import {lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {
  EXTENSION_UUID, createGnomeExtension, extensionBlockers, extensionDataHome, extensionFs, extensionState, gvariantStrings, gvariantStringArray, gdbusString,
  shellExtensionState, type ExtensionFacts
} from "./gnomeExtension";

const READER = "/opt/Clave Agent/clave-reader";

describe("reading GNOME's answers", () => {
  it("reads gsettings' string arrays, including the empty one and quotes inside names", () => {
    expect(gvariantStrings("['a@b', 'clave-focus@clave.dev']\n")).toEqual(["a@b", "clave-focus@clave.dev"]);
    expect(gvariantStrings("@as []\n")).toEqual([]);
    expect(gvariantStrings("[]")).toEqual([]);
    expect(gvariantStrings("['it\\'s@x']")).toEqual(["it's@x"]);
    for (const bad of ["", "nonsense", "['unclosed", "[1, 2]"]) expect(gvariantStrings(bad), bad).toBeNull();
  });

  it("writes a string array gsettings reads back the same", () => {
    const list = ["a@b", "it's@x", "back\\slash@y"];
    expect(gvariantStrings(gvariantStringArray(list))).toEqual(list);
    expect(gvariantStringArray([])).toBe("@as []");
  });

  it("reads the one string of a gdbus reply, in either quoting", () => {
    expect(gdbusString("('{\"version\":1,\"readerPath\":\"/opt/x\"}',)\n")).toBe("{\"version\":1,\"readerPath\":\"/opt/x\"}");
    expect(gdbusString("(\"it's\",)")).toBe("it's");
    expect(gdbusString("('a\\'b\\\\c',)")).toBe("a'b\\c");
    for (const bad of ["", "(true,)", "('a', 'b')", "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownObject"]) {
      expect(gdbusString(bad), bad).toBeNull();
    }
  });

  it("reads the state gnome-extensions prints", () => {
    expect(shellExtensionState("clave-focus@clave.dev\n  Name: Clave focus\n  Enabled: Yes\n  State: ACTIVE\n")).toBe("active");
    expect(shellExtensionState("  State: INACTIVE\n")).toBe("inactive");
    expect(shellExtensionState("  State: INITIALIZED\n")).toBe("inactive");
    expect(shellExtensionState("  State: ERROR\n")).toBe("error");
    expect(shellExtensionState("  State: OUT OF DATE\n")).toBe("error");
    expect(shellExtensionState("Extension “clave-focus@clave.dev” doesn't exist\n")).toBe("unknownToShell");
    expect(shellExtensionState("")).toBe("unknownToShell");
  });
});

describe("the extension's state", () => {
  const ready: ExtensionFacts = {
    files: "same", enabled: true, userExtensionsOff: false, shell: "active",
    loaded: {version: 1, readerPath: READER}, expected: {version: 1, readerPath: READER}, readerRefused: false
  };

  it("is ready when the right files are installed, switched on, running, and running what was installed", () => {
    expect(extensionState(ready)).toBe("ready");
  });

  it("asks for an install when the files are missing or not the ones this app carries", () => {
    expect(extensionState({...ready, files: "missing"})).toBe("missing");
    expect(extensionState({...ready, files: "different"})).toBe("outdated");
  });

  it("says GNOME's own switch is off before anything the app could fix, and says a switched-off extension apart", () => {
    expect(extensionState({...ready, userExtensionsOff: true})).toBe("extensionsOff");
    expect(extensionState({...ready, enabled: false})).toBe("disabled");
    expect(extensionState({...ready, enabled: false, userExtensionsOff: true})).toBe("extensionsOff");
  });

  it("asks for a new login when GNOME has not loaded it, or runs another version or reader path", () => {
    expect(extensionState({...ready, shell: "unknownToShell", loaded: null})).toBe("needsLogin");
    expect(extensionState({...ready, shell: "inactive", loaded: null})).toBe("needsLogin");
    expect(extensionState({...ready, loaded: {version: 0, readerPath: READER}})).toBe("needsLogin");
    expect(extensionState({...ready, loaded: {version: 1, readerPath: "/old/clave-reader"}})).toBe("needsLogin");
    expect(extensionState({...ready, loaded: {version: 1, readerPath: null}})).toBe("needsLogin");
    expect(extensionState({...ready, loaded: null})).toBe("needsLogin");
  });

  it("asks for a new login when the reader is refused though everything else matches (Task 7 review, I2)", () => {
    expect(extensionState({...ready, readerRefused: true})).toBe("needsLogin");
    expect(extensionState({...ready, files: "missing", readerRefused: true})).toBe("missing");
  });

  it("says GNOME cannot run it when GNOME reports an error or GNOME's answers cannot be read", () => {
    expect(extensionState({...ready, shell: "error"})).toBe("unsupported");
    expect(extensionState({...ready, enabled: null})).toBe("unsupported");
    expect(extensionState({...ready, userExtensionsOff: null})).toBe("unsupported");
  });
});

describe("the blockers the engine is told", () => {
  it("names one blocker for each state that needs the user, and none when ready or not yet known", () => {
    expect(extensionBlockers("ready")).toEqual([]);
    expect(extensionBlockers(null)).toEqual([]);
    expect(extensionBlockers("missing")).toEqual(["EXTENSION_MISSING"]);
    expect(extensionBlockers("outdated")).toEqual(["EXTENSION_MISSING"]);
    expect(extensionBlockers("disabled")).toEqual(["EXTENSION_OFF"]);
    expect(extensionBlockers("extensionsOff")).toEqual(["EXTENSIONS_OFF_IN_GNOME"]);
    expect(extensionBlockers("needsLogin")).toEqual(["EXTENSION_NEEDS_LOGIN"]);
    expect(extensionBlockers("unsupported")).toEqual(["EXTENSION_UNSUPPORTED"]);
  });
});

/** A fake machine: files by path (with modes and owners), and scripted commands. */
function machine(over: {
  enabled?: string; disabled?: string; userOff?: string; info?: string; status?: string | null; locked?: boolean; realpath?: string;
  /** A `gsettings get` that fails, as a timed-out or missing gsettings does (empty output, non-zero code). */
  unreadable?: boolean;
  /** `Status()`'s gdbus exit code, when it is not 0 though the output looks right. */
  statusCode?: number;
} = {}) {
  const files = new Map<string, {data: string; mode: number; uid?: number; regular?: boolean}>();
  const bundled = {"extension.js": "EXT", "logic.js": "LOGIC", "metadata.json": "{\"version\": 1}"};
  for (const [name, data] of Object.entries(bundled)) files.set(`/bundle/${name}`, {data, mode: 0o644});
  const settings = {
    "enabled-extensions": over.enabled ?? "@as []",
    "disabled-extensions": over.disabled ?? "@as []",
    "disable-user-extensions": over.userOff ?? "false"
  };
  const ran: string[][] = [];
  let unreadable = over.unreadable ?? false;
  /** The NEXT call of a command held open until released: `hold("gnome-extensions")` then `release()`. */
  let held: {file: string; waiting: (() => void)[]; taken: boolean} | null = null;
  const run = async (file: string, args: readonly string[]) => {
    ran.push([file, ...args]);
    if (held !== null && held.file === file && !held.taken) {
      held.taken = true;
      await new Promise<void>((resolve) => { held?.waiting.push(resolve); });
    }
    if (file === "gsettings" && args[0] === "get") return unreadable ? {code: 1, stdout: ""} : {code: 0, stdout: `${settings[args[2] as keyof typeof settings]}\n`};
    if (file === "gsettings" && args[0] === "set") { settings[args[2] as keyof typeof settings] = args[3] as string; return {code: 0, stdout: ""}; }
    if (file === "gnome-extensions") return {code: over.info === undefined ? 0 : 2, stdout: over.info ?? "  State: ACTIVE\n"};
    if (file === "gdbus" && args.includes("org.gnome.ScreenSaver.GetActive")) return {code: 0, stdout: over.locked ? "(true,)\n" : "(false,)\n"};
    if (file === "gdbus" && args.includes("com.clave.Focus.Status")) {
      return over.status === null ? {code: 1, stdout: ""} : {code: over.statusCode ?? 0, stdout: `('${over.status ?? `{"version":1,"readerPath":"${READER}"}`}',)\n`};
    }
    if (file === "gnome-session-quit") return {code: 0, stdout: ""};
    return {code: 127, stdout: ""};
  };
  const fs = {
    async read(path: string) { const file = files.get(path); if (!file) throw Object.assign(new Error("ENOENT"), {code: "ENOENT"}); return file.data; },
    async mode(path: string) { const file = files.get(path); return file ? {regular: file.regular ?? true, mode: file.mode, uid: file.uid ?? ME} : null; },
    async write(path: string, data: string, mode: number) { files.set(path, {data, mode}); },
    async remove(path: string) { files.delete(path); },
    async removeDir() { /* the fake has no directories */ },
    async makeDir() { /* the fake has no directories */ },
    async realpath() { return over.realpath ?? READER; }
  };
  const restarts: number[] = [];
  const extension = createGnomeExtension({
    run, fs, bundleDir: "/bundle", dataHome: "/home/a/.local/share", helperPath: READER, uid: ME,
    restartReader: () => { restarts.push(1); }
  });
  const target = `/home/a/.local/share/gnome-shell/extensions/${EXTENSION_UUID}`;
  return {
    extension, files, settings, ran, target, restarts,
    setUnreadable(value: boolean) { unreadable = value; },
    hold(file: string) { held = {file, waiting: [], taken: false}; },
    release() { const waiting = held?.waiting ?? []; held = null; for (const resolve of waiting) resolve(); }
  };
}

const ME = 1000;

describe("installing, checking and removing it", () => {
  it("installs the three files and a reader-path of the helper's real path, all 0644, and switches it on in GNOME", async () => {
    // The helper reached through a symlink: the extension compares /proc/<pid>/exe, which is resolved.
    const m = machine({enabled: "['other@x']", disabled: `['${EXTENSION_UUID}']`, realpath: "/opt/Clave Agent/resources/clave-reader"});
    await m.extension.install();
    for (const name of ["extension.js", "logic.js", "metadata.json"]) {
      expect(m.files.get(`${m.target}/${name}`), name).toEqual(m.files.get(`/bundle/${name}`));
    }
    expect(m.files.get(`${m.target}/reader-path`)).toEqual({data: "/opt/Clave Agent/resources/clave-reader\n", mode: 0o644});
    expect(gvariantStrings(m.settings["enabled-extensions"])).toEqual(["other@x", EXTENSION_UUID]);
    expect(gvariantStrings(m.settings["disabled-extensions"])).toEqual([]);
    // GNOME's own switch for every extension is the user's, and is never touched.
    expect(m.ran.some((command) => command.includes("disable-user-extensions") && command[1] === "set")).toBe(false);
  });

  it("does not add itself twice to GNOME's list", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    expect(gvariantStrings(m.settings["enabled-extensions"])).toEqual([EXTENSION_UUID]);
  });

  it("checks the machine: ready after an install that GNOME is running, needing a login when it is not", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    expect(await m.extension.check()).toBe("missing");
    await m.extension.install();
    expect(await m.extension.check()).toBe("ready");
    const fresh = machine({enabled: `['${EXTENSION_UUID}']`, info: "Extension doesn't exist\n", status: null});
    await fresh.extension.install();
    expect(await fresh.extension.check()).toBe("needsLogin");
  });

  it("sees files that are not this app's, and a reader-path someone else could write, as out of date", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    m.files.set(`${m.target}/logic.js`, {data: "OLD", mode: 0o644});
    expect(await m.extension.check()).toBe("outdated");
    await m.extension.install();
    m.files.set(`${m.target}/reader-path`, {data: `${READER}\n`, mode: 0o664});
    expect(await m.extension.check()).toBe("outdated");
    await m.extension.install();
    m.files.set(`${m.target}/reader-path`, {data: "/elsewhere/clave-reader\n", mode: 0o644});
    expect(await m.extension.check()).toBe("outdated");
  });

  it("keeps the last answer while the screen is locked, because GNOME switches extensions off there", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    expect(await m.extension.check()).toBe("ready");
    const locked = machine({enabled: `['${EXTENSION_UUID}']`, locked: true, status: null, info: "  State: INACTIVE\n"});
    expect(await locked.extension.check()).toBe(null);            // nothing known yet, and locked: no answer
    expect(locked.extension.state()).toBe(null);
  });

  it("tells whoever listens when the answer changes, and only then", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    const seen: (string | null)[] = [];
    m.extension.onChange(() => seen.push(m.extension.state()));
    await m.extension.check();
    await m.extension.check();
    await m.extension.install();
    await m.extension.check();
    expect(seen).toEqual(["missing", "ready"]);
  });

  it("removes its own files and its place in GNOME's list, and nothing else", async () => {
    const m = machine({enabled: `['other@x', '${EXTENSION_UUID}']`});
    await m.extension.install();
    m.files.set(`${m.target}/someone-elses`, {data: "x", mode: 0o644});
    await m.extension.remove();
    for (const name of ["extension.js", "logic.js", "metadata.json", "reader-path"]) expect(m.files.has(`${m.target}/${name}`), name).toBe(false);
    expect(m.files.has(`${m.target}/someone-elses`)).toBe(true);
    expect(gvariantStrings(m.settings["enabled-extensions"])).toEqual(["other@x"]);
    expect(await m.extension.check()).toBe("missing");
  });

  it("asks GNOME to log out through its own confirmation", async () => {
    const m = machine();
    await m.extension.logOut();
    expect(m.ran).toContainEqual(["gnome-session-quit", "--logout"]);
  });
});

