/**
 * What may be written to disk, and the function that writes it.
 *
 * This harness reads the screen. Everything it learns — a chat, a ticket, a bank's address bar, the
 * title of whatever window was in front — arrives in this process as an ordinary string, and the
 * results file is the only thing that outlives the run. So the file's contents are an allow-list,
 * twice over:
 *
 * - By TYPE: every field below is a number, a boolean, a fixed code from a closed union, or a case
 *   name this harness invented. There is no field of type `string` that holds anything read.
 * - By CONSTRUCTION: `serialiseResults` builds the object field by field, by hand, like the helper's
 *   own `stats_value` in `protocol.rs` and for the same reason. It never spreads an input and never
 *   serialises an object it was handed, so a field added upstream — a `text`, a `toolbarText`, a
 *   `lines[].text` — cannot ride along into the file by being present. It has to be written in here,
 *   in a diff somebody reads.
 *
 * `results.test.ts` runs a whole fake run whose every recognised string is a sentinel and asserts
 * that none of the sentinels appears anywhere in the serialised output.
 *
 * The one string that is allowed and is not invented here is the run nonce, which this harness
 * generated itself.
 */
import type {Confusion} from "./score";
import type {AccuracyGroup} from "./thresholds";

/** Why a repetition ended. A closed list: nothing here is derived from what was on the screen. */
export type RepetitionOutcome =
  /** Read, recognised, and the staged page's own markers were both found. The only outcome that scores. */
  | "ok"
  /** The staged window never came to the front inside the guard's timeout. Nothing was read. */
  | "notStaged"
  /** A read came back, but STARTMARKER/ENDMARKER were not both in it: the page was not staged as intended. */
  | "noMarkers"
  | "windowGone"
  | "black"
  | "locked"
  | "timeout"
  | "failed"
  /** The helper went away, or answered nothing at all. */
  | "down";

/** Outcomes that make their case incomplete: reported, never dropped, never counted as a pass. */
export const INCOMPLETE_OUTCOMES: readonly RepetitionOutcome[] =
  ["notStaged", "noMarkers", "windowGone", "black", "locked", "timeout", "failed", "down"];

/** The measurements the helper's `stats` carries. All numbers and one boolean, by the protocol's own rule. */
export interface ReadStats {
  captureMs: number | null;
  recogniseMs: number | null;
  cacheHit: boolean | null;
  widthPx: number | null;
  heightPx: number | null;
}

export const NO_STATS: ReadStats = {captureMs: null, recogniseMs: null, cacheHit: null, widthPx: null, heightPx: null};

export interface AccuracyRepetition {
  outcome: RepetitionOutcome;
  accuracy: number | null;
  markers: boolean | null;
  accents: number | null;
  stats: ReadStats;
  /**
   * The immediate second read of the SAME staging (first-run record, carried item 27: "the
   * same-pixels cache is still unmeasured"). Only two numbers are kept from it, because that is all
   * it is for: did the helper's same-pixels cache answer, and what did the answer cost.
   */
  repeat: {cacheHit: boolean | null; recogniseMs: number | null} | null;
}

export interface AccuracyCaseResult {
  case: string;
  group: AccuracyGroup;
  repetitions: AccuracyRepetition[];
  minAccuracy: number | null;
  medianAccuracy: number | null;
  minAccents: number | null;
  incomplete: boolean;
  /** Only for a case that fell short of its threshold; see `thresholds.ts`. */
  confusions: Confusion[];
}

