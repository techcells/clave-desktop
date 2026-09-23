import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {BarrenCounts} from "./capture/loop";
import {ACTIVE_POLL_MS, BARREN_AFTER_MS, READER_FAILURE_LIMIT} from "./constants";
import {nothingReadWhy, type Engine, type EngineStatus} from "./engine";
import {LOG_COUNT_KEYS} from "./log";
import {selfTestKey} from "./model/selfTest";
import {createHarness, type Harness} from "./testing/harness";

/**
 * The engine hands `onNothingRead` to the loop and the loop is its only caller, so the only way to
 * test what the engine does with a call the loop would never make is to be that caller. The module
 * is wrapped, not replaced: every other test in this file drives the real loop exactly as before,
 * and all this keeps is the deps object the engine built it with.
 */
const built = vi.hoisted(() => ({deps: undefined as {onNothingRead: (counts: BarrenCounts, since: number) => void} | undefined}));
vi.mock("./capture/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture/loop")>();
  return {
    ...actual,
    createCaptureLoop: (deps: Parameters<typeof actual.createCaptureLoop>[0]) => { built.deps = deps; return actual.createCaptureLoop(deps); }
  };
});

interface LogLine { at: number; code: string; counts: Record<string, unknown> }
const logLines = (h: Harness): LogLine[] =>
  (h.fs.text("/data/app.log") ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine);
const lineFor = (h: Harness, code: string): LogLine | undefined => logLines(h).find((l) => l.code === code);

/** Signed in, model verified, permission granted: everything capture needs, and nothing it does not. */
async function ready(h: Harness): Promise<Engine> {
  const engine = await h.launch();
  await engine.signIn("sardor", "correct");
  h.client.script.push({activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true},
    {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]});
  expect(await engine.selfTest()).toEqual({ok: true, timeScale: 1});
  expect(selfTestKey("1.0.0", "sha")).toBe(engine.settings().selfTestPassedFor);
  return engine;
}

/** Long enough for BOTH conditions: 120 polls of the 5 s loop is exactly the ten minutes. */
const TEN_MINUTES_OF_POLLS = BARREN_AFTER_MS / ACTIVE_POLL_MS;

