import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SCENARIO_IDLE_MS} from "../core/constants";
import {createDevReader} from "../standins/devReader";
import {createStubApi} from "../standins/stubApi";
import {ACTIVE_POLL_MS, PIPELINE_TICK_MS, READER_FAILURE_LIMIT} from "./constants";
import {LOG_CODES, LOG_COUNT_KEYS} from "./log";
import {parseTaxonomy, type Taxonomy} from "./ports/claveApi";
import type {ReadResult} from "./ports/reader";
import {createHarness} from "./testing/harness";

interface LogLine { code: string; counts: Record<string, unknown> }
const logLines = (text: string): LogLine[] =>
  text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine);

const taxonomy = parseTaxonomy(JSON.parse(readFileSync(new URL("../standins/taxonomy.json", import.meta.url), "utf8"))) as Taxonomy;

const SLACK = {app: "Slack", title: "#backend-team \u2014 Acme Workspace", text: [
  "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy. Any idea what changed?",
  "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
  "Sardor 10:46 export STRIPE_KEY=sk_live_51HxQbLkT9vW3mZpR8sYcD2eF",
  "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable for support agents? Mail me at tomas@acme.io",
  "Sardor 10:51 For the customer page yes. For the support dashboard I would bypass the cache and hit the replica."
].join("\n")};

const GATE_YES = {activity_summary: "Debugged a slow query.", is_professional: true, user_demonstrated_something: true};
const CLEAN = "Weighed stale reads against database load and chose different caching strategies for two kinds of page.";
const LEAKY = {evidence: [
  {target_id: "stub-postgresql", statement: "Explained the root cause of a slow query to Priya and proposed adding a supporting index."},
  {target_id: "stub-postgresql", statement: "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."},
  {target_id: "stub-postgresql", statement: "Identified a sequential scan over eight million rows and fixed it by adding a supporting index."},
  {target_id: "stub-redis", statement: "Emailed tomas@acme.io a proposal for a thirty second cache in front of a slow database query."},
  {target_id: "stub-problem-solving", statement: CLEAN}
]};
const SECRETS = ["Priya", "Raman", "Tomas", "Lindqvist", "Acme", "acme.io", "sk_live", "51HxQb", "backend-team", "8 million", "eight million", "2.4 seconds", "sequential scan on"];