export interface ToolbarCaseResult {
  case: string;
  mode: "normal" | "incognito";
  /** From the case table, not from the capture: what the rule is supposed to say about this window. */
  expectPrivate: boolean;
  outcome: RepetitionOutcome;
  /** The squashed host was found in the squashed toolbar strip (`toolbar.py`'s rule). */
  host: boolean | null;
  /** From `lines`: the bottom of the line the host was found on. */
  hostBottomPx: number | null;
  /** `hasPrivateToolbarMarker` — the product's own rule, not a copy of it. */
  private: boolean | null;
  privateBottomPx: number | null;
  /**
   * The band the helper judged this read against. A badge that fell BELOW the band shows up here as
   * `privateBottomPx > bandPx` with `private: false` — carried item 30's failure mode, made visible.
   */
  bandPx: number | null;
  /** How long the strip was, never what it said. */
  toolbarTextLength: number | null;
  toolbarTextPresent: boolean;
  lineCount: number | null;
  stats: ReadStats;
}

export interface ObserveCaseResult extends ToolbarCaseResult {
  /** Which app the owner staged this one in. A fixed name from the case table. */
  app: string;
}

export interface GroupVerdict {
  group: AccuracyGroup;
  threshold: number;
  /** The MINIMUM over the group's cases' minimums. Never the median: a group is as good as its worst read. */
  min: number | null;
  median: number | null;
  /** `pt` only, and `null` everywhere else. */
  accentsMin: number | null;
  accentsThreshold: number | null;
  incompleteCases: string[];
  passed: boolean;
}

export interface ToolbarVerdict {
  captures: number;
  hostHits: number;
  hostHitsMin: number;
  privateHits: number;
  privateHitsMin: number;
  falsePrivate: number;
  falsePrivateMax: number;
  incompleteCases: string[];
  passed: boolean;
}

/**
 * The owner-staged observations, judged.
 *
 * `observe` mode has an acceptance bar, and it is the strictest one in this harness, in both
 * directions:
 *
 * - `privateMissed` — a window the owner staged as PRIVATE whose read did not show the private
 *   marker. In the product that is a private window **kept**: the text of somebody's private
 *   browsing crosses into the pipeline. The first-run record calls the Safari half of this "the
 *   single most consequential unmeasured behaviour in the sub-project" (carried item 29), and
 *   carried item 30 is the same failure reached through a toolbar that pushed the badge out of the
 *   band. `private: null` — the helper sent no strip at all — counts here, because a badge that was
 *   never delivered is a badge that never skipped anything.
 * - `falsePrivate` — a window the owner staged as NORMAL that was flagged private. That costs the
 *   user reads for ever rather than costing privacy, and phase 0 measured zero of them.
 *
 * And a run in which nothing was successfully read is `incomplete`, never a pass: an owner who
 * staged nothing has measured nothing, and "nothing went wrong" must not read as "it works".
 */
export interface ObserveVerdict {
  /** Rows recorded — one per case the owner staged and the guard accepted. */
  staged: number;
  /** Of those, the ones that produced a usable read. */
  read: number;
  privateMissed: number;
  falsePrivate: number;
  incompleteCases: string[];
  passed: boolean;
}

export interface EvalSummary {
  groups: GroupVerdict[];
  /**
   * The accuracy groups this run's mode promised a verdict for and did not produce one for — because
   * every case in them failed to stage, or because nothing ran at all. Named rather than counted, so
   * a reader of the file can see WHICH part of the screen went unmeasured, and empty for a mode that
   * does not run the accuracy cases.
   */
  missingGroups: AccuracyGroup[];
  toolbar: ToolbarVerdict | null;
  observe: ObserveVerdict | null;
  /** Every acceptance check the run's mode asked for was produced, passed, and no case was incomplete. */
  accepted: boolean;
}

export type EvalMode = "accuracy" | "toolbar" | "observe" | "all";

export interface EvalResults {
  /** Bumped whenever the shape below changes, so an old file is never read as a new one. */
  schema: 1;
  mode: EvalMode;
  /** This run's random nonce. The harness generated it; it says nothing about the machine. */
  nonce: string;
  repetitions: number;
  chromeVariant: string;
  accuracy: AccuracyCaseResult[];
  toolbar: ToolbarCaseResult[];
  observe: ObserveCaseResult[];
  summary: EvalSummary;
}

