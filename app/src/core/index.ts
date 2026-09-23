import {z} from "zod";
import {createBuffer} from "./buffer";
import {buildSkillIndex, offeredFor, type SkillIndex} from "./candidates/index";
import {BUFFER_MAX_AGE_MS, EXTRACTION_QUEUE_MAX} from "./constants";
import {createCounters} from "./counters";
import {createDigest} from "./digest";
import {createExclusions, type Exclusions} from "./exclusions/index";
import {extract} from "./extraction/extract";
import {checkStatement} from "./guard/checks";
import {buildForbidden} from "./guard/forbidden";
import {compact} from "./scenarios/compact";
import {type ClosedSpan, createSegmenter} from "./scenarios/segmenter";
import {scrub} from "./scrub/scrub";
import {repairHomoglyphs} from "./text/homoglyphs";
import type {CaptureDecision, ConfigResult, IngestOutcome, Pipeline, PipelineConfig, Ports, Scenario, SkipReason} from "./types";

export {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./exclusions/defaults";
export type * from "./types";

const taxonomyShape = z.object({
  taxonomyVersion: z.string().min(1),
  skills: z.array(z.object({id: z.string().min(1), displayName: z.string().min(1), canonicalName: z.string(), aliases: z.array(z.string())})),
  competencies: z.array(z.object({id: z.string().min(1), name: z.string().min(1), description: z.string()})),
  userNames: z.array(z.string())
});

/** Denials that mean "the user is somewhere we do not look", which can end a stretch of work. */
const AWAY_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>(["excludedApp", "excludedTitle", "privateWindow"]);

/**
 * A read comes from another process, so a field that should be text may be anything; a malformed
 * read must still be refused by the checks that already refuse it rather than throw on its way to
 * them. Only a string is repaired; everything else is handed on untouched.
 */
function repaired<T>(value: T): T {
  return (typeof value === "string" ? repairHomoglyphs(value) : value) as T;
}

interface Active { config: PipelineConfig; exclusions: Exclusions; index: SkillIndex }

export function createPipeline(initial: PipelineConfig, ports: Ports): Pipeline {
  const {clock} = ports;
  const counters = createCounters();
  const buffer = createBuffer();
  const segmenter = createSegmenter();
  let active: Active | null = null;
  const digest = createDigest({clock, newId: ports.newId, counters, taxonomyVersion: () => active?.config.taxonomyVersion ?? ""});

  let on = false;
  let locked = false;
  let queue: Scenario[] = [];
  let running: Promise<void> | null = null;
  let paused = false;

  function configure(config: PipelineConfig): ConfigResult {
    const exclusions = createExclusions({exclusions: config?.exclusions, excludedSites: config?.excludedSites, selfApp: config?.selfApp});
    const taxonomy = taxonomyShape.safeParse(config);
    const problems = [...exclusions.problems, ...(taxonomy.success ? [] : ["skills, competencies, user names or taxonomy version are malformed"])];
    if (problems.length > 0) { active = null; return {ok: false, problems}; }
    active = {config, exclusions, index: buildSkillIndex(config.skills)};
    return {ok: true};
  }

  const deny = (reason: SkipReason, counter: string): {reason: SkipReason} => { counters.inc(`${counter}.${reason}`); return {reason}; };

  /** Shared by mayCapture and ingest, so ingest never depends on the app having asked first. */
  function gate(front: {app: string; title: string}, counter: string): SkipReason | null {
    if (!on) return deny("captureOff", counter).reason;
    if (locked) return deny("locked", counter).reason;
    if (!active) return deny("rulesInvalid", counter).reason;
    const now = clock.now();
    segmenter.activity(now);
    const reason = active.exclusions.before(front);
    if (reason) {
      if (AWAY_REASONS.has(reason)) segmenter.captureAllowed(now, false);
      return deny(reason, counter).reason;
    }
    segmenter.captureAllowed(now, true);
    return null;
  }

  async function process(scenario: Scenario): Promise<void> {
    const current = active;
    try {
      if (!current) return;
      const offered = offeredFor(current.index, current.config.competencies, scenario);
      const outcome = await extract({scenario, offered, userNames: current.config.userNames, model: ports.model, counters, timeScale: current.config.modelTimeScale});
      if (outcome.kind !== "statements") return;
      const skillById = new Map(current.config.skills.map((s) => [s.id, s]));
      const allowTerms = offered.flatMap((o) => {
        const skill = skillById.get(o.id);
        return skill ? [skill.displayName, skill.canonicalName, ...skill.aliases] : [o.name];
      });
      const forbidden = buildForbidden({scenario, userNames: current.config.userNames, allowTerms});
      const offeredIds = offered.map((o) => o.id);
      for (const draft of outcome.drafts) {
        const verdict = checkStatement({statement: draft.statement, targetId: draft.targetId, offeredIds, forbidden});
        if (verdict.ok) digest.add(draft);
        else counters.inc(`guard.discarded.check${verdict.check}`);
      }
    } catch {
      counters.inc("pipeline.processFailed");
    } finally {
      // The scenario's raw text is released as soon as extraction ends, whatever happened.
      scenario.text = "";
      scenario.blocks = [];
    }
  }

  function pump(): void {
    if (paused || running || queue.length === 0) return;
    const next = queue.shift() as Scenario;
    running = process(next).finally(() => { running = null; pump(); });
  }

  function closeSpan(span: ClosedSpan): void {
    counters.inc(`scenarios.closed.${span.reason}`);
    const reads = buffer.range(span.openedAt, span.closedAt);
    buffer.dropRange(span.openedAt, span.closedAt);
    const scenario = compact(reads, {id: ports.newId(), openedAt: span.openedAt, closedAt: span.closedAt});
    if (!scenario) { counters.inc("scenarios.droppedThin"); return; }
    if (queue.length >= EXTRACTION_QUEUE_MAX) {
      queue.shift();
      counters.inc("scenarios.droppedQueue");
      if (paused) counters.inc("pipeline.pausedDrops");
    }
    queue.push(scenario);
    pump();
  }

  configure(initial);

  return {
    configure,
    mayCapture(front): CaptureDecision {
      const reason = gate(front, "capture.denied");
      return reason ? {allow: false, reason} : {allow: true};
    },
    ingest(read): IngestOutcome {
      // Recognised text is repaired for script homoglyphs HERE, before anything in the core matches
      // on it: the private-window markers and excluded sites in `exclusions.after`, the scrub and
      // secret patterns below, and — through the buffer — the guard, the name rules and the English
      // check. The native reader already does this (`native/reader/src/text.rs`); A does it again
      // because A must not assume which reader produced the text (spec 10.1 item 13's sub-project-A
      // half, open as item 34 of the 2026-09-19 C-2a review). Doing it twice is safe because the
      // repair is idempotent, which the fixture the two share asserts case by case.
      // The title is NOT repaired: it comes from the window server, not from recognition, so it has
      // no homoglyphs to undo and rewriting it could only corrupt a window someone really named in
      // Cyrillic or Greek. That is also why `gate` and `exclusions.before`, which judge the app name
      // and the title, are left exactly as they were.
      const body = repaired(read.text);
      const toolbarText = repaired(read.toolbarText);
      const reason = gate(read, "reads.skipped");
      if (reason) return {kept: false, reason};
      const after = (active as Active).exclusions.after(read, toolbarText);
      if (after) return {kept: false, ...deny(after, "reads.skipped")};

      let text: string;
      let title: string;
      try { text = scrub(body).text; title = scrub(read.title).text; }
      catch { return {kept: false, ...deny("scrubFailed", "reads.skipped")}; }

      const now = clock.now();
      const result = buffer.accept({app: read.app, title, text, at: now});
      if (result !== "kept") return {kept: false, ...deny(result, "reads.skipped")};
      segmenter.kept(now);
      counters.inc("reads.kept");
      return {kept: true};
    },
    tick() {
      const now = clock.now();
      counters.inc("buffer.expired", buffer.expire(now));
      const span = segmenter.tick(now);
      if (span) closeSpan(span);
      const fresh = queue.filter((s) => now - s.openedAt <= BUFFER_MAX_AGE_MS);
      counters.inc("scenarios.droppedStale", queue.length - fresh.length);
      if (paused) counters.inc("pipeline.pausedDrops", queue.length - fresh.length);
      queue = fresh;
      digest.tick();
    },
    signal(s) {
      const now = clock.now();
      if (s === "captureOn") on = true;
      if (s === "locked") { locked = true; segmenter.locked(now); }
      if (s === "unlocked") { locked = false; segmenter.unlocked(now); }
      if (s === "modelPaused") paused = true;
      if (s === "modelResumed") { paused = false; pump(); }
      if (s === "captureOff") {
        on = false;
        const span = segmenter.off(now);
        if (span) closeSpan(span);
      }
    },
    digest: () => digest.list(),
    resolve(id, decision) { if (digest.resolve(id)) counters.inc(`statements.${decision}`); },
    counters: () => Object.fromEntries(Object.entries(counters.snapshot()).filter(([, value]) => value !== 0)),
    takeCounters() {
      const taken = Object.fromEntries(Object.entries(counters.snapshot()).filter(([, value]) => value !== 0));
      counters.reset();
      return taken;
    },
    exportPool: () => digest.exportPool(),
    importPool: (items) => digest.importPool(items),
    /** While the model is paused, waiting scenarios do not count: nothing can run until it resumes. */
    async whenIdle() { while (running || (!paused && queue.length > 0)) { pump(); await running; } }
  };
}
