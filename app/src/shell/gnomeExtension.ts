import {execFile} from "node:child_process";
import {randomBytes} from "node:crypto";
import {chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile} from "node:fs/promises";
import {posix} from "node:path";
import type {Blocker} from "../main/engine";
import type {ExtensionState} from "../shared/ipc";

// Linux paths whatever the machine running the code: the tests run on macOS and Windows too.
const {isAbsolute, join} = posix;

/**
 * The Clave focus extension (Linux, GNOME): the app installs it, checks it and removes it here. On
 * Wayland only GNOME Shell knows which window is in front and where, and the reader asks this
 * extension (`app/linux/gnome-extension`). What can be wrong, in the order the user can fix it:
 *
 * · `missing` / `outdated`: its files are not installed, or are not the ones this app carries (an
 *   older app's, or a `reader-path` that names another reader or that someone else could write).
 *   Fixed by installing again.
 * · `extensionsOff`: GNOME's own switch for every user extension is off. That switch is the user's and
 *   the app never touches it; they switch it on in the Extensions app.
 * · `disabled`: this extension is switched off in GNOME. Installing again switches it back on.
 * · `unsupported`: GNOME reports an error for it (a GNOME version it was not written for), or GNOME's
 *   answers cannot be read at all (not GNOME).
 * · `needsLogin`: installed and switched on, but the running GNOME has not loaded it, or runs an older
 *   version or an older reader path than the ones installed (GNOME reads an extension and its
 *   `reader-path` once, at login). Fixed by logging out and back in.
 *
 * While the screen is locked GNOME switches every extension off, so a check then keeps the answer it
 * had: the lock is not a problem to report.
 */
export type {ExtensionState};

export const EXTENSION_UUID = "clave-focus@clave.dev";
const FILES = ["extension.js", "logic.js", "metadata.json"] as const;

/**
 * What the engine is told: one blocker for a state the user has to act on. Nothing while the state is
 * not known yet: the reader's own answers keep capture from reading until the extension answers it.
 */
export function extensionBlockers(state: ExtensionState | null): Blocker[] {
  switch (state) {
    case null: case "ready": return [];
    case "missing": case "outdated": return ["EXTENSION_MISSING"];
    case "disabled": return ["EXTENSION_OFF"];
    case "extensionsOff": return ["EXTENSIONS_OFF_IN_GNOME"];
    case "needsLogin": return ["EXTENSION_NEEDS_LOGIN"];
    case "unsupported": return ["EXTENSION_UNSUPPORTED"];
  }
}

/** What GNOME's `gnome-extensions info` says the running shell has made of it. */
export type ShellExtensionState = "active" | "inactive" | "error" | "unknownToShell";

export interface ExtensionFacts {
  files: "same" | "different" | "missing";
  /** In GNOME's list of switched-on extensions and not in its switched-off list; null when unreadable. */
  enabled: boolean | null;
  /** GNOME's `disable-user-extensions`; null when unreadable. */
  userExtensionsOff: boolean | null;
  shell: ShellExtensionState;
  /** What the running extension says it loaded (`Status()`), or null when it does not answer. */
  loaded: {version: number | null; readerPath: string | null} | null;
  expected: {version: number | null; readerPath: string};
  /**
   * The reader has been refused by the running extension even after a fresh reader was started
   * (Task 7 review, I2): the extension loaded a reader path at login that no longer
   * matches the reader's executable, in a way `Status()` cannot show. A new login cures it.
   */
  readerRefused: boolean;
}

/** The one state the facts add up to. Pure. */
export function extensionState(facts: ExtensionFacts): ExtensionState {
  if (facts.files === "missing") return "missing";
  if (facts.files === "different") return "outdated";
  if (facts.enabled === null || facts.userExtensionsOff === null) return "unsupported";
  if (facts.userExtensionsOff) return "extensionsOff";
  if (!facts.enabled) return "disabled";
  if (facts.shell === "error") return "unsupported";
  const loaded = facts.loaded;
  if (loaded === null || loaded.version === null || loaded.version !== facts.expected.version
    || loaded.readerPath !== facts.expected.readerPath || facts.readerRefused) return "needsLogin";
  return "ready";
}

/** One GVariant text-format string body (between its quotes), unescaped. */
function unescape(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, code: string) => {
    if (code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
    return ({n: "\n", t: "\t", r: "\r"} as Record<string, string>)[code] ?? code;
  });
}

