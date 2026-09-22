// Stages what ships: the asar root (package.json, dist/, node_modules/) and the helper, under
// app/out/<flavour>/staging/, from a dist/ that scripts/build.mjs made for that flavour.
// Run from the repo root:  pnpm --dir app package:stage [-- --flavour internal] [-- --out <dir>]
//
// Every decision below is a pure function (no fs, no process, nothing at import), tested in
// scripts/package/stage.test.ts. `stage()` at the bottom is the only impure part, and the program
// half is gated on argv[1], so importing this module from a test never writes, installs or deletes
// anything (the 2026-09-19 incident in scripts/dev-bundle.mjs is why).
//
// What "what ships" is decided by (packaging design, sections 4.1 and 4.2):
//   dist/      an ALLOW-list. A file the list does not name is a refusal, never a quiet extra.
//   node_modules/  the runtime closure of node-llama-cpp only, installed OFFLINE from the pnpm store
//              into a hoisted (real directories, no symlinks) layout, checked against the app's own
//              lockfile, then pruned to the Mac-arm64 packages.
//   helper     dist/native/clave-reader goes NEXT to the bundle root, not into the asar: it is
//              signed on its own and copied to Contents/MacOS by the bundle step.
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, posix, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {generateLicences} from "./licences.mjs";
import {walk} from "./walk.mjs";

export const FLAVOURS = ["dev", "internal", "release"];

/** dist/ files that ship in every flavour. */
export const DIST_ALWAYS = ["main.cjs", "preload.cjs", "model-host.mjs", "WHAT-LEAVES.md", "build.json", "tray.png"];
/** dist/ files that ship only where the stub backend runs (dev and internal): the stub's public skills list. */
export const DIST_STANDINS_ONLY = ["standins-taxonomy.json"];
/** dist/ files that never ship: the staged-window harness and the plain-Node release gate. */
export const DIST_NEVER = ["reader-eval.cjs", "eval-gate.mjs"];
/** dist/ files the staging step READS and never ships: the inlined packages' licence facts. Required. */
export const DIST_STAGING_ONLY = ["bundled-packages.json"];
/** The one file under dist/native that exists, and where it goes: beside the asar, not inside it. */
export const HELPER_IN_DIST = "native/clave-reader";
/** The renderer files that must be there for the window to load at all. */
export const RENDERER_REQUIRED = ["renderer/index.html", "renderer/main.js", "renderer/main.css"];

/**
 * Decides, for every relative path in dist/ (posix separators), whether it ships into the asar's
 * dist/, is the helper, is skipped, or is a refusal. Returns `{ship, helper}` or `{error: {code,
 * path}}`. Refusals: a source map (nothing here ships one), a file nobody listed (a new build
 * output must be decided about here before it can ship), and a required file that is missing.
 */
export function shipList(distFiles, flavour) {
  if (!FLAVOURS.includes(flavour)) return {error: {code: "BAD_FLAVOUR", path: String(flavour)}};
  const files = [...distFiles].map((f) => f.split("\\").join("/")).sort();
  const ship = [];
  const consumed = [];
  let helper = null;
  for (const path of files) {
    if (path.endsWith(".map")) return {error: {code: "SOURCE_MAP_IN_DIST", path}};
    if (DIST_NEVER.includes(path)) continue;
    if (DIST_STAGING_ONLY.includes(path)) { consumed.push(path); continue; }
    if (path === HELPER_IN_DIST) { helper = path; continue; }
    if (path.startsWith("native/")) return {error: {code: "UNEXPECTED_DIST_FILE", path}};
    if (path.startsWith("renderer/")) { ship.push(path); continue; }
    if (DIST_ALWAYS.includes(path)) { ship.push(path); continue; }
    if (DIST_STANDINS_ONLY.includes(path)) { if (flavour !== "release") ship.push(path); continue; }
    return {error: {code: "UNEXPECTED_DIST_FILE", path}};
  }
  const required = [...DIST_ALWAYS, ...RENDERER_REQUIRED, ...(flavour === "release" ? [] : DIST_STANDINS_ONLY)];
  for (const path of required) if (!ship.includes(path)) return {error: {code: "DIST_INCOMPLETE", path}};
  if (helper === null) return {error: {code: "DIST_INCOMPLETE", path: HELPER_IN_DIST}};
  for (const path of DIST_STAGING_ONLY) if (!consumed.includes(path)) return {error: {code: "DIST_INCOMPLETE", path}};
  return {ship, helper};
}

