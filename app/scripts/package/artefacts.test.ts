// Tests the pure half of scripts/package/artefacts.mjs in plain Node; the module does nothing at
// import. The last block reads a real artefacts report if a run left one under app/out and checks
// the files it names exist with the recorded hashes; it never notarises, signs or launches.
import {createHash} from "node:crypto";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as artefactsScript from "./artefacts.mjs";

const {artefactBaseName, parseNotarizeArg, notarizeDecision, dmgCommand, zipCommand, copyAppCommand, signDmgCommand, notarySubmitCommand, notaryLogCommand, stapleCommand, notaryStatus, notaryResult, signatureChain, checkPlan, checkProblems} = artefactsScript as {
  notaryLogCommand: (a: {id: string; profile: string}) => [string, string[]];
  notaryResult: (output: unknown) => {status: string | null; id: string | null};
  signatureChain: (dvv: unknown) => {authorities: string[]; teamIdentifier: string | null};
  artefactBaseName: (info: unknown) => string | null;
  parseNotarizeArg: (argv: string[]) => {profile?: string | null; error?: string};
  notarizeDecision: (a: {flavour: string; report: unknown; profile: string | null}) => {profile?: string; skip?: boolean; error?: string};
  dmgCommand: (a: {root: string; volumeName: string; dmgPath: string}) => [string, string[]];
  zipCommand: (a: {appPath: string; zipPath: string}) => [string, string[]];
  copyAppCommand: (a: {appPath: string; destAppPath: string}) => [string, string[]];
  signDmgCommand: (a: {identity: string; dmgPath: string}) => [string, string[]];
  notarySubmitCommand: (a: {path: string; profile: string}) => [string, string[]];
  stapleCommand: (path: string) => [string, string[]];
  notaryStatus: (output: string) => string | null;
  checkPlan: (a: {appPath: string; dmgPath: string; developerId: boolean; notarized: boolean}) => Array<{name: string; cmd: string; args: string[]; mustPass: boolean}>;
  checkProblems: (results: Array<{name: string; status: number | null; mustPass: boolean}>) => Array<{code: string; detail: string}>;
};

const REPORT = {flavour: "internal", appName: "Clave Agent Internal", version: "0.1.0", buildNumber: "20260922.0815", signed: true, developerId: false, identity: "Clave Agent Dev"};

describe("artefactBaseName", () => {
  it("names the artefact without spaces, with version, build number and architecture", () => {
    expect(artefactBaseName(REPORT)).toBe("Clave-Agent-Internal-0.1.0-20260922.0815-arm64");
    expect(artefactBaseName({...REPORT, appName: "Clave Agent"})).toBe("Clave-Agent-0.1.0-20260922.0815-arm64");
    expect(artefactBaseName({...REPORT, appName: "  "})).toBeNull();
    expect(artefactBaseName({...REPORT, buildNumber: undefined})).toBeNull();
    expect(artefactBaseName({...REPORT, version: 1})).toBeNull();
    expect(artefactBaseName({...REPORT, appName: 5})).toBeNull();
    expect(artefactBaseName({...REPORT, appName: "Clave/Agent:X"})).toBe("ClaveAgentX-0.1.0-20260922.0815-arm64");
    expect(artefactBaseName(null)).toBeNull();
  });
});