/** A run that could not be made at all. A fixed code, never a message: a message can carry a path. */
export type EvalError = {error: "PROTOCOL" | "NO_GRANT" | "HARNESS"; code: string};

const stats = (value: ReadStats): Record<string, unknown> => ({
  captureMs: value.captureMs,
  recogniseMs: value.recogniseMs,
  cacheHit: value.cacheHit,
  widthPx: value.widthPx,
  heightPx: value.heightPx
});

const toolbarCase = (value: ToolbarCaseResult): Record<string, unknown> => ({
  case: value.case,
  mode: value.mode,
  expectPrivate: value.expectPrivate,
  outcome: value.outcome,
  host: value.host,
  hostBottomPx: value.hostBottomPx,
  private: value.private,
  privateBottomPx: value.privateBottomPx,
  bandPx: value.bandPx,
  toolbarTextLength: value.toolbarTextLength,
  toolbarTextPresent: value.toolbarTextPresent,
  lineCount: value.lineCount,
  stats: stats(value.stats)
});

/**
 * The results file. Every field is written out by hand; nothing is spread, nothing is copied
 * wholesale. See the file comment for why that is the point rather than a style.
 */
export function serialiseResults(results: EvalResults): string {
  return JSON.stringify({
    schema: results.schema,
    mode: results.mode,
    nonce: results.nonce,
    repetitions: results.repetitions,
    chromeVariant: results.chromeVariant,
    accuracy: results.accuracy.map((entry) => ({
      case: entry.case,
      group: entry.group,
      minAccuracy: entry.minAccuracy,
      medianAccuracy: entry.medianAccuracy,
      minAccents: entry.minAccents,
      incomplete: entry.incomplete,
      confusions: entry.confusions.map((confusion) => ({
        from: confusion.from,
        to: confusion.to,
        count: confusion.count
      })),
      repetitions: entry.repetitions.map((repetition) => ({
        outcome: repetition.outcome,
        accuracy: repetition.accuracy,
        markers: repetition.markers,
        accents: repetition.accents,
        stats: stats(repetition.stats),
        repeat: repetition.repeat === null
          ? null
          : {cacheHit: repetition.repeat.cacheHit, recogniseMs: repetition.repeat.recogniseMs}
      }))
    })),
    toolbar: results.toolbar.map(toolbarCase),
    observe: results.observe.map((entry) => ({...toolbarCase(entry), app: entry.app})),
    summary: {
      groups: results.summary.groups.map((group) => ({
        group: group.group,
        threshold: group.threshold,
        min: group.min,
        median: group.median,
        accentsMin: group.accentsMin,
        accentsThreshold: group.accentsThreshold,
        incompleteCases: [...group.incompleteCases],
        passed: group.passed
      })),
      missingGroups: [...results.summary.missingGroups],
      toolbar: results.summary.toolbar === null
        ? null
        : {
          captures: results.summary.toolbar.captures,
          hostHits: results.summary.toolbar.hostHits,
          hostHitsMin: results.summary.toolbar.hostHitsMin,
          privateHits: results.summary.toolbar.privateHits,
          privateHitsMin: results.summary.toolbar.privateHitsMin,
          falsePrivate: results.summary.toolbar.falsePrivate,
          falsePrivateMax: results.summary.toolbar.falsePrivateMax,
          incompleteCases: [...results.summary.toolbar.incompleteCases],
          passed: results.summary.toolbar.passed
        },
      observe: results.summary.observe === null
        ? null
        : {
          staged: results.summary.observe.staged,
          read: results.summary.observe.read,
          privateMissed: results.summary.observe.privateMissed,
          falsePrivate: results.summary.observe.falsePrivate,
          incompleteCases: [...results.summary.observe.incompleteCases],
          passed: results.summary.observe.passed
        },
      accepted: results.summary.accepted
    }
  }, null, 2);
}

export function serialiseError(error: EvalError): string {
  return JSON.stringify({error: error.error, code: error.code}, null, 2);
}
