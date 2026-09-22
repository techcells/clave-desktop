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

/**
 * What the helper said about the Screen Recording permission, as a CLOSED union.
 *
 * The helper's own three words are `granted`, `denied` and `refused` (`HelperPermission` in
 * `main/reader/protocol.ts`); `unknown` is this harness's word for "it answered something else, or
 * did not answer at all". The union exists so that the string in the answer BODY never reaches the
 * results file: `permissionOf` in `helper.ts` maps through the product's own `parseHelperPermission`
 * and falls back to `unknown`, so a helper that one day invents a fourth word — or a fourth word
 * that is somebody's window title — is written down as `unknown` and nothing else.
 */
export type EvalPermission = "granted" | "denied" | "refused" | "unknown";

/** The measurements the helper's `stats` carries. All numbers and one boolean, by the protocol's own rule. */
export interface ReadStats {
  captureMs: number | null;
  recogniseMs: number | null;
  cacheHit: boolean | null;
  widthPx: number | null;
  heightPx: number | null;
}

export const NO_STATS: ReadStats = {captureMs: null, recogniseMs: null, cacheHit: null, widthPx: null, heightPx: null};

/**
 * What the harness ASKED for, beside what it got.
 *
 * Spec 10.1 item 15 is the reason this exists: a run records the window size because phase 0's
 * terminal case moved 0.8686 -> 0.9882 between two runs and the window state was not written down.
 * The first run against a screen made the same hole visible from the other side — every Chrome
 * capture came back 1416 x 1768 px against a staged 1268 x 708 pt, and the results file had a field
 * for the pixels and none for the points, so nothing in it said the run had measured a window
 * nobody chose. Both numbers are here now, per repetition, whatever happened.
 *
 * A browser window is staged in POINTS and a Terminal window in CELLS, and there is no converting
 * one to the other without knowing a font, so each case fills the pair it has and leaves the other
 * `null`. Four numbers; nothing derived from anything on the screen.
 */
export interface StagedSize {
  widthPt: number | null;
  heightPt: number | null;
  columns: number | null;
  rows: number | null;
}

export const NO_STAGED_SIZE: StagedSize = {widthPt: null, heightPt: null, columns: null, rows: null};