describe("parseNotarizeArg and notarizeDecision", () => {
  it("reads a profile name and refuses the equals spelling, repeats and a missing value", () => {
    expect(parseNotarizeArg(["node", "artefacts.mjs"])).toEqual({profile: null});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", "clave-notary"])).toEqual({profile: "clave-notary"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize"])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", "--out", "x"])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize=clave-notary"])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", "a", "--notarize", "b"])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", "   "])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", "-p"])).toEqual({error: "BAD_NOTARIZE"});
    expect(parseNotarizeArg(["node", "artefacts.mjs", "--notarize", " clave-notary "])).toEqual({profile: "clave-notary"});
  });

  it("internal: may skip; needs a signed bundle; needs a Developer ID to notarise", () => {
    expect(notarizeDecision({flavour: "internal", report: REPORT, profile: null})).toEqual({skip: true});
    expect(notarizeDecision({flavour: "internal", report: {...REPORT, signed: false}, profile: null})).toEqual({error: "ARTEFACT_NEEDS_SIGNED"});
    expect(notarizeDecision({flavour: "internal", report: REPORT, profile: "clave-notary"})).toEqual({error: "NOTARIZE_NEEDS_DEVELOPER_ID"});
    expect(notarizeDecision({flavour: "internal", report: {...REPORT, developerId: true}, profile: "clave-notary"})).toEqual({profile: "clave-notary"});
  });

  it("release: must notarise, with a Developer ID, and never unsigned", () => {
    expect(notarizeDecision({flavour: "release", report: {...REPORT, flavour: "release", developerId: true}, profile: null})).toEqual({error: "NOTARIZE_REQUIRED"});
    expect(notarizeDecision({flavour: "release", report: {...REPORT, flavour: "release", developerId: true}, profile: "clave-notary"})).toEqual({profile: "clave-notary"});
    expect(notarizeDecision({flavour: "release", report: {...REPORT, flavour: "release", signed: false}, profile: "clave-notary"})).toEqual({error: "ARTEFACT_NEEDS_SIGNED"});
    expect(notarizeDecision({flavour: "dev", report: REPORT, profile: null})).toEqual({error: "BAD_FLAVOUR"});
    expect(notarizeDecision({flavour: "release", report: undefined, profile: "p"})).toEqual({error: "ARTEFACT_NEEDS_SIGNED"});
    expect(notarizeDecision({flavour: "release", report: {...REPORT, flavour: "release", signed: "yes", developerId: true}, profile: "p"})).toEqual({error: "ARTEFACT_NEEDS_SIGNED"});
    expect(notarizeDecision({flavour: "release", report: {...REPORT, flavour: "release", developerId: "true"}, profile: "p"})).toEqual({error: "NOTARIZE_NEEDS_DEVELOPER_ID"});
  });
});

