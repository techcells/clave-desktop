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
import type {WindowBox, WorkArea} from "./cases";
import {READY_SEPARATOR, READY_SIZE_END, READY_TOKEN} from "./stagedTitle";

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
export const PGREP = "/usr/bin/pgrep";

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
 * The same pattern, asked rather than acted on: is any process of THIS run's Chrome still alive?
 *
 * `pkill` sends a signal and returns at once; a Chrome that has been asked to quit takes a moment to
 * go, and the next staging's `open -na` lands in that moment. What happens then is not a slower
 * launch — it is a different launch: the new process finds the profile's singleton still held,
 * forwards its command line to the OLD process over the singleton socket and exits, and the old
 * process opens the window. Chromium decides that window's bounds in
 * `chrome/browser/ui/browser_window_state.cc`, which reads `base::CommandLine::ForCurrentProcess()`
 * — the command line of the process that is still running, which is the FIRST staging's, without
 * this staging's `--window-size`. And before that, `window_sizer.cc` prefers the last active
 * window's bounds to any saved placement, so every window after the first inherits the first one's
 * size whatever the profile says.
 *
 * That is the mechanism behind the first run's measurement: sixteen Chrome captures, every one of
 * them 1416 x 1768 px, none of them the staged 1268 x 708 pt — and eighteen stagings in 44 s, about
 * 2.5 s each, of which 2 s is the settle, which is not enough for a Chrome process to start but is
 * ample for a running one to open a window.
 *
 * So the run waits on this, bounded, before it opens the next window. `pgrep` matching nothing exits
 * 1, which is the answer we want; it can only ever match this run's own profile path.
 *
 * **A second hypothesis, left standing on purpose** (review B, Minor 7). The captured WIDTH of that
 * run, 708 pt, is exactly the staged HEIGHT of `1268 x 708` — so "the sizing process saw
 * `--window-size` and used only one of its two numbers" fits the measurement as well as "the flags
 * never reached it", and neither is proved by the results file alone. The same three fields settle
 * it in the next run without anybody arguing: `chromeWaitMs` says whether a previous Chrome was
 * still alive, `stageMs` says whether a process really started, and `sizeAsStaged` says whether the
 * window ended up the size it was asked for. No code chooses between the two hypotheses.
 */
export function chromeAliveCommand(profileDir: string): EvalCommand {
  return {program: PGREP, args: ["-f", chromeTeardownPattern(profileDir)]};
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
 *
 * **`browser.window_placement` is written here too, in every variant, since 2026-09-20.** It is the
 * mechanism Chrome itself uses to put a window back where it was — `window_sizer.cc` reads the
 * dictionary from the profile's own preferences (`left`, `top`, `right`, `bottom`, `maximized`, and
 * the `work_area_` prefixed four) and uses it for a new window when there is no last active window
 * to copy — so it is the one lever that does not depend on a command line reaching the process that
 * actually opens the window. The command-line flags are still passed as well, and the run still
 * waits for the previous Chrome to be gone (`chromeAliveCommand`): the three cover the three
 * different ways the first run's staged size could have been lost, and `sizeAsStaged` in the results
 * says whether they worked, per repetition, whatever happens.
 */
export function chromePreferences(
  variant: ChromeVariant,
  placement?: {bounds: WindowBox; workArea: WorkArea | null}
): Record<string, unknown> {
  const bar = variant === "bookmarks-bar" ? {bookmark_bar: {show_on_all_tabs: true}} : {};
  if (placement === undefined) return bar;
  const {bounds, workArea} = placement;
  return {
    ...bar,
    browser: {
      window_placement: {
        left: bounds.xPt,
        top: bounds.yPt,
        right: bounds.xPt + bounds.widthPt,
        bottom: bounds.yPt + bounds.heightPt,
        // Never `true`: a maximized window is whatever size the display makes it, which is the one
        // thing a run that records its window size must not accept.
        maximized: false,
        // The work area the placement was computed against. Chrome compares it with the display's
        // current one and adjusts a window that would no longer fit; written from what the display
        // actually reported, so the comparison is against the truth rather than against our guess.
        ...(workArea === null ? {} : {
          work_area_left: workArea.xPt,
          work_area_top: workArea.yPt,
          work_area_right: workArea.xPt + workArea.widthPt,
          work_area_bottom: workArea.yPt + workArea.heightPt
        })
      }
    }
  };
}

