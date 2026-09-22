import {describe, expect, it} from "vitest";
import {BUFFER_MAX_AGE_MS, SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel, type FakeScript} from "./testing/fakeModel";
import type {PipelineConfig} from "./types";

const CONFIG: PipelineConfig = {
  exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "tax-7",
  skills: [
    {id: "pg", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]},
    {id: "redis", displayName: "Redis", canonicalName: "redis", aliases: []}
  ],
  competencies: [{id: "cp1", name: "Problem Solving", description: "Breaks a problem down and resolves it"}],
  userNames: ["Sardor Astanov"]
};

const SLACK = {app: "Slack", title: "#backend-team — Acme Workspace", text: [
  "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy. Any idea what changed?",
  "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
  "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable for support agents?",
  "Sardor 10:51 For the customer page yes. For the support dashboard I would bypass the cache and hit the replica."
].join("\n")};
const JIRA = {app: "Jira", title: "PROJ-4821 Checkout latency regression", text:
  "Assignee Sardor Astanov  Reporter Priya Raman  Status In Review\nRoot Cause: migration 0412 added a join with no supporting index. p95 rose to 2400 ms.\nFix: added the index concurrently and a short cache, then verified on staging with replayed traffic."};

const GATE_YES = {activity_summary: "Debugged a slow query.", is_professional: true, user_demonstrated_something: true};
const GATE_NO = {activity_summary: "Personal browsing.", is_professional: false, user_demonstrated_something: false};
const CLEAN_PG = "Traced a latency regression to a missing index and rebuilt it without blocking writes on a production database.";
const CLEAN_CP = "Weighed stale reads against database load and chose different strategies for customer and support views.";