describe("engine: reading is on and nothing is coming through it", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("says so in the status, emits it, logs it once, and does not switch anything off", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const seen: EngineStatus[] = [];
    engine.onStatus((s) => seen.push(s));
    h.reader.front = null;                                      // nothing identifiable in front, ever
    const onAt = Date.now();
    await engine.setCapture(true);
    expect(engine.status().nothingRead).toBeNull();

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * (TEN_MINUTES_OF_POLLS - 1));
    expect(engine.status().nothingRead).toBeNull();             // one poll short of the ten minutes
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);

    expect(engine.status().nothingRead).toEqual({since: onAt, why: "noWindow"});
    expect(seen.some((s) => s.nothingRead !== null)).toBe(true);
    // Nothing is broken, so nothing is blocked and nothing is switched off: the ONLY change is that
    // the app has stopped claiming to be reading.
    expect(engine.status().capture).toBe("on");
    expect(engine.status().blockers).toEqual([]);
    expect(logLines(h).filter((l) => l.code === "READER_NOTHING_TO_READ")).toHaveLength(1);

    // And it stays at one, however long the same streak runs.
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);
    expect(logLines(h).filter((l) => l.code === "READER_NOTHING_TO_READ")).toHaveLength(1);
    expect(engine.status().nothingRead).toEqual({since: onAt, why: "noWindow"});
    await engine.quit();
  });

  it("writes the streak's tally under fixed count keys, as numbers, and never a name off a screen", async () => {
    const h = createHarness();
    const engine = await ready(h);
    // An excluded app with a title that would be a disaster to log. The core denies every cycle.
    h.reader.front = {app: "1Password", title: "Priya Raman — recovery codes"};
    h.reader.text = "the recovery codes themselves";
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);

    const line = lineFor(h, "READER_NOTHING_TO_READ");
    expect(line).toBeDefined();
    expect(line!.counts).toEqual({denied: TEN_MINUTES_OF_POLLS + 1});
    // Numeric values only, under keys from the closed set — asserted rather than assumed, because
    // this is the one log line whose contents are derived from what was on the user's screen.
    for (const [key, value] of Object.entries(line!.counts)) {
      expect(LOG_COUNT_KEYS as readonly string[]).toContain(key);
      expect(typeof value).toBe("number");
    }
    const written = h.fs.text("/data/app.log") as string;
    for (const secret of ["Priya", "Raman", "recovery", "1Password"]) expect(written).not.toContain(secret);
    expect(engine.status().nothingRead).toEqual({since: expect.any(Number), why: "notAllowed"});
    await engine.quit();
  });

  it("clears it, and says so, as soon as a window is read again", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);
    expect(engine.status().nothingRead).not.toBeNull();

    const seen: EngineStatus[] = [];
    engine.onStatus((s) => seen.push(s));
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "the query plan showed a sequential scan over the orders table";
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(engine.status().nothingRead).toBeNull();
    expect(seen.some((s) => s.nothingRead === null)).toBe(true);
    await engine.quit();
  });

  it("clears it whenever the loop stops, so capture off never sits under the notice", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);
    expect(engine.status().nothingRead).not.toBeNull();

    await engine.setCapture(false);
    expect(engine.status()).toMatchObject({capture: "off", nothingRead: null});
    await engine.quit();
  });

  /**
   * The one report that must go nowhere. The loop cannot make it today — it retracts on its way out
   * of `stop()`, and every barren return is behind a generation check — but if it ever did, the
   * notice would be raised AFTER the retraction and nothing would be left to clear it: the tray
   * would sit there saying "reading is on, and nothing is coming through" with capture off.
   */
  it("ignores a nothing-read report that arrives while the loop is not running", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);
    expect(engine.status().nothingRead).not.toBeNull();
    await engine.setCapture(false);
    expect(engine.status().nothingRead).toBeNull();

    const before = logLines(h).length;
    built.deps!.onNothingRead({noWindow: 24}, Date.now() - BARREN_AFTER_MS);
    await vi.advanceTimersByTimeAsync(0);                   // let anything it started reach the disk
    expect(engine.status()).toMatchObject({capture: "off", nothingRead: null});
    expect(logLines(h)).toHaveLength(before);               // and nothing written about it either
    await engine.quit();
  });

  /**
   * A screen with almost nothing on it — a video player, an image, a near-blank terminal — is read
   * perfectly well and yields no words. Nothing is excluded and nothing is wrong, so the user must
   * not be sent to Settings to look for a rule that is not there: `empty` is its own outcome, and
   * it falls in the group that names nothing to fix.
   */
  it("calls a run of near-blank screens what it is, and never an exclusion", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = {app: "QuickTime Player", title: "standup.mov"};
    h.reader.text = "00:14 / 41:07";                             // under MIN_READ_CHARS: read, and empty
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * TEN_MINUTES_OF_POLLS);

    expect(engine.status().nothingRead).toMatchObject({why: "other"});
    const line = lineFor(h, "READER_NOTHING_TO_READ");
    expect(line!.counts).toEqual({empty: TEN_MINUTES_OF_POLLS + 1});
    expect(LOG_COUNT_KEYS as readonly string[]).toContain("empty");
    await engine.quit();
  });

  it("carries that run's totals out on CAPTURE_OFF, which is what stats() is for", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "the query plan showed a sequential scan over the orders table";
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3);     // four cycles: one kept, then unchanged
    h.reader.front = null;
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);     // two with nothing in front
    await engine.setCapture(false);

    const line = lineFor(h, "CAPTURE_OFF");
    expect(line).toBeDefined();
    expect(line!.counts).toEqual({blockers: 0, kept: 1, unchanged: 3, noWindow: 2});
    for (const key of Object.keys(line!.counts)) expect(LOG_COUNT_KEYS as readonly string[]).toContain(key);
    await engine.quit();
  });

  /**
   * The line the whole change exists for. A run whose reader keeps failing has to leave behind not
   * just how many times, but at which step — because "READER_PROBLEM, failed: 5" was exactly what
   * the real run left, and it could not be acted on.
   *
   * Five failures inside the window also switch reading off by themselves, so this drives the real
   * thing end to end: the engine raises `READER_PROBLEM`, stops the loop, and writes the tallies out
   * — and the fifth failure, the one that caused all of it, is in them.
   */
  it("carries the failure stages out on CAPTURE_OFF, as numbers under the closed count keys", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.read = async () => ({ok: false, reason: "failed", detail: "captureRefused"});
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * READER_FAILURE_LIMIT);
    expect(engine.status().blockers).toContain("READER_PROBLEM");

    const line = lineFor(h, "CAPTURE_OFF");
    expect(line).toBeDefined();
    // Tallied before the problem was raised, so the count matches the limit that raised it: this is
    // the off-by-one that used to write `failed: 4` beside a notice caused by five.
    expect(line!.counts.failed).toBe(READER_FAILURE_LIMIT);
    expect(line!.counts.failedCaptureRefused).toBe(READER_FAILURE_LIMIT);
    for (const [key, value] of Object.entries(line!.counts)) {
      expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
      expect(typeof value, key).toBe("number");
    }
    await engine.quit();
  });

  /**
   * Each line is that run and no other. Anyone reading `app.log` takes a CAPTURE_OFF line as "what
   * that run did" — so lifetime totals would make the second line silently include the first run's
   * cycles, and every later line a sum of runs already written out.
   */
  it("counts each run on its own: a second CAPTURE_OFF line carries only the second run", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);      // three cycles with nothing in front
    await engine.setCapture(false);

    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);          // two more
    await engine.setCapture(false);

    const off = logLines(h).filter((l) => l.code === "CAPTURE_OFF");
    expect(off.map((l) => l.counts)).toEqual([{blockers: 0, noWindow: 3}, {blockers: 0, noWindow: 2}]);
    await engine.quit();
  });

  /**
   * The commonest way a run ends is not the switch: it is tray → Quit. A line written only by
   * `evaluate` would leave every such session — which is most of them, and every development
   * session — with no tally at all, and the whole point of counting per run is that C-2b-2 reads
   * these lines per run.
   */
  it("carries the run's totals out when the app quits, which is how most runs end", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "the query plan showed a sequential scan over the orders table";
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3);     // four cycles: one kept, then unchanged
    h.reader.front = null;
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);     // two with nothing in front

    await engine.quit();
    const off = logLines(h).filter((l) => l.code === "CAPTURE_OFF");
    expect(off).toHaveLength(1);
    expect(off[0]!.counts).toEqual({blockers: 0, kept: 1, unchanged: 3, noWindow: 2});
    for (const key of Object.keys(off[0]!.counts)) expect(LOG_COUNT_KEYS as readonly string[]).toContain(key);
  });

  /** A different account signing in ends the run under the previous one, tallies and all. */
  it("carries them out when a different account signs in under a running loop", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);      // three cycles with nothing in front

    expect(await engine.signIn("bea", "correct")).toMatchObject({ok: true});
    const off = logLines(h).filter((l) => l.code === "CAPTURE_OFF");
    expect(off).toHaveLength(1);
    expect(off[0]!.counts).toMatchObject({noWindow: 3});
    for (const key of Object.keys(off[0]!.counts)) expect(LOG_COUNT_KEYS as readonly string[]).toContain(key);
    await engine.quit();
  });

  /**
   * The order is the whole finding: the tally is written BEFORE the files go, so it is deleted with
   * them. A line written after the deletion would re-create `app.log` with a record of a run whose
   * data the user has just asked to be erased.
   */
  it("carries them out before deleting all data, and writes nothing to the log afterwards", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);      // three cycles with nothing in front

    const atRemoval: string[] = [];
    const remove = h.fs.remove;
    h.fs.remove = async (path) => { if (path === "/data/app.log") atRemoval.push(h.fs.text(path) ?? ""); await remove(path); };
    await engine.deleteAllData({removeModel: false});
    h.fs.remove = remove;

    const written = (atRemoval[0] ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine);
    const off = written.filter((l) => l.code === "CAPTURE_OFF");
    expect(off).toHaveLength(1);
    // `blockers: 0` is what makes this test tell the two orders apart, and is worth asserting in its
    // own right: the tallies must be stamped with the state the RUN ran in. Written any later, the
    // line comes from the unawaited `background(evaluate())` that `session.signOut()` sets off, and
    // that one counts `SIGNED_OUT` — a line about a run that ended before anybody signed out.
    expect(off[0]!.counts).toEqual({blockers: 0, noWindow: 3});
    // It went in before DATA_DELETED, and nothing about that run survives the deletion.
    expect(written.findIndex((l) => l.code === "CAPTURE_OFF")).toBeLessThan(written.findIndex((l) => l.code === "DATA_DELETED"));
    expect(logLines(h).filter((l) => l.code === "CAPTURE_OFF")).toHaveLength(0);
    await engine.quit();
  });

  /** One line per run and no more: a loop that is not running has no run to write out. */
  it("says nothing when the loop was not running, and never writes two lines for one run", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.reader.front = null;
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2);
    await engine.setCapture(false);                            // the run ends here, with its one line
    expect(logLines(h).filter((l) => l.code === "CAPTURE_OFF")).toHaveLength(1);

    await engine.deleteAllData({removeModel: false});          // nothing running: nothing to write out
    await engine.quit();
    expect(logLines(h).filter((l) => l.code === "CAPTURE_OFF")).toHaveLength(0);   // the log went with the data
  });
});