describe("the Task 7 review's findings", () => {
  it("never writes GNOME's list of extensions when it cannot read it, so no other extension is switched off (I1)", async () => {
    const m = machine({enabled: "['other@x', 'dash@y']", unreadable: true});
    await m.extension.install();
    expect(m.settings["enabled-extensions"]).toBe("['other@x', 'dash@y']");
    expect(m.ran.some((command) => command[0] === "gsettings" && command[1] === "set")).toBe(false);
    // Nothing is written at all when it would stop half way.
    expect(m.files.has(`${m.target}/extension.js`)).toBe(false);
  });

  it("does one thing at a time, so a slow check cannot land after an install and undo its answer (I4)", async () => {
    // Switched off in GNOME: a check started now reads that, and is held before it answers.
    const m = machine({enabled: `['${EXTENSION_UUID}']`, disabled: `['${EXTENSION_UUID}']`});
    m.hold("gnome-extensions");
    const slow = m.extension.check();
    const installing = m.extension.install();
    // Room for an install that did not wait its turn to finish before the held check answers.
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
    m.release();
    await Promise.all([slow, installing]);
    expect(m.extension.state()).toBe("ready");
    const order: (string | null)[] = [];
    m.extension.onChange(() => order.push(m.extension.state()));
    m.hold("gnome-extensions");
    const first = m.extension.remove();
    const second = m.extension.check();
    m.release();
    expect([await first, await second]).toEqual(["missing", "missing"]);
    expect(order).toEqual(["missing"]);
  });

  it("switches GNOME's extensions back on only when asked to, and nothing else (I3, owner's option A)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`, userOff: "true"});
    await m.extension.install();
    expect(await m.extension.check()).toBe("extensionsOff");
    expect(m.settings["disable-user-extensions"]).toBe("true");
    expect(await m.extension.enableAll()).toBe("ready");
    expect(m.settings["disable-user-extensions"]).toBe("false");
    expect(gvariantStrings(m.settings["enabled-extensions"])).toEqual([EXTENSION_UUID]);
  });

  it("restarts the reader once when the extension refuses it, and asks for a login when a fresh one is refused too (I2)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    await m.extension.readerRefused(true);
    // A reader replaced on disk while it ran ("(deleted)") is cured by a fresh one: tried first.
    expect(m.restarts).toHaveLength(1);
    expect(m.extension.state()).toBe("ready");
    await m.extension.readerRefused(true);
    expect(m.restarts).toHaveLength(1);
    expect(m.extension.state()).toBe("needsLogin");
    expect(await m.extension.check()).toBe("needsLogin");
    await m.extension.readerRefused(false);
    expect(m.extension.state()).toBe("ready");
    // Answered again: the next refusal starts over with a restart.
    await m.extension.readerRefused(true);
    expect(m.restarts).toHaveLength(2);
  });

  it("sees a reader-path it did not write as out of date: another owner, not a regular file, or a longer path (M6, M8, M9)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    m.files.set(`${m.target}/reader-path`, {data: `${READER}\n`, mode: 0o644, uid: 0});
    expect(await m.extension.check()).toBe("outdated");
    await m.extension.install();
    m.files.set(`${m.target}/reader-path`, {data: `${READER}\n`, mode: 0o644, regular: false});
    expect(await m.extension.check()).toBe("outdated");
    await m.extension.install();
    m.files.set(`${m.target}/reader-path`, {data: `${READER}-old\n`, mode: 0o644});
    expect(await m.extension.check()).toBe("outdated");
  });

  it("counts an extension in GNOME's switched-off list as switched off, even when it is also in the on list (M11)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`, disabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    m.settings["disabled-extensions"] = `['${EXTENSION_UUID}']`;
    expect(await m.extension.check()).toBe("disabled");
  });

  it("keeps the last answer when GNOME's settings cannot be read for a moment, rather than calling GNOME unsupported (M7)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    await m.extension.install();
    m.setUnreadable(true);
    expect(await m.extension.check()).toBe("ready");
    const fresh = machine({unreadable: true});
    expect(await fresh.extension.check()).toBe("missing");
  });

  it("answers the state an install left, so a failed one can be told apart (M5)", async () => {
    const m = machine({enabled: `['${EXTENSION_UUID}']`});
    m.files.delete("/bundle/logic.js");                 // a package without the extension's files
    expect(await m.extension.install()).toBe("missing");
  });

  it("reads a gdbus reply only when gdbus succeeded, and a version only when it is a whole number (M20, M21)", async () => {
    const failed = machine({enabled: `['${EXTENSION_UUID}']`, statusCode: 1});
    await failed.extension.install();
    expect(await failed.extension.check()).toBe("needsLogin");
    const bad = machine({enabled: `['${EXTENSION_UUID}']`});
    bad.files.set("/bundle/metadata.json", {data: "{\"version\": 1.5}", mode: 0o644});
    await bad.extension.install();
    expect(await bad.extension.check()).toBe("needsLogin");
  });
});

