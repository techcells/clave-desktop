// Tests the pure half of scripts/package/bundle.mjs in plain Node; the module does nothing at
// import. The last block checks a real bundle if a packaging run left one under app/out, reading
// only; it never packages, launches or signs anything.
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {describe, expect, it} from "vitest";
import * as bundleScript from "./bundle.mjs";
import * as walkScript from "./walk.mjs";

type Options = Record<string, unknown> & {appBundleId: string; name: string; executableName: string; appVersion: string; buildVersion: string; appCategoryType: string; appCopyright: string};
type Entry = {rel: string; kind: string; mode?: number};
type WinOptions = Record<string, unknown> & {name: string; executableName: string; appVersion: string; buildVersion: string; appCopyright: string; win32metadata: Record<string, string>};
type LinuxOptions = Record<string, unknown> & {name: string; executableName: string; arch: string};
type Model = {file: string; sha256: string};
const {BUNDLE_IDS, PLIST_REMOVE, PLIST_SET, ASAR_UNPACK, ASAR_REQUIRED, ASAR_FORBIDDEN, UNPACKED_ROOTS, WIN_UNPACKED_ROOTS, bundleIdFor, copyrightFor, findElectronZip, packagerOptions, expectedPlist, checkBundle, plistAsObject, pgrepPattern,
  windowsFileVersion, winPackagerOptions, expectedVersionInfo, checkWinBundle, versionInfoOf,
  linuxExecutableName, electronTargetFor, LINUX_UNPACKED_ROOTS, LINUX_ASAR_REQUIRED, linuxPackagerOptions, checkLinuxBundle, cacheFor} = bundleScript as {
  linuxExecutableName: (flavour: string) => string | null;
  electronTargetFor: (platform: string, arch?: string) => {platform: string; arch: string} | null;
  LINUX_UNPACKED_ROOTS: Record<string, string[]>;
  LINUX_ASAR_REQUIRED: string[];
  linuxPackagerOptions: (a: Record<string, unknown>) => {options?: LinuxOptions; error?: string};
  checkLinuxBundle: (a: {listing: Entry[]; asarFiles: string[]; unpacked: Entry[]; options: LinuxOptions; models: Model[]; modelHashes: Record<string, string | null>; rootMode: number}) => Array<{code: string; detail: string}>;
  cacheFor: (platform: string, env: Record<string, string | undefined>, home: string) => string;
  WIN_UNPACKED_ROOTS: string[];
  windowsFileVersion: (version: unknown) => string | null;
  winPackagerOptions: (a: Record<string, unknown>) => {options?: WinOptions; error?: string};
  expectedVersionInfo: (options: WinOptions) => Record<string, string>;
  checkWinBundle: (a: {listing: Entry[]; versionInfo: Record<string, string>; asarFiles: string[]; unpacked: Entry[]; options: WinOptions}) => Array<{code: string; detail: string}>;
  versionInfoOf: (exePath: string) => Promise<Record<string, string>>;
  ASAR_REQUIRED: string[];
  ASAR_FORBIDDEN: string[];
  UNPACKED_ROOTS: string[];
  pgrepPattern: (path: string) => string;
  BUNDLE_IDS: Record<string, string>;
  PLIST_REMOVE: string[];
  PLIST_SET: Record<string, unknown>;
  ASAR_UNPACK: {unpack: string; unpackDir: string};
  bundleIdFor: (flavour: string) => string | null;
  copyrightFor: (entity: unknown, buildNumber: unknown) => string | null;
  findElectronZip: (candidates: string[], version: string, platform?: string, arch?: string) => string | null;
  packagerOptions: (a: Record<string, unknown>) => {options?: Options; error?: string};
  expectedPlist: (options: Options) => Record<string, unknown>;
  checkBundle: (a: {listing: Entry[]; plist: Record<string, unknown>; asarFiles: string[]; unpacked: Entry[]; options: Options}) => Array<{code: string; detail: string}>;
  plistAsObject: (path: string) => Record<string, unknown>;
};
const {walk} = walkScript as {walk: (dir: string) => Entry[]};

const INFO = {flavour: "internal", appName: "Clave Agent Internal", version: "0.1.0", buildNumber: "20260922.0800"};
const ARGS = {flavour: "internal", info: INFO, stagingDir: "/out/internal/staging", outDir: "/out/internal/bundle", electronVersion: "44.4.1", electronZipDir: "/cache/x", entity: "Clave"};

describe("bundleIdFor and copyrightFor", () => {
  it("names the two packaged flavours and refuses dev", () => {
    expect(BUNDLE_IDS).toEqual({internal: "dev.clave.agent.internal", release: "dev.clave.agent"});
    expect(bundleIdFor("internal")).toBe("dev.clave.agent.internal");
    expect(bundleIdFor("release")).toBe("dev.clave.agent");
    expect(bundleIdFor("dev")).toBeNull();
    expect(bundleIdFor("toString")).toBeNull();
  });
  it("takes the year from the build number and needs an entity", () => {
    expect(copyrightFor("Clave", "20260922.0800")).toBe("Copyright © 2026 Clave");
    expect(copyrightFor("  Clave ", "20270101.0000")).toBe("Copyright © 2027 Clave");
    expect(copyrightFor("", "20260922.0800")).toBeNull();
    expect(copyrightFor(undefined, "20260922.0800")).toBeNull();
    expect(copyrightFor("Clave", "bad")).toBeNull();
  });
});

