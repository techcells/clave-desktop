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
import {cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {basename, dirname, join, posix, resolve, sep} from "node:path";
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
/**
 * What ships differs per system in four facts, and only these: the helper's file name, which of
 * node-llama-cpp's and reflink's per-platform binary packages stay, the folders native binaries may
 * live in, and the Rust target the helper's crates are listed for. Keyed by `process.platform`, since
 * a staging run packages the system it runs on; every other rule in this file is shared.
 *
 * Windows keeps both of node-llama-cpp's x64 builds: `win-x64-vulkan` for any GPU with a Vulkan
 * driver (Intel, AMD, NVIDIA), and plain `win-x64` as the CPU fallback node-llama-cpp picks where
 * Vulkan will not load. CUDA is not shipped (owner decision, 2026-09-23): 300 MB and more for
 * NVIDIA alone, which Vulkan already serves.
 */
export const TARGETS = {
  darwin: {
    helper: "clave-reader",
    keep: {"@node-llama-cpp": ["mac-arm64-metal"], "@reflink": ["reflink-darwin-arm64"]},
    binaryHomes: ["node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/", "node_modules/@reflink/reflink-darwin-arm64/"],
    rustTarget: "aarch64-apple-darwin"
  },
  win32: {
    helper: "clave-reader.exe",
    keep: {"@node-llama-cpp": ["win-x64", "win-x64-vulkan"], "@reflink": ["reflink-win32-x64-msvc"]},
    binaryHomes: [
      "node_modules/@node-llama-cpp/win-x64/bins/win-x64/",
      "node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/",
      "node_modules/@reflink/reflink-win32-x64-msvc/"
    ],
    rustTarget: "x86_64-pc-windows-msvc",
    // node-llama-cpp's prebuilt Windows binaries link Microsoft's C++ runtime dynamically, and a clean
    // Windows need not have it. The three DLLs are copied app-locally (owner decision, 2026-09-23)
    // into each folder that holds a `llama-addon.node`: Node loads an addon with its own folder
    // searched first, so a copy beside it is found before, or in the absence of, a system one.
    runtime: {
      files: ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"],
      into: ["node_modules/@node-llama-cpp/win-x64/bins/win-x64", "node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan"]
    }
  }
};

/**
 * The newest Visual C++ redistributable folder (`...\VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT`)
 * among candidates, with its version, or `null`. Newest by the numeric version in the path, so
 * `14.44.35112` beats `14.9.1` and a stray folder without a version is never picked.
 */
export function pickRedistDir(candidates) {
  const versioned = candidates.map((path) => {
    const parts = path.split("\\").join("/").split("/");
    const at = parts.findIndex((p) => p.toUpperCase() === "MSVC");
    const version = at >= 0 ? parts[at + 1] : undefined;
    return {path, version, numbers: /^[0-9]+(\.[0-9]+)*$/.test(version ?? "") ? version.split(".").map(Number) : null};
  }).filter((c) => c.numbers !== null && /^Microsoft\.VC14[0-9]\.CRT$/i.test(c.path.split("\\").join("/").split("/").pop() ?? ""));
  versioned.sort((a, b) => {
    for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i += 1) {
      const d = (b.numbers[i] ?? 0) - (a.numbers[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return versioned.length > 0 ? {path: versioned[0].path, version: versioned[0].version} : null;
}

/** The target for a platform, or `null` for one nothing here packages. */
export function targetFor(platform) {
  return Object.hasOwn(TARGETS, platform) ? TARGETS[platform] : null;
}

/** The one file under dist/native that exists, and where it goes: beside the asar, not inside it. */
export const HELPER_IN_DIST = `native/${TARGETS.darwin.helper}`;
const helperInDist = (platform) => `native/${(targetFor(platform) ?? TARGETS.darwin).helper}`;
/** The renderer files that must be there for the window to load at all. */
export const RENDERER_REQUIRED = ["renderer/index.html", "renderer/main.js", "renderer/main.css"];

/**
 * Decides, for every relative path in dist/ (posix separators), whether it ships into the asar's
 * dist/, is the helper, is skipped, or is a refusal. Returns `{ship, helper}` or `{error: {code,
 * path}}`. Refusals: a source map (nothing here ships one), a file nobody listed (a new build
 * output must be decided about here before it can ship), and a required file that is missing.
 */
export function shipList(distFiles, flavour, platform = "darwin") {
  if (!FLAVOURS.includes(flavour)) return {error: {code: "BAD_FLAVOUR", path: String(flavour)}};
  if (targetFor(platform) === null) return {error: {code: "UNSUPPORTED_PLATFORM", path: String(platform)}};
  const HELPER_IN_DIST = helperInDist(platform);
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
 * The binary packages that may ship, per scope, for a platform (`TARGETS[platform].keep`); every
 * sibling for another platform is dropped even if the offline install left one behind.
 */
const keepFor = (platform) => (targetFor(platform) ?? TARGETS.darwin).keep;

/**
 * Build leftovers a Windows binary package carries beside its DLLs: the import library a linker
 * would use (`llama-addon.lib`), export files and debug symbols. Nothing loads them at run time.
 */
const BUILD_LEFTOVERS = [".lib", ".exp", ".pdb"];

/**
 * For a path relative to node_modules/ (posix): `drop` or `keep`. Applied to directories too, so a
 * dropped folder goes as a whole. Dropped: every dot-entry (`.bin` symlinks, `.pnpm`, pnpm's own
 * state files, any dotfile a package shipped), TypeScript (an optional peer nothing loads), every
 * other-platform binary package, type declarations, source maps and build leftovers (never read at
 * run time), and, only when asked, node-llama-cpp's `llama/` source tree (kept until Task 5 measures
 * the app without it). `options.platform` is the system being packaged; macOS when not given.
 */
export function pruneDecision(relPath, options = {}) {
  const parts = relPath.split("\\").join("/").split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "keep";
  if (parts.some((p) => p.startsWith("."))) return "drop";
  if (parts[0] === "typescript") return "drop";
  const scope = parts[0];
  const keep = keepFor(options.platform ?? "darwin");
  // `@reflink/reflink` is the JavaScript front of the binary packages and stays; its siblings are per platform.
  const jsFront = scope === "@reflink" && parts[1] === "reflink";
  if (!jsFront && scope in keep && parts.length >= 2 && !keep[scope].includes(parts[1])) return "drop";
  const last = parts[parts.length - 1];
  if (last.endsWith(".map") || last.endsWith(".d.ts") || last.endsWith(".d.mts") || last.endsWith(".d.cts")) return "drop";
  if (BUILD_LEFTOVERS.some((ext) => last.toLowerCase().endsWith(ext))) return "drop";
  if (options.dropLlamaSource === true && parts[0] === "node-llama-cpp" && parts[1] === "llama") return "drop";
  return "keep";
}

const FORBIDDEN_EXTENSIONS = [".map", ".p12", ".p8", ".pem", ".cer", ".key", ".keychain-db", ".provisionprofile", ".gguf", ".log", ".jsonl", ".pfx", ...BUILD_LEFTOVERS];
const BINARY_EXTENSIONS = [".node", ".dylib", ".so", ".dll", ".metallib"];

/**
 * The must-not-ship rule over a path relative to the asar root (posix). `null` means allowed; a
 * code names why not. Outside node_modules only package.json and dist/ exist at all, and dist/
 * holds only what shipList allowed (this checks the negatives again, from the other side, so a
 * staging step that forgot to call shipList would still be caught). Native binaries may live only in
 * the platform's binary homes (`TARGETS`). Dotfiles are never allowed anywhere (a `.env`, a `.git`,
 * a `.DS_Store`). `platform` is the system being packaged; macOS when not given.
 */
export function forbidden(relPath, platform = "darwin") {
  const target = targetFor(platform) ?? TARGETS.darwin;
  const keep = target.keep;
  const path = relPath.split("\\").join("/");
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "EMPTY_PATH";
  if (parts.some((p) => p.startsWith("."))) return "DOTFILE";
  const last = parts[parts.length - 1].toLowerCase();
  if (FORBIDDEN_EXTENSIONS.some((ext) => last.endsWith(ext))) return "FORBIDDEN_FILE";
  if (BINARY_EXTENSIONS.some((ext) => last.endsWith(ext)) && !target.binaryHomes.some((home) => path.startsWith(home))) return "BINARY_OUTSIDE_ITS_HOME";
  if (parts[0] === "node_modules") {
    // Every node_modules level, nested ones included: a package's own node_modules may carry the
    // same things the top level must not.
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] !== "node_modules") continue;
      const name = parts[i + 1];
      const sub = parts[i + 2];
      if (name === "typescript" || name === ".bin") return "FORBIDDEN_FILE";
      if (name === "@node-llama-cpp" && sub !== undefined && !keep["@node-llama-cpp"].includes(sub)) return "OTHER_PLATFORM";
      if (name === "@reflink" && sub !== undefined && sub !== "reflink" && !keep["@reflink"].includes(sub)) return "OTHER_PLATFORM";
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
  for (const banned of [resolve(join(home, "Applications")), resolve("/Applications")]) {
    if (dir === banned || dir.startsWith(banned + sep)) return {error: "OUT_IS_APPLICATIONS"};
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

/**
 * How to run the pnpm at `path`: `{command, args}` to prepend, or `null` when it cannot be run.
 *
 * On Windows pnpm is usually a `pnpm.cmd` shim, and Node refuses to spawn a `.cmd` without a shell
 * (EINVAL), while a shell would re-parse every argument, paths with spaces included. So a shim is
 * replaced by the JavaScript entry it wraps, run with this Node: the shim of a global npm install
 * sits beside `node_modules/pnpm/bin/pnpm.cjs`, the one in a `.bin` folder beside `../pnpm/bin/pnpm.cjs`.
 * A path that already names a `.cjs`/`.mjs`/`.js` entry is run with Node as it is.
 */
export function pnpmInvocation(path, {nodePath, exists, join: joinPath = join, dirname: dirOf = dirname}) {
  if (/\.(c|m)?js$/i.test(path)) return exists(path) ? {command: nodePath, args: [path]} : null;
  if (/\.(cmd|bat)$/i.test(path)) {
    const dir = dirOf(path);
    const entry = [joinPath(dir, "node_modules", "pnpm", "bin", "pnpm.cjs"), joinPath(dir, "..", "pnpm", "bin", "pnpm.cjs")].find(exists);
    return entry === undefined ? null : {command: nodePath, args: [entry]};
  }
  return exists(path) ? {command: path, args: []} : null;
}

/** Where pnpm and cargo are looked for when CLAVE_PNPM / CLAVE_CARGO do not say. */
export function defaultTools(platform, home, env) {
  if (platform === "win32") {
    return {
      pnpm: join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "pnpm.cmd"),
      cargo: join(home, ".cargo", "bin", "cargo.exe")
    };
  }
  return {pnpm: join(home, "Library", "pnpm", "bin", "pnpm"), cargo: "/opt/homebrew/opt/rustup/bin/cargo"};
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

/**
 * The Visual C++ redistributable of the Visual Studio installed here: `CLAVE_VCREDIST_DIR` when set
 * (with the version as its `MSVC\<version>` segment), else every `Microsoft Visual Studio\<year>\
 * <edition>\VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT` under both Program Files folders.
 */
function findRedistDir(env) {
  if (env.CLAVE_VCREDIST_DIR) return pickRedistDir([env.CLAVE_VCREDIST_DIR]);
  const dirs = (path) => { try { return readdirSync(path, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => join(path, e.name)); } catch { return []; } };
  const candidates = [];
  for (const programs of [env["ProgramFiles(x86)"], env.ProgramFiles].filter(Boolean)) {
    for (const year of dirs(join(programs, "Microsoft Visual Studio"))) {
      for (const edition of dirs(year)) {
        for (const version of dirs(join(edition, "VC", "Redist", "MSVC"))) candidates.push(...dirs(join(version, "x64")));
      }
    }
  }
  return pickRedistDir(candidates);
}

export function stage({appDir, argv, env, home, log, err, platform = process.platform}) {
  const fail = (code, detail) => { err(`STAGE_FAILED ${code}${detail ? ` ${detail}` : ""}`); return 1; };
  const target = targetFor(platform);
  if (target === null) return fail("UNSUPPORTED_PLATFORM", platform);
  const tools = defaultTools(platform, home, env);
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
  const decided = shipList(distFiles, flavour, platform);
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
  cpSync(join(dist, decided.helper), join(staging, "helper", target.helper));
  writeFileSync(join(root, "package.json"), JSON.stringify(runtime, null, 2) + "\n");

  // The runtime closure, offline, from the store, at the lockfile's versions: the app's own lockfile
  // and workspace file are copied beside the generated package.json so pnpm reuses their resolutions
  // (and, from the workspace file, keeps every build script switched off), then removed again.
  cpSync(join(appDir, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
  cpSync(join(appDir, "pnpm-workspace.yaml"), join(root, "pnpm-workspace.yaml"));
  const pnpm = env.CLAVE_PNPM ?? tools.pnpm;
  const invoke = pnpmInvocation(pnpm, {nodePath: process.execPath, exists: existsSync});
  if (invoke === null) return fail("PNPM_MISSING", pnpm);
  // `--no-frozen-lockfile`: the copied lockfile lists the whole app's dependencies and this
  // package.json names one of them, which pnpm counts as "outdated" and refuses under CI's default.
  // `--offline` still holds: nothing is fetched, and the versions are checked against the lockfile below.
  const install = spawnSync(invoke.command, [...invoke.args, "install", "--prod", "--offline", "--no-frozen-lockfile", "--config.node-linker=hoisted", "--ignore-scripts", "--dir", root], {stdio: ["ignore", "pipe", "pipe"], env: {...env, CI: undefined}});
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
  const packageJsons = walk(modules).filter((e) => e.kind === "file" && posix.basename(e.rel) === "package.json" && pruneDecision(e.rel, {platform}) === "keep")
    .map((e) => { try { return JSON.parse(readFileSync(join(modules, e.rel), "utf8")); } catch { return null; } });
  for (const id of installedIds(packageJsons)) if (!lockHas(lockText, id)) return fail("LOCK_MISMATCH", id);

  // Prune: dropped directories go whole; walk order is parent-first, so a dropped parent's children
  // are simply gone by the time their turn comes.
  for (const entry of walk(modules)) {
    if (pruneDecision(entry.rel, {platform}) === "drop") rmSync(join(modules, entry.rel), {recursive: true, force: true});
  }

  // The system runtime the native binaries need, beside each of them (Windows: see TARGETS.win32.runtime).
  let systemRuntime = null;
  if (target.runtime) {
    const redist = findRedistDir(env);
    if (redist === null) return fail("RUNTIME_MISSING", "no Visual C++ redistributable found; install the VS Build Tools or set CLAVE_VCREDIST_DIR");
    for (const file of target.runtime.files) if (!existsSync(join(redist.path, file))) return fail("RUNTIME_MISSING", join(redist.path, file));
    for (const into of target.runtime.into) {
      if (!existsSync(join(root, into))) return fail("RUNTIME_HOME_MISSING", into);
      for (const file of target.runtime.files) cpSync(join(redist.path, file), join(root, into, file));
    }
    systemRuntime = {version: redist.version, files: target.runtime.files};
  }

  // The licence file: every component in the pruned closure, the helper's crates, Electron, and the
  // hand-kept entries; a missing or non-permissive licence refuses the whole run. Written into dist/
  // so it ships inside the asar; Electron's own two licence files are copied beside the root for the
  // bundle step to place in Contents/Resources.
  const cargo = env.CLAVE_CARGO ?? tools.cargo;
  if (!existsSync(cargo)) return fail("CARGO_MISSING", cargo);
  const licences = generateLicences({root, appDir, flavour, cargo, env, rustTarget: target.rustTarget, runtime: systemRuntime});
  if (licences.error) return fail(licences.error, licences.detail);
  writeFileSync(join(root, "dist", "THIRD-PARTY-LICENSES.txt"), licences.text);
  mkdirSync(join(staging, "electron"), {recursive: true});
  // `basename`, not `posix.basename`: these are real paths of this system, not the walk's posix ones.
  for (const file of licences.electronFiles) cpSync(file, join(staging, "electron", basename(file)));

  const everything = walk(root);
  const symlink = everything.find((e) => e.kind === "symlink");
  if (symlink) return fail("SYMLINK_IN_STAGING", symlink.rel);
  const entries = [];
  for (const entry of everything) {
    if (entry.kind !== "file") continue;
    const why = forbidden(entry.rel, platform);
    if (why) return fail(why, entry.rel);
    const full = join(root, entry.rel);
    entries.push({path: entry.rel, bytes: statSync(full).size, sha256: sha256(full)});
  }
  const helperPath = join(staging, "helper", target.helper);
  if (lstatSync(helperPath).isSymbolicLink()) return fail("SYMLINK_IN_STAGING", "helper");
  // `platform` says which system this staging is for, so the steps after it (and the tests that read a
  // real run) judge it by that system's rules; a manifest without one is from before Windows, i.e. macOS.
  const result = {...manifest(entries, info), platform, helper: {name: target.helper, bytes: statSync(helperPath).size, sha256: sha256(helperPath)}};
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(result, null, 2) + "\n");
  log(`STAGE_OK ${flavour} files ${result.fileCount} bytes ${result.totalBytes} licences ${licences.counts.packages}+${licences.counts.crates} at ${staging}`);
  return 0;
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "stage.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(stage({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}));
}