/**
 * How far a capture may be from the staged size and still count as staged, in PIXELS.
 *
 * Not zero: a window's captured bitmap is the window server's, and a point size multiplied by a
 * scale need not land on the same integer the compositor chose. Small, because the failure this
 * number exists to catch was 1416 x 1768 px against a staged 1268 x 708 pt — off by hundreds, in
 * both directions, in every one of sixteen captures.
 */
export const SIZE_TOLERANCE_PX = 4;

/** The display scales a capture is compared at: 1x, 2x (Retina), and 3x for a display nobody here has. */
export const CAPTURE_SCALES: readonly number[] = [1, 2, 3];

/**
 * Was the window captured at the size it was staged at, and at what scale?
 *
 * The helper reports no scale — `stats_value` in `native/reader/src/protocol.rs` writes `bandPx`,
 * `captureMs`, `recogniseMs`, `cacheHit`, `width` and `height`, and nothing else — so the scale here
 * is INFERRED: the one integer factor at which both staged points land on the captured pixels,
 * within `SIZE_TOLERANCE_PX`. On the built-in 2x panel a staged 1160 x 640 pt window is 2320 x 1280
 * px; on a 1x display it is 1160 x 640 px. Anything that fits neither has `scale: null` and
 * `sizeAsStaged: false`, which is what the first run's captures would have said had the field
 * existed (1416 x 1768 px is not 1268 x 708 pt at 1x, 2x or 3x).
 *
 * `null` for both when there is nothing to compare: a repetition that never read, or a Terminal
 * window, which is staged in CELLS and has no point size to check against (see `readySizeToken` for
 * how that one is answered instead).
 *
 * **`displayScale` decides when the bundle knows it** (review B, Minor 3). Electron's `Display`
 * carries `scaleFactor`, and `main.ts` is already asking that same display for its `workArea`, so
 * inferring the scale was answering a question we can simply ask. Two things change when the real
 * number is passed: a window that happens to be an exact integer multiple of the staged points can
 * no longer be read as "as staged at that multiple", and a fractional-scale display (1.5x) is
 * measured honestly instead of failing every case closed. The inferred scale is still computed and
 * still recorded, as the cross-check: the two disagreeing is itself a finding.
 */