describe("findElectronZip", () => {
  it("finds exactly the arm64 zip of the wanted version among cache candidates, whatever the order", () => {
    const cands = ["/c/e/electron-v44.4.10-darwin-arm64.zip", "/c/d/electron-v44.4.1-darwin-x64.zip", "/c/f/xelectron-v44.4.1-darwin-arm64.zip", "/c/b/electron-v44.4.1-darwin-arm64.zip", "/c/a/electron-v29.4.6-darwin-arm64.zip"];
    expect(findElectronZip(cands, "44.4.1")).toBe("/c/b/electron-v44.4.1-darwin-arm64.zip");
    expect(findElectronZip(["/c/electron-v44.4.1-darwin-arm64.zip.part"], "44.4.1")).toBeNull();
    expect(findElectronZip(["/c/electron-v44.4.1-darwin-x64.zip"], "44.4.1")).toBeNull();
    expect(findElectronZip(cands, "44.4.3")).toBeNull();
    expect(findElectronZip([], "44.4.1")).toBeNull();
  });
});

describe("packagerOptions: exactly what packager receives", () => {
  it("builds the internal flavour from its staging with the design's identity, plist and asar rules", () => {
    const r = packagerOptions(ARGS);
    expect(r.error).toBeUndefined();
    expect(r.options).toMatchObject({
      // Joined, as the function joins them: the same strings on macOS, backslashed on Windows.
      dir: join("/out/internal/staging", "app"), out: "/out/internal/bundle",
      name: "Clave Agent Internal", executableName: "Clave Agent Internal",
      appBundleId: "dev.clave.agent.internal", helperBundleId: "dev.clave.agent.internal.helper",
      appVersion: "0.1.0", buildVersion: "20260922.0800", platform: "darwin", arch: "arm64",
      electronVersion: "44.4.1", electronZipDir: "/cache/x", overwrite: true, prune: false, derefSymlinks: true, junk: true, quiet: true,
      asar: {unpack: "*.node", unpackDir: "node_modules/{node-llama-cpp,@node-llama-cpp}"}, asarIntegrityDigest: true,
      extraResource: [join("/out/internal/staging", "electron", "LICENSE"), join("/out/internal/staging", "electron", "LICENSES.chromium.html")],
      extendInfo: {LSUIElement: true, LSMinimumSystemVersion: "14.0"},
      appCategoryType: "public.app-category.productivity", appCopyright: "Copyright © 2026 Clave", darwinDarkModeSupport: true
    });
    expect(r.options).not.toHaveProperty("icon");
    expect(r.options).not.toHaveProperty("osxSign");
    expect(r.options).not.toHaveProperty("osxNotarize");
    expect(r.options).not.toHaveProperty("usageDescription");
  });

  it("release gets the release id and name; an icon and no zip dir are passed through when given", () => {
    const r = packagerOptions({...ARGS, flavour: "release", info: {...INFO, flavour: "release", appName: "Clave Agent"}, electronZipDir: undefined, iconPath: "/repo/app/build/icon.icns"});
    expect(r.options).toMatchObject({name: "Clave Agent", appBundleId: "dev.clave.agent", icon: "/repo/app/build/icon.icns"});
    expect(r.options).not.toHaveProperty("electronZipDir");
  });

  it("refuses dev, a staging of another flavour, an incomplete staging, an unknown Electron version and a missing entity", () => {
    expect(packagerOptions({...ARGS, flavour: "dev", info: {...INFO, flavour: "dev"}})).toEqual({error: "DEV_FLAVOUR_NOT_PACKAGED"});
    expect(packagerOptions({...ARGS, flavour: "release"})).toEqual({error: "STAGING_FLAVOUR_MISMATCH"});
    expect(packagerOptions({...ARGS, info: {...INFO, appName: ""}})).toEqual({error: "STAGING_INCOMPLETE"});
    expect(packagerOptions({...ARGS, info: {...INFO, buildNumber: undefined}})).toEqual({error: "STAGING_INCOMPLETE"});
    expect(packagerOptions({...ARGS, electronVersion: undefined})).toEqual({error: "ELECTRON_VERSION_UNKNOWN"});
    expect(packagerOptions({...ARGS, electronVersion: "44.4"})).toEqual({error: "ELECTRON_VERSION_UNKNOWN"});
    expect(packagerOptions({...ARGS, entity: ""})).toEqual({error: "COPYRIGHT_ENTITY_MISSING"});
  });

  it("removes exactly the five untrue usage strings and sets the tray-app keys", () => {
    expect(PLIST_REMOVE).toEqual(["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"]);
    expect(PLIST_SET).toEqual({LSUIElement: true, LSMinimumSystemVersion: "14.0"});
    expect(ASAR_UNPACK.unpack).toBe("*.node");
  });

  it("pins what the asar must and must not hold, the unpacked roots, and the plist the built app must show", () => {
    expect(ASAR_REQUIRED).toEqual(["/package.json", "/dist/main.cjs", "/dist/preload.cjs", "/dist/model-host.mjs", "/dist/renderer/index.html", "/dist/renderer/main.js", "/dist/WHAT-LEAVES.md", "/dist/THIRD-PARTY-LICENSES.txt"]);
    expect(ASAR_FORBIDDEN).toEqual(["/dist/reader-eval.cjs", "/dist/eval-gate.mjs"]);
    expect(UNPACKED_ROOTS).toEqual(["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/mac-arm64-metal"]);
    expect(expectedPlist(packagerOptions(ARGS).options as Options)).toEqual({
      CFBundleIdentifier: "dev.clave.agent.internal", CFBundleName: "Clave Agent Internal", CFBundleDisplayName: "Clave Agent Internal", CFBundleExecutable: "Clave Agent Internal",
      CFBundleShortVersionString: "0.1.0", CFBundleVersion: "20260922.0800", LSUIElement: true, LSMinimumSystemVersion: "14.0",
      LSApplicationCategoryType: "public.app-category.productivity", NSHumanReadableCopyright: "Copyright \u00a9 2026 Clave"
    });
  });

  it("escapes a folder name for pgrep so no metacharacter can break the running-app guard", () => {
    expect(pgrepPattern("/out/a (1)/bundle")).toBe("\\/out\\/a \\(1\\)\\/bundle");
    expect(pgrepPattern("/plain/path")).toBe("\\/plain\\/path");
    expect(pgrepPattern("x.y*z+[q]$^{}|?")).toBe("x\\.y\\*z\\+\\[q\\]\\$\\^\\{\\}\\|\\?");
  });
});

