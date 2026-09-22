import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CoreError} from "../../core/errors";
import type {ModelSettings} from "../../core/types";
import {MODEL_CRASH_LIMIT, MODEL_CRASH_WINDOW_MS, MODEL_IDLE_UNLOAD_MS, MODEL_REQUEST_TIMEOUT_MS} from "../constants";
import {createFakeHosts} from "../testing/fakeHost";
import {createModelClient} from "./client";
import type {FromHost, HostLink} from "./protocol";

const SETTINGS: ModelSettings = {systemPrompt: "system", thoughts: "discourage", templateVariation: "3.5", temperature: 0.2};
const LIMITS = {maxTokens: 300, timeoutMs: 30_000};

describe("model client", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts the host on demand and carries a conversation over messages", async () => {
    const hosts = createFakeHosts([{is_professional: true}]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    expect(hosts.spawned).toBe(0);
    const conversation = await client.open(SETTINGS);
    expect(await conversation.ask("the scenario", {type: "object"}, LIMITS)).toEqual({is_professional: true});
    await conversation.close();
    expect(hosts.spawned).toBe(1);
    expect(hosts.received.map((m) => m.type)).toEqual(["open", "ask", "close"]);
    expect(hosts.received[1]).toMatchObject({userText: "the scenario", maxTokens: 300});
  });

  it("fails the call in flight with the fixed code when the host dies, and restarts for the next call", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const conversation = await client.open(SETTINGS);
    const asking = conversation.ask("the scenario", {}, LIMITS);
    hosts.crash();
    const error = await asking.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("MODEL_FAILED");
    expect((error as CoreError).message).not.toContain("scenario");

    await client.open(SETTINGS);
    expect(hosts.spawned).toBe(2);
    expect(client.broken()).toBe(false);
  });

  it("gives up after three crashes in ten minutes, and recovers on reset", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const onBroken = vi.fn();
    client.onBroken(onBroken);
    for (let i = 0; i < MODEL_CRASH_LIMIT; i++) { await client.open(SETTINGS); hosts.crash(); }
    expect(client.broken()).toBe(true);
    expect(onBroken).toHaveBeenCalledTimes(1);
    await expect(client.open(SETTINGS)).rejects.toMatchObject({code: "MODEL_FAILED"});
    expect(hosts.spawned).toBe(MODEL_CRASH_LIMIT);

    client.reset();
    await client.open(SETTINGS);
    expect(client.broken()).toBe(false);
  });

  it("does not count crashes that are far apart", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    for (let i = 0; i < MODEL_CRASH_LIMIT + 2; i++) {
      await client.open(SETTINGS); hosts.crash();
      vi.advanceTimersByTime(MODEL_CRASH_WINDOW_MS);
    }
    expect(client.broken()).toBe(false);
  });

  it("stops the host after ten idle minutes and starts it again on demand", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const conversation = await client.open(SETTINGS);
    vi.advanceTimersByTime(MODEL_IDLE_UNLOAD_MS * 2);
    expect(hosts.alive()).toBe(true);             // a conversation is open: never unloaded under it
    await conversation.close();
    vi.advanceTimersByTime(MODEL_IDLE_UNLOAD_MS - 1);
    expect(hosts.alive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hosts.alive()).toBe(false);
    expect(client.broken()).toBe(false);          // an exit we asked for is not a crash
    await client.open(SETTINGS);
    expect(hosts.spawned).toBe(2);
  });

  it("shutdown kills the host and fails anything in flight", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const conversation = await client.open(SETTINGS);
    const asking = conversation.ask("x", {}, LIMITS);
    client.shutdown();
    await expect(asking).rejects.toMatchObject({code: "MODEL_FAILED"});
    expect(hosts.alive()).toBe(false);
  });

  it("a conversation from a crashed host is stale: ask rejects and close spawns nothing", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const conversation = await client.open(SETTINGS);
    hosts.crash();
    expect(hosts.spawned).toBe(1);

    await expect(conversation.ask("x", {}, LIMITS)).rejects.toMatchObject({code: "MODEL_FAILED"});
    expect(hosts.spawned).toBe(1);   // the stale ask() never spawned a new host

    await conversation.close();      // best-effort: resolves locally, sends nothing
    expect(hosts.spawned).toBe(1);   // and never spawns one either
  });

  it("the idle-unload guarantee still holds for a fresh host after a crash", async () => {
    const hosts = createFakeHosts([]);
    const client = createModelClient({spawn: hosts.spawn, now: () => Date.now()});
    const stale = await client.open(SETTINGS);
    hosts.crash();
    const conversation = await client.open(SETTINGS);
    vi.advanceTimersByTime(MODEL_IDLE_UNLOAD_MS * 2);
    expect(hosts.alive()).toBe(true);              // open under the new host: never unloaded under it
    await conversation.close();
    vi.advanceTimersByTime(MODEL_IDLE_UNLOAD_MS - 1);
    expect(hosts.alive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hosts.alive()).toBe(false);
    await stale.close();                            // the stale conversation's best-effort close
    expect(hosts.alive()).toBe(false);               // must not disturb any of this
  });

  it("a silent host times out a request instead of hanging forever", async () => {
    const client = createModelClient({
      spawn: () => ({send: () => undefined, onMessage: () => undefined, onExit: () => undefined, kill: () => undefined}),
      now: () => Date.now()
    });
    const opening = client.open(SETTINGS);
    const failed = expect(opening).rejects.toMatchObject({code: "MODEL_FAILED"});
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
    await failed;
  });

  it("re-arms the idle timer when open() fails, so a silent host is still unloaded", async () => {
    let killed = false;
    const client = createModelClient({
      spawn: () => ({send: () => undefined, onMessage: () => undefined, onExit: () => undefined, kill: () => { killed = true; }}),
      now: () => Date.now()
    });
    const opening = client.open(SETTINGS);
    const failed = expect(opening).rejects.toMatchObject({code: "MODEL_FAILED"});
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
    await failed;
    expect(killed).toBe(false);                                    // still alive right after the failure
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_UNLOAD_MS);
    expect(killed).toBe(true);                                     // and unloaded once it has sat idle
  });

  it("close arms the idle timer before waiting for the reply, so a silent host does not delay unloading", async () => {
    let killed = false;
    let onMessage: ((message: FromHost) => void) | null = null;
    const client = createModelClient({
      spawn: (): HostLink => ({
        // Replies to `open` and to nothing else: the close reply never comes.
        send: (message) => { if (message.type === "open") queueMicrotask(() => onMessage?.({type: "opened", requestId: message.requestId, conversationId: 1})); },
        onMessage: (cb) => { onMessage = cb; },
        onExit: () => undefined,
        kill: () => { killed = true; }
      }),
      now: () => Date.now()
    });
    const conversation = await client.open(SETTINGS);
    const closing = conversation.close();                          // never gets its reply
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_UNLOAD_MS);
    expect(killed).toBe(true);                                     // ten idle minutes, not ten plus 90 s
    await expect(closing).resolves.toBeUndefined();
  });

  it("a failed open() never leaves an idle timer armed under a conversation that succeeded", async () => {
    let killed = false;
    let onMessage: ((message: FromHost) => void) | null = null;
    let opens = 0;
    const client = createModelClient({
      spawn: (): HostLink => ({
        send: (message) => {
          if (message.type !== "open") return;
          opens += 1;
          if (opens === 1) return;                                 // the first open is met with silence
          // Answered on a timer, not a microtask: a real host's reply is just another macrotask, so
          // it can land AFTER an earlier request has already timed out and re-armed the idle timer.
          const {requestId} = message;
          setTimeout(() => onMessage?.({type: "opened", requestId, conversationId: 2}), MODEL_REQUEST_TIMEOUT_MS - 5);
        },
        onMessage: (cb) => { onMessage = cb; },
        onExit: () => undefined,
        kill: () => { killed = true; }
      }),
      now: () => Date.now()
    });

    const doomed = client.open(SETTINGS);
    const rejected = expect(doomed).rejects.toMatchObject({code: "MODEL_FAILED"});
    await vi.advanceTimersByTimeAsync(10);                         // a head start, so it gives up first
    const opening = client.open(SETTINGS);
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
    await rejected;
    await opening;                                                 // this one has a live conversation
    await vi.advanceTimersByTimeAsync(MODEL_IDLE_UNLOAD_MS * 2);
    expect(killed).toBe(false);                                    // never unloaded from under a live conversation
  });

  it("a spawn() that throws counts toward the crash limit", async () => {
    const client = createModelClient({spawn: () => { throw new Error("boom"); }, now: () => Date.now()});
    const onBroken = vi.fn();
    client.onBroken(onBroken);
    for (let i = 0; i < MODEL_CRASH_LIMIT; i++) {
      await expect(client.open(SETTINGS)).rejects.toMatchObject({code: "MODEL_FAILED"});
    }
    expect(client.broken()).toBe(true);
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});