const QUOTED = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/y;

/** A GVariant string array as `gsettings get` prints it (`['a', 'b']`, `@as []`), or null. */
export function gvariantStrings(output: string): string[] | null {
  const text = output.trim().replace(/^@as\s+/, "");
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const found: string[] = [];
  let at = 0;
  while (at < inner.length) {
    QUOTED.lastIndex = at;
    const match = QUOTED.exec(inner);
    if (!match) return null;
    found.push(unescape(match[1] ?? match[2] ?? ""));
    at = QUOTED.lastIndex;
    const rest = inner.slice(at).match(/^\s*(,\s*)?/);
    at += rest?.[0].length ?? 0;
    if (rest?.[1] === undefined && at < inner.length) return null;
  }
  return found;
}

/** A string array in the text form `gsettings set` takes. */
export function gvariantStringArray(list: readonly string[]): string {
  if (list.length === 0) return "@as []";
  return `[${list.map((item) => `'${item.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;
}

/** The single string of a gdbus reply (`('...',)`), or null for anything else. */
export function gdbusString(output: string): string | null {
  const text = output.trim();
  const match = /^\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),\)$/.exec(text);
  if (!match) return null;
  return unescape(match[1] ?? match[2] ?? "");
}

/** The state line of `gnome-extensions info`. */
export function shellExtensionState(output: string): ShellExtensionState {
  const state = /^\s*State:\s*(.+?)\s*$/m.exec(output)?.[1]?.toUpperCase();
  if (state === "ACTIVE" || state === "ENABLED") return "active";
  if (state === "ERROR" || state === "OUT OF DATE") return "error";
  if (state === undefined) return "unknownToShell";
  return "inactive";
}