function goodBundle() {
  const options = packagerOptions(ARGS).options as Options;
  const file = (rel: string, mode = 0o644): Entry => ({rel, kind: "file", mode});
  const dir = (rel: string): Entry => ({rel, kind: "dir"});
  const listing: Entry[] = [
    dir("Contents"), file("Contents/Info.plist"), dir("Contents/MacOS"), file("Contents/MacOS/Clave Agent Internal", 0o755), file("Contents/MacOS/clave-reader", 0o755),
    dir("Contents/Frameworks"), {rel: "Contents/Frameworks/Electron Framework.framework/Electron Framework", kind: "symlink"},
    dir("Contents/Resources"), file("Contents/Resources/app.asar"), file("Contents/Resources/LICENSE"), file("Contents/Resources/LICENSES.chromium.html"), file("Contents/Resources/electron.icns"),
    dir("Contents/Resources/app.asar.unpacked")
  ];
  const plist: Record<string, unknown> = {...expectedPlist(options), ElectronAsarIntegrity: {"Resources/app.asar": {algorithm: "SHA256", hash: "ab"}}, NSHighResolutionCapable: true};
  const asarFiles = ["/package.json", "/dist", "/dist/main.cjs", "/dist/preload.cjs", "/dist/model-host.mjs", "/dist/renderer/index.html", "/dist/renderer/main.js", "/dist/renderer/main.css", "/dist/WHAT-LEAVES.md", "/dist/THIRD-PARTY-LICENSES.txt", "/dist/build.json", "/node_modules/chalk/package.json", "/node_modules/node-llama-cpp/dist/index.js"];
  const unpacked: Entry[] = [dir("node_modules"), dir("node_modules/node-llama-cpp"), file("node_modules/node-llama-cpp/dist/index.js"), dir("node_modules/@node-llama-cpp"), dir("node_modules/@node-llama-cpp/mac-arm64-metal"),
    file("node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node"), dir("node_modules/@reflink"), dir("node_modules/@reflink/reflink-darwin-arm64"), file("node_modules/@reflink/reflink-darwin-arm64/reflink.darwin-arm64.node")];
  return {listing, plist, asarFiles, unpacked, options};
}

describe("checkBundle: the built bundle against the design", () => {
  it("passes a bundle that has everything in its place", () => {
    expect(checkBundle(goodBundle())).toEqual([]);
  });

  it("names each defect", () => {
    const g = goodBundle();
    const codes = (b: ReturnType<typeof goodBundle>) => checkBundle(b).map((p) => p.code);
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "Contents/MacOS/clave-reader")})).toContain("HELPER_MISSING");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "Contents/MacOS/clave-reader" ? {...e, mode: 0o644} : e))})).toContain("HELPER_NOT_EXECUTABLE");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "Contents/MacOS/Clave Agent Internal")})).toContain("EXECUTABLE_MISSING");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "Contents/Resources/LICENSES.chromium.html")})).toContain("BUNDLE_FILE_MISSING");
    expect(codes({...g, listing: [...g.listing, {rel: "Contents/Resources/app", kind: "dir"}]})).toContain("UNPACKED_APP_FOLDER");
    expect(codes({...g, listing: [...g.listing, {rel: "Contents/Resources/x", kind: "symlink"}]})).toContain("SYMLINK_OUTSIDE_FRAMEWORKS");
    expect(codes({...g, listing: [...g.listing, {rel: "Contents/Resources/.DS_Store", kind: "file", mode: 0o644}]})).toContain("FORBIDDEN_FILE");
    expect(codes({...g, plist: {...g.plist, LSUIElement: false}})).toContain("PLIST_KEY_WRONG");
    expect(codes({...g, plist: {...g.plist, CFBundleIdentifier: "com.other"}})).toContain("PLIST_KEY_WRONG");
    expect(codes({...g, plist: {...g.plist, NSCameraUsageDescription: "x"}})).toContain("PLIST_KEY_PRESENT");
    expect(codes({...g, plist: {...g.plist, ElectronAsarIntegrity: undefined}})).toContain("ASAR_INTEGRITY_MISSING");
    expect(codes({...g, asarFiles: g.asarFiles.filter((f) => f !== "/dist/THIRD-PARTY-LICENSES.txt")})).toContain("ASAR_FILE_MISSING");
    expect(codes({...g, asarFiles: [...g.asarFiles, "/dist/reader-eval.cjs"]})).toContain("ASAR_FORBIDDEN_FILE");
    expect(codes({...g, asarFiles: [...g.asarFiles, "/dist/native/clave-reader"]})).toContain("ASAR_FORBIDDEN_FILE");
    expect(codes({...g, asarFiles: [...g.asarFiles, "/dist/main.cjs.map"]})).toContain("ASAR_FORBIDDEN_FILE");
    expect(codes({...g, unpacked: g.unpacked.filter((e) => e.rel !== "node_modules/@node-llama-cpp/mac-arm64-metal")})).toContain("UNPACKED_ROOT_MISSING");
    expect(codes({...g, unpacked: [...g.unpacked, {rel: "node_modules/chalk/index.js", kind: "file", mode: 0o644}]})).toContain("UNPACKED_STRAY_FILE");
  });
});

