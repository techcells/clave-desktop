import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {BROWSER_WINDOW, TOOLBAR_CASES} from "./cases";
import {
  CAPTURE_SCALES,
  SIZE_TOLERANCE_PX,
  capturedSize,
  chromeAliveCommand,
  chromePreferences,
  chromeStageCommand,
  chromeTeardownCommand,
  chromeTeardownPattern,
  evalScratchPaths,
  pageUrl,
  terminalScript,
  terminalStageCommand
} from "./stage";
import {approve} from "./guard";
import {acceptStagedTitle} from "./pages";
import {READY_SIZE_END, READY_SIZE_MAX, READY_TOKEN, readyMark, readySizeIn, readySizeToken, readyTitleFor, stagedTitleFor} from "./stagedTitle";

const TMP = "/var/folders/ab/cd1_23/T";
const profileDir = `${TMP}/clave-reader-eval-a1b2c3d4e5f6/chrome-profile`;
const url = "http://127.0.0.1:51234/chat.html?theme=light&size=14";

/**
 * Where a run's own scratch goes, and why it is not the repo. A Chrome profile is written by Chrome,
 * not by this harness: it holds absolute paths carrying the macOS user's name and a pile of
 * machine-specific state. Under `app/reader-eval/out/` — inside the checkout, with no ignore file of
 * any kind — the first copy of `app/` into a scratch folder or a payload would carry all of it along.
 * The results JSON, which is numbers and fixed case names, stays where it is so it can be read.
 */
describe("where a run's Chrome profile and generated scripts go", () => {
  it("is a folder of this run's own, under the OS temp directory", () => {
    const {dir, profileDir: profile} = evalScratchPaths(TMP, "a1b2c3d4e5f6");
    // Joined as the function joins them: the same strings on macOS, backslashed on Windows.
    expect(dir).toBe(join(TMP, "clave-reader-eval-a1b2c3d4e5f6"));
    expect(profile).toBe(join(dir, "chrome-profile"));
    expect(evalScratchPaths(TMP, "ffffffffffff").dir).not.toBe(dir);   // per run, not per machine
  });

  it("is nowhere inside the repo, whatever the real temp directory turns out to be", () => {
    const {dir} = evalScratchPaths(tmpdir(), "a1b2c3d4e5f6");
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).not.toContain("reader-eval/out");
    expect(dir).not.toContain("/app/");
  });

  it("is still torn down by a pattern that matches that profile and no other", () => {
    const mine = evalScratchPaths(TMP, "a1b2c3d4e5f6").profileDir;
    const someoneElses = evalScratchPaths(TMP, "ffffffffffff").profileDir;
    const pattern = new RegExp(chromeTeardownPattern(mine));
    expect(pattern.test(`Google Chrome --user-data-dir=${mine} --new-window`)).toBe(true);
    expect(pattern.test(`Google Chrome --user-data-dir=${someoneElses} --new-window`)).toBe(false);
    expect(pattern.test(`Google Chrome --user-data-dir=${TMP} --new-window`)).toBe(false);
  });
});

describe("staging Chrome", () => {
  it("is a second instance, in the harness's own profile, at the recorded size and place", () => {
    const command = chromeStageCommand({profileDir, incognito: false, window: BROWSER_WINDOW, url});
    expect(command.program).toBe("/usr/bin/open");
    expect(command.args).toEqual([
      "-na", "Google Chrome", "--args",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "--window-size=1160,640",
      "--window-position=40,60",
      url
    ]);
  });

  it("adds --incognito only when asked", () => {
    expect(chromeStageCommand({profileDir, incognito: true, window: BROWSER_WINDOW, url}).args).toContain("--incognito");
    expect(chromeStageCommand({profileDir, incognito: false, window: BROWSER_WINDOW, url}).args).not.toContain("--incognito");
  });
});

