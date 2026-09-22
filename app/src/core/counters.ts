import type {Counters} from "./types";

export interface CountersApi {
  inc(name: string, by?: number): void;
  snapshot(): Counters;
  reset(): void;
}

export function createCounters(): CountersApi {
  let values: Counters = {};
  return {
    inc(name, by = 1) { values[name] = (values[name] ?? 0) + by; },
    snapshot() { return {...values}; },
    reset() { values = {}; }
  };
}
