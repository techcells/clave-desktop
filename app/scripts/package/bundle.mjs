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
import {fileURLToPath, pathToFileURL} from "node:url";
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
/** The same on Windows: node-llama-cpp and its two x64 builds (`stage.mjs` TARGETS.win32). */
export const WIN_UNPACKED_ROOTS = ["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/win-x64", "node_modules/@node-llama-cpp/win-x64-vulkan"];
const unpackedRootsFor = (platform) => (platform === "win32" ? WIN_UNPACKED_ROOTS : UNPACKED_ROOTS);

/** Electron's platform and arch in its zip names and in packager's options, per system packaged. */
export const ELECTRON_TARGETS = {darwin: {platform: "darwin", arch: "arm64"}, win32: {platform: "win32", arch: "x64"}};

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

/** Among candidate paths, the cached Electron zip for this version and system (macOS arm64 by default), or null. */
export function findElectronZip(candidates, version, platform = "darwin") {
  const target = ELECTRON_TARGETS[platform] ?? ELECTRON_TARGETS.darwin;
  const wanted = `electron-v${version}-${target.platform}-${target.arch}.zip`;
  return candidates.map((p) => p.split("\\").join("/")).find((p) => posix.basename(p) === wanted) ?? null;
}

/**
 * A Windows file version: four numbers, each at most 65535. The macOS build number (`YYYYMMDD.HHMM`)
 * cannot be one, so Windows carries the app version with a fourth `0`, and the build number stays in
 * the bundle report and About. `null` for a version that is not three plain numbers.
 */
export function windowsFileVersion(version) {
  const parts = String(version).split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[0-9]+$/.test(p) && Number(p) <= 65535)) return null;
  return `${parts.join(".")}.0`;
}

/**
 * The @electron/packager options for Windows: the same asar, licences and identity as macOS, and in
 * place of the plist the exe's version resource. FileDescription is not decoration: it is the name
 * the Windows reader reports for this app's own window, and the app excludes itself by that name.
 */
export function winPackagerOptions({flavour, info, stagingDir, outDir, electronVersion, electronZipDir, iconPath, entity}) {
  if (bundleIdFor(flavour) === null) return {error: "DEV_FLAVOUR_NOT_PACKAGED"};
  if (!info || info.flavour !== flavour) return {error: "STAGING_FLAVOUR_MISMATCH"};
  if (typeof info.appName !== "string" || !info.appName || typeof info.version !== "string" || !info.version || typeof info.buildNumber !== "string") return {error: "STAGING_INCOMPLETE"};
  if (typeof electronVersion !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(electronVersion)) return {error: "ELECTRON_VERSION_UNKNOWN"};
  const copyright = copyrightFor(entity, info.buildNumber);
  if (copyright === null) return {error: "COPYRIGHT_ENTITY_MISSING"};
  const fileVersion = windowsFileVersion(info.version);
  if (fileVersion === null) return {error: "VERSION_NOT_WINDOWS"};
  const options = {
    dir: join(stagingDir, "app"),
    out: outDir,
    name: info.appName,
    executableName: info.appName,
    appVersion: info.version,
    buildVersion: fileVersion,
    platform: "win32",
    arch: "x64",
    electronVersion,
    overwrite: true,
    prune: false,
    derefSymlinks: true,
    junk: true,
    quiet: true,
    asar: ASAR_UNPACK,
    asarIntegrityDigest: true,
    extraResource: [join(stagingDir, "electron", "LICENSE"), join(stagingDir, "electron", "LICENSES.chromium.html")],
    appCopyright: copyright,
    win32metadata: {
      CompanyName: entity.trim(),
      FileDescription: info.appName,
      ProductName: info.appName,
      InternalName: info.appName,
      OriginalFilename: `${info.appName}.exe`,
      // A tray app that reads the user's own windows: it never asks for administrator rights.
      "requested-execution-level": "asInvoker"
    }
  };
  if (electronZipDir) options.electronZipDir = electronZipDir;
  if (iconPath) options.icon = iconPath;
  return {options};
}

/** The version-resource strings the built exe must carry, given the options it was built with. */
export function expectedVersionInfo(options) {
  return {
    FileDescription: options.win32metadata.FileDescription,
    ProductName: options.win32metadata.ProductName,
    CompanyName: options.win32metadata.CompanyName,
    OriginalFilename: options.win32metadata.OriginalFilename,
    LegalCopyright: options.appCopyright
  };
}

/**
 * Checks a built Windows app folder, the counterpart of `checkBundle`: the listing of the folder, the
 * exe's version strings, the asar's file list and the listing of app.asar.unpacked. The asar rules
 * are the same as on macOS. Nothing in the folder may be a link, and the helper sits beside the exe,
 * where the app looks for it first (`app.ts`, `chooseHelperPath`).
 */