describe("LEAK TEST (app): with both stand-ins and a model that leaks", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("nothing read from the screen reaches the disk, the log, the upload, or anything a UI can ask for", async () => {
    const h = createHarness();
    const reader = createDevReader([SLACK], 60_000);
    const api = createStubApi({fs: h.fs, uploadsPath: "/data/stub-uploads.jsonl", taxonomy, now: () => Date.now()});
    const engine = await h.launch({reader, api});
    const statuses: unknown[] = [];
    engine.onStatus((s) => statuses.push(s));

    await engine.signIn("sardor", "anything");
    h.client.script.push(GATE_YES, {evidence: [{target_id: "self-test-postgres", statement: CLEAN}]});
    await engine.selfTest();
    h.client.script.push(GATE_YES, LEAKY);
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(SCENARIO_IDLE_MS + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);

    // The model did see the (scrubbed) work, and the guard let exactly one statement through.
    expect(h.client.fake.calls.length).toBeGreaterThanOrEqual(3);
    expect(engine.review().pending.map((p) => p.statement)).toEqual([CLEAN]);
    const sentToModel = JSON.stringify(h.client.fake.calls.map((c) => [c.settings.systemPrompt, c.userText]));
    expect(sentToModel).not.toContain("sk_live");
    expect(sentToModel).not.toContain("tomas@acme.io");

    await engine.approve(engine.review().pending[0]!.id);
    await engine.quit();

    const uploaded = h.fs.text("/data/stub-uploads.jsonl") as string;
    expect(uploaded).toContain(CLEAN);
    const everything = [
      h.fs.everything(), JSON.stringify(statuses), JSON.stringify(engine.review()),
      JSON.stringify(engine.status()), JSON.stringify(engine.settings()), JSON.stringify(engine.takeCounters())
    ].join("\n");
    for (const secret of SECRETS) expect(everything, secret).not.toContain(secret);
  });

  it("the log holds codes and numbers only, over a run that really writes to it", async () => {
    const h = createHarness();
    // A reader that answers every read with a failure: enough of them inside the window and the
    // engine logs a reader problem and switches capture off by itself.
    const reader = {...createDevReader([SLACK], 60_000), read: async () => ({ok: false, reason: "failed"} as const)};
    const engine = await h.launch({reader});
    await engine.signIn("sardor", "correct");
    h.client.script.push(GATE_YES, {evidence: [{target_id: "self-test-postgres", statement: CLEAN}]});
    expect(await engine.selfTest()).toEqual({ok: true, timeScale: 1});
    await engine.setCapture(true);
    expect(engine.status().capture).toBe("on");
    await vi.advanceTimersByTimeAsync(READER_FAILURE_LIMIT * ACTIVE_POLL_MS + PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("READER_PROBLEM");
    engine.retry("reader");
    await engine.quit();

    const text = h.fs.text("/data/app.log");
    expect(text, "the run must have logged something for this test to mean anything").not.toBeNull();
    const lines = (text as string).split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const entry = JSON.parse(line) as {at: unknown; code: unknown; counts: Record<string, unknown>};
      expect(Object.keys(entry).sort()).toEqual(["at", "code", "counts"]);
      expect(typeof entry.at).toBe("number");
      expect(LOG_CODES).toContain(entry.code);
      for (const value of Object.values(entry.counts)) expect(typeof value).toBe("number");
    }
    for (const secret of SECRETS) expect(text as string, secret).not.toContain(secret);
  });

  /**
   * The new opening this change makes, closed. A `failed` read now carries a `detail` saying which
   * step of the reader broke, and that word becomes a count KEY in `app.log` — the one place whose
   * privacy argument rests on its keys being fixed identifiers of this codebase rather than a
   * pattern. A helper that sent a window title as its detail would, without the closed set at the
   * port, write that title into the log as a key, right past every check that looks at values.
   *
   * So: a reader that answers every read with a detail made of the most private thing this suite
   * has, through the whole real path — port, loop tally, engine, log, status, review, IPC counters —
   * and none of it may surface anywhere. The run really does write to the log: five failures inside
   * the window raise `READER_PROBLEM` and switch capture off, which is what writes the tallies out.
   */
  it("a detail outside the closed set can never reach the log, an event, or anything a UI can ask for", async () => {
    const h = createHarness();
    const leaky = "Priya Raman \u2014 recovery codes at acme.io";
    const reader = {
      ...createDevReader([SLACK], 60_000),
      read: async () => ({ok: false, reason: "failed", detail: leaky} as unknown as ReadResult)
    };
    const engine = await h.launch({reader});
    const statuses: unknown[] = [];
    engine.onStatus((s) => statuses.push(s));
    await engine.signIn("sardor", "correct");
    h.client.script.push(GATE_YES, {evidence: [{target_id: "self-test-postgres", statement: CLEAN}]});
    expect(await engine.selfTest()).toEqual({ok: true, timeScale: 1});
    await engine.setCapture(true);
    await vi.advanceTimersByTimeAsync(READER_FAILURE_LIMIT * ACTIVE_POLL_MS + PIPELINE_TICK_MS);
    // The failures were counted and acted on — otherwise this test proves nothing about a path that ran.
    expect(engine.status().blockers).toContain("READER_PROBLEM");
    await engine.quit();

    const log = h.fs.text("/data/app.log") as string;
    expect(log, "the run must have logged something for this test to mean anything").not.toBeNull();
    const everything = [
      h.fs.everything(), JSON.stringify(statuses), JSON.stringify(engine.status()), JSON.stringify(engine.review()),
      JSON.stringify(engine.takeCounters())
    ].join("\n");
    for (const fragment of ["Priya", "Raman", "recovery codes", "acme.io", leaky]) {
      expect(everything, fragment).not.toContain(fragment);
    }
    // And what DID get written is the honest count: the stage could not be named, so it is not.
    const off = logLines(log).find((l) => l.code === "CAPTURE_OFF");
    expect(off?.counts).toMatchObject({failed: READER_FAILURE_LIMIT, failedUnknown: READER_FAILURE_LIMIT});
    for (const [key, value] of Object.entries(off?.counts ?? {})) {
      expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
      expect(typeof value, key).toBe("number");
    }
  });
});
