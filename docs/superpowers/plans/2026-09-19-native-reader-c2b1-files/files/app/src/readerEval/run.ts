/**
 * The run itself: stage, guard, read, score, tear down — over injected dependencies, so the whole
 * orchestration is exercised in unit tests against a fake link and a fake stager, on a machine with
 * no screen and with nothing ever opened.
 *
 * Two shapes here come straight out of the first-run record and the phase-0 findings:
 *
 * - **Every repetition is staged fresh.** Recognition of unchanged pixels was measured to be
 *   deterministic on this machine (ten reads of one unchanged Terminal window, one identical text,
 *   findings "P4 addendum 2"), and the helper's same-pixels cache would answer reads 2..5 of one
 *   staging anyway. Five reads of one staging would therefore be one measurement reported five
 *   times. Restaging is what makes five repetitions five samples.
 * - **One extra read per staging, immediately.** That second read is the one place the same-pixels
 *   cache CAN be observed (carried item 27: "the same-pixels cache is still unmeasured"), and only
 *   two numbers are kept from it: whether it was a cache hit and what recognition cost.
 *
 * Nothing in this file writes to disk and nothing in it spawns anything: `main.ts` supplies both.
 */
import {hasPrivateToolbarMarker} from "../core/exclusions/privateWindows";
import type {FrontWindow} from "../core/types";
import {
  CHROME,
  OBSERVE_CASES,
  TOOLBAR_CASES,
  ACCURACY_CASES,
  type AccuracyCase,
  type ObserveCase,
  type ToolbarCase,
  type TruthName
} from "./cases";
import {approve, awaitStagedWindow, type Approval} from "./guard";
import type {Answer, EvalHelper} from "./helper";
import {accents, accuracy, between, confusions} from "./score";
import {
  NO_STATS,
  type AccuracyCaseResult,
  type AccuracyRepetition,
  type ObserveCaseResult,
  type ReadStats,
  type RepetitionOutcome,
  type ToolbarCaseResult
} from "./results";
import {finishAccuracyCase} from "./summary";
import {stagedTitleFor} from "./stagedTitle";
import {
  chromePreferences,
  chromeStageCommand,
  chromeTeardownCommand,
  pageUrl,
  terminalScript,
  terminalStageCommand,
  type ChromeVariant,
  type EvalCommand
} from "./stage";
import {ACCURACY_THRESHOLDS, DEFAULT_REPETITIONS, EVAL_READ_BUDGET_MS, OBSERVE_POLL_MS, OBSERVE_SECONDS_DEFAULT} from "./thresholds";

/** Everything that touches the machine, behind one interface, so a test can supply none of it. */
export interface Stager {
  run(command: EvalCommand): Promise<void>;
  /** Writes an executable `.command` file under the out folder and answers with its path. */
  writeScript(name: string, contents: string): Promise<string>;
  /** Writes the staged Chrome profile's own preferences. Never touches any other profile. */
  writePreferences(preferences: Record<string, unknown>): Promise<void>;
}

export interface RunDeps {
  helper: EvalHelper;
  stager: Stager;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** This run's random nonce; every staged title carries it. */
  nonce: string;
  /** The loopback port the staged pages are served on. */
  port: number;
  profileDir: string;
  /** The truth files, read once by `main.ts`. */
  truth: Readonly<Record<TruthName, string>>;
  repetitions?: number;
  variant?: ChromeVariant;
  guard?: {timeoutMs?: number; pollMs?: number};
  /** How long a staged window is given to settle before the guard starts asking. */
  settleMs?: number;
}

/** Chrome's first window in a fresh profile takes a moment; the guard then polls on top of this. */
const DEFAULT_SETTLE_MS = 2_000;

const squash = (value: string): string => value.toLowerCase().replace(/\p{White_Space}+/gu, "");

/** `toolbar.py`'s rule: the squashed host is a substring of the squashed strip. */
export function hostInToolbar(toolbarText: string, host: string): boolean {
  return squash(toolbarText).includes(squash(host));
}

export interface LineBox {
  text: string;
  topPx: number;
  bottomPx: number;
  leftPx: number;
  rightPx: number;
}

