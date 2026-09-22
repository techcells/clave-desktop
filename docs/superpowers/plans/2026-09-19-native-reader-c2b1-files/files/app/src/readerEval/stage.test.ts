import {tmpdir} from "node:os";
import {describe, expect, it} from "vitest";
import {BROWSER_WINDOW} from "./cases";
import {
  chromePreferences,
  chromeStageCommand,
  chromeTeardownCommand,
  chromeTeardownPattern,
  evalScratchPaths,
  pageUrl,
  terminalScript,
  terminalStageCommand
} from "./stage";

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
    expect(dir).toBe(`${TMP}/clave-reader-eval-a1b2c3d4e5f6`);
    expect(profile).toBe(`${dir}/chrome-profile`);
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
      "--window-size=1268,708",
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
    const order = ["clear", "echo STARTMARKER", "line one", "echo ENDMARKER", "sleep"];
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
