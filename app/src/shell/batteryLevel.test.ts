import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BATTERY_POLL_MS, parsePmset, watchBattery} from "./batteryLevel";

describe("battery level", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads the percentage out of pmset's output", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t83%; discharging; 4:12 remaining present: true")).toBe(0.83);
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged; 0:00 remaining")).toBe(1);
    expect(parsePmset("Now drawing from 'AC Power'")).toBeNull();
    expect(parsePmset("")).toBeNull();
  });

  it("polls once a minute, tells listeners only on a change, and survives a failing command", async () => {
    const outputs = ["\t50%;", "\t50%;", "\t19%;"];
    const changes = vi.fn();
    const battery = watchBattery(async () => { const next = outputs.shift(); if (next === undefined) throw new Error("pmset missing"); return next; });
    battery.onChange(changes);
    await vi.advanceTimersByTimeAsync(0);
    expect(battery.level()).toBe(0.5);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(changes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(battery.level()).toBe(0.19);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(battery.level()).toBeNull();
    battery.stop();
  });
});
