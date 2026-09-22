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
  DEFAULT_POSITION,
  OBSERVE_CASES,
  TOOLBAR_CASES,
  ACCURACY_CASES,
  interleavedToolbarCases,
  limitedTo,
  stagedTitleOf,
  positioned,
  type AccuracyCase,
  type ObserveCase,
  type ToolbarCase,
  type TruthName,
  type WindowBox,
  type WindowPosition,
  type WorkArea
} from "./cases";
import {approve, awaitStagedWindow, type Approval} from "./guard";
import type {Answer, EvalHelper} from "./helper";
import {accents, accuracy, between, confusions, markerHits} from "./score";
import {
  NO_STAGED_SIZE,
  NO_STATS,
  type AccuracyCaseResult,
  type AccuracyRepetition,
  type EvalMode,
  type ObserveCaseResult,
  type ReadStats,
  type RepetitionOutcome,
  type StagedSize,
  type ToolbarCaseResult
} from "./results";
import {finishAccuracyCase} from "./summary";
import {readySizeIn} from "./stagedTitle";
import {
  capturedSize,
  chromeAliveCommand,
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
  /**
   * Did the command find anything? `pgrep` exiting 0, and nothing else: no output is read, so
   * nothing about any process — a name, an argument, a path — ever reaches this side. It is asked
   * exactly one question, about a pattern this harness built from its own profile path.
   */
  matches(command: EvalCommand): Promise<boolean>;
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
  /**
   * Where every staged CHROME window's top-left corner goes, in points (`--position`). Default:
   * `DEFAULT_POSITION`, which is where every window has been staged until now.
   *
   * It does NOT move a Terminal window, and nothing here pretends to. A Terminal staging is a
   * `.command` file opened through LaunchServices, and the two levers this harness uses on it are
   * the xterm sequences for size and for title — chosen precisely because they need no Automation
   * grant. There is no equivalent this harness will use to place the window: the one sequence that
   * exists for it is a thing a Terminal profile may simply ignore, and AppleScript is the grant the
   * harness refuses to ask for. So a run placed on another display stages its sixteen Chrome cases
   * there and leaves `terminal` and `terminal-narrow` wherever the owner's Terminal opens them —
   * which is a fact for the record of that run, not a gap to be papered over with a mechanism
   * nobody has measured.
   */
  position?: WindowPosition;
  /**
   * The display's usable area in points, as the bundle read it (`screen.getPrimaryDisplay`).
   *
   * Written into the staged profile's `browser.window_placement` so that Chrome's own comparison of
   * saved placement against the current work area is made against the truth. Absent in a unit test
   * and on any caller that has no display to ask; the placement is then written without its
   * `work_area_` half, which Chrome treats as a placement it may adjust.
   */
  workArea?: WorkArea | null;
  /**
   * That display's `scaleFactor`, as Electron reports it: 2 on the built-in Retina panel, 1 on an
   * ordinary external one, and a fraction on a scaled mode.
   *
   * It decides `sizeAsStaged` when it is known, instead of the scale being inferred from the capture
   * (review B, Minor 3): the bundle is already asking that display for its work area, so asking it
   * for the one number that turns points into pixels costs nothing and removes the only way a
   * capture of the wrong size could be read as the right one. Absent in a unit test and on any
   * caller with no display to ask, and the inferred value is then used, exactly as before.
   */
  displayScale?: number | null;
  /**
   * What the page server was asked for, per staged title: how many requests carried it and what the
   * last of them was answered with (`PageServer.served`).
   *
   * Injected, like everything else that touches the machine, so a unit test supplies none and the
   * two fields are recorded as `null`. It is the half of the `notStaged` diagnosis the window
   * server cannot give: whether the browser ever asked for the page at all.
   */
  pageStats?: (stagedTitle: string) => {count: number; lastStatus: number | null};
  /**
   * What this RUN has done so far. One counter, incremented by every Chrome staging.
   *
   * It exists for one decision: the first Chrome window of a run gets a more generous wait than the
   * rest (`FIRST_STAGE_GUARD_TIMEOUT_MS`), because that is the one that failed in two of the three
   * staged runs of 2026-09-21. It is mutable and shared on purpose — `runAccuracy` and `runToolbar`
   * make one for the whole run and hand it to every case — and a caller that supplies none (a unit
   * test calling one case directly) is treated as starting a run.
   */
  progress?: {chromeStagings: number};
  guard?: {timeoutMs?: number; pollMs?: number};
  /**
   * Stage only the first `limit` cases of this part (`--limit`), or all of them.
   *
   * The toolbar cases are taken INTERLEAVED — normal, incognito, normal, incognito — so a short run
   * measures both halves of what the mode is for; see `interleavedToolbarCases`. A limited run can
   * never be accepted (`summary.ts`), so this only ever costs the cases it does not stage.
   */
  limit?: number | null;
  /** How long a staged window is given to settle before the guard starts asking. */
  settleMs?: number;
  /** Bounds of the wait for a previous staged Chrome to exit. Overridden only by tests. */
  chromeExit?: {tries?: number; pollMs?: number};
}

