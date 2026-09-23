// The Linux packages (Linux plan, Task 9): a .deb for Ubuntu and an .rpm for Fedora, made by nfpm from
// one description over the fused app folder of scripts/package/bundle.mjs. Both install the folder to
// /opt/<App name>/ (the helper, and the models in `tessdata/` beside it, included), a desktop entry
// and an icon. The .deb also installs an AppArmor profile that lets the app's own executable create
// user namespaces, which Ubuntu 24.04 refuses to programs without one
// (`kernel.apparmor_restrict_unprivileged_userns`), so Electron's sandbox stays on; Fedora has no such
// restriction and the .rpm carries no profile and no scripts.
//
// Why nfpm (ledger, Task 9): one description makes both formats, a file can go anywhere (the profile in
// /etc/apparmor.d) and per format (depends, the .deb's scripts), and it is one static binary with no
// dpkg, fakeroot or rpmbuild behind it. electron-installer-debian/-redhat wrap dpkg-deb and rpmbuild, add
// a dependency tree to the app's devDependencies, and have no way to place the profile but a script.
//
// Pure decisions only; scripts/package/artefacts.mjs runs them. Nothing runs at import.
import {BUNDLE_IDS} from "../stage.mjs";

/**
 * The nfpm the packages are made with, and the SHA-256 of its two Linux archives as published in the
 * release's checksums.txt (https://github.com/goreleaser/nfpm/releases/tag/v2.47.0, checked
 * 2026-09-23). Whoever installs nfpm (the VM by hand, CI in Task 10) checks the archive against these;
 * the build itself refuses any other version it finds.
 */
export const NFPM = {
  version: "2.47.0",
  sha256: {
    x64: "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783",
    arm64: "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c"
  }
};

/**
 * The system libraries the app's binaries link, by soname, with the package that ships each on Ubuntu
 * 24.04 and on Fedora. Depends is computed from the built binaries' NEEDED entries through this table
 * (`dependsFor`), so it lists what is really linked and nothing else; a soname missing here refuses the
 * build. Ubuntu names are the pre-t64 ones, which the t64 packages Provide (checked in the VM
 * 2026-09-23), except PipeWire's, named as the plan names it.
 */