type Run = (file: string, args: readonly string[]) => Promise<{code: number; stdout: string}>;
interface ExtensionFs {
  read(path: string): Promise<string>;
  /** A file's kind, permission bits and owner, without following a symlink; null when it is not there. */
  mode(path: string): Promise<{regular: boolean; mode: number; uid: number} | null>;
  /** Write a whole file with exactly this mode, whatever the umask, replacing whatever was there. */
  write(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  /** Remove a directory if it is empty; anything else is left. */
  removeDir(path: string): Promise<void>;
  /** Make a directory (and its parents) that is a real directory, not a symlink, mode 0755. */
  makeDir(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export interface GnomeExtension {
  /** The last answer, or null before the first one. */
  state(): ExtensionState | null;
  /** Look at the machine again; the answer, or the last one while it cannot be read (locked, a GNOME command failing). */
  check(): Promise<ExtensionState | null>;
  /** Install (or reinstall) this app's extension and switch it on in GNOME, then check. Never throws. */
  install(): Promise<ExtensionState | null>;
  /** Switch it off and remove its files, then check. Never throws. */
  remove(): Promise<ExtensionState | null>;
  /** GNOME's own switch for every user extension, back on: only ever on the user's press (owner's decision, Task 7 review I3). */
  enableAll(): Promise<ExtensionState | null>;
  /** GNOME's own log-out, with its own confirmation. */
  logOut(): Promise<void>;
  /**
   * What the reader says: `true` when the running extension refused it, `false` when it answered.
   * The first refusal restarts the reader (a reader binary replaced while it ran is refused, and a
   * fresh one is not); a refusal after that means the extension needs a new login.
   */
  readerRefused(refused: boolean): Promise<ExtensionState | null>;
  onChange(cb: () => void): () => void;
}

export function createGnomeExtension(deps: {
  run: Run; fs: ExtensionFs; bundleDir: string; dataHome: string; helperPath: string;
  /** This process's uid: the owner `reader-path` must have, as the extension itself insists. */
  uid: number;
  /** Replace the running reader with a fresh one. */
  restartReader: () => void;
}): GnomeExtension {
  const {run, fs} = deps;
  const target = join(deps.dataHome, "gnome-shell", "extensions", EXTENSION_UUID);
  const listeners = new Set<() => void>();
  let current: ExtensionState | null = null;
  let refusals = 0;

  // One thing at a time: a check that started before an install must not land after it and put an
  // older answer back (Task 7 review, I4). Each step waits for the one before, and so answers last.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(step: () => Promise<T>): Promise<T> {
    const next = queue.then(step, step);
    queue = next.catch(() => undefined);
    return next;
  }

  const readerPath = () => fs.realpath(deps.helperPath).catch(() => deps.helperPath);
  const setting = async (key: string): Promise<string | null> => {
    const answer = await run("gsettings", ["get", "org.gnome.shell", key]).catch(() => ({code: 1, stdout: ""}));
    return answer.code === 0 ? answer.stdout : null;
  };
  const list = async (key: string): Promise<string[] | null> => {
    const text = await setting(key);
    return text === null ? null : gvariantStrings(text);
  };
  const setList = (key: string, items: readonly string[]) => run("gsettings", ["set", "org.gnome.shell", key, gvariantStringArray(items)]);

  async function bundledVersion(): Promise<number | null> {
    try {
      const version = (JSON.parse(await fs.read(join(deps.bundleDir, "metadata.json"))) as {version?: unknown}).version;
      return Number.isSafeInteger(version) ? version as number : null;
    } catch {
      return null;
    }
  }

  async function files(expectedReader: string): Promise<ExtensionFacts["files"]> {
    const installed = await fs.read(join(target, "extension.js")).catch(() => null);
    if (installed === null) return "missing";
    for (const name of FILES) {
      const [mine, theirs] = await Promise.all([fs.read(join(deps.bundleDir, name)).catch(() => null), fs.read(join(target, name)).catch(() => null)]);
      if (mine === null || theirs === null || mine !== theirs) return "different";
    }
    // The extension trusts `reader-path` only as a regular file of its user that nobody else may
    // write; the app judges it by the same rule, or a file the extension refuses reads "same" here
    // and the user is sent round a login that never cures it (Task 7 review, M6).
    const mode = await fs.mode(join(target, "reader-path"));
    if (mode === null || !mode.regular || (mode.mode & 0o022) !== 0 || mode.uid !== deps.uid) return "different";
    const named = await fs.read(join(target, "reader-path")).catch(() => null);
    return named === `${expectedReader}\n` ? "same" : "different";
  }

  async function locked(): Promise<boolean> {
    const answer = await run("gdbus", ["call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path",
      "/org/gnome/ScreenSaver", "--method", "org.gnome.ScreenSaver.GetActive"]).catch(() => ({code: 1, stdout: ""}));
    return answer.stdout.trim() === "(true,)";
  }

  async function loaded(): Promise<ExtensionFacts["loaded"]> {
    const answer = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/com/clave/Focus",
      "--method", "com.clave.Focus.Status"]).catch(() => ({code: 1, stdout: ""}));
    const json = answer.code === 0 ? gdbusString(answer.stdout) : null;
    if (json === null) return null;
    try {
      const value = JSON.parse(json) as {version?: unknown; readerPath?: unknown};
      return {
        version: Number.isSafeInteger(value.version) ? value.version as number : null,
        readerPath: typeof value.readerPath === "string" ? value.readerPath : null
      };
    } catch {
      return null;
    }
  }

  function settle(next: ExtensionState): ExtensionState {
    if (next !== current) {
      current = next;
      for (const cb of [...listeners]) { try { cb(); } catch { /* one bad listener must not stop the others */ } }
    }
    return next;
  }

  async function checkNow(): Promise<ExtensionState | null> {
    if (await locked()) return current;
    const expectedReader = await readerPath();
    const [enabledList, disabledList, userOffText] = await Promise.all([list("enabled-extensions"), list("disabled-extensions"), setting("disable-user-extensions")]);
    const userOff = userOffText?.trim() === "true" ? true : userOffText?.trim() === "false" ? false : null;
    const info = await run("gnome-extensions", ["info", EXTENSION_UUID]).catch(() => ({code: 1, stdout: ""}));
    const facts: ExtensionFacts = {
      files: await files(expectedReader),
      enabled: enabledList === null || disabledList === null ? null : enabledList.includes(EXTENSION_UUID) && !disabledList.includes(EXTENSION_UUID),
      userExtensionsOff: userOff,
      shell: shellExtensionState(info.stdout),
      loaded: await loaded(),
      expected: {version: await bundledVersion(), readerPath: expectedReader},
      readerRefused: refusals >= 2
    };
    // A GNOME command that fails for a moment is not GNOME being unsupported: the last answer stands
    // (Task 7 review, M7). Only with no answer yet is "unsupported" what it is.
    if ((facts.enabled === null || facts.userExtensionsOff === null) && current !== null && facts.files === "same") return current;
    return settle(extensionState(facts));
  }