/**
 * The asar root's package.json. `main` is where esbuild put the entry; `dependencies` names the one
 * runtime package at the exact version app/package.json pins, so the offline install below resolves
 * exactly what the lockfile holds; nothing else (no scripts, no devDependencies, no `files`).
 */
export function runtimePackageJson({flavour, version, nodeLlamaCppVersion}) {
  if (!FLAVOURS.includes(flavour)) throw new Error("BAD_FLAVOUR");
  if (typeof version !== "string" || version.length === 0) throw new Error("BAD_VERSION");
  if (typeof nodeLlamaCppVersion !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(nodeLlamaCppVersion)) throw new Error("BAD_DEPENDENCY_VERSION");
  return {
    name: flavour === "internal" ? "clave-agent-internal" : "clave-agent",
    version,
    private: true,
    main: "dist/main.cjs",
    dependencies: {"node-llama-cpp": nodeLlamaCppVersion}
  };
}

/** The pnpm-lock.yaml `packages:` section lists `  name@version:` on a line of its own. */
export function lockHas(lockText, id) {
  const line = `  ${id}:`;
  return lockText.split("\n").some((l) => l === line || l === `  '${id}':`);
}

/**
 * The two macOS-arm64 binary packages that may ship; every sibling for another platform is dropped
 * even if the offline install left one behind.
 */
const KEEP_PLATFORM = {"@node-llama-cpp": "mac-arm64-metal", "@reflink": "reflink-darwin-arm64"};

/**
 * For a path relative to node_modules/ (posix): `drop` or `keep`. Applied to directories too, so a
 * dropped folder goes as a whole. Dropped: every dot-entry (`.bin` symlinks, `.pnpm`, pnpm's own
 * state files, any dotfile a package shipped), TypeScript (an optional peer nothing loads), every
 * other-platform binary package, type declarations and source maps (never read at run time), and,
 * only when asked, node-llama-cpp's `llama/` source tree (kept until Task 5 measures the app without it).
 */
export function pruneDecision(relPath, options = {}) {
  const parts = relPath.split("\\").join("/").split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "keep";
  if (parts.some((p) => p.startsWith("."))) return "drop";
  if (parts[0] === "typescript") return "drop";
  const scope = parts[0];
  // `@reflink/reflink` is the JavaScript front of the binary packages and stays; its siblings are per platform.
  const jsFront = scope === "@reflink" && parts[1] === "reflink";
  if (!jsFront && scope in KEEP_PLATFORM && parts.length >= 2 && parts[1] !== KEEP_PLATFORM[scope]) return "drop";
  const last = parts[parts.length - 1];
  if (last.endsWith(".map") || last.endsWith(".d.ts") || last.endsWith(".d.mts") || last.endsWith(".d.cts")) return "drop";
  if (options.dropLlamaSource === true && parts[0] === "node-llama-cpp" && parts[1] === "llama") return "drop";
  return "keep";
}

const FORBIDDEN_EXTENSIONS = [".map", ".p12", ".p8", ".pem", ".cer", ".key", ".keychain-db", ".provisionprofile", ".gguf", ".log", ".jsonl"];
const BINARY_EXTENSIONS = [".node", ".dylib", ".so", ".dll", ".metallib"];
const BINARY_HOMES = ["node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/", "node_modules/@reflink/reflink-darwin-arm64/"];

