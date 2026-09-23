// Tests the pure half of scripts/package/linux/packages.mjs in plain Node: what the .deb and the .rpm
// are made of. The module does nothing at import. Nothing here runs nfpm, dpkg or rpm.
import {spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import * as packagesScript from "./packages.mjs";

type Contents = Array<{src?: string; dst: string; type?: string; packager?: string; file_info?: {mode: number}}>;
type Config = Record<string, unknown> & {contents: Contents; overrides: {deb: {depends: string[]; scripts: Record<string, string>}; rpm: {depends: string[]; scripts?: unknown}}};
type Listed = {path: string; mode: number; owner: string; dir?: boolean; other?: string};
const {NFPM, SONAME_PACKAGES, RUNTIME_LOADED, parseNeeded, dependsFor, installDir, goArch, packageVersion, apparmorProfile, desktopEntry, postinstScript, prermScript, nfpmConfig, nfpmVersionOf,
  pngSize, parseDebListing, parseRpmListing, checkPackageListing, linuxArtefactDecision} = packagesScript as {
  NFPM: {version: string; sha256: Record<string, string>};
  SONAME_PACKAGES: Record<string, {deb: string; rpm: string}>;
  RUNTIME_LOADED: Array<{deb: string; rpm: string; why: string}>;
  parseNeeded: (readelfOutput: string) => string[];
  dependsFor: (a: {needed: string[]; bundled: string[]}) => {deb: string[]; rpm: string[]; unmapped: string[]};
  installDir: (appName: unknown) => string | null;
  goArch: (arch: unknown) => string | null;
  packageVersion: (info: unknown) => {version: string; release: string} | null;
  apparmorProfile: (a: {profileName: string; executablePath: string}) => string;
  desktopEntry: (a: {appName: string; desktopId: string; executablePath: string}) => string;
  postinstScript: (a: {profilePath: string; securityfs?: string; restrictFile?: string}) => string;
  prermScript: (a: {profilePath: string; securityfs?: string}) => string;
  nfpmConfig: (a: Record<string, unknown>) => {config?: Config; error?: string};
  nfpmVersionOf: (output: string) => string | null;
  pngSize: (bytes: Uint8Array) => {width: number; height: number} | null;
  parseDebListing: (text: string) => Listed[];
  parseRpmListing: (text: string) => Listed[];
  checkPackageListing: (a: {listed: Listed[]; kind: string; appName: string; executable: string; desktopId: string; models: string[]}) => Array<{code: string; detail: string}>;
  linuxArtefactDecision: (a: {flavour: string; report: unknown}) => {ok?: boolean; error?: string};
};

describe("where the app goes and what it is called", () => {
  it("installs to /opt/<App name>, and refuses a name that the profile, the desktop entry or a shell could misread", () => {
    expect(installDir("Clave Agent Internal")).toBe("/opt/Clave Agent Internal");
    expect(installDir("Clave Agent")).toBe("/opt/Clave Agent");
    for (const bad of ["", " ", "../etc", "Clave/Agent", "Clave \"Agent\"", "Clave $Agent", "Clave\nAgent", "Clave`x`", " Clave", "Clave ", undefined, 3]) {
      expect(installDir(bad), String(bad)).toBeNull();
    }
  });

  it("maps the Node architectures to Go's, as nfpm names them", () => {
    expect(goArch("x64")).toBe("amd64");
    expect(goArch("arm64")).toBe("arm64");
    for (const bad of ["ia32", "arm", "amd64", undefined]) expect(goArch(bad), String(bad)).toBeNull();
  });

  it("versions the package as the app, with the build number as its release, so each build upgrades the last", () => {
    expect(packageVersion({version: "0.1.3", buildNumber: "20260923.1200"})).toEqual({version: "0.1.3", release: "20260923.1200"});
    for (const bad of [{version: "0.1.3-beta", buildNumber: "20260923.1200"}, {version: "0.1", buildNumber: "20260923.1200"}, {version: "0.1.3", buildNumber: "2026-09-23"},
      {version: "0.1.3", buildNumber: ""}, {version: "0.1.3", buildNumber: "20260923.12000"}, {version: "0.1.3", buildNumber: "120260923.1200"}, {version: "0.1.3"}, null]) {
      expect(packageVersion(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the AppArmor profile (the .deb only)", () => {
  const text = apparmorProfile({profileName: "dev.clave.agent.internal", executablePath: "/opt/Clave Agent Internal/clave-agent-internal"});

  it("grants user namespaces to the app's own executable and confines nothing else, as Ubuntu's profiles for Chrome and VS Code do", () => {
    expect(text).toContain("abi <abi/4.0>,\ninclude <tunables/global>\n");
    expect(text).toContain("profile dev.clave.agent.internal \"/opt/Clave Agent Internal/clave-agent-internal\" flags=(unconfined) {\n  userns,\n");
    expect(text).toContain("  include if exists <local/dev.clave.agent.internal>\n}\n");
  });

  it("grants nothing but userns: no other rule, no second profile, no other binary", () => {
    const rules = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(rules).toEqual(["abi <abi/4.0>,", "include <tunables/global>", "profile dev.clave.agent.internal \"/opt/Clave Agent Internal/clave-agent-internal\" flags=(unconfined) {",
      "userns,", "include if exists <local/dev.clave.agent.internal>", "}"]);
    expect(text).not.toContain("clave-reader");
  });

  it("refuses a path or name it could not quote safely", () => {
    expect(() => apparmorProfile({profileName: "dev.clave.agent", executablePath: "/opt/a\"b/x"})).toThrow("PROFILE_PATH_UNSAFE");
    expect(() => apparmorProfile({profileName: "dev.clave.agent", executablePath: "relative/x"})).toThrow("PROFILE_PATH_UNSAFE");
    expect(() => apparmorProfile({profileName: "dev clave", executablePath: "/opt/x/y"})).toThrow("PROFILE_NAME_UNSAFE");
  });
});

describe("the maintainer scripts (the .deb only)", () => {
  const postinst = postinstScript({profilePath: "/etc/apparmor.d/dev.clave.agent"});
  const prerm = prermScript({profilePath: "/etc/apparmor.d/dev.clave.agent"});

  it("postinst loads the profile on configure, and fails the install only where the app could not start without it", () => {
    expect(postinst.startsWith("#!/bin/sh\n")).toBe(true);
    expect(postinst).toContain("set -e\n");
    expect(postinst).toContain("case \"$1\" in\n  configure|abort-remove|abort-upgrade|abort-deconfigure)\n");
    expect(postinst).toContain("apparmor_parser --replace --write-cache --skip-read-cache '/etc/apparmor.d/dev.clave.agent'");
    expect(postinst).toContain("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
    expect(postinst).toContain("exit 1");
  });

  it("prerm unloads it on removal only: an upgrade keeps it loaded until postinst replaces it", () => {
    expect(prerm).toContain("[ \"$1\" = remove ]");
    expect(prerm).toContain("apparmor_parser --remove '/etc/apparmor.d/dev.clave.agent'");
    expect(prerm).not.toContain("upgrade");
  });

  it("quotes the profile path for the shell and refuses one it cannot", () => {
    expect(() => postinstScript({profilePath: "/etc/apparmor.d/it's"})).toThrow("SCRIPT_PATH_UNSAFE");
    expect(() => prermScript({profilePath: "relative"})).toThrow("SCRIPT_PATH_UNSAFE");
    expect(() => postinstScript({profilePath: "/etc/apparmor.d/x", securityfs: "/sys/$(x)"})).toThrow("SCRIPT_PATH_UNSAFE");
    expect(() => postinstScript({profilePath: "/etc/apparmor.d/x", restrictFile: "rel"})).toThrow("SCRIPT_PATH_UNSAFE");
    expect(() => prermScript({profilePath: "/etc/apparmor.d/x", securityfs: "/a'b"})).toThrow("SCRIPT_PATH_UNSAFE");
    // The real system paths when none are given.
    expect(postinst).toContain("[ -d '/sys/kernel/security/apparmor' ]");
    expect(prerm).toContain("[ -d '/sys/kernel/security/apparmor' ]");
  });
});

// The scripts themselves, run with a POSIX shell (dash where there is one, as Ubuntu runs them) against a
// stub apparmor_parser that logs its arguments and succeeds or fails as told, and stand-in files for
// AppArmor's securityfs folder and the userns restriction switch.
describe("the maintainer scripts, run", () => {
  const shell = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";
  const root = mkdtempSync(join(tmpdir(), "clave-maint-"));
  afterAll(() => rmSync(root, {recursive: true, force: true}));
  let n = 0;
  const run = (script: "postinst" | "prerm", arg: string, world: {parser: "ok" | "fails" | "absent"; securityfs: boolean; restrict: "1" | "0" | "absent"}) => {
    const dir = join(root, String(n += 1));
    mkdirSync(join(dir, "bin"), {recursive: true});
    const log = join(dir, "parser.log");
    if (world.parser !== "absent") {
      writeFileSync(join(dir, "bin", "apparmor_parser"), `#!/bin/sh\necho "$@" >> '${log}'\n${world.parser === "ok" ? "exit 0" : "exit 1"}\n`);
      chmodSync(join(dir, "bin", "apparmor_parser"), 0o755);
    }
    const securityfs = join(dir, "securityfs");
    if (world.securityfs) mkdirSync(securityfs);
    const restrictFile = join(dir, "restrict");
    if (world.restrict !== "absent") writeFileSync(restrictFile, `${world.restrict}\n`);
    const paths = {profilePath: "/etc/apparmor.d/dev.clave.agent", securityfs};
    const text = script === "postinst" ? postinstScript({...paths, restrictFile}) : prermScript(paths);
    writeFileSync(join(dir, script), text);
    const r = spawnSync(shell, [join(dir, script), arg], {env: {PATH: `${join(dir, "bin")}:/usr/bin:/bin`}, encoding: "utf8"});
    return {status: r.status, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], stderr: r.stderr};
  };
  const LOAD = "--replace --write-cache --skip-read-cache /etc/apparmor.d/dev.clave.agent";

  it("postinst on Ubuntu 24.04: loads the profile and succeeds", () => {
    expect(run("postinst", "configure", {parser: "ok", securityfs: true, restrict: "1"})).toEqual({status: 0, calls: [LOAD], stderr: ""});
  });

  it("postinst fails the install where userns is restricted and the profile did not load, and says why", () => {
    const r = run("postinst", "configure", {parser: "fails", securityfs: true, restrict: "1"});
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([LOAD]);
    expect(r.stderr).toContain("could not be loaded");
    expect(r.stderr).toContain("user namespaces");
    expect(run("postinst", "configure", {parser: "absent", securityfs: false, restrict: "1"}).status).toBe(1);
  });

  it("postinst only reports a failed load where nothing is restricted, and does nothing without AppArmor", () => {
    const r = run("postinst", "configure", {parser: "fails", securityfs: true, restrict: "0"});
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not be loaded");
    expect(run("postinst", "configure", {parser: "fails", securityfs: true, restrict: "absent"}).status).toBe(0);
    expect(run("postinst", "configure", {parser: "ok", securityfs: false, restrict: "0"})).toEqual({status: 0, calls: [], stderr: ""});
    expect(run("postinst", "configure", {parser: "absent", securityfs: true, restrict: "absent"})).toEqual({status: 0, calls: [], stderr: ""});
  });

  it("postinst loads the profile again when dpkg rolls back a failed removal or upgrade", () => {
    for (const arg of ["abort-remove", "abort-upgrade", "abort-deconfigure"]) {
      expect(run("postinst", arg, {parser: "ok", securityfs: true, restrict: "1"}), arg).toEqual({status: 0, calls: [LOAD], stderr: ""});
    }
    expect(run("postinst", "triggered", {parser: "ok", securityfs: true, restrict: "1"})).toEqual({status: 0, calls: [], stderr: ""});
  });

  it("prerm unloads on remove only, and a failed unload never blocks the removal", () => {
    expect(run("prerm", "remove", {parser: "ok", securityfs: true, restrict: "1"})).toEqual({status: 0, calls: ["--remove /etc/apparmor.d/dev.clave.agent"], stderr: ""});
    expect(run("prerm", "remove", {parser: "fails", securityfs: true, restrict: "1"}).status).toBe(0);
    for (const arg of ["upgrade", "deconfigure", "failed-upgrade"]) expect(run("prerm", arg, {parser: "ok", securityfs: true, restrict: "1"}), arg).toEqual({status: 0, calls: [], stderr: ""});
    expect(run("prerm", "remove", {parser: "ok", securityfs: false, restrict: "1"})).toEqual({status: 0, calls: [], stderr: ""});
    expect(run("prerm", "remove", {parser: "absent", securityfs: true, restrict: "1"})).toEqual({status: 0, calls: [], stderr: ""});
  });
});

describe("the desktop entry", () => {
  const text = desktopEntry({appName: "Clave Agent Internal", desktopId: "dev.clave.agent.internal", executablePath: "/opt/Clave Agent Internal/clave-agent-internal"});

  it("names the app as GNOME shows it and the reader excludes it, and ties its windows to the entry", () => {
    expect(text.split("\n")).toEqual([
      "[Desktop Entry]", "Type=Application", "Version=1.5", "Name=Clave Agent Internal",
      "Exec=\"/opt/Clave Agent Internal/clave-agent-internal\"", "Icon=dev.clave.agent.internal", "Terminal=false", "Categories=Office;",
      "StartupWMClass=dev.clave.agent.internal", ""
    ]);
  });

  it("never passes --no-sandbox or any other switch", () => {
    expect(text).not.toContain("--");
  });

  it("refuses a name or path it could not write unescaped", () => {
    expect(() => desktopEntry({appName: "A\nExec=evil", desktopId: "dev.clave.agent", executablePath: "/opt/x/y"})).toThrow("DESKTOP_VALUE_UNSAFE");
    expect(() => desktopEntry({appName: "A", desktopId: "dev.clave.agent", executablePath: "/opt/$x/y"})).toThrow("DESKTOP_VALUE_UNSAFE");
    expect(() => desktopEntry({appName: "A", desktopId: "dev clave", executablePath: "/opt/x/y"})).toThrow("DESKTOP_VALUE_UNSAFE");
  });
});

describe("nfpmConfig: one description, two packages", () => {
  const ARGS = {flavour: "internal", appName: "Clave Agent Internal", executable: "clave-agent-internal", arch: "arm64", version: "0.1.3", buildNumber: "20260923.1200",
    appDir: "/out/internal/bundle/Clave Agent Internal-linux-arm64", desktopFile: "/p/entry.desktop", iconFile: "/p/icon.png", profileFile: "/p/profile",
    postinstFile: "/p/postinst", prermFile: "/p/prerm", maintainer: "Clave", depends: {deb: ["libc6", "libtesseract5"], rpm: ["glibc", "tesseract-libs"]}};
  const config = nfpmConfig(ARGS).config as Config;

  it("names, versions and describes the package", () => {
    expect(config).toMatchObject({name: "clave-agent-internal", arch: "arm64", platform: "linux", version: "0.1.3", version_schema: "none", release: "20260923.1200",
      maintainer: "Clave", vendor: "Clave", license: "Proprietary", section: "utils", priority: "optional", description: "Clave Agent Internal"});
    // A build machine whose umask leaves files group-writable (Ubuntu's 0002) must not ship them so.
    expect(config.umask).toBe(0o022);
    expect(nfpmConfig({...ARGS, arch: "x64"}).config?.arch).toBe("amd64");
  });

  it("installs the app folder whole under /opt, the entry and icon where the desktop finds them, the profile for the .deb alone", () => {
    expect(config.contents).toEqual([
      {src: "/out/internal/bundle/Clave Agent Internal-linux-arm64/", dst: "/opt/Clave Agent Internal", type: "tree"},
      {src: "/p/entry.desktop", dst: "/usr/share/applications/dev.clave.agent.internal.desktop", file_info: {mode: 0o644}},
      {src: "/p/icon.png", dst: "/usr/share/icons/hicolor/256x256/apps/dev.clave.agent.internal.png", file_info: {mode: 0o644}},
      {src: "/p/profile", dst: "/etc/apparmor.d/dev.clave.agent.internal", file_info: {mode: 0o644}, packager: "deb"}
    ]);
  });

  it("depends on exactly what it is given, per format", () => {
    expect(config.overrides.deb.depends).toEqual(["libc6", "libtesseract5"]);
    expect(config.overrides.rpm.depends).toEqual(["glibc", "tesseract-libs"]);
    expect(config).not.toHaveProperty("depends");
    expect(nfpmConfig({...ARGS, depends: {deb: [], rpm: ["glibc"]}})).toEqual({error: "DEPENDS_MISSING"});
    expect(nfpmConfig({...ARGS, depends: undefined})).toEqual({error: "DEPENDS_MISSING"});
  });

  it("runs the AppArmor scripts from the .deb only; the .rpm has no scripts at all", () => {
    expect(config.overrides.deb.scripts).toEqual({postinstall: "/p/postinst", preremove: "/p/prerm"});
    expect(config.overrides.rpm.scripts).toBeUndefined();
    expect(config).not.toHaveProperty("scripts");
  });

  it("refuses what cannot be packaged", () => {
    expect(nfpmConfig({...ARGS, flavour: "dev"})).toEqual({error: "DEV_FLAVOUR_NOT_PACKAGED"});
    expect(nfpmConfig({...ARGS, arch: "ia32"})).toEqual({error: "UNSUPPORTED_ARCH"});
    expect(nfpmConfig({...ARGS, appName: "Clave/Agent"})).toEqual({error: "APP_NAME_UNSAFE"});
    expect(nfpmConfig({...ARGS, version: "0.1.3-rc1"})).toEqual({error: "VERSION_NOT_PACKAGEABLE"});
    expect(nfpmConfig({...ARGS, executable: "clave agent"})).toEqual({error: "EXECUTABLE_NAME_UNSAFE"});
    expect(nfpmConfig({...ARGS, maintainer: ""})).toEqual({error: "MAINTAINER_MISSING"});
    expect(nfpmConfig({...ARGS, maintainer: "   "})).toEqual({error: "MAINTAINER_MISSING"});
    expect(nfpmConfig({...ARGS, flavour: "toString"})).toEqual({error: "DEV_FLAVOUR_NOT_PACKAGED"});
    // arm64 is the internal build for the VM only (decision 3): never a release package.
    expect(nfpmConfig({...ARGS, flavour: "release", appName: "Clave Agent", executable: "clave-agent"})).toEqual({error: "ARM64_IS_INTERNAL_ONLY"});
    expect(nfpmConfig({...ARGS, flavour: "release", appName: "Clave Agent", executable: "clave-agent", arch: "x64"}).config?.name).toBe("clave-agent");
  });
});

describe("Depends: from what the binaries link, never from a remembered list", () => {
  // readelf -d of the arm64 bundle, 2026-09-23 (the app, the reader, libffmpeg, crashpad, the model addon).
  const NEEDED_ARM64 = ["ld-linux-aarch64.so.1", "libX11.so.6", "libXcomposite.so.1", "libXdamage.so.1", "libXext.so.6", "libXfixes.so.3", "libXrandr.so.2",
    "libasound.so.2", "libatk-1.0.so.0", "libatk-bridge-2.0.so.0", "libatspi.so.0", "libc.so.6", "libcairo.so.2", "libcups.so.2", "libdbus-1.so.3", "libdl.so.2",
    "libexpat.so.1", "libffmpeg.so", "libgbm.so.1", "libgcc_s.so.1", "libgio-2.0.so.0", "libglib-2.0.so.0", "libgobject-2.0.so.0", "libgtk-3.so.0", "liblept.so.5",
    "libm.so.6", "libnspr4.so", "libnss3.so", "libnssutil3.so", "libpango-1.0.so.0", "libpipewire-0.3.so.0", "libpthread.so.0", "libsmime3.so", "libtesseract.so.5",
    "libudev.so.1", "libxcb.so.1", "libxkbcommon.so.0", "libggml-base.so", "libggml.v0.4.0.so", "libllama-common.so", "libllama.v0.4.0.so", "libstdc++.so.6"];
  const BUNDLED = ["libffmpeg.so", "libvk_swiftshader.so", "libvulkan.so.1", "libggml-base.so", "libggml.v0.4.0.so", "libllama-common.so", "libllama.v0.4.0.so"];

  it("reads the NEEDED entries of a readelf -d report", () => {
    const text = [
      "Dynamic section at offset 0x1 contains 3 entries:",
      "  Tag        Type                         Name/Value",
      " 0x0000000000000001 (NEEDED)             Shared library: [libtesseract.so.5]",
      " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
      " 0x000000000000000e (SONAME)             Library soname: [libx.so]", ""
    ].join("\n");
    expect(parseNeeded(text)).toEqual(["libtesseract.so.5", "libc.so.6"]);
    expect(parseNeeded("")).toEqual([]);
  });

  it("maps the arm64 bundle's libraries to Ubuntu's and Fedora's packages, with the reader's two under the plan's names", () => {
    const r = dependsFor({needed: NEEDED_ARM64, bundled: BUNDLED});
    expect(r.unmapped).toEqual([]);
    expect(r.deb).toEqual(expect.arrayContaining(["libtesseract5", "libpipewire-0.3-0t64", "liblept5", "libgtk-3-0", "libnss3", "libcups2", "libc6"]));
    expect(r.rpm).toEqual(expect.arrayContaining(["tesseract-libs", "pipewire-libs", "leptonica", "gtk3", "nss", "nss-util", "cups-libs", "glibc"]));
    // Loaded at run time, not linked: the keyring (safeStorage through libsecret), notifications, opening files.
    expect(r.deb).toEqual(expect.arrayContaining(["libsecret-1-0", "libnotify4", "xdg-utils"]));
    expect(r.rpm).toEqual(expect.arrayContaining(["libsecret", "libnotify", "xdg-utils"]));
    // Never what nothing links: the old Electron list's libXss, libXtst and libuuid.
    for (const stale of ["libxss1", "libxtst6", "libuuid1"]) expect(r.deb).not.toContain(stale);
    expect(r.deb).toEqual([...new Set(r.deb)].sort());
    expect(r.rpm).toEqual([...new Set(r.rpm)].sort());
    for (const dep of [...r.deb, ...r.rpm]) expect(dep, dep).toMatch(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/);
  });

  it("names a library it cannot map instead of leaving it out, and ignores the ones the app ships", () => {
    expect(dependsFor({needed: ["libc.so.6", "libweird.so.3"], bundled: []}).unmapped).toEqual(["libweird.so.3"]);
    expect(dependsFor({needed: ["libffmpeg.so"], bundled: ["libffmpeg.so"]}).unmapped).toEqual([]);
    expect(dependsFor({needed: ["libffmpeg.so"], bundled: []}).unmapped).toEqual(["libffmpeg.so"]);
  });

  it("Tesseract is depended on though the reader no longer links it: it loads it at run time", () => {
    const withoutTesseract = NEEDED_ARM64.filter((so) => so !== "libtesseract.so.5" && so !== "liblept.so.5");
    const r = dependsFor({needed: withoutTesseract, bundled: BUNDLED});
    expect(r.deb).toEqual(expect.arrayContaining(["libtesseract5"]));
    expect(r.rpm).toEqual(expect.arrayContaining(["tesseract-libs"]));
    expect(r.unmapped).toEqual([]);
  });

  it("the runtime-loaded four each say why", () => {
    expect(RUNTIME_LOADED.map((r) => r.deb)).toEqual(["libtesseract5", "libsecret-1-0", "libnotify4", "xdg-utils"]);
    for (const r of RUNTIME_LOADED) expect(r.why.length, r.deb).toBeGreaterThan(10);
    for (const [soname, p] of Object.entries(SONAME_PACKAGES)) expect(p.deb && p.rpm, soname).toBeTruthy();
  });
});

describe("the tool, the icon and what was built", () => {
  it("pins nfpm's version and the checksums of both Linux archives", () => {
    expect(NFPM.version).toBe("2.47.0");
    expect(NFPM.sha256).toEqual({
      x64: "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783",
      arm64: "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c"
    });
  });

  it("reads nfpm's version from its --version report", () => {
    expect(nfpmVersionOf("nfpm: a simple packager\n\nGitVersion:    2.47.0\nGitCommit:     abc\n")).toBe("2.47.0");
    expect(nfpmVersionOf("GitVersion:    v2.47.0\n")).toBe("2.47.0");
    expect(nfpmVersionOf("nfpm version 2.47.0")).toBeNull();
    expect(nfpmVersionOf("GitVersion:    2.47.0-rc1\n")).toBeNull();
    expect(nfpmVersionOf("GitVersion:    2.47.0.1\n")).toBeNull();
    expect(nfpmVersionOf("")).toBeNull();
  });

  it("reads a PNG's size from its header, and nothing else", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 128]);
    expect(pngSize(png)).toEqual({width: 256, height: 128});
    const notPng = png.slice();
    notPng[1] = 0;
    expect(pngSize(notPng)).toBeNull();
    expect(pngSize(png.slice(0, 20))).toBeNull();
    const notIhdr = png.slice();
    notIhdr[12] = 0x69;
    expect(pngSize(notIhdr)).toBeNull();
  });

  it("builds packages only from a fused, unsigned Linux bundle", () => {
    expect(linuxArtefactDecision({flavour: "release", report: {platform: "linux", fused: true, signed: false}})).toEqual({ok: true});
    expect(linuxArtefactDecision({flavour: "internal", report: {platform: "linux", fused: false, signed: false}})).toEqual({error: "ARTEFACT_NEEDS_FUSED"});
    expect(linuxArtefactDecision({flavour: "internal", report: {platform: "win32", fused: true}})).toEqual({error: "BUNDLE_NOT_LINUX"});
    expect(linuxArtefactDecision({flavour: "internal", report: null})).toEqual({error: "BUNDLE_NOT_LINUX"});
    expect(linuxArtefactDecision({flavour: "dev", report: {platform: "linux", fused: true, signed: false}})).toEqual({error: "BAD_FLAVOUR"});
  });
});

describe("reading and checking a built package's file list", () => {
  const DEB = [
    "drwxr-xr-x 0/0               0 2026-09-23 12:00 ./",
    "drwxr-xr-x root/root         0 2026-09-23 12:00 ./opt/Clave Agent Internal/",
    "-rwxr-xr-x root/root  190000000 2026-09-23 12:00 ./opt/Clave Agent Internal/clave-agent-internal",
    "-rwxr-xr-x root/root    5000000 2026-09-23 12:00 ./opt/Clave Agent Internal/clave-reader",
    "-rwxr-xr-x root/root      50000 2026-09-23 12:00 ./opt/Clave Agent Internal/chrome-sandbox",
    "-rw-r--r-- root/root   15400601 2026-09-23 12:00 ./opt/Clave Agent Internal/tessdata/eng.traineddata",
    "-rw-r--r-- root/root    8159939 2026-09-23 12:00 ./opt/Clave Agent Internal/tessdata/por.traineddata",
    "-rw-r--r-- root/root   20000000 2026-09-23 12:00 ./opt/Clave Agent Internal/resources/app.asar",
    "lrwxrwxrwx root/root          0 2026-09-23 12:00 ./opt/Clave Agent Internal/libx.so -> libx.so.1",
    "-rw-r--r-- root/root        200 2026-09-23 12:00 ./usr/share/applications/dev.clave.agent.internal.desktop",
    "-rw-r--r-- root/root      30000 2026-09-23 12:00 ./usr/share/icons/hicolor/256x256/apps/dev.clave.agent.internal.png",
    "drwxr-xr-x root/root          0 2026-09-23 12:00 ./etc/apparmor.d/",
    "-rw-r--r-- root/root        300 2026-09-23 12:00 ./etc/apparmor.d/dev.clave.agent.internal",
    ""
  ].join("\n");
  const RPM = [
    "drwxr-xr-x    2 root     root                        0 Sep 23 12:00 /opt/Clave Agent Internal",
    "-rwxr-xr-x    1 root     root                190000000 Sep 23 12:00 /opt/Clave Agent Internal/clave-agent-internal",
    "-rwxr-xr-x    1 root     root                  5000000 Sep 23 12:00 /opt/Clave Agent Internal/clave-reader",
    "-rw-r--r--    1 root     root                 15400601 Sep 23 12:00 /opt/Clave Agent Internal/tessdata/eng.traineddata",
    "-rw-r--r--    1 root     root                  8159939 Sep 23 12:00 /opt/Clave Agent Internal/tessdata/por.traineddata",
    "-rw-r--r--    1 root     root                 20000000 Sep 23 12:00 /opt/Clave Agent Internal/resources/app.asar",
    "-rw-r--r--    1 root     root                      200 Sep 23 12:00 /usr/share/applications/dev.clave.agent.internal.desktop",
    "-rw-r--r--    1 root     root                    30000 Sep 23 12:00 /usr/share/icons/hicolor/256x256/apps/dev.clave.agent.internal.png",
    ""
  ].join("\n");
  const base = {appName: "Clave Agent Internal", executable: "clave-agent-internal", desktopId: "dev.clave.agent.internal", models: ["eng.traineddata", "por.traineddata"]};

  it("parses dpkg-deb -c and rpm -qlv lines, spaces in paths included, folders and links kept as what they are", () => {
    const deb = parseDebListing(DEB);
    expect(deb.map((e) => e.path)).toContain("/opt/Clave Agent Internal/clave-reader");
    expect(deb.find((e) => e.path.endsWith("/clave-reader"))).toEqual({path: "/opt/Clave Agent Internal/clave-reader", mode: 0o755, owner: "root/root"});
    // A link is listed as what it is, so the check can refuse it; the app folder never has one.
    expect(deb.find((e) => e.path.endsWith("libx.so"))).toEqual({path: "/opt/Clave Agent Internal/libx.so", mode: 0o777, owner: "root/root", other: "l"});
    expect(parseDebListing("hrwxr-xr-x root/root 0 2026-09-23 12:00 ./usr/bin/clave link to ./opt/x\n")).toEqual([{path: "/usr/bin/clave link to ./opt/x", mode: 0o755, owner: "root/root", other: "h"}]);
    expect(parseRpmListing("lrwxrwxrwx    1 root     root   9 Sep 23 12:00 /usr/bin/clave -> /opt/x\n")).toEqual([{path: "/usr/bin/clave", mode: 0o777, owner: "root/root", other: "l"}]);
    // Special bits are read from their letters: s and S (setuid, setgid), t and T (sticky).
    const modes = parseDebListing(["-rwsr-xr-x root/root 1 2026-09-23 12:00 ./a", "-rwxr-sr-x root/root 1 2026-09-23 12:00 ./b", "-rwSr--r-- root/root 1 2026-09-23 12:00 ./c",
      "drwxrwxrwt root/root 0 2026-09-23 12:00 ./d/", "-rw-r--r-T root/root 1 2026-09-23 12:00 ./e"].join("\n")).map((e) => e.mode);
    expect(modes).toEqual([0o4755, 0o2755, 0o4644, 0o1777, 0o1644]);
    expect(deb.find((e) => e.path === "/opt/Clave Agent Internal")).toEqual({path: "/opt/Clave Agent Internal", mode: 0o755, owner: "root/root", dir: true});
    expect(parseRpmListing("drwx------    2 root     root   0 Sep 23 12:00 /opt/Clave Agent Internal\n")).toEqual([{path: "/opt/Clave Agent Internal", mode: 0o700, owner: "root/root", dir: true}]);
    const rpm = parseRpmListing(RPM);
    expect(rpm.find((e) => e.path.endsWith("eng.traineddata"))).toEqual({path: "/opt/Clave Agent Internal/tessdata/eng.traineddata", mode: 0o644, owner: "root/root"});
    expect(rpm.filter((e) => !e.dir)).toHaveLength(7);
  });

  it("passes both packages as built", () => {
    expect(checkPackageListing({...base, kind: "deb", listed: parseDebListing(DEB).filter((e) => e.other === undefined)})).toEqual([]);
    expect(checkPackageListing({...base, kind: "rpm", listed: parseRpmListing(RPM)})).toEqual([]);
  });

  it("names each defect", () => {
    const deb = parseDebListing(DEB);
    expect(checkPackageListing({...base, kind: "deb", listed: deb}).map((p) => p.code)).toEqual(["PACKAGE_LINK"]);
    const codes = (kind: string, listed: Listed[]) => checkPackageListing({...base, kind, listed}).map((p) => `${p.code} ${p.detail}`);
    expect(codes("deb", deb.filter((e) => !e.path.endsWith("/clave-reader")))).toContain("PACKAGE_FILE_MISSING /opt/Clave Agent Internal/clave-reader");
    expect(codes("deb", deb.filter((e) => !e.path.endsWith("/clave-agent-internal")))).toContain("PACKAGE_FILE_MISSING /opt/Clave Agent Internal/clave-agent-internal");
    expect(codes("deb", deb.filter((e) => !e.path.endsWith("/app.asar")))).toContain("PACKAGE_FILE_MISSING /opt/Clave Agent Internal/resources/app.asar");
    expect(codes("deb", deb.filter((e) => !e.path.endsWith(".png")))).toContain("PACKAGE_FILE_MISSING /usr/share/icons/hicolor/256x256/apps/dev.clave.agent.internal.png");
    // A sibling folder whose name starts with the app's is not the app's folder.
    expect(codes("deb", [...deb, {path: "/opt/Clave Agent Internal2/x", mode: 0o644, owner: "root/root"}])).toContain("PACKAGE_FILE_UNEXPECTED /opt/Clave Agent Internal2/x");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("app.asar") ? {...e, mode: 0o2644} : e)))).toContain("PACKAGE_SETUID /opt/Clave Agent Internal/resources/app.asar");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("app.asar") ? {...e, mode: 0o664} : e)))).toContain("PACKAGE_WRITABLE /opt/Clave Agent Internal/resources/app.asar");
    // Programs run by every user: executable for owner, group and others alike.
    expect(codes("deb", deb.map((e) => (e.path.endsWith("/clave-agent-internal") ? {...e, mode: 0o655} : e)))).toContain("PACKAGE_NOT_EXECUTABLE /opt/Clave Agent Internal/clave-agent-internal");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("/clave-agent-internal") ? {...e, mode: 0o754} : e)))).toContain("PACKAGE_NOT_EXECUTABLE /opt/Clave Agent Internal/clave-agent-internal");
    // Links, hard links and special files have no place in the package.
    expect(codes("deb", deb)).toContain("PACKAGE_LINK /opt/Clave Agent Internal/libx.so");
    expect(codes("deb", [...deb, {path: "/dev/x", mode: 0o644, owner: "root/root", other: "c"}])).toContain("PACKAGE_LINK /dev/x");
    expect(codes("deb", deb.filter((e) => !e.path.endsWith("por.traineddata")))).toContain("PACKAGE_FILE_MISSING /opt/Clave Agent Internal/tessdata/por.traineddata");
    expect(codes("deb", deb.filter((e) => !e.path.startsWith("/etc/apparmor.d/")))).toContain("PACKAGE_FILE_MISSING /etc/apparmor.d/dev.clave.agent.internal");
    expect(codes("deb", deb.filter((e) => !e.path.endsWith(".desktop")))).toContain("PACKAGE_FILE_MISSING /usr/share/applications/dev.clave.agent.internal.desktop");
    expect(codes("rpm", [...parseRpmListing(RPM), {path: "/etc/apparmor.d/dev.clave.agent.internal", mode: 0o644, owner: "root/root"}])).toContain("PACKAGE_FILE_UNEXPECTED /etc/apparmor.d/dev.clave.agent.internal");
    expect(codes("deb", [...deb, {path: "/usr/bin/clave", mode: 0o755, owner: "root/root"}])).toContain("PACKAGE_FILE_UNEXPECTED /usr/bin/clave");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("chrome-sandbox") ? {...e, mode: 0o4755} : e)))).toContain("PACKAGE_SETUID /opt/Clave Agent Internal/chrome-sandbox");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("/clave-reader") ? {...e, mode: 0o644} : e)))).toContain("PACKAGE_NOT_EXECUTABLE /opt/Clave Agent Internal/clave-reader");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("app.asar") ? {...e, owner: "admin/admin"} : e)))).toContain("PACKAGE_OWNER /opt/Clave Agent Internal/resources/app.asar");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("app.asar") ? {...e, mode: 0o666} : e)))).toContain("PACKAGE_WRITABLE /opt/Clave Agent Internal/resources/app.asar");
    expect(codes("deb", [])).toContain("PACKAGE_EMPTY deb");
    // Every user must be able to read and enter what root installed.
    expect(codes("deb", deb.map((e) => (e.path === "/opt/Clave Agent Internal" ? {...e, mode: 0o700} : e)))).toContain("PACKAGE_NOT_READABLE /opt/Clave Agent Internal");
    expect(codes("deb", deb.map((e) => (e.path === "/opt/Clave Agent Internal" ? {...e, mode: 0o754} : e)))).toContain("PACKAGE_NOT_READABLE /opt/Clave Agent Internal");
    // Every folder the package owns, inside the app folder or not (/etc/apparmor.d, /usr/share/...).
    const dirAt = (path: string, change: Partial<Listed>) => deb.map((e) => (e.path === path ? {...e, ...change} : e));
    expect(codes("deb", dirAt("/opt/Clave Agent Internal", {mode: 0o775}))).toContain("PACKAGE_WRITABLE /opt/Clave Agent Internal");
    expect(codes("deb", dirAt("/opt/Clave Agent Internal", {owner: "admin/admin"}))).toContain("PACKAGE_OWNER /opt/Clave Agent Internal");
    expect(codes("deb", dirAt("/etc/apparmor.d", {mode: 0o777}))).toContain("PACKAGE_WRITABLE /etc/apparmor.d");
    expect(codes("deb", dirAt("/etc/apparmor.d", {mode: 0o2755}))).toContain("PACKAGE_SETUID /etc/apparmor.d");
    expect(codes("deb", dirAt("/etc/apparmor.d", {owner: "a/b"}))).toContain("PACKAGE_OWNER /etc/apparmor.d");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("app.asar") ? {...e, mode: 0o640} : e)))).toContain("PACKAGE_NOT_READABLE /opt/Clave Agent Internal/resources/app.asar");
    expect(codes("deb", deb.map((e) => (e.path.endsWith("/clave-reader") ? {...e, mode: 0o754} : e)))).toContain("PACKAGE_NOT_READABLE /opt/Clave Agent Internal/clave-reader");
    // The app folder itself must be in the package, so its mode is known.
    expect(codes("deb", deb.filter((e) => e.path !== "/opt/Clave Agent Internal"))).toContain("PACKAGE_FILE_MISSING /opt/Clave Agent Internal");
  });
});