export const SONAME_PACKAGES = {
  "ld-linux-aarch64.so.1": {deb: "libc6", rpm: "glibc"}, "ld-linux-x86-64.so.2": {deb: "libc6", rpm: "glibc"},
  "libc.so.6": {deb: "libc6", rpm: "glibc"}, "libm.so.6": {deb: "libc6", rpm: "glibc"}, "libdl.so.2": {deb: "libc6", rpm: "glibc"},
  "libpthread.so.0": {deb: "libc6", rpm: "glibc"}, "librt.so.1": {deb: "libc6", rpm: "glibc"},
  "libgcc_s.so.1": {deb: "libgcc-s1", rpm: "libgcc"}, "libstdc++.so.6": {deb: "libstdc++6", rpm: "libstdc++"},
  "libX11.so.6": {deb: "libx11-6", rpm: "libX11"}, "libXcomposite.so.1": {deb: "libxcomposite1", rpm: "libXcomposite"},
  "libXdamage.so.1": {deb: "libxdamage1", rpm: "libXdamage"}, "libXext.so.6": {deb: "libxext6", rpm: "libXext"},
  "libXfixes.so.3": {deb: "libxfixes3", rpm: "libXfixes"}, "libXrandr.so.2": {deb: "libxrandr2", rpm: "libXrandr"},
  "libxcb.so.1": {deb: "libxcb1", rpm: "libxcb"}, "libxkbcommon.so.0": {deb: "libxkbcommon0", rpm: "libxkbcommon"},
  "libasound.so.2": {deb: "libasound2", rpm: "alsa-lib"},
  "libatk-1.0.so.0": {deb: "libatk1.0-0", rpm: "atk"}, "libatk-bridge-2.0.so.0": {deb: "libatk-bridge2.0-0", rpm: "at-spi2-atk"},
  "libatspi.so.0": {deb: "libatspi2.0-0", rpm: "at-spi2-core"},
  "libcairo.so.2": {deb: "libcairo2", rpm: "cairo"}, "libpango-1.0.so.0": {deb: "libpango-1.0-0", rpm: "pango"},
  "libgdk_pixbuf-2.0.so.0": {deb: "libgdk-pixbuf-2.0-0", rpm: "gdk-pixbuf2"},
  "libgtk-3.so.0": {deb: "libgtk-3-0", rpm: "gtk3"}, "libgdk-3.so.0": {deb: "libgtk-3-0", rpm: "gtk3"},
  "libglib-2.0.so.0": {deb: "libglib2.0-0", rpm: "glib2"}, "libgio-2.0.so.0": {deb: "libglib2.0-0", rpm: "glib2"},
  "libgobject-2.0.so.0": {deb: "libglib2.0-0", rpm: "glib2"}, "libgmodule-2.0.so.0": {deb: "libglib2.0-0", rpm: "glib2"},
  "libcups.so.2": {deb: "libcups2", rpm: "cups-libs"}, "libdbus-1.so.3": {deb: "libdbus-1-3", rpm: "dbus-libs"},
  "libexpat.so.1": {deb: "libexpat1", rpm: "expat"}, "libgbm.so.1": {deb: "libgbm1", rpm: "mesa-libgbm"},
  "libdrm.so.2": {deb: "libdrm2", rpm: "libdrm"}, "libudev.so.1": {deb: "libudev1", rpm: "systemd-libs"},
  "libnspr4.so": {deb: "libnspr4", rpm: "nspr"}, "libplc4.so": {deb: "libnspr4", rpm: "nspr"}, "libplds4.so": {deb: "libnspr4", rpm: "nspr"},
  "libnss3.so": {deb: "libnss3", rpm: "nss"}, "libsmime3.so": {deb: "libnss3", rpm: "nss"}, "libnssutil3.so": {deb: "libnss3", rpm: "nss-util"},
  "libtesseract.so.5": {deb: "libtesseract5", rpm: "tesseract-libs"}, "liblept.so.5": {deb: "liblept5", rpm: "leptonica"},
  "libpipewire-0.3.so.0": {deb: "libpipewire-0.3-0t64", rpm: "pipewire-libs"}
};

/** What the app loads at run time rather than links, and so no NEEDED entry shows. */
export const RUNTIME_LOADED = [
  {deb: "libtesseract5", rpm: "tesseract-libs", why: "the reader loads Tesseract (and through it Leptonica) at run time under each distribution's file name"},
  {deb: "libsecret-1-0", rpm: "libsecret", why: "Electron's safeStorage reaches the desktop keyring through libsecret, loaded at run time"},
  {deb: "libnotify4", rpm: "libnotify", why: "Electron shows notifications through libnotify, loaded at run time"},
  {deb: "xdg-utils", rpm: "xdg-utils", why: "opening the licence file and the What-leaves page runs xdg-open"}
];