describe("engine: which of the three reasons a barren streak is given", () => {
  it("names the group most of the streak fell into, and ties go to the one the user can act on", () => {
    expect(nothingReadWhy({denied: 10, noWindow: 3})).toBe("notAllowed");
    expect(nothingReadWhy({notKept: 30})).toBe("notAllowed");
    expect(nothingReadWhy({denied: 5, notKept: 5, black: 9})).toBe("notAllowed");
    expect(nothingReadWhy({noWindow: 12, denied: 4})).toBe("noWindow");
    expect(nothingReadWhy({windowGone: 8, locked: 8, notKept: 15})).toBe("noWindow");
    expect(nothingReadWhy({locked: 24})).toBe("noWindow");
    expect(nothingReadWhy({windowChanged: 20, denied: 2})).toBe("other");
    expect(nothingReadWhy({black: 24})).toBe("other");
    // Nothing on the screen to read is not a rule the user wrote: it belongs nowhere near Settings.
    expect(nothingReadWhy({empty: 24})).toBe("other");
    expect(nothingReadWhy({empty: 20, denied: 4})).toBe("other");
    // A dead heat between the two named groups: Settings is where the user can actually do something.
    expect(nothingReadWhy({denied: 12, noWindow: 12})).toBe("notAllowed");
  });
});
