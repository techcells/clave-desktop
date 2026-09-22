/**
 * How a window is staged, as DATA.
 *
 * Every command this harness would run is built here, by a pure function, and returned rather than
 * executed, so the exact argument list can be asserted in a unit test on a machine with no screen.
 * The one that matters most is the teardown: it kills only processes whose command line contains
 * this run's own `--user-data-dir=`, never "Google Chrome", because the owner's browser is open on
 * the same machine and a loose pattern would close it. Phase 0 ran the same way and recorded it
 * (findings, "Pre-flight rule correction"); here the pattern is a tested value instead of a line in
 * a throwaway shell script.
 *
 * Nothing here runs anything. `main.ts` is the only file that does.
 */
import {join} from "node:path";
import type {PageName} from "./pages";
import type {WindowBox} from "./cases";

export interface EvalCommand {
  program: string;
  args: readonly string[];
}

/**
 * Where one run's Chrome profile and generated `.command` files go: a folder of that run's own,
 * under the OS temp directory, deleted when the run ends.
 *
 * Not `app/reader-eval/out/`, where the results JSON lives. That folder is inside the checkout on
 * purpose — the results have to be readable by an agent that may not open the dev data folder, and
 * they are numbers, booleans and fixed case names. A Chrome profile is not ours at all: Chrome
 * writes it, and it holds absolute paths carrying the macOS user's name (the default download
 * directory, for one) along with machine-specific state. There is no ignore file of any kind in this
 * repo, and both the plan's and the ledger's "copy `app/` without node_modules, dist, target"
 * recipes would carry the whole profile into every scratch copy and payload the moment one exists.
 *
 * Per run, not per machine: two runs must never share a profile, and the teardown pattern is built
 * from this exact path, so one run's `pkill` can only ever match its own windows.
 */
export function evalScratchPaths(tmpDir: string, runId: string): {dir: string; profileDir: string} {
  const dir = join(tmpDir, `clave-reader-eval-${runId}`);
  return {dir, profileDir: join(dir, "chrome-profile")};
}

/** Which extra toolbar furniture the staged Chrome shows. `none` is phase 0's default profile. */
export type ChromeVariant = "none" | "bookmarks-bar";
export const CHROME_VARIANTS: readonly ChromeVariant[] = ["none", "bookmarks-bar"];

export const OPEN = "/usr/bin/open";
export const PKILL = "/usr/bin/pkill";

/**
 * A second Chrome instance, in a profile directory of this harness's own, at a fixed size and place.
 *
 * `-n` is what makes it a new instance rather than a message to the running one; `--user-data-dir`
 * is what makes that instance's windows identifiable later; `--no-first-run` and
 * `--no-default-browser-check` keep the first-run surfaces out of the capture — phase 0 listed both
 * of those as staging-failure conditions.
 */
export function chromeStageCommand(options: {
  profileDir: string;
  incognito: boolean;
  window: WindowBox;
  url: string;
}): EvalCommand {
  const {profileDir, incognito, window, url} = options;
  return {
    program: OPEN,
    args: [
      "-na", "Google Chrome", "--args",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(incognito ? ["--incognito"] : []),
      "--new-window",
      `--window-size=${window.widthPt},${window.heightPt}`,
      `--window-position=${window.xPt},${window.yPt}`,
      url
    ]
  };
}

/** Extended-regex metacharacters, escaped so a profile path is matched literally by `pkill -f`. */
function escapeEre(value: string): string {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, (character) => `\\${character}`);
}

/**
 * The only pattern this harness ever kills on: the whole `--user-data-dir=` flag with THIS run's
 * profile path, matched literally.
 *
 * The leading `--` is written as the character class `[-]` for two reasons, both real: a pattern
 * beginning with a dash would be eaten by `pkill`'s own option parsing, and a bracket expression
 * cannot match `pkill`'s own command line the way a plain substring of it could.
 */
export function chromeTeardownPattern(profileDir: string): string {
  return `[-]-user-data-dir=${escapeEre(profileDir)}`;
}

export function chromeTeardownCommand(profileDir: string): EvalCommand {
  return {program: PKILL, args: ["-f", chromeTeardownPattern(profileDir)]};
}

