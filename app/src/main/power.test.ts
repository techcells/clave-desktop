import {describe, expect, it, vi} from "vitest";
import {pauseReason, watchPower, type PowerSource, type ThermalState} from "./power";

function fakePower(init: {onBattery: boolean; level: number | null; thermal: ThermalState}) {
  const state = {...init};
  const listeners = new Set<() => void>();
  const source: PowerSource = {
    onBattery: () => state.onBattery, batteryLevel: () => state.level, thermalState: () => state.thermal,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
  return {source, set(patch: Partial<typeof state>) { Object.assign(state, patch); for (const cb of listeners) cb(); }, listeners};
}

describe("power guards", () => {
  it("pauses under 20% only while unplugged", () => {
    expect(pauseReason(fakePower({onBattery: true, level: 0.19, thermal: "nominal"}).source)).toBe("lowBattery");
    expect(pauseReason(fakePower({onBattery: true, level: 0.2, thermal: "nominal"}).source)).toBeNull();
    expect(pauseReason(fakePower({onBattery: false, level: 0.05, thermal: "nominal"}).source)).toBeNull();
    expect(pauseReason(fakePower({onBattery: true, level: null, thermal: "nominal"}).source)).toBeNull();
  });

  it("pauses on serious or critical thermal state, plugged in or not", () => {
    expect(pauseReason(fakePower({onBattery: false, level: 1, thermal: "serious"}).source)).toBe("thermal");
    expect(pauseReason(fakePower({onBattery: false, level: 1, thermal: "critical"}).source)).toBe("thermal");
    expect(pauseReason(fakePower({onBattery: false, level: 1, thermal: "fair"}).source)).toBeNull();
    expect(pauseReason(fakePower({onBattery: false, level: 1, thermal: "unknown"}).source)).toBeNull();
  });

  it("reports only the transitions between paused and running", () => {
    const power = fakePower({onBattery: true, level: 0.5, thermal: "nominal"});
    const onChange = vi.fn();
    const guards = watchPower(power.source, onChange);
    power.set({level: 0.4});
    expect(onChange).not.toHaveBeenCalled();
    power.set({level: 0.1});
    power.set({thermal: "serious"});              // still paused: no second call
    expect(onChange.mock.calls).toEqual([["lowBattery"]]);
    expect(guards.paused()).toBe("thermal");
    power.set({onBattery: false, thermal: "nominal"});
    expect(onChange.mock.calls).toEqual([["lowBattery"], [null]]);
  });

  it("does not call onChange during construction: the caller reads guards.paused() for a pause already in force at start, then stops listening", () => {
    const power = fakePower({onBattery: false, level: 1, thermal: "critical"});
    const onChange = vi.fn();
    const guards = watchPower(power.source, onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(guards.paused()).toBe("thermal");
    guards.stop();
    expect(power.listeners.size).toBe(0);
  });
});