export interface AccuracyRepetition {
  outcome: RepetitionOutcome;
  accuracy: number | null;
  markers: boolean | null;
  accents: number | null;
  stats: ReadStats;
  /** What this repetition asked the window to be (`stats.widthPx`/`heightPx` is what it became). */
  staged: StagedSize;
  /**
   * What the DISPLAY said its scale factor was (Electron's `Display.scaleFactor`, for the display
   * nearest the staging position), and what the capture IMPLIES it was.
   *
   * `displayScale` is the authority and decides `sizeAsStaged`; `scale` is the integer factor at
   * which the capture fits the staged points, kept as the cross-check — the two disagreeing is a
   * finding in itself, and `scale` is `null` whenever no integer factor fits (which is also the case
   * a fractional display produces). `null` for a Terminal window, which is compared in cells, and
   * for a caller with no display to ask. The helper reports no scale at all: `stats_value` in
   * `native/reader/src/protocol.rs` writes `bandPx`, `captureMs`, `recogniseMs`, `cacheHit`, `width`
   * and `height`, and nothing else.
   */
  displayScale: number | null;
  scale: number | null;
  /**
   * Was the window the size it was staged at? `false` makes the case INCOMPLETE for acceptance
   * (`summary.ts`) while its numbers are still reported: a read of a window at the wrong size is a
   * real measurement of the wrong thing, and spec 10.1 item 15 exists because that is exactly what
   * a run must not report as a pass. `null` where there is nothing to compare — a repetition that
   * never read, or a Terminal window whose shell could not say what size it got.
   */
  sizeAsStaged: boolean | null;
  /**
   * The two numbers the staged SHELL reported for its own window, read back out of the title this
   * harness minted (`readySizeIn`), bounded to [1, 1000]; `null` for a browser case, and `null` when
   * the token held anything else.
   *
   * They are the one measurement in this file taken from a window title, and the reason is the run
   * of 2026-09-21: both terminal cases came back `sizeAsStaged: false` with captures that looked
   * right for the staged cells (1560 x 967 px for 140 x 40), and the file could not say whether
   * Terminal had ignored the resize or the shell had misread its own size — so the next run would
   * have had to guess again. With these two, `readyColumns` equal to `staged.columns` and
   * `sizeAsStaged: false` would be a contradiction worth a stop; 80 and 24 together are the
   * signature of a `tput` answering down a pipe; anything else is a terminal that was not resized.
   */
  readyColumns: number | null;
  readyRows: number | null;
  /**
   * How many times this repetition's window was staged: 1, or 2 when the first Chrome staging never
   * came to the front and was opened again.
   *
   * A re-stage is a NEW window of a new process, so the repetition it produces is an ordinary
   * repetition and not a second read of the same staging — this number is what says one happened.
   * Never more than 2, and never above 1 for a Terminal case, which is not re-staged.
   */
  stageAttempts: number | null;
  /**
   * What the guard saw while it was refusing, and what the page server was asked for — the four
   * numbers that take `notStaged` apart.
   *
   * The first real toolbar run (2026-09-21) produced forty `notStaged` rows, two staging attempts
   * each, and the file could not say whether Chrome had opened at all, opened on somebody else's
   * window, opened on an error page (whose title is the host, never ours) or opened our page under
   * a title that did not match. `frontAppSeen` and `stagedTitleSeen` come from the guard's own
   * observations (`GuardOutcome`); `pageRequests` and `pageStatus` come from the page server's
   * counters for THIS case's staged title. Read together: 0 requests puts the failure before the
   * page — the URL, the host, the launch — and 1 request answered 200 with `frontAppSeen` true and
   * `stagedTitleSeen` false puts it in the title or the window server. On 2026-09-21 the answer was
   * the third one: both booleans true, two requests, 200 — our page, our prefix, and a title the
   * guard still refused. See `refusedTitleLength`.
   *
   * The two counters are kept by the page server, which answers anything on the loopback address,
   * so a local process that knew this run's nonce (it is on the staged window's own title) could
   * add to a count or overwrite a status. That would be somebody confusing a diagnosis on their own
   * machine; it cannot put a string anywhere, and the counter map holds only the titles this run
   * minted (`server.ts`).
   */
  frontAppSeen: boolean | null;
  stagedTitleSeen: boolean | null;
  pageRequests: number | null;
  pageStatus: number | null;
  /**
   * The length of the longest title this harness's own app carried, with this harness's own prefix
   * on it, that `approve` still refused — and `null` when that never happened.
   *
   * It exists to settle one question with a number. A staged title is now at most
   * `STAGED_TITLE_MAX` characters (`cases.ts`), so a refusal carrying a length at or near the staged
   * title's own is a title that was NOT shortened and the cause is elsewhere, while a length well
   * below it is a title something cut. A length, never a title, and bounded by
   * `REFUSED_TITLE_LENGTH_MAX`.
   */
  refusedTitleLength: number | null;
  /** `STARTMARKER` was in the read. See `markerHits`: this is which half of `noMarkers` happened. */
  startFound: boolean | null;
  endFound: boolean | null;
  /** How many lines the read came back with, and how long it was. Never what it said. */
  lineCount: number | null;
  textLength: number | null;
  /**
   * Milliseconds the harness waited for the PREVIOUS staged Chrome to be gone before it opened this
   * one, and milliseconds from issuing the open command to the guard approving the window.
   *
   * They are here because they are what tells a staging that started a Chrome process apart from one
   * that merely asked a running Chrome for a window — the difference that decides whether
   * `--window-size` is read at all (see `chromeAliveCommand`). The first run's whole 18-case pass
   * took 44 s, about 2.5 s a staging against a 2 s settle, which is not a browser starting; with
   * these two numbers the next run does not have to be inferred from a stopwatch. `null` for a
   * Terminal staging, which is neither waited on nor killed.
   */
  chromeWaitMs: number | null;
  stageMs: number | null;
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
  /** As on a repetition, and for the same reason: the band is measured in a window of a known size. */
  staged: StagedSize;
  displayScale: number | null;
  scale: number | null;
  sizeAsStaged: boolean | null;
  chromeWaitMs: number | null;
  stageMs: number | null;
  stageAttempts: number | null;
  /** As on a repetition: what the guard saw, and what the page server was asked for. */
  frontAppSeen: boolean | null;
  stagedTitleSeen: boolean | null;
  pageRequests: number | null;
  pageStatus: number | null;
  refusedTitleLength: number | null;
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

/**
 * `coldstart`'s verdict: the one mode that measures the helper instead of the screen.
 *
 * Two facts, both of which the spec asks for by name — spec 10.1 item 4 (how long a cold helper
 * takes to be ready; phase 0 measured 43-45 s for the first-ever recognition of a binary) and
 * whether the Screen Recording grant reaches a helper spawned by the window-less evaluation entry
 * at all, which nothing has ever established. Both must be there, or the run measured nothing: a
 * `readyMs` that is not a finite number is no measurement, and a permission that is not `granted`
 * is the finding that blocks every other mode.
 */
export interface ColdstartVerdict {
  /** Milliseconds from spawn to `ready`, or `null` when no usable number was taken. */
  readyMs: number | null;
  permission: EvalPermission;
  passed: boolean;
}

/**
 * A run that staged only part of its table, and therefore cannot be an acceptance run.
 *
 * `reason` is a fixed code from a closed union, like every other word in this file. The two numbers
 * say how much of the table was staged: a reader of the file, and the owner reading the terminal,
 * both need to know that `passed: true` on three groups means three groups of four cases.
 */
export interface LimitedRun {
  reason: "LIMITED";
  cases: number;
  of: number;
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
  /** Only `coldstart` produces one; `null` in every other mode, which judges nothing about the helper. */
  coldstart: ColdstartVerdict | null;
  /**
   * Set when the run was asked for fewer cases than its table holds (`--limit`), and `null`
   * otherwise. Its presence alone makes `accepted` false — see `summarise`.
   */
  limited: LimitedRun | null;
  /** Every acceptance check the run's mode asked for was produced, passed, and no case was incomplete. */
  accepted: boolean;
}

/**
 * `coldstart` is deliberately NOT part of `all`. `all` is the staged-window run — accuracy, toolbar,
 * observe — and a mode that measures a process start has nothing to add to it; worse, folding it in
 * would make every `all` run's verdict depend on a helper start time that varies with what else the
 * machine is doing. It is asked for by name or not at all.
 */
export type EvalMode = "accuracy" | "toolbar" | "observe" | "all" | "coldstart";

export interface EvalResults {
  /**
   * Bumped whenever the shape below changes, so an old file is never read as a new one.
   *
   * **2** since 2026-09-21: `displayScale` (repair loop 1) and `readyColumns`, `readyRows`,
   * `stageAttempts` (repair loop 2) were added to the rows. Both changes are additive — a version-1
   * file read as a version 2 gives `undefined` for them rather than a wrong value, and no release
   * has produced a file — but the rule as written was broken twice, and a version number that is
   * only bumped when somebody remembers is not a version number (review C, Minor 5).
   *
   * **3** since the summary gained `limited` (the `--limit` option).
   */
  schema: 3;
  mode: EvalMode;
  /** This run's random nonce. The harness generated it; it says nothing about the machine. */
  nonce: string;
  repetitions: number;
  chromeVariant: string;
  /**
   * How long the helper took to start, in every mode: milliseconds from the moment the process was
   * SPAWNED to the `ready` line it answers with. A number and nothing else — the object exists so
   * that a second helper figure, should one ever be wanted, has somewhere to go that is plainly not
   * a place for text.
   */
  helper: {readyMs: number};
  /**
   * The helper's answer to `permission`, in every mode. In every mode but `coldstart` it can only be
   * `granted`, because the run refuses with `NO_GRANT` otherwise; `coldstart` is the one mode whose
   * job is to REPORT it, so it is recorded rather than refused on.
   */
  permission: EvalPermission;
  /**
   * Whether the page server got BOTH loopback families (127.0.0.1 and ::1) on its port.
   *
   * It is in the file because it is the one fact that says whether the repair of 2026-09-21 was in
   * effect at all: every toolbar URL is a `*.localhost` name, which Chromium resolves to `::1`
   * first. The run now refuses to start half-bound (`server.ts`), so this is `true` for any run
   * that produced results and `null` for a mode that served no page — but a reader of the file
   * should not have to infer that from the absence of a refusal.
   */
  pageServerIpv6: boolean | null;
  /**
   * Where every staged Chrome window's top-left corner was put, in points — the values the run
   * ACTUALLY used, the default included, not only a position somebody typed.
   *
   * It is here because the file is the record: `--position` is what decides which DISPLAY a run
   * measured (spec 10.1 item 8, the Retina check), and a results file that does not say where its
   * windows were is a set of numbers whose provenance lives only in somebody's shell history. Two
   * integers of this harness's own choosing; nothing about the machine, and nothing read.
   *
   * `null` for `coldstart`, which stages no window and so has no position to report. Saying `40,60`
   * there would be recording a corner nothing was ever put at.
   */
  position: {x: number; y: number} | null;
  accuracy: AccuracyCaseResult[];
  toolbar: ToolbarCaseResult[];
  observe: ObserveCaseResult[];
  summary: EvalSummary;
}

/**
 * A run that could not be made at all. A fixed code, never a message: a message can carry a path.
 *
 * One number is allowed beside it: how long the helper had taken when the run was refused. It is
 * there for `coldstart`, whose whole job is that number — a helper still not ready after the 120 s
 * deadline is the interesting answer, and the run used to write `{"error":"PROTOCOL"}` and throw the
 * measurement away. Optional, and written only when it is a usable figure, because the refusals
 * raised before a helper is ever spawned (`BAD_MODE`, `BAD_VARIANT`, `BAD_POSITION`, the catch-all)
 * have no such number and must not invent one.
 */
export type EvalError = {error: "PROTOCOL" | "NO_GRANT" | "HARNESS"; code: string; readyMs?: number};

const stats = (value: ReadStats): Record<string, unknown> => ({
  captureMs: value.captureMs,
  recogniseMs: value.recogniseMs,
  cacheHit: value.cacheHit,
  widthPx: value.widthPx,
  heightPx: value.heightPx
});

/**
 * Four numbers, by hand like everything else here — and each of them read one at a time, so a row
 * that arrived without this object at all (an older path, a hand-built row in a test) is written as
 * four `null`s rather than throwing. "No staged size was recorded" is the honest thing to write; a
 * serialiser that throws in the middle would leave the whole run with no file.
 */
const staged = (value: StagedSize | undefined): Record<string, unknown> => ({
  widthPt: value?.widthPt ?? null,
  heightPt: value?.heightPt ?? null,
  columns: value?.columns ?? null,
  rows: value?.rows ?? null
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
  stats: stats(value.stats),
  // `?? null` on each: `JSON.stringify` DROPS a field whose value is `undefined`, so a row that
  // reached here without one would silently lose the key rather than record "not measured" — and a
  // results file whose fields come and go is one nobody can compare two runs of. `??` leaves a
  // `false` or a `0` alone, which is the whole point of using it rather than `||`.
  staged: staged(value.staged),
  displayScale: value.displayScale ?? null,
  scale: value.scale ?? null,
  sizeAsStaged: value.sizeAsStaged ?? null,
  chromeWaitMs: value.chromeWaitMs ?? null,
  stageMs: value.stageMs ?? null,
  stageAttempts: value.stageAttempts ?? null,
  frontAppSeen: value.frontAppSeen ?? null,
  stagedTitleSeen: value.stagedTitleSeen ?? null,
  pageRequests: value.pageRequests ?? null,
  pageStatus: value.pageStatus ?? null,
  refusedTitleLength: value.refusedTitleLength ?? null
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
    // By hand, field by field, like everything else here: `results.helper` is an object this harness
    // built, but writing it wholesale would be the one line through which a field added to it later
    // reaches the file without anybody reading a diff.
    helper: {readyMs: results.helper.readyMs},
    permission: results.permission,
    // Field by field again, and `null` rather than an invented corner for a mode that staged nothing.
    position: results.position === null ? null : {x: results.position.x, y: results.position.y},
    pageServerIpv6: results.pageServerIpv6,
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
        // `?? null` throughout, for the reason given on `toolbarCase` above.
        staged: staged(repetition.staged),
        displayScale: repetition.displayScale ?? null,
        scale: repetition.scale ?? null,
        sizeAsStaged: repetition.sizeAsStaged ?? null,
        startFound: repetition.startFound ?? null,
        endFound: repetition.endFound ?? null,
        lineCount: repetition.lineCount ?? null,
        textLength: repetition.textLength ?? null,
        readyColumns: repetition.readyColumns ?? null,
        readyRows: repetition.readyRows ?? null,
        chromeWaitMs: repetition.chromeWaitMs ?? null,
        stageMs: repetition.stageMs ?? null,
        stageAttempts: repetition.stageAttempts ?? null,
        frontAppSeen: repetition.frontAppSeen ?? null,
        stagedTitleSeen: repetition.stagedTitleSeen ?? null,
        pageRequests: repetition.pageRequests ?? null,
        pageStatus: repetition.pageStatus ?? null,
        refusedTitleLength: repetition.refusedTitleLength ?? null,
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
      coldstart: results.summary.coldstart === null
        ? null
        : {
          readyMs: results.summary.coldstart.readyMs,
          permission: results.summary.coldstart.permission,
          passed: results.summary.coldstart.passed
        },
      limited: results.summary.limited === null
        ? null
        : {
          // The literal, not a copy of the input's: every other fixed code in this file is written
          // out here, which is what makes the allow-list an allow-list (review D, Minor 6).
          reason: "LIMITED",
          cases: results.summary.limited.cases,
          of: results.summary.limited.of
        },
      accepted: results.summary.accepted
    }
  }, null, 2);
}

export function serialiseError(error: EvalError): string {
  // By hand, like everything else here, and the number is admitted only when it is one: a `NaN`, an
  // `Infinity` or a duration that ran backwards is no measurement, and `JSON.stringify` would in any
  // case write the first two as `null`, which reads like a figure that was taken and came back empty.
  const measured = typeof error.readyMs === "number" && Number.isFinite(error.readyMs) && error.readyMs >= 0;
  return JSON.stringify(
    measured ? {error: error.error, code: error.code, readyMs: error.readyMs} : {error: error.error, code: error.code},
    null,
    2
  );
}