/**
 * The must-not-ship rule over a path relative to the asar root (posix). `null` means allowed; a
 * code names why not. Outside node_modules only package.json and dist/ exist at all, and dist/
 * holds only what shipList allowed (this checks the negatives again, from the other side, so a
 * staging step that forgot to call shipList would still be caught). Native binaries may live in
 * exactly two folders. Dotfiles are never allowed anywhere (a `.env`, a `.git`, a `.DS_Store`).
 */
export function forbidden(relPath) {
  const path = relPath.split("\\").join("/");
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "EMPTY_PATH";
  if (parts.some((p) => p.startsWith("."))) return "DOTFILE";
  const last = parts[parts.length - 1].toLowerCase();
  if (FORBIDDEN_EXTENSIONS.some((ext) => last.endsWith(ext))) return "FORBIDDEN_FILE";
  if (BINARY_EXTENSIONS.some((ext) => last.endsWith(ext)) && !BINARY_HOMES.some((home) => path.startsWith(home))) return "BINARY_OUTSIDE_ITS_HOME";
  if (parts[0] === "node_modules") {
    // Every node_modules level, nested ones included: a package's own node_modules may carry the
    // same things the top level must not.
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] !== "node_modules") continue;
      const name = parts[i + 1];
      const sub = parts[i + 2];
      if (name === "typescript" || name === ".bin") return "FORBIDDEN_FILE";
      if (name === "@node-llama-cpp" && sub !== undefined && sub !== KEEP_PLATFORM["@node-llama-cpp"]) return "OTHER_PLATFORM";
      if (name === "@reflink" && sub !== undefined && sub !== "reflink" && sub !== KEEP_PLATFORM["@reflink"]) return "OTHER_PLATFORM";
    }
    if (last.endsWith(".d.ts") || last.endsWith(".d.mts") || last.endsWith(".d.cts")) return "FORBIDDEN_FILE";
    return null;
  }
  if (parts[0] === "dist") {
    if (parts[1] === "native") return "HELPER_INSIDE_ASAR";
    if (parts.length === 2 && DIST_NEVER.includes(parts[1])) return "FORBIDDEN_FILE";
    return null;
  }
  if (parts.length === 1 && parts[0] === "package.json") return null;
  return "FORBIDDEN_FILE";
}

/** The manifest: sorted entries, totals, and what the build was. Hashes are computed by the caller. */
export function manifest(entries, info) {
  const files = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    flavour: info.flavour, appName: info.appName, version: info.version, buildNumber: info.buildNumber,
    fileCount: files.length, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), files
  };
}

/**
 * Where a run writes. Default app/out; `--out <dir>` elsewhere; never inside ~/Applications or
 * /Applications (a staging folder is not an app, and those are the two folders macOS attributes
 * grants to). A `--out` with no path after it is a refusal, not the default.
 */
export function resolveOut(argv, home, appDir) {
  const spellings = argv.filter((arg) => typeof arg === "string" && arg.startsWith("--out"));
  if (spellings.length > 1 || (spellings.length === 1 && spellings[0] !== "--out")) return {error: "BAD_OUT"};
  const at = argv.indexOf("--out");
  let dir;
  if (at < 0) dir = resolve(join(appDir, "out"));
  else {
    const given = argv[at + 1];
    if (typeof given !== "string" || given.startsWith("--")) return {error: "BAD_OUT"};
    const named = given === "~" ? home : given.startsWith("~/") ? join(home, given.slice(2)) : given;
    dir = resolve(named);
  }
  for (const banned of [resolve(join(home, "Applications")), "/Applications"]) {
    if (dir === banned || dir.startsWith(banned + "/")) return {error: "OUT_IS_APPLICATIONS"};
  }
  return {dir};
}

