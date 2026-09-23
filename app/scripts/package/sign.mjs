// Hardens and signs a built bundle (scripts/package/bundle.mjs): flips the fuses, then signs every
// Mach-O inside out with @electron/osx-sign under the per-file entitlements of harden.mjs, then
// verifies. Run from the repo root:
//   pnpm --dir app package:sign -- --flavour internal [--sign "<identity name>"] [--level 0|1|2] [--out <dir>]
// Without --sign only the fuses are flipped (an internal build may stay unsigned on the owner's
// machine; a release build refuses). The identity is a NAME looked up in the keychain; nothing
// secret is read, printed or stored. A release build accepts a "Developer ID Application" identity
// only; an internal build also accepts the self-signed development certificate.
//
// Pure decisions live above the line and are tested in sign.test.ts; nothing runs at import.
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir, tmpdir} from "node:os";
import {dirname, join, posix} from "node:path";
import {fileURLToPath} from "node:url";
import {runningAppCheck} from "../dev-bundle.mjs";
import {ENTITLEMENT_LEVELS, entitlementsFor, flip, FORBIDDEN_ENTITLEMENTS} from "./harden.mjs";
import {runningProbe} from "./bundle.mjs";
import {requestedFlavour, resolveOut} from "./stage.mjs";

/** `security find-identity -p codesigning` lines: `N) <hash> "Name"`, with a trailing `(CSSMERR_...)` when not trusted. */
export function parseIdentities(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"(.+)"(\s+\(([A-Z_]+)\))?\s*$/.exec(line);
    if (m) out.push({name: m[1], trusted: m[3] === undefined});
  }
  return out;
}

export const DEVELOPER_ID_PREFIX = "Developer ID Application:";
export const isDeveloperId = (name) => typeof name === "string" && name.startsWith(DEVELOPER_ID_PREFIX);

/**
 * Which identity signs, or why not. `requested` is the `--sign` value or null; `identities` the
 * keychain's list. A release build is never left unsigned and never signed by anything but a
 * Developer ID Application certificate.
 */
export function identityDecision({flavour, requested, identities}) {
  if (flavour !== "internal" && flavour !== "release") return {error: "BAD_FLAVOUR"};
  if (requested === null || requested === undefined) return flavour === "release" ? {error: "SIGN_REQUIRED"} : {skip: true};
  if (typeof requested !== "string" || !requested.trim()) return {error: "BAD_IDENTITY"};
  const found = identities.find((i) => i.name === requested);
  if (!found) return {error: "IDENTITY_MISSING"};
  const developerId = isDeveloperId(found.name);
  if (flavour === "release" && !developerId) return {error: "RELEASE_NEEDS_DEVELOPER_ID"};
  if (developerId && !found.trusted) return {error: "IDENTITY_NOT_TRUSTED"};
  return {identity: found.name, developerId};
}

/**
 * Linux: there is nothing to sign with (no code-signing scheme the desktop checks), so both packaged
 * flavours are fused and left unsigned, and the SHA-256 checksums published beside the packages are
 * the integrity check. `--sign` or a `--level` is refused rather than silently ignored.
 */
export function linuxSignDecision({flavour, requested, levelGiven}) {
  if (flavour !== "internal" && flavour !== "release") return {error: "BAD_FLAVOUR"};
  if ((requested !== null && requested !== undefined) || levelGiven !== false) return {error: "LINUX_HAS_NO_SIGNING"};
  return {skip: true};
}

/** `--sign <name>` and `--level <n>` from argv; `--sign=` spellings and repeats refuse. */
export function parseSignArgs(argv) {
  const one = (flag) => {
    const spellings = argv.filter((a) => typeof a === "string" && a.startsWith(flag));
    if (spellings.length === 0) return {value: null};
    if (spellings.length > 1 || spellings[0] !== flag) return {error: `BAD_${flag.slice(2).toUpperCase()}`};
    const value = argv[argv.indexOf(flag) + 1];
    if (typeof value !== "string" || value.startsWith("--")) return {error: `BAD_${flag.slice(2).toUpperCase()}`};
    return {value};
  };
  const sign = one("--sign");
  if (sign.error) return {error: sign.error};
  const level = one("--level");
  if (level.error) return {error: level.error};
  let levelNumber = 0;
  if (level.value !== null) {
    if (!/^[0-9]+$/.test(level.value) || Number(level.value) >= ENTITLEMENT_LEVELS.length) return {error: "BAD_LEVEL"};
    levelNumber = Number(level.value);
  }
  return {sign: sign.value, level: levelNumber};
}