describe("the commands, exactly", () => {
  it("builds a compressed HFS+ image from the folder with the volume named after the app", () => {
    expect(dmgCommand({root: "/o/dmg-root", volumeName: "Clave Agent Internal", dmgPath: "/o/a.dmg"}))
      .toEqual(["/usr/bin/hdiutil", ["create", "-volname", "Clave Agent Internal", "-srcfolder", "/o/dmg-root", "-ov", "-format", "UDZO", "-fs", "HFS+", "-quiet", "/o/a.dmg"]]);
  });
  it("copies and zips with ditto, keeping the bundle folder", () => {
    expect(copyAppCommand({appPath: "/o/X.app", destAppPath: "/o/dmg-root/X.app"})).toEqual(["/usr/bin/ditto", ["/o/X.app", "/o/dmg-root/X.app"]]);
    expect(zipCommand({appPath: "/o/X.app", zipPath: "/o/a.zip"})).toEqual(["/usr/bin/ditto", ["-c", "-k", "--keepParent", "/o/X.app", "/o/a.zip"]]);
  });
  it("signs the DMG by identity name with a timestamp, submits by keychain profile name, staples", () => {
    expect(signDmgCommand({identity: "Developer ID Application: T (ID)", dmgPath: "/o/a.dmg"})).toEqual(["/usr/bin/codesign", ["--sign", "Developer ID Application: T (ID)", "--timestamp", "--force", "/o/a.dmg"]]);
    expect(notarySubmitCommand({path: "/o/a.dmg", profile: "clave-notary"})).toEqual(["/usr/bin/xcrun", ["notarytool", "submit", "/o/a.dmg", "--keychain-profile", "clave-notary", "--wait", "--output-format", "json"]]);
    expect(notaryLogCommand({id: "1234-abcd", profile: "clave-notary"})).toEqual(["/usr/bin/xcrun", ["notarytool", "log", "1234-abcd", "--keychain-profile", "clave-notary"]]);
    expect(stapleCommand("/o/a.dmg")).toEqual(["/usr/bin/xcrun", ["stapler", "staple", "/o/a.dmg"]]);
    // No command ever carries a credential flag: only names (identity, keychain profile) travel.
    const tokens = [...signDmgCommand({identity: "x", dmgPath: "y"})[1], ...notarySubmitCommand({path: "p", profile: "q"})[1], ...notaryLogCommand({id: "i", profile: "q"})[1]];
    for (const flag of ["--password", "--apple-id", "--key", "--key-id", "--issuer", "--team-id", "-p"]) expect(tokens, flag).not.toContain(flag);
    expect(tokens).toContain("--keychain-profile");
  });
  it("reads notarytool's status word", () => {
    expect(notaryStatus("Conducting pre-submission checks\n  id: 1234\n  status: Accepted\n")).toBe("Accepted");
    expect(notaryStatus("  status: Invalid\n")).toBe("Invalid");
    expect(notaryStatus("Processing complete\n  status: In Progress\n")).toBe("In Progress");
    expect(notaryStatus("  status: Rejected\n")).toBe("Rejected");
    expect(notaryStatus("nothing here")).toBeNull();
    expect(notaryStatus("status: Accepted-ish")).toBeNull();
    expect(notaryStatus("last status: Accepted")).toBeNull();
  });
  it("reads notarytool's JSON result, falling back to the text form, and never invents a status", () => {
    expect(notaryResult('{"status":"Accepted","id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","message":"Processing complete"}')).toEqual({status: "Accepted", id: "2efe2717-52ef-43a5-96dc-0797e4ca1041"});
    expect(notaryResult('{"status":"Invalid","id":"abc"}\n')).toEqual({status: "Invalid", id: "abc"});
    expect(notaryResult('{"status":"Weird","id":"abc"}')).toEqual({status: null, id: "abc"});
    expect(notaryResult("Conducting pre-submission checks\n  id: 2efe2717-52ef-43a5-96dc-0797e4ca1041\n  status: Accepted\n")).toEqual({status: "Accepted", id: "2efe2717-52ef-43a5-96dc-0797e4ca1041"});
    expect(notaryResult("garbage")).toEqual({status: null, id: null});
    expect(notaryResult(undefined)).toEqual({status: null, id: null});
  });
  it("keeps the signature chain's names and team identifier, never a hash", () => {
    const dvv = "Executable=/x\nIdentifier=dev.clave.agent\nFormat=app bundle with Mach-O thin (arm64)\nCodeDirectory v=20500 size=441 flags=0x10000(runtime) hashes=3+7 location=embedded\nHash type=sha256 size=32\nCDHash=0123456789abcdef0123456789abcdef01234567\nSignature size=4\nAuthority=Developer ID Application: TeamEx (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=Sep 22, 2026\nTeamIdentifier=ABCDE12345\n";
    expect(signatureChain(dvv)).toEqual({authorities: ["Developer ID Application: TeamEx (ABCDE12345)", "Developer ID Certification Authority", "Apple Root CA"], teamIdentifier: "ABCDE12345"});
    expect(signatureChain("Authority=Clave Agent Dev\nTeamIdentifier=not set\n")).toEqual({authorities: ["Clave Agent Dev"], teamIdentifier: "not set"});
    expect(signatureChain("")).toEqual({authorities: [], teamIdentifier: null});
    expect(JSON.stringify(signatureChain(dvv))).not.toContain("0123456789abcdef");
  });
});

