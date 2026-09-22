import {describe, expect, it, vi} from "vitest";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "../../core/index";
import {createFakeModel} from "../../core/testing/fakeModel";
import {createSessionStore} from "../account/session";
import {UPLOAD_BACKOFF_MS} from "../constants";
import {ApiError, type ApprovedStatement} from "../ports/claveApi";
import {StorageError} from "../storage/jsonFile";
import {createFakeApi} from "../testing/fakeApi";
import {createFakeCipher, createMemFs} from "../testing/memFs";
import {createPoolStore} from "./pool";
import {createSentLog, type SentLog} from "./sentLog";
import {createUploader} from "./uploader";

/** Drains the microtask queue, so every promise that can make progress without a timer has. */
const tick = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const item = (id: string): ApprovedStatement => ({
  clientItemId: id, statement: "Traced a latency regression to a missing index and rebuilt it without blocking writes.",
  kind: "skill", targetId: "pg", createdAt: 1, taxonomyVersion: "tax-1", pipelineVersion: "1"
});

async function setup(signedIn = true) {
  let now = 1_000_000;
  const fs = createMemFs();
  const api = createFakeApi(() => now);
  const session = createSessionStore({api, fs, cipher: createFakeCipher(), path: "/d/session.bin", now: () => now});
  if (signedIn) await session.signIn("sardor", "correct");
  const sentLog = createSentLog({fs, path: "/d/sent-log.json"});
  const make = () => createUploader({api, session, sentLog, fs, cipher: createFakeCipher(), path: "/d/outbox.bin", now: () => now});
  return {fs, api, session, sentLog, make, advance: (ms: number) => { now += ms; }, now: () => now};
}

