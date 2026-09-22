import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {createFakeModel} from "../core/testing/fakeModel";
import type {ModelPort} from "../core/types";
import {runGate} from "./gate";

const DIR = new URL("../../../eval/fixtures/", import.meta.url).pathname;
const load = (file: string) => ({name: file, value: JSON.parse(readFileSync(join(DIR, file), "utf8")) as {model: {gate: unknown; statements: unknown | null}}});
const SELF_GATE = {activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true};
const SELF_ANSWER = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

/** Answers the self-test first, then each fixture's own scripted answers, in order. */
function scripted(files: string[]): ModelPort {
  const script: unknown[] = [SELF_GATE, SELF_ANSWER];
  for (const file of files.filter((f) => !f.includes("adversarial"))) { const m = load(file).value.model; script.push(m.gate); if (m.statements !== null) script.push(m.statements); }
  return createFakeModel(script);
}

describe("release gate", () => {
  // Adapted for E9 on purpose: a skipped fixture is now reported rather than passed over in silence.
  it("passes when the self-test and every fixture pass, and reports each one, skips included", async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
    const seen: string[] = [];
    const report = await runGate({model: scripted(files), fixtures: files.map(load), now: () => 0, onResult: (r) => seen.push(r.name)});
    expect(report.selfTest).toBe(true);
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.safe).toBe(true);
    // Every fixture is accounted for: nothing disappears between the folder and the report.
    expect(seen).toEqual(files);
    expect(report.results.map((r) => r.name)).toEqual(files);
    // Adversarial fixtures only differ in their scripted model, which a real run ignores: skipped,
    // out loud, and never counted as a fixture that passed.
    const skipped = report.results.filter((r) => r.skipped);
    expect(skipped.map((r) => r.name)).toEqual(files.filter((f) => f.includes("adversarial")));
    expect(skipped.every((r) => r.problems.length === 0 && !r.safety)).toBe(true);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("is neither passed nor safe when nothing actually ran", async () => {
    const files = readdirSync(DIR).filter((f) => f.includes("adversarial")).sort();
    expect(files.length).toBeGreaterThan(0);
    const report = await runGate({model: scripted(files), fixtures: files.map(load), now: () => 0});
    expect(report.selfTest).toBe(true);
    expect(report.results.every((r) => r.skipped)).toBe(true);
    // "Every fixture passed" over an empty set is not a release: nothing was tried.
    expect(report.passed).toBe(false);
    expect(report.safe).toBe(false);
  });

  it("fails on a failed self-test, a malformed fixture, a run that throws, or a judged problem", async () => {
    const silent: ModelPort = {open: async () => { throw new Error("no model"); }};
    const report = await runGate({model: silent, fixtures: [{name: "bad.json", value: {name: "x"}}, load("01-work-english.json")], now: () => 0});
    expect(report.selfTest).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.results[0]).toMatchObject({ok: false, problems: ["fixture is malformed"]});
    expect(report.results[1]?.ok).toBe(false);
    expect(report.safe).toBe(false);
  });

  it("tells a quality finding from a safety problem", async () => {
    const colleague = load("05-colleague.json");
    const eager = createFakeModel([SELF_GATE, SELF_ANSWER,
      {activity_summary: "Migrated a cluster.", is_professional: true, user_demonstrated_something: true},
      {evidence: [{target_id: "k8s", statement: "Migrated every service to a new cluster with a staged rollout and disruption budgets for stateful workloads."}]}]);
    const report = await runGate({model: eager, fixtures: [colleague], now: () => 0});
    expect(report.results[0]).toMatchObject({ok: false, safety: false});
    expect(report).toMatchObject({safe: true, passed: false});
  });
});
