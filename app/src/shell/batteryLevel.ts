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
 * Linux: the computer's charge from `/sys/class/power_supply`, printed as `NN%` so the same parser
 * reads it; empty when there is no battery. A battery whose `scope` is `Device` belongs to a mouse
 * or a keyboard and is not the computer's. With two batteries (some ThinkPads) the charge is the
 * energy held over the energy they can hold, as UPower reports it, when every battery gives the same
 * kind of amount (`energy_*` in µWh, or `charge_*` in µAh); otherwise the mean of their percentages.
 * No subprocess: the kernel's own files.
 */
export async function linuxBatteryOutput(sysfs: {
  list(): Promise<string[]>;
  read(name: string, file: string): Promise<string>;
}): Promise<string> {
  let names: string[];
  try { names = await sysfs.list(); } catch { return ""; }
  const whole = async (name: string, file: string): Promise<number | null> => {
    const text = (await sysfs.read(name, file).catch(() => "")).trim();
    return /^\d{1,15}$/.test(text) ? Number(text) : null;
  };
  const batteries: {capacity: number; energy: [number, number] | null; charge: [number, number] | null}[] = [];
  for (const name of names) {
    const type = await sysfs.read(name, "type").catch(() => "");
    if (type.trim() !== "Battery") continue;
    const scope = await sysfs.read(name, "scope").catch(() => "");
    if (scope.trim() === "Device") continue;
    const capacity = (await sysfs.read(name, "capacity").catch(() => "")).trim();
    if (!/^\d{1,3}$/.test(capacity)) continue;
    const pair = async (kind: string): Promise<[number, number] | null> => {
      const [now, full] = [await whole(name, `${kind}_now`), await whole(name, `${kind}_full`)];
      return now !== null && full !== null ? [now, full] : null;
    };
    batteries.push({capacity: Number(capacity), energy: await pair("energy"), charge: await pair("charge")});
  }
  if (batteries.length === 0) return "";
  for (const kind of ["energy", "charge"] as const) {
    const pairs = batteries.flatMap((battery) => (battery[kind] ? [battery[kind]] : []));
    const [now, full] = pairs.reduce(([n, f], [pairNow, pairFull]) => [n + pairNow, f + pairFull], [0, 0]);
    if (pairs.length === batteries.length && full > 0) return `${Math.min(100, Math.round((now / full) * 100))}%`;
  }
  return `${Math.round(batteries.reduce((sum, battery) => sum + battery.capacity, 0) / batteries.length)}%`;
}