describe("uploader", () => {
  it("sends an approved statement, logs exactly what was sent, and empties the outbox", async () => {
    const {api, sentLog, make, now} = await setup();
    const uploader = make();
    await uploader.enqueue(item("a"));
    expect(api.submitted).toEqual([[item("a")]]);
    expect(uploader.waiting()).toEqual([]);
    expect(sentLog.list("user:sardor")).toEqual([{sentAt: now(), item: item("a"), ownerUserId: "user:sardor"}]);
  });

  it("drops what the server refused for good, counts it, and never logs it as sent", async () => {
    const {api, sentLog, make, now} = await setup();
    const rejectedCounts: number[] = [];
    const uploader = createUploader({api, session: (await setup()).session, sentLog, fs: createMemFs(), cipher: createFakeCipher(), path: "/d/outbox.bin", now, onRejected: (count) => rejectedCounts.push(count)});
    api.submitEvidence = async (_s, items) => ({accepted: items.filter((i) => i.clientItemId === "a").map((i) => i.clientItemId), rejected: ["b", "a", "d", "never-sent"]});
    await uploader.enqueue(item("a"));
    await uploader.enqueue(item("b"));
    await uploader.enqueue(item("c"));
    await uploader.enqueue(item("d"));
    // a: held (and named in both lists: held wins); b, d: refused for good; c: in neither list, so it waits.
    expect(uploader.waiting()).toEqual([item("c")]);
    expect(sentLog.list("user:sardor").map((entry) => entry.item.clientItemId)).toEqual(["a"]);
    // One call per send, with the whole count: the four enqueues collapsed into two sends (the first, then one round for what joined it).
    expect(rejectedCounts.reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(rejectedCounts.every((n) => n >= 1)).toBe(true);
    expect(await uploader.flush(true)).toBe("waiting");
    expect(uploader.waiting()).toEqual([item("c")]);
  });

  it("a refusal is counted only once the outbox save went through, and a listener that throws does not fail the send", async () => {
    const {api, fs, session, sentLog, now} = await setup();
    const counts: number[] = [];
    const uploader = createUploader({api, session, sentLog, fs, cipher: createFakeCipher(), path: "/d/outbox.bin", now, onRejected: (count) => { counts.push(count); throw new Error("listener bug"); }});
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));                   // the send it triggers fails; the item waits
    api.failWith = null;
    api.submitEvidence = async () => ({accepted: [], rejected: ["a"]});
    fs.failWrites = true;
    expect(await uploader.flush(true)).toBe("STORAGE_WRITE_FAILED");
    expect(counts).toEqual([]);                          // nothing counted: the outbox still holds it
    expect(uploader.waiting()).toEqual([item("a")]);
    fs.failWrites = false;
    expect(await uploader.flush(true)).toBe("sent");     // the throwing listener changed nothing
    expect(counts).toEqual([1]);
    expect(uploader.waiting()).toEqual([]);
  });

  it("an answer without a rejected list behaves exactly as before", async () => {
    const {api, sentLog, make} = await setup();
    const uploader = make();
    api.submitEvidence = async (_s, items) => ({accepted: items.map((i) => i.clientItemId)});
    await uploader.enqueue(item("a"));
    expect(uploader.waiting()).toEqual([]);
    expect(sentLog.list("user:sardor")).toHaveLength(1);
  });

  it("logs a sent batch under the batch's owner, never under whoever is signed in now", async () => {
    const {api, session, sentLog, make} = await setup(false);
    const uploader = make();
    await uploader.enqueue(item("a"));                 // built while signed out: the owner is still null
    await session.signIn("sardor", "correct");
    expect(await uploader.flush(true)).toBe("sent");
    expect(sentLog.list("user:sardor").map((e) => e.item.clientItemId)).toEqual(["a"]);

    await session.signOut();
    await session.signIn("someone-else", "correct");
    expect(sentLog.list(session.userId())).toEqual([]);
    expect(api.submitted).toHaveLength(1);
  });

  it("keeps the statement, encrypted, while offline and retries with a growing delay", async () => {
    const {fs, api, make, advance} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));
    expect(uploader.waiting()).toHaveLength(1);
    expect(fs.everything()).not.toContain("latency");

    expect(await uploader.flush()).toBe("waiting");
    advance(UPLOAD_BACKOFF_MS[0]);
    expect(await uploader.flush()).toBe("OFFLINE");
    advance(UPLOAD_BACKOFF_MS[0]);
    expect(await uploader.flush()).toBe("waiting");
    advance(UPLOAD_BACKOFF_MS[1]);
    api.failWith = null;
    expect(await uploader.flush()).toBe("sent");
    expect(uploader.nextAttemptAt()).toBeNull();
  });

  it("never waits longer than the last backoff step", async () => {
    const {api, make, advance, now} = await setup();
    const uploader = make();
    api.failWith = "SERVER";
    await uploader.enqueue(item("a"));
    for (let i = 0; i < 8; i++) { advance(UPLOAD_BACKOFF_MS.at(-1) as number); await uploader.flush(); }
    expect((uploader.nextAttemptAt() as number) - now()).toBe(UPLOAD_BACKOFF_MS.at(-1));
  });

  it("survives a restart with the outbox intact, and sends everything in one request", async () => {
    const {api, make} = await setup();
    api.failWith = "OFFLINE";
    const first = make();
    await first.enqueue(item("a"));
    await first.enqueue(item("b"));
    api.failWith = null;
    const second = make();
    await second.load();
    expect(await second.flush(true)).toBe("sent");
    expect(api.submitted).toEqual([[item("a"), item("b")]]);
  });

  it("does not enqueue the same statement twice, and keeps what the server did not accept", async () => {
    const {api, make} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));
    await uploader.enqueue(item("a"));
    await uploader.enqueue(item("b"));
    expect(uploader.waiting()).toHaveLength(2);
    api.failWith = null;
    api.submitEvidence = async (_s, items) => { api.submitted.push(items); return {accepted: ["a"]}; };
    expect(await uploader.flush(true)).toBe("waiting");
    expect(uploader.waiting().map((i) => i.clientItemId)).toEqual(["b"]);
  });

  it("waits while signed out, and discards the outbox if a different user signs in", async () => {
    const {api, session, make} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));
    api.failWith = null;
    await session.signOut();
    expect(await uploader.flush(true)).toBe("signedOut");
    // W1: nobody is signed in, so nothing is visible — but the item is still stored and still due.
    expect(uploader.waiting()).toEqual([]);
    expect(uploader.nextAttemptAt()).not.toBeNull();

    await session.signIn("sardor", "correct");
    await uploader.adoptOwner(session.userId() as string);
    expect(uploader.waiting()).toHaveLength(1);

    await session.signOut();
    await session.signIn("someone-else", "correct");
    await uploader.adoptOwner(session.userId() as string);
    expect(uploader.waiting()).toEqual([]);
    expect(api.submitted).toEqual([]);
  });

  it("clear empties the outbox and its file", async () => {
    const {fs, api, make} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));
    await uploader.clear();
    expect(uploader.waiting()).toEqual([]);
    expect(fs.files.has("/d/outbox.bin")).toBe(false);
  });

  it("keeps an accepted item in the outbox when the sent log fails to write", async () => {
    const {api, session, fs} = await setup();
    const failingSentLog: SentLog = {list: () => [], load: async () => undefined, add: async () => { throw new Error("disk full"); }};
    const uploader = createUploader({api, session, sentLog: failingSentLog, fs, cipher: createFakeCipher(), path: "/d/outbox.bin", now: () => 1_000_000});
    await uploader.enqueue(item("a"));
    expect(uploader.waiting().map((i) => i.clientItemId)).toEqual(["a"]);
    expect(api.submitted).toEqual([[item("a")]]);   // the server did accept it: resending is safe (clientItemId)
  });

  it("enqueue rejects with the storage error and leaves the outbox unchanged when the save fails", async () => {
    const {fs, make} = await setup();
    const uploader = make();
    fs.failWrites = true;
    await expect(uploader.enqueue(item("a"))).rejects.toBeInstanceOf(StorageError);
    expect(uploader.waiting()).toEqual([]);
  });

  it("flush refuses when the outbox's owner does not match the signed-in user", async () => {
    const {api, session, make} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));   // ownerUserId becomes "user:sardor"
    api.failWith = null;
    await session.signOut();
    await session.signIn("someone-else", "correct");
    // deliberately no adoptOwner call here: the raw owner-mismatch guard must still refuse
    expect(await uploader.flush(true)).toBe("signedOut");
    // W1: not this user's outbox, so not this user's to see — but still stored for its owner.
    expect(uploader.waiting()).toEqual([]);
    expect(uploader.nextAttemptAt()).not.toBeNull();
    expect(api.submitted).toEqual([]);
  });

  it("flush adopts a null owner from the live session before sending, and the adoption sticks", async () => {
    const {api, session, make} = await setup(false);
    const uploader = make();
    await uploader.enqueue(item("a"));
    await uploader.enqueue(item("b"));
    await session.signIn("sardor", "correct");
    // Only "a" is accepted this round; "b" stays in the outbox, still carrying the adopted owner.
    api.submitEvidence = async (_s, items) => { api.submitted.push(items); return {accepted: ["a"]}; };
    expect(await uploader.flush(true)).toBe("waiting");
    expect(uploader.waiting().map((i) => i.clientItemId)).toEqual(["b"]);

    await session.signOut();
    await session.signIn("someone-else", "correct");
    expect(await uploader.flush(true)).toBe("signedOut");   // "b" belongs to sardor now, not someone-else
    expect(uploader.waiting()).toEqual([]);                 // W1: and is not someone-else's to see
    expect(uploader.nextAttemptAt()).not.toBeNull();        // still stored, waiting for sardor
  });

  it("adoptOwner resets the backoff when it clears a different user's items", async () => {
    const {api, session, make, advance, now} = await setup();
    const uploader = make();
    api.failWith = "SERVER";
    await uploader.enqueue(item("a"));            // failures: 0 -> 1, notBefore = now + BACKOFF[0]
    advance(UPLOAD_BACKOFF_MS[0]);                 // past the backoff window, so the next send is not gated
    api.failWith = null;                           // do not let the sign-in below fail too
    await session.signOut();
    await session.signIn("someone-else", "correct");
    await uploader.adoptOwner(session.userId() as string);
    expect(uploader.waiting()).toEqual([]);

    api.failWith = "SERVER";
    await uploader.enqueue(item("b"));             // still failing: must be a FRESH first-step backoff
    expect(uploader.nextAttemptAt()).toBe(now() + UPLOAD_BACKOFF_MS[0]);
  });

  it("flush never rejects: a storage failure while adopting the owner becomes a code and a backoff", async () => {
    const {fs, session, make, now} = await setup(false);
    const uploader = make();
    await uploader.enqueue(item("a"));              // signed out: the owner stays null
    await session.signIn("sardor", "correct");
    fs.failWrites = true;
    expect(await uploader.flush(true)).toBe("STORAGE_WRITE_FAILED");
    expect(uploader.nextAttemptAt()).toBe(now() + UPLOAD_BACKOFF_MS[0]);
  });

  // A lock, not a fix: `send`'s own guard already covered this path. It is here because N2's rule is
  // "enqueue rejects for its own save and for nothing else", and this is the other half of that rule.
  it("enqueue resolves when the flush it triggers cannot empty the outbox", async () => {
    const {fs, session, make} = await setup(false);
    const first = make();
    await first.enqueue(item("a"));                 // owner null: built while signed out
    await session.signIn("sardor", "correct");

    const second = make();
    await second.load();
    let writes = 0;
    const realWrite = fs.writeAtomic;
    fs.writeAtomic = async (path, data) => {
      if (path === "/d/outbox.bin") { writes += 1; if (writes >= 2) throw new Error("ENOSPC"); }
      return realWrite(path, data);
    };
    // enqueue's OWN save is the first write and succeeds; the save inside the flush it triggers is
    // refused. That is the flush's outcome to report, not the caller's to catch.
    await expect(second.enqueue(item("b"))).resolves.toBeUndefined();
    expect(second.waiting()).toHaveLength(2);
  });

  it("logs each sent item exactly once, even when the outbox save after a send fails", async () => {
    const {fs, sentLog, make, advance} = await setup();
    let writes = 0;
    const realWrite = fs.writeAtomic;
    fs.writeAtomic = async (path, data) => {
      // Write 1 is enqueue's own save; write 2 is the save that empties the outbox after the send.
      if (path === "/d/outbox.bin") { writes += 1; if (writes === 2) throw new Error("ENOSPC"); }
      return realWrite(path, data);
    };
    const uploader = make();
    await uploader.enqueue(item("a"));
    expect(sentLog.list("user:sardor")).toHaveLength(1);   // logged as sent: the server did accept it
    expect(uploader.waiting()).toHaveLength(1);    // but the outbox could not be emptied

    advance(UPLOAD_BACKOFF_MS[0]);
    expect(await uploader.flush(true)).toBe("sent");
    expect(uploader.waiting()).toEqual([]);
    expect(sentLog.list("user:sardor")).toHaveLength(1);   // re-sent, but never logged twice
  });

  it("an item enqueued during an in-flight flush is tried as soon as that flush settles", async () => {
    const {api, make} = await setup();
    const uploader = make();
    let releaseSubmit!: () => void;
    const real = api.submitEvidence;
    api.submitEvidence = async (s, items) => {
      api.submitEvidence = real;                   // only the first call is held
      await new Promise<void>((resolve) => { releaseSubmit = resolve; });
      return real(s, items);
    };

    const first = uploader.enqueue(item("a"));
    await tick();                                  // parked inside the first submit
    const second = uploader.enqueue(item("b"));    // lands while that flush is in flight
    await tick();
    releaseSubmit();
    await first; await second;

    expect(api.submitted.map((batch) => batch.map((i) => i.clientItemId))).toEqual([["a"], ["b"]]);
    expect(uploader.waiting()).toEqual([]);
  });

  it("never submits one user's batch under another who signed in while the request was out", async () => {
    const {api, session, make} = await setup();            // signed in as sardor
    const uploader = make();

    const submittedUnder: string[] = [];
    let refuseFirst!: () => void;
    let calls = 0;
    const real = api.submitEvidence;
    api.submitEvidence = async (s, items) => {
      calls += 1;
      submittedUnder.push(s.userId);
      if (calls === 1) {
        // A's request is still out when B signs in, and only then is A's token refused.
        await new Promise<void>((resolve) => { refuseFirst = resolve; });
        throw new ApiError("UNAUTHORISED");
      }
      return real(s, items);
    };

    const enqueuing = uploader.enqueue(item("a"));
    await tick();                                          // parked inside A's submit
    await session.signOut();
    await session.signIn("someone-else", "correct");
    refuseFirst();
    await expect(enqueuing).resolves.toBeUndefined();

    expect(submittedUnder).toEqual(["user:sardor"]);        // tried once, as A, and never again as B
    expect(api.submitted).toEqual([]);                      // the server accepted nothing
    expect(uploader.waiting()).toEqual([]);                 // not B's to see
    expect(uploader.nextAttemptAt()).not.toBeNull();        // but still stored, for A

    await session.signOut();
    await session.signIn("sardor", "correct");              // A comes back to their own statement
    expect(uploader.waiting().map((i) => i.clientItemId)).toEqual(["a"]);
    expect(await uploader.flush(true)).toBe("sent");
    expect(api.submitted).toEqual([[item("a")]]);           // the server sees it exactly once
  });

  it("hides the outbox from a signed-out screen and from another user, without discarding it", async () => {
    const {api, session, make} = await setup();
    const uploader = make();
    api.failWith = "OFFLINE";
    await uploader.enqueue(item("a"));
    api.failWith = null;
    expect(uploader.waiting()).toHaveLength(1);
    expect(uploader.waitingCount()).toBe(1);

    await session.signOut();
    expect(uploader.waiting()).toEqual([]);
    expect(uploader.waitingCount()).toBe(0);

    await session.signIn("someone-else", "correct");   // deliberately no adoptOwner call
    expect(uploader.waiting()).toEqual([]);
    expect(uploader.waitingCount()).toBe(0);

    await session.signOut();
    await session.signIn("sardor", "correct");         // the owner is back
    expect(uploader.waiting().map((i) => i.clientItemId)).toEqual(["a"]);
    expect(uploader.waitingCount()).toBe(1);
  });
});

