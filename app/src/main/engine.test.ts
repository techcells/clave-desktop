import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SCENARIO_IDLE_MS} from "../core/constants";
import {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "../core/index";
import {createDevReader} from "../standins/devReader";
import {createReadyDownloader} from "../standins/readyDownloader";
import {DEFAULT_REVIEW_TIME, PAUSE_FOR_MS, PIPELINE_TICK_MS, SCHEDULER_CHECK_MS, TAXONOMY_RETRY_MS, UPLOAD_BACKOFF_MS} from "./constants";
import type {Engine, EngineDeps, UserSettingsPatch} from "./engine";
import {selfTestKey} from "./model/selfTest";
import type {FileSystem} from "./ports/system";
import {createHarness, type Harness} from "./testing/harness";

/** The codes in `app.log`, in order. The log holds nothing else a test could look at. */
const logCodes = (h: Harness): string[] =>
  (h.fs.text("/data/app.log") ?? "").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as {code: string}).code);

const GATE_YES = {activity_summary: "Tuned a slow query.", is_professional: true, user_demonstrated_something: true};
const STATEMENT = "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table.";
const ANSWER = {evidence: [{target_id: "pg", statement: STATEMENT}]};
const WORK = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);

/**
 * The same fake disk, with every write held open until it is released. It is the only way to keep a
 * decision genuinely in flight — inside the encrypted outbox write — long enough for a second
 * decision on the same statement to arrive, which is exactly the race a double click produces.
 */
function heldWrites(fs: FileSystem): FileSystem & {hold(): void; release(): void} {
  let holding = false;
  const waiting: Array<() => void> = [];
  return {
    read: (path) => fs.read(path),
    async writeAtomic(path, data) {
      if (holding) await new Promise<void>((resolve) => { waiting.push(resolve); });
      return fs.writeAtomic(path, data);
    },
    append: (path, data) => fs.append(path, data),
    size: (path) => fs.size(path),
    remove: (path) => fs.remove(path),
    hold() { holding = true; },
    release() { holding = false; for (const resolve of waiting.splice(0)) resolve(); }
  };
}

/** Signed in, model verified, permission granted: everything capture needs. */
async function ready(h: Harness, overrides: Partial<EngineDeps> = {}): Promise<Engine> {
  const engine = await h.launch(overrides);
  await engine.signIn("sardor", "correct");
  h.client.script.push({activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true},
    {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]});
  expect(await engine.selfTest()).toEqual({ok: true});
  return engine;
}

/** One stretch of work: the text is on screen, then the user walks away long enough for the scenario to close. */
async function workThenLeave(h: Harness, engine: Engine): Promise<void> {
  h.reader.front = {app: "Code", title: "report.sql"};
  h.reader.text = WORK;
  await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
  engine.system("locked");
  await vi.advanceTimersByTimeAsync(SCENARIO_IDLE_MS + 2 * PIPELINE_TICK_MS);
  engine.system("unlocked");
  await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
}