export function capturedSize(
  captured: {widthPx: number | null; heightPx: number | null},
  // A whole `StagedSize` is welcome and its cells are ignored: a Terminal staging has no point size,
  // which is why it answers `null` here and is judged by the size its own shell reported instead.
  staged: {widthPt: number | null; heightPt: number | null; columns?: number | null; rows?: number | null},
  displayScale?: number | null
): {scale: number | null; sizeAsStaged: boolean | null} {
  const {widthPx, heightPx} = captured;
  const {widthPt, heightPt} = staged;
  if (widthPx === null || heightPx === null || widthPt === null || heightPt === null) {
    return {scale: null, sizeAsStaged: null};
  }
  const close = (px: number, pt: number, scale: number): boolean => Math.abs(px - pt * scale) <= SIZE_TOLERANCE_PX;
  const scale = CAPTURE_SCALES.find((candidate) => close(widthPx, widthPt, candidate) && close(heightPx, heightPt, candidate)) ?? null;
  const known = typeof displayScale === "number" && Number.isFinite(displayScale) && displayScale > 0;
  const asStaged = known
    ? close(widthPx, widthPt, displayScale as number) && close(heightPx, heightPt, displayScale as number)
    : scale !== null;
  return {scale, sizeAsStaged: asStaged};
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
/**
 * The line separator of the generated script, from its code point rather than as an escape — the
 * rule the whole of this file lives under (`bytes.test.ts`): an escape in a source file of this
 * harness has twice come back from the tooling as the raw byte it names, and a raw byte inside the
 * one module that builds the shell command run on the owner's machine is invisible to `grep`.
 */
const NEWLINE = String.fromCharCode(10);

/** How long the staged shell holds the window before it exits. Long enough for the guard plus two reads. */
export const TERMINAL_HOLD_SECONDS = 40;

/**
 * How long the staged shell waits before it asks for its size, and again before it asks a second
 * time.
 *
 * Terminal.app applies a profile's own window size while the window is still being created, and an
 * `ESC [ 8 ; rows ; cols t` that arrives during that moment is lost — the shell is running before
 * the window has settled. The first run against a screen is consistent with exactly that: the two
 * terminal captures came back 1406 x 1754 px and 1426 x 880 px, which are neither equal (as they
 * would be if both were the profile default) nor in the 140 : 72 ratio of what was asked for.
 *
 * So the sequence is printed late and printed twice. This needs no permission of any kind, which is
 * the whole reason it is the chosen repair: a `.terminal` settings file would have to be imported
 * into the owner's Terminal, and AppleScript would need an Automation grant — a screen-reading
 * evaluation asking for a second kind of control over the machine is not a trade worth making for a
 * window size (see the note on `terminalScript`). Whether it worked is recorded either way, by the
 * shell itself, in the title: see `readySizeToken`.
 */
export const TERMINAL_RESIZE_DELAY_SECONDS = 0.4;

/**
 * How many times the staged shell asks the tty for its size before giving up, and how long it waits
 * between asks: 15 x 0.2 s = 3 s at the outside, on top of the two resize delays.
 *
 * Bounded, and giving up is not a failure: the shell prints the text and the READY title with
 * whatever the last answer was, the harness reads the window, scores it, records the two numbers and
 * marks the case incomplete because the size is not the staged one. A wait that could not end would
 * trade a measured wrong size for no measurement at all, in a session the owner is sitting through.
 */
export const TERMINAL_SIZE_TRIES = 15;
export const TERMINAL_SIZE_POLL_SECONDS = 0.2;

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
 *
 * **Wrapping, and why nothing here "fixes" it.** `terminal.txt` is 12 lines whose longest is 66
 * characters, so a window of the staged 72 columns does not wrap it at all, and a window of 140
 * certainly does not — the narrow case differs by the WINDOW, not by the wrapping, which is worth
 * knowing before anybody reads its number as a wrapping measurement. If a narrower window than the
 * one asked for does wrap a line, that is expected and is not an error: the scorer normalises runs
 * of whitespace — newlines included — to one space before it compares (`norm` in `score.ts`), so a
 * wrapped line and an unwrapped one score identically against the same truth. The markers are the
 * part that must not wrap or scroll away, which is why they are printed on lines of their own into a
 * freshly cleared screen and buffer, 14 lines into a window asked for 30 rows.
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
  // The truth is inserted at a LINE START, so a delimiter at offset 0 ends the heredoc at once
  // and everything after it becomes shell commands. Testing a leading newline in front of the
  // truth closes that hole without changing what is written (review B, Minor 5).
  if ((`\n${truth}`).includes(`\n${TRUTH_DELIMITER}\n`)) throw new Error("EVAL_TRUTH_DELIMITER");
  const body = truth.endsWith("\n") ? truth : `${truth}\n`;
  return [
    "#!/bin/bash",
    // Run this file in a shell of KNOWN shape, whatever opened it.
    //
    // Two reaches exist and both are the owner's own environment (review B, Minor 8). LaunchServices
    // may hand the file to the owner's login shell rather than honouring the shebang, and even under
    // bash, `BASH_ENV` is sourced for a non-interactive shell while an exported `SHELLOPTS` applies
    // its options at start-up — an `errexit` there would abort this script before READY. Neither can
    // make the harness read a window it did not stage, but both can make a staged window behave
    // differently on one machine than on another, in a run whose whole purpose is a measurement.
    //
    // `env -i` is the answer rather than `unset`: `SHELLOPTS` and `BASHOPTS` are READONLY in bash, so
    // unsetting them fails (and under `errexit` that failure is itself the abort). A fresh
    // environment with three variables and `--noprofile --norc` leaves nothing to source and nothing
    // to inherit. `TERM` is pinned rather than passed through, so `tput` answers from a terminfo
    // entry this harness chose; `PATH` is pinned so `clear`, `tput`, `cat` and `sleep` are the
    // system's. The guard variable makes the re-exec happen exactly once.
    // The flag is compared with the value this harness sets, not merely tested for emptiness, and
    // `--` ends bash's option parsing so a path that began with a dash could never be read as one.
    "if [ \"$CLAVE_EVAL_CLEAN\" != \"1\" ]; then",
    "  exec /usr/bin/env -i CLAVE_EVAL_CLEAN=1 TERM=xterm-256color PATH=/usr/bin:/bin " +
      "/bin/bash --noprofile --norc -- \"$0\"",
    "fi",
    // The title FIRST, and without the READY token. The window becomes identifiable at once — to the
    // owner watching it, and to any future staging question about which window this is — while the
    // token that says "the text has been printed" cannot appear until that is true.
    `printf '%s' '${ESC}]0;${title}${BEL}'`,
    // Late, and twice: see TERMINAL_RESIZE_DELAY_SECONDS. A sequence that arrives while Terminal is
    // still building the window is dropped, and the second one is what makes that survivable.
    `sleep ${TERMINAL_RESIZE_DELAY_SECONDS}`,
    `printf '%s' '${ESC}[8;${rows};${columns}t'`,
    `sleep ${TERMINAL_RESIZE_DELAY_SECONDS}`,
    `printf '%s' '${ESC}[8;${rows};${columns}t'`,
    // Wait for the resize to ARRIVE, rather than assuming a fixed delay did it.
    //
    // Terminal resizes the window and the tty asynchronously (window manager, then `TIOCSWINSZ` and
    // `SIGWINCH` to the shell), and the first staged run showed the cost of guessing: both terminal
    // cases reported a size that was not the staged one although the captures looked right. So the
    // shell asks until the answer is the size that was asked for, bounded, and then prints — the
    // text is laid out at the final size, and the READY title carries whatever the last answer was,
    // matching or not. A window that never resizes costs the bound and is then reported honestly.
    //
    // **`stty size` and not `tput cols`.** `tput` is run here inside a command substitution, so its
    // stdout is a PIPE, not the tty: ncurses asks `TIOCGWINSZ` on that fd, the ioctl fails, and it
    // falls back to the terminfo entry's static 80 x 24 — and `env -i` has (rightly) removed the
    // `COLUMNS`/`LINES` that would otherwise have covered for it. That is the most likely reading of
    // the first run's two false negatives. `stty size` takes its ioctl from stdin, which is given
    // `/dev/tty` explicitly, so the substitution's pipe cannot reach it. `tput` stays as the last
    // resort for a shell where `/dev/tty` is not there, with its caveat: a fallback answer of
    // exactly 80 x 24 is the signature of this failure, and the results now record the numbers.
    `sleep ${TERMINAL_RESIZE_DELAY_SECONDS}`,
    "CLAVE_COLS=",
    "CLAVE_ROWS=",
    "CLAVE_TRY=0",
    `while [ "$CLAVE_TRY" -lt ${TERMINAL_SIZE_TRIES} ]; do`,
    // `2>/dev/null` FIRST: redirections are applied left to right, so with the order reversed a
    // `/dev/tty` that is not there is reported by BASH, before stderr has been silenced — fifteen
    // error lines into the owner's window. Nothing reaches the capture (the poll runs before `clear`
    // and the scrollback drop), but it is one reordering away from doing so (review C, Minor 1).
    "  CLAVE_SIZE=$(stty size 2>/dev/null < /dev/tty)",
    "  set -- $CLAVE_SIZE",
    "  CLAVE_ROWS=$1",
    "  CLAVE_COLS=$2",
    `  if [ "$CLAVE_COLS" = "${columns}" ] && [ "$CLAVE_ROWS" = "${rows}" ]; then break; fi`,
    "  CLAVE_TRY=$((CLAVE_TRY + 1))",
    `  sleep ${TERMINAL_SIZE_POLL_SECONDS}`,
    "done",
    "if [ -z \"$CLAVE_COLS\" ]; then",
    "  CLAVE_COLS=$(tput cols 2>/dev/null)",
    "  CLAVE_ROWS=$(tput lines 2>/dev/null)",
    "fi",
    // The screen and then the SCROLLBACK. `clear` homes the cursor and blanks what is visible; the
    // lines above the window stay in the buffer, where a resize or a scroll can bring them back into
    // the capture — and this window must hold this staging's text and nothing else, including
    // nothing of the shell's own start-up. ESC [ 3 J drops the buffer, after `clear` so that what
    // `clear` pushed up goes with it.
    "clear",
    `printf '%s' '${ESC}[3J'`,
    "echo STARTMARKER",
    `cat <<'${TRUTH_DELIMITER}'`,
    body + TRUTH_DELIMITER,
    "echo ENDMARKER",
    // Printing is over, so the title now gains the READY token the guard waits for — and after it,
    // the size the shell measured above. Those two numbers are the only way this harness can learn
    // whether the resize was honoured without anybody looking at a screen, and they come from the
    // shell's own view of its window rather than from a capture. Both empty — no `/dev/tty` and no
    // `tput` — prints `READY x.`, which reads back as two `null`s and as "not as staged": the run is
    // still read and still scored, and the case is incomplete, which is the honest report of a
    // window whose size is unknown.
    `printf '%s%sx%s%s' '${ESC}]0;${title}${READY_TOKEN}${READY_SEPARATOR}' "$CLAVE_COLS" "$CLAVE_ROWS" '${READY_SIZE_END}${BEL}'`,
    `sleep ${holdSeconds}`,
    "exit 0",
    ""
  ].join(NEWLINE);
}

export function terminalStageCommand(scriptPath: string): EvalCommand {
  return {program: OPEN, args: [scriptPath]};
}
