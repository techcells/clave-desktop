import {describe, expect, it} from "vitest";
import {createBuffer} from "./buffer";
import {BUFFER_MAX_AGE_MS} from "./constants";

const long = (seed: string) => `${seed} `.repeat(20);
const read = (app: string, title: string, text: string, at: number) => ({app, title, text, at});

describe("buffer", () => {
  it("keeps a read and rejects text that is too short", () => {
    const b = createBuffer();
    expect(b.accept(read("Code", "a.ts", long("alpha"), 1))).toBe("kept");
    expect(b.accept(read("Code", "a.ts", "tiny", 2))).toBe("empty");
    expect(b.size()).toBe(1);
  });

  it("skips an identical consecutive read of the same window", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1));
    expect(b.accept(read("Code", "a.ts", long("alpha"), 2))).toBe("unchanged");
    expect(b.accept(read("Code", "a.ts", long("beta"), 3))).toBe("kept");
  });

  it("forgets the fingerprint when focus moves to another window", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1));
    b.accept(read("Slack", "#general", long("hello"), 2));
    expect(b.accept(read("Code", "a.ts", long("alpha"), 3))).toBe("kept");
  });

  it("expires reads older than sixty minutes", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1_000));
    b.accept(read("Code", "b.ts", long("beta"), 2_000_000));
    expect(b.expire(1_000 + BUFFER_MAX_AGE_MS + 1)).toBe(1);
    expect(b.oldestAt()).toBe(2_000_000);
  });

  it("returns and drops a time range", () => {
    const b = createBuffer();
    b.accept(read("A", "1", long("one"), 10));
    b.accept(read("B", "2", long("two"), 20));
    b.accept(read("C", "3", long("three"), 30));
    expect(b.range(10, 20).map((r) => r.app)).toEqual(["A", "B"]);
    b.dropRange(10, 20);
    expect(b.size()).toBe(1);
    b.clear();
    expect(b.size()).toBe(0);
    expect(b.oldestAt()).toBeNull();
  });
});