/** Chrome's first window in a fresh profile takes a moment; the guard then polls on top of this. */
const DEFAULT_SETTLE_MS = 2_000;

/**
 * How long the run will wait for the previous staged Chrome to be GONE before it opens the next one,
 * and how often it asks: 40 x 250 ms = 10 s at the outside.
 *
 * Bounded, and the bound is not a failure: a Chrome that will not go inside ten seconds leaves the
 * staging to happen anyway, be recorded, and show up as `sizeAsStaged: false` — a wait that could
 * hang would trade a measured wrong size for no measurement at all, in a session the owner is
 * sitting through. The wait itself is recorded per repetition (`chromeWaitMs`), so a run in which
 * this mattered says so in numbers.
 */
const CHROME_EXIT_TRIES = 40;
const CHROME_EXIT_POLL_MS = 250;

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
  /** Terminal only: wait for the shell to say it has finished printing (`stagedTitle.ts`). */
  requireReady: boolean;
  /** What was asked for: points for a browser window, cells for a terminal. */
  staged: StagedSize;
  /**
   * Terminal only: this staging is judged in CELLS, from the two numbers the shell put in the title,
   * not from the capture against a point size it does not have.
   */
  cells: boolean;
  /** Whether this staging is a Chrome one, and so waits for the previous Chrome to be gone. */
  chrome: boolean;
}

/**
 * Wait for this run's previous staged Chrome to be GONE, and answer with how long that took.
 *
 * Bounded by `CHROME_EXIT_TRIES`. The first ask is made before any sleeping, so a teardown that has
 * already finished — the ordinary case — costs one `pgrep` and returns 0.
 */
async function awaitChromeGone(deps: RunDeps): Promise<number> {
  const command = chromeAliveCommand(deps.profileDir);
  const tries = deps.chromeExit?.tries ?? CHROME_EXIT_TRIES;
  const pollMs = deps.chromeExit?.pollMs ?? CHROME_EXIT_POLL_MS;
  const started = deps.now();
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (!await deps.stager.matches(command)) break;
    await deps.sleep(pollMs);
  }
  return deps.now() - started;
}

/**
 * Everything a Chrome staging does before the window is opened, in the ONE order that works:
 * **wait for the old Chrome to be gone, then write the placement, then open.**
 *
 * It was written the other way round until review B, on the reasoning that the placement must be on
 * disk before the process that reads it starts. True, and not enough: the process that is still
 * QUITTING also WRITES that file. Chrome persists `browser.window_placement` as a window closes and
 * flushes its `PrefService` on shutdown, and the teardown `pkill` that begins that shutdown runs
 * microseconds before this. Written first, our placement was overwritten by the dying Chrome's own
 * — the wrong size, the very one being repaired — and the next launch read that. Waiting first
 * means the writer is gone before we write, and nothing touches the file between our write and the
 * launch that reads it.
 *
 * `run.test.ts` pins the sequence as data (`pgrep…, preferences, open`); the old order fails it.
 */