  return {
    state: () => current,
    check: () => serial(checkNow),
    install: () => serial(async () => {
      try {
        // Read GNOME's lists before anything is written: a list that cannot be read would be written
        // back holding only this extension, switching every other one off (Task 7 review, I1).
        const [enabled, disabled] = await Promise.all([list("enabled-extensions"), list("disabled-extensions")]);
        if (enabled === null || disabled === null) return await checkNow();
        const contents = await Promise.all(FILES.map((name) => fs.read(join(deps.bundleDir, name))));
        await fs.makeDir(target);
        for (const [index, name] of FILES.entries()) await fs.write(join(target, name), contents[index] as string, 0o644);
        await fs.write(join(target, "reader-path"), `${await readerPath()}\n`, 0o644);
        if (!enabled.includes(EXTENSION_UUID)) await setList("enabled-extensions", [...enabled, EXTENSION_UUID]);
        if (disabled.includes(EXTENSION_UUID)) await setList("disabled-extensions", disabled.filter((uuid) => uuid !== EXTENSION_UUID));
      } catch {
        // The state checked below says what is there; the window compares it with what it asked for.
      }
      return checkNow();
    }),
    remove: () => serial(async () => {
      try {
        const enabled = await list("enabled-extensions");
        if (enabled?.includes(EXTENSION_UUID)) await setList("enabled-extensions", enabled.filter((uuid) => uuid !== EXTENSION_UUID));
        for (const name of [...FILES, "reader-path"]) await fs.remove(join(target, name)).catch(() => undefined);
        await fs.removeDir(target).catch(() => undefined);
      } catch {
        // As for install: the check says what is left.
      }
      return checkNow();
    }),
    enableAll: () => serial(async () => {
      await run("gsettings", ["set", "org.gnome.shell", "disable-user-extensions", "false"]).catch(() => undefined);
      return checkNow();
    }),
    async logOut() {
      await run("gnome-session-quit", ["--logout"]);
    },
    readerRefused: (refused) => serial(async () => {
      if (!refused) {
        refusals = 0;
      } else {
        refusals += 1;
        if (refusals === 1) deps.restartReader();
      }
      return checkNow();
    }),
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}

/** Where GNOME keeps this user's extensions: `$XDG_DATA_HOME` when it is an absolute path, else `~/.local/share`. */
export function extensionDataHome(env: NodeJS.ProcessEnv, home: string): string {
  const named = env.XDG_DATA_HOME;
  return named !== undefined && isAbsolute(named) ? named : join(home, ".local", "share");
}

/** How long any one of GNOME's commands may take before its answer counts as none. */
const COMMAND_TIMEOUT_MS = 5000;

/** The real commands: never throws; a failure to start is a non-zero code. */
export const runCommand: Run = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], {timeout: COMMAND_TIMEOUT_MS, encoding: "utf8"}, (error, stdout) => {
    const code = error === null ? 0 : typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 1;
    resolve({code, stdout: String(stdout ?? "")});
  });
});

/**
 * The real files. A write goes to a new, unguessable name in the same folder, created exclusively
 * (so nothing planted there can be written through), is given its mode, and replaces the old file by
 * a rename (which replaces a symlink itself, never what it points at). A failed write leaves nothing.
 */
export const extensionFs: ExtensionFs = {
  read: (path) => readFile(path, "utf8"),
  async mode(path) {
    try {
      const stat = await lstat(path);
      return {regular: stat.isFile(), mode: stat.mode & 0o777, uid: stat.uid};
    } catch {
      return null;
    }
  },
  async write(path, data, mode) {
    const temporary = `${path}.clave-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temporary, data, {mode, flag: "wx"});
      await chmod(temporary, mode);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, {force: true}).catch(() => undefined);
      throw error;
    }
  },
  remove: (path) => rm(path, {force: true}),
  removeDir: (path) => rmdir(path),
  async makeDir(path) {
    await mkdir(path, {recursive: true, mode: 0o755});
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error("EXTENSION_DIR_NOT_A_DIRECTORY");
    await chmod(path, 0o755);
  },
  realpath: (path) => realpath(path)
};