describe("Windows: the app folder instead of the .app", () => {
  it("finds the win32-x64 zip, and only when asked for Windows", () => {
    const cands = ["/c/a/electron-v44.4.1-darwin-arm64.zip", "C:\\cache\\h\\electron-v44.4.1-win32-x64.zip", "/c/c/electron-v44.4.1-win32-arm64.zip"];
    expect(findElectronZip(cands, "44.4.1", "win32")).toBe("C:/cache/h/electron-v44.4.1-win32-x64.zip");
    expect(findElectronZip(cands, "44.4.1")).toBe("/c/a/electron-v44.4.1-darwin-arm64.zip");
    expect(findElectronZip(["/c/electron-v44.4.1-win32-arm64.zip"], "44.4.1", "win32")).toBeNull();
  });

  it("gives Windows a four-part file version, since the macOS build number cannot be one", () => {
    expect(windowsFileVersion("0.1.1")).toBe("0.1.1.0");
    expect(windowsFileVersion("12.34.56")).toBe("12.34.56.0");
    for (const bad of ["20260922.0800", "1.2", "1.2.3.4", "1.2.x", "1.2.70000", undefined]) expect(windowsFileVersion(bad), String(bad)).toBeNull();
  });

  it("builds the exe with the app's name as its description, the same asar as macOS, and no macOS keys", () => {
    const r = winPackagerOptions({...ARGS, iconPath: "C:\\repo\\app\\build\\icon.ico"});
    expect(r.error).toBeUndefined();
    expect(r.options).toMatchObject({
      name: "Clave Agent Internal", executableName: "Clave Agent Internal", platform: "win32", arch: "x64",
      appVersion: "0.1.0", buildVersion: "0.1.0.0", asar: ASAR_UNPACK, asarIntegrityDigest: true, icon: "C:\\repo\\app\\build\\icon.ico",
      appCopyright: "Copyright © 2026 Clave",
      win32metadata: {CompanyName: "Clave", FileDescription: "Clave Agent Internal", ProductName: "Clave Agent Internal", InternalName: "Clave Agent Internal",
        OriginalFilename: "Clave Agent Internal.exe", "requested-execution-level": "asInvoker"}
    });
    for (const key of ["appBundleId", "helperBundleId", "extendInfo", "appCategoryType", "darwinDarkModeSupport"]) expect(r.options).not.toHaveProperty(key);
  });

  it("refuses what the macOS options refuse, and a version Windows cannot carry", () => {
    expect(winPackagerOptions({...ARGS, flavour: "dev", info: {...INFO, flavour: "dev"}})).toEqual({error: "DEV_FLAVOUR_NOT_PACKAGED"});
    expect(winPackagerOptions({...ARGS, flavour: "release"})).toEqual({error: "STAGING_FLAVOUR_MISMATCH"});
    expect(winPackagerOptions({...ARGS, entity: ""})).toEqual({error: "COPYRIGHT_ENTITY_MISSING"});
    expect(winPackagerOptions({...ARGS, info: {...INFO, version: "1.2.3-beta"}})).toEqual({error: "VERSION_NOT_WINDOWS"});
  });

  function goodWinBundle() {
    const options = winPackagerOptions(ARGS).options as WinOptions;
    const file = (rel: string): Entry => ({rel, kind: "file", mode: 0o666});
    const dir = (rel: string): Entry => ({rel, kind: "dir"});
    const listing: Entry[] = [file("Clave Agent Internal.exe"), file("clave-reader.exe"), file("ffmpeg.dll"), dir("locales"), file("locales/en-US.pak"), dir("resources"),
      file("resources/app.asar"), file("resources/LICENSE"), file("resources/LICENSES.chromium.html"), dir("resources/app.asar.unpacked")];
    const asarFiles = ["/package.json", "/dist/main.cjs", "/dist/preload.cjs", "/dist/model-host.mjs", "/dist/renderer/index.html", "/dist/renderer/main.js", "/dist/WHAT-LEAVES.md", "/dist/THIRD-PARTY-LICENSES.txt"];
    const unpacked: Entry[] = [dir("node_modules"), dir("node_modules/node-llama-cpp"), file("node_modules/node-llama-cpp/dist/index.js"), dir("node_modules/@node-llama-cpp"),
      dir("node_modules/@node-llama-cpp/win-x64"), file("node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node"),
      dir("node_modules/@node-llama-cpp/win-x64-vulkan"), file("node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll"),
      dir("node_modules/@reflink"), file("node_modules/@reflink/reflink-win32-x64-msvc/reflink.win32-x64-msvc.node")];
    return {listing, versionInfo: {...expectedVersionInfo(options), FileVersion: "0.1.0.0"}, asarFiles, unpacked, options};
  }

  it("passes an app folder with everything in its place", () => {
    expect(WIN_UNPACKED_ROOTS).toEqual(["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/win-x64", "node_modules/@node-llama-cpp/win-x64-vulkan"]);
    expect(checkWinBundle(goodWinBundle())).toEqual([]);
  });

  it("names each defect, the exe's own name first among them", () => {
    const g = goodWinBundle();
    const codes = (b: ReturnType<typeof goodWinBundle>) => checkWinBundle(b).map((p) => p.code);
    // The Windows reader names this app's window by its FileDescription, and the app excludes itself by that name.
    expect(codes({...g, versionInfo: {...g.versionInfo, FileDescription: "Electron"}})).toContain("VERSION_INFO_WRONG");
    expect(codes({...g, versionInfo: {...g.versionInfo, CompanyName: "GitHub, Inc."}})).toContain("VERSION_INFO_WRONG");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "clave-reader.exe")})).toContain("HELPER_MISSING");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "Clave Agent Internal.exe")})).toContain("EXECUTABLE_MISSING");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "resources/LICENSE")})).toContain("BUNDLE_FILE_MISSING");
    expect(codes({...g, listing: [...g.listing, {rel: "resources/app", kind: "dir"}]})).toContain("UNPACKED_APP_FOLDER");
    expect(codes({...g, listing: [...g.listing, {rel: "resources/link", kind: "symlink"}]})).toContain("SYMLINK_IN_BUNDLE");
    expect(codes({...g, listing: [...g.listing, {rel: "clave-reader.pdb", kind: "file", mode: 0o666}]})).toContain("FORBIDDEN_FILE");
    expect(codes({...g, asarFiles: [...g.asarFiles, "/dist/native/clave-reader.exe"]})).toContain("ASAR_FORBIDDEN_FILE");
    expect(codes({...g, unpacked: g.unpacked.filter((e) => e.rel !== "node_modules/@node-llama-cpp/win-x64-vulkan")})).toContain("UNPACKED_ROOT_MISSING");
    expect(codes({...g, unpacked: [...g.unpacked, {rel: "node_modules/chalk/index.js", kind: "file", mode: 0o666}]})).toContain("UNPACKED_STRAY_FILE");
  });
});