describe("engine", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("a fresh install is off and says exactly what is missing", async () => {
    const h = createHarness();
    h.downloader.set({kind: "missing"});
    h.reader.permissionValue = "denied";
    const engine = await h.launch();
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]});
    expect(await engine.setCapture(true)).toEqual({ok: false, blockers: ["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]});
    expect(h.reader.reads).toBe(0);
    await engine.quit();
  });

  it("walks through the blockers one by one; capture stays off until the user switches it on", async () => {
    const h = createHarness();
    h.downloader.set({kind: "missing"});
    h.reader.permissionValue = "needsRestart";
    const engine = await h.launch();
    await engine.signIn("sardor", "correct");
    expect(engine.status().blockers).toEqual(["MODEL_MISSING", "PERMISSION_NEEDS_RESTART"]);
    h.downloader.set({kind: "ready"});
    expect(engine.status().blockers).toEqual(["SELF_TEST_NEEDED", "PERMISSION_NEEDS_RESTART"]);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "self-test-postgres", statement: STATEMENT}]});
    await engine.selfTest();
    h.reader.permissionValue = "granted";
    expect(await engine.recheckPermission()).toBe("granted");
    expect(engine.status()).toMatchObject({capture: "off", blockers: []});
    expect(h.reader.reads).toBe(0);
    expect(await engine.setCapture(true)).toEqual({ok: true});
    expect(engine.status().capture).toBe("on");
    await engine.quit();
  });

  it("turns a stretch of work into a statement, shows it with the skill's name, uploads it on approval, and logs what was sent", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);

    const {pending} = engine.review();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({statement: STATEMENT, targetId: "pg", targetName: "PostgreSQL"});
    expect(h.api.submitted).toEqual([]);                       // nothing leaves before approval

    expect(await engine.approve(pending[0]!.id)).toBe(true);
    expect(h.api.submitted).toHaveLength(1);
    expect(h.api.submitted[0]![0]).toMatchObject({clientItemId: pending[0]!.id, statement: STATEMENT, targetId: "pg", taxonomyVersion: "tax-1"});
    expect(engine.review()).toMatchObject({pending: [], waitingUpload: []});
    expect(engine.review().sent).toHaveLength(1);
    expect(await engine.approve(pending[0]!.id)).toBe(false);
    await engine.quit();
  });

  it("rejecting removes the statement for good and uploads nothing", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;
    expect(await engine.reject(id)).toBe(true);
    expect(engine.review().pending).toEqual([]);
    expect(h.api.submitted).toEqual([]);
    await engine.quit();
  });

  it("refuses a reject while an approve of the same statement is still in flight, and never resurrects it", async () => {
    const h = createHarness();
    const disk = heldWrites(h.fs);
    const engine = await ready(h, {fs: disk});
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;

    disk.hold();                                        // the outbox write will not finish yet
    const approving = engine.approve(id);
    expect(await engine.reject(id)).toBe(false);         // one statement, one decision
    disk.release();
    expect(await approving).toBe(true);

    expect(h.api.submitted).toHaveLength(1);
    expect(engine.review().pending).toEqual([]);
    expect(engine.review().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * PIPELINE_TICK_MS);
    expect(engine.review().pending).toEqual([]);        // the refused reject brought nothing back
    expect(h.api.submitted).toHaveLength(1);            // and nothing went out twice
    await engine.quit();
  });

  it("answers exactly one of two approves of the same statement and uploads it once", async () => {
    const h = createHarness();
    const disk = heldWrites(h.fs);
    const engine = await ready(h, {fs: disk});
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;

    disk.hold();
    const first = engine.approve(id);
    const second = engine.approve(id);
    disk.release();
    expect((await Promise.all([first, second])).filter((ok) => ok)).toEqual([true]);
    expect(h.api.submitted).toHaveLength(1);
    expect(engine.review().sent).toHaveLength(1);
    expect(engine.review().pending).toEqual([]);
    await engine.quit();
  });

  it("frees a statement for another decision once one has settled, whatever the answer was", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;

    // A false because the statement is nobody's to decide while nobody is signed in.
    await engine.signOut();
    expect(await engine.approve(id)).toBe(false);
    await engine.signIn("sardor", "correct");
    expect(engine.review().pending.map((p) => p.id)).toEqual([id]);

    // A false because the disk refused the outbox write.
    h.fs.failWrites = true;
    expect(await engine.approve(id)).toBe(false);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    h.fs.failWrites = false;

    // Neither false may leave the statement locked: this decision has to go through.
    expect(await engine.approve(id)).toBe(true);
    expect(h.api.submitted).toHaveLength(1);
    // And the lock is gone after a success too, so the next decision on it is refused for the one
    // honest reason — it is no longer in the list — and changes nothing.
    expect(await engine.reject(id)).toBe(false);
    expect(engine.review().pending).toEqual([]);
    expect(h.api.submitted).toHaveLength(1);
    await engine.quit();
  });

  it("keeps pending statements across a restart, encrypted, and resumes capture with one notice", async () => {
    const h = createHarness();
    const first = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await first.setCapture(true);
    await workThenLeave(h, first);
    await first.quit();
    expect(h.fs.everything()).not.toContain("Traced a slow report");

    const second = await h.launch();
    expect(second.review().pending).toHaveLength(1);
    expect(second.status().capture).toBe("on");
    expect(h.resumedNotices).toBe(1);
    await second.quit();
  });

  it("an approved statement waits, visibly, while offline and goes out later", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    h.api.failWith = "OFFLINE";
    await engine.approve(engine.review().pending[0]!.id);
    expect(engine.status().waitingUpload).toBe(1);
    h.api.failWith = null;
    await vi.advanceTimersByTimeAsync(60_000 + PIPELINE_TICK_MS);
    expect(engine.status().waitingUpload).toBe(0);
    expect(h.api.submitted).toHaveLength(1);
    await engine.quit();
  });

  it("hides a waiting upload from a signed-out screen without discarding it", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    h.api.failWith = "OFFLINE";
    await engine.approve(engine.review().pending[0]!.id);
    expect(engine.status().waitingUpload).toBe(1);
    expect(engine.review().waitingUpload).toHaveLength(1);

    h.api.failWith = null;
    await engine.signOut();
    // Nobody is signed in, so the previous user's approved statement is nobody's to see.
    expect(engine.status().waitingUpload).toBe(0);
    expect(engine.review().waitingUpload).toEqual([]);
    expect(h.api.submitted).toEqual([]);

    await engine.signIn("sardor", "correct");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(h.api.submitted).toHaveLength(1);        // hidden while it waited, never discarded
    await engine.quit();
  });

  it("switches capture off the moment a precondition disappears, and back on when it returns", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    await engine.signOut();
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["SIGNED_OUT"]});
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reader.reads).toBe(reads);
    await engine.signIn("sardor", "correct");
    expect(engine.status().capture).toBe("on");

    h.client.breakNow();
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["MODEL_PROBLEM"]});
    engine.retry("model");
    expect(engine.status().capture).toBe("on");
    await engine.quit();
  });

  it("a revoked permission is noticed on the next check and stops capture", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    h.reader.permissionValue = "denied";
    await engine.recheckPermission();
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["NO_PERMISSION"]});
    await engine.quit();
  });

  it("pause for an hour stops reading and comes back by itself; switching off cancels the pause", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    await engine.pauseForAnHour();
    expect(engine.status()).toMatchObject({capture: "pausedByUser", resumeAt: Date.now() + PAUSE_FOR_MS});
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(PAUSE_FOR_MS - 1);
    expect(h.reader.reads).toBe(reads);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.status().capture).toBe("on");

    await engine.pauseForAnHour();
    await engine.setCapture(false);
    await vi.advanceTimersByTimeAsync(PAUSE_FOR_MS);
    expect(engine.status()).toMatchObject({capture: "off", resumeAt: null});
    await engine.quit();
  });

  it("low battery pauses extraction, not capture, and the scenario is extracted after plugging in", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    h.power.set({onBattery: true, level: 0.1});
    expect(engine.status()).toMatchObject({capture: "on", extractionPaused: "lowBattery"});
    const opened = h.client.fake.opened;
    h.client.script.push(GATE_YES, ANSWER);
    await workThenLeave(h, engine);
    expect(h.client.fake.opened).toBe(opened);
    h.power.set({onBattery: false});
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().extractionPaused).toBeNull();
    expect(engine.review().pending).toHaveLength(1);
    await engine.quit();
  });

  it("prompts once at the review time, only when there is something to review", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await vi.advanceTimersByTimeAsync(9 * 60 * 60_000);          // 18:00, nothing pending
    expect(h.reviewPrompts).toEqual([]);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + SCHEDULER_CHECK_MS);
    expect(h.reviewPrompts).toEqual([1]);
    await engine.quit();
    // Thirty seconds, not the default five: this test runs 24 fake hours of 5 s capture polls plus a
    // day of scheduler ticks — tens of thousands of real awaited cycles — against a WALL-CLOCK
    // deadline. On a busy machine (load average 169 during the final review) it ran past 5 s and
    // failed, identically on the pre-plan code: a machine-speed failure, never a behaviour one. The
    // timeout is the only thing generous here; nothing about what the test asserts is relaxed.
  }, 30_000);

  it("holds a review moment that passes while nobody is signed in, and prompts once after signing in", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    expect(engine.review().pending).toHaveLength(1);

    await engine.signOut();
    const dayBefore = engine.settings().lastPromptDay;
    await vi.advanceTimersByTimeAsync(9 * 60 * 60_000);             // 09:00 -> 18:00, past 17:30
    expect(h.reviewPrompts).toEqual([]);                            // nobody to prompt
    expect(engine.settings().lastPromptDay).toBe(dayBefore);        // and the day is NOT used up

    await engine.signIn("sardor", "correct");
    await vi.advanceTimersByTimeAsync(SCHEDULER_CHECK_MS);
    expect(h.reviewPrompts).toEqual([1]);                           // the owner's own count, once
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);             // the rest of the evening
    expect(h.reviewPrompts).toEqual([1]);
    await engine.quit();
  });

  it("recovered settings keep capture off until the user has looked at Settings", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.setCapture(true);
    await first.quit();
    h.fs.files.set("/data/settings.json", new TextEncoder().encode("{broken"));
    const second = await h.launch();
    expect(second.status()).toMatchObject({capture: "off"});
    expect(second.status().blockers).toContain("SETTINGS_NEED_REVIEW");
    second.settingsOpened();
    expect(second.status().blockers).not.toContain("SETTINGS_NEED_REVIEW");
    await second.quit();
  });

  it("a full disk stops capture and loses nothing from memory", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    h.fs.failWrites = true;
    await workThenLeave(h, engine);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    expect(engine.status().capture).toBe("off");
    expect(engine.review().pending).toHaveLength(1);
    h.fs.failWrites = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });

  it("says so when the tick's upload cannot be written to disk, and clears it when the disk returns", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    h.api.failWith = "OFFLINE";
    expect(await engine.approve(engine.review().pending[0]!.id)).toBe(true);
    expect(engine.status().waitingUpload).toBe(1);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");

    // The server is back, but the disk now refuses the writes the send needs (the sent log and the
    // save that empties the outbox). A refused disk is the same problem however it was reached.
    h.api.failWith = null;
    h.fs.failWrites = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_BACKOFF_MS[0] + PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    expect(engine.status().capture).toBe("off");
    expect(engine.status().waitingUpload).toBe(1);                  // nothing was lost
    expect(engine.review().sent).toEqual([]);

    h.fs.failWrites = false;
    await vi.advanceTimersByTimeAsync(UPLOAD_BACKOFF_MS[1] + PIPELINE_TICK_MS);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    expect(engine.status().waitingUpload).toBe(0);
    expect(engine.review().sent).toHaveLength(1);
    await engine.quit();
  });

  it("delete all local data leaves nothing but the model, and signs out", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    await engine.deleteAllData({removeModel: false});
    expect([...h.fs.files.keys()]).toEqual([]);
    expect(engine.review()).toEqual({pending: [], waitingUpload: [], sent: []});
    expect(engine.status()).toMatchObject({capture: "off"});
    expect(engine.status().blockers).toContain("SIGNED_OUT");
    expect(h.downloader.state()).toEqual({kind: "ready"});
    await engine.deleteAllData({removeModel: true});
    expect(h.downloader.state()).toEqual({kind: "missing"});
    await engine.quit();
  });

  it("shows one user's pending statements to nobody else, and keeps them for that user's own return", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const mine = engine.review().pending[0]!.id;
    expect(h.fs.files.has("/data/pool.bin")).toBe(true);

    // Signed out there is no owner, so there is nothing to show and nothing to act on.
    await engine.signOut();
    expect(engine.review().pending).toEqual([]);
    expect(engine.status().pending).toBe(0);
    expect(await engine.approve(mine)).toBe(false);
    expect(await engine.reject(mine)).toBe(false);
    expect(h.api.submitted).toEqual([]);
    expect(h.fs.files.has("/data/pool.bin")).toBe(true);        // kept: the same user may come back

    await engine.signIn("sardor", "correct");
    expect(engine.review().pending.map((p) => p.id)).toEqual([mine]);

    // A different user: A's statements are neither shown, nor uploadable, nor left on disk.
    await engine.signOut();
    await engine.signIn("bea", "correct");
    expect(engine.review().pending).toEqual([]);
    expect(engine.status().pending).toBe(0);
    expect(await engine.approve(mine)).toBe(false);
    expect(h.api.submitted).toEqual([]);
    expect(h.fs.files.has("/data/pool.bin")).toBe(false);
    await engine.quit();
  });

  it("gives a new user the default settings, and a returning user their own back", async () => {
    const h = createHarness();
    const engine = await ready(h);
    expect(await engine.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15", onboardingStep: 3})).toEqual({ok: true});
    await engine.setCapture(true);
    const passed = engine.settings().selfTestPassedFor;
    expect(passed).not.toBeNull();

    // The same user signs out and comes back: nothing of theirs was touched.
    await engine.signOut();
    await engine.signIn("sardor", "correct");
    expect(engine.settings().excludedSites).toContain("bank.example");
    expect(engine.settings().reviewTime).toBe("08:15");
    expect(engine.settings().captureOn).toBe(true);
    expect(engine.status().capture).toBe("on");

    // A different user: what the previous user chose is theirs, not this machine's.
    await engine.signOut();
    await engine.signIn("bea", "correct");
    expect(engine.settings().excludedSites).not.toContain("bank.example");
    expect(engine.settings().excludedSites).toEqual(DEFAULT_EXCLUDED_SITES);
    expect(engine.settings().exclusions).toEqual(DEFAULT_EXCLUSIONS);
    expect(engine.settings().reviewTime).toBe(DEFAULT_REVIEW_TIME);
    expect(engine.settings().lastPromptDay).toBeNull();
    // Capture does not start by itself for somebody who never switched it on.
    expect(engine.settings().captureOn).toBe(false);
    expect(engine.status().capture).toBe("off");
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(10 * PIPELINE_TICK_MS);
    expect(h.reader.reads).toBe(reads);
    // Facts about this machine, not about a user: the self-test does not have to be run again.
    expect(engine.settings().selfTestPassedFor).toBe(passed);
    expect(engine.settings().onboardingStep).toBe(3);
    expect(engine.status().blockers).toEqual([]);
    await engine.quit();
  });

  it("does not restore a pool that belongs to another user after a relaunch", async () => {
    const h = createHarness();
    const first = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await first.setCapture(true);
    await workThenLeave(h, first);
    expect(first.review().pending).toHaveLength(1);
    await first.quit();
    expect(h.fs.files.has("/data/pool.bin")).toBe(true);

    h.writeSession("user:bea");                                 // B's machine now, A's pool still on disk
    const second = await h.launch();
    expect(second.review().pending).toEqual([]);
    expect(second.status().pending).toBe(0);
    expect(h.fs.files.has("/data/pool.bin")).toBe(false);
    await second.quit();
  });

  it("drops everything but the four settings a user may change, however the patch was typed", async () => {
    const h = createHarness();
    const engine = await h.launch();
    await engine.signIn("sardor", "correct");
    expect(engine.status().blockers).toEqual(["SELF_TEST_NEEDED"]);
    const dayBefore = engine.settings().lastPromptDay;
    // What a renderer that lies about its argument types could send over IPC.
    const forged = {
      reviewTime: "08:15", captureOn: true,
      selfTestPassedFor: selfTestKey("1.0.0", "sha"), lastPromptDay: "2026-09-17"
    } as unknown as UserSettingsPatch;

    expect(await engine.updateSettings(forged)).toEqual({ok: true});
    expect(engine.settings().reviewTime).toBe("08:15");           // the one key it was allowed to set
    expect(engine.settings().captureOn).toBe(false);
    expect(engine.settings().selfTestPassedFor).toBeNull();
    expect(engine.settings().lastPromptDay).toBe(dayBefore);
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["SELF_TEST_NEEDED"]});
    await engine.quit();
  });

  it("keeps a statement pending and says why when the outbox cannot be written", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;

    h.fs.failWrites = true;
    expect(await engine.approve(id)).toBe(false);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    expect(engine.status().capture).toBe("off");
    expect(engine.review().pending.map((p) => p.id)).toEqual([id]);
    expect(engine.review().waitingUpload).toEqual([]);
    expect(h.api.submitted).toEqual([]);

    h.fs.failWrites = false;                                       // the disk comes back
    expect(await engine.approve(id)).toBe(true);
    expect(h.api.submitted).toHaveLength(1);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });

  it("delete all local data leaves the folder empty and the app runs on without refilling it", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);

    // A storage problem raised before the delete is about data that no longer exists afterwards.
    h.fs.failWrites = true;
    expect(await engine.reject(engine.review().pending[0]!.id)).toBe(true);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    h.fs.failWrites = false;

    await engine.deleteAllData({removeModel: false});
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    expect([...h.fs.files.keys()]).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * SCHEDULER_CHECK_MS);     // the tick and the scheduler run again
    expect([...h.fs.files.keys()]).toEqual([]);
    await engine.quit();
  });

  it("starts no unhandled rejection over an hour with a full disk, a dead server and a failing notifier", async () => {
    const h = createHarness();
    // Everything the engine calls and does not wait for may fail, including the notification itself.
    const engine = await ready(h, {notifyReview: (count) => { h.reviewPrompts.push(count); throw new Error("no notification centre"); }});
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    await engine.updateSettings({reviewTime: "09:30"});            // a review moment inside the hour below

    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", watch);
    try {
      h.fs.failWrites = true;
      h.fs.failReads = true;
      h.api.failWith = "SERVER";
      await engine.approve(engine.review().pending[0]!.id);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await Promise.resolve();
      await new Promise<void>((resolve) => { void Promise.resolve().then(resolve); });
    } finally {
      process.off("unhandledRejection", watch);
    }
    expect(unhandled).toEqual([]);
    expect(h.reviewPrompts).toEqual([1]);                          // the prompt still happened
    h.fs.failWrites = false; h.fs.failReads = false;
    await engine.quit();
  });

  it("one listener that throws costs neither the other listeners nor the tick", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const seen: number[] = [];
    engine.onStatus(() => { throw new Error("the renderer went away"); });
    engine.onStatus((s) => { seen.push(s.pending); });
    await engine.setCapture(true);
    expect(seen.length).toBeGreaterThan(0);

    const before = seen.length;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(seen.length).toBeGreaterThan(before);
    expect(engine.status().capture).toBe("on");
    await engine.quit();
  });

  it("notices a permission taken away while capturing, within one tick, and logs it once", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    expect(engine.status().capture).toBe("on");

    h.reader.permissionValue = "denied";                           // switched off in System Settings
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["NO_PERMISSION"]});
    expect(logCodes(h).filter((code) => code === "PERMISSION_LOST")).toEqual(["PERMISSION_LOST"]);
    await vi.advanceTimersByTimeAsync(10 * PIPELINE_TICK_MS);
    expect(logCodes(h).filter((code) => code === "PERMISSION_LOST")).toEqual(["PERMISSION_LOST"]);
    await engine.quit();
  });

  it("keeps the last known permission when the reader cannot answer, and still acts on a real answer", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    expect(engine.status()).toMatchObject({capture: "on", blockers: []});

    let asks = 0;
    h.reader.permission = async () => {
      asks += 1;
      if (asks % 2 === 1) throw new Error("reader busy");     // every other tick has no answer at all
      return h.reader.permissionValue;
    };
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
      expect(engine.status().capture, `tick ${i}`).toBe("on");
      expect(engine.status().blockers, `tick ${i}`).toEqual([]);
    }
    expect(asks).toBeGreaterThanOrEqual(10);
    // "unknown" is the absence of an answer, so nothing was lost and nothing is logged as lost.
    expect(logCodes(h)).not.toContain("PERMISSION_LOST");

    h.reader.permissionValue = "denied";                      // a real answer, and a real revocation
    h.reader.permission = async () => h.reader.permissionValue;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["NO_PERMISSION"]});
    expect(logCodes(h).filter((code) => code === "PERMISSION_LOST")).toEqual(["PERMISSION_LOST"]);
    await engine.quit();
  });

  it("holds capture off while the reader has not answered at launch, without calling it a missing permission", async () => {
    const h = createHarness();
    h.reader.permission = async () => { throw new Error("reader process died"); };
    const engine = await h.launch();
    // Nothing better is known than "unknown", so capture waits — but nothing is known to be WRONG
    // either, so there is no blocker to show. A permanently broken reader is the loop's
    // READER_PROBLEM supervision's job, not this one's to guess around.
    expect(engine.status()).toMatchObject({capture: "off", checkingPermission: true});
    expect(engine.status().blockers).not.toContain("NO_PERMISSION");
    expect(await engine.recheckPermission()).toBe("unknown");
    await engine.quit();
  });

  it("at a relaunch, waits for the reader's first answer and then resumes by itself, with no alarm on the way", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.setCapture(true);
    await first.quit();
    const readsBefore = h.reader.reads;                         // the first run's own reads

    // The helper is still starting: every ask has no answer, as for the first seconds after launch.
    h.reader.permission = async () => { throw new Error("helper still starting"); };
    const second = await h.launch();
    expect(second.status()).toMatchObject({capture: "off", blockers: [], checkingPermission: true});
    // Refused with nothing to fix — "ask me again in a moment" — and the stored switch is untouched.
    expect(await second.setCapture(true)).toEqual({ok: false, blockers: []});
    expect(second.settings().captureOn).toBe(true);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(second.status()).toMatchObject({capture: "off", checkingPermission: true});
    expect(h.reader.reads).toBe(readsBefore);                   // nothing read on a guess

    h.reader.permission = async () => "granted";                // the helper is up
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(second.status()).toMatchObject({capture: "on", blockers: [], checkingPermission: false});
    expect(h.resumedNotices).toBe(1);
    expect(logCodes(h)).not.toContain("PERMISSION_LOST");
    await second.quit();
  });

  it("shows the Screen Recording blocker once the reader's first answer is a real no", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.setCapture(true);
    await first.quit();

    h.reader.permission = async () => { throw new Error("helper still starting"); };
    const second = await h.launch();
    expect(second.status().blockers).toEqual([]);
    h.reader.permission = async () => "denied";
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(second.status()).toMatchObject({capture: "off", blockers: ["NO_PERMISSION"], checkingPermission: false});
    // Never granted in this run, so nothing was lost.
    expect(logCodes(h)).not.toContain("PERMISSION_LOST");
    await second.quit();
  });

  it("keeps a running pause through a refused switch-on, and calls it a pause only while nothing else blocks", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    await engine.pauseForAnHour();
    const resumeAt = Date.now() + PAUSE_FOR_MS;
    expect(engine.status()).toMatchObject({capture: "pausedByUser", resumeAt});

    await engine.signOut();
    expect(engine.status()).toMatchObject({capture: "off", resumeAt, blockers: ["SIGNED_OUT"]});
    expect(await engine.setCapture(true)).toEqual({ok: false, blockers: ["SIGNED_OUT"]});
    expect(engine.status().resumeAt).toBe(resumeAt);               // the refusal changed nothing

    await engine.signIn("sardor", "correct");
    expect(engine.status()).toMatchObject({capture: "pausedByUser", resumeAt});
    await vi.advanceTimersByTimeAsync(PAUSE_FOR_MS);
    expect(engine.status()).toMatchObject({capture: "on", resumeAt: null});
    await engine.quit();
  });

  it("after quit every call answers no, no listener hears anything more, and no timer is left behind", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    const id = engine.review().pending[0]!.id;
    const seen: unknown[] = [];
    engine.onStatus((s) => { seen.push(s); });

    await engine.quit();
    const emitted = seen.length;
    expect(vi.getTimerCount()).toBe(0);

    expect(await engine.setCapture(true)).toMatchObject({ok: false});
    await expect(engine.pauseForAnHour()).resolves.toBeUndefined();
    expect(await engine.approve(id)).toBe(false);
    expect(await engine.reject(id)).toBe(false);
    expect(await engine.updateSettings({reviewTime: "08:00"})).toEqual({ok: false, problem: "SAVE_FAILED"});
    expect(engine.settings().reviewTime).not.toBe("08:00");
    expect(await engine.signIn("bea", "correct")).toEqual({ok: false, code: "UNAUTHORISED"});
    engine.system("locked");
    engine.retry("reader");

    expect(seen.length).toBe(emitted);
    expect(h.api.submitted).toEqual([]);
    expect(engine.status().capture).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands over the core's counters as fixed keys and numbers, once", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, ANSWER);
    await engine.setCapture(true);
    await workThenLeave(h, engine);
    expect(await engine.approve(engine.review().pending[0]!.id)).toBe(true);

    const counters = engine.takeCounters();
    expect(Object.keys(counters).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(counters)) {
      expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);
      expect(typeof value, key).toBe("number");
      expect(Number.isFinite(value), key).toBe(true);
    }
    expect(counters["statements.approved"]).toBe(1);
    expect(engine.takeCounters()).toEqual({});                     // taken means taken
    await engine.quit();
  });

  it("shows the resumed notice once when a precondition arrives only after launch", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.setCapture(true);
    await first.quit();
    expect(h.resumedNotices).toBe(0);

    // The switch is on, but there is no skills list yet and the server cannot be reached.
    h.fs.files.delete("/data/taxonomy.json");
    h.api.failWith = "SERVER";
    const second = await h.launch();
    expect(second.status()).toMatchObject({capture: "off", blockers: ["NO_TAXONOMY"]});
    expect(h.resumedNotices).toBe(0);

    h.api.failWith = null;
    await vi.advanceTimersByTimeAsync(TAXONOMY_RETRY_MS + PIPELINE_TICK_MS);
    expect(second.status().capture).toBe("on");
    expect(h.resumedNotices).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * PIPELINE_TICK_MS);
    expect(h.resumedNotices).toBe(1);
    await second.quit();
  });

  it("a reader that cannot be subscribed to becomes a reader problem, not a failed setCapture", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const realSubscribe = h.reader.onFocusChange;
    h.reader.onFocusChange = () => { throw new Error("reader process died"); };

    // Never a rejection out of setCapture, and never silently on either.
    expect(await engine.setCapture(true)).toEqual({ok: true});
    expect(engine.status()).toMatchObject({capture: "off"});
    expect(engine.status().blockers).toEqual(["READER_PROBLEM"]);
    expect(logCodes(h)).toContain("READER_PROBLEM");
    expect(logCodes(h)).not.toContain("CAPTURE_ON");
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(10 * PIPELINE_TICK_MS);
    expect(h.reader.reads).toBe(reads);                            // nothing is being read

    h.reader.onFocusChange = realSubscribe;                        // the reader comes back
    engine.retry("reader");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status()).toMatchObject({capture: "on", blockers: []});
    await engine.quit();
  });

  it("reports a reader that cannot be subscribed to when capture is retried after another problem", async () => {
    const h = createHarness();
    const engine = await ready(h);
    await engine.setCapture(true);
    h.client.breakNow();                                           // capture off: the model is broken
    expect(engine.status()).toMatchObject({capture: "off", blockers: ["MODEL_PROBLEM"]});

    h.reader.onFocusChange = () => { throw new Error("reader process died"); };
    expect(() => { engine.retry("model"); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status()).toMatchObject({capture: "off"});
    expect(engine.status().blockers).toEqual(["READER_PROBLEM"]);
    await engine.quit();
  });

  it("logs that the settings file had to be recovered", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.quit();
    h.fs.files.set("/data/settings.json", new TextEncoder().encode("{broken"));
    h.fs.files.delete("/data/app.log");
    const second = await h.launch();
    expect(logCodes(h)).toContain("SETTINGS_FILE_UNREADABLE");
    await second.quit();
  });


  it("a production build refuses to start with a stand-in, whichever port it is", async () => {
    const h = createHarness();
    // Every port the shell can wire a stand-in into, one at a time. A build that ships with any one
    // of them would read, sign in, encrypt, extract or "download" against something that is not the
    // real thing — silently, and with a real user's statements.
    // The same marker a real stand-in carries, on an otherwise ordinary fake.
    const marked = <T extends object>(port: T): T => ({...port, standIn: true} as T);
    const standIns: Partial<EngineDeps>[] = [
      {reader: createDevReader([], 1_000)},
      {api: marked(h.api)},
      {cipher: marked(h.cipher)},
      {model: marked(h.client)},
      {downloader: createReadyDownloader()}
    ];
    for (const overrides of standIns) {
      await expect(h.launch({production: true, ...overrides}), Object.keys(overrides)[0]).rejects.toMatchObject({code: "STANDIN_IN_PRODUCTION"});
    }
    // And the real thing still starts: the guard is about the marker, not about being in production.
    const engine = await h.launch({production: true});
    expect(engine.status().blockers).toContain("SIGNED_OUT");
    await engine.quit();
  });
});