/** The sonames in a `readelf -d` report's NEEDED lines. */
export function parseNeeded(text) {
  return [...String(text ?? "").matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
}

/**
 * Depends for both formats from the sonames the binaries need, minus the libraries the app folder
 * ships itself (`bundled`, file names), plus `RUNTIME_LOADED`; sorted, each once. `unmapped` names every
 * soname neither shipped nor in the table: the build refuses those rather than guess a package.
 */
export function dependsFor({needed, bundled}) {
  const deb = new Set(RUNTIME_LOADED.map((r) => r.deb));
  const rpm = new Set(RUNTIME_LOADED.map((r) => r.rpm));
  const unmapped = new Set();
  for (const soname of needed) {
    if (bundled.includes(soname)) continue;
    const p = Object.hasOwn(SONAME_PACKAGES, soname) ? SONAME_PACKAGES[soname] : null;
    if (p === null) { unmapped.add(soname); continue; }
    deb.add(p.deb);
    rpm.add(p.rpm);
  }
  return {deb: [...deb].sort(), rpm: [...rpm].sort(), unmapped: [...unmapped].sort()};
}

/** Characters every generated file can carry unquoted or inside plain double or single quotes. */
const SAFE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 .-]*[A-Za-z0-9])?$/;
const SAFE_PATH = /^\/[A-Za-z0-9 ._/-]+$/;
const SAFE_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** `/opt/<App name>`, or `null` for a name the profile, the desktop entry or a shell could misread. */
export function installDir(appName) {
  if (typeof appName !== "string" || !SAFE_NAME.test(appName) || appName.includes("..")) return null;
  return `/opt/${appName}`;
}

/** nfpm's architecture (Go's names) for Node's. */
export function goArch(arch) {
  return arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
}

/**
 * The package version: the app's own (three numbers) with the build number (`YYYYMMDD.HHMM`) as the
 * release, so a newer build of the same version still upgrades the older one, in dpkg and rpm alike.
 */
export function packageVersion(info) {
  if (!info || typeof info.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(info.version)) return null;
  if (typeof info.buildNumber !== "string" || !/^[0-9]{8}\.[0-9]{4}$/.test(info.buildNumber)) return null;
  return {version: info.version, release: info.buildNumber};
}

/**
 * The AppArmor profile: user namespaces for the app's executable and nothing else, unconfined
 * otherwise, the shape of Ubuntu's own profiles for Chrome and VS Code (and of the one the owner
 * rehearsed for the development Electron in the VM, ledger "Task 5, first step"). Electron's child
 * processes run the same executable, so they are covered; the reader needs no namespace and is not named.
 */
export function apparmorProfile({profileName, executablePath}) {
  if (typeof profileName !== "string" || !SAFE_ID.test(profileName)) throw new Error("PROFILE_NAME_UNSAFE");
  if (typeof executablePath !== "string" || !SAFE_PATH.test(executablePath)) throw new Error("PROFILE_PATH_UNSAFE");
  return [
    "# Generated by app/scripts/package/linux/packages.mjs (apparmorProfile). Installed by the .deb only.",
    "# Ubuntu lets only programs with their own profile create user namespaces, and Electron's sandbox",
    "# needs them. This profile grants that to the app's executable and confines nothing else.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${profileName} "${executablePath}" flags=(unconfined) {`,
    "  userns,",
    "",
    "  # Site-specific additions and overrides. See local/README for details.",
    `  include if exists <local/${profileName}>`,
    "}",
    ""
  ].join("\n");
}

const shellQuoted = (path) => {
  if (typeof path !== "string" || !SAFE_PATH.test(path)) throw new Error("SCRIPT_PATH_UNSAFE");
  return `'${path}'`;
};

/**
 * The .deb's postinst: loads the profile on configure, and again when dpkg rolls back a failed removal or
 * upgrade (prerm had unloaded it). Where AppArmor restricts user namespaces and the profile cannot be
 * loaded, the app could not start at all, so the install fails with the reason rather than leave a
 * program that aborts on launch; everywhere else a failed load is only reported. `securityfs` and
 * `restrictFile` are the system's own paths; the tests point them at stand-ins.
 */