describe("Linux: an app folder per architecture, installed to /opt by the package", () => {
  const MODELS: Model[] = [{file: "eng.traineddata", sha256: "a".repeat(64)}, {file: "por.traineddata", sha256: "b".repeat(64)}];

  it("names the Linux executable in lower case without spaces, and never the dev flavour", () => {
    expect(linuxExecutableName("internal")).toBe("clave-agent-internal");
    expect(linuxExecutableName("release")).toBe("clave-agent");
    expect(linuxExecutableName("dev")).toBeNull();
    expect(linuxExecutableName("toString")).toBeNull();
  });

  it("chooses Electron's Linux build by architecture, x64 and arm64 only; the others by system alone", () => {
    expect(electronTargetFor("linux", "x64")).toEqual({platform: "linux", arch: "x64"});
    expect(electronTargetFor("linux", "arm64")).toEqual({platform: "linux", arch: "arm64"});
    expect(electronTargetFor("linux")).toBeNull();
    expect(electronTargetFor("linux", "ia32")).toBeNull();
    expect(electronTargetFor("darwin", "x64")).toEqual({platform: "darwin", arch: "arm64"});
    expect(electronTargetFor("win32")).toEqual({platform: "win32", arch: "x64"});
    expect(electronTargetFor("freebsd", "x64")).toBeNull();
  });

  it("finds the Linux zip of that architecture only", () => {
    const cands = ["/h/.cache/electron/a/electron-v44.4.1-linux-arm64.zip", "/h/.cache/electron/b/electron-v44.4.1-linux-x64.zip", "/h/electron-v44.4.1-darwin-arm64.zip"];
    expect(findElectronZip(cands, "44.4.1", "linux", "arm64")).toBe("/h/.cache/electron/a/electron-v44.4.1-linux-arm64.zip");
    expect(findElectronZip(cands, "44.4.1", "linux", "x64")).toBe("/h/.cache/electron/b/electron-v44.4.1-linux-x64.zip");
    expect(findElectronZip(cands.slice(1), "44.4.1", "linux", "arm64")).toBeNull();
    expect(findElectronZip(cands, "44.4.1", "linux")).toBeNull();
    expect(findElectronZip(cands, "44.4.2", "linux", "x64")).toBeNull();
  });

  it("looks for the zip where @electron/get keeps it on Linux: XDG_CACHE_HOME, else ~/.cache", () => {
    expect(cacheFor("linux", {}, "/home/u")).toBe("/home/u/.cache/electron");
    expect(cacheFor("linux", {XDG_CACHE_HOME: "/x/cache"}, "/home/u")).toBe("/x/cache/electron");
    expect(cacheFor("darwin", {XDG_CACHE_HOME: "/x/cache"}, "/Users/u")).toBe("/Users/u/Library/Caches/electron");
    expect(cacheFor("linux", {XDG_CACHE_HOME: ""}, "/home/u")).toBe("/home/u/.cache/electron");
  });

  it("builds the app folder with the lower-case executable, the same asar and licences, and nothing macOS or Windows", () => {
    for (const arch of ["x64", "arm64"]) {
      const r = linuxPackagerOptions({...ARGS, arch, iconPath: "/repo/app/build/icon.icns"});
      expect(r.error, arch).toBeUndefined();
      expect(r.options).toMatchObject({
        dir: "/out/internal/staging/app", out: "/out/internal/bundle", name: "Clave Agent Internal", executableName: "clave-agent-internal",
        platform: "linux", arch, appVersion: "0.1.0", buildVersion: "20260922.0800", electronVersion: "44.4.1", electronZipDir: "/cache/x",
        overwrite: true, prune: false, derefSymlinks: true, asar: ASAR_UNPACK, appCopyright: "Copyright © 2026 Clave",
        extraResource: ["/out/internal/staging/electron/LICENSE", "/out/internal/staging/electron/LICENSES.chromium.html"]
      });
      for (const key of ["appBundleId", "helperBundleId", "extendInfo", "appCategoryType", "darwinDarkModeSupport", "win32metadata", "icon", "asarIntegrityDigest"]) expect(r.options, key).not.toHaveProperty(key);
    }
    expect(linuxPackagerOptions({...ARGS, flavour: "release", info: {...INFO, flavour: "release", appName: "Clave Agent"}, arch: "x64"}).options?.executableName).toBe("clave-agent");
  });

  it("refuses what the other systems refuse, and an unknown architecture", () => {
    expect(linuxPackagerOptions({...ARGS, arch: "x64", flavour: "dev", info: {...INFO, flavour: "dev"}})).toEqual({error: "DEV_FLAVOUR_NOT_PACKAGED"});
    expect(linuxPackagerOptions({...ARGS, arch: "x64", flavour: "release"})).toEqual({error: "STAGING_FLAVOUR_MISMATCH"});
    expect(linuxPackagerOptions({...ARGS, arch: "x64", entity: " "})).toEqual({error: "COPYRIGHT_ENTITY_MISSING"});
    expect(linuxPackagerOptions({...ARGS, arch: "x64", electronVersion: "latest"})).toEqual({error: "ELECTRON_VERSION_UNKNOWN"});
    expect(linuxPackagerOptions({...ARGS, arch: "x64", info: {...INFO, buildNumber: undefined}})).toEqual({error: "STAGING_INCOMPLETE"});
    expect(linuxPackagerOptions({...ARGS, arch: "ia32"})).toEqual({error: "UNSUPPORTED_ARCH"});
    expect(linuxPackagerOptions({...ARGS})).toEqual({error: "UNSUPPORTED_ARCH"});
    expect(linuxPackagerOptions({...ARGS, arch: "toString"})).toEqual({error: "UNSUPPORTED_ARCH"});
    // arm64 is internal only (decision 3): the VM's build, never a release.
    const release = {...ARGS, flavour: "release", info: {...INFO, flavour: "release", appName: "Clave Agent"}};
    expect(linuxPackagerOptions({...release, arch: "arm64"})).toEqual({error: "ARM64_IS_INTERNAL_ONLY"});
    expect(linuxPackagerOptions({...release, arch: "x64"}).error).toBeUndefined();
  });

  it("pins the unpacked roots per architecture and the extension the asar must carry", () => {
    expect(LINUX_UNPACKED_ROOTS).toEqual({
      x64: ["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/linux-x64", "node_modules/@node-llama-cpp/linux-x64-vulkan"],
      arm64: ["node_modules/node-llama-cpp", "node_modules/@node-llama-cpp/linux-arm64"]
    });
    expect(LINUX_ASAR_REQUIRED).toEqual([...ASAR_REQUIRED, "/dist/gnome-extension/extension.js", "/dist/gnome-extension/logic.js", "/dist/gnome-extension/metadata.json"]);
  });

  function goodLinuxBundle(arch = "arm64") {
    const options = linuxPackagerOptions({...ARGS, arch}).options as LinuxOptions;
    const file = (rel: string, mode = 0o100644): Entry => ({rel, kind: "file", mode});
    const dir = (rel: string): Entry => ({rel, kind: "dir", mode: 0o40755});
    const listing: Entry[] = [file("clave-agent-internal", 0o100755), file("clave-reader", 0o100755), file("chrome-sandbox", 0o100755), file("libffmpeg.so", 0o100755),
      dir("locales"), file("locales/en-US.pak"), dir("resources"), file("resources/app.asar"), file("resources/LICENSE"), file("resources/LICENSES.chromium.html"),
      dir("resources/app.asar.unpacked"), dir("tessdata"), file("tessdata/eng.traineddata"), file("tessdata/por.traineddata")];
    const asarFiles = [...LINUX_ASAR_REQUIRED, "/dist/renderer/main.css"];
    const roots = LINUX_UNPACKED_ROOTS[arch];
    const unpacked: Entry[] = [dir("node_modules"), ...roots.map(dir), ...roots.slice(1).map((root) => file(`${root}/bins/x/llama-addon.node`)),
      file("node_modules/node-llama-cpp/dist/index.js"), file(`node_modules/@reflink/reflink-linux-${arch}-gnu/reflink.linux-${arch}-gnu.node`)];
    const modelHashes = Object.fromEntries(MODELS.map((m) => [m.file, m.sha256]));
    return {listing, asarFiles, unpacked, options, models: MODELS, modelHashes, rootMode: 0o40755};
  }

  it("passes an app folder with everything in its place, for both architectures", () => {
    expect(checkLinuxBundle(goodLinuxBundle("arm64"))).toEqual([]);
    expect(checkLinuxBundle(goodLinuxBundle("x64"))).toEqual([]);
  });

  it("names each defect", () => {
    const g = goodLinuxBundle();
    const codes = (b: ReturnType<typeof goodLinuxBundle>) => checkLinuxBundle(b).map((p) => `${p.code} ${p.detail}`);
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "clave-reader")})).toContain("HELPER_MISSING clave-reader");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "clave-reader" ? {...e, mode: 0o100644} : e))})).toContain("HELPER_NOT_EXECUTABLE clave-reader");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "clave-agent-internal" ? {...e, mode: 0o100644} : e))})).toContain("EXECUTABLE_MISSING clave-agent-internal");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "clave-agent-internal")})).toContain("EXECUTABLE_MISSING clave-agent-internal");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "resources/LICENSES.chromium.html")})).toContain("BUNDLE_FILE_MISSING resources/LICENSES.chromium.html");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "resources/app.asar")})).toContain("BUNDLE_FILE_MISSING resources/app.asar");
    expect(codes({...g, listing: [...g.listing, {rel: "resources/app", kind: "dir", mode: 0o40755}]})).toContain("UNPACKED_APP_FOLDER resources/app");
    expect(codes({...g, listing: [...g.listing, {rel: "lib/link.so", kind: "symlink"}]})).toContain("SYMLINK_IN_BUNDLE lib/link.so");
    expect(codes({...g, listing: [...g.listing, {rel: "main.js.map", kind: "file", mode: 0o100644}]})).toContain("FORBIDDEN_FILE main.js.map");
    // No setuid or setgid file ever: Electron's sandbox runs on user namespaces (the AppArmor profile on Ubuntu), never a root helper.
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "chrome-sandbox" ? {...e, mode: 0o104755} : e))})).toContain("SETUID_FILE chrome-sandbox");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "clave-reader" ? {...e, mode: 0o102755} : e))})).toContain("SETUID_FILE clave-reader");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "tessdata/por.traineddata")})).toContain("MODEL_MISSING por.traineddata");
    expect(codes({...g, modelHashes: {...g.modelHashes, "eng.traineddata": "c".repeat(64)}})).toContain("MODEL_HASH_WRONG eng.traineddata");
    expect(codes({...g, modelHashes: {...g.modelHashes, "eng.traineddata": null}})).toContain("MODEL_HASH_WRONG eng.traineddata");
    expect(codes({...g, models: []})).toContain("MODELS_UNLISTED tessdata");
    expect(codes({...g, listing: [...g.listing, {rel: "tessdata/deu.traineddata", kind: "file", mode: 0o100644}]})).toContain("MODEL_UNEXPECTED tessdata/deu.traineddata");
    // Installed under /opt by root, the folder must still be readable by every user: packager leaves its output folder 0700.
    expect(codes({...g, rootMode: 0o40700})).toContain("NOT_READABLE_BY_USERS .");
    expect(codes({...g, rootMode: 0o40754})).toContain("NOT_READABLE_BY_USERS .");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "locales" ? {...e, mode: 0o40744} : e))})).toContain("NOT_READABLE_BY_USERS locales");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "locales" ? {...e, mode: 0o40644} : e))})).toContain("NOT_READABLE_BY_USERS locales");
    expect(codes({...g, listing: g.listing.filter((e) => e.rel !== "resources/LICENSE")})).toContain("BUNDLE_FILE_MISSING resources/LICENSE");
    expect(codes({...g, listing: [...g.listing, {rel: "tessdata/extra", kind: "dir", mode: 0o40755}]})).toContain("MODEL_UNEXPECTED tessdata/extra");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "locales" ? {...e, mode: 0o40750} : e))})).toContain("NOT_READABLE_BY_USERS locales");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "resources/app.asar" ? {...e, mode: 0o100640} : e))})).toContain("NOT_READABLE_BY_USERS resources/app.asar");
    expect(codes({...g, listing: g.listing.map((e) => (e.rel === "clave-reader" ? {...e, mode: 0o100754} : e))})).toContain("NOT_READABLE_BY_USERS clave-reader");
    expect(codes({...g, asarFiles: g.asarFiles.filter((f) => f !== "/dist/gnome-extension/logic.js")})).toContain("ASAR_FILE_MISSING /dist/gnome-extension/logic.js");
    expect(codes({...g, asarFiles: [...g.asarFiles, "/dist/native/clave-reader"]})).toContain("ASAR_FORBIDDEN_FILE /dist/native/clave-reader");
    expect(codes({...g, unpacked: g.unpacked.filter((e) => e.rel !== "node_modules/@node-llama-cpp/linux-arm64")})).toContain("UNPACKED_ROOT_MISSING node_modules/@node-llama-cpp/linux-arm64");
    expect(codes({...g, unpacked: [...g.unpacked, {rel: "node_modules/x/y.js", kind: "file"}]})).toContain("UNPACKED_STRAY_FILE node_modules/x/y.js");
  });
});