describe("tearing it down again", () => {
  /**
   * The owner's own Chrome is open on this machine while the evaluation runs. A pattern that matched
   * "Google Chrome" would close their windows; phase 0 ran with the same narrow rule and recorded
   * that the only process it ever killed was one matching its own `--user-data-dir=`.
   */
  const ownersChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --no-startup-window";
  const anotherProfile = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/somewhere/else --new-window";
  const ours = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDir} --new-window`;

  it("matches only a command line carrying this run's own profile flag", () => {
    const pattern = new RegExp(chromeTeardownPattern(profileDir));
    expect(pattern.test(ours)).toBe(true);
    expect(pattern.test(ownersChrome)).toBe(false);
    expect(pattern.test(anotherProfile)).toBe(false);
  });

  it("carries the whole flag, not just the path", () => {
    expect(chromeTeardownPattern(profileDir)).toContain("-user-data-dir=");
    expect(chromeTeardownPattern(profileDir)).toContain(profileDir);
  });

  it("escapes regex metacharacters in the path, so a dot is a dot", () => {
    const pattern = new RegExp(chromeTeardownPattern("/a.b/c+d"));
    expect(pattern.test("chrome --user-data-dir=/a.b/c+d")).toBe(true);
    expect(pattern.test("chrome --user-data-dir=/axb/cd")).toBe(false);
  });

  it("does not begin with a dash, which pkill would eat as an option", () => {
    expect(chromeTeardownPattern(profileDir).startsWith("-")).toBe(false);
  });

  it("is passed to pkill with -f", () => {
    expect(chromeTeardownCommand(profileDir)).toEqual({
      program: "/usr/bin/pkill",
      args: ["-f", chromeTeardownPattern(profileDir)]
    });
  });
});

describe("the bookmarks-bar variant", () => {
  it("is off by default, so an ordinary run stays comparable with phase 0", () => {
    expect(chromePreferences("none")).toEqual({});
  });

  it("asks Chrome to show the bookmarks bar on all tabs", () => {
    expect(chromePreferences("bookmarks-bar")).toEqual({bookmark_bar: {show_on_all_tabs: true}});
  });
});

describe("the staged page's URL", () => {
  it("carries theme, size and the staged title", () => {
    const built = pageUrl({
      host: "mybank.example.localhost", port: 51234, page: "ticket",
      theme: "dark", sizePx: 11, stagedTitle: "CLAVE-EVAL ticket-dark-11 abc123"
    });
    expect(built).toBe(
      "http://mybank.example.localhost:51234/ticket.html?theme=dark&size=11&stagedTitle=CLAVE-EVAL+ticket-dark-11+abc123"
    );
  });
});

describe("the staged Terminal window", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const script = terminalScript({columns: 140, rows: 40, title: "CLAVE-EVAL terminal abc123", truth: "line one\nline two\n"});

  it("resizes with the xterm sequence, rows before columns", () => {
    expect(script).toContain(`${ESC}[8;40;140t`);
  });

  it("names the window with the staged title", () => {
    expect(script).toContain(`${ESC}]0;CLAVE-EVAL terminal abc123${BEL}`);
  });

  it("clears, prints the markers around the truth, then holds the window", () => {
    const order = ["stty size", "clear", "echo STARTMARKER", "line one", "echo ENDMARKER", "READY "];
    let at = -1;
    for (const part of order) {
      const found = script.indexOf(part);
      expect(found, part).toBeGreaterThan(at);
      at = found;
    }
  });

  it("prints the truth from a quoted heredoc, so the shell expands nothing in it", () => {
    const withShellSyntax = terminalScript({
      columns: 72, rows: 40, title: "CLAVE-EVAL terminal-narrow abc123",
      truth: "$ pnpm --dir app test\n`whoami` | wc -l\n"
    });
    expect(withShellSyntax).toContain("cat <<'CLAVE_EVAL_TRUTH'");
    expect(withShellSyntax).toContain("$ pnpm --dir app test");
    expect(withShellSyntax).toContain("`whoami` | wc -l");
  });

  it("refuses a title that could end the shell string it goes into", () => {
    expect(() => terminalScript({columns: 80, rows: 40, title: "CLAVE-EVAL x'; rm -rf /; echo '", truth: "x"}))
      .toThrow("EVAL_TITLE_UNSAFE");
  });

  it("refuses a truth that contains the heredoc's own delimiter", () => {
    expect(() => terminalScript({columns: 80, rows: 40, title: "CLAVE-EVAL x 1", truth: "a\nCLAVE_EVAL_TRUTH\nb"}))
      .toThrow("EVAL_TRUTH_DELIMITER");
  });

  it("is opened through LaunchServices, like every other staging", () => {
    expect(terminalStageCommand("/out/terminal.command")).toEqual({program: "/usr/bin/open", args: ["/out/terminal.command"]});
  });
});
/**
 * Why the run waits at all: `pkill` signals and returns, and Chromium decides a new window's bounds
 * from `CommandLine::ForCurrentProcess()` — the still-running process's command line, not the one
 * this staging just passed — and prefers the last active window's bounds to any saved placement.
 * So a staging that lands while the previous Chrome is still alive is a staging whose size flags
 * nothing ever reads.
 */
describe("waiting for the previous staged Chrome", () => {
  it("asks pgrep, with exactly the teardown pattern and nothing looser", () => {
    expect(chromeAliveCommand(profileDir)).toEqual({
      program: "/usr/bin/pgrep",
      args: ["-f", chromeTeardownPattern(profileDir)]
    });
  });

  it("can only ever match this run's own profile", () => {
    const pattern = new RegExp(chromeAliveCommand(profileDir).args[1] as string);
    expect(pattern.test(`Google Chrome --user-data-dir=${profileDir} --new-window`)).toBe(true);
    expect(pattern.test("Google Chrome")).toBe(false);
    expect(pattern.test(`Google Chrome --user-data-dir=${TMP}/somebody-elses/chrome-profile`)).toBe(false);
  });
});

describe("the staged profile's window placement", () => {
  const placement = {bounds: BROWSER_WINDOW, workArea: {xPt: 0, yPt: 25, widthPt: 1280, heightPt: 775}};
  const written = (variant: "none" | "bookmarks-bar"): Record<string, Record<string, Record<string, unknown>>> =>
    chromePreferences(variant, placement) as Record<string, Record<string, Record<string, unknown>>>;

  it("writes the staged box as the corners Chrome reads", () => {
    expect(written("none").browser?.window_placement).toEqual({
      left: 40, top: 60, right: 1200, bottom: 700, maximized: false,
      work_area_left: 0, work_area_top: 25, work_area_right: 1280, work_area_bottom: 800
    });
  });

  it("never asks for a maximized window, whose size the display would decide", () => {
    expect(written("none").browser?.window_placement?.maximized).toBe(false);
  });

  it("leaves out the work area when nobody could say what it was", () => {
    const keys = Object.keys(chromePreferences("none", {bounds: BROWSER_WINDOW, workArea: null}).browser as object);
    expect(keys).toEqual(["window_placement"]);
    const bounds = (chromePreferences("none", {bounds: BROWSER_WINDOW, workArea: null}) as Record<string, Record<string, Record<string, unknown>>>);
    expect(Object.keys(bounds.browser?.window_placement ?? {})).toEqual(["left", "top", "right", "bottom", "maximized"]);
  });

  /** The two live in one file: a merge written the obvious way drops whichever was written second. */
  it("carries the bookmarks bar and the placement together", () => {
    expect(written("bookmarks-bar")).toMatchObject({
      bookmark_bar: {show_on_all_tabs: true},
      browser: {window_placement: {left: 40, top: 60}}
    });
  });

  it("still writes nothing at all when no placement is asked for", () => {
    expect(chromePreferences("none")).toEqual({});
    expect(chromePreferences("bookmarks-bar")).toEqual({bookmark_bar: {show_on_all_tabs: true}});
  });
});

describe("was the window captured at the size it was staged at", () => {
  const staged = {widthPt: 1160, heightPt: 640, columns: null, rows: null};

  it("is true at 1x on an ordinary display", () => {
    expect(capturedSize({widthPx: 1160, heightPx: 640}, staged)).toEqual({scale: 1, sizeAsStaged: true});
  });

  it("is true at 2x on the built-in Retina panel", () => {
    expect(capturedSize({widthPx: 2320, heightPx: 1280}, staged)).toEqual({scale: 2, sizeAsStaged: true});
  });

  it("allows the tolerance, and not a pixel more", () => {
    const edge = SIZE_TOLERANCE_PX;
    expect(capturedSize({widthPx: 2320 + edge, heightPx: 1280 - edge}, staged).sizeAsStaged).toBe(true);
    expect(capturedSize({widthPx: 2320 + edge + 1, heightPx: 1280}, staged)).toEqual({scale: null, sizeAsStaged: false});
  });

  /** The measurement this field was added for: the first run against a screen, 2026-09-20. */
  it("is false for the first run's captures against the size that run staged", () => {
    const phase = {widthPt: 1268, heightPt: 708, columns: null, rows: null};
    expect(capturedSize({widthPx: 1416, heightPx: 1768}, phase)).toEqual({scale: null, sizeAsStaged: false});
    expect(capturedSize({widthPx: 1406, heightPx: 1754}, phase).sizeAsStaged).toBe(false);
  });

  it("refuses to mix scales between the two dimensions", () => {
    expect(capturedSize({widthPx: 1160, heightPx: 1280}, staged)).toEqual({scale: null, sizeAsStaged: false});
  });

  it("says nothing at all when there is nothing to compare", () => {
    expect(capturedSize({widthPx: null, heightPx: null}, staged)).toEqual({scale: null, sizeAsStaged: null});
    expect(capturedSize({widthPx: 2320, heightPx: 1280}, {widthPt: null, heightPt: null, columns: 72, rows: 40}))
      .toEqual({scale: null, sizeAsStaged: null});
  });

  it("knows only whole scales, because a display has one", () => {
    expect(CAPTURE_SCALES.every((scale) => Number.isInteger(scale))).toBe(true);
  });
});

/**
 * The Terminal repairs of 2026-09-20, all four of them: the resize is late and repeated, the
 * scrollback is dropped as well as the screen, and the title gains a READY token with the size the
 * shell actually got only after ENDMARKER has been printed.
 */
describe("the staged Terminal window, repaired", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const title = "CLAVE-EVAL terminal abc123";
  const script = terminalScript({columns: 140, rows: 40, title, truth: "line one\nline two\n"});
  const resize = `${ESC}[8;40;140t`;

  it("asks for its size twice, both times after a wait", () => {
    const asks = script.split(resize).length - 1;
    expect(asks).toBe(2);
    const firstResize = script.indexOf(resize);
    const firstSleep = script.indexOf("sleep 0.4");
    expect(firstSleep).toBeGreaterThan(-1);
    expect(firstSleep).toBeLessThan(firstResize);
    expect(script.indexOf("sleep 0.4", firstResize)).toBeLessThan(script.lastIndexOf(resize));
  });

  it("names the window before it does anything else, without the ready token", () => {
    const named = script.indexOf(`${ESC}]0;${title}${BEL}`);
    expect(named).toBeGreaterThan(-1);
    expect(named).toBeLessThan(script.indexOf(resize));
    expect(named).toBeLessThan(script.indexOf(`${title}${READY_TOKEN}`));
  });

  it("drops the scrollback as well as the screen, before the markers", () => {
    const scrollback = script.indexOf(`${ESC}[3J`);
    expect(scrollback).toBeGreaterThan(script.indexOf("clear"));
    expect(scrollback).toBeLessThan(script.indexOf("echo STARTMARKER"));
  });

  it("says READY only after ENDMARKER, and with the size the shell measured", () => {
    const readyAt = script.indexOf(`${ESC}]0;${title}${READY_TOKEN} `);
    expect(readyAt).toBeGreaterThan(script.indexOf("echo ENDMARKER"));
    expect(script).toContain("CLAVE_COLS=$(tput cols");
    expect(script).toContain("CLAVE_ROWS=$(tput lines");
    expect(script).toContain('"$CLAVE_COLS" "$CLAVE_ROWS"');
  });

  /**
   * The title the shell prints and the title the harness waits for are built in two places; this is
   * the join. A staged 140x40 that really gets 140x40 prints exactly what `readyTitleFor` plus
   * `readySizeToken` compose, which is what `run.ts` tests the approved window's title against.
   */
  it("prints a title the harness's own grammar can compose", () => {
    const expected = `${readyTitleFor("terminal", "abc123")}${readySizeToken(140, 40)}`;
    expect(expected).toBe(`${title}${READY_TOKEN} 140x40.`);
    const printed = script.slice(script.indexOf(`${ESC}]0;${title}${READY_TOKEN} `));
    expect(printed).toContain(`${title}${READY_TOKEN} `);
  });

  it("still holds the window after all of it", () => {
    expect(script.lastIndexOf("sleep 40")).toBeGreaterThan(script.indexOf("echo ENDMARKER"));
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });
});
/** The repairs that came out of review B. */
describe("the staged Terminal window, hardened", () => {
  const ESC = String.fromCharCode(27);
  const title = "CLAVE-EVAL terminal abc123";
  const script = terminalScript({columns: 140, rows: 40, title, truth: "line one\nline two\n"});

  /**
   * Important 3: Terminal applies a resize asynchronously, so `tput` read immediately after it can
   * answer with the PRE-resize size — which would put a wrong size in the title and mark a perfectly
   * staged window incomplete.
   */
  it("settles before it asks the tty what size it got", () => {
    const lastResize = script.lastIndexOf(`${ESC}[8;40;140t`);
    const asked = script.indexOf("CLAVE_COLS=$(tput cols");
    const settle = script.lastIndexOf("sleep 0.4", asked);
    expect(settle).toBeGreaterThan(lastResize);
    expect(settle).toBeLessThan(asked);
    // three waits in all: two around the resizes, one before the reading
    expect(script.split("sleep 0.4").length - 1).toBe(3);
  });

  /** Minor 1: ` 140x40` is satisfied by ` 140x400`; the closing sentinel is what stops it. */
  it("closes the size token so a longer number cannot satisfy it", () => {
    expect(readySizeToken(140, 40)).toBe(` 140x40${READY_SIZE_END}`);
    expect(`${readyTitleFor("terminal", "n")}${readySizeToken(140, 400)}`)
      .not.toContain(readySizeToken(140, 40));
    expect(script).toContain(`'${READY_SIZE_END}`);
  });

  /**
   * Minor 8: whatever opened this file — the owner's login shell, or the kernel honouring the
   * shebang — the script re-executes itself in an environment this harness chose, so `BASH_ENV`, an
   * exported `SHELLOPTS` and the owner's `PATH` cannot change what a staged window does.
   */
  it("re-executes itself in a clean, fixed environment before anything else", () => {
    const guard = script.indexOf("if [ \"$CLAVE_EVAL_CLEAN\" != \"1\" ]; then");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf("printf"));
    expect(script).toContain("exec /usr/bin/env -i CLAVE_EVAL_CLEAN=1 TERM=xterm-256color PATH=/usr/bin:/bin");
    expect(script).toContain("/bin/bash --noprofile --norc -- \"$0\"");
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    // `unset` is not the mechanism: SHELLOPTS and BASHOPTS are readonly in bash.
    expect(script).not.toContain("unset SHELLOPTS");
  });

  /** Minor 5: the guard could not see a delimiter on the FIRST line, where it does the most damage. */
  it("refuses a truth whose first line is the heredoc delimiter", () => {
    expect(() => terminalScript({columns: 80, rows: 40, title: "CLAVE-EVAL x 1", truth: "CLAVE_EVAL_TRUTH\necho PWNED\n"}))
      .toThrow("EVAL_TRUTH_DELIMITER");
    // and still refuses it in the middle, and still accepts an ordinary truth
    expect(() => terminalScript({columns: 80, rows: 40, title: "CLAVE-EVAL x 1", truth: "a\nCLAVE_EVAL_TRUTH\nb"}))
      .toThrow("EVAL_TRUTH_DELIMITER");
    expect(terminalScript({columns: 80, rows: 40, title: "CLAVE-EVAL x 1", truth: "ordinary\n"})).toContain("ordinary");
  });

  it("prints exactly the mark the guard waits for", () => {
    expect(script).toContain(readyMark(title));
    expect(readyMark(title)).toBe(`${title}${READY_TOKEN} `);
  });
});

