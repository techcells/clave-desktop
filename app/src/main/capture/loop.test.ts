import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {CaptureDecision, FrontWindow, IngestOutcome, WindowRead} from "../../core/types";
import {ACTIVE_POLL_MS, AWAY_AFTER_SECONDS, BARREN_AFTER_MS, BARREN_CYCLE_LIMIT, FOCUS_SETTLE_MS, IDLE_AFTER_SECONDS, IDLE_POLL_MS, READ_BUDGET_MS, READER_CALL_TIMEOUT_MS, READER_FAILURE_LIMIT} from "../constants";
import type {ReadResult} from "../ports/reader";
import {createFakeReader} from "../testing/fakeReader";
import type {FailureDetail} from "../ports/reader";
import {createCaptureLoop, CYCLE_CLASS, cycleClass, FAILED_DETAIL_KEY, type BarrenOutcome} from "./loop";

function setup(opts: {allow?: (front: FrontWindow) => boolean; ingest?: () => IngestOutcome} = {}) {
  const reader = createFakeReader();
  reader.text = "some recognised text";
  const asked: FrontWindow[] = [];
  const ingested: WindowRead[] = [];
  const pipeline = {
    mayCapture(front: FrontWindow): CaptureDecision { asked.push(front); return (opts.allow ?? (() => true))(front) ? {allow: true} : {allow: false, reason: "excludedApp"}; },
    ingest(read: WindowRead): IngestOutcome { ingested.push(read); return (opts.ingest ?? (() => ({kept: true})))(); }
  };
  let idle = 0;
  const onReaderProblem = vi.fn();
  const onNothingRead = vi.fn();
  const onReadingAgain = vi.fn();
  const loop = createCaptureLoop({reader, pipeline, idleSeconds: () => idle, now: () => Date.now(), onReaderProblem, onNothingRead, onReadingAgain});
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return {reader, pipeline, asked, ingested, loop, onReaderProblem, onNothingRead, onReadingAgain, settle, setIdle: (s: number) => { idle = s; }};
}

