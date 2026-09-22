import {describe, expect, it} from "vitest";
import {createCounters} from "./counters";

describe("counters", () => {
  it("starts empty and counts by name", () => {
    const c = createCounters();
    c.inc("reads.kept");
    c.inc("reads.kept");
    c.inc("reads.skipped.unchanged", 3);
    expect(c.snapshot()).toEqual({"reads.kept": 2, "reads.skipped.unchanged": 3});
  });

  it("returns a copy, not the live object", () => {
    const c = createCounters();
    c.inc("x");
    const snap = c.snapshot();
    snap.x = 99;
    expect(c.snapshot().x).toBe(1);
  });

  it("resets", () => {
    const c = createCounters();
    c.inc("x");
    c.reset();
    expect(c.snapshot()).toEqual({});
  });
});