describe("sent log", () => {
  // Adapted for E1 on purpose: every entry now carries its owner and `list` is asked whose log to show.
  it("is plain JSON on disk and survives a restart", async () => {
    const fs = createMemFs();
    const log = createSentLog({fs, path: "/d/sent-log.json"});
    await log.add([item("a")], 5, "user:a");
    expect(fs.text("/d/sent-log.json")).toContain("Traced a latency regression");
    const again = createSentLog({fs, path: "/d/sent-log.json"});
    await again.load();
    expect(again.list("user:a")).toEqual([{sentAt: 5, item: item("a"), ownerUserId: "user:a"}]);
  });

  it("shows one account's entries to nobody else, and nothing at all while signed out", async () => {
    const fs = createMemFs();
    const log = createSentLog({fs, path: "/d/sent-log.json"});
    await log.add([item("a")], 5, "user:a");
    await log.add([item("b")], 6, "user:b");
    expect(log.list("user:a").map((e) => e.item.clientItemId)).toEqual(["a"]);
    expect(log.list("user:b").map((e) => e.item.clientItemId)).toEqual(["b"]);
    expect(log.list(null)).toEqual([]);

    const again = createSentLog({fs, path: "/d/sent-log.json"});
    await again.load();
    expect(again.list("user:a").map((e) => e.item.clientItemId)).toEqual(["a"]);
    expect(again.list(null)).toEqual([]);
  });

  it("de-dupes per account: the same item sent by two accounts is logged for each of them", async () => {
    const fs = createMemFs();
    const log = createSentLog({fs, path: "/d/sent-log.json"});
    await log.add([item("a")], 5, "user:a");
    await log.add([item("a")], 6, "user:a");
    expect(log.list("user:a")).toHaveLength(1);
    await log.add([item("a")], 7, "user:b");
    expect(log.list("user:b")).toHaveLength(1);
    expect(log.list("user:a")).toHaveLength(1);
  });

  it("drops entries from a version that stored them without an owner, and keeps the rest", async () => {
    const fs = createMemFs();
    const legacy = [{sentAt: 1, item: item("legacy")}, {sentAt: 2, item: item("owned"), ownerUserId: "user:a"}];
    fs.files.set("/d/sent-log.json", new TextEncoder().encode(JSON.stringify(legacy)));
    const log = createSentLog({fs, path: "/d/sent-log.json"});
    await log.load();
    expect(log.list("user:a").map((e) => e.item.clientItemId)).toEqual(["owned"]);
    // Nobody inherits the ownerless entry: it is gone from memory, and from the file at the next write.
    await log.add([item("next")], 3, "user:a");
    expect(fs.text("/d/sent-log.json")).not.toContain("legacy");
  });
});