/** The `lines` of an answer, or an empty list. Shaped by hand: an answer is another process's JSON. */
export function linesOf(body: Record<string, unknown>): LineBox[] {
  const lines = body.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((entry): LineBox[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const numbers = ["topPx", "bottomPx", "leftPx", "rightPx"] as const;
    if (typeof record.text !== "string" || numbers.some((key) => typeof record[key] !== "number")) return [];
    return [{
      text: record.text,
      topPx: record.topPx as number,
      bottomPx: record.bottomPx as number,
      leftPx: record.leftPx as number,
      rightPx: record.rightPx as number
    }];
  });
}

export function statsOf(body: Record<string, unknown>): ReadStats {
  const stats = body.stats;
  if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return NO_STATS;
  const record = stats as Record<string, unknown>;
  const number = (key: string): number | null => (typeof record[key] === "number" ? (record[key] as number) : null);
  return {
    captureMs: number("captureMs"),
    recogniseMs: number("recogniseMs"),
    cacheHit: typeof record.cacheHit === "boolean" ? record.cacheHit : null,
    widthPx: number("width"),
    heightPx: number("height")
  };
}

export function bandPxOf(body: Record<string, unknown>): number | null {
  const stats = body.stats;
  if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return null;
  const band = (stats as Record<string, unknown>).bandPx;
  return typeof band === "number" ? band : null;
}

/** The fixed outcome code for an answer that is not a usable `ok`. */
export function failureOutcome(answer: Answer): RepetitionOutcome {
  if (!answer.ok) return answer.why === "timeout" ? "timeout" : "down";
  if (answer.body.ok === true) return "ok";
  const reason = answer.body.reason;
  const known: readonly RepetitionOutcome[] = ["locked", "black", "timeout", "failed", "windowGone"];
  return typeof reason === "string" && (known as readonly string[]).includes(reason)
    ? (reason as RepetitionOutcome)
    : "failed";
}

const textOf = (body: Record<string, unknown>): string => (typeof body.text === "string" ? body.text : "");
const toolbarOf = (body: Record<string, unknown>): string | null =>
  typeof body.toolbarText === "string" ? body.toolbarText : null;

interface Staging {
  /** What to run to put the window on screen. */
  open: EvalCommand;
  /** What to run afterwards, or nothing at all (a Terminal window is never killed — see below). */
  teardown: EvalCommand | null;
  stagedTitle: string;
  app: string;
}

async function stageAccuracy(theCase: AccuracyCase, deps: RunDeps): Promise<Staging> {
  const stagedTitle = stagedTitleFor(theCase.name, deps.nonce);
  if (theCase.kind === "browser") {
    const variant = deps.variant ?? "none";
    if (variant !== "none") await deps.stager.writePreferences(chromePreferences(variant));
    return {
      app: CHROME,
      stagedTitle,
      open: chromeStageCommand({
        profileDir: deps.profileDir,
        incognito: false,
        window: theCase.window,
        url: pageUrl({
          host: "127.0.0.1",
          port: deps.port,
          page: theCase.page,
          theme: theCase.theme,
          sizePx: theCase.sizePx,
          stagedTitle
        })
      }),
      teardown: chromeTeardownCommand(deps.profileDir)
    };
  }
  const path = await deps.stager.writeScript(
    `${theCase.name}.command`,
    terminalScript({
      columns: theCase.columns,
      rows: theCase.rows,
      title: stagedTitle,
      truth: deps.truth.terminal
    })
  );
  // No teardown for Terminal, on purpose. The only way to close somebody else's Terminal window from
  // here is to kill Terminal, and Terminal is one process for every window the owner has open —
  // including the one this session is being run from. The staged shell exits by itself instead
  // (`sleep` then `exit 0`); whether the window then closes is the owner's Terminal setting, and a
  // window left behind is an inconvenience where killing the wrong one is a loss.
  return {app: theCase.app, stagedTitle, open: terminalStageCommand(path), teardown: null};
}

/**
 * One repetition, plus the recognised body it scored — held in memory only, for the one use below.
 * It never reaches `results.ts`, which has no field that could carry it.
 */
