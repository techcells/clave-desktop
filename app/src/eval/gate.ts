import type {ModelPort} from "../core/types";
import {runSelfTest} from "../main/model/selfTest";
import {judgeReal, parseFixture, runFixture} from "./runFixture";

/** `skipped` is a fixture this run had nothing to do with: reported, and never counted as a pass. */
export interface GateResult { name: string; ok: boolean; problems: string[]; safety: boolean; seconds: number; skipped: boolean }
/**
 * `safe` is the hard requirement: no fixture let a forbidden string reach the model or leave, every
 * read was kept or skipped as expected, and nothing crashed. `passed` additionally wants the
 * quality expectations (how many statements, for which targets), which a real model at a non-zero
 * temperature misses now and then: those are tuning findings, not release blockers.
 * Both need at least one fixture to have actually run: "every fixture passed" over a set of skips
 * is not a release, and a fixtures folder that was renamed away must not read as a green gate.
 */
export interface GateReport { selfTest: boolean; results: GateResult[]; safe: boolean; passed: boolean }

/** Problems from `judgeReal` that are about quality only. Everything else is a safety problem. */
const QUALITY = /^(digest size |unexpected target )/;
/** Adversarial fixtures differ from their originals only in the SCRIPTED model, which a real run ignores. */
const SCRIPT_ONLY = /^adversarial-/;

/**
 * The release gate: the self-test, then every fixture through the real pipeline with the given
 * model, judged by `judgeReal`. Problems are fixed phrases with indexes, never fixture text.
 */
export async function runGate(deps: {model: ModelPort; fixtures: {name: string; value: unknown}[]; now: () => number; onResult?: (result: GateResult) => void}): Promise<GateReport> {
  const selfTest = (await runSelfTest(deps.model)).ok;
  const results: GateResult[] = [];
  for (const {name, value} of deps.fixtures) {
    const started = deps.now();
    const fixture = parseFixture(value);
    const seconds = () => Math.round((deps.now() - started) / 1000);
    if (fixture && SCRIPT_ONLY.test(fixture.category)) {
      const skip: GateResult = {name, ok: true, problems: [], safety: false, seconds: seconds(), skipped: true};
      results.push(skip);
      deps.onResult?.(skip);
      continue;
    }
    let problems: string[];
    if (!fixture) problems = ["fixture is malformed"];
    else {
      try { problems = judgeReal(fixture, await runFixture(fixture, deps.model)); }
      catch { problems = ["run failed"]; }
    }
    const result: GateResult = {name, ok: problems.length === 0, problems, safety: problems.some((p) => !QUALITY.test(p)), seconds: seconds(), skipped: false};
    results.push(result);
    deps.onResult?.(result);
  }
  const ran = results.filter((r) => !r.skipped);
  return {
    selfTest, results,
    safe: selfTest && ran.length > 0 && ran.every((r) => !r.safety),
    passed: selfTest && ran.length > 0 && ran.every((r) => r.ok)
  };
}