function setup(script: FakeScript, config: PipelineConfig = CONFIG) {
  let now = Date.UTC(2026, 8, 17, 9);
  let n = 0;
  const model = createFakeModel(script);
  const pipeline = createPipeline(config, {
    model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`
  });
  const advance = (ms: number) => { now += ms; };
  const read = (w: {app: string; title: string; text: string; toolbarText?: string}) => {
    advance(30_000);
    const decision = pipeline.mayCapture(w);
    return decision.allow ? pipeline.ingest({...w, at: now}) : {kept: false as const, reason: decision.reason};
  };
  const finish = async () => { advance(SCENARIO_IDLE_MS + 1_000); pipeline.tick(); await pipeline.whenIdle(); };
  return {pipeline, model, advance, read, finish};
}
const long = (tag: string) => `${tag} investigated the failing integration and documented the outcome for the team. `.repeat(8);

describe("pipeline", () => {
  it("is off until switched on, and stops when the screen locks", () => {
    const {pipeline} = setup([]);
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "captureOff"});
    pipeline.signal("captureOn");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
    pipeline.signal("locked");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "locked"});
    expect(pipeline.ingest({...SLACK, at: 0})).toEqual({kept: false, reason: "locked"});
    pipeline.signal("unlocked");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
  });

  it("turns a stretch of work into stamped, guarded statements", async () => {
    const {pipeline, model, read, finish} = setup([GATE_YES, {evidence: [{target_id: "pg", statement: CLEAN_PG}, {target_id: "cp1", statement: CLEAN_CP}]}]);
    pipeline.signal("captureOn");
    expect(read(SLACK)).toEqual({kept: true});
    expect(read(SLACK)).toEqual({kept: false, reason: "unchanged"});
    expect(read(JIRA)).toEqual({kept: true});
    await finish();
    // The digest ranks by specificity, so compare without assuming an order.
    const rows = pipeline.digest().map((i) => [i.kind, i.targetId, i.statement, i.taxonomyVersion]);
    expect(rows.sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
      ["competency", "cp1", CLEAN_CP, "tax-7"], ["skill", "pg", CLEAN_PG, "tax-7"]
    ]);
    expect(model.calls[0]!.settings.systemPrompt).toContain("pg = PostgreSQL");
    expect(model.calls[0]!.userText).toContain("[Slack — #backend-team — Acme Workspace]");
    const id = pipeline.digest()[0]!.id;
    pipeline.resolve(id, "approved");
    expect(pipeline.digest().length).toBe(1);
    expect(pipeline.counters()["statements.approved"]).toBe(1);
    const taken = pipeline.takeCounters();
    expect(taken["reads.kept"]).toBe(2);
    expect(taken["reads.skipped.unchanged"]).toBe(1);
    expect(pipeline.counters()).toEqual({});
  });

  it("LEAK TEST: nothing forbidden reaches the digest or the counters, even when the model leaks", async () => {
    const leaky = {evidence: [
      {target_id: "pg", statement: "Explained the root cause of a slow query to Priya and proposed adding a supporting index."},
      {target_id: "pg", statement: "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."},
      {target_id: "cp1", statement: "Closed PROJ-4821 by adding a supporting index and a cache for a rarely changing database value."},
      {target_id: "pg", statement: "Identified a sequential scan over eight million rows and fixed it by adding a supporting index."},
      {target_id: "cp1", statement: CLEAN_CP}
    ]};
    const {pipeline, read, finish} = setup([GATE_YES, leaky]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    expect(pipeline.digest().map((i) => i.statement)).toEqual([CLEAN_CP]);
    expect(pipeline.counters()["guard.discarded.check1"]).toBe(4);
    const everythingThatCouldLeave = JSON.stringify([pipeline.digest(), pipeline.exportPool(), pipeline.counters()]);
    for (const secret of ["Priya", "Raman", "Tomas", "Lindqvist", "Acme", "PROJ", "4821", "0412", "2400", "eight million", "Sardor", "backend-team"]) {
      expect(everythingThatCouldLeave).not.toContain(secret);
    }
  });

  it("never reads an excluded app, even if the app forgets to ask first", async () => {
    const {pipeline, model, read, finish} = setup([]);
    pipeline.signal("captureOn");
    const telegram = {app: "Telegram", title: "Madina", text: long("private")};
    expect(read(telegram)).toEqual({kept: false, reason: "excludedApp"});
    expect(pipeline.ingest({...telegram, at: 0})).toEqual({kept: false, reason: "excludedApp"});
    expect(read({app: "Google Chrome", title: "Log in", text: long("bank"), toolbarText: "https://www.paypal.com/signin"})).toEqual({kept: false, reason: "excludedSite"});
    expect(read({app: "Google Chrome", title: "Example Domain", text: long("secret"), toolbarText: "example.com  Incognito"})).toEqual({kept: false, reason: "privateWindow"});
    await finish();
    expect(model.opened).toBe(0);
  });

  it("scrubs secrets before the model ever sees the text", async () => {
    const {pipeline, model, read, finish} = setup([GATE_NO]);
    pipeline.signal("captureOn");
    read({app: "Terminal", title: "zsh — deploy", text: long("deploy") + "\nexport STRIPE_KEY=sk_live_51AbCdEfGhIjKlMnOpQrStUv\n"});
    await finish();
    expect(model.calls[0]!.userText).toContain("[SECRET]");
    expect(model.calls[0]!.userText).not.toContain("sk_live_51AbCdEfGhIjKlMnOpQrStUv");
    expect(pipeline.digest()).toEqual([]);
  });

  it("denies everything while the configuration is invalid, and recovers when it is fixed", () => {
    const {pipeline} = setup([], {...CONFIG, exclusions: [42] as unknown as string[]});
    pipeline.signal("captureOn");
    let seed = 3;
    for (let i = 0; i < 50; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      expect(pipeline.mayCapture({app: `App${seed % 9}`, title: `Title ${seed}`})).toEqual({allow: false, reason: "rulesInvalid"});
    }
    expect(pipeline.configure({...CONFIG, skills: "nope" as unknown as []}).ok).toBe(false);
    expect(pipeline.configure(CONFIG)).toEqual({ok: true});
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
  });

  it("drops the scenario when the model keeps returning a target that was never offered", async () => {
    const bad = {evidence: [{target_id: "k8s", statement: CLEAN_PG}]};
    const {pipeline, read, finish} = setup([GATE_YES, bad, GATE_YES, bad]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    expect(pipeline.digest()).toEqual([]);
    expect(pipeline.counters()["extract.failed"]).toBe(1);
  });

  it("keeps at most three scenarios waiting and drops the oldest, without ever blocking capture", async () => {
    let release: (v: unknown) => void = () => undefined;
    const blocked = new Promise((resolve) => { release = resolve; });
    const {pipeline, model, advance, read} = setup([() => blocked, GATE_NO, GATE_NO, GATE_NO]);
    pipeline.signal("captureOn");
    for (let i = 0; i < 5; i++) {
      expect(read({app: "Code", title: `file${i}.ts`, text: long(`item${i}`)})).toEqual({kept: true});
      advance(SCENARIO_IDLE_MS + 1_000);
      pipeline.tick();
    }
    expect(pipeline.counters()["scenarios.droppedQueue"]).toBe(1);
    release(GATE_NO);
    await pipeline.whenIdle();
    expect(model.opened).toBe(4);
  });

  it("drops a waiting scenario once it is older than sixty minutes", async () => {
    let release: (v: unknown) => void = () => undefined;
    const blocked = new Promise((resolve) => { release = resolve; });
    const {pipeline, model, advance, read} = setup([() => blocked]);
    pipeline.signal("captureOn");
    for (let i = 0; i < 2; i++) { read({app: "Code", title: `f${i}.ts`, text: long(`w${i}`)}); advance(SCENARIO_IDLE_MS + 1_000); pipeline.tick(); }
    advance(BUFFER_MAX_AGE_MS + 1);
    pipeline.tick();
    expect(pipeline.counters()["scenarios.droppedStale"]).toBe(1);
    release(GATE_NO);
    await pipeline.whenIdle();
    expect(model.opened).toBe(1);
  });

  it("closes the open scenario at once when capture is switched off", async () => {
    const {pipeline, model, read} = setup([GATE_NO]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    pipeline.signal("captureOff");
    await pipeline.whenIdle();
    expect(model.opened).toBe(1);
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "captureOff"});
  });

  it("scrubs the window title, not just the body text", async () => {
    const {pipeline, model, read, finish} = setup([GATE_YES, {evidence: [{target_id: "pg", statement: CLEAN_PG}, {target_id: "cp1", statement: CLEAN_CP}]}]);
    pipeline.signal("captureOn");
    const secretTitle = "sk_live_51AbCdEfGhIjKlMnOpQrStUv priya.raman@acme.io";
    expect(read({app: "Slack", title: secretTitle, text: long("investigated")})).toEqual({kept: true});
    await finish();
    expect(model.calls.length).toBeGreaterThan(0);
    for (const call of model.calls) {
      const seen = call.settings.systemPrompt + call.userText;
      expect(seen).not.toContain("sk_live_51AbCdEfGhIjKlMnOpQrStUv");
      expect(seen).not.toContain("priya.raman@acme.io");
    }
    expect(model.calls[0]!.userText).toContain("[SECRET]");
    expect(model.calls[0]!.userText).toContain("[EMAIL]");
  });

  it("persists only finished statements", async () => {
    const {pipeline, read, finish} = setup([GATE_YES, {evidence: [{target_id: "cp1", statement: CLEAN_CP}]}]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    const pool = pipeline.exportPool();
    expect(pool.map((i) => i.statement)).toEqual([CLEAN_CP]);
    const other = setup([]);
    expect(other.pipeline.importPool(pool)).toEqual({accepted: 1, rejected: 0});
    expect(other.pipeline.digest().length).toBe(1);
  });
});
