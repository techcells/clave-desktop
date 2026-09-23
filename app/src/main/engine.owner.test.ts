import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "../core/index";
import {DEFAULT_REVIEW_TIME, PIPELINE_TICK_MS} from "./constants";
import type {Blocker, Engine} from "./engine";
import {createHarness, type Harness} from "./testing/harness";

const GATE_YES = {activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true};
const SELF_TEST = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

async function ready(h: Harness, user = "sardor"): Promise<Engine> {
  const engine = await h.launch();
  await engine.signIn(user, "correct");
  h.client.script.push(GATE_YES, SELF_TEST);
  expect(await engine.selfTest()).toEqual({ok: true, timeScale: 1});
  return engine;
}
const stored = (h: Harness) => JSON.parse(h.fs.text("/data/settings.json") as string) as {ownerUserId: string | null; excludedSites: string[]; captureOn: boolean};
/** Every status frame the engine emitted, so a blocker that flashes for one turn is still caught. */
function collectBlockers(engine: Engine): Blocker[][] {
  const seen: Blocker[][] = [];
  engine.onStatus((s) => { seen.push(s.blockers); });
  return seen;
}
const logCodes = (h: Harness) => (h.fs.text("/data/app.log") ?? "").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as {code: string}).code);

describe("engine: settings belong to one account", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("stamps the settings with the first account that signs in", async () => {
    const h = createHarness();
    const engine = await ready(h);
    expect(stored(h).ownerUserId).toBe("user:sardor");
    await engine.quit();
  });

  it("another account never inherits exclusions or the capture switch, even when the pool file is gone", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15"});
    await first.setCapture(true);
    await first.quit();
    await h.fs.remove("/data/pool.bin");                 // what a corrupt pool file, deleted by design, leaves behind
    await h.fs.remove("/data/session.bin");              // signed out at the next launch

    const second = await h.launch();
    await second.signIn("bea", "correct");
    expect(second.settings().excludedSites).not.toContain("bank.example");
    expect(second.settings().reviewTime).toBe("17:30");
    expect(second.settings().captureOn).toBe(false);
    expect(second.status().capture).toBe("off");
    expect(stored(h).ownerUserId).toBe("user:bea");
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 5);
    expect(h.reader.reads).toBe(reads);
    await second.quit();
  });

  it("also at launch: a stored session of another account than the settings' owner resets them before anything is read", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.quit();
    const settings = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify({...settings, ownerUserId: "user:someone-before"})));

    const reads = h.reader.reads;
    const second = await h.launch();
    expect(second.settings().excludedSites).not.toContain("bank.example");
    expect(second.status().capture).toBe("off");
    expect(h.reader.reads).toBe(reads);
    await second.quit();
  });

  it("the same account keeps its settings across sign-out, sign-in and a restart", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.signOut();
    await first.signIn("sardor", "correct");
    expect(first.settings().excludedSites).toContain("bank.example");
    await first.quit();
    const second = await h.launch();
    expect(second.settings().excludedSites).toContain("bank.example");
    await second.quit();
  });

  it("a reset that the disk refuses blocks capture, is retried on the tick, and clears by itself", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.signOut();

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let settingsBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (settingsBroken && path.endsWith("settings.json")) throw new Error("EIO"); return realWrite(path, data); };
    await first.signIn("bea", "correct");
    expect(first.status().blockers).toContain("STORAGE_PROBLEM");
    expect(first.status().capture).toBe("off");
    expect(await first.setCapture(true)).toMatchObject({ok: false});

    settingsBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(first.status().blockers).not.toContain("STORAGE_PROBLEM");
    expect(first.settings().excludedSites).not.toContain("bank.example");
    expect(stored(h).ownerUserId).toBe("user:bea");
    expect(first.status().capture).toBe("off");          // and capture does not start by itself for the new account
    await first.quit();
  });

  // Adapted for E2 on purpose: adoption keeps the choices but never the switch or the prompt day,
  // because nobody can say which account agreed to have their screen read.
  it("stops blocking on a refused reset once nobody is signed in: nothing is read while signed out", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.signOut();

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let settingsBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (settingsBroken && path.endsWith("settings.json")) throw new Error("EIO"); return realWrite(path, data); };
    await first.signIn("bea", "correct");
    expect(first.status().blockers).toContain("STORAGE_PROBLEM");

    await first.signOut();
    settingsBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    // Nobody is signed in, so nothing may be read under anybody's choices anyway: the storage
    // problem has nothing left to protect, and must not outlive the account that raised it.
    expect(first.status().blockers).not.toContain("STORAGE_PROBLEM");
    expect(first.status().blockers).toContain("SIGNED_OUT");
    expect(first.status().capture).toBe("off");
    await first.quit();
  });

  it("never shows another account's choices while the reset has not reached the disk", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15"});
    await first.setCapture(true);
    await first.signOut();

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let settingsBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (settingsBroken && path.endsWith("settings.json")) throw new Error("EIO"); return realWrite(path, data); };
    await first.signIn("bea", "correct");
    expect(first.status().blockers).toContain("STORAGE_PROBLEM");
    // The file on disk still says A, so what it says is nobody's to see: B gets the defaults.
    expect(first.settings().excludedSites).not.toContain("bank.example");
    expect(first.settings().excludedSites).toEqual(DEFAULT_EXCLUDED_SITES);
    expect(first.settings().exclusions).toEqual(DEFAULT_EXCLUSIONS);
    expect(first.settings().reviewTime).toBe(DEFAULT_REVIEW_TIME);
    expect(first.settings().captureOn).toBe(false);

    settingsBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(first.settings().excludedSites).toEqual(DEFAULT_EXCLUDED_SITES);
    expect(first.settings().reviewTime).toBe(DEFAULT_REVIEW_TIME);
    await first.quit();
  });

  it("an old settings file without an owner is adopted, but never with capture on", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15"});
    await first.setCapture(true);
    await first.quit();
    const {ownerUserId: _dropped, ...legacy} = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify({...legacy, captureOn: true, lastPromptDay: "2026-09-20"})));

    const reads = h.reader.reads;
    const second = await h.launch();
    expect(second.settings().excludedSites).toContain("bank.example");
    expect(second.settings().reviewTime).toBe("08:15");
    expect(second.settings().captureOn).toBe(false);
    // The prompt day was cleared on adoption, so today's review moment (08:15, already past) was
    // caught up instead of being silently swallowed by a day nobody's account had handled.
    expect(second.settings().lastPromptDay).toBe("2026-09-17");
    expect(second.status().capture).toBe("off");
    expect(second.status().blockers).not.toContain("SETTINGS_NEED_REVIEW");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(stored(h).ownerUserId).toBe("user:sardor");
    expect(stored(h).captureOn).toBe(false);
    expect(h.reader.reads).toBe(reads);
    expect(h.resumedNotices).toBe(0);
    await second.quit();
  });

  // G1: the stamp not being on disk YET is not a storage problem. A healthy machine must never tell
  // an ordinary user that their disk is refusing writes, whichever account signs in.
  it("says nothing about storage on a healthy machine, on a first sign-in or another account's", async () => {
    const h = createHarness();
    const engine = await h.launch();
    const seen = collectBlockers(engine);
    await engine.signIn("sardor", "correct");             // the file names nobody yet: the first stamp
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    await engine.signOut();
    await engine.signIn("bea", "correct");                // a different account: the reset
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(seen.length).toBeGreaterThan(2);
    for (const blockers of seen) expect(blockers).not.toContain("STORAGE_PROBLEM");
    expect(stored(h).ownerUserId).toBe("user:bea");
    await engine.quit();
  });

  // And the gate that replaces the blocker still holds capture off for the whole owner-pending turn.
  it("never reads under a switch the previous account left on, and does not call that a storage problem", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.setCapture(true);
    expect(first.status().capture).toBe("on");
    await first.signOut();

    const seen = collectBlockers(first);
    const reads = h.reader.reads;
    await first.signIn("bea", "correct");
    expect(first.status().capture).toBe("off");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 3);
    expect(h.reader.reads).toBe(reads);
    for (const blockers of seen) expect(blockers).not.toContain("STORAGE_PROBLEM");
    // The stamp is on disk now, so bea may switch it on for herself — and then it really does read.
    expect(await first.setCapture(true)).toMatchObject({ok: true});
    expect(first.status().capture).toBe("on");
    await first.quit();
  });

  // G2: an ownerless file's choices are nobody's secret, but nobody can say who agreed to have their
  // screen read either, so the SWITCH is answered false until the stamp is on disk.
  it("answers captureOn false while an adoption write is refused, and keeps the choices", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15"});
    await first.setCapture(true);
    await first.quit();
    const {ownerUserId: _dropped, ...legacy} = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify({...legacy, captureOn: true})));
    await h.fs.remove("/data/session.bin");               // signed out at the next launch

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    h.fs.writeAtomic = async (path, data) => { if (path.endsWith("settings.json")) throw new Error("EIO"); return realWrite(path, data); };
    const second = await h.launch();
    await second.signIn("bea", "correct");
    expect(second.settings().captureOn).toBe(false);
    expect(second.settings().excludedSites).toContain("bank.example");   // ownerless: not another account's to hide
    expect(second.settings().reviewTime).toBe("08:15");
    expect(second.status().capture).toBe("off");
    await second.quit();
  });

  it("adopts an ownerless file for whoever signs in next, with capture off and nothing read", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.quit();
    const {ownerUserId: _dropped, ...legacy} = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify({...legacy, captureOn: true})));
    await h.fs.remove("/data/session.bin");               // signed out at the next launch

    const reads = h.reader.reads;
    const second = await h.launch();
    await second.signIn("bea", "correct");
    expect(second.settings().captureOn).toBe(false);
    expect(second.status().capture).toBe("off");
    expect(stored(h).ownerUserId).toBe("user:bea");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 5);
    expect(h.reader.reads).toBe(reads);
    await second.quit();
  });
});

