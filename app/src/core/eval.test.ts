import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel} from "./testing/fakeModel";
import type {Competency, Skill} from "./types";

interface Fixture {
  name: string; category: string; userNames: string[]; skills: Skill[]; competencies: Competency[];
  reads: {app: string; title: string; text: string; toolbarText?: string; gapSeconds?: number}[];
  model: {gate: unknown; statements: unknown | null};
  expect: {outcomes: string[]; modelCalls: number; modelMustNotSee: string[]; digestTargets: string[]; mustNotAppear: string[]};
  expectReal: {digestMin: number; digestMax: number; allowedTargets: string[]};
}

const DIR = new URL("../../../eval/fixtures/", import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("evaluation set (scripted model)", () => {
  it("has a fixture for every category in the spec", () => {
    const categories = new Set(files.map((f) => (JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture).category));
    for (const c of ["work-english", "work-portuguese", "private", "mixed", "colleague", "names-everywhere", "secret-on-screen", "recognition-noise"]) {
      expect([...categories]).toContain(c);
    }
  });

  it.each(files)("%s", async (file) => {
    const fx = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture;
    let now = Date.UTC(2026, 8, 17, 9);
    let n = 0;
    const model = createFakeModel(fx.model.statements === null ? [fx.model.gate] : [fx.model.gate, fx.model.statements]);
    const pipeline = createPipeline({
      exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "eval",
      skills: fx.skills, competencies: fx.competencies, userNames: fx.userNames
    }, {model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`});
    pipeline.signal("captureOn");

    const outcomes = fx.reads.map((read) => {
      now += (read.gapSeconds ?? 30) * 1000;
      const decision = pipeline.mayCapture(read);
      if (!decision.allow) return decision.reason;
      const result = pipeline.ingest({...read, at: now});
      return result.kept ? "kept" : result.reason;
    });
    now += SCENARIO_IDLE_MS + 1_000;
    pipeline.tick();
    await pipeline.whenIdle();

    expect(outcomes).toEqual(fx.expect.outcomes);
    expect(model.calls.length).toBe(fx.expect.modelCalls);
    const sentToModel = JSON.stringify(model.calls.map((c) => [c.settings.systemPrompt, c.userText]));
    for (const secret of fx.expect.modelMustNotSee) expect(sentToModel).not.toContain(secret);
    expect(pipeline.digest().map((i) => i.targetId).sort()).toEqual(fx.expect.digestTargets);
    const couldLeave = JSON.stringify([pipeline.digest(), pipeline.exportPool(), pipeline.counters()]);
    for (const secret of fx.expect.mustNotAppear) expect(couldLeave).not.toContain(secret);
  });
});