/** The @electron/osx-sign options: per-file entitlements from the ladder, hardened runtime everywhere, no automation, strict verify. */
export function signOptions({appPath, identity, developerId, level, appName}) {
  return {
    app: appPath,
    platform: "darwin",
    identity,
    // The self-signed development certificate is not "valid" in `security -v` terms; only a real
    // Developer ID is validated.
    identityValidation: developerId,
    preAutoEntitlements: false,
    strictVerify: true,
    optionsForFile: (filePath) => ({entitlements: entitlementsFor(filePath, level, appName, {teamId: developerId}), hardenedRuntime: true})
  };
}

/** Checks entitlements read back from a signed executable against what was intended. */
export function checkEntitlements(readBack, intended) {
  const problems = [];
  const keys = Object.keys(readBack ?? {});
  for (const key of keys) if (FORBIDDEN_ENTITLEMENTS.includes(key)) problems.push({code: "FORBIDDEN_ENTITLEMENT", detail: key});
  for (const key of intended) if (readBack?.[key] !== true) problems.push({code: "ENTITLEMENT_MISSING", detail: key});
  for (const key of keys) if (!intended.includes(key)) problems.push({code: "ENTITLEMENT_EXTRA", detail: key});
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

function readEntitlements(executable) {
  const dir = mkdtempSync(join(tmpdir(), "clave-ent-"));
  try {
    const xml = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", executable], {stdio: ["ignore", "pipe", "pipe"]});
    if (xml.status !== 0) return null;
    const bytes = xml.stdout;
    if (!bytes || bytes.length === 0) return {};
    const file = join(dir, "e.plist");
    writeFileSync(file, bytes);
    return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]).toString());
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

async function loadOsxSign() {
  const req = createRequire(import.meta.url);
  return import(createRequire(req.resolve("@electron/packager")).resolve("@electron/osx-sign"));
}