describe("engine: storage problems are tracked per file", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("a write that works again clears only its own file's problem", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const realWrite = h.fs.writeAtomic.bind(h.fs);
    const broken = new Set(["pool.bin", "outbox.bin"]);
    const realRemove = h.fs.remove.bind(h.fs);
    const refused = (path: string) => [...broken].some((name) => path.endsWith(name));
    h.fs.writeAtomic = async (path, data) => { if (refused(path)) throw new Error("EIO"); return realWrite(path, data); };
    h.fs.remove = async (path) => { if (refused(path)) throw new Error("EIO"); return realRemove(path); };
    await engine.signOut();
    await engine.signIn("bea", "correct");                // a new owner: the old pool must go and the outbox be rewritten, both refused
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");

    broken.delete("outbox.bin");                          // the outbox recovers, the pool does not
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 3);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");

    broken.delete("pool.bin");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });

  it("probes a refused pool write again even when the pool is back to what the file already holds", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "pg", statement: "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table."}]});
    await engine.setCapture(true);

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let poolBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (poolBroken && path.endsWith("pool.bin")) throw new Error("EIO"); return realWrite(path, data); };

    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.review().pending).toHaveLength(1);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");

    // Rejecting puts the pool back to exactly what the file on disk already holds. The blocker must
    // still be probed, or it would stand for the rest of the session with nothing left to write.
    expect(await engine.reject(engine.review().pending[0]!.id)).toBe(true);
    poolBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });

  it("an outbox write that failed once is probed again on the tick, so the blocker cannot stick", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let outboxBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (outboxBroken && path.endsWith("outbox.bin")) throw new Error("EIO"); return realWrite(path, data); };
    await engine.signOut();
    await engine.signIn("sardor", "correct");             // adoptOwner writes the outbox: refused
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    outboxBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });
});