interface Repetition {
  repetition: AccuracyRepetition;
  /** The text between the markers, kept only until the case is finished. */
  scoredBody: string | null;
}

/** One staging, guarded, read once (and once more for the cache), then torn down. */
async function oneRepetition(theCase: AccuracyCase, deps: RunDeps): Promise<Repetition> {
  const none = (outcome: RepetitionOutcome, stats: ReadStats): Repetition => ({
    repetition: {outcome, accuracy: null, markers: null, accents: null, stats, repeat: null},
    scoredBody: null
  });
  const staging = await stageAccuracy(theCase, deps);
  try {
    await deps.stager.run(staging.open);
    await deps.sleep(deps.settleMs ?? DEFAULT_SETTLE_MS);
    const guarded = await awaitStagedWindow(
      {app: staging.app, stagedTitle: staging.stagedTitle},
      {
        frontWindow: async () => await frontWindowOf(deps.helper),
        sleep: deps.sleep,
        now: deps.now,
        ...(deps.guard?.timeoutMs === undefined ? {} : {timeoutMs: deps.guard.timeoutMs}),
        ...(deps.guard?.pollMs === undefined ? {} : {pollMs: deps.guard.pollMs})
      }
    );
    if (guarded.kind === "notStaged") return none("notStaged", NO_STATS);
    const answer = await deps.helper.readApproved(guarded.approval, {lines: false, budgetMs: EVAL_READ_BUDGET_MS});
    const outcome = failureOutcome(answer);
    if (!answer.ok || outcome !== "ok") return none(outcome, answer.ok ? statsOf(answer.body) : NO_STATS);
    const truth = deps.truth[theCase.truth];
    const {body, found} = between(textOf(answer.body));
    const repeat = await cacheProbe(guarded.approval, deps);
    return {
      repetition: {
        outcome: found ? "ok" : "noMarkers",
        accuracy: found ? accuracy(body, truth) : null,
        markers: found,
        accents: found ? accents(body, truth) : null,
        stats: statsOf(answer.body),
        repeat
      },
      scoredBody: found ? body : null
    };
  } finally {
    if (staging.teardown) await deps.stager.run(staging.teardown);
  }
}

/**
 * The immediate second read of the same staging. Its only purpose is `cacheHit` and `recogniseMs`;
 * its text is not looked at and does not exist once this function returns.
 *
 * It reuses the approval rather than asking the window server again, and that is safe for the reason
 * the protocol number moved to 2: the `read` still carries `expect`, so a helper that finds anything
 * else in front answers `windowGone` having captured nothing.
 */
async function cacheProbe(approval: Approval, deps: RunDeps): Promise<{cacheHit: boolean | null; recogniseMs: number | null} | null> {
  const answer = await deps.helper.readApproved(approval, {lines: false, budgetMs: EVAL_READ_BUDGET_MS});
  if (!answer.ok || answer.body.ok !== true) return null;
  const stats = statsOf(answer.body);
  return {cacheHit: stats.cacheHit, recogniseMs: stats.recogniseMs};
}

async function frontWindowOf(helper: EvalHelper): Promise<FrontWindow | null> {
  const answer = await helper.frontWindow();
  if (!answer.ok) return null;
  const window = answer.body.window;
  if (typeof window !== "object" || window === null || Array.isArray(window)) return null;
  const record = window as Record<string, unknown>;
  if (typeof record.app !== "string" || typeof record.title !== "string") return null;
  return typeof record.bundleId === "string"
    ? {app: record.app, bundleId: record.bundleId, title: record.title}
    : {app: record.app, title: record.title};
}

