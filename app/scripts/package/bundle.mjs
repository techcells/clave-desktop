// Turns a staging folder (scripts/package/stage.mjs) into the .app bundle with @electron/packager:
// Electron 44 from the local zip cache, the asar with node-llama-cpp unpacked, the Info.plist of the
// packaging design (section 5.3), the helper next to the executable, Electron's licence files in
// Resources. Not yet fused or signed: that is scripts/package/harden.mjs and sign.mjs (Task 5).
// Run from the repo root:  pnpm --dir app package:bundle [-- --flavour internal] [-- --out <dir>] [-- --allow-download]
//
// Every decision is a pure function, tested in bundle.test.ts; `bundle()` is the only impure part and
// the program half is gated on the script's own basename, so importing this never packages anything.
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {basename, dirname, join, posix} from "node:path";
import {fileURLToPath} from "node:url";
import {runningAppCheck} from "../dev-bundle.mjs";
import {requestedFlavour, resolveOut} from "./stage.mjs";
import {walk} from "./walk.mjs";

/** The bundle ids (design section 2). `dev` is never packaged: it is the checkout's unpackaged run. */
export const BUNDLE_IDS = {internal: "dev.clave.agent.internal", release: "dev.clave.agent"};

/**
 * Keys Electron's template Info.plist carries that are UNTRUE for this app and would suggest
 * capabilities it does not have (design 5.3). Removed before packager reads the plist.
 */
export const PLIST_REMOVE = [
  "NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"
];

/** Keys set on top of the template: a tray app on macOS 14 or later. */
export const PLIST_SET = {LSUIElement: true, LSMinimumSystemVersion: "14.0"};

export const CATEGORY = "public.app-category.productivity";

/**
 * What must leave the asar: every native module (`*.node`, matched by base name anywhere) and the
 * two node-llama-cpp package folders whole (their file structure is load-bearing; design 4.1).
 * @electron/asar takes one glob per option; the brace names both folders.
 */
export const ASAR_UNPACK = {unpack: "*.node", unpackDir: "node_modules/{node-llama-cpp,@node-llama-cpp}"};

/** The folders every unpacked file must live under, plus any `*.node` (reflink's) at its own place. */
export const UNPACKED_ROOTS = ["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/mac-arm64-metal"];

/** What the asar must and must not hold (posix paths as @electron/asar lists them, leading slash). */
export const ASAR_REQUIRED = ["/package.json", "/dist/main.cjs", "/dist/preload.cjs", "/dist/model-host.mjs", "/dist/renderer/index.html", "/dist/renderer/main.js", "/dist/WHAT-LEAVES.md", "/dist/THIRD-PARTY-LICENSES.txt"];
export const ASAR_FORBIDDEN = ["/dist/reader-eval.cjs", "/dist/eval-gate.mjs"];

export function bundleIdFor(flavour) {
  return Object.hasOwn(BUNDLE_IDS, flavour) ? BUNDLE_IDS[flavour] : null;
}

/** `Copyright © <year> <entity>`; the year is the build number's. The entity is "Clave" (decision 4, owner 2026-09-22). */
export function copyrightFor(entity, buildNumber) {
  const year = String(buildNumber).slice(0, 4);
  if (!/^[0-9]{4}$/.test(year) || typeof entity !== "string" || !entity.trim()) return null;
  return `Copyright \u00a9 ${year} ${entity.trim()}`;
}

