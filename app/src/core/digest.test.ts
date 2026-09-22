import {describe, expect, it} from "vitest";
import {DIGEST_ITEM_TTL_DAYS, DIGEST_PER_DAY, DIGEST_PER_TARGET} from "./constants";
import {createCounters} from "./counters";
import {createDigest} from "./digest";

const DAY = 86_400_000;
function setup(start = Date.UTC(2026, 8, 17, 9)) {
  let now = start;
  let n = 0;
  const counters = createCounters();
  const digest = createDigest({
    clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)},
    newId: () => `id${++n}`, counters, taxonomyVersion: () => "tax-7"
  });
  return {digest, counters, advance: (ms: number) => { now += ms; }};
}
const skill = (targetId: string, statement: string) => ({targetId, kind: "skill" as const, statement});
const distinct = (i: number) => `Resolved problem number${i} using technique${i} on system${i} while coordinating rollout${i} safely`;

describe("digest", () => {
  it("stamps every item", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Traced a latency regression to a missing index and rebuilt it without blocking writes."));
    expect(digest.list()).toEqual([{
      id: "id1", kind: "skill", targetId: "pg", createdAt: Date.UTC(2026, 8, 17, 9),
      statement: "Traced a latency regression to a missing index and rebuilt it without blocking writes.",
      taxonomyVersion: "tax-7", pipelineVersion: "1"
    }]);
  });

  it("merges near-duplicates for the same target and keeps the more specific one", () => {
    const {digest, counters} = setup();
    expect(digest.add(skill("pg", "Traced a latency regression to a missing index."))).toBe("added");
    expect(digest.add(skill("pg", "Traced a latency regression to a missing index and rebuilt it without blocking production writes."))).toBe("merged");
    expect(digest.list().map((i) => i.statement)).toEqual(["Traced a latency regression to a missing index and rebuilt it without blocking production writes."]);
    expect(counters.snapshot()["digest.merged"]).toBe(1);
  });

  it("does not merge across different targets", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Traced a latency regression to a missing index."));
    digest.add(skill("redis", "Traced a latency regression to a missing index."));
    expect(digest.list().length).toBe(2);
  });

  it("shows at most two per target, preferring the most specific", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Tuned a query planner setting."));
    digest.add(skill("pg", distinct(1)));
    digest.add(skill("pg", distinct(2)));
    const shown = digest.list();
    expect(shown.length).toBe(DIGEST_PER_TARGET);
    expect(shown.map((i) => i.statement)).not.toContain("Tuned a query planner setting.");
  });

  it("caps the day and spreads across targets before doubling up", () => {
    const {digest} = setup();
    for (let i = 0; i < 8; i++) { digest.add(skill(`t${i}`, distinct(i))); digest.add(skill(`t${i}`, distinct(100 + i))); }
    const shown = digest.list();
    expect(shown.length).toBe(DIGEST_PER_DAY);
    expect(new Set(shown.map((i) => i.targetId)).size).toBe(8);
  });

  it("counts resolved items against the day's cap", () => {
    const {digest} = setup();
    for (let i = 0; i < 14; i++) digest.add(skill(`t${i}`, distinct(i)));
    const first = digest.list();
    expect(first.length).toBe(10);
    for (const item of first.slice(0, 4)) expect(digest.resolve(item.id)).toBe(true);
    expect(digest.list().length).toBe(6);
    expect(digest.resolve("nope")).toBe(false);
  });

  it("at day rollover carries what was shown and drops the rest", () => {
    const {digest, counters, advance} = setup();
    for (let i = 0; i < 14; i++) digest.add(skill(`t${i}`, distinct(i)));
    const shown = digest.list().map((i) => i.id);
    advance(DAY); digest.tick();
    expect(digest.list().map((i) => i.id).sort()).toEqual([...shown].sort());
    expect(counters.snapshot()["digest.capped"]).toBe(4);
  });

  it("expires carried items after the time-to-live", () => {
    const {digest, counters, advance} = setup();
    digest.add(skill("pg", distinct(1)));
    advance(DAY); digest.tick();
    expect(digest.list().length).toBe(1);
    advance(DIGEST_ITEM_TTL_DAYS * DAY); digest.tick();
    expect(digest.list()).toEqual([]);
    expect(counters.snapshot()["digest.expired"]).toBe(1);
  });

  it("never exceeds its caps whatever is added (property check)", () => {
    const {digest} = setup();
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 300; i++) {
      digest.add(skill(`t${rand(12)}`, distinct(rand(1000))));
      const shown = digest.list();
      expect(shown.length).toBeLessThanOrEqual(DIGEST_PER_DAY);
      const perTarget = new Map<string, number>();
      for (const item of shown) perTarget.set(item.targetId, (perTarget.get(item.targetId) ?? 0) + 1);
      expect(Math.max(0, ...perTarget.values())).toBeLessThanOrEqual(DIGEST_PER_TARGET);
    }
  });

  it("round-trips through export and import, rejecting anything malformed or expired", () => {
    const a = setup();
    a.digest.add(skill("pg", distinct(1)));
    const exported = a.digest.exportPool();
    const b = setup();
    const stale = {...exported[0]!, id: "old", createdAt: Date.UTC(2026, 8, 1)};
    expect(b.digest.importPool([...exported, {id: 1}, "junk", stale])).toEqual({accepted: 1, rejected: 3});
    expect(b.digest.list().map((i) => i.statement)).toEqual([distinct(1)]);
    expect(b.digest.importPool("not a list")).toEqual({accepted: 0, rejected: 0});
  });
});