export async function runAccuracyCase(theCase: AccuracyCase, deps: RunDeps): Promise<AccuracyCaseResult> {
  const total = deps.repetitions ?? DEFAULT_REPETITIONS;
  const repetitions: AccuracyRepetition[] = [];
  /** The body of the WORST scoring repetition, kept only to explain a shortfall. */
  let worst: {body: string; accuracy: number} | null = null;
  for (let index = 0; index < total; index += 1) {
    const {repetition, scoredBody} = await oneRepetition(theCase, deps);
    repetitions.push(repetition);
    if (scoredBody !== null && repetition.accuracy !== null && (worst === null || repetition.accuracy < worst.accuracy)) {
      worst = {body: scoredBody, accuracy: repetition.accuracy};
    }
  }
  const result = finishAccuracyCase({case: theCase.name, group: theCase.group, repetitions, confusions: []});
  // The confusion list exists for a case that fell short, and only then: it is the one field derived
  // from recognised characters, so it is computed for nothing else. It explains the WORST read,
  // because that is the read the group's verdict was decided on.
  return result.minAccuracy !== null && result.minAccuracy < ACCURACY_THRESHOLDS[theCase.group] && worst !== null
    ? {...result, confusions: confusions(worst.body, deps.truth[theCase.truth])}
    : result;
}

export async function runAccuracy(deps: RunDeps, cases: readonly AccuracyCase[] = ACCURACY_CASES): Promise<AccuracyCaseResult[]> {
  const results: AccuracyCaseResult[] = [];
  for (const theCase of cases) results.push(await runAccuracyCase(theCase, deps));
  return results;
}

/**
 * The facts a toolbar capture yields, from the strip and from the line boxes.
 *
 * A cache HIT carries no `lines` and no `bandPx` — the helper's cache remembers the assembled text
 * and the strip, never the boxes, and inventing boxes from an older frame would be a measurement of
 * the wrong frame (`ReadGeometry` in `scheduler.rs`). So a hit yields `host`/`private` from the strip
 * and nulls for every pixel figure, which is the honest report rather than a guess. Every toolbar
 * case is staged fresh at a URL of its own, so the pixels differ and a hit is not expected.
 */
export function toolbarFacts(
  body: Record<string, unknown>,
  options: {host: string; app: string}
): Pick<ToolbarCaseResult, "host" | "hostBottomPx" | "private" | "privateBottomPx" | "bandPx" | "toolbarTextLength" | "toolbarTextPresent" | "lineCount"> {
  const toolbarText = toolbarOf(body);
  const lines = linesOf(body);
  const hostLine = lines.find((line) => hostInToolbar(line.text, options.host));
  const privateLine = lines.find((line) => hasPrivateToolbarMarker(line.text, options.app));
  return {
    host: toolbarText === null ? null : hostInToolbar(toolbarText, options.host),
    hostBottomPx: hostLine ? hostLine.bottomPx : null,
    // The product's own rule, called with the product's own arguments. Never a copy of it: a copy
    // could pass here while the real one fails on somebody's screen.
    private: toolbarText === null ? null : hasPrivateToolbarMarker(toolbarText, options.app),
    privateBottomPx: privateLine ? privateLine.bottomPx : null,
    bandPx: bandPxOf(body),
    toolbarTextLength: toolbarText === null ? null : toolbarText.length,
    toolbarTextPresent: toolbarText !== null,
    lineCount: lines.length
  };
}

const EMPTY_FACTS = {
  host: null, hostBottomPx: null, private: null, privateBottomPx: null,
  bandPx: null, toolbarTextLength: null, toolbarTextPresent: false, lineCount: null
} as const;

