import type {Pipeline} from "../../core/types";
import {ACTIVE_POLL_MS, AWAY_AFTER_SECONDS, BARREN_AFTER_MS, BARREN_CYCLE_LIMIT, FOCUS_SETTLE_MS, IDLE_AFTER_SECONDS, IDLE_POLL_MS, READ_BUDGET_MS, READER_CALL_TIMEOUT_MS, READER_FAILURE_LIMIT, READER_FAILURE_WINDOW_MS} from "../constants";
import {parseFrontWindow, parseReadResult, type FailureDetail, type Reader} from "../ports/reader";
import type {Now} from "../ports/system";

/** A `frontWindow()`/`read()` call that was given up on, whether its deadline passed or the loop was
 * stopped under it. Whichever settles second is ignored by construction: a promise can only settle
 * once, so a late real result is simply dropped. */
class ReaderCallTimeout extends Error {}

export type CycleOutcome =
  | "kept" | "noWindow" | "denied" | "windowChanged" | "stopped" | "notKept" | "userAway"
  | "locked" | "black" | "timeout" | "failed" | "windowGone" | "unchanged" | "empty";

/**
 * What a cycle says about whether the app is reading anything at all — which is NOT the same question
 * as whether the reader is healthy (`onReaderProblem` answers that one).
 *
 * - `productive`: something was read. `unchanged` belongs here and not with the rest: the read WORKED,
 *   the screen simply had not moved, which is the ordinary answer while someone reads a long document.
 * - `barren`: a cycle that produced nothing, through no fault of the reader — an app the user excluded,
 *   an unmeasured browser, a private window, a locked screen, a title that ticks faster than a read,
 *   a screen with almost no words on it at all.
 *   Any one of them is normal; hundreds of them in a row mean the tray is lying about reading.
 * - `neutral`: neither extends nor ends a streak. `userAway` and `stopped` are cycles that never
 *   looked at a screen, so they say nothing either way — counting `userAway` would raise the notice
 *   on every lunch break. `timeout` and `failed` are the reader's own faults and already have their
 *   own path out through `onReaderProblem`; a second, quieter notice for them would only compete.
 *   `userAway` is neutral for the streak in exactly this sense and does one thing besides: the span
 *   it covers is taken off the clock the ten minutes are measured on, because time nobody was there
 *   is not time in which reading failed. See `noteOutcome`.
 */
export type CycleClass = "productive" | "barren" | "neutral";

/**
 * One answer per outcome, written out rather than derived. `satisfies` makes this exhaustive BOTH
 * ways: a new `CycleOutcome` with no row here stops typecheck, and a row for an outcome that no
 * longer exists does too — so an outcome can never quietly default to "this counts as reading".
 */
export const CYCLE_CLASS = {
  kept: "productive", unchanged: "productive",
  noWindow: "barren", windowGone: "barren", black: "barren", windowChanged: "barren",
  denied: "barren", notKept: "barren", locked: "barren", empty: "barren",
  userAway: "neutral", stopped: "neutral", timeout: "neutral", failed: "neutral"
} as const satisfies Record<CycleOutcome, CycleClass>;

/** The outcomes `CYCLE_CLASS` calls barren, as a type: the keys of the counts a notice carries. */
export type BarrenOutcome = {[K in CycleOutcome]: typeof CYCLE_CLASS[K] extends "barren" ? K : never}[CycleOutcome];
/** How a streak of barren cycles is reported: fixed outcome names, numbers, and nothing else. */
export type BarrenCounts = Partial<Record<BarrenOutcome, number>>;

export const cycleClass = (outcome: CycleOutcome): CycleClass => CYCLE_CLASS[outcome];

/**
 * The fixed count key each failure detail is tallied under, written out rather than derived from the
 * detail name.
 *
 * `satisfies Record<FailureDetail, string>` is what makes it exhaustive: a detail added to the port
 * with no key here stops typecheck, so a new stage cannot arrive as a `failed` that is silently
 * counted under nothing. Written out rather than computed (`"failed" + capitalise(detail)`) for two
 * reasons: `recogniseError` is deliberately `failedRecognise` and no rule would produce that, and a
 * COMPUTED key is a key this codebase does not contain as a literal — which is precisely the
 * property `LOG_COUNT_KEYS` exists to have. Every key below is also spelled out there, and
 * `main/engine.ts` asserts at compile time that the two agree.
 */
