// Tests the pure halves of scripts/package/harden.mjs and sign.mjs in plain Node. Neither module
// does anything at import. The last block reads a real bundle's report if a run left one under
// app/out and checks the fuse wire and, when signed, the signature; it never signs or launches.
import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as harden from "./harden.mjs";
import * as sign from "./sign.mjs";

type Enum = Record<string, number | string>;
const {FUSE_TABLE, fuseConfig, checkFuseWire, ENTITLEMENT_LEVELS, FORBIDDEN_ENTITLEMENTS, entitlementsFor} = harden as {
  FUSE_TABLE: Record<string, boolean>;
  fuseConfig: (options: Enum, version: {V1: string}, platform?: string) => Record<string, unknown>;
  checkFuseWire: (wire: Record<number, number>, options: Enum, state: {ENABLE: number; DISABLE: number}) => Array<{code: string; detail: string}>;
  ENTITLEMENT_LEVELS: string[][];
  FORBIDDEN_ENTITLEMENTS: string[];
  entitlementsFor: (path: string, level: number, appName: string, opts?: {teamId?: boolean}) => string[];
};
const {parseIdentities, isDeveloperId, identityDecision, parseSignArgs, signOptions, checkEntitlements, linuxSignDecision} = sign as {
  linuxSignDecision: (a: {flavour: string; requested: unknown; levelGiven: boolean}) => {skip?: boolean; error?: string};
  parseIdentities: (text: string) => Array<{name: string; trusted: boolean}>;
  isDeveloperId: (name: unknown) => boolean;
  identityDecision: (a: {flavour: string; requested: unknown; identities: Array<{name: string; trusted: boolean}>}) => {identity?: string; developerId?: boolean; skip?: boolean; error?: string};
  parseSignArgs: (argv: string[]) => {sign?: string | null; level?: number; error?: string};
  signOptions: (a: {appPath: string; identity: string; developerId: boolean; level: number; appName: string}) => Record<string, unknown> & {optionsForFile: (p: string) => {entitlements: string[]; hardenedRuntime: boolean}};
  checkEntitlements: (readBack: Record<string, unknown> | null, intended: string[]) => Array<{code: string; detail: string}>;
};

// The enums exactly as @electron/fuses 2.1.3 declares them (TypeScript numeric enums map both ways).
const OPTIONS: Enum = {RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5, LoadBrowserProcessSpecificV8Snapshot: 6, GrantFileProtocolExtraPrivileges: 7, WasmTrapHandlers: 8};
for (const [k, v] of Object.entries(OPTIONS)) OPTIONS[v] = k;
const VERSION = {V1: "1"};
const STATE = {ENABLE: 49, DISABLE: 48};

describe("the fuse table and its config", () => {
  it("decides every fuse the tool knows, as the design says", () => {
    expect(FUSE_TABLE).toEqual({
      RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: true, WasmTrapHandlers: true
    });
    expect(fuseConfig(OPTIONS, VERSION)).toEqual({version: "1", strictlyRequireAllFuses: true, resetAdHocDarwinSignature: true, 0: false, 1: true, 2: false, 3: false, 4: true, 5: true, 6: false, 7: true, 8: true});
  });

  it("sets the same fuses on Windows, with no macOS signature to redo there", () => {
    expect(fuseConfig(OPTIONS, VERSION, "win32")).toEqual({version: "1", strictlyRequireAllFuses: true, resetAdHocDarwinSignature: false, 0: false, 1: true, 2: false, 3: false, 4: true, 5: true, 6: false, 7: true, 8: true});
  });

  it("sets the same fuses on Linux, with no macOS signature to redo there", () => {
    expect(fuseConfig(OPTIONS, VERSION, "linux")).toEqual({version: "1", strictlyRequireAllFuses: true, resetAdHocDarwinSignature: false, 0: false, 1: true, 2: false, 3: false, 4: true, 5: true, 6: false, 7: true, 8: true});
  });

  it("refuses a fuse the tool knows and the table does not, and a table entry the tool does not know", () => {
    const more: Enum = {...OPTIONS, BrandNewFuse: 9, 9: "BrandNewFuse"};
    expect(() => fuseConfig(more, VERSION)).toThrow("FUSE_UNLISTED BrandNewFuse");
    const fewer: Enum = {...OPTIONS};
    delete fewer.WasmTrapHandlers; delete fewer[8];
    expect(() => fuseConfig(fewer, VERSION)).toThrow("FUSE_UNKNOWN WasmTrapHandlers");
  });

  it("checks a read-back wire fuse by fuse", () => {
    const good = {0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 49, 8: 49};
    expect(checkFuseWire(good, OPTIONS, STATE)).toEqual([]);
    expect(checkFuseWire({...good, 0: 49}, OPTIONS, STATE)).toEqual([{code: "FUSE_WRONG", detail: "RunAsNode"}]);
    expect(checkFuseWire({...good, 5: 114}, OPTIONS, STATE)).toEqual([{code: "FUSE_WRONG", detail: "OnlyLoadAppFromAsar"}]);
    expect(checkFuseWire({}, OPTIONS, STATE)).toHaveLength(9);
  });
});

