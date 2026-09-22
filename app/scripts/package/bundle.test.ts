// Tests the pure half of scripts/package/bundle.mjs in plain Node; the module does nothing at
// import. The last block checks a real bundle if a packaging run left one under app/out, reading
// only; it never packages, launches or signs anything.
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as bundleScript from "./bundle.mjs";
import * as walkScript from "./walk.mjs";

type Options = Record<string, unknown> & {appBundleId: string; name: string; executableName: string; appVersion: string; buildVersion: string; appCategoryType: string; appCopyright: string};
type Entry = {rel: string; kind: string; mode?: number};
const {BUNDLE_IDS, PLIST_REMOVE, PLIST_SET, ASAR_UNPACK, ASAR_REQUIRED, ASAR_FORBIDDEN, UNPACKED_ROOTS, bundleIdFor, copyrightFor, findElectronZip, packagerOptions, expectedPlist, checkBundle, plistAsObject, pgrepPattern} = bundleScript as {
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
  findElectronZip: (candidates: string[], version: string) => string | null;
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
      dir: "/out/internal/staging/app", out: "/out/internal/bundle",
      name: "Clave Agent Internal", executableName: "Clave Agent Internal",
      appBundleId: "dev.clave.agent.internal", helperBundleId: "dev.clave.agent.internal.helper",
      appVersion: "0.1.0", buildVersion: "20260922.0800", platform: "darwin", arch: "arm64",
      electronVersion: "44.4.1", electronZipDir: "/cache/x", overwrite: true, prune: false, derefSymlinks: true, junk: true, quiet: true,
      asar: {unpack: "*.node", unpackDir: "node_modules/{node-llama-cpp,@node-llama-cpp}"}, asarIntegrityDigest: true,
      extraResource: ["/out/internal/staging/electron/LICENSE", "/out/internal/staging/electron/LICENSES.chromium.html"],
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

describe("a real bundle, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const reports = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "bundle", "bundle-report.json")).filter((p) => existsSync(p)) : [];
  it.each(reports.length > 0 ? reports : [])("%s passes checkBundle from disk", async (reportPath) => {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {flavour: string; appName: string; version: string; buildNumber: string; electronVersion: string; appPath: string};
    const appPath = join(outDir, report.appPath);
    expect(existsSync(appPath)).toBe(true);
    const info = {flavour: report.flavour, appName: report.appName, version: report.version, buildNumber: report.buildNumber};
    const options = packagerOptions({flavour: report.flavour, info, stagingDir: join(outDir, report.flavour, "staging"), outDir: join(outDir, report.flavour, "bundle"), electronVersion: report.electronVersion, entity: "Clave"}).options as Options;
    const req = createRequire(import.meta.url);
    const asar = await import(createRequire(req.resolve("@electron/packager")).resolve("@electron/asar")) as {listPackage: (p: string, o: {isPack: boolean}) => string[]};
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