describe("engine: the sent log belongs to one account", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows what A uploaded to A alone, before and after a relaunch", async () => {
    const h = createHarness();
    const first = await ready(h);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "pg", statement: "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table."}]});
    await first.setCapture(true);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    first.system("locked");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * PIPELINE_TICK_MS);
    first.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(await first.approve(first.review().pending[0]!.id)).toBe(true);
    expect(first.review().sent).toHaveLength(1);

    // B signs in on the same machine: A's statement is not B's to read.
    await first.signOut();
    expect(first.review().sent).toEqual([]);
    await first.signIn("bea", "correct");
    expect(first.review().sent).toEqual([]);

    // A comes back, in this process and after a relaunch: their own record is still there.
    await first.signOut();
    await first.signIn("sardor", "correct");
    expect(first.review().sent).toHaveLength(1);
    await first.quit();

    const second = await h.launch();
    expect(second.review().sent).toHaveLength(1);        // A's session was restored, so A's record is there
    await second.signOut();
    expect(second.review().sent).toEqual([]);            // nobody signed in: nothing to show anyone
    await second.signIn("bea", "correct");
    expect(second.review().sent).toEqual([]);
    await second.signOut();
    await second.signIn("sardor", "correct");
    expect(second.review().sent).toHaveLength(1);
    await second.quit();
  });
});

