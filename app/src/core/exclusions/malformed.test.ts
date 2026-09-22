import {describe, expect, it} from "vitest";
import {createExclusions} from "./index";
import type {FrontWindow} from "../types";

const x = createExclusions({exclusions: [], excludedSites: []});
const bad = (value: unknown) => value as FrontWindow;

describe("a malformed front window (the reader is another process)", () => {
  it.each([
    ["app missing", {title: "x"}],
    ["title missing", {app: "Code"}],
    ["app not text", {app: 7, title: "x"}],
    ["title not text", {app: "Code", title: null}],
    ["not an object", null],
    ["a string", "Code"]
  ])("%s is an unknown window, not a crash", (_why, value) => {
    expect(x.before(bad(value))).toBe("unknownWindow");
  });

  it("after() treats it the same way", () => {
    expect(x.after(bad({app: 7, title: "x"}), undefined)).toBe("unknownWindow");
    expect(x.after(bad(null), "chase.com")).toBe("unknownWindow");
  });
});
