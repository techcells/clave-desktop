import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers, type FakeHelpers} from "../testing/fakeReaderHelper";
import {
  HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT, HELPER_HEALTHY_AFTER_MS, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS,
  HELPER_START_DEADLINE_MS
} from "./constants";
import {createReaderClient, ReaderDown, type ReaderClient, type ReaderClientEvent} from "./readerClient";

const WINDOW = {app: "Code", title: "query.sql"};

describe("reader client: supervision", () => {
  let helpers: FakeHelpers;
  let events: ReaderClientEvent[];
  let client: ReaderClient;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  async function ready(): Promise<void> {
    void client.permission();
    helpers.latest().ready();
    await settle();
  }

  /** One complete good read on the current helper. */
  async function goodRead(): Promise<void> {
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "text"});
    await read;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    helpers = createFakeHelpers();
    events = [];
    client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (e) => events.push(e)});
  });
  afterEach(() => { vi.useRealTimers(); });

  it("restarts after an exit with a doubling backoff, and a long healthy run resets it", async () => {
    await ready();
    helpers.latest().exit();
    expect(client.state()).toBe("waiting");
    await vi.advanceTimersByTimeAsync(499);
    expect(helpers.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all).toHaveLength(2);                         // 0.5 s

    helpers.latest().exit();
    await vi.advanceTimersByTimeAsync(999);
    expect(helpers.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all).toHaveLength(3);                         // 1 s

    helpers.latest().ready();
    await vi.advanceTimersByTimeAsync(HELPER_HEALTHY_AFTER_MS);
    helpers.latest().exit();
    await vi.advanceTimersByTimeAsync(500);
    expect(helpers.all).toHaveLength(4);                         // back to 0.5 s
  });

  it("while waiting to restart there is no helper at all: the front-window call rejects", async () => {
    await ready();
    helpers.latest().exit();
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    expect(await client.permission()).toBe("unknown");
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed", detail: "helperDown"});
    expect(helpers.all).toHaveLength(1);                         // a call does not jump the backoff
  });

  it("never waits longer than the maximum backoff", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    expect(helpers.all).toHaveLength(HELPER_EXIT_LIMIT);
  });

  it("gives up after five unplanned exits in ten minutes, says so once, and stays down", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    expect(client.state()).toBe("gaveUp");
    expect(events.filter((e) => e === "HELPER_GAVE_UP")).toHaveLength(1);
    const started = helpers.all.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    expect(helpers.all).toHaveLength(started);
  });

  it("a new focus subscription after giving up is the user's try-again", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    const started = helpers.all.length;
    client.onFocusChange(() => undefined);
    expect(helpers.all).toHaveLength(started + 1);
    expect(client.state()).toBe("starting");
  });

  it("a helper that cannot even be started counts as an exit and is retried", async () => {
    helpers.failNextSpawn = true;
    expect(await client.permission()).toBe("unknown");
    expect(events).toEqual(["HELPER_EXIT"]);
    expect(client.state()).toBe("waiting");
    await vi.advanceTimersByTimeAsync(500);
    expect(helpers.all).toHaveLength(1);
  });

  it("allows a cold start of a minute and a half, then treats silence as a crash", async () => {
    void client.permission();
    await vi.advanceTimersByTimeAsync(HELPER_START_DEADLINE_MS - 1);
    expect(client.state()).toBe("starting");
    expect(await client.frontWindow()).toBeNull();               // still "no window", never a failure
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all[0]?.killed).toBe(true);
    expect(events).toEqual(["HELPER_START_TIMEOUT", "HELPER_EXIT"]);
  });

  // Protocol 1 is the one that matters now: a helper left over from before `read` carried the
  // approved window would capture and recognise whatever is in front, and there is no other way to
  // tell it apart from a helper that keeps the rule.
  it("never uses a helper that speaks another protocol, and does not restart it in a loop", async () => {
    void client.permission();
    helpers.latest().ready(1);
    await settle();
    expect(helpers.latest().killed).toBe(true);
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("gaveUp");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(helpers.all).toHaveLength(1);
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
  });

  /**
   * A give-up after five crashes is about a machine that may well recover, so switching capture off
   * and on again revives it (D5, tested above). A mismatch is about the binary on disk, and the only
   * binary this client can spawn is the same one: reviving would buy a process start and a Vision
   * warm-up for every subscription, and one more `HELPER_PROTOCOL_MISMATCH` each time, to be told
   * again what is already known.
   */
  it("a mismatch is permanent: switching capture off and on again does not start the same binary again", async () => {
    void client.permission();
    helpers.latest().ready(1);
    await settle();
    expect(client.state()).toBe("gaveUp");

    client.onFocusChange(() => undefined)();       // capture off again
    client.onFocusChange(() => undefined);         // and on
    expect(helpers.all).toHaveLength(1);
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("gaveUp");

    expect(await client.permission()).toBe("unknown");
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed", detail: "helperDown"});
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(helpers.all).toHaveLength(1);
  });

  /**
   * The helper that announces the wrong number is not always the first one. A planned replacement
   * announces its protocol too, and when it is the one that mismatches, `current` is still serving:
   * `state()` stays "ready", so nothing about the client looks broken. `maybePlanReplacement()` runs
   * on EVERY call (the engine asks for the permission every ten seconds), and the mismatch branch
   * retires the helper before `gone()`, which skips `postponeReplacement()` — so the planned restart
   * stays due and each call would start, and SIGKILL, another copy of the same binary for ever.
   */
  it("a mismatch announced by a planned replacement is permanent too: no later call starts another", async () => {
    await ready();
    await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
    void client.permission();                                    // this call plans the replacement
    expect(helpers.all).toHaveLength(2);
    helpers.latest().ready(1);                                   // which speaks a protocol we do not
    await settle();
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("ready");                        // the good helper carries on serving

    const started = helpers.all.length;
    for (let i = 0; i < 5; i++) {
      void client.permission();
      if (helpers.all.length > started) helpers.latest().ready(1);
      await settle();
    }
    expect(helpers.all).toHaveLength(started);                   // D14(d): a mismatch is permanent
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);        // said once, not once per call
  });

  describe("the planned restart", () => {
    it("after enough reads, warms a replacement up while the old helper keeps serving, then swaps between calls", async () => {
      await ready();
      const old = helpers.latest();
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) await goodRead();
      expect(helpers.all).toHaveLength(1);

      const during = client.read({budgetMs: 1500, expect: WINDOW});                // this call notices that it is time
      expect(helpers.all).toHaveLength(2);
      const next = helpers.latest();
      expect(old.received.at(-1)).toMatchObject({op: "read"});     // and is still served by the old helper
      next.ready();                                                // ready while a call is in flight: no swap yet
      await settle();
      expect(old.inputClosed).toBe(false);
      old.answerLast({ok: true, window: WINDOW, text: "served by the old one"});
      expect(await during).toMatchObject({ok: true, text: "served by the old one"});

      expect(old.received.at(-1)).toEqual({op: "shutdown"});       // swapped as soon as nothing was in flight
      expect(old.inputClosed).toBe(true);
      expect(events).toEqual(["HELPER_REPLACED"]);                 // and it was no crash
      const after = client.read({budgetMs: 1500, expect: WINDOW});
      expect(next.received.at(-1)).toMatchObject({op: "read"});
      next.answerLast({ok: true, window: WINDOW, text: "served by the new one"});
      expect(await after).toMatchObject({text: "served by the new one"});
    });

    it("a read that was superseded and never answered does not hold the swap up", async () => {
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.read({budgetMs: 1500, expect: WINDOW});                          // abandoned by main, never answered by the helper
      const second = client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().ready();                                    // the replacement is warm
      await settle();
      old.answerLast({ok: true, window: WINDOW, text: "second"});
      await second;
      expect(old.inputClosed).toBe(true);                          // nothing is in flight any more: swapped
    });

    it("also happens after six hours", async () => {
      await ready();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      expect(helpers.all).toHaveLength(2);
    });

    it("a replacement that dies while warming up is an exit, and the old helper simply carries on", async () => {
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      helpers.latest().exit();
      expect(events).toEqual(["HELPER_EXIT"]);
      expect(client.state()).toBe("ready");
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      expect(helpers.all).toHaveLength(2);                         // the next attempt is a full period away
      old.answerLast({ok: true, window: WINDOW, text: "still here"});
      expect(await read).toMatchObject({text: "still here"});
    });

    it("a replacement that dies while warming up does not count towards giving up", async () => {
      await ready();
      // Four real crashes inside the ten-minute window: one short of giving up.
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
        helpers.latest().ready();
        await settle();
      }
      const serving = helpers.latest();
      // Enough reads to make a planned restart due, still inside the same window.
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) await goodRead();
      const read = client.read({budgetMs: 1500, expect: WINDOW});                  // notices it is time, starts a replacement
      expect(helpers.latest()).not.toBe(serving);
      helpers.latest().exit();                                     // which dies while warming up
      expect(events).not.toContain("HELPER_GAVE_UP");              // it interrupted nothing
      expect(client.state()).toBe("ready");
      serving.answerLast({ok: true, window: WINDOW, text: "still serving"});
      expect(await read).toMatchObject({text: "still serving"});

      serving.exit();                                              // the fifth REAL crash does count
      expect(events).toContain("HELPER_GAVE_UP");
    });

    it("if the old helper dies while the replacement warms up, the replacement takes over without a second start", async () => {
      await ready();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      const next = helpers.latest();
      helpers.all[0]?.exit();
      expect(client.state()).toBe("starting");
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
      expect(helpers.all).toHaveLength(2);
      next.ready();
      await settle();
      expect(client.state()).toBe("ready");
    });

    it("focus events from a replacement that has not taken over are ignored", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      helpers.latest().ready();
      await settle();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      const held = client.read({budgetMs: 1500, expect: WINDOW});                  // keeps the old helper busy, so no swap
      const next = helpers.latest();
      next.ready();
      await settle();
      next.emit({event: "focus"});
      expect(count).toBe(0);
      helpers.all[0]?.answerLast({ok: true, window: WINDOW, text: "x"});
      await held;
    });
  });
});