describe("reading GNOME's answers, more strictly", () => {
  it("wants a comma between gsettings' strings (M16) and counts GNOME 44's ENABLED as running (M17)", () => {
    expect(gvariantStrings("['a' 'b']")).toBeNull();
    expect(shellExtensionState("  State: ENABLED\n")).toBe("active");
  });

  it("takes the extensions folder from XDG_DATA_HOME when it is an absolute path, else ~/.local/share (M38)", () => {
    expect(extensionDataHome({XDG_DATA_HOME: "/data/a"}, "/home/a")).toBe("/data/a");
    expect(extensionDataHome({XDG_DATA_HOME: "relative"}, "/home/a")).toBe("/home/a/.local/share");
    expect(extensionDataHome({}, "/home/a")).toBe("/home/a/.local/share");
  });
});

describe("the real file writes (Task 7 review, M9)", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "clave-ext-"));

  it("replaces a symlink where a file goes, never writing through it, with exactly the mode asked for", async () => {
    const dir = scratch();
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(dir, "reader-path"));
    // A strict umask: the mode asked for is set explicitly, not left to what the umask allows.
    const umask = process.umask(0o077);
    try {
      await extensionFs.write(join(dir, "reader-path"), "/opt/x/clave-reader\n", 0o644);
    } finally {
      process.umask(umask);
    }
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(lstatSync(join(dir, "reader-path")).isSymbolicLink()).toBe(false);
    expect(statSync(join(dir, "reader-path")).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).sort()).toEqual(["outside.txt", "reader-path"]);
    rmSync(dir, {recursive: true, force: true});
  });

  it("leaves no temporary file behind when a write fails after the temporary file was made", async () => {
    const dir = scratch();
    // The rename fails: a folder with something in it sits where the file goes.
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "inside"), "");
    await expect(extensionFs.write(join(dir, "x"), "data", 0o644)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["x"]);
    rmSync(dir, {recursive: true, force: true});
  });

  it("makes the extension's folder 0755 whatever the umask, and refuses one that is a symlink", async () => {
    const dir = scratch();
    const umask = process.umask(0o077);
    try {
      await extensionFs.makeDir(join(dir, "a", "b"));
    } finally {
      process.umask(umask);
    }
    expect(statSync(join(dir, "a", "b")).mode & 0o777).toBe(0o755);
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "linked"));
    await expect(extensionFs.makeDir(join(dir, "linked"))).rejects.toThrow("EXTENSION_DIR_NOT_A_DIRECTORY");
    rmSync(dir, {recursive: true, force: true});
  });
});
