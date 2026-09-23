// Hardening of the built bundle (packaging design, sections 5.1 and 5.2): the Electron fuse table
// and the per-file entitlement sets. Pure tables and decisions; the one impure function flips the
// fuses on a bundle and reads them back. Nothing runs at import.
import {posix} from "node:path";

/**
 * The fuse table. Every fuse @electron/fuses 2.1.3 knows is named, and `fuseConfig` refuses a fuse
 * the tool knows and this table does not (a future Electron adds one: decide, do not inherit).
 * WasmTrapHandlers is Electron's default (on); it has nothing to do with Node or the asar.
 */
export const FUSE_TABLE = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  // MEASURED 2026-09-22 (second packaged launch): with this fuse OFF the window stayed white. The
  // renderer is a file:// page (index.html with its own script and stylesheet beside it inside the
  // asar); Electron's documentation calls the privileges this fuse governs "incompletely documented",
  // and the observed effect is that the page's own subresources or its CSP 'self' no longer resolve.
  // Kept at Electron's default until the renderer is served from a custom protocol (an app.ts change
  // owned by another session), which is Electron's recommended way and would let it go off again.
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true
};

/**
 * The config object `flipFuses` takes, built from the tool's own enums so an index can never be guessed.
 * The fuse table is the same on every system; only macOS has an ad-hoc signature to redo after the
 * binary changes, so `resetAdHocDarwinSignature` is set there alone.
 */
export function fuseConfig(FuseV1Options, FuseVersion, platform = "darwin") {
  const known = Object.entries(FuseV1Options).filter(([, v]) => typeof v === "number");
  const config = {version: FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: platform === "darwin"};
  for (const [name, index] of known) {
    if (!Object.hasOwn(FUSE_TABLE, name)) throw new Error(`FUSE_UNLISTED ${name}`);
    config[index] = FUSE_TABLE[name];
  }
  for (const name of Object.keys(FUSE_TABLE)) {
    if (!known.some(([n]) => n === name)) throw new Error(`FUSE_UNKNOWN ${name}`);
  }
  return config;
}

/** Compares a fuse wire read back from the binary with the table: every fuse set, and set as decided. */
export function checkFuseWire(wire, FuseV1Options, FuseState) {
  const problems = [];
  for (const [name, wanted] of Object.entries(FUSE_TABLE)) {
    const index = FuseV1Options[name];
    const state = wire[index];
    const expected = wanted ? FuseState.ENABLE : FuseState.DISABLE;
    if (state !== expected) problems.push({code: "FUSE_WRONG", detail: name});
  }
  return problems;
}

const JIT = "com.apple.security.cs.allow-jit";
const UNSIGNED_MEMORY = "com.apple.security.cs.allow-unsigned-executable-memory";
const NO_LIBRARY_VALIDATION = "com.apple.security.cs.disable-library-validation";

/**
 * The reduction ladder for the main executable (design 5.2), measured in Task 5 from level 0 up:
 * the smallest level under which the window opens, the model answers and the helper reads a staged
 * window is the one shipped.
 */
export const ENTITLEMENT_LEVELS = [
  [JIT, UNSIGNED_MEMORY, NO_LIBRARY_VALIDATION],
  [JIT, UNSIGNED_MEMORY],
  [JIT]
];

/** Never emitted for any file at any level: the app captures no sound or picture, drives nothing, listens on nothing. */
export const FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.device.camera", "com.apple.security.device.microphone", "com.apple.security.device.audio-input",
  "com.apple.security.device.bluetooth", "com.apple.security.device.usb", "com.apple.security.device.print",
  "com.apple.security.personal-information.location", "com.apple.security.personal-information.photos-library",
  "com.apple.security.personal-information.addressbook", "com.apple.security.personal-information.calendars",
  "com.apple.security.automation.apple-events", "com.apple.security.network.server", "com.apple.security.app-sandbox",
  "com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.debugger", "com.apple.security.get-task-allow"
];

/**
 * The entitlement keys for one file osx-sign is about to sign (it asks for every binary it finds,
 * for each helper .app and framework, and for the app itself). Strings only, all `true`.
 *   the app and its main executable      the ladder level
 *   the helper clave-reader              none: a plain Mach-O with no JIT and only system frameworks
 *   Electron Helper (Plugin)             what the plugin helper needs to load code it did not sign
 *   the other Electron helpers           JIT for V8
 *   everything else (frameworks, dylibs, .node, .so)   none: entitlements belong to executables
 *
 * `teamId`: whether the signing identity carries a Team ID (a Developer ID does; the self-signed
 * development certificate does not). MEASURED 2026-09-22 on the first launch of a packaged build:
 * under the hardened runtime, dyld's library validation refuses our own Electron Framework in a
 * process whose signature has no Team ID ("mapping process and mapped file have different Team IDs",
 * the helper apps died at launch), so without a Team ID every executable that loads the framework
 * must carry `disable-library-validation`, and the ladder above level 0 is not measurable at all.
 */
export function entitlementsFor(filePath, level, appName, {teamId = true} = {}) {
  if (!Number.isInteger(level) || level < 0 || level >= ENTITLEMENT_LEVELS.length) throw new Error("BAD_LEVEL");
  if (typeof appName !== "string" || !appName.trim()) throw new Error("BAD_APP_NAME");
  if (!teamId && level !== 0) throw new Error("LEVEL_NEEDS_TEAM_ID");
  const path = filePath.split("\\").join("/");
  const withoutTeam = (keys) => (teamId || keys.includes(NO_LIBRARY_VALIDATION) ? keys : [...keys, NO_LIBRARY_VALIDATION]);
  if (path.endsWith(`${appName}.app`) || path.endsWith(`${appName}.app/Contents/MacOS/${appName}`)) return withoutTeam([...ENTITLEMENT_LEVELS[level]]);
  if (path.endsWith("/Contents/MacOS/clave-reader")) return [];
  if (path.includes("(Plugin).app")) return [JIT, UNSIGNED_MEMORY, NO_LIBRARY_VALIDATION];
  // The other helper apps are named "<app> Helper.app", "<app> Helper (GPU).app", "<app> Helper (Renderer).app".
  if (path.includes(`${appName} Helper`)) return withoutTeam([JIT]);
  return [];
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

/**
 * Flips the fuses on a bundle and reads them back. Returns `{wire}` or `{error, detail}`. `appPath` is
 * the .app on macOS and the app's own .exe on Windows, which is where Electron keeps its fuse wire.
 */
export async function flip(appPath, platform = "darwin") {
  const fuses = await import("@electron/fuses");
  let config;
  try { config = fuseConfig(fuses.FuseV1Options, fuses.FuseVersion, platform); } catch (error) { return {error: error instanceof Error ? error.message.split(" ")[0] : "FUSE_TABLE_INVALID", detail: error instanceof Error ? error.message : ""}; }
  try { await fuses.flipFuses(appPath, config); } catch (error) { return {error: "FUSE_FLIP_FAILED", detail: error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : ""}; }
  const wire = await fuses.getCurrentFuseWire(appPath);
  const problems = checkFuseWire(wire, fuses.FuseV1Options, fuses.FuseState);
  if (problems.length > 0) return {error: "FUSE_READBACK_WRONG", detail: problems.map((p) => p.detail).join(",")};
  const named = {};
  for (const name of Object.keys(FUSE_TABLE)) named[name] = wire[fuses.FuseV1Options[name]] === fuses.FuseState.ENABLE;
  return {wire: named};
}
