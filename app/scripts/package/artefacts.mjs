// The artefacts of a signed bundle (packaging design, section 6.2, steps 7 to 9): notarise and staple
// the .app (through @electron/notarize with a keychain PROFILE NAME, never a credential), a DMG with an
// Applications link (hdiutil), signed, notarised and stapled itself, a ZIP of the stapled app (ditto),
// and the Gatekeeper checks (spctl, stapler validate, codesign --verify), all recorded in a report.
// Run from the repo root:
//   pnpm --dir app package:artefacts -- --flavour internal [--notarize <profile name>] [--out <dir>]
// Without --notarize an internal build gets its DMG and ZIP unnotarised (the owner's own machine, or
// a layout check); a release build refuses. Nothing here reads, prints or stores a secret.
//
// Pure decisions above the line (tested in artefacts.test.ts); nothing runs at import.
import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {basename, dirname, join, posix} from "node:path";
import {fileURLToPath} from "node:url";
import {requestedFlavour, resolveOut} from "./stage.mjs";

/** `Clave-Agent-Internal-0.1.0-20260922.0815-arm64`: the app name without spaces, the version, the build number, the architecture. */
export function artefactBaseName(info) {
  if (!info || typeof info.appName !== "string" || !info.appName.trim() || typeof info.version !== "string" || typeof info.buildNumber !== "string") return null;
  const name = info.appName.trim().split(/\s+/).join("-").replace(/[^A-Za-z0-9.-]/g, "");
  if (!name) return null;
  return `${name}-${info.version}-${info.buildNumber}-arm64`;
}

/** `--notarize <profile>` from argv; the `=` spelling and repeats refuse; the value is a keychain profile NAME. */
export function parseNotarizeArg(argv) {
  const spellings = argv.filter((a) => typeof a === "string" && a.startsWith("--notarize"));
  if (spellings.length === 0) return {profile: null};
  if (spellings.length > 1 || spellings[0] !== "--notarize") return {error: "BAD_NOTARIZE"};
  const value = argv[argv.indexOf("--notarize") + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("-")) return {error: "BAD_NOTARIZE"};
  return {profile: value.trim()};
}

/**
 * Whether this run notarises, and why not. Only a bundle signed under a Developer ID can be
 * notarised; a release build must be; an internal build may skip it.
 */
export function notarizeDecision({flavour, report, profile}) {
  if (flavour !== "internal" && flavour !== "release") return {error: "BAD_FLAVOUR"};
  if (!report || report.signed !== true) return {error: "ARTEFACT_NEEDS_SIGNED"};
  if (profile === null || profile === undefined) return flavour === "release" ? {error: "NOTARIZE_REQUIRED"} : {skip: true};
  if (report.developerId !== true) return {error: "NOTARIZE_NEEDS_DEVELOPER_ID"};
  return {profile};
}

export function dmgCommand({root, volumeName, dmgPath}) {
  return ["/usr/bin/hdiutil", ["create", "-volname", volumeName, "-srcfolder", root, "-ov", "-format", "UDZO", "-fs", "HFS+", "-quiet", dmgPath]];
}

export function zipCommand({appPath, zipPath}) {
  return ["/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, zipPath]];
}

export function copyAppCommand({appPath, destAppPath}) {
  return ["/usr/bin/ditto", [appPath, destAppPath]];
}

export function signDmgCommand({identity, dmgPath}) {
  return ["/usr/bin/codesign", ["--sign", identity, "--timestamp", "--force", dmgPath]];
}

export function notarySubmitCommand({path, profile}) {
  return ["/usr/bin/xcrun", ["notarytool", "submit", path, "--keychain-profile", profile, "--wait", "--output-format", "json"]];
}

/** The notary log of one submission, saved next to the artefacts so a rejection has its reasons on file. */
export function notaryLogCommand({id, profile}) {
  return ["/usr/bin/xcrun", ["notarytool", "log", id, "--keychain-profile", profile]];
}

/**
 * The outcome of a `submit --wait`: `{status, id}` from notarytool's JSON output, or from its text
 * form as a fallback (stdout and stderr merged by the caller). Status is one of Accepted, Invalid,
 * Rejected, In Progress, or null when nothing readable came back.
 */
export function notaryResult(output) {
  const text = String(output ?? "");
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object") {
      const status = ["Accepted", "Invalid", "Rejected", "In Progress"].includes(parsed.status) ? parsed.status : null;
      return {status, id: typeof parsed.id === "string" ? parsed.id : null};
    }
  } catch { /* not JSON: the text form */ }
  const id = /^\s*id:\s*([0-9a-fA-F-]{8,})\s*$/m.exec(text);
  return {status: notaryStatus(text), id: id ? id[1] : null};
}

