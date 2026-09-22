/**
 * Every environment variable the app reads is a DEVELOPMENT switch: stand-ins instead of the real
 * reader and backend, the real native reader beside the stand-in backend, a scripted model instead of the 2.7 GB file, the unattended smoke run, a
 * throwaway data folder, a fixture folder, a different model URL. None of them may have any effect
 * in a packaged build, so they are all read here and here only, and this function answers
 * `undefined` for every one of them once the app is packaged. Pure, so the rule is tested without
 * Electron.
 */
export const DEV_SWITCHES = [
  "CLAVE_STANDINS", "CLAVE_SCRIPTED_MODEL", "CLAVE_SMOKE", "CLAVE_DATA_DIR", "CLAVE_FIXTURES", "CLAVE_MODEL_URL", "CLAVE_REAL_READER"
] as const;
export type DevSwitch = typeof DEV_SWITCHES[number];
export type DevEnv = Readonly<Record<DevSwitch, string | undefined>>;

export function devEnv(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean): DevEnv {
  const read: Record<string, string | undefined> = {};
  // Own properties only: nothing reached through a prototype counts as a switch that was set.
  for (const name of DEV_SWITCHES) read[name] = isPackaged || !Object.hasOwn(env, name) ? undefined : env[name];
  return read as DevEnv;
}