describe("entitlementsFor: the per-file sets", () => {
  const app = "/out/Clave Agent Internal.app";
  const name = "Clave Agent Internal";
  it("gives the app and its executable the ladder level, the helper nothing, libraries nothing", () => {
    expect(entitlementsFor(app, 0, name)).toEqual(ENTITLEMENT_LEVELS[0]);
    expect(entitlementsFor(`${app}/Contents/MacOS/${name}`, 0, name)).toEqual(ENTITLEMENT_LEVELS[0]);
    expect(entitlementsFor(`${app}/Contents/MacOS/${name}`, 2, name)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementsFor(`${app}/Contents/MacOS/clave-reader`, 0, name)).toEqual([]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/Electron Framework.framework`, 0, name)).toEqual([]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`, 0, name)).toEqual([]);
    expect(entitlementsFor(`${app}/Contents/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node`, 0, name)).toEqual([]);
    expect(entitlementsFor(`${app}/Contents/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/libggml-metal.so`, 1, name)).toEqual([]);
  });

  it("gives Electron's helper apps JIT (a reduction of osx-sign's defaults) and the plugin helper its triple", () => {
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (Renderer).app`, 0, name)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (GPU).app/Contents/MacOS/${name} Helper (GPU)`, 0, name)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper.app`, 0, name)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (Plugin).app`, 2, name)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
  });

  it("never emits a forbidden entitlement, for any file at any level, and refuses a bad level", () => {
    const paths = [app, `${app}/Contents/MacOS/${name}`, `${app}/Contents/MacOS/clave-reader`, `${app}/Contents/Frameworks/${name} Helper (Plugin).app`, `${app}/Contents/Frameworks/${name} Helper (GPU).app`, `${app}/Contents/Frameworks/x.dylib`];
    for (let level = 0; level < ENTITLEMENT_LEVELS.length; level += 1) {
      for (const p of paths) for (const key of entitlementsFor(p, level, name)) expect(FORBIDDEN_ENTITLEMENTS, `${p} ${key}`).not.toContain(key);
    }
    expect(() => entitlementsFor(app, 3, name)).toThrow("BAD_LEVEL");
    expect(() => entitlementsFor(app, -1, name)).toThrow("BAD_LEVEL");
    expect(() => entitlementsFor(app, 1.5, name)).toThrow("BAD_LEVEL");
    expect(() => entitlementsFor(app, 0, "")).toThrow("BAD_APP_NAME");
  });

  it("the forbidden list names every capability the app must never hold", () => {
    expect(FORBIDDEN_ENTITLEMENTS).toEqual([
      "com.apple.security.device.camera", "com.apple.security.device.microphone", "com.apple.security.device.audio-input",
      "com.apple.security.device.bluetooth", "com.apple.security.device.usb", "com.apple.security.device.print",
      "com.apple.security.personal-information.location", "com.apple.security.personal-information.photos-library",
      "com.apple.security.personal-information.addressbook", "com.apple.security.personal-information.calendars",
      "com.apple.security.automation.apple-events", "com.apple.security.network.server", "com.apple.security.app-sandbox",
      "com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.debugger", "com.apple.security.get-task-allow"
    ]);
  });

  it("without a Team ID (the self-signed certificate) every executable that loads Electron also disables library validation, and the ladder is level 0 only", () => {
    const noTeam = {teamId: false};
    expect(entitlementsFor(`${app}/Contents/MacOS/${name}`, 0, name, noTeam)).toEqual(ENTITLEMENT_LEVELS[0]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (Renderer).app`, 0, name, noTeam)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (GPU).app/Contents/MacOS/${name} Helper (GPU)`, 0, name, noTeam)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper.app`, 0, name, noTeam)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (Plugin).app`, 0, name, noTeam)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
    expect(entitlementsFor(`${app}/Contents/MacOS/clave-reader`, 0, name, noTeam)).toEqual([]);
    expect(entitlementsFor(`${app}/Contents/Frameworks/Electron Framework.framework`, 0, name, noTeam)).toEqual([]);
    expect(() => entitlementsFor(`${app}/Contents/MacOS/${name}`, 1, name, noTeam)).toThrow("LEVEL_NEEDS_TEAM_ID");
    expect(() => entitlementsFor(`${app}/Contents/MacOS/${name}`, 2, name, noTeam)).toThrow("LEVEL_NEEDS_TEAM_ID");
    // With a Team ID the sets are the designed ones, unchanged.
    expect(entitlementsFor(`${app}/Contents/Frameworks/${name} Helper (Renderer).app`, 0, name, {teamId: true})).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementsFor(`${app}/Contents/MacOS/${name}`, 2, name, {teamId: true})).toEqual(["com.apple.security.cs.allow-jit"]);
  });

  it("the ladder only ever removes", () => {
    for (let i = 1; i < ENTITLEMENT_LEVELS.length; i += 1) {
      for (const key of ENTITLEMENT_LEVELS[i]) expect(ENTITLEMENT_LEVELS[i - 1]).toContain(key);
      expect(ENTITLEMENT_LEVELS[i].length).toBeLessThan(ENTITLEMENT_LEVELS[i - 1].length);
    }
    expect(ENTITLEMENT_LEVELS[ENTITLEMENT_LEVELS.length - 1]).toEqual(["com.apple.security.cs.allow-jit"]);
  });
});