export function checkWinBundle({listing, versionInfo, asarFiles, unpacked, options}) {
  const problems = [];
  const has = (rel) => listing.some((e) => e.rel === rel && e.kind === "file");
  if (!has("clave-reader.exe")) problems.push({code: "HELPER_MISSING", detail: "clave-reader.exe"});
  if (!has(`${options.executableName}.exe`)) problems.push({code: "EXECUTABLE_MISSING", detail: `${options.executableName}.exe`});
  for (const rel of ["resources/app.asar", "resources/LICENSE", "resources/LICENSES.chromium.html"]) {
    if (!has(rel)) problems.push({code: "BUNDLE_FILE_MISSING", detail: rel});
  }
  if (listing.some((e) => e.rel === "resources/app" && e.kind === "dir")) problems.push({code: "UNPACKED_APP_FOLDER", detail: "resources/app"});
  for (const e of listing) {
    if (e.kind === "symlink") problems.push({code: "SYMLINK_IN_BUNDLE", detail: e.rel});
    if (e.kind === "file" && (e.rel.endsWith(".map") || e.rel.toLowerCase().endsWith(".pdb"))) problems.push({code: "FORBIDDEN_FILE", detail: e.rel});
  }
  for (const [key, value] of Object.entries(expectedVersionInfo(options))) {
    if (versionInfo?.[key] !== value) problems.push({code: "VERSION_INFO_WRONG", detail: key});
  }
  problems.push(...checkAsar({asarFiles, unpacked, platform: "win32"}));
  return problems;
}

/** The asar and unpacked-folder rules both systems share. */
function checkAsar({asarFiles, unpacked, platform}) {
  const problems = [];
  const roots = unpackedRootsFor(platform);
  for (const rel of ASAR_REQUIRED) if (!asarFiles.includes(rel)) problems.push({code: "ASAR_FILE_MISSING", detail: rel});
  for (const rel of asarFiles) {
    if (ASAR_FORBIDDEN.includes(rel) || rel.startsWith("/dist/native/") || rel.endsWith(".map")) problems.push({code: "ASAR_FORBIDDEN_FILE", detail: rel});
  }
  for (const root of roots) if (!unpacked.some((e) => e.rel === root && e.kind === "dir")) problems.push({code: "UNPACKED_ROOT_MISSING", detail: root});
  for (const e of unpacked) {
    if (e.kind !== "file") continue;
    const inRoot = roots.some((root) => e.rel.startsWith(root + "/"));
    if (!inRoot && !e.rel.endsWith(".node")) problems.push({code: "UNPACKED_STRAY_FILE", detail: e.rel});
  }
  return problems;
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
  problems.push(...checkAsar({asarFiles, unpacked, platform: "darwin"}));
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

/** Where @electron/get keeps its zips: `~/Library/Caches/electron` on macOS, `%LOCALAPPDATA%\electron\Cache` on Windows. */
const cacheFor = (platform, env) => (platform === "win32"
  ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "electron", "Cache")
  : join(homedir(), "Library", "Caches", "electron"));

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
  return import(pathToFileURL(fromPackager.resolve("@electron/asar")).href);
}

/** The string table of an exe's version resource, read with resedit (packager's own dependency). */
export async function versionInfoOf(exePath) {
  const req = createRequire(import.meta.url);
  const fromPackager = createRequire(req.resolve("@electron/packager"));
  const ResEdit = await import(pathToFileURL(fromPackager.resolve("resedit")).href);
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath));
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(ResEdit.NtExecutableResource.from(exe).entries);
  const [language] = info?.getAllLanguagesForStringValues() ?? [];
  return language ? info.getStringValues(language) : {};
}

/**
 * Is anything running from under `dir`? The same three answers `runningAppCheck` gives for pgrep:
 * on Windows the process list is asked through PowerShell, with the folder passed in the environment
 * rather than on the command line, so no quoting of a path with spaces can go wrong.
 */
export function runningProbe(dir, platform) {
  const probe = {defaultLocation: true, status: 1, output: ""};
  if (platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:CLAVE_PROBE_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }";
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {stdio: ["ignore", "pipe", "pipe"], env: {...process.env, CLAVE_PROBE_DIR: dir}, windowsHide: true}).toString();
      return {...probe, status: output.trim() ? 0 : 1, output};
    } catch { return {...probe, status: null}; }
  }
  try { return {...probe, status: 0, output: execFileSync("/usr/bin/pgrep", ["-f", pgrepPattern(dir)], {stdio: ["ignore", "pipe", "pipe"]}).toString()}; }
  catch (error) { return {...probe, status: Number.isInteger(error?.status) ? error.status : null, output: String(error?.stdout ?? "")}; }
}

