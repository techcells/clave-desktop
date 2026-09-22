import {describe, expect, it} from "vitest";
import {BUFFER_MAX_AGE_MS, SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel, type FakeScript} from "./testing/fakeModel";
import type {PipelineConfig} from "./types";

const CONFIG: PipelineConfig = {
  exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "tax-7",
  skills: [{id: "pg", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]}],
  competencies: [], userNames: ["Sardor Astanov"]
};
const GATE_NO = {activity_summary: "Personal browsing.", is_professional: false, user_demonstrated_something: false};
const work = (tag: string) => `${tag} tuned a Postgres query and documented the outcome for the team in the runbook. `.repeat(8);

function setup(script: FakeScript) {
  let now = Date.UTC(2026, 8, 17, 9);
  let n = 0;
  const model = createFakeModel(script);
  const pipeline = createPipeline(CONFIG, {
    model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`
  });
  const advance = (ms: number) => { now += ms; };
  /** One kept read, then enough idle time to close the scenario. */
  const scenario = (tag: string) => {
    advance(30_000);
    pipeline.ingest({app: "Code", title: "query.sql", text: work(tag), at: now});
    advance(SCENARIO_IDLE_MS + 1_000);
    pipeline.tick();
  };
  pipeline.signal("captureOn");
  return {pipeline, model, advance, scenario};
}

describe("pipeline: model paused", () => {
  it("holds closed scenarios while paused and runs them on resume", async () => {
    const {pipeline, model, scenario} = setup([GATE_NO, GATE_NO]);
    pipeline.signal("modelPaused");
    scenario("first"); scenario("second");
    await pipeline.whenIdle();
    expect(model.opened).toBe(0);

    pipeline.signal("modelResumed");
    await pipeline.whenIdle();
    expect(model.opened).toBe(2);
  });

  it("whenIdle resolves while paused even though scenarios are waiting", async () => {
    const {pipeline, scenario} = setup([]);
    pipeline.signal("modelPaused");
    scenario("first");
    await expect(Promise.race([pipeline.whenIdle().then(() => "idle"), new Promise((r) => setTimeout(() => r("hung"), 200))])).resolves.toBe("idle");
  });

  it("keeps capturing while paused", () => {
    const {pipeline} = setup([]);
    pipeline.signal("modelPaused");
    expect(pipeline.mayCapture({app: "Code", title: "query.sql"})).toEqual({allow: true});
  });

  it("still drops a waiting scenario after sixty minutes, and counts it as a paused drop", async () => {
    const {pipeline, model, advance, scenario} = setup([]);
    pipeline.signal("modelPaused");
    scenario("first");
    advance(BUFFER_MAX_AGE_MS + 1_000);
    pipeline.tick();
    pipeline.signal("modelResumed");
    await pipeline.whenIdle();
    expect(model.opened).toBe(0);
    expect(pipeline.counters()).toMatchObject({"scenarios.droppedStale": 1, "pipeline.pausedDrops": 1});
  });

  it("still keeps at most three waiting while paused", async () => {
    const {pipeline, model, scenario} = setup([GATE_NO, GATE_NO, GATE_NO]);
    pipeline.signal("modelPaused");
    scenario("a"); scenario("b"); scenario("c"); scenario("d");
    pipeline.signal("modelResumed");
    await pipeline.whenIdle();
    expect(model.opened).toBe(3);
    expect(pipeline.counters()).toMatchObject({"scenarios.droppedQueue": 1, "pipeline.pausedDrops": 1});
  });

  it("lets a running extraction finish when the pause arrives", async () => {
    const {pipeline, model, scenario} = setup([GATE_NO, GATE_NO]);
    scenario("first");
    pipeline.signal("modelPaused");
    scenario("second");
    await pipeline.whenIdle();
    expect(model.opened).toBe(1);
  });
});
