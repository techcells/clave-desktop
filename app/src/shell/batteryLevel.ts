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

/**
 * Linux: the first system battery's charge from `/sys/class/power_supply`, printed as `NN%` so the
 * same parser reads it; empty when there is none. A battery whose `scope` is `Device` belongs to a
 * mouse or a keyboard and is not the computer's. No subprocess: the kernel's own files.
 */
export async function linuxBatteryOutput(sysfs: {
  list(): Promise<string[]>;
  read(name: string, file: string): Promise<string>;
}): Promise<string> {
  let names: string[];
  try { names = await sysfs.list(); } catch { return ""; }
  for (const name of [...names].sort()) {
    const type = await sysfs.read(name, "type").catch(() => "");
    if (type.trim() !== "Battery") continue;
    const scope = await sysfs.read(name, "scope").catch(() => "");
    if (scope.trim() === "Device") continue;
    const capacity = (await sysfs.read(name, "capacity").catch(() => "")).trim();
    if (/^\d{1,3}$/.test(capacity)) return `${capacity}%`;
  }
  return "";
}