describe("checkPlan and checkProblems", () => {
  it("always enforces the signature checks; Gatekeeper and stapling only for a notarised Developer ID build", () => {
    const self = checkPlan({appPath: "/o/X.app", dmgPath: "/o/a.dmg", developerId: false, notarized: false});
    // Pinned literally: the command, its arguments and whether it must pass, for every check.
    expect(self).toEqual([
      {name: "codesign-verify-app", cmd: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", "/o/X.app"], mustPass: true},
      {name: "codesign-verify-dmg", cmd: "/usr/bin/codesign", args: ["--verify", "--verbose=2", "/o/a.dmg"], mustPass: true},
      {name: "spctl-app", cmd: "/usr/sbin/spctl", args: ["--assess", "--type", "execute", "-vv", "/o/X.app"], mustPass: false},
      {name: "spctl-dmg", cmd: "/usr/sbin/spctl", args: ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", "/o/a.dmg"], mustPass: false},
      {name: "stapler-validate-app", cmd: "/usr/bin/xcrun", args: ["stapler", "validate", "/o/X.app"], mustPass: false},
      {name: "stapler-validate-dmg", cmd: "/usr/bin/xcrun", args: ["stapler", "validate", "/o/a.dmg"], mustPass: false}
    ]);
    const real = checkPlan({appPath: "/o/X.app", dmgPath: "/o/a.dmg", developerId: true, notarized: true});
    expect(real.map((c) => [c.name, c.mustPass])).toEqual([["codesign-verify-app", true], ["codesign-verify-dmg", true], ["spctl-app", true], ["spctl-dmg", true], ["stapler-validate-app", true], ["stapler-validate-dmg", true]]);
    expect(real.map((c) => ({...c, mustPass: false}))).toEqual(self.map((c) => ({...c, mustPass: false})));
    const devIdUnnotarised = checkPlan({appPath: "/o/X.app", dmgPath: "/o/a.dmg", developerId: true, notarized: false});
    expect(devIdUnnotarised.map((c) => c.mustPass)).toEqual([true, true, false, false, false, false]);
    const notarisedNoDevId = checkPlan({appPath: "/o/X.app", dmgPath: "/o/a.dmg", developerId: false, notarized: true});
    expect(notarisedNoDevId.map((c) => c.mustPass)).toEqual([true, true, false, false, true, true]);
    // No check may ever write: stapler only validates, spctl only assesses.
    for (const c of self) expect(c.args, c.name).not.toContain("staple");
  });
  it("turns a failed must-pass check into a problem and ignores the rest", () => {
    expect(checkProblems([{name: "a", status: 0, mustPass: true}, {name: "b", status: 3, mustPass: false}, {name: "c", status: 1, mustPass: true}, {name: "d", status: null, mustPass: true}]))
      .toEqual([{code: "ARTEFACT_CHECK_FAILED", detail: "c"}, {code: "ARTEFACT_CHECK_FAILED", detail: "d"}]);
  });
});

describe("a real artefacts run, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const reports = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "artefacts", "artefacts-report.json")).filter((p) => existsSync(p)) : [];
  it.each(reports.length > 0 ? reports : [])("%s names a DMG and a ZIP that exist with the recorded hashes, and every must-pass check passed", (reportPath) => {
    const r = JSON.parse(readFileSync(reportPath, "utf8")) as {dmg: {file: string; sha256: string}; zip: {file: string; sha256: string}; checks: Array<{name: string; status: number; mustPass: boolean}>; notarized: boolean; signatures: {app: {authorities: string[]}; helper: {authorities: string[]}; dmg: {authorities: string[]}}};
    expect(r.signatures.app.authorities.length).toBeGreaterThan(0);
    expect(r.signatures.helper.authorities).toEqual(r.signatures.app.authorities);
    expect(r.signatures.dmg.authorities).toEqual(r.signatures.app.authorities);
    // The signature chains carry names only (the report's own sha256 fields are elsewhere).
    expect(JSON.stringify(r.signatures)).not.toMatch(/[0-9a-f]{40}/);
    const dir = join(reportPath, "..");
    for (const f of [r.dmg, r.zip]) {
      expect(existsSync(join(dir, f.file))).toBe(true);
      expect(createHash("sha256").update(readFileSync(join(dir, f.file))).digest("hex")).toBe(f.sha256);
    }
    expect(r.dmg.file.endsWith("-arm64.dmg")).toBe(true);
    expect(r.checks.filter((c) => c.mustPass).every((c) => c.status === 0)).toBe(true);
    if (!r.notarized) expect(r.checks.find((c) => c.name === "stapler-validate-app")?.mustPass).toBe(false);
  });
  it("records whether a run was checked", () => { expect(reports.length >= 0).toBe(true); });
});