/** Minor 3: the display can be asked for its scale, so it is not inferred when it is known. */
describe("the display's own scale decides", () => {
  const staged = {widthPt: 1160, heightPt: 640, columns: null, rows: null};

  it("accepts a capture that matches the display's real scale", () => {
    expect(capturedSize({widthPx: 2320, heightPx: 1280}, staged, 2)).toEqual({scale: 2, sizeAsStaged: true});
    expect(capturedSize({widthPx: 1160, heightPx: 640}, staged, 1)).toEqual({scale: 1, sizeAsStaged: true});
  });

  /** The one false accept the inferred scale allowed: a real 1x display handing back 2x the points. */
  it("refuses a capture at the wrong multiple although an integer scale fits it", () => {
    expect(capturedSize({widthPx: 2320, heightPx: 1280}, staged, 1)).toEqual({scale: 2, sizeAsStaged: false});
  });

  /** A fractional display used to fail every case closed; the real number measures it honestly. */
  it("measures a fractional display instead of failing it closed", () => {
    expect(capturedSize({widthPx: 1740, heightPx: 960}, staged, 1.5)).toEqual({scale: null, sizeAsStaged: true});
    expect(capturedSize({widthPx: 1740, heightPx: 960}, staged)).toEqual({scale: null, sizeAsStaged: false});
  });

  it("falls back to the inferred scale when nobody could say", () => {
    expect(capturedSize({widthPx: 2320, heightPx: 1280}, staged, null)).toEqual({scale: 2, sizeAsStaged: true});
    expect(capturedSize({widthPx: 1416, heightPx: 1768}, staged, null).sizeAsStaged).toBe(false);
  });

  it("ignores a scale that is not a usable number", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(capturedSize({widthPx: 2320, heightPx: 1280}, staged, bad).sizeAsStaged).toBe(true);
    }
  });
});
/**
 * Repair loop 2. The staged run of 2026-09-21 had both terminal cases report `sizeAsStaged: false`
 * with captures that looked right for the staged cells, and nothing recorded what the shell had
 * said — so the script now polls the TTY for the size it was asked for, and the two numbers it
 * finally reports are read back out of the title.
 */
