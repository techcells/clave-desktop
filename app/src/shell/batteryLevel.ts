/** Parses `pmset -g batt` ("... 83%; discharging; ..."). `null` when there is no battery or the output is not understood. */
export function parsePmset(output: string): number | null {
  const match = /(\d{1,3})%/.exec(output);
  if (!match) return null;
  const percent = Number(match[1]);
  return percent >= 0 && percent <= 100 ? percent / 100 : null;
}

export const BATTERY_POLL_MS = 60_000;

/** Polls the battery level once a minute. `run` executes `pmset -g batt` and resolves with its output. */
export function watchBattery(run: () => Promise<string>): {level: () => number | null; onChange: (cb: () => void) => () => void; stop: () => void} {
  let level: number | null = null;
  const listeners = new Set<() => void>();
  const read = async () => {
    const next = parsePmset(await run().catch(() => ""));
    if (next !== level) { level = next; for (const cb of listeners) cb(); }
  };
  void read();
  const timer = setInterval(() => { void read(); }, BATTERY_POLL_MS);
  return {level: () => level, onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }, stop: () => clearInterval(timer)};
}