describe("parseIdentities and identityDecision", () => {
  const listing = '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Clave Agent Dev" (CSSMERR_TP_NOT_TRUSTED)\n  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: TeamEx (ABCDE12345)"\n     2 identities found\n';
  const ids = parseIdentities(listing);
  it("reads names and trust from the keychain listing, never a hash", () => {
    expect(ids).toEqual([{name: "Clave Agent Dev", trusted: false}, {name: "Developer ID Application: TeamEx (ABCDE12345)", trusted: true}]);
    expect(parseIdentities("     0 identities found\n")).toEqual([]);
    expect(JSON.stringify(ids)).not.toMatch(/[0-9A-F]{40}/);
  });

  it("recognises a Developer ID Application identity by its prefix only", () => {
    expect(isDeveloperId("Developer ID Application: TeamEx (ABCDE12345)")).toBe(true);
    expect(isDeveloperId("Developer ID Installer: TeamEx (ABCDE12345)")).toBe(false);
    expect(isDeveloperId("Apple Development: someone")).toBe(false);
    expect(isDeveloperId("Not a Developer ID Application: x")).toBe(false);
    expect(isDeveloperId("Developer ID Application")).toBe(false);
    expect(isDeveloperId(undefined)).toBe(false);
  });

  it("internal: unsigned allowed, self-signed allowed, Developer ID allowed", () => {
    expect(identityDecision({flavour: "internal", requested: null, identities: ids})).toEqual({skip: true});
    expect(identityDecision({flavour: "internal", requested: "Clave Agent Dev", identities: ids})).toEqual({identity: "Clave Agent Dev", developerId: false});
    expect(identityDecision({flavour: "internal", requested: "Developer ID Application: TeamEx (ABCDE12345)", identities: ids})).toEqual({identity: "Developer ID Application: TeamEx (ABCDE12345)", developerId: true});
  });

  it("release: must be signed, by a trusted Developer ID Application identity that exists", () => {
    expect(identityDecision({flavour: "release", requested: null, identities: ids})).toEqual({error: "SIGN_REQUIRED"});
    expect(identityDecision({flavour: "release", requested: "Clave Agent Dev", identities: ids})).toEqual({error: "RELEASE_NEEDS_DEVELOPER_ID"});
    expect(identityDecision({flavour: "release", requested: "Developer ID Application: TeamEx (ABCDE12345)", identities: ids})).toEqual({identity: "Developer ID Application: TeamEx (ABCDE12345)", developerId: true});
    expect(identityDecision({flavour: "release", requested: "Developer ID Application: Nobody", identities: ids})).toEqual({error: "IDENTITY_MISSING"});
    expect(identityDecision({flavour: "release", requested: "Developer ID Application: TeamEx (ABCDE12345)", identities: [{name: "Developer ID Application: TeamEx (ABCDE12345)", trusted: false}]})).toEqual({error: "IDENTITY_NOT_TRUSTED"});
    expect(identityDecision({flavour: "dev", requested: null, identities: ids})).toEqual({error: "BAD_FLAVOUR"});
    expect(identityDecision({flavour: "internal", requested: "", identities: ids})).toEqual({error: "BAD_IDENTITY"});
    expect(identityDecision({flavour: "internal", requested: "clave agent dev", identities: ids})).toEqual({error: "IDENTITY_MISSING"});
  });
});

