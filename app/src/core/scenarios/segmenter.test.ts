import {describe, expect, it} from "vitest";
import {SCENARIO_AWAY_MS, SCENARIO_IDLE_MS, SCENARIO_MAX_MS} from "../constants";
import {createSegmenter} from "./segmenter";

const MIN = 60_000;

describe("segmenter", () => {
  it("opens on the first kept read and stays open while there is activity", () => {
    const s = createSegmenter();
    expect(s.isOpen()).toBe(false);
    s.activity(0); s.kept(0);
    expect(s.isOpen()).toBe(true);
    s.activity(4 * MIN);               // a read skipped as unchanged still counts as activity
    expect(s.tick(4 * MIN + 1)).toBeNull();
  });

  it("closes after five idle minutes, ending at the last activity", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN);
    expect(s.tick(1 * MIN + SCENARIO_IDLE_MS - 1)).toBeNull();
    expect(s.tick(1 * MIN + SCENARIO_IDLE_MS)).toEqual({openedAt: 0, closedAt: 1 * MIN, reason: "idle"});
    expect(s.isOpen()).toBe(false);
  });

  it("closes after two minutes spent only in excluded windows", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN); s.captureAllowed(1 * MIN, false);
    s.activity(2 * MIN); s.captureAllowed(2 * MIN, false);
    expect(s.tick(1 * MIN + SCENARIO_AWAY_MS)).toEqual({openedAt: 0, closedAt: 1 * MIN, reason: "away"});
  });

  it("an allowed capture ends the away streak", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN); s.captureAllowed(1 * MIN, false);
    s.activity(2 * MIN); s.captureAllowed(2 * MIN, true);
    expect(s.tick(1 * MIN + SCENARIO_AWAY_MS)).toBeNull();
  });

  it("closes at the ten minute cap even under constant activity", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    for (let t = MIN; t < SCENARIO_MAX_MS; t += MIN) { s.activity(t); s.captureAllowed(t, true); }
    expect(s.tick(SCENARIO_MAX_MS)).toEqual({openedAt: 0, closedAt: SCENARIO_MAX_MS, reason: "cap"});
  });

  it("closes immediately when capture is switched off", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    expect(s.off(90_000)).toEqual({openedAt: 0, closedAt: 90_000, reason: "off"});
    expect(s.off(91_000)).toBeNull();
  });

  it("closes when the screen stays locked longer than the idle limit", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.locked(30_000);
    expect(s.tick(30_000 + SCENARIO_IDLE_MS)).toBeNull();
    expect(s.tick(30_000 + SCENARIO_IDLE_MS + 1)).toEqual({openedAt: 0, closedAt: 30_000, reason: "locked"});
  });

  it("a short lock does not close the scenario", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.locked(30_000); s.unlocked(60_000); s.activity(60_000);
    expect(s.tick(61_000)).toBeNull();
    expect(s.isOpen()).toBe(true);
  });
});
