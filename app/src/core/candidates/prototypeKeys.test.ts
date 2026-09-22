import {describe, expect, it} from "vitest";
import {hintPresent, strictnessOf} from "./ambiguous";
import {buildSkillIndex, findCandidates} from "./index";
import type {Scenario} from "../types";

const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("skill names that collide with Object.prototype", () => {
  it.each(NAMES)("%s is an ordinary name, not an ambiguous one", (name) => {
    expect(strictnessOf(name.toLowerCase())).toBe("plain");
    expect(hintPresent(name.toLowerCase(), "anything at all")).toBe(false);
  });

  it("does not throw while matching a taxonomy that contains them", () => {
    const index = buildSkillIndex(NAMES.map((n, i) => ({id: `s${i}`, displayName: n, canonicalName: n.toLowerCase(), aliases: []})));
    const text = "Refactored the constructor and the toString helper in the parser module.";
    const scenario: Scenario = {id: "s", openedAt: 0, closedAt: 1, blocks: [{app: "Code", title: "parser.ts", text, at: 0}], text};
    expect(() => findCandidates(index, scenario)).not.toThrow();
    expect(findCandidates(index, scenario).map((o) => o.name)).toContain("constructor");
  });
});