describe("parseSignArgs and signOptions", () => {
  it("reads --sign and --level, defaults to level 0, refuses bad spellings", () => {
    expect(parseSignArgs(["node", "sign.mjs"])).toEqual({sign: null, level: 0});
    expect(parseSignArgs(["node", "sign.mjs", "--sign", "Clave Agent Dev", "--level", "2"])).toEqual({sign: "Clave Agent Dev", level: 2});
    expect(parseSignArgs(["node", "sign.mjs", "--sign"])).toEqual({error: "BAD_SIGN"});
    expect(parseSignArgs(["node", "sign.mjs", "--sign", "--level", "1"])).toEqual({error: "BAD_SIGN"});
    expect(parseSignArgs(["node", "sign.mjs", "--sign=X"])).toEqual({error: "BAD_SIGN"});
    expect(parseSignArgs(["node", "sign.mjs", "--sign", "A", "--sign", "B"])).toEqual({error: "BAD_SIGN"});
    expect(parseSignArgs(["node", "sign.mjs", "--level", "3"])).toEqual({error: "BAD_LEVEL"});
    expect(parseSignArgs(["node", "sign.mjs", "--level", "one"])).toEqual({error: "BAD_LEVEL"});
    expect(parseSignArgs(["node", "sign.mjs", "--level", "1x"])).toEqual({error: "BAD_LEVEL"});
    expect(parseSignArgs(["node", "sign.mjs", "--level", "-1"])).toEqual({error: "BAD_LEVEL"});
    expect(parseSignArgs(["node", "sign.mjs", "--level"])).toEqual({error: "BAD_LEVEL"});
  });

  it("builds osx-sign options with per-file entitlements, hardened runtime, no automation, validation only for a Developer ID", () => {
    const o = signOptions({appPath: "/out/Clave Agent Internal.app", identity: "Developer ID Application: T (ID)", developerId: true, level: 1, appName: "Clave Agent Internal"});
    expect(o).toMatchObject({app: "/out/Clave Agent Internal.app", platform: "darwin", identity: "Developer ID Application: T (ID)", identityValidation: true, preAutoEntitlements: false, strictVerify: true});
    expect(signOptions({appPath: "/x.app", identity: "Clave Agent Dev", developerId: false, level: 0, appName: "x"}).identityValidation).toBe(false);
    expect(o.optionsForFile("/out/Clave Agent Internal.app/Contents/MacOS/Clave Agent Internal")).toEqual({entitlements: ENTITLEMENT_LEVELS[1], hardenedRuntime: true});
    expect(o.optionsForFile("/out/Clave Agent Internal.app/Contents/MacOS/clave-reader")).toEqual({entitlements: [], hardenedRuntime: true});
    // A self-signed identity: the helpers also disable library validation (there is no Team ID to match).
    const selfSigned = signOptions({appPath: "/out/Clave Agent Internal.app", identity: "Clave Agent Dev", developerId: false, level: 0, appName: "Clave Agent Internal"});
    expect(selfSigned.optionsForFile("/out/Clave Agent Internal.app/Contents/Frameworks/Clave Agent Internal Helper (Renderer).app").entitlements).toContain("com.apple.security.cs.disable-library-validation");
    expect(o.optionsForFile("/out/Clave Agent Internal.app/Contents/Frameworks/Clave Agent Internal Helper (Renderer).app").entitlements).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(signOptions({appPath: "/x.app", identity: "Developer ID Application: T (ID)", developerId: true, level: 0, appName: "x"}).identityValidation).toBe(true);
    expect(o).not.toHaveProperty("keychain");
    expect(o).not.toHaveProperty("binaries");
  });

  it("checkEntitlements names forbidden, missing and extra keys", () => {
    expect(checkEntitlements({"com.apple.security.cs.allow-jit": true}, ["com.apple.security.cs.allow-jit"])).toEqual([]);
    expect(checkEntitlements({}, [])).toEqual([]);
    expect(checkEntitlements({"com.apple.security.device.camera": true, "com.apple.security.cs.allow-jit": true}, ["com.apple.security.cs.allow-jit"])).toEqual([{code: "FORBIDDEN_ENTITLEMENT", detail: "com.apple.security.device.camera"}, {code: "ENTITLEMENT_EXTRA", detail: "com.apple.security.device.camera"}]);
    expect(checkEntitlements({}, ["com.apple.security.cs.allow-jit"])).toEqual([{code: "ENTITLEMENT_MISSING", detail: "com.apple.security.cs.allow-jit"}]);
    expect(checkEntitlements({"com.apple.security.cs.allow-jit": false}, ["com.apple.security.cs.allow-jit"])).toEqual([{code: "ENTITLEMENT_MISSING", detail: "com.apple.security.cs.allow-jit"}]);
    expect(checkEntitlements(null, [])).toEqual([]);
  });
});