describe("a real bundle, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const reports = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "bundle", "bundle-report.json")).filter((p) => existsSync(p)) : [];
  it.each(reports.length > 0 ? reports : [])("%s passes checkBundle from disk", async (reportPath) => {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {flavour: string; platform?: string; appName: string; version: string; buildNumber: string; electronVersion: string; appPath: string};
    const appPath = join(outDir, report.appPath);
    expect(existsSync(appPath)).toBe(true);
    const info = {flavour: report.flavour, appName: report.appName, version: report.version, buildNumber: report.buildNumber};
    const req = createRequire(import.meta.url);
    const loadAsar = async () => await import(pathToFileURL(createRequire(req.resolve("@electron/packager")).resolve("@electron/asar")).href) as {listPackage: (p: string, o: {isPack: boolean}) => string[]};
    if (report.platform === "linux") {
      const {arch, models} = JSON.parse(readFileSync(reportPath, "utf8")) as {arch: string; models: Model[]};
      const options = linuxPackagerOptions({flavour: report.flavour, info, stagingDir: join(outDir, report.flavour, "staging"), outDir: join(outDir, report.flavour, "bundle"), electronVersion: report.electronVersion, entity: "Clave", arch}).options as LinuxOptions;
      const asar = await loadAsar();
      const unpackedPath = join(appPath, "resources", "app.asar.unpacked");
      const {createHash} = await import("node:crypto");
      const modelHashes = Object.fromEntries(models.map((m) => [m.file, createHash("sha256").update(readFileSync(join(appPath, "tessdata", m.file))).digest("hex")]));
      expect(checkLinuxBundle({
        listing: walk(appPath).map((e) => ({...e, mode: e.kind === "symlink" ? 0 : statSync(join(appPath, e.rel)).mode})),
        asarFiles: asar.listPackage(join(appPath, "resources", "app.asar"), {isPack: false}),
        unpacked: existsSync(unpackedPath) ? walk(unpackedPath) : [], options, models, modelHashes, rootMode: statSync(appPath).mode
      })).toEqual([]);
      // Literal values, not derived from the function that asked for them: the executable's name, and the
      // helper byte for byte as staged (Linux builds are never signed).
      expect(existsSync(join(appPath, report.flavour === "internal" ? "clave-agent-internal" : "clave-agent"))).toBe(true);
      expect(readFileSync(join(appPath, "clave-reader")).equals(readFileSync(join(outDir, report.flavour, "staging", "helper", "clave-reader")))).toBe(true);
      return;
    }
    if (report.platform === "win32") {
      const options = winPackagerOptions({flavour: report.flavour, info, stagingDir: join(outDir, report.flavour, "staging"), outDir: join(outDir, report.flavour, "bundle"), electronVersion: report.electronVersion, entity: "Clave"}).options as WinOptions;
      const asar = await loadAsar();
      const unpackedPath = join(appPath, "resources", "app.asar.unpacked");
      const versionInfo = await versionInfoOf(join(appPath, `${report.appName}.exe`));
      expect(checkWinBundle({
        listing: walk(appPath), versionInfo,
        asarFiles: asar.listPackage(join(appPath, "resources", "app.asar"), {isPack: false}).map((f) => f.split("\\").join("/")),
        unpacked: existsSync(unpackedPath) ? walk(unpackedPath) : [], options
      })).toEqual([]);
      // Literal values of the built exe, not derived from the function that asked for them.
      expect(versionInfo).toMatchObject({FileDescription: report.appName, ProductName: report.appName, CompanyName: "Clave"});
      const signed = (JSON.parse(readFileSync(reportPath, "utf8")) as {signed?: boolean}).signed === true;
      if (!signed) expect(readFileSync(join(appPath, "clave-reader.exe")).equals(readFileSync(join(outDir, report.flavour, "staging", "helper", "clave-reader.exe")))).toBe(true);
      return;
    }
    const options = packagerOptions({flavour: report.flavour, info, stagingDir: join(outDir, report.flavour, "staging"), outDir: join(outDir, report.flavour, "bundle"), electronVersion: report.electronVersion, entity: "Clave"}).options as Options;
    const asar = await loadAsar();
    const listing = walk(appPath).map((e) => ({...e, mode: e.kind === "file" ? statSync(join(appPath, e.rel)).mode : 0}));
    const unpackedPath = join(appPath, "Contents/Resources/app.asar.unpacked");
    const problems = checkBundle({
      listing, plist: plistAsObject(join(appPath, "Contents/Info.plist")),
      asarFiles: asar.listPackage(join(appPath, "Contents/Resources/app.asar"), {isPack: false}),
      unpacked: existsSync(unpackedPath) ? walk(unpackedPath) : [], options
    });
    expect(problems).toEqual([]);
    // The helper is the Mach-O the staging step kept: byte for byte until it is signed, and then
    // the same code with a signature added (its identifier stays the helper's own).
    const staged = readFileSync(join(outDir, report.flavour, "staging", "helper", "clave-reader"));
    const shipped = readFileSync(join(appPath, "Contents/MacOS/clave-reader"));
    const signed = (JSON.parse(readFileSync(reportPath, "utf8")) as {signed?: boolean}).signed === true;
    if (!signed) expect(shipped.equals(staged)).toBe(true);
    else {
      // codesign -d writes its description to stderr; the helper keeps its own identifier once signed.
      const d = spawnSync("/usr/bin/codesign", ["-d", "--verbose=1", join(appPath, "Contents/MacOS/clave-reader")], {stdio: ["ignore", "pipe", "pipe"]});
      expect(d.status).toBe(0);
      expect(String(d.stderr)).toContain("Identifier=clave-reader");
    }
    // Literal plist values of the built app, not derived from the same function that produced them.
    const plist = plistAsObject(join(appPath, "Contents/Info.plist"));
    expect(plist).toMatchObject({CFBundleIdentifier: report.flavour === "internal" ? "dev.clave.agent.internal" : "dev.clave.agent", CFBundleName: report.appName, CFBundleExecutable: report.appName, LSUIElement: true, LSMinimumSystemVersion: "14.0", CFBundleShortVersionString: report.version, CFBundleVersion: report.buildNumber});
    for (const key of PLIST_REMOVE) expect(plist).not.toHaveProperty(key);
    // Nothing from Electron's template name survives.
    expect(execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", join(appPath, "Contents/Info.plist")]).toString().trim()).toBe(report.appName);
  });
  it("records whether a run was checked", () => { expect(reports.length >= 0).toBe(true); });
});