/** `--flavour <name>` when given; `null` when absent (the dist's own build.json decides then). */
export function requestedFlavour(argv) {
  const spellings = argv.filter((arg) => typeof arg === "string" && arg.startsWith("--flavour"));
  if (spellings.length === 0) return {flavour: null};
  if (spellings.length > 1 || spellings[0] !== "--flavour") return {error: "BAD_FLAVOUR"};
  const value = argv[argv.indexOf("--flavour") + 1];
  if (typeof value !== "string" || !FLAVOURS.includes(value)) return {error: "BAD_FLAVOUR"};
  return {flavour: value};
}

/** `name@version` for every package.json found under node_modules (hoisted layout: any depth). */
export function installedIds(packageJsons) {
  const ids = new Set();
  for (const p of packageJsons) if (typeof p?.name === "string" && typeof p?.version === "string") ids.add(`${p.name}@${p.version}`);
  return [...ids].sort();
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function stage({appDir, argv, env, home, log, err}) {
  const fail = (code, detail) => { err(`STAGE_FAILED ${code}${detail ? ` ${detail}` : ""}`); return 1; };
  const out = resolveOut(argv, home, appDir);
  if (out.error) return fail(out.error);
  const asked = requestedFlavour(argv);
  if (asked.error) return fail(asked.error);

  const dist = join(appDir, "dist");
  const buildJson = join(dist, "build.json");
  if (!existsSync(buildJson)) return fail("DIST_NOT_BUILT", "run: pnpm --dir app build -- --flavour <name>");
  let info;
  try { info = JSON.parse(readFileSync(buildJson, "utf8")); } catch { return fail("DIST_NOT_BUILT"); }
  if (!FLAVOURS.includes(info.flavour)) return fail("DIST_NOT_BUILT");
  if (asked.flavour !== null && asked.flavour !== info.flavour) return fail("DIST_FLAVOUR_MISMATCH", `dist is ${info.flavour}`);
  const flavour = info.flavour;

  const distFiles = walk(dist).filter((e) => e.kind === "file").map((e) => e.rel);
  if (walk(dist).some((e) => e.kind === "symlink")) return fail("SYMLINK_IN_DIST");
  const decided = shipList(distFiles, flavour);
  if (decided.error) return fail(decided.error.code, decided.error.path);

  const appPackage = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  // The version is build.json's (what the bundles were built with), not package.json's as it is now:
  // a bump between build and stage must not ship two versions.
  let runtime;
  try { runtime = runtimePackageJson({flavour, version: info.version, nodeLlamaCppVersion: appPackage.dependencies?.["node-llama-cpp"]}); }
  catch (error) { return fail(error instanceof Error ? error.message : "BAD_PACKAGE_JSON"); }

  const staging = join(out.dir, flavour, "staging");
  const root = join(staging, "app");
  rmSync(staging, {recursive: true, force: true});
  mkdirSync(join(root, "dist"), {recursive: true});
  mkdirSync(join(staging, "helper"), {recursive: true});
  for (const rel of decided.ship) {
    mkdirSync(dirname(join(root, "dist", rel)), {recursive: true});
    cpSync(join(dist, rel), join(root, "dist", rel));
  }
  cpSync(join(dist, decided.helper), join(staging, "helper", "clave-reader"));
  writeFileSync(join(root, "package.json"), JSON.stringify(runtime, null, 2) + "\n");

  // The runtime closure, offline, from the store, at the lockfile's versions: the app's own lockfile
  // and workspace file are copied beside the generated package.json so pnpm reuses their resolutions
  // (and, from the workspace file, keeps every build script switched off), then removed again.
  cpSync(join(appDir, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
  cpSync(join(appDir, "pnpm-workspace.yaml"), join(root, "pnpm-workspace.yaml"));
  const pnpm = env.CLAVE_PNPM ?? join(home, "Library", "pnpm", "bin", "pnpm");
  if (!existsSync(pnpm)) return fail("PNPM_MISSING", pnpm);
  // `--no-frozen-lockfile`: the copied lockfile lists the whole app's dependencies and this
  // package.json names one of them, which pnpm counts as "outdated" and refuses under CI's default.
  // `--offline` still holds: nothing is fetched, and the versions are checked against the lockfile below.
  const install = spawnSync(pnpm, ["install", "--prod", "--offline", "--no-frozen-lockfile", "--config.node-linker=hoisted", "--ignore-scripts", "--dir", root], {stdio: ["ignore", "pipe", "pipe"], env: {...env, CI: undefined}});
  rmSync(join(root, "pnpm-lock.yaml"), {force: true});
  rmSync(join(root, "pnpm-workspace.yaml"), {force: true});
  if (install.status !== 0) {
    // pnpm's own last lines, so a refusal can be read; they name packages and paths, never screen text.
    err(String(install.stderr ?? "").split("\n").filter((l) => l.trim()).slice(-4).join("\n"));
    return fail("PNPM_INSTALL_FAILED", String(install.status));
  }

  const modules = join(root, "node_modules");
  if (!existsSync(modules)) return fail("PNPM_INSTALL_FAILED", "no node_modules");
  const lockText = readFileSync(join(appDir, "pnpm-lock.yaml"), "utf8");
  const packageJsons = walk(modules).filter((e) => e.kind === "file" && posix.basename(e.rel) === "package.json" && pruneDecision(e.rel) === "keep")
    .map((e) => { try { return JSON.parse(readFileSync(join(modules, e.rel), "utf8")); } catch { return null; } });
  for (const id of installedIds(packageJsons)) if (!lockHas(lockText, id)) return fail("LOCK_MISMATCH", id);

  // Prune: dropped directories go whole; walk order is parent-first, so a dropped parent's children
  // are simply gone by the time their turn comes.
  for (const entry of walk(modules)) {
    if (pruneDecision(entry.rel) === "drop") rmSync(join(modules, entry.rel), {recursive: true, force: true});
  }

  // The licence file: every component in the pruned closure, the helper's crates, Electron, and the
  // hand-kept entries; a missing or non-permissive licence refuses the whole run. Written into dist/
  // so it ships inside the asar; Electron's own two licence files are copied beside the root for the
  // bundle step to place in Contents/Resources.
  const cargo = env.CLAVE_CARGO ?? "/opt/homebrew/opt/rustup/bin/cargo";
  if (!existsSync(cargo)) return fail("CARGO_MISSING", cargo);
  const licences = generateLicences({root, appDir, flavour, cargo, env});
  if (licences.error) return fail(licences.error, licences.detail);
  writeFileSync(join(root, "dist", "THIRD-PARTY-LICENSES.txt"), licences.text);
  mkdirSync(join(staging, "electron"), {recursive: true});
  for (const file of licences.electronFiles) cpSync(file, join(staging, "electron", posix.basename(file)));

  const everything = walk(root);
  const symlink = everything.find((e) => e.kind === "symlink");
  if (symlink) return fail("SYMLINK_IN_STAGING", symlink.rel);
  const entries = [];
  for (const entry of everything) {
    if (entry.kind !== "file") continue;
    const why = forbidden(entry.rel);
    if (why) return fail(why, entry.rel);
    const full = join(root, entry.rel);
    entries.push({path: entry.rel, bytes: statSync(full).size, sha256: sha256(full)});
  }
  if (lstatSync(join(staging, "helper", "clave-reader")).isSymbolicLink()) return fail("SYMLINK_IN_STAGING", "helper");
  const helperPath = join(staging, "helper", "clave-reader");
  const result = {...manifest(entries, info), helper: {bytes: statSync(helperPath).size, sha256: sha256(helperPath)}};
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(result, null, 2) + "\n");
  log(`STAGE_OK ${flavour} files ${result.fileCount} bytes ${result.totalBytes} licences ${licences.counts.packages}+${licences.counts.crates} at ${staging}`);
  return 0;
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "stage.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(stage({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}));
}