/** A path as a `pgrep -f` pattern: every regular-expression metacharacter escaped, so a `(` in a folder name cannot break the guard. */
export function pgrepPattern(path) {
  return String(path).replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`);
}

/** Among candidate paths, the cached Electron zip for this version and arm64, or null. */
export function findElectronZip(candidates, version) {
  const wanted = `electron-v${version}-darwin-arm64.zip`;
  return candidates.map((p) => p.split("\\").join("/")).find((p) => posix.basename(p) === wanted) ?? null;
}

/**
 * The @electron/packager options for one flavour (hooks are added by the impure half). Pure and
 * complete: what the test asserts is what packager receives.
 */
export function packagerOptions({flavour, info, stagingDir, outDir, electronVersion, electronZipDir, iconPath, entity}) {
  const id = bundleIdFor(flavour);
  if (id === null) return {error: "DEV_FLAVOUR_NOT_PACKAGED"};
  if (!info || info.flavour !== flavour) return {error: "STAGING_FLAVOUR_MISMATCH"};
  if (typeof info.appName !== "string" || !info.appName || typeof info.version !== "string" || !info.version || typeof info.buildNumber !== "string") return {error: "STAGING_INCOMPLETE"};
  if (typeof electronVersion !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(electronVersion)) return {error: "ELECTRON_VERSION_UNKNOWN"};
  const copyright = copyrightFor(entity, info.buildNumber);
  if (copyright === null) return {error: "COPYRIGHT_ENTITY_MISSING"};
  const options = {
    dir: join(stagingDir, "app"),
    out: outDir,
    name: info.appName,
    executableName: info.appName,
    appBundleId: id,
    helperBundleId: `${id}.helper`,
    appVersion: info.version,
    buildVersion: info.buildNumber,
    platform: "darwin",
    arch: "arm64",
    electronVersion,
    overwrite: true,
    prune: false,
    derefSymlinks: true,
    junk: true,
    quiet: true,
    asar: ASAR_UNPACK,
    asarIntegrityDigest: true,
    extraResource: [join(stagingDir, "electron", "LICENSE"), join(stagingDir, "electron", "LICENSES.chromium.html")],
    extendInfo: {...PLIST_SET},
    appCategoryType: CATEGORY,
    appCopyright: copyright,
    darwinDarkModeSupport: true
  };
  if (electronZipDir) options.electronZipDir = electronZipDir;
  if (iconPath) options.icon = iconPath;
  return {options};
}

/** The plist keys the built app must show, given the options it was built with. */
export function expectedPlist(options) {
  return {
    CFBundleIdentifier: options.appBundleId,
    CFBundleName: options.name,
    CFBundleDisplayName: options.name,
    CFBundleExecutable: options.executableName,
    CFBundleShortVersionString: options.appVersion,
    CFBundleVersion: options.buildVersion,
    LSUIElement: true,
    LSMinimumSystemVersion: PLIST_SET.LSMinimumSystemVersion,
    LSApplicationCategoryType: options.appCategoryType,
    NSHumanReadableCopyright: options.appCopyright
  };
}

/**
 * Checks a built bundle from four views: the file listing of the .app (entries `{rel, kind,
 * mode}`), its Info.plist as an object, the asar's file list, and the listing of app.asar.unpacked.
 * Returns problems `{code, detail}`; empty is a pass. Used by the script after packaging and by
 * the bundle test on a bundle found on disk.
 */
export function checkBundle({listing, plist, asarFiles, unpacked, options}) {
  const problems = [];
  const has = (rel) => listing.some((e) => e.rel === rel && e.kind === "file");
  const executable = (rel) => listing.some((e) => e.rel === rel && e.kind === "file" && (e.mode & 0o111) !== 0);
  if (!has("Contents/MacOS/clave-reader")) problems.push({code: "HELPER_MISSING", detail: "Contents/MacOS/clave-reader"});
  else if (!executable("Contents/MacOS/clave-reader")) problems.push({code: "HELPER_NOT_EXECUTABLE", detail: "Contents/MacOS/clave-reader"});
  if (!executable(`Contents/MacOS/${options.executableName}`)) problems.push({code: "EXECUTABLE_MISSING", detail: options.executableName});
  for (const rel of ["Contents/Resources/app.asar", "Contents/Resources/LICENSE", "Contents/Resources/LICENSES.chromium.html", "Contents/Info.plist"]) {
    if (!has(rel)) problems.push({code: "BUNDLE_FILE_MISSING", detail: rel});
  }
  if (listing.some((e) => e.rel === "Contents/Resources/app" && e.kind === "dir")) problems.push({code: "UNPACKED_APP_FOLDER", detail: "Contents/Resources/app"});
  for (const e of listing) {
    if (e.kind === "symlink" && !e.rel.startsWith("Contents/Frameworks/")) problems.push({code: "SYMLINK_OUTSIDE_FRAMEWORKS", detail: e.rel});
    if (e.kind === "file" && (e.rel.endsWith(".map") || posix.basename(e.rel) === ".DS_Store")) problems.push({code: "FORBIDDEN_FILE", detail: e.rel});
  }
  const expected = expectedPlist(options);
  for (const [key, value] of Object.entries(expected)) {
    if (plist[key] !== value) problems.push({code: "PLIST_KEY_WRONG", detail: key});
  }
  for (const key of PLIST_REMOVE) if (Object.hasOwn(plist, key)) problems.push({code: "PLIST_KEY_PRESENT", detail: key});
  const integrity = plist.ElectronAsarIntegrity;
  if (!integrity || typeof integrity !== "object" || !integrity["Resources/app.asar"]) problems.push({code: "ASAR_INTEGRITY_MISSING", detail: "ElectronAsarIntegrity"});
  for (const rel of ASAR_REQUIRED) if (!asarFiles.includes(rel)) problems.push({code: "ASAR_FILE_MISSING", detail: rel});
  for (const rel of asarFiles) {
    if (ASAR_FORBIDDEN.includes(rel) || rel.startsWith("/dist/native/") || rel.endsWith(".map")) problems.push({code: "ASAR_FORBIDDEN_FILE", detail: rel});
  }
  for (const root of UNPACKED_ROOTS) if (!unpacked.some((e) => e.rel === root && e.kind === "dir")) problems.push({code: "UNPACKED_ROOT_MISSING", detail: root});
  for (const e of unpacked) {
    if (e.kind !== "file") continue;
    const inRoot = UNPACKED_ROOTS.some((root) => e.rel.startsWith(root + "/"));
    if (!inRoot && !e.rel.endsWith(".node")) problems.push({code: "UNPACKED_STRAY_FILE", detail: e.rel});
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

const CACHE = join(homedir(), "Library", "Caches", "electron");

function zipCandidates(cacheDir) {
  if (!existsSync(cacheDir)) return [];
  const out = [];
  for (const entry of readdirSync(cacheDir, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(cacheDir, entry.name))) if (file.endsWith(".zip")) out.push(join(cacheDir, entry.name, file));
  }
  return out;
}

function listingOf(appPath) {
  return walk(appPath).map((e) => ({...e, mode: e.kind === "file" ? statSync(join(appPath, e.rel)).mode : 0}));
}

export function plistAsObject(plistPath) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]).toString());
}

/** @electron/asar is a dependency of packager, not of the app: resolve it through packager. */
async function loadAsar() {
  const req = createRequire(import.meta.url);
  const fromPackager = createRequire(req.resolve("@electron/packager"));
  return import(fromPackager.resolve("@electron/asar"));
}

export async function bundle({appDir, argv, env, home, log, err}) {
  const fail = (code, detail) => { err(`BUNDLE_FAILED ${code}${detail ? ` ${detail}` : ""}`); return 1; };
  const out = resolveOut(argv, home, appDir);
  if (out.error) return fail(out.error);
  const asked = requestedFlavour(argv);
  if (asked.error) return fail(asked.error);

  if (asked.flavour === "dev") return fail("DEV_FLAVOUR_NOT_PACKAGED");
  // Which staging: the one asked for, or the only one there is.
  let flavour = asked.flavour;
  if (flavour === null) {
    const present = existsSync(out.dir) ? readdirSync(out.dir).filter((f) => existsSync(join(out.dir, f, "staging", "manifest.json"))) : [];
    if (present.length !== 1) return fail("FLAVOUR_REQUIRED", `staged: ${present.join(",") || "none"}`);
    flavour = present[0];
  }
  const stagingDir = join(out.dir, flavour, "staging");
  const manifestPath = join(stagingDir, "manifest.json");
  if (!existsSync(manifestPath)) return fail("STAGING_MISSING", "run: pnpm --dir app package:stage");
  let info;
  try { info = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return fail("STAGING_MISSING"); }
  for (const rel of ["app/package.json", "app/dist/main.cjs", "helper/clave-reader", "electron/LICENSE", "electron/LICENSES.chromium.html"]) {
    if (!existsSync(join(stagingDir, rel))) return fail("STAGING_INCOMPLETE", rel);
  }

  const electronVersion = JSON.parse(readFileSync(join(appDir, "node_modules", "electron", "package.json"), "utf8")).version;
  const zip = findElectronZip(zipCandidates(env.CLAVE_ELECTRON_CACHE ?? CACHE), electronVersion);
  const allowDownload = argv.includes("--allow-download");
  if (zip === null && !allowDownload) return fail("ELECTRON_ZIP_MISSING", `electron-v${electronVersion}-darwin-arm64.zip; pass --allow-download to fetch it`);

  const iconPath = join(appDir, "build", "icon.icns");
  const bundleOut = join(out.dir, flavour, "bundle");
  const decided = packagerOptions({
    flavour, info, stagingDir, outDir: bundleOut, electronVersion,
    electronZipDir: zip ? dirname(zip) : undefined,
    iconPath: existsSync(iconPath) ? iconPath : undefined,
    entity: env.CLAVE_COPYRIGHT_ENTITY ?? "Clave"
  });
  if (decided.error) return fail(decided.error);
  const options = decided.options;
  const appPath = join(bundleOut, `${info.appName}-darwin-arm64`, `${info.appName}.app`);

  // Never delete a folder something is running from (the lesson of 2026-09-19): the WHOLE bundle
  // folder is removed below, so the whole folder is what is probed, whatever is inside it.
  if (existsSync(bundleOut)) {
    let probe = {defaultLocation: true, status: 1, output: ""};
    try { probe = {...probe, status: 0, output: execFileSync("/usr/bin/pgrep", ["-f", pgrepPattern(bundleOut)], {stdio: ["ignore", "pipe", "pipe"]}).toString()}; }
    catch (error) { probe = {...probe, status: Number.isInteger(error?.status) ? error.status : null, output: String(error?.stdout ?? "")}; }
    const answer = runningAppCheck(probe);
    if (answer === "running") return fail("APP_RUNNING", bundleOut);
    if (answer === "unanswered") return fail("PGREP_UNANSWERED");
  }
  rmSync(bundleOut, {recursive: true, force: true});

  const {packager} = await import("@electron/packager");
  const hooks = {
    // The template plist is read by packager AFTER this hook, so a key removed here stays removed.
    afterExtract: [async ({buildPath}) => {
      const plist = join(buildPath, "Electron.app", "Contents", "Info.plist");
      for (const key of PLIST_REMOVE) {
        try { execFileSync("/usr/bin/plutil", ["-remove", key, plist], {stdio: "ignore"}); } catch { /* not present: nothing to remove */ }
      }
    }]
  };
  let produced;
  try { produced = await packager({...options, ...hooks}); }
  catch (error) { return fail("PACKAGER_FAILED", error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : ""); }
  if (!Array.isArray(produced) || produced.length !== 1) return fail("PACKAGER_FAILED", `outputs ${Array.isArray(produced) ? produced.length : "?"}`);
  if (!existsSync(appPath)) return fail("PACKAGER_FAILED", `expected ${basename(appPath)}`);

  cpSync(join(stagingDir, "helper", "clave-reader"), join(appPath, "Contents", "MacOS", "clave-reader"));
  chmodSync(join(appPath, "Contents", "MacOS", "clave-reader"), 0o755);

  const asar = await loadAsar();
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  const unpackedPath = join(appPath, "Contents", "Resources", "app.asar.unpacked");
  const problems = checkBundle({
    listing: listingOf(appPath),
    plist: plistAsObject(join(appPath, "Contents", "Info.plist")),
    asarFiles: asar.listPackage(asarPath, {isPack: false}),
    unpacked: existsSync(unpackedPath) ? walk(unpackedPath) : [],
    options
  });
  if (problems.length > 0) return fail("BUNDLE_CHECK_FAILED", `${problems[0].code} ${problems[0].detail} (+${problems.length - 1})`);

  const bytes = (dir) => walk(dir).filter((e) => e.kind === "file").reduce((sum, e) => sum + statSync(join(dir, e.rel)).size, 0);
  const report = {
    flavour, appName: info.appName, version: info.version, buildNumber: info.buildNumber, electronVersion,
    bundleId: options.appBundleId, appPath: appPath.slice(out.dir.length + 1),
    bytes: {app: bytes(appPath), asar: statSync(asarPath).size, unpacked: existsSync(unpackedPath) ? bytes(unpackedPath) : 0},
    fused: false, signed: false, notarized: false
  };
  writeFileSync(join(bundleOut, "bundle-report.json"), JSON.stringify(report, null, 2) + "\n");
  log(`BUNDLE_OK ${flavour} ${info.appName}.app bytes ${report.bytes.app} asar ${report.bytes.asar} unpacked ${report.bytes.unpacked} at ${bundleOut}`);
  return 0;
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "bundle.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  bundle({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}).then((code) => process.exit(code));
}