/**
 * The profile preferences written before launch, into the harness's OWN profile directory
 * (`<profile>/Default/Preferences`) and never anywhere else.
 *
 * This is the mechanism behind carried item 30: "a bookmarks bar, an extensions row, a side panel, a
 * tab group strip or a theme pushes Chrome's content down; the 82 pt band then holds the wrong strip
 * and the Incognito badge can fall OUTSIDE it — in which case a private Chrome window is KEPT". The
 * bookmarks bar is the one of those five that a fresh profile can be told to show with a single
 * setting, so it is the one offered here. The others need an extension or a theme to be installed,
 * which this harness does not do; they stay on the list as unmeasured.
 *
 * Default is `none`, so an ordinary run stays comparable with phase 0's default-profile numbers.
 */
export function chromePreferences(variant: ChromeVariant): Record<string, unknown> {
  return variant === "bookmarks-bar" ? {bookmark_bar: {show_on_all_tabs: true}} : {};
}

/** Where those preferences go, relative to the profile directory. */
export const CHROME_PREFERENCES_PATH = ["Default", "Preferences"] as const;

/** The URL of one staged page. `host` is `127.0.0.1` for the accuracy cases and a `*.localhost` name for the toolbar ones. */
export function pageUrl(options: {
  host: string;
  port: number;
  page: PageName;
  theme: string;
  sizePx: number;
  stagedTitle: string;
}): string {
  const {host, port, page, theme, sizePx, stagedTitle} = options;
  const query = new URLSearchParams({theme, size: String(sizePx), stagedTitle});
  return `http://${host}:${port}/${page}.html?${query.toString()}`;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** How long the staged shell holds the window before it exits. Long enough for the guard plus two reads. */
export const TERMINAL_HOLD_SECONDS = 40;

/** A `.command` file must be executable for LaunchServices to open it in Terminal. */
export const TERMINAL_SCRIPT_MODE = 0o755;

/**
 * What may never appear in a staged title: a single quote, which would end the quoted string the
 * title goes into, or any control character, which could carry its own escape sequence into the
 * terminal.
 *
 * Spelled as escapes inside a string rather than written as a regex literal holding the characters:
 * this file once held the literal NUL and U+001F, which made it `data` to `file(1)` and invisible
 * to `grep` -- in the one module that builds the shell command run on the owner's machine.
 * `bytes.test.ts` holds the rule.
 */
const TITLE_UNSAFE = new RegExp("['\\u0000-\\u001F]");

/** The heredoc delimiter. Quoted at the opening, so the shell expands nothing inside the truth. */
const TRUTH_DELIMITER = "CLAVE_EVAL_TRUTH";

/**
 * The staged Terminal window, as a `.command` file.
 *
 * No AppleScript anywhere in this harness: driving Terminal that way needs an Automation grant, and
 * a screen-reading evaluation asking for a second kind of control over the machine is not a trade
 * worth making for a window size. The xterm control sequences do the same job with no grant at all:
 * `ESC [ 8 ; rows ; cols t` resizes and `ESC ] 0 ; title BEL` renames, and both are built from
 * character codes rather than typed, because an escape written as a literal is exactly the kind of
 * byte a copy through three tools turns into something else.
 *
 * The truth is printed from a quoted heredoc so nothing in it is expanded — `terminal.txt` contains
 * `$ pnpm`, backticks and `|`, all of which a shell would otherwise act on.
 */
export function terminalScript(options: {
  columns: number;
  rows: number;
  title: string;
  truth: string;
  holdSeconds?: number;
}): string {
  const {columns, rows, title, truth} = options;
  const holdSeconds = options.holdSeconds ?? TERMINAL_HOLD_SECONDS;
  // The title is this harness's own (`CLAVE-EVAL <case> <nonce>`) and goes inside single quotes; a
  // quote or a control character in it would end the string and run whatever followed. It cannot
  // happen from our own callers, so it is a throw rather than an escape: quietly rewriting a staged
  // title would break the guard that depends on it being exactly what was asked for.
  if (TITLE_UNSAFE.test(title)) throw new Error("EVAL_TITLE_UNSAFE");
  if (truth.includes(`\n${TRUTH_DELIMITER}\n`)) throw new Error("EVAL_TRUTH_DELIMITER");
  const body = truth.endsWith("\n") ? truth : `${truth}\n`;
  return [
    "#!/bin/bash",
    `printf '%s' '${ESC}[8;${rows};${columns}t'`,
    `printf '%s' '${ESC}]0;${title}${BEL}'`,
    "clear",
    "echo STARTMARKER",
    `cat <<'${TRUTH_DELIMITER}'`,
    body + TRUTH_DELIMITER,
    "echo ENDMARKER",
    `sleep ${holdSeconds}`,
    "exit 0",
    ""
  ].join("\n");
}

export function terminalStageCommand(scriptPath: string): EvalCommand {
  return {program: OPEN, args: [scriptPath]};
}
