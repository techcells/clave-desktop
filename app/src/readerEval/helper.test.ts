import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import {encode} from "../main/reader/protocol";
import {approve} from "./guard";
import {createEvalHelper, encodeRead, permissionOf, readWindow, spawnHelper, waitReadyFrom, type EvalHelper} from "./helper";
import {stagedTitleFor} from "./stagedTitle";
import {createFakeLink, createManualSchedule, respondTo} from "./testing/fakes";

const staged = stagedTitleFor("chat-light-14", "abc123");
const window: FrontWindow = {app: "Google Chrome", bundleId: "com.google.Chrome", title: staged};
const approval = approve(window, {app: "Google Chrome", stagedTitle: staged});
if (approval === null) throw new Error("the fixture window must be approvable");

describe("the read line", () => {
  /**
   * The harness encodes `read` itself, because it carries the evaluation-only `lines` switch that
   * the app's `ToHelper` has no member for and must never grow one. This is what keeps the two from
   * drifting: without `lines`, the byte string must be identical to what the product's own encoder
   * produces for the same call.
   */
  it("is byte for byte the product's own encoding when it does not ask for lines", () => {
    expect(encodeRead(7, 1_500, window, false)).toBe(encode({id: 7, op: "read", budgetMs: 1_500, expect: window}));
  });

  it("adds `lines` only when asked", () => {
    expect(JSON.parse(encodeRead(7, 1_500, window, true))).toEqual({
      id: 7, op: "read", budgetMs: 1_500, expect: window, lines: true
    });
    expect(encodeRead(7, 1_500, window, false)).not.toContain("lines");
  });

  it("always carries the approved window as `expect`", () => {
    expect(JSON.parse(encodeRead(1, 10, window, false)).expect).toEqual(window);
  });
});

describe("createEvalHelper", () => {
  it("answers `ready` with the protocol number the helper announced", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    const waiting = helper.waitReady();
    link.emit(JSON.stringify({event: "ready", protocol: 2}));
    expect(await waiting).toEqual({ok: true, body: {protocol: 2}});
  });

  it("settles every outstanding call when the helper goes away", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    const permission = helper.permission();
    const front = helper.frontWindow();
    link.exit();
    expect(await permission).toEqual({ok: false, why: "down"});
    expect(await front).toEqual({ok: false, why: "down"});
  });

  it("gives up on a call that is never answered", async () => {
    const link = createFakeLink();
    const timers = createManualSchedule();
    const helper = createEvalHelper({link, schedule: timers.schedule});
    const waiting = helper.permission();
    timers.fireAll();
    expect(await waiting).toEqual({ok: false, why: "timeout"});
  });

  it("ignores a focus event and an answer to a call it never made", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    respondTo(link, () => null);
    const waiting = helper.frontWindow();
    link.emit(JSON.stringify({event: "focus"}));
    link.emit(JSON.stringify({id: 99, window: null}));
    link.emit(JSON.stringify({id: 1, window}));
    expect(await waiting).toEqual({ok: true, body: {window}});
  });

  it("keeps `stats` and `lines`, which the product's own parser strips", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    respondTo(link, (request) => request.op === "read"
      ? {ok: true, window, text: "x", stats: {captureMs: 31, bandPx: 82}, lines: [{text: "x", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}]}
      : null);
    const answer = await helper.readApproved(approval, {lines: true});
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.body.stats).toEqual({captureMs: 31, bandPx: 82});
    expect(answer.body.lines).toHaveLength(1);
  });

  it("sends shutdown and closes the helper's input rather than killing it", () => {
    const link = createFakeLink();
    createEvalHelper({link, schedule: createManualSchedule().schedule}).shutdown();
    expect(JSON.parse(link.sent[0] as string)).toEqual({op: "shutdown"});
    expect(link.inputClosed).toBe(true);
    expect(link.killed).toBe(false);
  });
});

/**
 * A clock the test moves by hand, so `readyMs` is an assertion about WHICH two moments were
 * subtracted rather than about how fast the machine running the test happens to be.
 */
function fakeClock(start: number): {now: () => number; advance: (ms: number) => void} {
  let value = start;
  return {now: () => value, advance: (ms) => { value += ms; }};
}

