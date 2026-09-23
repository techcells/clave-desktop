import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BATTERY_POLL_MS, linuxBatteryOutput, parsePmset, watchBattery} from "./batteryLevel";

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

describe("battery on Linux", () => {
  const sysfs = (entries: Record<string, Record<string, string>>) => ({
    list: async () => Object.keys(entries),
    read: async (name: string, file: string) => {
      const value = entries[name]?.[file];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    }
  });

  it("reads the first battery's capacity as the same NN% the other platforms print", async () => {
    const output = await linuxBatteryOutput(sysfs({AC: {type: "Mains\n"}, BAT0: {type: "Battery\n", capacity: "83\n"}}));
    expect(output).toBe("83%");
    expect(parsePmset(output)).toBe(0.83);
  });

  it("is empty with no battery, an unreadable one, or no power supplies at all", async () => {
    expect(await linuxBatteryOutput(sysfs({AC: {type: "Mains\n"}}))).toBe("");
    expect(await linuxBatteryOutput(sysfs({BAT0: {type: "Battery\n"}}))).toBe("");
    expect(await linuxBatteryOutput(sysfs({BAT0: {type: "Battery\n", capacity: "lots"}}))).toBe("");
    expect(await linuxBatteryOutput({list: async () => { throw new Error("ENOENT"); }, read: async () => ""})).toBe("");
  });

  it("ignores a peripheral's battery (a mouse reports its own scope)", async () => {
    // Sorted first on purpose, so the rule has to skip it rather than never reach it.
    const output = await linuxBatteryOutput(sysfs({
      BAT0: {type: "Battery\n", scope: "Device\n", capacity: "40\n"},
      BAT1: {type: "Battery\n", capacity: "61\n"}
    }));
    expect(output).toBe("61%");
  });

  it("reads only batteries, whatever else reports a capacity", async () => {
    const output = await linuxBatteryOutput(sysfs({AC: {type: "Mains\n", capacity: "100\n"}, BAT0: {type: "Battery\n", capacity: "83\n"}}));
    expect(output).toBe("83%");
  });
});