export async function runToolbarCase(theCase: ToolbarCase, deps: RunDeps): Promise<ToolbarCaseResult> {
  const stagedTitle = stagedTitleFor(theCase.name, deps.nonce);
  const variant = deps.variant ?? "none";
  if (variant !== "none") await deps.stager.writePreferences(chromePreferences(variant));
  const open = chromeStageCommand({
    profileDir: deps.profileDir,
    incognito: theCase.mode === "incognito",
    window: theCase.window,
    url: pageUrl({
      host: theCase.host,
      port: deps.port,
      page: theCase.page,
      theme: theCase.theme,
      sizePx: theCase.sizePx,
      stagedTitle
    })
  });
  const base = {case: theCase.name, mode: theCase.mode, expectPrivate: theCase.expectPrivate};
  try {
    await deps.stager.run(open);
    await deps.sleep(deps.settleMs ?? DEFAULT_SETTLE_MS);
    const guarded = await awaitStagedWindow(
      {app: theCase.app, stagedTitle},
      {
        frontWindow: async () => await frontWindowOf(deps.helper),
        sleep: deps.sleep,
        now: deps.now,
        ...(deps.guard?.timeoutMs === undefined ? {} : {timeoutMs: deps.guard.timeoutMs}),
        ...(deps.guard?.pollMs === undefined ? {} : {pollMs: deps.guard.pollMs})
      }
    );
    if (guarded.kind === "notStaged") return {...base, outcome: "notStaged", ...EMPTY_FACTS, stats: NO_STATS};
    const answer = await deps.helper.readApproved(guarded.approval, {lines: true, budgetMs: EVAL_READ_BUDGET_MS});
    const outcome = failureOutcome(answer);
    if (!answer.ok || outcome !== "ok") {
      return {...base, outcome, ...EMPTY_FACTS, stats: answer.ok ? statsOf(answer.body) : NO_STATS};
    }
    return {
      ...base,
      outcome: "ok",
      ...toolbarFacts(answer.body, {host: theCase.host, app: theCase.app}),
      stats: statsOf(answer.body)
    };
  } finally {
    await deps.stager.run(chromeTeardownCommand(deps.profileDir));
  }
}

export async function runToolbar(deps: RunDeps, cases: readonly ToolbarCase[] = TOOLBAR_CASES): Promise<ToolbarCaseResult[]> {
  const results: ToolbarCaseResult[] = [];
  for (const theCase of cases) results.push(await runToolbarCase(theCase, deps));
  return results;
}

export interface ObserveDeps extends RunDeps {
  seconds?: number;
}

/**
 * `observe` mode: the stagings no command line can make.
 *
 * A Safari private window cannot be opened without an Automation grant, and this harness will not
 * ask for one. So the owner opens the window on one of the URLs the terminal side prints, and this
 * watches the front window. The URL carries the staged title, the page sets it, the guard matches it
 * — so the harness still only ever reads a window whose title it minted, and the expectation
 * (private or not) is inside that name, which is why a recorded observation cannot end up filed
 * under the wrong one.
 *
 * That expectation is judged, not merely recorded: a row disagreeing with its own name fails the
 * run, in both directions, and a run that read nothing at all is incomplete. See
 * `summariseObserve`.
 *
 * Each case is read once, the first time it is seen.
 */
export async function runObserve(deps: ObserveDeps, cases: readonly ObserveCase[] = OBSERVE_CASES): Promise<ObserveCaseResult[]> {
  const seconds = deps.seconds ?? OBSERVE_SECONDS_DEFAULT;
  const until = deps.now() + seconds * 1_000;
  const seen = new Map<string, ObserveCaseResult>();
  while (deps.now() < until && seen.size < cases.length) {
    const window = await frontWindowOf(deps.helper);
    for (const theCase of cases) {
      if (seen.has(theCase.name)) continue;
      const approval = approve(window, {app: theCase.app, stagedTitle: stagedTitleFor(theCase.name, deps.nonce)});
      if (!approval) continue;
      const answer = await deps.helper.readApproved(approval, {lines: true, budgetMs: EVAL_READ_BUDGET_MS});
      const outcome = failureOutcome(answer);
      const base = {
        case: theCase.name,
        app: theCase.app,
        mode: (theCase.expectPrivate ? "incognito" : "normal") as "incognito" | "normal",
        expectPrivate: theCase.expectPrivate
      };
      seen.set(theCase.name, answer.ok && outcome === "ok"
        ? {...base, outcome: "ok", ...toolbarFacts(answer.body, {host: "127.0.0.1", app: theCase.app}), stats: statsOf(answer.body)}
        : {...base, outcome, ...EMPTY_FACTS, stats: answer.ok ? statsOf(answer.body) : NO_STATS});
      break;
    }
    await deps.sleep(OBSERVE_POLL_MS);
  }
  return cases.flatMap((theCase) => {
    const result = seen.get(theCase.name);
    return result ? [result] : [];
  });
}