export async function signBundle({appDir, argv, env, home, log, err}) {
  const fail = (code, detail) => { err(`SIGN_FAILED ${code}${detail ? ` ${detail}` : ""}`); return 1; };
  const out = resolveOut(argv, home, appDir);
  if (out.error) return fail(out.error);
  const asked = requestedFlavour(argv);
  if (asked.error) return fail(asked.error);
  if (asked.flavour === null) return fail("FLAVOUR_REQUIRED");
  const args = parseSignArgs(argv);
  if (args.error) return fail(args.error);
  const flavour = asked.flavour;

  const bundleOut = join(out.dir, flavour, "bundle");
  const reportPath = join(bundleOut, "bundle-report.json");
  if (!existsSync(reportPath)) return fail("BUNDLE_MISSING", "run: pnpm --dir app package:bundle");
  let report;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { return fail("BUNDLE_MISSING"); }
  if (report.flavour !== flavour) return fail("BUNDLE_FLAVOUR_MISMATCH", report.flavour);
  const appPath = join(out.dir, report.appPath);
  const appName = report.appName;
  // A report from before Windows names no platform: it describes a macOS bundle.
  const windows = report.platform === "win32";
  const linux = report.platform === "linux";
  const executable = windows ? join(appPath, report.executable ?? `${appName}.exe`) : linux ? join(appPath, report.executable ?? "") : join(appPath, "Contents", "MacOS", appName);
  const helper = windows ? join(appPath, report.helper ?? "clave-reader.exe") : linux ? join(appPath, report.helper ?? "clave-reader") : join(appPath, "Contents", "MacOS", "clave-reader");
  if (linux && !report.executable) return fail("BUNDLE_INCOMPLETE", "executable");
  if (!existsSync(executable) || !existsSync(helper)) return fail("BUNDLE_INCOMPLETE");

  let probe = {defaultLocation: true, status: 1, output: ""};
  if (windows || linux) probe = runningProbe(appPath, report.platform);
  else {
    try { probe = {...probe, status: 0, output: execFileSync("/usr/bin/pgrep", ["-f", join(appPath, "Contents", "MacOS")], {stdio: ["ignore", "pipe", "pipe"]}).toString()}; }
    catch (error) { probe = {...probe, status: Number.isInteger(error?.status) ? error.status : null, output: String(error?.stdout ?? "")}; }
  }
  const running = runningAppCheck(probe);
  if (running === "running") return fail("APP_RUNNING", appPath);
  if (running === "unanswered") return fail("PGREP_UNANSWERED");

  // Identity first, so a wrong name refuses before anything is modified. Windows signing is not set
  // up yet (owner decision, 2026-09-23: unsigned for now): an internal build is fused and left
  // unsigned, and a release build refuses exactly as an unsigned macOS release does.
  if (windows && args.sign !== null) return fail("WINDOWS_SIGNING_NOT_SET_UP");
  if (linux) {
    const decided = linuxSignDecision({flavour, requested: args.sign, levelGiven: argv.some((a) => typeof a === "string" && a.startsWith("--level"))});
    if (decided.error) return fail(decided.error);
    const flippedLinux = await flip(executable, "linux");
    if (flippedLinux.error) return fail(flippedLinux.error, flippedLinux.detail);
    report.fused = true;
    report.fuses = flippedLinux.wire;
    report.signed = false;
    report.integrity = "sha256 checksums";
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    log(`HARDEN_OK ${flavour} fuses set, unsigned (Linux: checksums are the integrity check) at ${appPath}`);
    return 0;
  }
  let identities = [];
  if (!windows) {
    try { identities = parseIdentities(execFileSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], {stdio: ["ignore", "pipe", "pipe"]}).toString()); }
    catch { return fail("IDENTITY_LOOKUP_FAILED"); }
  }
  const decision = identityDecision({flavour, requested: args.sign, identities});
  if (decision.error) return fail(decision.error);
  // The ladder above level 0 needs a Team ID (see entitlementsFor); a self-signed run refuses it.
  if (!decision.skip && !decision.developerId && args.level !== 0) return fail("LEVEL_NEEDS_DEVELOPER_ID", String(args.level));

  const flipped = windows ? await flip(executable, "win32") : await flip(appPath);
  if (flipped.error) return fail(flipped.error, flipped.detail);
  report.fused = true;
  report.fuses = flipped.wire;
  // From here on the binary IS fused (and ad-hoc re-signed by the fuse tool): every exit, failed or
  // not, writes what the bundle now is, so the report never says "unfused, unsigned" of a bundle that
  // is neither. A failed signing leaves `signed:false` plus the failure code.
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const failSigned = (code, detail) => { report.signed = false; report.signError = code; save(); return fail(code, detail); };

  if (decision.skip) {
    report.signed = false;
    save();
    log(`HARDEN_OK ${flavour} fuses set, unsigned at ${appPath}`);
    return 0;
  }

  const osxSign = await loadOsxSign();
  const options = signOptions({appPath, identity: decision.identity, developerId: decision.developerId, level: args.level, appName});
  try { await osxSign.sign(options); }
  catch (error) { return failSigned("CODESIGN_FAILED", error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : ""); }

  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {stdio: ["ignore", "pipe", "pipe"]});
  if (verify.status !== 0) return failSigned("VERIFY_FAILED", String(verify.status));
  const mainEntitlements = readEntitlements(executable);
  const helperEntitlements = readEntitlements(helper);
  if (mainEntitlements === null || helperEntitlements === null) return failSigned("ENTITLEMENTS_UNREADABLE");
  const problems = [...checkEntitlements(mainEntitlements, entitlementsFor(executable, args.level, appName, {teamId: decision.developerId})), ...checkEntitlements(helperEntitlements, [])];
  if (problems.length > 0) return failSigned("ENTITLEMENTS_WRONG", `${problems[0].code} ${problems[0].detail} (+${problems.length - 1})`);
  const flags = (path) => { const d = spawnSync("/usr/bin/codesign", ["-dvv", path], {stdio: ["ignore", "pipe", "pipe"]}); const text = String(d.stderr); const m = /flags=([^\s]+)/.exec(text); return m ? m[1] : ""; };
  const mainFlags = flags(executable);
  const helperFlags = flags(helper);
  if (!mainFlags.includes("runtime") || !helperFlags.includes("runtime")) return failSigned("HARDENED_RUNTIME_MISSING", `${mainFlags} ${helperFlags}`);
  delete report.signError;

  report.signed = true;
  report.identity = decision.identity;
  report.developerId = decision.developerId;
  report.entitlementLevel = args.level;
  report.entitlements = {main: Object.keys(mainEntitlements).sort(), helper: Object.keys(helperEntitlements).sort()};
  report.codesignFlags = {main: mainFlags, helper: helperFlags};
  save();
  log(`SIGN_OK ${flavour} level ${args.level} ${decision.developerId ? "developer-id" : "self-signed"} at ${appPath}`);
  return 0;
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "sign.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  signBundle({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}).then((code) => process.exit(code));
}