/** `Authority=` lines and the `TeamIdentifier=` of a `codesign -dvv` description (names only, never a hash). */
export function signatureChain(dvvOutput) {
  const text = String(dvvOutput ?? "");
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const team = /^TeamIdentifier=(.+)$/m.exec(text);
  return {authorities, teamIdentifier: team ? team[1].trim() : null};
}

export function stapleCommand(path) {
  return ["/usr/bin/xcrun", ["stapler", "staple", path]];
}

/** The status word of a `notarytool submit --wait` transcript: `Accepted`, `Invalid`, `Rejected`, or null. */
export function notaryStatus(output) {
  const m = /^\s*status:\s*(Accepted|Invalid|Rejected|In Progress)\s*$/m.exec(String(output));
  return m ? m[1] : null;
}

/**
 * The checks and what each must do. `mustPass` is decided by what the bundle is: a self-signed
 * internal build cannot pass Gatekeeper and is not expected to; a notarised one must.
 */
export function checkPlan({appPath, dmgPath, developerId, notarized}) {
  return [
    {name: "codesign-verify-app", cmd: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", appPath], mustPass: true},
    {name: "codesign-verify-dmg", cmd: "/usr/bin/codesign", args: ["--verify", "--verbose=2", dmgPath], mustPass: true},
    {name: "spctl-app", cmd: "/usr/sbin/spctl", args: ["--assess", "--type", "execute", "-vv", appPath], mustPass: developerId && notarized},
    {name: "spctl-dmg", cmd: "/usr/sbin/spctl", args: ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmgPath], mustPass: developerId && notarized},
    {name: "stapler-validate-app", cmd: "/usr/bin/xcrun", args: ["stapler", "validate", appPath], mustPass: notarized},
    {name: "stapler-validate-dmg", cmd: "/usr/bin/xcrun", args: ["stapler", "validate", dmgPath], mustPass: notarized}
  ];
}

/** Turns check results `{name, status, mustPass}` into problems. */
export function checkProblems(results) {
  return results.filter((r) => r.mustPass && r.status !== 0).map((r) => ({code: "ARTEFACT_CHECK_FAILED", detail: r.name}));
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function run(cmd, args) {
  const r = spawnSync(cmd, args, {stdio: ["ignore", "pipe", "pipe"]});
  return {status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "")};
}

async function loadNotarize() {
  const {createRequire} = await import("node:module");
  const req = createRequire(import.meta.url);
  return import(createRequire(req.resolve("@electron/packager")).resolve("@electron/notarize"));
}