describe("the staged Terminal window asks the tty for its size", () => {
  const title = "CLAVE-EVAL terminal abc123";
  const script = terminalScript({columns: 140, rows: 40, title, truth: "line one\n"});

  it("asks `stty size` on /dev/tty, not `tput` down a pipe", () => {
    expect(script).toContain("CLAVE_SIZE=$(stty size 2>/dev/null < /dev/tty)");
    // stderr is silenced BEFORE the redirect that can fail, or bash reports it itself
    expect(script.indexOf("2>/dev/null")).toBeLessThan(script.indexOf("< /dev/tty"));
    // `tput` survives only as the last resort, and only when the tty answered nothing at all
    const fallback = script.indexOf("CLAVE_COLS=$(tput cols");
    expect(fallback).toBeGreaterThan(script.indexOf("CLAVE_SIZE=$(stty size"));
    expect(script.indexOf("if [ -z \"$CLAVE_COLS\" ]; then")).toBeLessThan(fallback);
  });

  it("polls until the tty reports the staged cells, bounded", () => {
    expect(script).toContain("while [ \"$CLAVE_TRY\" -lt 15 ]; do");
    expect(script).toContain("if [ \"$CLAVE_COLS\" = \"140\" ] && [ \"$CLAVE_ROWS\" = \"40\" ]; then break; fi");
    expect(script).toContain("sleep 0.2");
    expect(script).toContain("CLAVE_TRY=$((CLAVE_TRY + 1))");
  });

  /** The text is laid out at the final size, so the poll has to finish before anything is printed. */
  it("finishes asking before it prints the page", () => {
    expect(script.indexOf("done")).toBeLessThan(script.indexOf("echo STARTMARKER"));
    expect(script.indexOf("clear")).toBeGreaterThan(script.indexOf("while ["));
  });

  /** Each case polls for ITS OWN cells. */
  it("compares against the cells this case staged", () => {
    const narrow = terminalScript({columns: 72, rows: 40, title, truth: "x\n"});
    expect(narrow).toContain("if [ \"$CLAVE_COLS\" = \"72\" ] && [ \"$CLAVE_ROWS\" = \"40\" ]; then break; fi");
    expect(narrow).not.toContain("= \"140\"");
  });
});
/**
 * The toolbar titles, in and out. A toolbar case name carries DOTS and is long
 * (`incognito-mybank.example.localhost-ticket-dark-14`), which is the one thing about the toolbar
 * path that is not true of the accuracy path besides the host — so the round trip through the URL
 * is pinned rather than assumed, for every one of the forty cases.
 */