export function postinstScript({profilePath, securityfs = "/sys/kernel/security/apparmor", restrictFile = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"}) {
  const quoted = shellQuoted(profilePath);
  const fs = shellQuoted(securityfs);
  const restrict = shellQuoted(restrictFile);
  return [
    "#!/bin/sh",
    "# Generated by app/scripts/package/linux/packages.mjs (postinstScript).",
    "set -e",
    "case \"$1\" in",
    "  configure|abort-remove|abort-upgrade|abort-deconfigure)",
    `    if command -v apparmor_parser >/dev/null 2>&1 && [ -d ${fs} ]; then`,
    `      if apparmor_parser --replace --write-cache --skip-read-cache ${quoted}; then exit 0; fi`,
    `      echo "The AppArmor profile ${profilePath} could not be loaded." >&2`,
    "    fi",
    `    if [ "$(cat ${restrict} 2>/dev/null)" = 1 ]; then`,
    "      echo \"This system allows user namespaces only to programs with an AppArmor profile, and the app's sandbox needs them.\" >&2",
    "      exit 1",
    "    fi",
    "    ;;",
    "esac",
    "exit 0",
    ""
  ].join("\n");
}

/** The .deb's prerm: unloads the profile when the package is removed (not on upgrade: postinst replaces it). */
export function prermScript({profilePath, securityfs = "/sys/kernel/security/apparmor"}) {
  const quoted = shellQuoted(profilePath);
  const fs = shellQuoted(securityfs);
  return [
    "#!/bin/sh",
    "# Generated by app/scripts/package/linux/packages.mjs (prermScript).",
    "set -e",
    `if [ "$1" = remove ] && command -v apparmor_parser >/dev/null 2>&1 && [ -d ${fs} ]; then`,
    `  apparmor_parser --remove ${quoted} >/dev/null 2>&1 || true`,
    "fi",
    "exit 0",
    ""
  ].join("\n");
}

/**
 * The desktop entry. `Name` is what GNOME reports as the application name of the app's own windows,
 * which is how the reader recognises and skips them; `StartupWMClass` and the file name match the
 * Wayland app id and WM_CLASS Electron sets from `desktopName` (`stage.mjs`, runtimePackageJson). No
 * switch on the command line: the sandbox is never turned off here.
 */
export function desktopEntry({appName, desktopId, executablePath}) {
  if (typeof appName !== "string" || !SAFE_NAME.test(appName)) throw new Error("DESKTOP_VALUE_UNSAFE");
  if (typeof desktopId !== "string" || !SAFE_ID.test(desktopId)) throw new Error("DESKTOP_VALUE_UNSAFE");
  if (typeof executablePath !== "string" || !SAFE_PATH.test(executablePath)) throw new Error("DESKTOP_VALUE_UNSAFE");
  return [
    "[Desktop Entry]", "Type=Application", "Version=1.5", `Name=${appName}`,
    `Exec="${executablePath}"`, `Icon=${desktopId}`, "Terminal=false", "Categories=Office;",
    `StartupWMClass=${desktopId}`, ""
  ].join("\n");
}

/**
 * nfpm's configuration for both packages, as an object (written as JSON, which nfpm reads as YAML).
 * Paths are the files artefacts.mjs wrote into its partial folder.
 */
export function nfpmConfig({flavour, appName, executable, arch, version, buildNumber, appDir, desktopFile, iconFile, profileFile, postinstFile, prermFile, maintainer, depends}) {
  if (!Object.hasOwn(BUNDLE_IDS, flavour)) return {error: "DEV_FLAVOUR_NOT_PACKAGED"};
  const goarch = goArch(arch);
  if (goarch === null) return {error: "UNSUPPORTED_ARCH"};
  if (arch === "arm64" && flavour === "release") return {error: "ARM64_IS_INTERNAL_ONLY"};
  const dir = installDir(appName);
  if (dir === null) return {error: "APP_NAME_UNSAFE"};
  const versions = packageVersion({version, buildNumber});
  if (versions === null) return {error: "VERSION_NOT_PACKAGEABLE"};
  if (typeof executable !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(executable)) return {error: "EXECUTABLE_NAME_UNSAFE"};
  if (typeof maintainer !== "string" || !maintainer.trim()) return {error: "MAINTAINER_MISSING"};
  if (!Array.isArray(depends?.deb) || !Array.isArray(depends?.rpm) || depends.deb.length === 0 || depends.rpm.length === 0) return {error: "DEPENDS_MISSING"};
  const desktopId = BUNDLE_IDS[flavour];
  return {config: {
    name: executable,
    arch: goarch,
    platform: "linux",
    version: versions.version,
    version_schema: "none",
    release: versions.release,
    section: "utils",
    priority: "optional",
    maintainer: maintainer.trim(),
    vendor: maintainer.trim(),
    description: appName,
    license: "Proprietary",
    // Applied to every file's mode: whatever the build machine's umask left, nothing ships writable
    // by group or others.
    umask: 0o022,
    contents: [
      {src: `${appDir}/`, dst: dir, type: "tree"},
      {src: desktopFile, dst: `/usr/share/applications/${desktopId}.desktop`, file_info: {mode: 0o644}},
      {src: iconFile, dst: `/usr/share/icons/hicolor/256x256/apps/${desktopId}.png`, file_info: {mode: 0o644}},
      {src: profileFile, dst: `/etc/apparmor.d/${desktopId}`, file_info: {mode: 0o644}, packager: "deb"}
    ],
    overrides: {
      deb: {depends: [...depends.deb], scripts: {postinstall: postinstFile, preremove: prermFile}},
      rpm: {depends: [...depends.rpm]}
    }
  }};
}

/** The version in `nfpm --version`'s report (`GitVersion:    2.47.0`), or `null`. */
export function nfpmVersionOf(output) {
  const m = /^GitVersion:[ \t]+v?([0-9]+\.[0-9]+\.[0-9]+)[ \t]*$/m.exec(String(output ?? ""));
  return m ? m[1] : null;
}

/** A PNG's size from its IHDR header, or `null` for anything that is not a PNG. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  const u32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  return {width: u32(16), height: u32(20)};
}

/** `rwsr-xr-x` and the like to a number, setuid, setgid and sticky bits included. */
function modeOf(text) {
  let mode = 0;
  const triple = (chars, shift, special) => {
    if (chars[0] === "r") mode |= 4 << shift;
    if (chars[1] === "w") mode |= 2 << shift;
    if ("xst".includes(chars[2])) mode |= 1 << shift;
    if ("sStT".includes(chars[2])) mode |= special;
  };
  triple(text.slice(0, 3), 6, 0o4000);
  triple(text.slice(3, 6), 3, 0o2000);
  triple(text.slice(6, 9), 0, 0o1000);
  return mode;
}

/**
 * A listed entry: a regular file, a directory (`dir: true`, path without its trailing slash), or
 * anything else (`other`: its type letter, `l` link, `h` hard link, `c`/`b` device, ...), kept so the
 * check can refuse it rather than never see it.
 */
const entryOf = (type, perms, path, owner) => {
  const clean = (type === "l" ? path.replace(/ -> .*$/, "") : path).replace(/\/+$/, "");
  if (!clean) return null;
  const entry = {path: clean, mode: modeOf(perms), owner};
  if (type === "d") return {...entry, dir: true};
  return type === "-" ? entry : {...entry, other: type};
};

/** The entries of a `dpkg-deb -c` listing (`-rwxr-xr-x root/root 123 2026-09-23 12:00 ./opt/x`). */
export function parseDebListing(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([-dlhcbps])([rwxsStT-]{9})\s+(\S+)\s+[0-9]+\s+[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}\s+\.(\/.*)$/.exec(line);
    const e = m ? entryOf(m[1], m[2], m[4], m[3]) : null;
    if (e) out.push(e);
  }
  return out;
}