export async function artefacts({appDir, argv, env, home, log, err}) {
  const fail = (code, detail) => { err(`ARTEFACTS_FAILED ${code}${detail ? ` ${detail}` : ""}`); return 1; };
  void env;
  const out = resolveOut(argv, home, appDir);
  if (out.error) return fail(out.error);
  const asked = requestedFlavour(argv);
  if (asked.error) return fail(asked.error);
  if (asked.flavour === null) return fail("FLAVOUR_REQUIRED");
  const flavour = asked.flavour;
  const notarizeArg = parseNotarizeArg(argv);
  if (notarizeArg.error) return fail(notarizeArg.error);

  const bundleOut = join(out.dir, flavour, "bundle");
  const reportPath = join(bundleOut, "bundle-report.json");
  if (!existsSync(reportPath)) return fail("BUNDLE_MISSING", "run: pnpm --dir app package:bundle, then package:sign");
  let report;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { return fail("BUNDLE_MISSING"); }
  if (report.flavour !== flavour) return fail("BUNDLE_FLAVOUR_MISMATCH", report.flavour);
  const decision = notarizeDecision({flavour, report, profile: notarizeArg.profile});
  if (decision.error) return fail(decision.error);
  const appPath = join(out.dir, report.appPath);
  if (!existsSync(appPath)) return fail("BUNDLE_MISSING", "app");
  const base = artefactBaseName(report);
  if (base === null) return fail("BUNDLE_MISSING", "report fields");

  // Everything is made in a PARTIAL folder and renamed into place only at the end: a failed run leaves
  // the previous artefacts alone and nothing half-made under the final name. The app copy for the
  // DMG lives inside it too, so it is removed with it whatever happens.
  const artefactDir = join(out.dir, flavour, "artefacts");
  const partial = join(out.dir, flavour, "artefacts.partial");
  const dmgRoot = join(partial, "dmg-root");
  rmSync(partial, {recursive: true, force: true});
  mkdirSync(dmgRoot, {recursive: true});
  const dmgPath = join(partial, `${base}.dmg`);
  const zipPath = join(partial, `${base}.zip`);
  const notarized = !decision.skip;
  const notary = {app: null, dmg: null};
  const saveText = (name, text) => writeFileSync(join(partial, name), String(text ?? "").split("\r\n").join("\n"));

  try {
    // 1. The .app: notarised and stapled in place (the profile name is all @electron/notarize is given).
    //    Its error carries notarytool's own log for a rejection: saved whole, then the run refuses.
    if (notarized) {
      const mod = await loadNotarize();
      try { await mod.notarize({appPath, keychainProfile: decision.profile}); notary.app = "Accepted"; }
      catch (error) {
        saveText("notary-app.log", error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
        return fail("NOTARIZE_FAILED", "see artefacts.partial/notary-app.log");
      }
    }

    // 2. The DMG: a folder with the app (copied by ditto, which keeps symlinks, modes, signatures and
    //    the stapled ticket) and an Applications link, so a drag installs it and translocation never applies.
    const destApp = join(dmgRoot, basename(appPath));
    let r = run(...copyAppCommand({appPath, destAppPath: destApp}));
    if (r.status !== 0) return fail("DMG_COPY_FAILED", String(r.status));
    symlinkSync("/Applications", join(dmgRoot, "Applications"));
    r = run(...dmgCommand({root: dmgRoot, volumeName: report.appName, dmgPath}));
    if (r.status !== 0) return fail("DMG_CREATE_FAILED", String(r.status));
    r = run(...signDmgCommand({identity: report.identity, dmgPath}));
    if (r.status !== 0) return fail("DMG_SIGN_FAILED", String(r.status));
    if (notarized) {
      r = run(...notarySubmitCommand({path: dmgPath, profile: decision.profile}));
      const result = notaryResult(`${r.stdout}\n${r.stderr}`);
      saveText("notary-dmg-submit.log", `${r.stdout}\n${r.stderr}`);
      if (result.id) {
        const logResult = run(...notaryLogCommand({id: result.id, profile: decision.profile}));
        saveText("notary-dmg.log", `${logResult.stdout}\n${logResult.stderr}`);
      }
      notary.dmg = {status: result.status, id: result.id};
      if (r.status !== 0 || result.status !== "Accepted") return fail("DMG_NOTARIZE_FAILED", result.status ?? String(r.status));
      r = run(...stapleCommand(dmgPath));
      if (r.status !== 0) return fail("DMG_STAPLE_FAILED", String(r.status));
    }

    // 3. The ZIP of the (stapled) app.
    r = run(...zipCommand({appPath, zipPath}));
    if (r.status !== 0) return fail("ZIP_FAILED", String(r.status));

    // 4. The checks, every one recorded; the ones that must pass, enforced. The signature chain of the
    //    app, its helper and the DMG is recorded too (authority names and the team identifier only).
    const results = checkPlan({appPath, dmgPath, developerId: report.developerId === true, notarized}).map((c) => ({name: c.name, mustPass: c.mustPass, status: run(c.cmd, c.args).status}));
    const chain = (path) => signatureChain(run("/usr/bin/codesign", ["-dvv", path]).stderr);
    const problems = checkProblems(results);
    const artefactReport = {
      flavour, appName: report.appName, version: report.version, buildNumber: report.buildNumber, identity: report.identity, developerId: report.developerId === true, notarized, notary,
      dmg: {file: basename(dmgPath), bytes: statSync(dmgPath).size, sha256: sha256(dmgPath)},
      zip: {file: basename(zipPath), bytes: statSync(zipPath).size, sha256: sha256(zipPath)},
      signatures: {app: chain(appPath), helper: chain(join(appPath, "Contents", "MacOS", "clave-reader")), dmg: chain(dmgPath)},
      checks: results
    };
    writeFileSync(join(partial, "artefacts-report.json"), JSON.stringify(artefactReport, null, 2) + "\n");
    if (problems.length > 0) return fail(problems[0].code, `${problems[0].detail} (+${problems.length - 1})`);
    rmSync(dmgRoot, {recursive: true, force: true});
    rmSync(artefactDir, {recursive: true, force: true});
    renameSync(partial, artefactDir);
    log(`ARTEFACTS_OK ${flavour} ${notarized ? "notarized" : "not notarized"} dmg ${artefactReport.dmg.bytes} zip ${artefactReport.zip.bytes} at ${artefactDir}`);
    return 0;
  } finally {
    rmSync(dmgRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "artefacts.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  artefacts({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}).then((code) => process.exit(code));
}