/** A helper that says `ready` after the clock has moved on by `warmUpMs`. */
function helperReadyAfter(clock: {advance: (ms: number) => void}, warmUpMs: number): EvalHelper {
  return {
    waitReady: async () => { clock.advance(warmUpMs); return {ok: true, body: {protocol: 2}}; },
    permission: async () => ({ok: true, body: {permission: "granted"}}),
    frontWindow: async () => ({ok: false, why: "down"}),
    readApproved: async () => ({ok: false, why: "down"}),
    shutdown: () => undefined
  };
}

describe("how long the helper took to start", () => {
  /**
   * The measurement the plan asks for: milliseconds from the SPAWN to `ready`. The three moments are
   * deliberately far apart in this test — the process already alive at 1 000, spawned at 1 000,
   * spawning costing 5, the warm-up 295 — so that timing it from this process's own start (1 300) or
   * from the moment `waitReady` was called (295) gives a different number from the right one (300).
   *
   * The spawn and the wait are two functions, not one, so that the caller can hold the helper before
   * it awaits anything (`main.ts` puts the wait inside the `try` whose `finally` shuts the helper
   * down). `spawnHelper` reads the clock before it starts anything; `waitReadyFrom` subtracts.
   */
  it("is measured from the spawn, not from the process start and not from `ready`", async () => {
    const clock = fakeClock(1_000);
    const started = spawnHelper({
      now: clock.now,
      start: () => { clock.advance(5); return helperReadyAfter(clock, 295); }
    });
    expect(started.spawnedAt).toBe(1_000);
    const {ready, readyMs} = await waitReadyFrom(started, clock.now);
    expect(readyMs).toBe(300);
    expect(ready).toEqual({ok: true, body: {protocol: 2}});
  });

  it("is never negative, and is zero for a helper that was ready at once", async () => {
    const clock = fakeClock(0);
    const started = spawnHelper({now: clock.now, start: () => helperReadyAfter(clock, 0)});
    const {readyMs} = await waitReadyFrom(started, clock.now);
    expect(readyMs).toBe(0);
    expect(readyMs).toBeGreaterThanOrEqual(0);
  });

  /** A helper that never said `ready` still took a measurable amount of time not to say it. */
  it("still reports the interval when the helper never became ready", async () => {
    const clock = fakeClock(500);
    const started = spawnHelper({
      now: clock.now,
      start: () => ({
        ...helperReadyAfter(clock, 0),
        waitReady: async () => { clock.advance(90_000); return {ok: false, why: "timeout"}; }
      })
    });
    const {ready, readyMs} = await waitReadyFrom(started, clock.now);
    expect(readyMs).toBe(90_000);
    expect(ready).toEqual({ok: false, why: "timeout"});
  });

  it("hands back the helper it started, not a new one", () => {
    const clock = fakeClock(0);
    const helper = helperReadyAfter(clock, 1);
    expect(spawnHelper({now: clock.now, start: () => helper}).helper).toBe(helper);
  });

  /**
   * The shape this split exists for: the helper is in hand BEFORE anything is awaited, so the wait
   * happens inside the caller's `try` and a helper that never becomes ready is still shut down.
   * Driven over the real `createEvalHelper` and a fake link, so what is asserted is the line the
   * helper's process would actually have received.
   */
  it("lets the caller shut down a helper that never became ready", async () => {
    const link = createFakeLink();
    const timers = createManualSchedule();
    const clock = fakeClock(0);
    const started = spawnHelper({now: clock.now, start: () => createEvalHelper({link, schedule: timers.schedule})});
    try {
      const waiting = waitReadyFrom(started, clock.now);
      clock.advance(120_000);
      timers.fireAll();                                  // the ready deadline expires; nothing said `ready`
      expect(await waiting).toEqual({ready: {ok: false, why: "timeout"}, readyMs: 120_000});
      expect(link.sent).toEqual([]);                     // and it asked the helper nothing at all
    } finally {
      started.helper.shutdown();
    }
    expect(JSON.parse(link.sent[0] as string)).toEqual({op: "shutdown"});
    expect(link.inputClosed).toBe(true);
    expect(link.killed).toBe(false);                     // shutdown and close input, never kill
  });
});

/**
 * `main.ts` runs inside a granted bundle with no window and cannot be imported, let alone driven, by
 * any test — so the one property of its shape that a refactor has already broken once is read off
 * its source instead. The helper is spawned, then the wait happens INSIDE the `try` whose `finally`
 * shuts it down; folding the two into one `await` before the `try` left a spawned process with
 * nobody holding it.
 */