async function prepareChrome(deps: RunDeps, window: WindowBox): Promise<number> {
  if (deps.progress) deps.progress.chromeStagings += 1;
  const waited = await awaitChromeGone(deps);
  await deps.stager.writePreferences(chromePreferences(deps.variant ?? "none", {
    bounds: window,
    workArea: deps.workArea ?? null
  }));
  return waited;
}

async function stageAccuracy(theCase: AccuracyCase, deps: RunDeps): Promise<Staging & {chromeWaitMs: number | null}> {
  const stagedTitle = stagedTitleOf(theCase.name, deps.nonce);
  if (theCase.kind === "browser") {
    const window = positioned(theCase.window, deps.position ?? DEFAULT_POSITION);
    const chromeWaitMs = await prepareChrome(deps, window);
    return {
      app: CHROME,
      stagedTitle,
      requireReady: false,
      staged: {widthPt: window.widthPt, heightPt: window.heightPt, columns: null, rows: null},
      cells: false,
      chrome: true,
      chromeWaitMs,
      open: chromeStageCommand({
        profileDir: deps.profileDir,
        incognito: false,
        window,
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
  return {
    app: theCase.app,
    stagedTitle,
    // The one case that waits for the READY token: a Terminal window has its title before it has its
    // text, which is how the first run read two empty windows and recorded `noMarkers` for both.
    requireReady: true,
    staged: {widthPt: null, heightPt: null, columns: theCase.columns, rows: theCase.rows},
    cells: true,
    chrome: false,
    chromeWaitMs: null,
    open: terminalStageCommand(path),
    teardown: null
  };
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

/** How many lines a recognised text came back as. A count, never a line. */
const NEWLINE = String.fromCharCode(10);
export function lineCountOf(text: string): number {
  return text.length === 0 ? 0 : text.split(NEWLINE).length;
}

/**
 * Open a staged window and wait for the guard, once.
 *
 * Returns the guard's outcome and how long it took, so the caller can decide whether to try again —
 * which is what `oneRepetition` does for a Chrome staging that did not come to the front.
 */
async function openAndWait(staging: Staging, deps: RunDeps, timeoutMs: number | undefined): Promise<{
  guarded: Awaited<ReturnType<typeof awaitStagedWindow>>;
  stageMs: number;
}> {
  const opened = deps.now();
  await deps.stager.run(staging.open);
  await deps.sleep(deps.settleMs ?? DEFAULT_SETTLE_MS);
  const guarded = await awaitStagedWindow(
    {app: staging.app, stagedTitle: staging.stagedTitle, requireReady: staging.requireReady},
    {
      frontWindow: async () => await frontWindowOf(deps.helper),
      sleep: deps.sleep,
      now: deps.now,
      ...(timeoutMs === undefined ? {} : {timeoutMs}),
      ...(deps.guard?.pollMs === undefined ? {} : {pollMs: deps.guard.pollMs})
    }
  );
  return {guarded, stageMs: deps.now() - opened};
}

/**
 * How long the guard waits for the FIRST Chrome window of a run, against `GUARD_TIMEOUT_MS` = 15 s
 * for every one after it.
 *
 * Measured, not guessed: in two of the three staged runs of 2026-09-21 the first Chrome case of the
 * run came back `notStaged` with `chromeWaitMs` about 20 ms and no `stageMs` at all — nothing was
 * ever read — while every later case in the same run staged in well under the ordinary timeout. A
 * browser's first window in a profile that has just been created does more work than its second
 * (the profile is written, the network service and the GPU process start), and it is also the moment
 * most likely to lose the front window to whatever else the machine was doing. 30 s costs a quarter
 * of a minute once per run and buys the case that has failed most often.
 */
export const FIRST_STAGE_GUARD_TIMEOUT_MS = 30_000;

/** The guard timeout for one staging: the caller's if it set one, else generous for the first. */
export function guardTimeoutFor(deps: RunDeps, chrome: boolean): number | undefined {
  if (deps.guard?.timeoutMs !== undefined) return deps.guard.timeoutMs;
  // A caller with NO counter is not the first staging of anything: `runAccuracy` and `runToolbar`
  // mint the counter, so they are the only source of the generous wait. Defaulting the other way
  // would silently double the worst-case wait of every case for a future entry point that called
  // one case directly, with nothing failing to show it (review C, Minor 3).
  return chrome && (deps.progress?.chromeStagings ?? 2) <= 1 ? FIRST_STAGE_GUARD_TIMEOUT_MS : undefined;
}

/** One staging, guarded, read once (and once more for the cache), then torn down. */
async function oneRepetition(theCase: AccuracyCase, deps: RunDeps): Promise<Repetition> {
  let staging = await stageAccuracy(theCase, deps);
  let attempts = 1;
  /**
   * Everything about this staging that is true whatever the read did.
   *
   * `displayScale` is the scale of the display the CHROME stagings were put on — the one nearest
   * `--position`. A Terminal window is opened by LaunchServices wherever the owner's Terminal opens
   * it and this harness neither sizes nor places it, so for a terminal case the number would be a
   * claim about a display the window may not be on: the run of 2026-09-21 staged `terminal` on the
   * 1x external display and `terminal-narrow` on the 2x built-in one. `null` is what is known.
   */
  const fixed = {
    staged: staging.staged,
    // Read from the CURRENT staging every time it is spread, never captured once. A repetition that
    // was staged twice reports the second attempt's wait beside its own `stageMs`, because that is
    // the staging the read came from — the toolbar path has always done this, and the two fields
    // meaning different things in two row types of the same file is exactly the confusion the next
    // run would have to unpick (review C, Important 1): `chromeWaitMs` is the number P2 of this
    // repair loop was diagnosed from.
    get chromeWaitMs(): number | null { return staging.chromeWaitMs; },
    // A plain value, unlike the wait above: `cells` is a property of the CASE and `displayScale` of
    // the run, so neither can differ between two attempts at the same staging. A getter here would
    // be a construct no test could tell from a constant.
    displayScale: staging.cells ? null : (deps.displayScale ?? null)
  };
  const scaleOf = (stats: ReadStats): {scale: number | null; sizeAsStaged: boolean | null} =>
    // A terminal's capture cannot be turned into cells without a font nobody here knows, so there is
    // no inferred scale to cross-check it with either: both are null until the title is read below.
    staging.cells
      ? {scale: null, sizeAsStaged: null}
      : capturedSize({widthPx: stats.widthPx, heightPx: stats.heightPx}, staging.staged, deps.displayScale);
  /** What the page server was asked for under this case's title, or two nulls. */
  const page = (): {pageRequests: number | null; pageStatus: number | null} => {
    const seen = deps.pageStats?.(staging.stagedTitle);
    return seen === undefined
      ? {pageRequests: null, pageStatus: null}
      : {pageRequests: seen.count, pageStatus: seen.lastStatus};
  };
  const none = (
    outcome: RepetitionOutcome,
    stats: ReadStats,
    stageMs: number | null,
    seen: {sawApp: boolean; sawStagedTitle: boolean; refusedTitleLength?: number | null} | null
  ): Repetition => ({
    repetition: {
      outcome, accuracy: null, markers: null, accents: null, stats, repeat: null,
      ...fixed,
      ...scaleOf(stats),
      startFound: null, endFound: null, lineCount: null, textLength: null,
      readyColumns: null, readyRows: null,
      frontAppSeen: seen === null ? null : seen.sawApp,
      stagedTitleSeen: seen === null ? null : seen.sawStagedTitle,
      refusedTitleLength: seen?.refusedTitleLength ?? null,
      ...page(),
      stageAttempts: attempts, stageMs
    },
    scoredBody: null
  });
  try {
    let {guarded, stageMs} = await openAndWait(staging, deps, guardTimeoutFor(deps, staging.chrome));
    // ONE automatic re-stage for a Chrome window that never came to the front, and only for Chrome:
    // a fresh window of a fresh process is a NEW staging, not a second read of the same one, and the
    // repetition that comes out of it is an ordinary repetition. A Terminal window is never killed
    // by this harness (see `stageAccuracy`), so re-staging one would leave the first window on the
    // screen carrying the same staged title, and the guard could then approve a window from the
    // attempt that failed.
    if (guarded.kind === "notStaged" && staging.chrome) {
      if (staging.teardown) await deps.stager.run(staging.teardown);
      staging = await stageAccuracy(theCase, deps);
      attempts += 1;
      ({guarded, stageMs} = await openAndWait(staging, deps, guardTimeoutFor(deps, staging.chrome)));
    }
    if (guarded.kind === "notStaged") return none("notStaged", NO_STATS, null, guarded);
    const answer = await deps.helper.readApproved(guarded.approval, {lines: false, budgetMs: EVAL_READ_BUDGET_MS});
    const outcome = failureOutcome(answer);
    // The window WAS the staged one — the guard approved it — so both observations are true by
    // construction; what follows is a failure of the read, not of the staging.
    if (!answer.ok || outcome !== "ok") {
      return none(outcome, answer.ok ? statsOf(answer.body) : NO_STATS, stageMs, {sawApp: true, sawStagedTitle: true});
    }
    const truth = deps.truth[theCase.truth];
    const text = textOf(answer.body);
    const {body, found} = between(text);
    const marks = markerHits(text);
    const stats = statsOf(answer.body);
    // Two bounded integers or two nulls, out of a title this harness minted and matched. See
    // `readySizeIn` for why this one exception to "nothing is parsed out of a title" exists.
    const ready = staging.cells
      ? readySizeIn(guarded.approval.window.title, staging.stagedTitle)
      : {columns: null, rows: null};
    const repeat = await cacheProbe(guarded.approval, deps);
    return {
      repetition: {
        outcome: found ? "ok" : "noMarkers",
        accuracy: found ? accuracy(body, truth) : null,
        markers: found,
        accents: found ? accents(body, truth) : null,
        stats,
        repeat,
        ...fixed,
        // A browser window is judged by its capture against the points it was staged at; a Terminal
        // window by the two numbers its own shell put in the title this harness minted, bounded and
        // read back by `readySizeIn`, because cells do not convert to points without a font nobody
        // here knows.
        ...(staging.cells
          ? {
            scale: null,
            sizeAsStaged: ready.columns !== null &&
              ready.columns === staging.staged.columns && ready.rows === staging.staged.rows
          }
          : scaleOf(stats)),
        startFound: marks.start,
        endFound: marks.end,
        lineCount: lineCountOf(text),
        textLength: text.length,
        readyColumns: ready.columns,
        readyRows: ready.rows,
        frontAppSeen: true,
        stagedTitleSeen: true,
        // The window WAS approved, so no title of ours was refused on the way to it.
        refusedTitleLength: null,
        ...page(),
        stageAttempts: attempts,
        stageMs
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

/** One counter for the whole run, so only its first Chrome staging gets the generous wait. */
export function withProgress(deps: RunDeps): RunDeps {
  return deps.progress === undefined ? {...deps, progress: {chromeStagings: 0}} : deps;
}

export async function runAccuracy(deps: RunDeps, cases: readonly AccuracyCase[] = ACCURACY_CASES): Promise<AccuracyCaseResult[]> {
  const shared = withProgress(deps);
  const results: AccuracyCaseResult[] = [];
  for (const theCase of limitedTo(cases, deps.limit ?? null)) results.push(await runAccuracyCase(theCase, shared));
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
  const stagedTitle = stagedTitleOf(theCase.name, deps.nonce);
  const window = positioned(theCase.window, deps.position ?? DEFAULT_POSITION);
  const chromeWaitMs = await prepareChrome(deps, window);
  const staged: StagedSize = {widthPt: window.widthPt, heightPt: window.heightPt, columns: null, rows: null};
  const open = chromeStageCommand({
    profileDir: deps.profileDir,
    incognito: theCase.mode === "incognito",
    window,
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
  let chromeWait = chromeWaitMs;
  let attempts = 1;
  const sized = (
    stats: ReadStats,
    stageMs: number | null,
    seen: {sawApp: boolean; sawStagedTitle: boolean; refusedTitleLength?: number | null} | null
  ): Pick<ToolbarCaseResult, "staged" | "scale" | "sizeAsStaged" | "chromeWaitMs" | "stageMs" | "displayScale" | "stageAttempts" | "frontAppSeen" | "stagedTitleSeen" | "pageRequests" | "pageStatus" | "refusedTitleLength"> => {
    const page = deps.pageStats?.(stagedTitle);
    return {
      staged,
      ...capturedSize({widthPx: stats.widthPx, heightPx: stats.heightPx}, staged, deps.displayScale),
      chromeWaitMs: chromeWait,
      stageMs,
      displayScale: deps.displayScale ?? null,
      stageAttempts: attempts,
      frontAppSeen: seen === null ? null : seen.sawApp,
      stagedTitleSeen: seen === null ? null : seen.sawStagedTitle,
      refusedTitleLength: seen?.refusedTitleLength ?? null,
      pageRequests: page === undefined ? null : page.count,
      pageStatus: page === undefined ? null : page.lastStatus
    };
  };
  const staging: Staging = {
    open, teardown: chromeTeardownCommand(deps.profileDir), stagedTitle, app: theCase.app,
    requireReady: false, staged, cells: false, chrome: true
  };
  try {
    let {guarded, stageMs} = await openAndWait(staging, deps, guardTimeoutFor(deps, true));
    // The same one re-stage as an accuracy case, for the same measured reason.
    if (guarded.kind === "notStaged") {
      await deps.stager.run(chromeTeardownCommand(deps.profileDir));
      chromeWait = await prepareChrome(deps, window);
      attempts += 1;
      ({guarded, stageMs} = await openAndWait(staging, deps, guardTimeoutFor(deps, true)));
    }
    if (guarded.kind === "notStaged") {
      return {...base, outcome: "notStaged", ...EMPTY_FACTS, stats: NO_STATS, ...sized(NO_STATS, null, guarded)};
    }
    const answer = await deps.helper.readApproved(guarded.approval, {lines: true, budgetMs: EVAL_READ_BUDGET_MS});
    const outcome = failureOutcome(answer);
    if (!answer.ok || outcome !== "ok") {
      const stats = answer.ok ? statsOf(answer.body) : NO_STATS;
      return {...base, outcome, ...EMPTY_FACTS, stats, ...sized(stats, stageMs, {sawApp: true, sawStagedTitle: true})};
    }
    const stats = statsOf(answer.body);
    return {
      ...base,
      outcome: "ok",
      ...toolbarFacts(answer.body, {host: theCase.host, app: theCase.app}),
      stats,
      ...sized(stats, stageMs, {sawApp: true, sawStagedTitle: true})
    };
  } finally {
    await deps.stager.run(chromeTeardownCommand(deps.profileDir));
  }
}

export async function runToolbar(deps: RunDeps, cases: readonly ToolbarCase[] = TOOLBAR_CASES): Promise<ToolbarCaseResult[]> {
  const shared = withProgress(deps);
  const results: ToolbarCaseResult[] = [];
  // Interleaved for every run, limited or not, so a limited run is a PREFIX of the full one.
  for (const theCase of limitedTo(interleavedToolbarCases(cases), deps.limit ?? null)) {
    results.push(await runToolbarCase(theCase, shared));
  }
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
      const approval = approve(window, {app: theCase.app, stagedTitle: stagedTitleOf(theCase.name, deps.nonce)});
      if (!approval) continue;
      const answer = await deps.helper.readApproved(approval, {lines: true, budgetMs: EVAL_READ_BUDGET_MS});
      const outcome = failureOutcome(answer);
      const base = {
        case: theCase.name,
        app: theCase.app,
        mode: (theCase.expectPrivate ? "incognito" : "normal") as "incognito" | "normal",
        expectPrivate: theCase.expectPrivate
      };
      // Nothing was staged by this harness, so there is no staged size to compare a capture against
      // and no Chrome of ours to have waited for: the owner opened the window, at whatever size his
      // browser opens windows. `null` throughout is the honest answer, and it keeps an `observe`
      // row out of the not-as-staged rule, which is about stagings this harness made.
      const unstaged = {
        staged: NO_STAGED_SIZE, scale: null, sizeAsStaged: null, chromeWaitMs: null, stageMs: null,
        stageAttempts: null,
        // The owner staged this one; the guard was watching for it rather than waiting on a staging
        // of ours, and no page of ours was fetched for it.
        frontAppSeen: null, stagedTitleSeen: null, pageRequests: null, pageStatus: null,
        refusedTitleLength: null,
        // The owner opened this window, on whatever display he opened it on; the scale of the display
        // the harness would have staged on says nothing about it.
        displayScale: null
      };
      seen.set(theCase.name, answer.ok && outcome === "ok"
        ? {...base, outcome: "ok", ...toolbarFacts(answer.body, {host: "127.0.0.1", app: theCase.app}), stats: statsOf(answer.body), ...unstaged}
        : {...base, outcome, ...EMPTY_FACTS, stats: answer.ok ? statsOf(answer.body) : NO_STATS, ...unstaged});
      break;
    }
    await deps.sleep(OBSERVE_POLL_MS);
  }
  return cases.flatMap((theCase) => {
    const result = seen.get(theCase.name);
    return result ? [result] : [];
  });
}

/** Everything a run read, per mode. A mode that does not run a part answers with an empty list for it. */
export interface EvalRuns {
  accuracy: AccuracyCaseResult[];
  toolbar: ToolbarCaseResult[];
  observe: ObserveCaseResult[];
}

/**
 * Which parts of the harness a mode runs — the one place that decides it.
 *
 * It lives here rather than as three `mode === …` tests inside `main.ts` for the reason every other
 * decision in this folder does: `main.ts` needs a screen to run and so is never unit-tested, and the
 * question "what does this mode send to the helper" is the question the whole privacy claim rests
 * on. In particular `coldstart` runs NONE of the three: it opens nothing, so it asks the window
 * server nothing and reads nothing, and `run.test.ts` asserts that on the lines a fake helper
 * actually received rather than on this reading well. The only line a `coldstart` run ever writes to
 * the helper is the `permission` question `main.ts` asks in every mode, and `shutdown`.
 */
export async function runMode(mode: EvalMode, deps: ObserveDeps): Promise<EvalRuns> {
  // ONE counter for the whole run, minted here and shared by the parts, so `all` gives the generous
  // first-staging wait once and not once per part (review C, Minor 2). `runAccuracy` and
  // `runToolbar` keep their own `withProgress` for a caller that runs one part on its own.
  const shared = {...deps, ...withProgress(deps)};
  return {
    accuracy: mode === "accuracy" || mode === "all" ? await runAccuracy(shared) : [],
    toolbar: mode === "toolbar" || mode === "all" ? await runToolbar(shared) : [],
    observe: mode === "observe" || mode === "all" ? await runObserve(shared) : []
  };
}
