import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers, type FakeHelpers} from "../testing/fakeReaderHelper";
import {
  CLIENT_CALL_DEADLINE_MS, CLIENT_DENIED_REFRESH_MS, CLIENT_MAX_READ_BUDGET_MS, CLIENT_READ_GRACE_MS, HELPER_BACKOFF_MAX_MS,
  HELPER_EXIT_LIMIT, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS, HELPER_SHUTDOWN_GRACE_MS, HELPER_START_DEADLINE_MS
} from "./constants";
import type {HelperLink} from "./protocol";
import {createReaderClient, ReaderDown, type ReaderClient, type ReaderClientEvent} from "./readerClient";

const WINDOW = {app: "Code", bundleId: "com.microsoft.VSCode", title: "query.sql"};

describe("reader client: calls", () => {
  let helpers: FakeHelpers;
  let events: ReaderClientEvent[];
  let client: ReaderClient;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  /** A client whose helper is up and ready. */
  async function ready(): Promise<void> {
    void client.permission();                 // any call starts the helper
    helpers.latest().ready();
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    helpers = createFakeHelpers();
    events = [];
    client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (e) => events.push(e)});
  });
  afterEach(() => { vi.useRealTimers(); });

  it("starts no helper until it is used", () => {
    expect(helpers.all).toHaveLength(0);
    expect(client.state()).toBe("idle");
  });

  it("while the helper warms up: permission is unknown, there is no window, a read fails, and nothing is sent", async () => {
    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("starting");
    expect(await client.frontWindow()).toBeNull();
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed", detail: "helperDown"});
    await client.requestPermission();
    expect(helpers.all).toHaveLength(1);
    expect(helpers.latest().received).toEqual([]);
  });

  it("asks the helper once it is ready, and hands back what the port's own parsers accept", async () => {
    await ready();
    expect(client.state()).toBe("ready");

    const permission = client.permission();
    helpers.latest().answerLast({permission: "granted"});
    expect(await permission).toBe("granted");

    const front = client.frontWindow();
    helpers.latest().answerLast({window: WINDOW});
    expect(await front).toEqual(WINDOW);

    const read = client.read({budgetMs: 1500, expect: WINDOW});
    expect(helpers.latest().received.at(-1)).toEqual({id: helpers.latest().lastId(), op: "read", budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "SELECT 1", toolbarText: "example.com", extra: "dropped"});
    expect(await read).toEqual({ok: true, window: WINDOW, text: "SELECT 1", toolbarText: "example.com"});
  });

  it("no front window is null; a window that does not parse rejects, so the loop counts it", async () => {
    await ready();
    const none = client.frontWindow();
    helpers.latest().answerLast({window: null});
    expect(await none).toBeNull();
    const bad = client.frontWindow().then(() => "resolved", (error: unknown) => error);
    helpers.latest().answerLast({window: {app: 7}});
    expect(await bad).toBeInstanceOf(ReaderDown);
    const missing = client.frontWindow().then(() => "resolved", (error: unknown) => error);
    helpers.latest().answerLast({});
    expect(await missing).toBeInstanceOf(ReaderDown);
    expect(client.state()).toBe("ready");                        // a bad answer does not cost the helper its life
  });

  it("a malformed read answer is a failed read; a helper's failure reason passes through", async () => {
    await ready();
    const bad = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, text: 5});
    // No detail: the helper answered, so this is not `helperDown`, and what it answered could not be
    // read, so there is no stage to name either. The loop tallies it as `failedUnknown`.
    expect(await bad).toEqual({ok: false, reason: "failed"});
    const locked = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "locked"});
    expect(await locked).toEqual({ok: false, reason: "locked"});
  });

  /**
   * A helper's own account of which stage failed is passed on — that is the point of the feature —
   * but only for the stages a helper can actually witness.
   *
   * `helperDown` is not one of them. It means "this read was never answered by a helper at all",
   * which is a fact about the pipe, and this client is the thing holding the pipe. A helper that
   * claims it — stale, confused, or a different binary than we think — would otherwise put
   * `failedHelperDown` in `app.log` and send whoever reads it to the supervisor while the fault is
   * in the capture. Dropped, so the read counts as `failedUnknown`: we know it failed, and we
   * correctly do not claim to know why.
   */
  it("passes a helper's stage through, but never lets it claim the one word only we can say", async () => {
    await ready();
    const staged = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "failed", detail: "captureNoContent"});
    expect(await staged).toEqual({ok: false, reason: "failed", detail: "captureNoContent"});

    const lying = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "failed", detail: "helperDown"});
    expect(await lying).toEqual({ok: false, reason: "failed"});
  });

  // The client does not interpret a reason, it passes the parsed result on. `windowGone` has to
  // arrive at the loop as itself: turned into `failed` it would count towards switching capture off.
  it("passes a vanished window through as its own reason", async () => {
    await ready();
    const gone = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "windowGone"});
    expect(await gone).toEqual({ok: false, reason: "windowGone"});
  });

  // Protocol 2. `expect` is a privacy instruction to another process, so what goes on the wire is
  // written out field by field rather than spread from whatever object main happened to hand over.
  it("puts exactly the three known fields of the approved window on the wire", async () => {
    await ready();
    const noted = {app: "Code", title: "query.sql", note: "main's own bookkeeping"};
    void client.read({budgetMs: 1500, expect: noted});
    expect(helpers.latest().lastRead().expect).toEqual({app: "Code", title: "query.sql"});
    expect(Object.keys(helpers.latest().lastRead().expect)).toEqual(["app", "title"]);

    void client.read({budgetMs: 1500, expect: WINDOW});
    expect(helpers.latest().lastRead().expect).toEqual(WINDOW);
    expect(Object.keys(helpers.latest().lastRead().expect).sort()).toEqual(["app", "bundleId", "title"]);
  });

  // The helper measures what a read cost (protocol 2). Those numbers are for the evaluation
  // harness; the port hands the caller the port's own fields and nothing else.
  it("strips the helper's measurements out of a read answer", async () => {
    await ready();
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "SELECT 1", stats: {captureMs: 31, recogniseMs: 198, cacheHit: false}});
    expect(await read).toEqual({ok: true, window: WINDOW, text: "SELECT 1"});
  });

  it("anything but a known permission value is unknown", async () => {
    await ready();
    const p = client.permission();
    helpers.latest().answerLast({permission: "needsRestart"});   // not the helper's to say
    expect(await p).toBe("unknown");
  });

  it("an unreadable line fails whatever was being asked", async () => {
    await ready();
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().emitRaw("Segmentation fault");
    expect(await read).toEqual({ok: false, reason: "failed", detail: "helperDown"});
    expect(client.state()).toBe("ready");        // one stray line does not cost the helper its life
  });

  it("drops an answer nobody is waiting for", async () => {
    await ready();
    helpers.latest().emit({id: 999, ok: true, window: WINDOW, text: "stale"});
    const front = client.frontWindow();
    helpers.latest().answerLast({window: WINDOW});
    expect(await front).toEqual(WINDOW);
  });

  describe("re-entry", () => {
    it("a second read settles the first as a timeout, cancels it, and can never be answered by it", async () => {
      await ready();
      const first = client.read({budgetMs: 1500, expect: WINDOW});
      const firstId = helpers.latest().lastId();
      const second = client.read({budgetMs: 1500, expect: WINDOW});
      expect(await first).toEqual({ok: false, reason: "timeout"});
      expect(helpers.latest().received).toContainEqual({op: "cancel", target: firstId});

      // The earlier frame arrives late, under the earlier id: it must not answer the later call.
      helpers.latest().emit({id: firstId, ok: true, window: WINDOW, text: "EARLIER FRAME"});
      let answered = false;
      void second.then(() => { answered = true; });
      await settle();
      expect(answered).toBe(false);

      helpers.latest().answerLast({ok: true, window: WINDOW, text: "later frame"});
      expect(await second).toEqual({ok: true, window: WINDOW, text: "later frame"});
    });

    it("a read does not disturb a front-window call in flight", async () => {
      await ready();
      const front = client.frontWindow();
      const frontId = helpers.latest().lastId();
      void client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().emit({id: frontId, window: WINDOW});
      expect(await front).toEqual(WINDOW);
      expect(helpers.latest().received.filter((m) => "op" in m && m.op === "cancel")).toEqual([]);
    });
  });

  describe("deadlines", () => {
    it("a read that outlives budget plus grace is a timeout, and the wedged helper is killed and replaced", async () => {
      await ready();
      const wedged = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      await vi.advanceTimersByTimeAsync(1500 + CLIENT_READ_GRACE_MS - 1);
      expect(wedged.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toEqual({ok: false, reason: "timeout"});
      expect(wedged.killed).toBe(true);
      expect(events).toContain("HELPER_WEDGED");
      await vi.advanceTimersByTimeAsync(500);
      expect(helpers.all).toHaveLength(2);
    });

    it("a front-window call that is never answered rejects, so the loop counts it", async () => {
      await ready();
      const front = client.frontWindow();
      const outcome = front.then(() => "resolved", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
      expect(await outcome).toBeInstanceOf(ReaderDown);
      expect(helpers.all[0]?.killed).toBe(true);
    });

    it("a permission call that is never answered is unknown; a permission request just ends", async () => {
      await ready();
      const p = client.permission();
      await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
      expect(await p).toBe("unknown");
    });

    it("treats a nonsense budget as zero rather than passing it on", async () => {
      await ready();
      void client.read({budgetMs: Number.NaN, expect: WINDOW});
      expect(helpers.latest().received.at(-1)).toMatchObject({op: "read", budgetMs: 0});
    });

    it("caps an absurd budget instead of overflowing the timer and killing a healthy helper", async () => {
      await ready();
      const read = client.read({budgetMs: 2 ** 31, expect: WINDOW});
      expect(helpers.latest().received.at(-1)).toMatchObject({op: "read", budgetMs: CLIENT_MAX_READ_BUDGET_MS});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(helpers.latest().killed).toBe(false);
      helpers.latest().answerLast({ok: false, reason: "black"});
      expect(await read).toEqual({ok: false, reason: "black"});
    });
  });

  describe("the helper goes away under a call", () => {
    it("a read fails, a front-window call rejects, permission is unknown", async () => {
      await ready();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const front = client.frontWindow().then(() => "resolved", (error: unknown) => error);
      const permission = client.permission();
      helpers.latest().exit();
      expect(await read).toEqual({ok: false, reason: "failed", detail: "helperDown"});
      expect(await front).toBeInstanceOf(ReaderDown);
      expect(await permission).toBe("unknown");
      expect(events).toContain("HELPER_EXIT");
    });
  });

  describe("permission: what works outranks what the check says", () => {
    it("restarts the helper once by itself when captures are refused, and only then asks the user to restart", async () => {
      await ready();
      const first = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await first).toBe("unknown");                       // not the user's problem yet
      // With nothing in flight the old helper is asked to go at once — asked, not killed: it is
      // being replaced on suspicion, and a helper that leaves when asked never needs killing.
      expect(helpers.all[0]?.received.at(-1)).toEqual({op: "shutdown"});
      expect(helpers.all[0]?.inputClosed).toBe(true);
      expect(helpers.all[0]?.exited()).toBe(true);
      expect(helpers.all).toHaveLength(2);                       // at once, without backoff
      expect(events).not.toContain("HELPER_EXIT");               // and it was no crash

      helpers.latest().ready();
      await settle();
      const second = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await second).toBe("needsRestart");
      expect(helpers.all).toHaveLength(2);                       // no restart loop
    });

    /**
     * The other way the same helper can be sent away twice, and the one the `drain` guard is
     * actually for: a warmed-up replacement is waiting, the `refused` answer settles the last call
     * in flight, and `tryPromote()` — which runs inside `onLine`, before the `permission()`
     * continuation gets its turn — promotes the replacement and retires this helper. The cure then
     * calls `drain()` on a helper that is already on its way out. Without the guard that is a second
     * `shutdown` and a kill timer restarted, extending the grace period, for one replacement that
     * has already happened.
     */
    it("does not send a helper away twice when a promotion and the refused cure land together", async () => {
      helpers.exitOnInputClosed = false;      // so a retired helper is still there to be retired again
      await ready();
      // Enough reads that the next call plans the routine replacement.
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();
      const answer = client.permission();     // plans the replacement, and asks the serving helper
      expect(helpers.all).toHaveLength(2);
      helpers.latest().ready();               // warm, but a call is in flight: not promoted yet
      await settle();
      expect(events).not.toContain("HELPER_REPLACED");

      serving.answerLast({permission: "refused"});
      expect(await answer).toBe("unknown");
      expect(events).toContain("HELPER_REPLACED");                              // promoted first
      expect(serving.received.filter((m) => m.op === "shutdown")).toHaveLength(1);
      expect(helpers.all).toHaveLength(2);    // and the cure started nothing of its own
    });

    /**
     * The cure used to kill the old helper where it stood, which settled a `read` in flight as
     * `failed` — and the capture loop counts `failed` against the reader, in the same failure window
     * that decides whether to switch capture off and tell the user the reader is broken. Our own
     * cure must not reach the loop looking like the illness.
     */
    it("lets a read that is already in flight finish, and only then asks the old helper to go", async () => {
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const readId = old.lastId();
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      expect(await refused).toBe("unknown");

      expect(helpers.all).toHaveLength(2);                       // the fresh helper is already warming up
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);   // and nobody hurried the old one
      expect(old.killed).toBe(false);
      old.emit({id: readId, ok: true, window: WINDOW, text: "finished after the cure began"});
      expect(await read).toEqual({ok: true, window: WINDOW, text: "finished after the cure began"});

      expect(old.received.at(-1)).toEqual({op: "shutdown"});     // its last call answered: now it may go
      expect(old.inputClosed).toBe(true);
      expect(events).toEqual([]);                                // going when asked is no crash, and counts for nothing
    });

    it("sends the helper on its way out nothing more: later calls go to the fresh one", async () => {
      await ready();
      const old = helpers.latest();
      void client.read({budgetMs: 1500, expect: WINDOW});        // never answered, so `old` stays alive
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      const sent = old.received.length;

      const fresh = helpers.latest();
      fresh.ready();
      await settle();
      const granted = client.permission();
      fresh.answerLast({permission: "granted"});
      expect(await granted).toBe("granted");
      expect(old.received).toHaveLength(sent);
    });

    it("a helper on its way out that never answers is killed by its own call's deadline", async () => {
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      await vi.advanceTimersByTimeAsync(1500 + CLIENT_READ_GRACE_MS);

      expect(await read).toEqual({ok: false, reason: "timeout"});
      expect(old.killed).toBe(true);
      // `HELPER_WEDGED` is said for a helper on its way out as well: the code states that the binary
      // hung inside a native call, which is true whoever was waiting for it, and a helper that hangs
      // on every read would otherwise be replaced in silence for ever. Its exit still counts for
      // nothing — it was out of service before it hung.
      expect(events).toEqual(["HELPER_WEDGED"]);
    });

    it("dispose in the middle of the drain owns both helpers", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      const fresh = helpers.latest();
      expect(fresh).not.toBe(old);

      const done = client.dispose();
      expect(await read).toEqual({ok: false, reason: "failed", detail: "helperDown"});  // nobody is listening any more
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(fresh.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    /**
     * The twin of "does not take the last working helper away after the supervisor has given up"
     * below, on this path. The cure IS a fresh helper, and once the supervisor has given up there is
     * none to be had — `start()` refuses — so draining the helper that is still answering perfectly
     * well would leave the client with no process at all: `state()` `gaveUp`, `permission()`
     * `unknown` for ever, and nothing on screen, because giving up is only logged.
     *
     * The answer is `needsRestart`, not `unknown`. The system check says yes while captures are
     * refused — that is something real and something the user can act on — and restarting the app is
     * exactly the cure we can no longer perform ourselves: a new process gets both a fresh helper
     * (curing the stale grant) and a supervisor that has not given up. `unknown` would reach the
     * engine as `NO_PERMISSION` (`engine.ts:246`), which is not what we know, and would leave a
     * reader that needs a restart saying nothing at all.
     */
    it("the refused cure does not take the last working helper away after the supervisor has given up", async () => {
      await ready();
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();                                  // a crash: counted
        await settle();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);  // the restart timer fires
        helpers.latest().ready();
        await settle();
      }
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();
      const planned = client.permission();                        // this call plans the replacement
      serving.answerLast({permission: "granted"});
      await planned;
      const warming = helpers.all.length;
      expect(warming).toBe(6);                                    // five so far, plus the one warming up
      serving.exit();                                             // the fifth crash: given up, but not down
      await settle();
      expect(events).toContain("HELPER_GAVE_UP");
      helpers.latest().ready();
      await settle();
      expect(client.state()).toBe("ready");

      const refused = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await refused).toBe("needsRestart");                 // the user's turn: we cannot cure it
      expect(helpers.all).toHaveLength(warming);                  // and the helper we have is still ours
      expect(client.state()).toBe("ready");
      const again = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await again).toBe("granted");                        // still answering, call after call
    });

    it("a good read ends the episode, so a later refusal gets its own automatic restart", async () => {
      await ready();
      const p1 = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      await p1;
      helpers.latest().ready();
      await settle();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().answerLast({ok: true, window: WINDOW, text: "fine again"});
      await read;
      const p2 = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await p2).toBe("unknown");
      expect(helpers.all).toHaveLength(3);
    });
  });

  // Measured in the first real run: the system check is cached for the life of the process and the
  // helper never captures while denied, so the helper that was running when the owner switched
  // Screen Recording on kept saying `denied` until it was killed, while a fresh one said `granted`
  // at once.
  describe("permission: a stale `denied` is cured by a fresh helper", () => {
    /** A ready helper with nothing in flight: the first `permission()` is answered before it is ready. */
    async function readyIdle(): Promise<void> {
      expect(await client.permission()).toBe("unknown");   // starts the helper; nothing is asked yet
      helpers.latest().ready();
      await settle();
    }

    async function denied(): Promise<string> {
      const p = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      return p;
    }

    it("leaves a young helper alone, so polling every second cannot cause a restart storm", async () => {
      await readyIdle();
      expect(await denied()).toBe("denied");
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS - 1);
      expect(await denied()).toBe("denied");
      expect(helpers.all).toHaveLength(1);
      expect(helpers.all[0]?.received.some((m) => m.op === "shutdown")).toBe(false);
    });

    it("replaces a helper that has been saying denied for long enough, and blames it for nothing", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      expect(await denied()).toBe("denied");                        // this call still answers what it knows
      const old = helpers.all[0];
      expect(old?.received.some((m) => m.op === "shutdown")).toBe(true);
      expect(old?.inputClosed).toBe(true);
      expect(helpers.all).toHaveLength(2);                          // a fresh one, at once
      expect(events).not.toContain("HELPER_EXIT");                  // going when asked is not a crash
      expect(events).not.toContain("HELPER_GAVE_UP");
    });

    /**
     * Two polls in flight at once — the engine's tick and a recheck from the window, say — both
     * answered `denied` by the same helper that is old enough to be replaced. The first answer
     * sends it away; the second must find a helper already on its way out and leave it alone,
     * rather than retire it a second time (a second `shutdown`, and the grace period extended by a
     * restarted kill timer) and charge one replacement two doublings of the wait.
     */
    it("sends a helper away once, however many denied answers land on it at the same time", async () => {
      helpers.exitOnInputClosed = false;        // so a retired helper is still there to be retired again
      await readyIdle();
      // Older than the DOUBLED interval: the first answer doubles the wait before the second is
      // looked at, so a younger helper would be spared the second drain by the doubling alone.
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS * 2);
      const old = helpers.latest();

      const first = client.permission();
      const second = client.permission();
      const ids = old.received.flatMap((message) => ("id" in message ? [message.id] : []));
      expect(ids).toHaveLength(2);
      old.emit({id: ids[0] as number, permission: "denied"});
      old.emit({id: ids[1] as number, permission: "denied"});
      expect(await first).toBe("denied");
      expect(await second).toBe("denied");

      expect(old.received.filter((message) => message.op === "shutdown")).toHaveLength(1);
      expect(helpers.all).toHaveLength(2);      // one replacement, not two

      // And the wait doubled once, not twice: the next replacement is due after ten seconds.
      helpers.latest().ready();
      await settle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS * 2);
      const third = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await third).toBe("denied");
      expect(helpers.all).toHaveLength(3);
    });

    it("the fresh helper's answer is the one that counts", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      await denied();
      helpers.latest().ready();
      await settle();
      const p = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await p).toBe("granted");
    });

    it("twenty denied polls a second apart replace the helper at most once per five seconds", async () => {
      await readyIdle();
      for (let second = 0; second < 20; second++) {
        if (!helpers.latest().exited()) {
          const p = client.permission();
          // A helper that is not ready yet is never asked, so there is nothing to answer.
          if (helpers.latest().received.some((m) => "id" in m)) helpers.latest().answerLast({permission: "denied"});
          await p;
        }
        helpers.latest().ready();
        await settle();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(helpers.all.length).toBeLessThanOrEqual(1 + Math.floor(20 / (CLIENT_DENIED_REFRESH_MS / 1_000)));
      expect(events).not.toContain("HELPER_GAVE_UP");
      expect(client.state()).toBe("ready");
    });

    // The refresh is our decision about a helper that is answering perfectly well, so it costs the
    // calls it is holding nothing: they are answered by the helper that took them, and only then is
    // it asked to go. Settling them as "down" instead would reach the capture loop as `failed` and
    // count against the reader in the window that switches capture off.
    it("lets the calls in flight finish on the helper being replaced, and never sends it another", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const readId = old.lastId();
      const front = client.frontWindow();
      const frontId = old.lastId();
      expect(await denied()).toBe("denied");
      const sent = old.received.length;
      expect(helpers.all).toHaveLength(2);                          // the fresh one is warming up already
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);

      old.emit({id: frontId, window: WINDOW});
      expect(await front).toEqual(WINDOW);
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);   // one call still open
      old.emit({id: readId, ok: true, window: WINDOW, text: "its last word"});
      expect(await read).toEqual({ok: true, window: WINDOW, text: "its last word"});
      expect(old.received.at(-1)).toEqual({op: "shutdown"});        // nothing left to hold it here
      expect(old.inputClosed).toBe(true);

      // The fresh helper is not ready, so these are answered without anybody being asked.
      expect(await client.permission()).toBe("unknown");
      expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed", detail: "helperDown"});
      expect(old.received).toHaveLength(sent + 1);                  // the shutdown, and nothing else
      expect(events).not.toContain("HELPER_EXIT");
    });

    /**
     * One poll a second, every one answered `denied`, each fresh helper readied at once — the
     * engine's tick, sped up. Answers with the seconds (counted from the first poll of this call) at
     * which a new helper was spawned.
     */
    async function pollDeniedFor(seconds: number): Promise<number[]> {
      const spawnedAt: number[] = [];
      for (let second = 0; second < seconds; second++) {
        const before = helpers.all.length;
        if (!helpers.latest().exited()) {
          const p = client.permission();
          // A helper that is not ready yet is never asked, so there is nothing to answer.
          if (helpers.latest().received.some((m) => "id" in m)) helpers.latest().answerLast({permission: "denied"});
          await p;
        }
        if (helpers.all.length > before) spawnedAt.push(second);
        helpers.latest().ready();
        await settle();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      return spawnedAt;
    }

    // The engine asks every 10 s whatever else is happening, so a fixed 5 s wait would charge a user
    // who has simply declined a process and a Vision warm-up every 10 s for ever. Doubling makes the
    // cost fade: over five minutes this poller pays 7 replacements instead of 60. The 60 is a rate
    // only a unit test reaches — it polls once a second, so a fixed 5 s interval is due again every
    // 5 s (300 / 5). The app's own asker is the engine's tick, `PIPELINE_TICK_MS`, at 10 s, where the
    // same fixed interval would cost about 30 replacements — 31 helpers — in five minutes. Either
    // baseline is many times the 7 measured here, which is the point of the test.
    it("doubles the wait after each replacement that is still denied, up to a minute", async () => {
      await readyIdle();
      const spawnedAt = await pollDeniedFor(300);
      // The gaps are the intervals used: 5, 10, 20, 40, then capped at 60, 60.
      expect(spawnedAt).toEqual([5, 15, 35, 75, 135, 195, 255]);
      expect(helpers.all).toHaveLength(8);
      expect(events).not.toContain("HELPER_EXIT");
      expect(events).not.toContain("HELPER_GAVE_UP");
    });

    it("an answer that is not denied puts the wait back to the first interval", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);   // the wait is now 40 s
      const before = helpers.all.length;
      const granted = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await granted).toBe("granted");
      // Six more seconds is enough only because the wait went back to five.
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("asking the user for permission puts the wait back, because they are about to grant it", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);
      const before = helpers.all.length;
      const asked = client.requestPermission();
      helpers.latest().answerLast({});
      await asked;
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("switching capture on puts the wait back: that is the user's try again", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);
      const before = helpers.all.length;
      client.onFocusChange(() => undefined);
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("does not take the last working helper away after the supervisor has given up", async () => {
      // Giving up while a helper is still serving needs the fifth counted exit to promote a warming
      // replacement, and a replacement is only planned after HELPER_PLANNED_RESTART_READS reads or
      // six hours — six hours would push the earlier exits out of the ten-minute window, so reads it
      // is. This is the state the re-review reached.
      await readyIdle();
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();                                  // a crash: counted
        await settle();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);  // the restart timer fires
        helpers.latest().ready();
        await settle();
      }
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();                           // the helper that has done the reads
      const planned = client.permission();                        // this call plans the replacement
      serving.answerLast({permission: "granted"});
      await planned;
      const warming = helpers.all.length;
      expect(warming).toBe(6);                                    // five so far, plus the one warming up
      serving.exit();                                             // the fifth crash, with a replacement ready to take over
      await settle();
      expect(events).toContain("HELPER_GAVE_UP");
      helpers.latest().ready();
      await settle();
      expect(client.state()).toBe("ready");                       // a helper is still serving

      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      const p = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await p).toBe("denied");
      // Without the guard this would retire the last helper, `start()` would refuse to replace it,
      // and `permission()` would answer `unknown` for ever with nothing on screen to say why.
      expect(helpers.all).toHaveLength(warming);
      expect(client.state()).toBe("ready");
      const again = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await again).toBe("denied");
    });
  });

  describe("focus", () => {
    it("tells every subscriber, survives one that throws, and stops telling one that unsubscribed", async () => {
      const seen: string[] = [];
      client.onFocusChange(() => { seen.push("a"); });
      client.onFocusChange(() => { throw new Error("bad subscriber"); });
      const off = client.onFocusChange(() => { seen.push("c"); });
      helpers.latest().ready();
      await settle();
      helpers.latest().emit({event: "focus"});
      expect(seen).toEqual(["a", "c"]);
      off();
      helpers.latest().emit({event: "focus"});
      expect(seen).toEqual(["a", "c", "a"]);
    });

    it("subscribing starts the helper, and subscriptions survive a helper restart", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      expect(helpers.all).toHaveLength(1);
      helpers.latest().ready();
      await settle();
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(500);
      helpers.latest().ready();
      await settle();
      helpers.latest().emit({event: "focus"});
      expect(count).toBe(1);
    });

    it("ignores focus events from a helper that is not ready", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      helpers.latest().emit({event: "focus"});
      expect(count).toBe(0);
    });
  });

  describe("dispose", () => {
    it("asks the helper to go, closes its input, and needs no kill when it leaves", async () => {
      await ready();
      const helper = helpers.latest();
      await client.dispose();
      expect(helper.received.at(-1)).toEqual({op: "shutdown"});
      expect(helper.inputClosed).toBe(true);
      expect(helper.killed).toBe(false);
      expect(client.state()).toBe("disposed");
    });

    it("kills a helper that does not leave within the grace period", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const helper = helpers.latest();
      const done = client.dispose();
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(helper.killed).toBe(true);
    });

    it("fails calls in flight, answers every later call as down, starts nothing, and tells no one", async () => {
      await ready();
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      await client.dispose();
      expect(await read).toEqual({ok: false, reason: "failed", detail: "helperDown"});
      expect(await client.permission()).toBe("unknown");
      expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed", detail: "helperDown"});
      await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
      await vi.advanceTimersByTimeAsync(HELPER_START_DEADLINE_MS);
      expect(helpers.all).toHaveLength(1);
      expect(count).toBe(0);
      await client.dispose();                                     // twice is fine
    });

    // A helper that has been asked to go is still a process. Until now `dispose` only knew about
    // `current` and `replacement`, so one that had been retired earlier — and that ignores both
    // `shutdown` and a closed stdin — was held by nothing but its own kill timer, which outlived the
    // client: the process was still there after the app believed the reader was gone.
    it("waits for a stubborn helper that a promotion retired, and kills it", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      const p = client.permission();                     // any call plans the replacement
      old.answerLast({permission: "granted"});
      await p;
      expect(helpers.all).toHaveLength(2);
      helpers.latest().ready();                          // the replacement takes over and retires `old`
      await settle();
      expect(events).toContain("HELPER_REPLACED");
      expect(old.inputClosed).toBe(true);
      expect(old.killed).toBe(false);                    // stubborn: it is still running
      // The promoted helper then crashes, so the stubborn `old` is the only thing still on its way
      // out. If `dispose` does not know about it, it has nothing to wait for and returns at once.
      helpers.latest().exit();
      await settle();

      let resolvedWhileItRan = false;
      const done = client.dispose().then(() => { resolvedWhileItRan = !old.killed && !old.exited(); });
      await settle();
      expect(resolvedWhileItRan).toBe(false);
      // One helper on its way out, one kill timer: re-retiring it must not orphan the first one.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a stubborn helper that the denied refresh retired, and kills it", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      helpers.failNextSpawn = true;                      // no fresh helper, so `old` is all there is
      const p = client.permission();
      old.answerLast({permission: "denied"});
      expect(await p).toBe("denied");
      expect(helpers.all).toHaveLength(1);
      expect(old.inputClosed).toBe(true);
      expect(old.killed).toBe(false);

      let resolvedWhileItRan = false;
      const done = client.dispose().then(() => { resolvedWhileItRan = !old.killed && !old.exited(); });
      await settle();
      expect(resolvedWhileItRan).toBe(false);
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

/**
 * `HelperLink` asks the client to register `onLine` and `onExit` in the same turn as `spawn()`
 * returns, and the real link holds back whatever the helper said before that — delivering it on a
 * later turn, never from inside `onLine` itself. This is the client's half of the same contract: a
 * link that DOES deliver re-entrantly must not be able to wedge it.
 *
 * It could. `launch()` registered the callbacks before the caller had put the new helper into
 * `current` or `replacement`, so a line delivered during registration was handled against a helper
 * the client did not know about yet. A mismatching `ready` reached `gone()`, which found the helper
 * in neither slot and so recorded nothing and scheduled nothing; `start()` then assigned the already
 * dead helper to `current`. The client sat in "starting" for ever — no timers, no further spawn, and
 * `frontWindow()` answering `null` instead of rejecting, so the capture loop never counted a failure
 * (`loop.ts`) and a reader that was dead for good never surfaced as a reader problem.
 */
describe("reader client: a link that delivers lines from inside `onLine`", () => {
  /** A link that says its piece the moment the client registers, and answers nothing afterwards. */
  const reentrant = (lines: string[]): HelperLink => ({
    send: () => undefined,
    onLine(cb) { for (const line of lines) cb(line); },
    onExit: () => undefined,
    closeInput: () => undefined,
    kill: () => undefined
  });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a mismatching `ready` delivered during registration stops the client for good, and says so", async () => {
    const events: ReaderClientEvent[] = [];
    let spawned = 0;
    const client = createReaderClient({
      spawn: () => { spawned += 1; return reentrant(['{"event":"ready","protocol":1}']); },
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("gaveUp");                        // not "starting" for ever
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);   // the loop counts this
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect({spawned, events}).toEqual({spawned: 1, events: ["HELPER_PROTOCOL_MISMATCH"]});
    expect(vi.getTimerCount()).toBe(0);
    await client.dispose();
  });

  /** A link that never notices it was asked to go: only the kill timer ends it, so dispose waits. */
  async function disposeOf(client: ReaderClient): Promise<void> {
    const done = client.dispose();
    await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
    await done;
  }

  it("a good `ready` delivered during registration leaves the client ready", async () => {
    const client = createReaderClient({spawn: () => reentrant(['{"event":"ready","protocol":2}']), now: () => Date.now()});
    void client.permission();
    expect(client.state()).toBe("ready");
    await disposeOf(client);
  });

  it("a replacement whose `ready` arrives during registration takes over, and says so", async () => {
    const events: ReaderClientEvent[] = [];
    const first = {say: (_line: string) => undefined as void, shutdown: false};
    let spawned = 0;
    const client = createReaderClient({
      spawn: () => {
        spawned += 1;
        if (spawned > 1) return reentrant(['{"event":"ready","protocol":2}']);
        return {
          send: (line) => { if (line.includes("shutdown")) first.shutdown = true; },
          onLine(cb) { first.say = cb; },
          onExit: () => undefined,
          closeInput: () => undefined,
          kill: () => undefined
        };
      },
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    void client.permission();
    first.say('{"event":"ready","protocol":2}');
    await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
    void client.permission();                                    // plans the replacement, ready on arrival
    expect(spawned).toBe(2);
    // The swap is not left waiting for a line that a warm helper has no reason to send.
    expect(events).toEqual(["HELPER_REPLACED"]);
    expect(first.shutdown).toBe(true);
    await disposeOf(client);
  });
});