describe("capture loop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("asks the core first, reads, and hands the text over with the core-checked window", async () => {
    const {reader, asked, ingested, loop, settle} = setup();
    loop.start();
    await settle();
    expect(asked).toEqual([{app: "Code", title: "query.sql"}]);
    expect(reader.reads).toBe(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({app: "Code", title: "query.sql", text: "some recognised text"});
    expect(loop.stats()).toEqual({kept: 1});
  });

  // The whole point of protocol 2: the reader is told which window the core approved, so it can
  // refuse to capture anything else. Without it the reader resolves the front window a second time,
  // by itself, and an excluded window that comes forward in the gap is captured and recognised
  // before main ever gets to throw the text away.
  it("tells the reader which window the core approved, and it is the one the core just checked", async () => {
    const {reader, asked, loop, settle} = setup();
    loop.start();
    await settle();
    expect(reader.expects).toEqual([{app: "Code", title: "query.sql"}]);
    expect(reader.expects[0]).toEqual(asked[0]);
  });

  it("carries the bundle id in the approved window when the front window has one", async () => {
    const {reader, loop, settle} = setup();
    reader.front = {app: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs"};
    loop.start();
    await settle();
    expect(reader.expects).toEqual([{app: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs"}]);
    expect(loop.stats()).toEqual({kept: 1});
  });

  it("approves the window of each cycle, not the first one for ever", async () => {
    const {reader, loop, settle} = setup();
    loop.start();
    await settle();
    reader.front = {app: "Slack", title: "#general"};
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(reader.expects).toEqual([{app: "Code", title: "query.sql"}, {app: "Slack", title: "#general"}]);
  });

  it("NEVER calls read() when the core denies the window", async () => {
    const {reader, loop, settle} = setup({allow: () => false});
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3);
    expect(reader.reads).toBe(0);
    expect(loop.stats().denied).toBe(4);
  });

  it("does not read when nothing identifiable is in front", async () => {
    const {reader, loop, settle} = setup();
    reader.front = null;
    loop.start();
    await settle();
    expect(reader.reads).toBe(0);
    expect(loop.stats()).toEqual({noWindow: 1});
  });

  it("throws the text away when the window changed while it was being read", async () => {
    const {reader, ingested, loop, settle} = setup();
    reader.duringRead = () => { reader.front = {app: "1Password", title: "Vault"}; };
    loop.start();
    await settle();
    expect(reader.reads).toBe(1);
    expect(ingested).toEqual([]);
    expect(loop.stats()).toEqual({windowChanged: 1});
  });

  it("throws the text away when the reader withholds the window's band while it was being read", async () => {
    // Same app, same title, but its toolbar can no longer be judged: the window the core approved is gone.
    const {reader, ingested, loop, settle} = setup();
    reader.duringRead = () => { reader.front = {app: "Code", title: "query.sql", bandWithheld: true}; };
    loop.start();
    await settle();
    expect(ingested).toEqual([]);
    expect(loop.stats()).toEqual({windowChanged: 1});
  });

  it("throws the text away when the reader reports a different window than the one that was checked", async () => {
    const {reader, ingested, loop, settle} = setup();
    reader.nextRead = {ok: true, window: {app: "Messages", title: "Anna"}, text: "private"};
    loop.start();
    await settle();
    expect(ingested).toEqual([]);
    expect(loop.stats()).toEqual({windowChanged: 1});
  });

  it("never queues reads: triggers during a read collapse into exactly one more", async () => {
    const {reader, loop, settle} = setup();
    reader.holdReads = true;
    loop.start();
    await settle();
    expect(reader.reads).toBe(1);
    for (let i = 0; i < 5; i++) { reader.focusChanged(); await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS); }
    expect(reader.reads).toBe(1);
    reader.holdReads = false;
    reader.releaseRead();
    await settle();
    expect(reader.reads).toBe(2);
  });

  it("reads shortly after a focus change, polls every 5 s while active and every 30 s while idle", async () => {
    const {reader, loop, settle, setIdle} = setup();
    loop.start();
    await settle();
    reader.focusChanged(); reader.focusChanged();
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS);
    expect(reader.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS - FOCUS_SETTLE_MS);
    expect(reader.reads).toBe(3);

    setIdle(IDLE_AFTER_SECONDS);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);      // the poll that notices the idleness
    const before = reader.reads;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(reader.reads).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.reads).toBe(before + 1);
  });

  it("goes silent once the user has been away for five minutes, so the core can close the scenario", async () => {
    const {reader, asked, loop, settle, setIdle} = setup();
    loop.start();
    await settle();
    setIdle(AWAY_AFTER_SECONDS);
    const before = {asked: asked.length, fronts: reader.frontCalls, reads: reader.reads};
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 4);
    expect({asked: asked.length, fronts: reader.frontCalls, reads: reader.reads}).toEqual(before);
    expect(loop.stats().userAway).toBeGreaterThan(0);
    setIdle(0);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(reader.reads).toBeGreaterThan(before.reads);      // back at the keyboard: reading again
  });

  it("stop is immediate: no more triggers, and a read in flight is thrown away", async () => {
    const {reader, ingested, loop, settle} = setup();
    reader.holdReads = true;
    loop.start();
    await settle();
    loop.stop();
    reader.releaseRead();
    await settle();
    reader.focusChanged();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 4);
    expect(ingested).toEqual([]);
    expect(reader.reads).toBe(1);
    expect(loop.running()).toBe(false);
    expect(loop.stats()).toEqual({stopped: 1});
  });

  it("counts skipped reads by reason, and treats a malformed result as a failed read", async () => {
    const {reader, ingested, loop, settle} = setup();
    reader.nextRead = {ok: false, reason: "locked"};
    loop.start();
    await settle();
    reader.nextRead = {ok: true, window: {app: "Code", title: "query.sql"}, text: 12345};
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(ingested).toEqual([]);
    // `failedUnknown` beside it: an answer that could not be parsed names no stage, and "we could
    // not tell" is itself a finding rather than something to leave out of the tally.
    expect(loop.stats()).toEqual({locked: 1, failed: 1, failedUnknown: 1});
  });

  it("records a vanished window as its own outcome and ingests nothing", async () => {
    const {reader, ingested, loop, settle} = setup();
    reader.nextRead = {ok: false, reason: "windowGone"};
    loop.start();
    await settle();
    expect(ingested).toEqual([]);
    expect(loop.stats()).toEqual({windowGone: 1});
  });

  // Measured in the first real run: 6 of 36 reads answered this way, every one of them mid
  // app-switch or under an overlay app. Counted as faults they switched capture off in ten minutes
  // of ordinary window switching, which is what this test exists to prevent from coming back.
  it("never reports a reader problem, however many windows vanish in a row", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    loop.start();
    await settle();
    for (let i = 0; i < 10; i++) {
      reader.nextRead = {ok: false, reason: "windowGone"};
      await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    }
    expect(onReaderProblem).not.toHaveBeenCalled();
    expect(loop.stats().windowGone).toBe(10);
  });

  it("reports a reader problem after five failures in ten minutes, but not for locked or black", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    loop.start();
    await settle();
    for (let i = 0; i < READER_FAILURE_LIMIT * 2; i++) { reader.nextRead = {ok: false, reason: "black"}; await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS); }
    expect(onReaderProblem).not.toHaveBeenCalled();
    for (let i = 0; i < READER_FAILURE_LIMIT; i++) { reader.nextRead = {ok: false, reason: "timeout"}; await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS); }
    expect(onReaderProblem).toHaveBeenCalledTimes(1);
  });

  /**
   * The tally has to be complete BEFORE the problem is raised, because raising it is what ends the
   * run: `onReaderProblem` stops the loop and the engine writes `stats()` out with `CAPTURE_OFF`.
   * Tallied afterwards, the fifth failure — the one that caused all of it — is never counted, and
   * the log says `failed: 4` beside a `READER_PROBLEM` raised by five. That is not a rounding error
   * in a log line: it is the one number anybody reads to find out what happened, and it is wrong by
   * exactly the cycle that matters most.
   */
  it("tallies the cycle that trips the limit before raising the problem, so all five are counted", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    let atProblem: ReturnType<typeof loop.stats> = {};
    onReaderProblem.mockImplementation(() => { atProblem = loop.stats(); });
    loop.start();
    await settle();
    for (let i = 0; i < READER_FAILURE_LIMIT; i++) {
      reader.nextRead = {ok: false, reason: "failed"};
      await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    }
    expect(onReaderProblem).toHaveBeenCalledTimes(1);
    expect(atProblem.failed).toBe(READER_FAILURE_LIMIT);
    // And the detail keys are complete at that same moment, for the same reason.
    expect(atProblem.failedUnknown).toBe(READER_FAILURE_LIMIT);
  });

  /**
   * The tally that makes a `READER_PROBLEM` line readable: `failed` still counts every failure, and
   * exactly one stage key counts beside it saying which step it was. Driven through the real port —
   * the fake hands `nextRead` over raw and the loop parses it — so what is pinned here is the whole
   * path a helper's word travels, not a table lookup.
   *
   * `Record` makes it exhaustive: a detail added to the port with no row here does not compile, so
   * no stage can arrive with nobody having decided what it is called.
   */
  const detailCases: Record<FailureDetail, undefined> = {
    noExpect: undefined, noGrant: undefined, captureRefused: undefined, captureTimeout: undefined,
    captureError: undefined, captureNoContent: undefined, captureNoImage: undefined,
    recogniseError: undefined, helperDown: undefined
  };

  /**
   * The table itself, spelled out. The sweep below asks the table what each stage is called, so it
   * would pass against any table at all; this is what says the names are THESE names — the ones
   * written into `LOG_COUNT_KEYS` and the ones anybody reading `app.log` will search for.
   */
  it("names each failure stage with its own fixed count key", () => {
    expect(FAILED_DETAIL_KEY).toEqual({
      noExpect: "failedNoExpect", noGrant: "failedNoGrant", captureRefused: "failedCaptureRefused",
      captureTimeout: "failedCaptureTimeout", captureError: "failedCaptureError",
      captureNoContent: "failedCaptureNoContent", captureNoImage: "failedCaptureNoImage",
      recogniseError: "failedRecognise", helperDown: "failedHelperDown"
    });
    // One key each: two stages sharing a key would silently merge two different faults.
    expect(new Set(Object.values(FAILED_DETAIL_KEY)).size).toBe(Object.keys(FAILED_DETAIL_KEY).length);
  });

  it.each(Object.keys(detailCases) as FailureDetail[])("tallies a failure the reader blamed on %s under its own key", async (detail) => {
    const {reader, loop, settle} = setup();
    reader.read = async () => ({ok: false, reason: "failed", detail});
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({failed: 1, [FAILED_DETAIL_KEY[detail]]: 1});
    loop.stop();
  });

  /**
   * The two answers the loop cannot get a stage from, and the honest key for each. `failedUnknown`
   * is not a gap in the feature: a run that is all `failedUnknown` says the helper is too old or too
   * broken to diagnose itself, which is something worth learning from a log.
   */
  it.each([
    ["no detail at all, as an older helper sends", {ok: false, reason: "failed"}],
    ["a detail the port refused", {ok: false, reason: "failed", detail: "captureExploded"}],
    ["a detail that is not even a string", {ok: false, reason: "failed", detail: 7}],
    ["an answer that could not be parsed", {ok: true, text: 5}]
  ])("tallies a failure with %s as failedUnknown", async (_what, answer) => {
    const {reader, loop, settle} = setup();
    reader.read = async () => answer as never;
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({failed: 1, failedUnknown: 1});
    loop.stop();
  });

  // A detail on an answer that is not `failed` changes nothing: the port drops it, and the outcome
  // is tallied as the state of the screen it is. Nothing is counted against the reader.
  it("never tallies a stage for an answer that is not a failure", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    reader.read = async () => ({ok: false, reason: "black", detail: "captureTimeout"}) as never;
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({black: 1});
    expect(onReaderProblem).not.toHaveBeenCalled();
    loop.stop();
  });

  /**
   * When the call REJECTS there is no answer to carry a detail, so only this side can say which call
   * it was — and the two mean entirely different things. A `frontWindow` that rejects is the window
   * server or a helper that is not there; a `read` that rejects is a capture or the recogniser.
   */
  it("says which reader call rejected: the front-window call or the read", async () => {
    const front = setup();
    front.reader.frontWindow = async () => { throw new Error("helper died"); };
    front.loop.start();
    await front.settle();
    expect(front.loop.stats()).toEqual({failed: 1, failedFrontWindow: 1});
    front.loop.stop();

    const read = setup();
    read.reader.read = async () => { throw new Error("the capture blew up"); };
    read.loop.start();
    await read.settle();
    expect(read.loop.stats()).toEqual({failed: 1, failedReadCall: 1});
    read.loop.stop();
  });

  /**
   * The same split for a call that never settles at all. `timeout` keeps counting both, exactly as
   * before; the two keys beside it are what says whether it was the window server or the capture
   * that hung — which is the one question a `timeout: 5` line used to leave open.
   */
  it("says which reader call hung: the front-window call or the read", async () => {
    const front = setup();
    front.reader.frontWindow = () => new Promise(() => undefined);
    front.loop.start();
    await front.settle();
    await vi.advanceTimersByTimeAsync(READER_CALL_TIMEOUT_MS);
    expect(front.loop.stats()).toMatchObject({timeout: 1, timeoutFrontWindow: 1});
    expect(front.loop.stats().timeoutRead).toBeUndefined();
    front.loop.stop();

    const read = setup();
    read.reader.read = () => new Promise(() => undefined);
    read.loop.start();
    await read.settle();
    await vi.advanceTimersByTimeAsync(READ_BUDGET_MS + READER_CALL_TIMEOUT_MS);
    expect(read.loop.stats()).toMatchObject({timeout: 1, timeoutRead: 1});
    expect(read.loop.stats().timeoutFrontWindow).toBeUndefined();
    read.loop.stop();
  });

  /**
   * A throw from something that is NOT a reader call must not be blamed on whichever call ran last.
   * Both positions are covered, and they are different guards: `mayCapture` throws right after the
   * FIRST `frontWindow` returns, `ingest` right after the second one does. Each is pinned by its own
   * `calling = null`, and a test of only one of them leaves the other free to blame the window
   * server for a fault in the core's exclusion rules — which is a plausible throw, since
   * `mayCapture` runs the user's own rules over a real window title.
   */
  it.each([
    ["mayCapture, right after the first front-window call", {allow: () => { throw new Error("the exclusion rules threw"); }}],
    ["ingest, right after the second", {ingest: () => { throw new Error("the pipeline threw"); }}]
  ])("never blames a reader call for a throw from %s", async (_where, hooks) => {
    const {loop, settle} = setup(hooks as Parameters<typeof setup>[0]);
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({failed: 1, failedUnknown: 1});
    loop.stop();
  });

  /**
   * The stage keys split the SAME total rather than replacing it, so `failed` and `timeout` still
   * mean what every existing reader of a log line takes them to mean, and the split sums back to
   * them. A stage key that was counted instead of the outcome would quietly change `CYCLE_CLASS`'s
   * arithmetic — the barren-streak feature reads those outcomes — without touching the table.
   */
  it("counts the stage in addition to the outcome, never instead of it", async () => {
    const {reader, loop, settle} = setup();
    const details: FailureDetail[] = ["noGrant", "captureTimeout", "captureTimeout", "recogniseError"];
    loop.start();
    await settle();                                   // cycle 1: a good read
    for (const detail of details) {
      reader.nextRead = {ok: false, reason: "failed", detail};
      await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    }
    const stats = loop.stats();
    expect(stats.failed).toBe(details.length);
    expect(stats.failedNoGrant).toBe(1);
    expect(stats.failedCaptureTimeout).toBe(2);
    expect(stats.failedRecognise).toBe(1);
    const staged = (stats.failedNoGrant ?? 0) + (stats.failedCaptureTimeout ?? 0) + (stats.failedRecognise ?? 0);
    expect(staged).toBe(stats.failed);
    loop.stop();
  });

  // Per run like every other tally, and for the same reason: each CAPTURE_OFF line is that run.
  it("clears the stage tallies when a fresh run starts", async () => {
    const {reader, loop, settle} = setup();
    reader.read = async () => ({ok: false, reason: "failed", detail: "captureRefused"});
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({failed: 1, failedCaptureRefused: 1});
    loop.stop();

    reader.read = async () => ({ok: false, reason: "failed", detail: "noGrant"});
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({failed: 1, failedNoGrant: 1});
    loop.stop();
  });

  it("survives a reader that throws", async () => {
    const {reader, loop, settle} = setup();
    reader.frontWindow = async () => { throw new Error("reader process died"); };
    loop.start();
    await settle();
    // The rejecting call is named: no answer came back, so only this side can say which call it was.
    expect(loop.stats()).toEqual({failed: 1, failedFrontWindow: 1});
    expect(loop.running()).toBe(true);
  });

  it("times out a front-window call that never settles, counts it, and the next poll runs a fresh cycle", async () => {
    const {reader, loop, settle} = setup();
    reader.frontWindow = () => new Promise(() => undefined);
    loop.start();
    await settle();
    // Restore it before the timeout lands, so the poll due at the same moment gets a working reader.
    reader.frontWindow = async () => { reader.frontCalls += 1; return reader.front; };
    await vi.advanceTimersByTimeAsync(READER_CALL_TIMEOUT_MS);
    expect(loop.stats().timeout).toBe(1);
    expect(loop.running()).toBe(true);
    expect(loop.stats().kept).toBeGreaterThan(0);
  });

  it("times out a read that never settles, counts it, and a late result is never ingested", async () => {
    const {reader, ingested, loop, settle} = setup();
    let resolveLate!: (value: ReadResult) => void;
    let calls = 0;
    reader.read = async () => {
      calls += 1;
      if (calls === 1) return new Promise<ReadResult>((resolve) => { resolveLate = resolve; });
      return {ok: true, window: reader.front as FrontWindow, text: reader.text};
    };
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(READ_BUDGET_MS + READER_CALL_TIMEOUT_MS);
    expect(loop.stats().timeout).toBe(1);
    expect(loop.running()).toBe(true);

    resolveLate({ok: true, window: reader.front as FrontWindow, text: "STALE - must never be ingested"});
    await settle();
    expect(ingested.some((r) => r.text.includes("STALE"))).toBe(false);
  });

  it("keeps polling and reading when idleSeconds throws, and never charges it to the reader", async () => {
    const reader = createFakeReader();
    reader.text = "some recognised text";
    const pipeline = {
      mayCapture: (): CaptureDecision => ({allow: true}),
      ingest: (): IngestOutcome => ({kept: true})
    };
    const onReaderProblem = vi.fn();
    const loop = createCaptureLoop({
      reader, pipeline, idleSeconds: () => { throw new Error("idle info unavailable"); }, now: () => Date.now(), onReaderProblem,
      onNothingRead: vi.fn(), onReadingAgain: vi.fn()
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3);
    expect(loop.running()).toBe(true);
    // No idle information means "treat the user as active", in the cycle exactly as in the poll: the
    // reads go on as normal, and nothing about this is the reader's fault.
    expect(reader.reads).toBeGreaterThanOrEqual(3);
    expect(loop.stats().kept).toBeGreaterThanOrEqual(3);
    expect(loop.stats().failed ?? 0).toBe(0);
    expect(onReaderProblem).not.toHaveBeenCalled();
    loop.stop();
  });

  it("clears a pending reader-timeout timer on stop, and starts cleanly again afterwards", async () => {
    const {reader, loop, settle} = setup();
    reader.read = () => new Promise(() => undefined);
    loop.start();
    await settle();
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);          // nothing of the abandoned cycle is still pending

    reader.read = async () => { reader.reads += 1; return {ok: true, window: reader.front as FrontWindow, text: reader.text}; };
    loop.start();
    await settle();
    expect(loop.stats().kept).toBe(1);           // the read lock was released: a fresh cycle can run
    loop.stop();
  });

  it("never charges a cycle that stop() abandoned to the reader", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    reader.read = () => new Promise(() => undefined);
    for (let i = 0; i < READER_FAILURE_LIMIT; i++) {
      loop.start();
      await settle();
      loop.stop();
      await settle();       // let the abandoned cycle finish before the next run starts
      // Counted per run, so the check is per run too: one abandoned cycle each time, and five runs
      // of it in a row — the number that would report a reader problem if any of them were charged.
      expect(loop.stats()).toEqual({stopped: 1});
    }
    expect(loop.stats().timeout ?? 0).toBe(0);
    expect(loop.stats().failed ?? 0).toBe(0);
    expect(onReaderProblem).not.toHaveBeenCalled();
  });

  it("is not running, and reports a reader problem, when the reader refuses to subscribe", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    const realSubscribe = reader.onFocusChange;
    reader.onFocusChange = () => { throw new Error("reader process died"); };

    expect(() => { loop.start(); }).not.toThrow();
    // No subscription means no focus notifications; polling on top of that would be a loop that only
    // ever reads on a timer, silently. Better to not be running at all and say so.
    expect(loop.running()).toBe(false);
    expect(onReaderProblem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 4);
    expect(reader.frontCalls).toBe(0);
    expect(reader.reads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // A reader that comes back can be started normally.
    reader.onFocusChange = realSubscribe;
    loop.start();
    await settle();
    expect(loop.running()).toBe(true);
    expect(loop.stats().kept).toBe(1);
    loop.stop();
  });

  it("forgets earlier reader failures when the loop is started again", async () => {
    const {reader, loop, onReaderProblem, settle} = setup();
    loop.start();
    await settle();
    for (let i = 0; i < READER_FAILURE_LIMIT - 1; i++) {
      reader.nextRead = {ok: false, reason: "failed"};
      await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    }
    expect(onReaderProblem).not.toHaveBeenCalled();

    loop.stop();
    loop.start();
    await settle();
    reader.nextRead = {ok: false, reason: "failed"};
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    // A fresh run starts with a clean bank: this is failure one of five, not five of five.
    expect(onReaderProblem).not.toHaveBeenCalled();
    loop.stop();
  });
});