export const FAILED_DETAIL_KEY = {
  noExpect: "failedNoExpect",
  noGrant: "failedNoGrant",
  captureRefused: "failedCaptureRefused",
  captureTimeout: "failedCaptureTimeout",
  captureError: "failedCaptureError",
  captureNoContent: "failedCaptureNoContent",
  captureNoImage: "failedCaptureNoImage",
  recogniseError: "failedRecognise",
  helperDown: "failedHelperDown"
} as const satisfies Record<FailureDetail, string>;

/**
 * The keys a cycle may tally IN ADDITION to its outcome, saying which stage failed.
 *
 * They sit alongside `failed` and `timeout` rather than replacing them: `CycleOutcome` and
 * `CYCLE_CLASS` are unchanged, so nothing about what a cycle MEANS — productive, barren, neutral —
 * moves because a failure now says more about itself. `failed` still counts every failure; these
 * split that same total by cause, and they sum to it.
 *
 * - the eight from `FAILED_DETAIL_KEY`: the reader answered `failed` and said which stage.
 * - `failedUnknown`: it answered `failed` and said nothing usable — an older helper, a malformed
 *   answer, or a detail the port refused. Kept as its own key rather than left out, because "we do
 *   not know" is a finding: a run that is all `failedUnknown` means the diagnosis itself is broken.
 * - `failedFrontWindow` / `failedReadCall`: the call REJECTED rather than answering, so there is no
 *   answer to carry a detail and only this side knows which call it was.
 * - `timeoutFrontWindow` / `timeoutRead`: the same split for a call that never settled at all. Two
 *   very different machines: a `frontWindow` that hangs is the window server, a `read` that hangs is
 *   a capture or Vision, and before this they were one word.
 */
export type FailedDetailKey = typeof FAILED_DETAIL_KEY[FailureDetail];
export type FailureTallyKey =
  | FailedDetailKey | "failedUnknown" | "failedFrontWindow" | "failedReadCall" | "timeoutFrontWindow" | "timeoutRead";

/** What a run tallied: outcome names and stage names, fixed identifiers both, and numbers. */
export type CycleStats = Partial<Record<CycleOutcome | FailureTallyKey, number>>;

export interface CaptureLoop {
  start(): void;
  /** Stops triggering. A read already in flight is thrown away when it returns. */
  stop(): void;
  running(): boolean;
  /**
   * How many cycles ended in each outcome since the last `start()`, and — for the ones that failed
   * — how many failed at each stage. Numbers only. Per run and not per object, because the one
   * caller writes them out when the run ends (`CAPTURE_OFF`): a reader of that line takes it as
   * "what that run did", and lifetime totals would make every line after the first a sum of runs
   * that had already been written out.
   */
  stats(): CycleStats;
}

/**
 * Decides WHEN to read, never WHETHER: every cycle asks the core first, and the reader is only
 * called when the core allows it. One read at a time; triggers during a read collapse into one more.
 */