describe("engine: a discarded outbox is said out loud", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("logs OUTBOX_DISCARDED with the count when another account signs in over unsent statements", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "pg", statement: "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table."}]});
    await engine.setCapture(true);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    h.api.failWith = "OFFLINE";
    expect(await engine.approve(engine.review().pending[0]!.id)).toBe(true);
    await engine.signOut();
    h.api.failWith = null;
    await engine.signIn("bea", "correct");
    expect(logCodes(h)).toContain("OUTBOX_DISCARDED");
    expect(h.api.submitted).toEqual([]);
    await engine.quit();
  });

  it("logs UPLOAD_REJECTED with the count when the server refuses an approved statement for good, and never shows it as sent", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "pg", statement: "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table."}]});
    await engine.setCapture(true);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    h.api.submitEvidence = async (_s, items) => ({accepted: [], rejected: items.map((i) => i.clientItemId)});
    expect(await engine.approve(engine.review().pending[0]!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(logCodes(h)).toContain("UPLOAD_REJECTED");
    expect((h.fs.text("/data/app.log") ?? "")).toContain('"code":"UPLOAD_REJECTED","counts":{"count":1}');
    expect(engine.review().sent).toEqual([]);
    expect(engine.review().waitingUpload).toEqual([]);
    expect(h.fs.text("/data/app.log")).not.toContain("Traced a slow report");
    await engine.quit();
  });

  it("signs in through the browser: the exchange, the names, the skill list and the log codes, never the attempt id", async () => {
    const h = createHarness();
    let started = 0;
    const engine = await h.launch({googleSignIn: {
      start: async (exchange) => { started += 1; return exchange("attempt-ok", "the-verifier"); },
      cancel: () => undefined
    }});
    expect(await engine.signInWithGoogle()).toEqual({ok: true});
    expect(started).toBe(1);
    expect(h.api.calls).toEqual(["exchangeOAuthAttempt", "profile", "taxonomy"]);
    expect(h.api.verifiers).toEqual(["the-verifier"]);
    expect(engine.status().blockers).not.toContain("SIGNED_OUT");
    expect(engine.status().blockers).not.toContain("NO_TAXONOMY");
    expect(logCodes(h)).toEqual(expect.arrayContaining(["SIGN_IN_GOOGLE_STARTED", "SIGN_IN_GOOGLE_FINISHED"]));
    expect(h.fs.everything()).not.toContain("attempt-ok");
    await engine.quit();
  });

  it("a refused browser sign-in leaves the user signed out and says so in the log's count", async () => {
    const h = createHarness();
    const engine = await h.launch({googleSignIn: {start: async (exchange) => exchange("attempt-bad", "the-verifier"), cancel: () => undefined}});
    expect(await engine.signInWithGoogle()).toEqual({ok: false, code: "UNAUTHORISED"});
    expect(engine.status().blockers).toContain("SIGNED_OUT");
    expect(h.fs.text("/data/app.log")).toContain('"code":"SIGN_IN_GOOGLE_FINISHED","counts":{"failures":1}');
    await engine.quit();
  });

  it("without a browser sign-in in the build, asking for one answers OAUTH_BROWSER and cancelling is harmless", async () => {
    const h = createHarness();
    const engine = await h.launch();
    expect(await engine.signInWithGoogle()).toEqual({ok: false, code: "OAUTH_BROWSER"});
    engine.cancelGoogleSignIn();
    expect(h.api.calls).toEqual([]);
    await engine.quit();
  });

  it("cancel reaches the sign-in in flight", async () => {
    const h = createHarness();
    let cancelled = 0;
    const engine = await h.launch({googleSignIn: {start: async () => ({ok: false, code: "OAUTH_TIMEOUT"}), cancel: () => { cancelled += 1; }}});
    expect(await engine.signInWithGoogle()).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    engine.cancelGoogleSignIn();
    expect(cancelled).toBe(1);
    await engine.quit();
  });

  it("quitting cancels a browser sign-in in flight, and a sign-in landing after quit runs none of the after-steps", async () => {
    const h = createHarness();
    let release: ((r: {ok: true}) => void) | null = null;
    let cancelled = 0;
    const engine = await h.launch({googleSignIn: {
      start: async (exchange) => { await new Promise<{ok: true}>((r) => { release = r; }); return exchange("attempt-ok", "the-verifier"); },
      cancel: () => { cancelled += 1; }
    }});
    const pending = engine.signInWithGoogle();
    await vi.advanceTimersByTimeAsync(0);
    await engine.quit();
    expect(cancelled).toBe(1);
    release!({ok: true});
    expect(await pending).toEqual({ok: true});
    expect(h.api.calls).not.toContain("taxonomy");
  });

  it("renews the token on the minute tick while the app runs, so a long day never ends signed out", async () => {
    const h = createHarness();
    // A token good for 25 hours: due once under a day AND under half its life (12.5 h) remains, which the minute tick reaches after 12.5 hours.
    const realSignIn = h.api.signIn.bind(h.api);
    h.api.signIn = async (id, pw) => ({...(await realSignIn(id, pw)), expiresAt: Date.now() + 25 * 60 * 60_000});
    const engine = await ready(h);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    expect(h.api.calls.filter((c) => c === "refresh")).toEqual([]);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(h.api.calls.filter((c) => c === "refresh")).toEqual(["refresh"]);
    expect(engine.status().blockers).not.toContain("SIGNED_OUT");
    await engine.quit();
  });
});