/**
 * The defect these cover: the tray said "Reading is on" while nothing whatever was read, indefinitely
 * and invisibly — an excluded app in front all afternoon, a lock `powerMonitor` never reported, a
 * title that ticks faster than a read. None of it is a reader failure, so `onReaderProblem` never
 * fires and nothing else ever noticed.
 */
describe("capture loop: a long run in which nothing is read", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("has an answer for every outcome, and only a read that worked counts as reading", () => {
    expect(Object.keys(CYCLE_CLASS).sort()).toEqual([
      "black", "denied", "empty", "failed", "kept", "locked", "noWindow", "notKept", "stopped",
      "timeout", "unchanged", "userAway", "windowChanged", "windowGone"
    ]);
    // `unchanged` is productive: the read WORKED and the screen simply had not moved. `userAway` is
    // neutral: an empty chair is not the app failing to read. Both are the whole point of the table.
    expect(cycleClass("kept")).toBe("productive");
    expect(cycleClass("unchanged")).toBe("productive");
    expect(cycleClass("userAway")).toBe("neutral");
    expect(cycleClass("stopped")).toBe("neutral");
    expect(cycleClass("timeout")).toBe("neutral");
    expect(cycleClass("failed")).toBe("neutral");
    for (const outcome of ["noWindow", "windowGone", "black", "windowChanged", "denied", "notKept", "locked", "empty"] as const) {
      expect(cycleClass(outcome), outcome).toBe("barren");
    }
  });

  /** 120 polls of the 5 s loop is exactly the ten minutes, and the 121 cycles are past the 24. */
  const POLLS_TO_BOTH_CONDITIONS = BARREN_AFTER_MS / ACTIVE_POLL_MS;

  /**
   * One driver per barren outcome, so each of them can be put through a real streak. `Record` makes
   * this exhaustive: a barren outcome added later has no driver until someone writes one, which is
   * the point — the table above says what each outcome IS CALLED, and only these say what the loop
   * then DOES with it.
   */
  const streakOf: Record<BarrenOutcome, () => ReturnType<typeof setup>> = {
    noWindow: () => { const s = setup(); s.reader.front = null; return s; },
    denied: () => setup({allow: () => false}),
    notKept: () => setup({ingest: () => ({kept: false, reason: "excludedTitle"})}),
    empty: () => setup({ingest: () => ({kept: false, reason: "empty"})}),
    // `nextRead` is spent by the cycle that takes it, so a screen that stays in one state for ten
    // minutes has to come from the reader itself.
    windowGone: () => { const s = setup(); s.reader.read = async () => ({ok: false, reason: "windowGone"}); return s; },
    black: () => { const s = setup(); s.reader.read = async () => ({ok: false, reason: "black"}); return s; },
    locked: () => { const s = setup(); s.reader.read = async () => ({ok: false, reason: "locked"}); return s; },
    // A title that ticks faster than a read: main's own after-check catches it on every cycle.
    windowChanged: () => {
      const s = setup();
      let tick = 0;
      s.reader.duringRead = () => { tick += 1; s.reader.front = {app: "Code", title: `query ${tick}.sql`}; };
      return s;
    }
  };

  /**
   * The classification table is pinned by the test above, but a table says nothing about what runs.
   * A special case for one outcome inside `noteOutcome` — an early return, a streak reset, a "this
   * one does not really count" — would leave that table untouched and quietly take the outcome out
   * of the feature. So every barren outcome is driven end to end, once, here.
   */
  it.each(Object.keys(streakOf) as BarrenOutcome[])("raises the notice on a streak of nothing but %s cycles", async (outcome) => {
    const {loop, onNothingRead, onReadingAgain, settle} = streakOf[outcome]();
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * (POLLS_TO_BOTH_CONDITIONS - 1));
    expect(onNothingRead).not.toHaveBeenCalled();          // one poll short of the ten minutes
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    // Every cycle of the run is in the tally, under this outcome's own name and no other.
    expect(onNothingRead.mock.calls[0]![0]).toEqual({[outcome]: POLLS_TO_BOTH_CONDITIONS + 1});
    expect(onReadingAgain).not.toHaveBeenCalled();
    loop.stop();
  });

  it("says nothing about 23 barren cycles spread over more than ten minutes", async () => {
    const {reader, loop, onNothingRead, settle, setIdle} = setup();
    reader.front = null;                                  // every cycle: noWindow
    setIdle(IDLE_AFTER_SECONDS);                          // the 30 s poll, so 23 cycles span 11 minutes
    const startedAt = Date.now();
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 22);
    expect(loop.stats()).toEqual({noWindow: 23});
    expect(Date.now() - startedAt).toBeGreaterThan(BARREN_AFTER_MS);
    expect(onNothingRead).not.toHaveBeenCalled();
  });

  it("says nothing about 31 barren cycles inside two and a half minutes", async () => {
    const {reader, loop, onNothingRead, settle} = setup();
    reader.front = null;
    const startedAt = Date.now();
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 30);
    expect(loop.stats()).toEqual({noWindow: 31});         // well past the 24 cycles
    expect(Date.now() - startedAt).toBeLessThan(BARREN_AFTER_MS);
    expect(onNothingRead).not.toHaveBeenCalled();         // but nowhere near the ten minutes
  });

  it("raises it exactly once when both conditions hold, with the streak's own tally", async () => {
    let allow = false;
    const {reader, loop, onNothingRead, settle} = setup({allow: () => allow});
    reader.front = {app: "1Password", title: "Vault"};    // excluded: denied, and never read
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 60);
    reader.front = null;                                  // and then nothing in front at all
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 59);
    expect(onNothingRead).not.toHaveBeenCalled();         // 120 cycles, one poll short of ten minutes
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(onNothingRead.mock.calls[0]![0]).toEqual({denied: 61, noWindow: 60});
    expect(onNothingRead.mock.calls[0]![1]).toBe(Date.now() - BARREN_AFTER_MS);

    // Once per streak, however long it runs: another ten minutes of the same changes nothing.
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 120);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(loop.running()).toBe(true);
    loop.stop();
  });

  it("takes it back on the first cycle that reads something, and can raise a fresh streak later", async () => {
    let allow = false;
    const {reader, loop, onNothingRead, onReadingAgain, settle} = setup({allow: () => allow});
    reader.front = {app: "1Password", title: "Vault"};
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 120);
    expect(onNothingRead).toHaveBeenCalledTimes(1);

    allow = true;                                          // one window the core allows: kept
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(loop.stats().kept).toBe(1);
    expect(onReadingAgain).toHaveBeenCalledTimes(1);

    // A second streak is judged from scratch, and raises on its own once BOTH conditions hold again.
    allow = false;
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 119);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(onNothingRead).toHaveBeenCalledTimes(2);
    expect(onReadingAgain).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("counts a screen that has not moved as a read that worked, and never as a barren cycle", async () => {
    const outcome: IngestOutcome = {kept: false, reason: "unchanged"};
    const {loop, onNothingRead, settle} = setup({ingest: () => outcome});
    loop.start();
    await settle();
    expect(loop.stats()).toEqual({unchanged: 1});          // ingest said "unchanged", the loop says so too
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 180);
    expect(loop.stats()).toEqual({unchanged: 181});        // fifteen minutes of a document held still
    expect(onNothingRead).not.toHaveBeenCalled();
  });

  it("an unchanged cycle ends a streak, exactly as a kept one does", async () => {
    let outcome: IngestOutcome = {kept: false, reason: "excludedTitle"};
    const {loop, onNothingRead, onReadingAgain, settle} = setup({ingest: () => outcome});
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 120);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(onNothingRead.mock.calls[0]![0]).toEqual({notKept: 121});

    outcome = {kept: false, reason: "unchanged"};
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(onReadingAgain).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  // Walking away for lunch must never raise this by itself: with no input for five minutes the loop
  // does not look at a screen at all, so those cycles say nothing about whether reading works. They
  // stay NEUTRAL for the streak (D6) — the tally from before the chair emptied is still the tally —
  // and the only thing the away stretch changes is the clock, which does not run while nobody is there.
  it("a user who is away neither extends the streak nor ends it", async () => {
    const {reader, loop, onNothingRead, settle, setIdle} = setup();
    // The run's own tally at the moment the notice goes up, so the streak can be compared with it.
    let statsAtRaise: Partial<Record<string, number>> = {};
    onNothingRead.mockImplementation(() => { statsAtRaise = loop.stats(); });
    reader.front = null;
    loop.start();
    await settle();                                        // barren cycle 1

    setIdle(AWAY_AFTER_SECONDS);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 40);   // twenty minutes of an empty chair
    expect(loop.stats().userAway).toBe(40);
    expect(onNothingRead).not.toHaveBeenCalled();

    setIdle(0);
    const backAt = Date.now();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);        // the armed idle poll, then the active rate
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 22);
    // Well past the 24 cycles, and the away ones are not among them — and still nothing is said,
    // because two minutes of a user who is back is not the ten minutes the notice is about.
    expect(loop.stats().noWindow as number).toBeGreaterThanOrEqual(BARREN_CYCLE_LIMIT);
    expect(loop.stats().noWindow as number).toBeLessThan(loop.stats().userAway as number);
    expect(onNothingRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BARREN_AFTER_MS);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    // The streak survived the away stretch whole — it did not restart at cycle 1 when the user came
    // back; every barren cycle of the run is in it, the one from before the lunch included.
    expect(onNothingRead.mock.calls[0]![0]).toEqual({noWindow: statsAtRaise.noWindow as number});
    // And the twenty minutes of nobody there came off the clock: it stands at the last away cycle,
    // i.e. the return, give or take the one poll that straddles it.
    expect(onNothingRead.mock.calls[0]![1]).toBeGreaterThanOrEqual(backAt - IDLE_POLL_MS);
    expect(onNothingRead.mock.calls[0]![1]).toBeLessThanOrEqual(backAt);
    loop.stop();
  });

  /**
   * The locked lunch, which is what a walk away actually looks like: the screen locks, the loop
   * keeps polling and finds nothing readable for the five minutes it takes the idle clock to reach
   * `AWAY_AFTER_SECONDS`, and only then do the cycles go neutral. Those ~20 barren cycles plus the
   * half hour the chair was empty used to satisfy both conditions between them, so the notice was
   * raised within half a minute of the user sitting down again — dated before the lock, about a
   * stretch in which nobody asked the app to read anything.
   *
   * What the lock's own five minutes ARE is five minutes of a machine that was on, unlocked-until-
   * just-now and reading nothing; they stay on the clock, so the notice comes after five more
   * minutes of the same with the user back at the desk. Ten minutes of presence, as it says.
   */
  it("says nothing right after a locked lunch, however many barren cycles the lock itself made", async () => {
    const {reader, loop, onNothingRead, settle, setIdle} = setup();
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 59);   // five minutes of ordinary reading
    expect(loop.stats().kept).toBe(60);

    const lockedAt = Date.now();                             // the screen locks: nothing readable
    reader.front = null;
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 12);   // a minute before the idle poll takes over
    setIdle(IDLE_AFTER_SECONDS);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 8);      // four more, to the five-minute away line
    expect(loop.stats().noWindow).toBeGreaterThanOrEqual(19);
    expect(onNothingRead).not.toHaveBeenCalled();

    setIdle(AWAY_AFTER_SECONDS);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 60);     // half an hour of lunch
    const backAt = Date.now();

    setIdle(0);                                              // back at the desk, nothing readable yet
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(onNothingRead).not.toHaveBeenCalled();            // NOT in the first half minute: the flash
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 30);   // nor in the two and a half minutes after
    expect(onNothingRead).not.toHaveBeenCalled();

    // And when it is finally said, it is measured on presence: the half hour of lunch is not in it.
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 60);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(Date.now() - (onNothingRead.mock.calls[0]![1] as number)).toBeGreaterThanOrEqual(BARREN_AFTER_MS);
    expect(onNothingRead.mock.calls[0]![1]).toBeLessThan(backAt);      // the clock is behind the wall
    expect(onNothingRead.mock.calls[0]![1]).toBeGreaterThan(lockedAt);
    loop.stop();
  });

  /**
   * The other way round, and the reason the clock is not simply restarted when the user comes back:
   * someone who steps away for five minutes in every ten would then hold a genuinely barren machine
   * below the ten minutes for ever, however long it went on. Excluding the away spans instead means
   * the presence adds up — a shape as ordinary as reading a long document in an app the reader
   * cannot read, or watching a video, where "no input for five minutes and nothing readable" is
   * simply what the afternoon looks like.
   */
  it("still says it when a barren machine is used four minutes in every nine", async () => {
    const {reader, loop, onNothingRead, setIdle, settle} = setup();
    reader.front = null;                                     // nothing readable, for two hours
    loop.start();
    await settle();

    for (let stretch = 0; stretch < 12; stretch++) {
      setIdle(0);
      await vi.advanceTimersByTimeAsync(4 * 60_000);         // four minutes at the desk
      setIdle(AWAY_AFTER_SECONDS);
      await vi.advanceTimersByTimeAsync(5 * 60_000);         // five minutes away
    }

    // Raised, once, during the third stretch — when the PRESENT barren time passed ten minutes, not
    // when the wall clock did. Twelve stretches is nearly two hours; it must not say it twelve times.
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(loop.stats().userAway as number).toBeGreaterThan(100);
    expect(onNothingRead.mock.calls[0]![0].noWindow as number).toBeGreaterThanOrEqual(BARREN_CYCLE_LIMIT);
    loop.stop();
  });

  /** And an empty chair on its own is never evidence of anything, however long it lasts. */
  it("says nothing about two hours in which nobody was at the machine at all", async () => {
    const {reader, loop, onNothingRead, setIdle, settle} = setup();
    reader.front = null;
    loop.start();
    await settle();                                          // barren cycle 1, at the desk

    setIdle(AWAY_AFTER_SECONDS);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(loop.stats().userAway as number).toBeGreaterThan(200);
    expect(loop.stats().noWindow).toBe(1);
    expect(onNothingRead).not.toHaveBeenCalled();
    loop.stop();
  });

  it("a reader that fails or times out neither extends the streak nor ends it", async () => {
    let allow = false;
    const {reader, loop, onNothingRead, onReaderProblem, settle, setIdle} = setup({allow: () => allow});
    reader.front = {app: "1Password", title: "Vault"};
    setIdle(IDLE_AFTER_SECONDS);                            // the 30 s poll: the whole run spans 14 minutes
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 19);
    expect(loop.stats().denied).toBe(20);

    const working = reader.frontWindow;
    reader.frontWindow = async () => { throw new Error("helper died"); };
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    reader.frontWindow = working;
    allow = true;
    reader.read = () => new Promise(() => undefined);        // a read that never answers
    // The second of the two only gives up after its own deadline, which falls between two polls.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2 + READ_BUDGET_MS + READER_CALL_TIMEOUT_MS);
    expect(loop.stats()).toMatchObject({denied: 20, failed: 2, timeout: 2});

    allow = false;
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(loop.stats().denied).toBe(23);
    expect(onNothingRead).not.toHaveBeenCalled();            // 23 barren cycles: the four faults did not count
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(onNothingRead.mock.calls[0]![0]).toEqual({denied: 24});
    expect(onReaderProblem).not.toHaveBeenCalled();          // four faults is under the limit of five
    loop.stop();
  });

  it("takes the notice back when the loop stops, so nothing is left saying it while capture is off", async () => {
    const {reader, loop, onNothingRead, onReadingAgain, settle} = setup();
    reader.front = null;
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 120);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(onReadingAgain).not.toHaveBeenCalled();

    loop.stop();
    expect(onReadingAgain).toHaveBeenCalledTimes(1);
    expect(loop.running()).toBe(false);
    // And a stop with nothing raised says nothing: the notice is retracted, never announced.
    loop.stop();
    expect(onReadingAgain).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh run with an empty streak and a fresh clock", async () => {
    const {reader, loop, onNothingRead, settle, setIdle} = setup();
    reader.front = null;
    setIdle(IDLE_AFTER_SECONDS);
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 22);    // 23 barren cycles over eleven minutes
    expect(onNothingRead).not.toHaveBeenCalled();
    loop.stop();

    setIdle(0);
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 60);  // 61 more, but only five minutes of them
    // Nothing of the old run carries over: not its 23 cycles, not the eleven minutes, and not its
    // tallies either — `stats()` answers for the run in hand, which is what each CAPTURE_OFF line
    // has to mean if it is to be read as "what that run did".
    expect(loop.stats()).toEqual({noWindow: 61});
    expect(onNothingRead).not.toHaveBeenCalled();
    loop.stop();
  });

  it("keeps reading when either callback throws", async () => {
    const {reader, loop, onNothingRead, onReadingAgain, settle} = setup();
    onNothingRead.mockImplementation(() => { throw new Error("the engine threw"); });
    onReadingAgain.mockImplementation(() => { throw new Error("and again"); });
    reader.front = null;
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 120);
    expect(onNothingRead).toHaveBeenCalledTimes(1);
    expect(loop.running()).toBe(true);

    reader.front = {app: "Code", title: "query.sql"};
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(onReadingAgain).toHaveBeenCalledTimes(1);
    expect(loop.stats().kept).toBe(1);                       // the throw cost the cycle nothing
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3);
    expect(loop.stats().kept).toBe(4);
    loop.stop();
  });
});

// The fake stands in for the native reader everywhere in this suite, so it has to keep the port's
// promises — otherwise the loop is tested against behaviour the real reader does not have.
describe("the fake reader honours the window it was told main approved", () => {
  const gone = {ok: false, reason: "windowGone"};

  it("refuses a window whose app, title or bundle id is not the approved one", async () => {
    const reader = createFakeReader({app: "Code", title: "query.sql"});
    reader.text = "some recognised text";
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", title: "query.sql"}}))
      .toEqual({ok: true, window: {app: "Code", title: "query.sql"}, text: "some recognised text"});
    expect(await reader.read({budgetMs: 100, expect: {app: "1Password", title: "query.sql"}})).toEqual(gone);
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", title: "secrets.sql"}})).toEqual(gone);
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", bundleId: "com.microsoft.VSCode", title: "query.sql"}}))
      .toEqual(gone);
  });

  it("says a vanished window rather than a failure when nothing is in front", async () => {
    // `failed` is what the loop counts towards switching capture off; an empty desktop must not.
    const reader = createFakeReader(null);
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", title: "query.sql"}})).toEqual(gone);
  });
});