/** The entries of an `rpm -qlvp` listing (`-rwxr-xr-x 1 root root 123 Sep 23 12:00 /opt/x`). */
export function parseRpmListing(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([-dlhcbps])([rwxsStT-]{9})\s+[0-9]+\s+(\S+)\s+(\S+)\s+[0-9]+\s+\S+\s+[0-9]+\s+\S+\s+(\/.*)$/.exec(line);
    const e = m ? entryOf(m[1], m[2], m[5], `${m[3]}/${m[4]}`) : null;
    if (e) out.push(e);
  }
  return out;
}

/**
 * Checks a built package's files and folders: everything the app needs where it must be, nothing
 * outside the app folder, the desktop entry, the icon and (the .deb only) the profile; every file
 * root's, not writable by group or others, never setuid or setgid, and readable by every user (the
 * programs runnable, the app's folders enterable: packager leaves its output folder 0700).
 */
export function checkPackageListing({listed, kind, appName, executable, desktopId, models}) {
  const problems = [];
  const all = Array.isArray(listed) ? listed : [];
  const dirs = all.filter((e) => e.dir === true);
  for (const e of all) if (e.other !== undefined) problems.push({code: "PACKAGE_LINK", detail: e.path});
  listed = all.filter((e) => e.dir !== true && e.other === undefined);
  if (listed.length === 0) return [{code: "PACKAGE_EMPTY", detail: kind}];
  const dir = installDir(appName);
  const desktop = `/usr/share/applications/${desktopId}.desktop`;
  const icon = `/usr/share/icons/hicolor/256x256/apps/${desktopId}.png`;
  const profile = `/etc/apparmor.d/${desktopId}`;
  const programs = [`${dir}/${executable}`, `${dir}/clave-reader`];
  const required = [...programs, `${dir}/resources/app.asar`, ...models.map((m) => `${dir}/tessdata/${m}`), desktop, icon, ...(kind === "deb" ? [profile] : [])];
  const has = (path) => listed.find((e) => e.path === path);
  for (const path of required) if (!has(path)) problems.push({code: "PACKAGE_FILE_MISSING", detail: path});
  const outside = [desktop, icon, ...(kind === "deb" ? [profile] : [])];
  for (const e of listed) {
    if (!e.path.startsWith(`${dir}/`) && !outside.includes(e.path)) problems.push({code: "PACKAGE_FILE_UNEXPECTED", detail: e.path});
    if (e.mode & 0o6000) problems.push({code: "PACKAGE_SETUID", detail: e.path});
    if (e.mode & 0o022) problems.push({code: "PACKAGE_WRITABLE", detail: e.path});
    if (e.owner !== "root/root") problems.push({code: "PACKAGE_OWNER", detail: e.path});
  }
  for (const path of programs) { const e = has(path); if (e && (e.mode & 0o111) !== 0o111) problems.push({code: "PACKAGE_NOT_EXECUTABLE", detail: path}); }
  for (const e of listed) {
    const needs = programs.includes(e.path) ? 0o005 : 0o004;
    if ((e.mode & needs) !== needs) problems.push({code: "PACKAGE_NOT_READABLE", detail: e.path});
  }
  if (!dirs.some((d) => d.path === dir)) problems.push({code: "PACKAGE_FILE_MISSING", detail: dir});
  // Every folder the package carries, the shared ones it only lists (/etc/apparmor.d, /usr/share/...) too.
  for (const d of dirs) {
    if ((d.mode & 0o005) !== 0o005) problems.push({code: "PACKAGE_NOT_READABLE", detail: d.path});
    if (d.mode & 0o6000) problems.push({code: "PACKAGE_SETUID", detail: d.path});
    if (d.mode & 0o022) problems.push({code: "PACKAGE_WRITABLE", detail: d.path});
    if (d.owner !== "root/root") problems.push({code: "PACKAGE_OWNER", detail: d.path});
  }
  return problems;
}

/** Packages are made only from a Linux bundle that has been through the fuse step (sign.mjs). */
export function linuxArtefactDecision({flavour, report}) {
  if (flavour !== "internal" && flavour !== "release") return {error: "BAD_FLAVOUR"};
  if (!report || report.platform !== "linux") return {error: "BUNDLE_NOT_LINUX"};
  if (report.fused !== true) return {error: "ARTEFACT_NEEDS_FUSED"};
  return {ok: true};
}
