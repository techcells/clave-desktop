import {describe, expect, it} from "vitest";
import type {Scenario, Skill} from "../types";
import {buildSkillIndex, findCandidates, offeredFor} from "./index";
import {normalisePhrase, tokenize} from "./normalise";

const skill = (id: string, displayName: string, aliases: string[] = []): Skill =>
  ({id, displayName, canonicalName: displayName.toLowerCase(), aliases});

const SKILLS = [
  skill("pg", "PostgreSQL", ["Postgres", "psql"]), skill("redis", "Redis"), skill("node", "Node.js", ["NodeJS"]),
  skill("cpp", "C++"), skill("cs", "C#"), skill("ml", "Machine Learning"), skill("go", "Go", ["Golang"]),
  skill("react", "React", ["React.js"]), skill("aws", "AWS"), skill("r", "R"), skill("k8s", "Kubernetes")
];
const index = buildSkillIndex(SKILLS);

const scenario = (...texts: string[]): Scenario => ({
  id: "s", openedAt: 0, closedAt: 1,
  blocks: texts.map((text, i) => ({app: `App${i}`, title: `T${i}`, text, at: i})),
  text: texts.join("\n\n")
});
const ids = (s: Scenario) => findCandidates(index, s).map((o) => o.id);

describe("tokenize", () => {
  it("keeps + # and inner dots, drops trailing punctuation, splits on hyphens", () => {
    expect(tokenize("Use C++, C# and Node.js. Postgres-backed!").map((t) => t.raw))
      .toEqual(["Use", "C++", "C#", "and", "Node.js", "Postgres", "backed"]);
  });
  it("normalises a phrase the same way as text", () => {
    expect(normalisePhrase("  Machine   Learning ")).toBe("machine learning");
  });
});

describe("findCandidates", () => {
  it("matches names and aliases case-insensitively", () => {
    expect(ids(scenario("postgres falls back to a sequential scan; cached in REDIS"))).toEqual(expect.arrayContaining(["pg", "redis"]));
  });

  it("matches symbols and multi-word names", () => {
    expect(ids(scenario("ported the C++ solver, some C# glue, a machine learning model on Node.js")))
      .toEqual(expect.arrayContaining(["cpp", "cs", "ml", "node"]));
  });

  it("does not match inside another word", () => {
    expect(ids(scenario("a redistribution of predispositions"))).toEqual([]);
  });

  it("needs a hint for ambiguous names", () => {
    expect(ids(scenario("I will Go home and React to the news"))).toEqual([]);
    expect(ids(scenario("Rewrote the worker in Go. Ran go build and go test ./..."))).toContain("go");
    expect(ids(scenario("Moved the form to React with useState and useEffect hooks"))).toContain("react");
  });

  it("needs exact casing for short names and a hint for single letters", () => {
    expect(ids(scenario("deployed to AWS last night"))).toContain("aws");
    expect(ids(scenario("the paws and jaws of it"))).toEqual([]);
    expect(ids(scenario("plotted it in R with ggplot and dplyr"))).toContain("r");
    expect(ids(scenario("Section R of the contract"))).toEqual([]);
  });

  it("ranks by occurrences, with a bonus for appearing in more than one window", () => {
    const s = scenario("Kubernetes Kubernetes Kubernetes", "Redis", "Redis again");
    expect(ids(s).slice(0, 2)).toEqual(["redis", "k8s"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(findCandidates(index, scenario("lunch plans and a birthday cake"))).toEqual([]);
  });
});

describe("offeredFor", () => {
  it("offers candidate skills and then every competency", () => {
    const offered = offeredFor(index, [{id: "cp1", name: "Problem Solving", description: "Breaks problems down"}], scenario("tuned Redis"));
    expect(offered).toEqual([
      {id: "redis", kind: "skill", name: "Redis"},
      {id: "cp1", kind: "competency", name: "Problem Solving", description: "Breaks problems down"}
    ]);
  });
});