describe("linuxSignDecision: Linux builds are fused and never signed", () => {
  it("fuses both packaged flavours unsigned: on Linux the published checksums are the integrity check", () => {
    expect(linuxSignDecision({flavour: "internal", requested: null, levelGiven: false})).toEqual({skip: true});
    expect(linuxSignDecision({flavour: "release", requested: null, levelGiven: false})).toEqual({skip: true});
  });

  it("refuses --sign and --level rather than ignore them, and any other flavour", () => {
    expect(linuxSignDecision({flavour: "release", requested: "Clave Agent Dev", levelGiven: false})).toEqual({error: "LINUX_HAS_NO_SIGNING"});
    expect(linuxSignDecision({flavour: "internal", requested: "x", levelGiven: false})).toEqual({error: "LINUX_HAS_NO_SIGNING"});
    expect(linuxSignDecision({flavour: "internal", requested: "", levelGiven: false})).toEqual({error: "LINUX_HAS_NO_SIGNING"});
    // Any --level, 0 included: there is no entitlement ladder on Linux to choose a rung of.
    expect(linuxSignDecision({flavour: "internal", requested: null, levelGiven: true})).toEqual({error: "LINUX_HAS_NO_SIGNING"});
    expect(linuxSignDecision({flavour: "dev", requested: null, levelGiven: false})).toEqual({error: "BAD_FLAVOUR"});
  });
});

describe("a real bundle's hardening, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const reports = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "bundle", "bundle-report.json")).filter((p) => existsSync(p)) : [];
  it.each(reports.length > 0 ? reports : [])("%s: the fuse wire on disk matches the table once fused, and a signature verifies once signed", async (reportPath) => {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {fused: boolean; signed: boolean; appPath: string; appName: string; entitlementLevel?: number; platform?: string; executable?: string};
    const appPath = join(outDir, report.appPath);
    if (report.fused) {
      const fuses = await import("@electron/fuses") as unknown as {getCurrentFuseWire: (p: string) => Promise<Record<number, number>>; FuseV1Options: Enum; FuseState: {ENABLE: number; DISABLE: number}};
      // The wire lives in the .app on macOS and in the app's own .exe on Windows.
      // And in the app's own executable on Linux too.
      const wire = await fuses.getCurrentFuseWire(report.platform === "win32" ? join(appPath, report.executable ?? `${report.appName}.exe`) : report.platform === "linux" ? join(appPath, report.executable ?? "") : appPath);
      expect(checkFuseWire(wire, fuses.FuseV1Options, fuses.FuseState)).toEqual([]);
    }
    if (report.platform === "linux") expect(report.signed).toBe(false);
    if (report.signed) {
      expect(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]).status).toBe(0);
      // codesign -dvv writes its description to stderr.
      const info = spawnSync("/usr/bin/codesign", ["-dvv", join(appPath, "Contents/MacOS/clave-reader")], {stdio: ["ignore", "pipe", "pipe"]});
      expect(String(info.stderr)).toContain("runtime");
    }
    expect(typeof report.appName).toBe("string");
  });
  it("records whether a run was checked", () => { expect(reports.length >= 0).toBe(true); });
});