describe("pool store", () => {
  const config = {exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "tax-1", skills: [], competencies: [], userNames: []};
  const pipelineAt = (now: number) => createPipeline(config, {model: createFakeModel([]), clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => "id"});
  const pending = {id: "p1", kind: "skill", targetId: "pg", statement: "Traced a latency regression to a missing index and rebuilt it without blocking writes.", createdAt: 1_000, taxonomyVersion: "tax-1", pipelineVersion: "1"};

  it("saves the pipeline's pool encrypted and restores it through the core's own validation", async () => {
    const fs = createMemFs();
    const store = createPoolStore({fs, cipher: createFakeCipher(), path: "/d/pool.bin"});
    const first = pipelineAt(2_000);
    expect(first.importPool([pending, {id: "junk"}])).toEqual({accepted: 1, rejected: 1});
    await store.save(first, "user:a");
    expect(fs.everything()).not.toContain("latency");

    const second = pipelineAt(3_000);
    expect(await store.restore(second, "user:a")).toEqual({accepted: 1, rejected: 0, ownerUserId: "user:a"});
    expect(second.exportPool()).toHaveLength(1);
  });

  it("restores nothing when there is no file or it is unreadable", async () => {
    const fs = createMemFs();
    const store = createPoolStore({fs, cipher: createFakeCipher(), path: "/d/pool.bin"});
    expect(await store.restore(pipelineAt(1), "user:a")).toEqual({accepted: 0, rejected: 0, ownerUserId: "user:a"});
    fs.files.set("/d/pool.bin", new TextEncoder().encode("garbage"));
    expect(await store.restore(pipelineAt(1), "user:a")).toEqual({accepted: 0, rejected: 0, ownerUserId: "user:a"});
    expect(fs.files.has("/d/pool.bin")).toBe(false);
  });

  it("gives one user's pool to nobody else, and discards it rather than leaving it behind", async () => {
    const fs = createMemFs();
    const store = createPoolStore({fs, cipher: createFakeCipher(), path: "/d/pool.bin"});
    const mine = pipelineAt(2_000);
    mine.importPool([pending]);
    await store.save(mine, "user:a");

    const theirs = pipelineAt(3_000);
    expect(await store.restore(theirs, "user:b")).toEqual({accepted: 0, rejected: 0, ownerUserId: "user:b"});
    expect(theirs.exportPool()).toEqual([]);
    expect(fs.files.has("/d/pool.bin")).toBe(false);
  });

  it("restores a pool while nobody is signed in, and says whose it is", async () => {
    const fs = createMemFs();
    const store = createPoolStore({fs, cipher: createFakeCipher(), path: "/d/pool.bin"});
    const mine = pipelineAt(2_000);
    mine.importPool([pending]);
    await store.save(mine, "user:a");

    const later = pipelineAt(3_000);
    expect(await store.restore(later, null)).toEqual({accepted: 1, rejected: 0, ownerUserId: "user:a"});
    expect(fs.files.has("/d/pool.bin")).toBe(true);        // kept for its owner's return
  });

  it("discards a file from a version that stored the items without an owner", async () => {
    const fs = createMemFs();
    const cipher = createFakeCipher();
    const unreadable = vi.fn();
    const store = createPoolStore({fs, cipher, path: "/d/pool.bin", onUnreadable: unreadable});
    fs.files.set("/d/pool.bin", cipher.encrypt(JSON.stringify([pending])));
    const pipeline = pipelineAt(1);
    expect(await store.restore(pipeline, "user:a")).toEqual({accepted: 0, rejected: 0, ownerUserId: "user:a"});
    expect(pipeline.exportPool()).toEqual([]);
    expect(fs.files.has("/d/pool.bin")).toBe(false);
    expect(unreadable).toHaveBeenCalledTimes(1);
  });
});
