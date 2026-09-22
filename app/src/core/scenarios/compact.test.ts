import {describe, expect, it} from "vitest";
import {SCENARIO_MAX_CHARS} from "../constants";
import {compact, lineOverlap} from "./compact";

const lines = (prefix: string, n: number) => Array.from({length: n}, (_, i) => `${prefix} line ${i} with some words`).join("\n");
const read = (app: string, title: string, text: string, at: number) => ({app, title, text, at});
const meta = {id: "s1", openedAt: 0, closedAt: 600_000};

describe("lineOverlap", () => {
  it("is 1 for identical text and 0 for disjoint text", () => {
    expect(lineOverlap("a\nb\nc", "a\nb\nc")).toBe(1);
    expect(lineOverlap("a\nb", "c\nd")).toBe(0);
  });
  it("is measured against the smaller side", () => {
    expect(lineOverlap("a\nb", "a\nb\nc\nd")).toBe(1);
  });
});

describe("compact", () => {
  it("drops a scenario with too little text", () => {
    expect(compact([read("Code", "a.ts", "x".repeat(120), 1)], meta)).toBeNull();
  });

  it("labels blocks, orders them by time, and keeps the latest read of each window", () => {
    const scenario = compact([
      read("Slack", "#backend", lines("slack", 20), 10),
      read("Code", "order.ts", lines("code-v1", 20), 20),
      read("Code", "order.ts", lines("code-v2", 20), 30)
    ], meta)!;
    expect(scenario.blocks.map((b) => `${b.app}@${b.at}`)).toEqual(["Slack@10", "Code@20", "Code@30"]);
    expect(scenario.text).toContain("[Slack — #backend]");
    expect(scenario.text).toContain("[Code — order.ts]");
    expect(scenario.id).toBe("s1");
  });

  it("drops earlier snapshots that mostly repeat a kept one", () => {
    const base = lines("same", 20);
    const scenario = compact([
      read("Code", "a.ts", base, 10),
      read("Code", "a.ts", base + "\nplus one new line here", 20)
    ], meta)!;
    expect(scenario.blocks.length).toBe(1);
    expect(scenario.blocks[0]!.at).toBe(20);
  });

  it("keeps at most three earlier snapshots per window", () => {
    const reads = Array.from({length: 8}, (_, i) => read("Code", "a.ts", lines(`v${i}`, 20), i + 1));
    expect(compact(reads, meta)!.blocks.length).toBe(4);
  });

  it("trims the oldest blocks to stay under the size cap", () => {
    const big = (tag: string) => lines(tag, 400);
    const scenario = compact([
      read("A", "1", big("a"), 1), read("B", "2", big("b"), 2), read("C", "3", big("c"), 3)
    ], meta)!;
    expect(scenario.text.length).toBeLessThanOrEqual(SCENARIO_MAX_CHARS);
    expect(scenario.blocks.at(-1)!.app).toBe("C");
  });
});