describe("the entry point's helper lifecycle", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    expect(index, `main.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it("waits for `ready` inside the try whose finally shuts the helper down", () => {
    const shutdown = at("helper.shutdown()");
    // The `try` that shuts the helper down is the last one opened before it, not the first in the
    // file (`removeScratch` has one of its own).
    const opened = source.lastIndexOf("try {", shutdown);
    const closed = source.lastIndexOf("} finally {", shutdown);
    expect(opened, "main.ts no longer wraps the run in a try").toBeGreaterThan(-1);
    expect(at("spawnHelper(")).toBeLessThan(opened);
    expect(opened).toBeLessThan(at("await waitReadyFrom("));
    expect(at("await waitReadyFrom(")).toBeLessThan(closed);
    expect(closed).toBeLessThan(shutdown);
  });

  /**
   * And the clock it hands them is monotonic. `Date.now()` can step backwards mid-measurement, and a
   * cold helper start is 43-90 s — long enough for one to land inside it.
   *
   * **One use of the wall clock is allowed, and it is named here.** A file's mtime is a wall-clock
   * stamp, so the reveal channel's liveness check — how old the terminal's heartbeat file is — has
   * no monotonic equivalent and cannot have one. It is admitted because nothing it decides is a
   * measurement: it decides whether a debug file exists, never a duration, a timeout or a verdict,
   * and `heartbeatFresh` treats a stepped clock's negative age as fresh. The count is pinned at
   * exactly one, so a second wall-clock reading anywhere in this entry point fails here.
   */
  it("times the helper on a monotonic clock, not on the wall clock", () => {
    expect(source).toContain("node:perf_hooks");
    expect(source).toContain("performance.now()");
    expect(source.split("Date.now()")).toHaveLength(2);           // exactly one occurrence
    expect(source).toContain("return Date.now() - statSync(alivePath).mtimeMs;");
    // and no duration this harness REPORTS comes off it: the helper's own figures are monotonic
    expect(source).toContain("const now = (): number => Math.round(performance.now());");
  });

  /**
   * And it hands the elapsed time to the refusals raised after the helper was spawned. `coldstart`
   * exists to answer "how long does a cold helper take"; a helper still not ready after the 120 s
   * deadline is that answer, and the run used to write a bare code and discard it. `serialiseError`
   * admitting the number is pinned in `results.test.ts`; this is the caller's half.
   */
  it("hands the elapsed helper time to the refusals raised after the spawn", () => {
    expect(source).toContain('serialiseError({error: "PROTOCOL", code: "PROTOCOL", readyMs})');
    expect(source).toContain('serialiseError({error: "NO_GRANT", code: "NO_GRANT", readyMs})');
    // and not to the ones raised before a helper exists, which have no such number
    expect(source).toContain('serialiseError({error: "HARNESS", code: configured.code})');
  });
});

describe("the permission answer", () => {
  it.each(["granted", "denied", "refused"])("takes the helper's own word %s", async (permission) => {
    expect(permissionOf({ok: true, body: {permission}})).toBe(permission);
  });

  /**
   * The answer body is another process's JSON and this value goes into the results file, so anything
   * that is not one of the helper's three words becomes the harness's own fourth. Nothing the helper
   * said can reach the file under this name.
   */
  it.each([
    ["a word the helper does not have", {permission: "maybe"}],
    ["a window title", {permission: "Inbox (14) - mail.corp"}],
    ["a number", {permission: 1}],
    ["nothing at all", {}]
  ])("calls %s unknown", (_label, body) => {
    expect(permissionOf({ok: true, body: body as Record<string, unknown>})).toBe("unknown");
  });

  it("calls a helper that never answered unknown", () => {
    expect(permissionOf({ok: false, why: "timeout"})).toBe("unknown");
    expect(permissionOf({ok: false, why: "down"})).toBe("unknown");
  });
});

describe("readWindow", () => {
  it("reads a window with and without a bundle id", () => {
    expect(readWindow({window})).toEqual(window);
    expect(readWindow({window: {app: "Terminal", title: staged}})).toEqual({app: "Terminal", title: staged});
  });

  it.each([
    ["nothing", {}],
    ["null", {window: null}],
    ["a string", {window: "Google Chrome"}],
    ["a window with no title", {window: {app: "Google Chrome"}}],
    ["a window whose app is a number", {window: {app: 7, title: "x"}}]
  ])("refuses %s", (_label, body) => {
    expect(readWindow(body as Record<string, unknown>)).toBeNull();
  });
});
/**
 * The same source-shape approach, for the wiring that decides WHICH display a run is judged against.
 *
 * `main.ts` cannot be imported by a test, and this is a property a refactor can quietly break: the
 * work area and the scale factor must come from the display nearest the staging position — not from
 * the primary one, which refused the Retina run outright (review B, Important 2) — and the refusal
 * must happen before anything is opened.
 */
describe("the entry point's display wiring", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    expect(index, `main.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it("asks for the display nearest the staging position", () => {
    at("screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt})");
    expect(source).not.toContain("getPrimaryDisplay");
  });

  it("takes the work area and the scale factor from that one display", () => {
    const display = at("screen.getDisplayNearestPoint");
    for (const needle of ["display.workArea.x", "display.workArea.width", "display.scaleFactor"]) {
      expect(at(needle)).toBeGreaterThan(display);
    }
  });

  it("refuses before a page is served and before a helper exists", () => {
    const refusal = at("displayRefusal(workArea, position");
    expect(refusal).toBeLessThan(at("createPageServer("));
    expect(refusal).toBeLessThan(at("spawnHelper("));
    // and the refusal is written as a fixed code, never a message
    expect(at("serialiseError({error: \"HARNESS\", code: refusal})")).toBeGreaterThan(refusal);
  });

  /**
   * The version the entry point stamps on a file. The type demands 2, so a wrong number is a
   * compile error — this is the half that fails in a test run as well (review C, Minor 5).
   */
  it("stamps the current schema version on what it writes", () => {
    expect(source).toContain("schema: 6,");
    expect(source).not.toContain("schema: 5,");
  });

  it("hands the scale to the run, so a row can say which display it was staged on", () => {
    expect(at("displayScale,")).toBeGreaterThan(at("const displayScale"));
    expect(at("await runMode(")).toBeLessThan(at("displayScale,"));
  });
});
/**
 * The wiring a revert could remove with nothing failing, because `RunDeps.pageStats` is optional and
 * `main.ts` cannot be imported by a test (review D, Important 4 and Important 1).
 */
