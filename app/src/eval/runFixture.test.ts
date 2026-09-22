import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {createFakeModel} from "../core/testing/fakeModel";
import {judgeReal, parseFixture, runFixture, type Fixture} from "./runFixture";

const DIR = new URL("../../../eval/fixtures/", import.meta.url).pathname;
const load = (file: string) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as {model: {gate: unknown; statements: unknown | null}};
const scripted = (file: string) => { const m = load(file).model; return createFakeModel(m.statements === null ? [m.gate] : [m.gate, m.statements]); };
const files = () => readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
/** The fixtures written to attack the guard: scripted statements that carry each category's own forbidden terms. */
const adversarial = () => files().filter((f) => (parseFixture(load(f)) as Fixture | null)?.category.startsWith("adversarial-") === true);

describe("fixture runner (the release gate for the real model)", () => {
  it("parses every fixture in eval/fixtures", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) expect(parseFixture(load(file)), file).not.toBeNull();
    expect(parseFixture({name: "x"})).toBeNull();
  });

  it("a well-behaved model passes a fixture", async () => {
    const fixture = parseFixture(load("01-work-english.json")) as Fixture;
    const run = await runFixture(fixture, scripted("01-work-english.json"));
    expect(judgeReal(fixture, run)).toEqual([]);
  });

  it("records everything the model was sent, so modelMustNotSee also binds a real model", async () => {
    const fixture = parseFixture(load("07-secret-on-screen.json")) as Fixture;
    const run = await runFixture(fixture, scripted("07-secret-on-screen.json"));
    expect(run.sentToModel.length).toBeGreaterThan(100);
    expect(judgeReal(fixture, run)).toEqual([]);
  });

  it("flags a model that finds evidence where there is none, without quoting anything", async () => {
    const fixture = parseFixture(load("05-colleague.json")) as Fixture;
    const eager = createFakeModel([
      {activity_summary: "Migrated a cluster.", is_professional: true, user_demonstrated_something: true},
      {evidence: [{target_id: "k8s", statement: "Migrated every service to a new cluster with a staged rollout and disruption budgets for stateful workloads."}]}
    ]);
    const problems = judgeReal(fixture, await runFixture(fixture, eager));
    expect(problems).toEqual(["digest size 1 outside 0..0", "unexpected target k8s"]);
  });

  it("carries at least seven adversarial fixtures, each with terms it forbids", () => {
    const files = adversarial();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const fixture = parseFixture(load(file)) as Fixture;
      expect(fixture.expect.mustNotAppear.length, file).toBeGreaterThan(0);
    }
  });

  it("lets no forbidden term out of any adversarial fixture, even when the model puts it in a statement", async () => {
    const files = adversarial();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const fixture = parseFixture(load(file)) as Fixture;
      const run = await runFixture(fixture, scripted(file));
      for (const term of fixture.expect.mustNotAppear) expect(run.couldLeave, `${file}: ${term}`).not.toContain(term);
    }
  });

  it("reports every forbidden entry by its own index, duplicates included", async () => {
    const fixture = parseFixture(load("01-work-english.json")) as Fixture;
    const run = await runFixture(fixture, scripted("01-work-english.json"));
    const inPrompt = run.sentToModel.slice(0, 24);
    const couldLeave = run.couldLeave.slice(0, 24);
    const problems = judgeReal({...fixture, expect: {
      outcomes: fixture.expect.outcomes,
      modelMustNotSee: [inPrompt, "nowhere near this run", inPrompt],
      mustNotAppear: [couldLeave, couldLeave]
    }}, run);
    expect(problems).toEqual([
      "model saw a forbidden string (#0)", "model saw a forbidden string (#2)",
      "forbidden string could leave (#0)", "forbidden string could leave (#1)"
    ]);
  });

  it("flags too few statements and wrong outcomes", async () => {
    const fixture = parseFixture(load("01-work-english.json")) as Fixture;
    const lazy = createFakeModel([{activity_summary: "Nothing.", is_professional: false, user_demonstrated_something: false}]);
    expect(judgeReal(fixture, await runFixture(fixture, lazy))).toContain(`digest size 0 outside ${fixture.expectReal.digestMin}..${fixture.expectReal.digestMax}`);
    expect(judgeReal({...fixture, expect: {...fixture.expect, outcomes: ["excludedApp"]}}, await runFixture(fixture, scripted("01-work-english.json")))).toContain("outcomes differ");
  });
});