export async function bundle({appDir, argv, env, home, log, err, platform: host = process.platform}) {
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
  // A staging is packaged on the system it was made for: its node_modules hold that system's binaries.
  // A manifest from before Windows names no platform, and was made on macOS.
  const platform = info.platform ?? "darwin";
  if (!Object.hasOwn(ELECTRON_TARGETS, platform)) return fail("UNSUPPORTED_PLATFORM", platform);
  if (platform !== host) return fail("STAGING_FOR_ANOTHER_SYSTEM", `staged for ${platform}, running on ${host}`);
  const windows = platform === "win32";
  const helperName = info.helper?.name ?? "clave-reader";
  for (const rel of ["app/package.json", "app/dist/main.cjs", `helper/${helperName}`, "electron/LICENSE", "electron/LICENSES.chromium.html"]) {
    if (!existsSync(join(stagingDir, rel))) return fail("STAGING_INCOMPLETE", rel);
  }

  const electronVersion = JSON.parse(readFileSync(join(appDir, "node_modules", "electron", "package.json"), "utf8")).version;
  const target = ELECTRON_TARGETS[platform];
  const zip = findElectronZip(zipCandidates(env.CLAVE_ELECTRON_CACHE ?? cacheFor(platform, env)), electronVersion, platform);
  const allowDownload = argv.includes("--allow-download");
  if (zip === null && !allowDownload) return fail("ELECTRON_ZIP_MISSING", `electron-v${electronVersion}-${target.platform}-${target.arch}.zip; pass --allow-download to fetch it`);

  const iconPath = join(appDir, "build", windows ? "icon.ico" : "icon.icns");
  const bundleOut = join(out.dir, flavour, "bundle");
  const decided = (windows ? winPackagerOptions : packagerOptions)({
    flavour, info, stagingDir, outDir: bundleOut, electronVersion,
    electronZipDir: zip ? dirname(zip) : undefined,
    iconPath: existsSync(iconPath) ? iconPath : undefined,
    entity: env.CLAVE_COPYRIGHT_ENTITY ?? "Clave"
  });
  if (decided.error) return fail(decided.error);
  const options = decided.options;
  const folder = join(bundleOut, `${info.appName}-${target.platform}-${target.arch}`);
  // What the later steps sign and package: the .app on macOS, the app folder on Windows.
  const appPath = windows ? folder : join(folder, `${info.appName}.app`);

  // Never delete a folder something is running from (the lesson of 2026-09-19): the WHOLE bundle
  // folder is removed below, so the whole folder is what is probed, whatever is inside it.
  if (existsSync(bundleOut)) {
    const answer = runningAppCheck(runningProbe(bundleOut, platform));
    if (answer === "running") return fail("APP_RUNNING", bundleOut);
    if (answer === "unanswered") return fail("PGREP_UNANSWERED");
  }
  rmSync(bundleOut, {recursive: true, force: true});

  const {packager} = await import("@electron/packager");
  const hooks = windows ? {} : {
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

  // The helper beside the app's own executable: where app.ts looks for it first.
  if (windows) cpSync(join(stagingDir, "helper", helperName), join(appPath, helperName));
  else {
    cpSync(join(stagingDir, "helper", helperName), join(appPath, "Contents", "MacOS", helperName));
    chmodSync(join(appPath, "Contents", "MacOS", helperName), 0o755);
  }

  const asar = await loadAsar();
  const resources = windows ? join(appPath, "resources") : join(appPath, "Contents", "Resources");
  const asarPath = join(resources, "app.asar");
  const unpackedPath = join(resources, "app.asar.unpacked");
  // @electron/asar lists with this system's separator; the checks are written with posix ones.
  const asarFiles = asar.listPackage(asarPath, {isPack: false}).map((f) => f.split("\\").join("/"));
  const unpacked = existsSync(unpackedPath) ? walk(unpackedPath) : [];
  const problems = windows
    ? checkWinBundle({listing: listingOf(appPath), versionInfo: await versionInfoOf(join(appPath, `${options.executableName}.exe`)), asarFiles, unpacked, options})
    : checkBundle({listing: listingOf(appPath), plist: plistAsObject(join(appPath, "Contents", "Info.plist")), asarFiles, unpacked, options});
  if (problems.length > 0) return fail("BUNDLE_CHECK_FAILED", `${problems[0].code} ${problems[0].detail} (+${problems.length - 1})`);

  const bytes = (dir) => walk(dir).filter((e) => e.kind === "file").reduce((sum, e) => sum + statSync(join(dir, e.rel)).size, 0);
  const report = {
    flavour, platform, appName: info.appName, version: info.version, buildNumber: info.buildNumber, electronVersion,
    bundleId: bundleIdFor(flavour), appPath: appPath.slice(out.dir.length + 1),
    ...(windows ? {executable: `${options.executableName}.exe`, helper: helperName} : {}),
    bytes: {app: bytes(appPath), asar: statSync(asarPath).size, unpacked: existsSync(unpackedPath) ? bytes(unpackedPath) : 0},
    fused: false, signed: false, notarized: false
  };
  writeFileSync(join(bundleOut, "bundle-report.json"), JSON.stringify(report, null, 2) + "\n");
  log(`BUNDLE_OK ${flavour} ${basename(appPath)} bytes ${report.bytes.app} asar ${report.bytes.asar} unpacked ${report.bytes.unpacked} at ${bundleOut}`);
  return 0;
}

if (process.argv[1] && posix.basename(process.argv[1].split("\\").join("/")) === "bundle.mjs") {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  bundle({appDir, argv: process.argv, env: process.env, home: homedir(), log: console.log, err: console.error}).then((code) => process.exit(code));
}