describe("the entry point's diagnostics wiring", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("hands the page server's counters to the run", () => {
    expect(source).toContain("pageStats: staging.server.served");
  });

  it("seeds those counters with this run's own staged titles and nothing else", () => {
    expect(source).toContain("allStagedIds()");
    expect(source).toContain("createPageServer(truth, titles)");
  });

  it("records whether the page server got both loopback families", () => {
    expect(source).toContain("pageServerIpv6: staging === null ? null : staging.server.ipv6");
  });

  /**
   * The staged title is minted by `observeUrlsFile` now rather than inline here, so the claim is in
   * two halves: the entry point calls that builder, and the builder is the one that mints the title
   * (which `observe.test.ts` asserts against the real table, URL by URL).
   */
  it("titles every staged window with the case's short id, through the tested builder", () => {
    expect(source).toContain("observeUrlsFile({port, nonce, host, expect})");
    const builder = readFileSync(new URL("./observe.ts", import.meta.url), "utf8");
    expect(builder).toContain("stagedTitleOf(theCase.name, nonce)");
  });

  /**
   * The observe fixes of 2026-09-21, on the lines of `main.ts` that a revert could remove with
   * nothing failing — every one of these is an OPTIONAL field of `ObserveDeps` or an argument with a
   * default, so the run would go on working and would simply stop doing the thing it was fixed for.
   */
  it("names this run's nonce in both observe file names, and never a fixed name", () => {
    expect(source).toContain("observeUrlsName(nonce)");
    expect(source).toContain("observeProgressName(nonce)");
    expect(source).not.toContain("observe-urls.json");
  });

  it("hands the expected cases to the run, so it can end as soon as it has them", () => {
    expect(source).toContain("expect: observeExpect === null ? null : observeExpect.cases");
  });

  it("hands the asked-for host to the run, so the strip is searched for what the URLs printed", () => {
    expect(source).toContain("observeHost: host");
  });

  it("gives the run somewhere to report each finished case while the owner waits", () => {
    expect(source).toContain("writeProgress: observesWindows(mode)");
    expect(source).toContain("observeProgressWriter(nonce, expect,");
    // written the way every other file here is: through the allow-list, and atomically
    expect(source).toContain("serialiseObserveProgress(");
    expect(source).toContain("writeAtomic(path, serialiseObserveProgress(");
  });

  /**
   * The one line that decides whether a file of recognised text exists at all (review, Important 2).
   *
   * `main.ts` cannot be imported by a test, and `ObserveDeps.writeReveal` is optional — the
   * reviewer's probe mutated this line to pass the writer on EVERY observing run and left all 1173
   * tests green. `runObserve`'s own `reveal === true` check is the other half of the lock and is
   * exercised behaviourally in `run.test.ts`; this is the half only a source pin can hold.
   */
  it("hands the reveal writer to the run only when the validated setting says so", () => {
    expect(source).toContain("const revealGate: RevealGate | null = reveal ? revealGateFor(nonce) : null;");
    expect(source).toContain("writeReveal: reveal ? (rows) => { revealGate?.reveal(rows); } : undefined");
    // and the setting travels with it, because the run demands BOTH
    expect(source.indexOf("        reveal,")).toBeLessThan(source.indexOf("writeReveal: reveal ?"));
  });

  /**
   * And the liveness half: the gate is asked again however the run ended, so a run whose terminal
   * died does not leave its strips on disk (review, Important 1c).
   */
  it("closes the reveal gate on every way out of the run", () => {
    expect(source).toContain("revealGate?.end();");
    expect(source.indexOf("revealGate?.end();")).toBeLessThan(source.indexOf("helper.shutdown();"));
    // the decisions themselves are in the tested factory, not here
    expect(source).toContain("createRevealGate(nonce, {");
    expect(source).toContain("observeAliveName(nonce)");
    // written through the production writer, which chooses the mode itself — so the mode cannot be
    // dropped from this call site (re-review, Minor B). `writeRevealFile` is tested against a real
    // folder in `observe.test.ts`, where the mode is read off the file it wrote.
    expect(source).toContain("writeRevealFile(path, contents, {writeFile: writeFileSync, rename: renameSync})");
    expect(source).not.toContain("REVEAL_FILE_MODE");
    // and every name this run's strips can be under goes when the gate removes them, the terminal's
    // `.claimed` included (re-review, Minor A)
    expect(source).toContain("for (const name of revealFileNames(nonce))");
  });

  /**
   * The folder the one file that can carry screen text lives in, on the bundle's side (the
   * terminal's is pinned in `reader-eval.test.ts`). `mkdirSync`'s mode applies when the folder is
   * CREATED, so this is best-effort on a machine whose folder already exists — which is why it is a
   * source pin and not an assertion about any particular directory.
   */
  it("creates the out folder for the owner alone", () => {
    expect(source).toContain("mkdirSync(outDir, {recursive: true, mode: 0o700})");
  });

  /** Without this argument the verdict is EXPLORATORY and the run cannot be accepted (finding O1). */
  it("hands the expectation to the summary, which is what an observe run is judged against", () => {
    expect(source).toContain("limited, observeExpect, exploratoryOf(notSecure))");
    expect(source).toContain("expectationOf(expect)");
  });

  /**
   * The page server's refusal is caught where it is thrown, so the file carries its own fixed code
   * rather than the catch-all's `HARNESS` (re-review D, Important 1). It is the one failure that
   * means another local process may be receiving the staged URLs.
   */
  it("writes the page server's own refusal code, from the imported constant", () => {
    expect(source).toContain("PAGE_SERVER_REFUSAL");
    expect(source).toContain("serialiseError({error: \"HARNESS\", code: PAGE_SERVER_REFUSAL})");
    // caught at the call, not left to the catch-all at the bottom
    const call = source.indexOf("createPageServer(truth, titles)");
    const caught = source.indexOf("code: PAGE_SERVER_REFUSAL");
    expect(call).toBeGreaterThan(-1);
    expect(caught).toBeGreaterThan(call);
    expect(source.lastIndexOf("try {", call)).toBeGreaterThan(-1);
  });
});