export function createCaptureLoop(deps: {
  reader: Reader;
  pipeline: Pick<Pipeline, "mayCapture" | "ingest">;
  /** Seconds since the last keyboard or mouse input (Electron `powerMonitor.getSystemIdleTime`). */
  idleSeconds: () => number;
  now: Now;
  /** Called once when the reader failed `READER_FAILURE_LIMIT` times within the window. */
  onReaderProblem: () => void;
  /**
   * Called ONCE per streak, when the loop has run long enough and often enough without reading
   * anything. `counts` is that streak's tally, by outcome. `since` is when the last productive cycle
   * of the run ended, or when `start()` was called if there has not been one — the caller needs it to
   * say how long this has been going on, and only the loop knows it. Not a reader failure: capture
   * stays on, and the very next productive cycle clears it.
   */
  onNothingRead: (counts: BarrenCounts, since: number) => void;
  /** The notice raised by `onNothingRead` no longer holds. Called only if one was raised. */
  onReadingAgain: () => void;
}): CaptureLoop {
  const {reader, pipeline, idleSeconds, now} = deps;
  let active = false;
  let generation = 0;
  let reading = false;
  let dirty = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let failures: number[] = [];
  let stats: CycleStats = {};

  /** The run of barren cycles in progress: its tally, its length, and whether it has been reported. */
  let streak: BarrenCounts = {};
  let streakLength = 0;
  let noticeUp = false;
  /**
   * When the loop last read something, or when this run started, PLUS every span the user was away
   * for. The clock half of the two conditions, and it measures time the user was there.
   */
  let lastProductiveAt = 0;
  /** When the previous cycle of this run ended: how much time a `userAway` cycle takes off the clock. */
  let lastCycleAt = 0;

  /** A callback the caller wrote is the caller's to get wrong: it must never break the read loop. */
  function safely(call: () => void): void {
    try { call(); } catch { /* the engine's problem, not the loop's */ }
  }

  function clearStreak(): void { streak = {}; streakLength = 0; }

  /** The streak is over, whether because something was read or because the loop stopped. */
  function endStreak(): void {
    clearStreak();
    if (!noticeUp) return;
    noticeUp = false;
    safely(() => deps.onReadingAgain());
  }

  /**
   * The only place a streak grows or ends. BOTH conditions have to hold before anything is said: a
   * long quiet stretch with three cycles in it is not evidence, and neither is a burst of twenty-four
   * excluded windows in two minutes while the user works in 1Password.
   */
  function noteOutcome(outcome: CycleOutcome): void {
    const at = now();
    const sincePreviousCycle = at - lastCycleAt;
    lastCycleAt = at;
    const kind = CYCLE_CLASS[outcome];
    // Nobody was at the machine for this one. `userAway` stays NEUTRAL, exactly as D6 says: the
    // streak keeps its count and its tally, a notice already up stays up, and nothing is retracted —
    // walking away neither is evidence of a problem nor clears one.
    //
    // What it does do is take its own span off the CLOCK, so that "ten minutes" means ten minutes in
    // which the user was THERE and nothing came through. Left running, the clock let a locked lunch
    // raise the notice: ~20 barren cycles while the idle timer climbs to five minutes, then half an
    // hour of an empty chair, and the two conditions were satisfied between them within half a
    // minute of the user sitting down again, dated before the lock. Resetting the clock instead
    // would be worse the other way: a user who steps away for five minutes in every ten would hold
    // a genuinely barren machine below the threshold for ever.
    //
    // Never past `now()`: excluded time can only cancel time that has passed, never buy the clock a
    // future in which the notice can no longer be raised.
    if (outcome === "userAway") { lastProductiveAt = Math.min(at, lastProductiveAt + sincePreviousCycle); return; }
    if (kind === "neutral") return;
    if (kind === "productive") { endStreak(); lastProductiveAt = at; return; }
    const key = outcome as BarrenOutcome;
    streak[key] = (streak[key] ?? 0) + 1;
    streakLength += 1;
    if (noticeUp) return;                                       // once per streak, however long it runs
    if (streakLength < BARREN_CYCLE_LIMIT) return;
    if (at - lastProductiveAt < BARREN_AFTER_MS) return;
    noticeUp = true;
    const counts = {...streak};
    const since = lastProductiveAt;
    safely(() => deps.onNothingRead(counts, since));
  }

  /** One entry per reader call still in flight: gives it up so the cycle waiting on it can end. */
  const abandoners = new Set<() => void>();

  function withReaderTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let abandon = (): void => undefined;
    const raced = new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const claim = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        abandoners.delete(abandon);
        return true;
      };
      // Giving up both clears the deadline and settles the call, so no cycle is ever left hanging on
      // a reader that will not answer — which would hold the `reading` lock for the rest of the run.
      abandon = () => { if (claim()) reject(new ReaderCallTimeout()); };
      timer = setTimeout(abandon, ms);
      work.then((value) => { if (claim()) resolve(value); }, (error) => { if (claim()) reject(error); });
    });
    abandoners.add(abandon);
    return raced;
  }

  function noteFailure(): void {
    const t = now();
    failures = [...failures.filter((at) => t - at < READER_FAILURE_WINDOW_MS), t];
    if (failures.length >= READER_FAILURE_LIMIT) { failures = []; deps.onReaderProblem(); }
  }

  function tally(key: CycleOutcome | FailureTallyKey): void { stats[key] = (stats[key] ?? 0) + 1; }

  /**
   * What one cycle produced: the outcome, and — when the reader was at fault — the fixed key saying
   * which stage. `key` is null when there is no stage to name: a helper-reported `timeout`, which
   * the helper itself decided and cannot attribute further.
   *
   * Returned rather than tallied inside `cycle`, and that is the whole of the ordering fix: the
   * tally has to be complete before `noteFailure` may raise the problem, because raising it stops
   * the loop and writes `stats()` out. Tallied from inside `cycle`, after `noteFailure` had already
   * returned, the fifth failure — the one that caused the notice — was never counted, and the log
   * said `failed: 4` beside a `READER_PROBLEM` raised by five.
   */
  interface CycleReport { outcome: CycleOutcome; key: FailureTallyKey | null }

  /** The reader is charged for exactly these two, and no other outcome may be charged for. */
  const isFault = (outcome: CycleOutcome): boolean => outcome === "failed" || outcome === "timeout";

  /** An outcome with no stage to name — which is every outcome except the ones this side can place. */
  const plain = (outcome: CycleOutcome): CycleReport => ({outcome, key: null});

  async function cycle(mine: number): Promise<CycleReport> {
    // Which reader call is in flight, so the catch below can say which one rejected or hung. Set
    // immediately before each awaited call and cleared immediately after, so a throw from anything
    // that is NOT a reader call — `mayCapture`, `ingest` — finds it null and is charged to nobody in
    // particular (`failedUnknown`) rather than to whichever call happened to run last.
    let calling: "frontWindow" | "read" | null = null;
    try {
      // To the core, every mayCapture call is user activity. Someone who has not touched the
      // machine for five minutes is not working, so the core must not hear from us at all.
      // Guarded exactly as in schedulePoll: with no idle information, treat the user as active. A
      // throw here is the OS's business and never the reader's, so it must not count against it.
      let idle: number;
      try { idle = idleSeconds(); } catch { idle = 0; }
      if (idle >= AWAY_AFTER_SECONDS) return plain("userAway");
      calling = "frontWindow";
      const front = parseFrontWindow(await withReaderTimeout(reader.frontWindow(), READER_CALL_TIMEOUT_MS));
      calling = null;
      if (mine !== generation) return plain("stopped");
      if (!front) return plain("noWindow");
      if (!pipeline.mayCapture(front).allow) return plain("denied");     // nothing has been captured

      // `expect: front` is what the reader is allowed to capture: the window, and only the window,
      // the core has just approved. Everything else it answers `windowGone` without capturing.
      calling = "read";
      const read = reader.read({budgetMs: READ_BUDGET_MS, expect: front});
      const result = parseReadResult(await withReaderTimeout(read, READ_BUDGET_MS + READER_CALL_TIMEOUT_MS));
      calling = null;
      if (mine !== generation) return plain("stopped");
      // Only `failed` and `timeout` are the reader's fault. `locked`, `black` and `windowGone` are
      // states of the screen: the last of those is the ordinary answer while the user is switching
      // windows, and counting it would switch capture off for doing nothing wrong.
      //
      // A `failed` also says WHICH stage, when the reader could tell us: the detail the port let
      // through, mapped to its fixed key, or `failedUnknown` when there was none. `timeout` here is
      // the reader's own verdict on itself and carries no stage — the loop's own two timeouts, which
      // it CAN attribute, are in the catch below.
      if (!result.ok) {
        if (result.reason !== "failed") return plain(result.reason);
        return {outcome: "failed", key: result.detail === undefined ? "failedUnknown" : FAILED_DETAIL_KEY[result.detail]};
      }

      // The window may have changed while the picture was taken. Text from a window that was
      // never checked against the exclusions is thrown away. Both checks stay, and deliberately:
      // the reader now refuses such a window itself, but these two are main's own, they cost one
      // call, and they are what holds if a reader ever fails to keep its side of the bargain.
      calling = "frontWindow";
      const after = parseFrontWindow(await withReaderTimeout(reader.frontWindow(), READER_CALL_TIMEOUT_MS));
      calling = null;
      if (mine !== generation) return plain("stopped");
      if (!after || after.app !== front.app || after.title !== front.title) return plain("windowChanged");
      if (result.window.app !== front.app || result.window.title !== front.title) return plain("windowChanged");

      const outcome = pipeline.ingest({...front, text: result.text, ...(result.toolbarText === undefined ? {} : {toolbarText: result.toolbarText}), at: now()});
      if (outcome.kept) return plain("kept");
      // "The screen has not moved since the last read" is the one not-kept answer that means reading
      // WORKED. Someone reading a long document produces nothing else for minutes on end, and a run
      // of these must not look like a run of excluded windows.
      if (outcome.reason === "unchanged") return plain("unchanged");
      // And "there were almost no words on that screen" is its own answer too — a video player, an
      // image, a near-blank terminal, a design tool. Nothing was excluded and nothing is wrong, so
      // it must not be reported as `notAllowed` and send the user to Settings for a rule that does
      // not exist. It stays barren: an afternoon of it still means nothing is being read.
      return plain(outcome.reason === "empty" ? "empty" : "notKept");
    } catch (error) {
      // A cycle whose generation has moved on was given up on by stop(), not by the reader: the
      // reader is owed no blame for a call nobody was waiting for any more.
      if (mine !== generation) return plain("stopped");
      // Which call broke is the one thing the answer cannot tell us, because there was no answer.
      // A `frontWindow` that hangs or rejects is the window server or a dead helper; a `read` that
      // does is a capture or the recogniser. Before this they were one word, and the run that made
      // this necessary could not be told apart from either.
      if (error instanceof ReaderCallTimeout) {
        return {outcome: "timeout", key: calling === "frontWindow" ? "timeoutFrontWindow" : calling === "read" ? "timeoutRead" : null};
      }
      return {outcome: "failed", key: calling === "frontWindow" ? "failedFrontWindow" : calling === "read" ? "failedReadCall" : "failedUnknown"};
    }
  }

  async function trigger(): Promise<void> {
    if (!active) return;
    if (reading) { dirty = true; return; }
    reading = true;
    try {
      do {
        dirty = false;
        const {outcome, key} = await cycle(generation);
        // Tally FIRST, judge second. `noteFailure` can raise the reader problem, and raising it is
        // what ends the run: the engine stops the loop and writes `stats()` out with `CAPTURE_OFF`.
        // Counted afterwards, the cycle that caused the notice would be missing from the one line
        // anybody reads to find out why.
        tally(outcome);
        if (key) tally(key);
        if (isFault(outcome)) noteFailure();
        noteOutcome(outcome);
      } while (dirty && active);
    } finally { reading = false; }
  }

  function schedulePoll(): void {
    if (!active) return;
    // A throw here must never break the recursive setTimeout chain: with no idle information, treat
    // the user as active (the more frequent poll) rather than let the loop fall silent forever.
    let idle: number;
    try { idle = idleSeconds(); } catch { idle = 0; }
    const delay = idle >= IDLE_AFTER_SECONDS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
    pollTimer = setTimeout(() => { void trigger(); schedulePoll(); }, delay);
  }

  return {
    start() {
      if (active) return;
      // The subscription comes FIRST, and nothing else happens until it is in hand. A reader that
      // cannot be subscribed to sends no focus notifications, and marking the loop as running under
      // it would leave `running()` true with nothing subscribed, nothing polling and nothing to say
      // why — capture that is on in name only. So: no subscription, no run, and the supervision is
      // told, which is the caller's signal (`running()` stays false) to show the reader problem.
      let subscribed: (() => void) | null = null;
      try {
        subscribed = reader.onFocusChange(() => {
          // A reader that registered this callback and then threw, or one that keeps calling after
          // stop(): with the loop not running there is nothing to settle and no timer to arm.
          if (!active) return;
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => { settleTimer = null; void trigger(); }, FOCUS_SETTLE_MS);
        });
      } catch {
        deps.onReaderProblem();
        return;
      }
      unsubscribe = subscribed;
      active = true;
      generation += 1;
      // A fresh run judges the reader on what it does now. Failures from an earlier run — which may
      // have been days ago, or may have been the very reason capture went off — are not held against it.
      failures = [];
      // The tallies go with them, for the same reason and one more: they are written out when the
      // run ends, so carrying them forward would put this run's cycles in the next run's line too.
      stats = {};
      // Same for the barren streak, and for the clock it is measured against: a run that has just
      // begun has read nothing yet, and that is not something to tell anybody about. Starting the
      // clock here rather than leaving it at 0 is what stops the first cycle of the first run from
      // already being ten minutes old.
      clearStreak();
      lastProductiveAt = now();
      lastCycleAt = now();
      void trigger();
      schedulePoll();
    },
    stop() {
      if (!active) return;
      active = false;
      generation += 1;
      dirty = false;
      unsubscribe?.(); unsubscribe = null;
      if (pollTimer) clearTimeout(pollTimer);
      if (settleTimer) clearTimeout(settleTimer);
      pollTimer = null; settleTimer = null;
      // Give up whatever reader call the cycle in flight is waiting on. Its deadline timer goes with
      // it, and the cycle ends as "stopped" instead of holding the read lock until that deadline.
      // The copy matters: giving up removes the entry.
      for (const abandon of [...abandoners]) abandon();
      // And retract the notice if one is up. It says "reading is on and nothing is coming through",
      // which is a sentence about a running loop; left standing with capture off it would contradict
      // the tray beside it. The loop raised it, so the loop takes it back — one owner, and no caller
      // has to remember to clear it on each of the four paths that stop the loop. `active` is already
      // false above, so anything the callback asks about the loop gets the truth.
      endStreak();
    },
    running: () => active,
    stats: () => ({...stats})
  };
}