describe("the title a toolbar staging asks for is the title its guard expects", () => {
  const NONCE = "38f0f465d288";

  it.each(TOOLBAR_CASES.map((entry) => [entry.name, entry] as const))("%s", (_name, theCase) => {
    const stagedTitle = stagedTitleFor(theCase.name, NONCE);
    const url = new URL(pageUrl({
      host: theCase.host, port: 51234, page: theCase.page,
      theme: theCase.theme, sizePx: theCase.sizePx, stagedTitle
    }));
    // what the browser will send, decoded the way the server and the page decode it
    expect(url.searchParams.get("stagedTitle")).toBe(stagedTitle);
    // what the server will put in the <title>, and what the page's own script will re-apply
    expect(acceptStagedTitle(url.searchParams.get("stagedTitle"))).toBe(stagedTitle);
    // and what the guard demands of the window
    expect(stagedTitle.includes(theCase.host)).toBe(true);
    expect(approve({app: "Google Chrome", title: stagedTitle}, {app: "Google Chrome", stagedTitle})).not.toBeNull();
  });

  it("keeps the host and the port out of each other's way", () => {
    const first = TOOLBAR_CASES[0] as (typeof TOOLBAR_CASES)[number];
    const url = new URL(pageUrl({
      host: first.host, port: 51234, page: "chat", theme: "light", sizePx: 14,
      stagedTitle: stagedTitleFor(first.name, NONCE)
    }));
    expect(url.hostname).toBe(first.host);
    expect(url.port).toBe("51234");
    expect(url.pathname).toBe("/chat.html");
  });
});
