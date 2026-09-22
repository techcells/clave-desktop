import {LOW_BATTERY_LEVEL} from "./constants";

export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";

/** Electron `powerMonitor` in the app. */
export interface PowerSource {
  onBattery(): boolean;
  /** 0 to 1, or `null` when the machine has no battery or the level is unknown. */
  batteryLevel(): number | null;
  thermalState(): ThermalState;
  /** Called whenever any of the above may have changed. Returns the function that unsubscribes. */
  subscribe(cb: () => void): () => void;
}

export type PauseReason = "lowBattery" | "thermal";

export function pauseReason(source: PowerSource): PauseReason | null {
  const thermal = source.thermalState();
  if (thermal === "serious" || thermal === "critical") return "thermal";
  const level = source.batteryLevel();
  if (source.onBattery() && level !== null && level < LOW_BATTERY_LEVEL) return "lowBattery";
  return null;
}

export interface PowerGuards {
  paused(): PauseReason | null;
  stop(): void;
}

/**
 * Tells the owner when extraction must pause or may resume. Capture itself is never paused by power.
 * `onChange` is never called during construction: a pause already in force at start is reported only
 * through `guards.paused()`, which the caller must read right after creating the guards.
 */
export function watchPower(source: PowerSource, onChange: (reason: PauseReason | null) => void): PowerGuards {
  let current = pauseReason(source);
  const unsubscribe = source.subscribe(() => {
    const next = pauseReason(source);
    if ((next === null) === (current === null)) { current = next; return; }
    current = next;
    onChange(next);
  });
  return {paused: () => current, stop: unsubscribe};
}
