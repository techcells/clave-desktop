// Tests the pure half of app/scripts/reader-eval.mjs, in plain Node. Same arrangement as
// dev-launcher.test.ts: the script's program half is gated on argv[1], so importing it here never
// opens a bundle, and app/tsconfig.json's `include` is src/**/*.ts, so this file is run by vitest
// and type-checked by nobody -- which is why the interop below is a plain namespace import.
import {describe, expect, it} from "vitest";
import {DEFAULT_POSITION} from "../src/readerEval/cases";
import * as cli from "./reader-eval.mjs";

const {parseEvalArgs, openArgs, evalEnv, formatObserveUrls, formatSummary, exitCodeFor, parsePositionArg, countArg, stagedPhrase, stagingLines, HINTS, LIMIT_MAX, POSITION_MAX_PT, POSITION_MIN_PT, USAGE, MODES} = cli as {
  parseEvalArgs: (argv: string[]) => Record<string, unknown>;
  openArgs: (bundle: string, env: Record<string, string>) => string[];
  evalEnv: (options: Record<string, unknown>, outFile: string, nonce: string) => Record<string, string>;
  formatObserveUrls: (urls: unknown) => string;
  formatSummary: (results: unknown) => string;
  exitCodeFor: (results: unknown) => number;
  parsePositionArg: (value: unknown) => string | null;
  countArg: (value: unknown) => number | null;
  LIMIT_MAX: number;
  stagedPhrase: (staged: unknown) => string;
  stagingLines: (name: string, repetitions: Record<string, unknown>[]) => string[];
  HINTS: Record<string, string>;
  POSITION_MAX_PT: number;
  POSITION_MIN_PT: number;
  USAGE: string;
  MODES: string[];
};

/** Every option at its default, which is what the parser answers with when given nothing. */
const DEFAULTS = {mode: "accuracy", repetitions: 5, seconds: 120, variant: "none", position: null, limit: null};

describe("the command line", () => {
  it("defaults to the accuracy run with five repetitions", () => {
    expect(parseEvalArgs([])).toEqual({ok: true, ...DEFAULTS});
  });

  it("drops the leading -- that pnpm adds", () => {
    expect(parseEvalArgs(["--", "toolbar"])).toMatchObject({ok: true, mode: "toolbar"});
  });

  it.each(["accuracy", "toolbar", "observe", "all", "coldstart"])("takes %s as a mode", (mode) => {
    expect(parseEvalArgs([mode])).toMatchObject({ok: true, mode});
    expect(MODES).toContain(mode);
  });

  it("refuses a mode it does not have", () => {
    expect(parseEvalArgs(["everything"])).toEqual({ok: false, problem: "everything"});
  });

  it("takes the five options", () => {
    expect(parseEvalArgs(["accuracy", "--repetitions", "3", "--seconds", "30", "--variant", "bookmarks-bar", "--position", "120,80", "--limit", "4"]))
      .toEqual({ok: true, mode: "accuracy", repetitions: 3, seconds: 30, variant: "bookmarks-bar", position: "120,80", limit: 4});
  });

  it.each([
    ["a repetition count of nought", ["--repetitions", "0"]],
    ["a fractional repetition count", ["--repetitions", "2.5"]],
    ["a repetition count that is not a number", ["--repetitions", "lots"]],
    ["a variant it does not have", ["--variant", "dark-theme"]],
    ["a flag it does not have", ["--forever"]],
    ["a missing value", ["--seconds"]]
  ])("refuses %s", (_label, args) => {
    expect(parseEvalArgs(args)).toMatchObject({ok: false});
  });

  it("has a usage text that names every mode and every option", () => {
    for (const mode of MODES) expect(USAGE).toContain(mode);
    for (const option of ["--repetitions", "--seconds", "--variant", "--position"]) expect(USAGE).toContain(option);
  });

  /** The two things a mode with no window has to say for itself, in the text the owner reads. */
  it("says in the usage text that coldstart opens nothing and is not part of all", () => {
    expect(USAGE).toContain("No window is opened");
    expect(USAGE).toContain("Not part of \"all\"");
  });
});

describe("--position", () => {
  it.each([
    ["the pair the plan names", "120,80", "120,80"],
    ["the origin", "0,0", "0,0"],
    ["a corner on a second display", "3000,140", "3000,140"]
  ])("takes %s", (_label, value, expected) => {
    expect(parsePositionArg(value)).toBe(expected);
    expect(parseEvalArgs(["accuracy", "--position", value])).toMatchObject({ok: true, position: expected});
  });

  /**
   * The plan's refusal table in full. Every one of these is a value `Number()` alone would have
   * taken, which is why this parser counts digits instead — and the owner is told HERE, before a
   * bundle is opened and windows start appearing on their screen.
   */
  it.each([
    ["two words", "a,b"],
    ["one number", "1"],
    ["a lone minus", "-,3"],
    ["a fractional coordinate", "3.2,4"],
    ["three numbers", "1,2,3"],
    ["nothing at all", ""],
    ["a missing coordinate", "40,"],
    ["a signed coordinate", "+40,60"],
    ["spaces around a number", " 40,60"],
    ["exponent notation", "1e3,60"],
    ["hexadecimal", "0x20,60"],
    ["a coordinate past the safe integer range", "9007199254740993,60"],
    // No screen is this large: a stray digit would stage every window off every display, every case
    // would come back `notStaged`, and the owner would lose a whole session to it.
    ["an x past any screen", "20001,60"],
    ["a y past any screen", "40,20001"],
    ["a stray extra digit", "400,600000"]
  ])("refuses %s", (_label, value) => {
    expect(parsePositionArg(value)).toBeNull();
    expect(parseEvalArgs(["accuracy", "--position", value])).toEqual({ok: false, problem: "--position"});
  });

  it("refuses a missing value", () => {
    expect(parsePositionArg(undefined)).toBeNull();
    expect(parseEvalArgs(["accuracy", "--position"])).toEqual({ok: false, problem: "--position"});
  });

  /** The same bound as the bundle's, so the two sides refuse the same command line. */
  it("takes a coordinate up to the bound and refuses the first one past it", () => {
    expect(POSITION_MAX_PT).toBe(20000);
    expect(parsePositionArg(`${POSITION_MAX_PT},${POSITION_MAX_PT}`)).toBe("20000,20000");
    expect(parsePositionArg(`${POSITION_MAX_PT + 1},0`)).toBeNull();
    // and the owner is told the bound rather than left with a bare refusal
    expect(USAGE).toContain(String(POSITION_MAX_PT));
  });

  /**
   * The default corner lives in `cases.ts`, beside the window size it belongs to. An ABSENT variable
   * is what tells the bundle to use it, so this script must not copy the numbers — and must not send
   * an empty variable either, which the bundle refuses rather than defaulting.
   */
  it("sends no position variable at all when none was asked for", () => {
    const env = evalEnv({...DEFAULTS}, "/out/a.json", "abc");
    expect(env.CLAVE_EVAL_POSITION).toBeUndefined();
    expect(Object.keys(env)).not.toContain("CLAVE_EVAL_POSITION");
    expect(evalEnv({...DEFAULTS, position: ""}, "/out/a.json", "abc").CLAVE_EVAL_POSITION).toBeUndefined();
  });

  it("passes the position it was given through to the bundle", () => {
    const env = evalEnv({...DEFAULTS, position: "3000,140"}, "/out/a.json", "abc");
    expect(env.CLAVE_EVAL_POSITION).toBe("3000,140");
    expect(openArgs("/b.app", env)).toContain("CLAVE_EVAL_POSITION=3000,140");
  });

  /**
   * The usage text is the one place the default corner is written down twice — once here for the
   * owner to read, once in `cases.ts` where the bundle takes it from. This is what keeps the
   * sentence the owner reads true after somebody moves the window.
   */
  it("tells the owner the same default corner the bundle would use", () => {
    expect(USAGE).toContain(`default ${DEFAULT_POSITION.xPt},${DEFAULT_POSITION.yPt}`);
  });
});

describe("opening the bundle", () => {
  /**
   * This is the line that decides which program the Screen Recording grant belongs to. `-W` is what
   * makes this script wait for the run rather than returning to the shell while windows open.
   */
  it("opens a new instance, waits for it, and passes every switch through --env", () => {
    const env = evalEnv({mode: "toolbar", repetitions: 5, seconds: 120, variant: "none"}, "/out/toolbar-abc.json", "abc");
    expect(openArgs("/Users/x/Applications/Clave Agent Dev.app", env)).toEqual([
      "-n", "-W", "/Users/x/Applications/Clave Agent Dev.app",
      "--env", "CLAVE_DEV_ENTRY=reader-eval",
      "--env", "CLAVE_EVAL_MODE=toolbar",
      "--env", "CLAVE_EVAL_OUT=/out/toolbar-abc.json",
      "--env", "CLAVE_EVAL_NONCE=abc",
      "--env", "CLAVE_EVAL_REPETITIONS=5",
      "--env", "CLAVE_EVAL_SECONDS=120",
      "--env", "CLAVE_EVAL_VARIANT=none"
    ]);
  });

  it("asks the dev launcher for the evaluation entry, not the app", () => {
    expect(evalEnv({mode: "accuracy", repetitions: 5, seconds: 120, variant: "none"}, "/o.json", "n").CLAVE_DEV_ENTRY)
      .toBe("reader-eval");
  });
});

const accepted = {
  schema: 3, mode: "accuracy", nonce: "abc", repetitions: 5, chromeVariant: "none",
  helper: {readyMs: 812}, permission: "granted",
  accuracy: [{
    case: "chat-light-14", group: "chat", minAccuracy: 1, medianAccuracy: 1, minAccents: 1,
    incomplete: false, confusions: [], repetitions: [{outcome: "ok"}, {outcome: "ok"}]
  }],
  toolbar: [], observe: [],
  summary: {
    groups: [{group: "chat", threshold: 0.97, min: 1, median: 1, accentsMin: null, accentsThreshold: null, incompleteCases: [], passed: true}],
    toolbar: null, accepted: true
  }
};

describe("the printed summary", () => {
  it("shows every case with its minimum, its median and its outcomes", () => {
    const printed = formatSummary(accepted);
    expect(printed).toContain("chat-light-14");
    expect(printed).toContain("1.0000");
    expect(printed).toContain("ok,ok");
  });

  it("says PASS and the threshold for a group that cleared it", () => {
    expect(formatSummary(accepted)).toContain("PASS  chat");
    expect(formatSummary(accepted)).toContain("need 0.97");
  });

  it("says SHORT and names the incomplete cases", () => {
    const short = {
      ...accepted,
      summary: {
        ...accepted.summary,
        groups: [{...accepted.summary.groups[0], min: 0.5, passed: false, incompleteCases: ["chat-dark-11"]}],
        accepted: false
      }
    };
    const printed = formatSummary(short);
    expect(printed).toContain("SHORT");
    expect(printed).toContain("INCOMPLETE: chat-dark-11");
    expect(printed).toContain("READER_EVAL SHORTFALL");
  });

  /** Carried item 30's failure mode: a badge below the band means a private window would be KEPT. */
  it("calls out a private badge that fell below the toolbar band", () => {
    const printed = formatSummary({
      ...accepted,
      toolbar: [{case: "incognito-x", privateBottomPx: 140, bandPx: 82, private: false}],
      summary: {
        ...accepted.summary,
        toolbar: {captures: 40, hostHits: 20, hostHitsMin: 19, privateHits: 19, privateHitsMin: 20, falsePrivate: 0, falsePrivateMax: 0, incompleteCases: [], passed: false},
        accepted: false
      }
    });
    expect(printed).toContain("BELOW BAND  incognito-x");
    expect(printed).toContain("140px > band 82px");
  });

  it("says a staged private window that showed no marker would have been KEPT", () => {
    const printed = formatSummary({
      ...accepted,
      observe: [
        {case: "safari-private-chat-light-14", outcome: "ok", host: true, private: false, expectPrivate: true, bandPx: 41, privateBottomPx: null},
        {case: "safari-normal-chat-light-14", outcome: "ok", host: true, private: false, expectPrivate: false, bandPx: 41, privateBottomPx: null}
      ],
      summary: {
        ...accepted.summary,
        observe: {staged: 2, read: 2, privateMissed: 1, falsePrivate: 0, incompleteCases: [], passed: false},
        accepted: false
      }
    });
    expect(printed).toContain("NOT AS EXPECTED: private window would be KEPT");
    expect(printed).toContain("as expected");
    expect(printed).toContain("SHORT  observe");
    expect(printed).toContain("private-missed 1");
    expect(printed).toContain("READER_EVAL SHORTFALL");
  });

  it("says a staged normal window flagged private is not as expected either", () => {
    const printed = formatSummary({
      ...accepted,
      observe: [{case: "safari-normal-chat-light-14", outcome: "ok", host: true, private: true, expectPrivate: false, bandPx: 41, privateBottomPx: 30}],
      summary: {
        ...accepted.summary,
        observe: {staged: 1, read: 1, privateMissed: 0, falsePrivate: 1, incompleteCases: [], passed: false},
        accepted: false
      }
    });
    expect(printed).toContain("NOT AS EXPECTED: normal window flagged private");
    expect(printed).toContain("false-private 1");
  });

  it("says an observe run that measured nothing is incomplete, not a pass", () => {
    const printed = formatSummary({
      ...accepted,
      observe: [],
      summary: {
        ...accepted.summary,
        observe: {staged: 0, read: 0, privateMissed: 0, falsePrivate: 0, incompleteCases: [], passed: false},
        accepted: false
      }
    });
    expect(printed).toContain("SHORT  observe");
    expect(printed).toContain("INCOMPLETE: nothing was staged and read");
    expect(printed).toContain("READER_EVAL SHORTFALL");
  });

  it("passes an observe run in which every staged window read as staged", () => {
    const results = {
      ...accepted,
      observe: [{case: "safari-private-chat-light-14", outcome: "ok", host: true, private: true, expectPrivate: true, bandPx: 41, privateBottomPx: 36}],
      summary: {
        ...accepted.summary,
        observe: {staged: 1, read: 1, privateMissed: 0, falsePrivate: 0, incompleteCases: [], passed: true},
        accepted: true
      }
    };
    expect(formatSummary(results)).toContain("PASS  observe");
    expect(exitCodeFor(results)).toBe(0);
  });

  it("gives an observe shortfall exit code 2, like any other", () => {
    expect(exitCodeFor({
      ...accepted,
      summary: {...accepted.summary, observe: {staged: 5, read: 5, privateMissed: 1, falsePrivate: 0, incompleteCases: [], passed: false}, accepted: false}
    })).toBe(2);
  });

  it("prints a refusal from inside the bundle as the fixed code it is", () => {
    expect(formatSummary({error: "NO_GRANT", code: "NO_GRANT"})).toBe("READER_EVAL_FAILED NO_GRANT\n");
  });

  /**
   * `HARNESS` alone does not tell the owner that the CALL was wrong. A bundle launched with a mode it
   * does not have refuses before it stages anything, and the code is the whole message.
   */
  it.each(["BAD_MODE", "BAD_VARIANT"])("prints %s beside the catch-all error it arrives under", (code) => {
    expect(formatSummary({error: "HARNESS", code})).toBe(`READER_EVAL_FAILED HARNESS ${code}\n`);
    expect(exitCodeFor({error: "HARNESS", code})).toBe(1);
  });

  /**
   * A group with no verdict is a part of the screen nobody measured. It used to be invisible: an
   * accuracy run that staged nothing printed no group line at all and then said ACCEPTED.
   */
  it("names the accuracy groups the run never produced a verdict for", () => {
    const printed = formatSummary({
      ...accepted,
      summary: {...accepted.summary, missingGroups: ["ticket", "terminal", "pt", "code"], accepted: false}
    });
    expect(printed).toContain("MISSING: ticket terminal pt code");
    expect(printed).toContain("READER_EVAL SHORTFALL");
  });

  it("says nothing about missing groups when none are", () => {
    expect(formatSummary({...accepted, summary: {...accepted.summary, missingGroups: []}})).not.toContain("MISSING");
  });
});

describe("the coldstart run", () => {
  const coldstart = (over: Record<string, unknown>) => ({
    schema: 3, mode: "coldstart", nonce: "abc", repetitions: 5, chromeVariant: "none",
    helper: {readyMs: 43_912}, permission: "granted",
    accuracy: [], toolbar: [], observe: [],
    summary: {
      groups: [], missingGroups: [], toolbar: null, observe: null,
      coldstart: {readyMs: 43_912, permission: "granted", passed: true},
      accepted: true,
      ...over
    }
  });

  /** Both figures, plainly: they ARE the measurement this mode exists for. */
  it("prints the start time and the permission answer", () => {
    const printed = formatSummary(coldstart({}));
    expect(printed).toContain("helper ready in 43912 ms");
    expect(printed).toContain("PASS  coldstart ready 43912 ms  permission granted");
    expect(printed).toContain("READER_EVAL ACCEPTED");
    expect(exitCodeFor(coldstart({}))).toBe(0);
  });

  /**
   * A helper spawned by the window-less evaluation entry that is not granted is the finding that
   * blocks Tasks 3-5 of the measurement plan, so it is a SHORTFALL with an exit code, not a note.
   */
  it("says a helper that was not granted is a shortfall, and why it matters", () => {
    const denied = coldstart({
      coldstart: {readyMs: 900, permission: "denied", passed: false},
      accepted: false
    });
    const printed = formatSummary(denied);
    expect(printed).toContain("SHORT  coldstart ready 900 ms  permission denied");
    expect(printed).toContain("the grant does not reach a helper spawned by the evaluation entry");
    expect(exitCodeFor(denied)).toBe(2);
  });

  it("says so plainly when no start time was measured at all", () => {
    expect(formatSummary(coldstart({
      coldstart: {readyMs: null, permission: "granted", passed: false},
      accepted: false
    }))).toContain("SHORT  coldstart ready not measured  permission granted");
  });

  /** Every mode records the start time, so every mode prints it. */
  it("prints the helper start time in a staged-window run too", () => {
    expect(formatSummary(accepted)).toContain("helper ready in 812 ms");
  });

  it("says nothing about coldstart in a mode that did not run it", () => {
    expect(formatSummary(accepted)).not.toContain("coldstart");
  });
});

describe("the observe URLs", () => {
  const urls = [
    {case: "safari-normal-chat-light-14", app: "Safari", expectPrivate: false, url: "http://127.0.0.1:1/a"},
    {case: "safari-private-chat-light-14", app: "Safari", expectPrivate: true, url: "http://127.0.0.1:1/b"},
    {case: "chrome-normal-chat-light-14", app: "Google Chrome", expectPrivate: false, url: "http://127.0.0.1:1/c"},
    {case: "chrome-private-chat-light-14", app: "Google Chrome", expectPrivate: true, url: "http://127.0.0.1:1/d"}
  ];

  /**
   * The guard compares the app name exactly, so a Chrome case opened in Safari is simply never read:
   * the owner has to be told which browser each URL belongs in, and which window kind.
   */
  it("names the browser and the window kind for every URL", () => {
    const printed = formatObserveUrls(urls);
    expect(printed).toContain("Safari  normal window    http://127.0.0.1:1/a");
    expect(printed).toContain("Safari  PRIVATE window   http://127.0.0.1:1/b");
    expect(printed).toContain("Chrome  normal window    http://127.0.0.1:1/c");
    // Chrome's own word for the window the owner must open, although the case is named `private`.
    expect(printed).toContain("Chrome  INCOGNITO window  http://127.0.0.1:1/d");
  });

  it("does not tell the owner to open everything in Safari", () => {
    expect(formatObserveUrls(urls)).not.toContain("in Safari");
  });

  it("prints nothing but its heading when there are no URLs", () => {
    expect(formatObserveUrls([])).not.toContain("http");
    expect(formatObserveUrls(undefined)).not.toContain("http");
  });
});

describe("the exit code", () => {
  it("is 0 only when every acceptance check passed", () => {
    expect(exitCodeFor(accepted)).toBe(0);
  });

  it("is 2 on a shortfall", () => {
    expect(exitCodeFor({...accepted, summary: {...accepted.summary, accepted: false}})).toBe(2);
  });

  it("is 1 when the run never produced results", () => {
    expect(exitCodeFor({error: "PROTOCOL", code: "PROTOCOL"})).toBe(1);
    expect(exitCodeFor(null)).toBe(1);
    expect(exitCodeFor("nonsense")).toBe(1);
  });
});
/**
 * The staging lines of 2026-09-20. The first run against a screen printed sixteen passes for
 * sixteen windows that were not the size the run asked for, and two `noMarkers` with no way to tell
 * an empty window from a scrolled one. Both now have a line of their own, in the summary the owner
 * reads rather than only in the JSON.
 */
describe("the staging diagnostics", () => {
  const wrongSize = {
    outcome: "ok", markers: true, sizeAsStaged: false, scale: null,
    staged: {widthPt: 1268, heightPt: 708, columns: null, rows: null},
    stats: {widthPx: 1416, heightPx: 1768}
  };

  it("prints the captured size against the staged size, in the words the record uses", () => {
    const [line] = stagingLines("chat-light-14", [wrongSize]);
    expect(line).toContain("NOT AS STAGED: captured 1416x1768 px, staged 1268x708 pt");
    expect(line).toContain("chat-light-14");
    expect(line).toContain("(1 of 1 reads)");
  });

  it("counts the reads it happened to, and prints one line for the case", () => {
    const lines = stagingLines("chat-light-14", [wrongSize, {outcome: "ok", markers: true, sizeAsStaged: true}, wrongSize]);
    expect(lines.filter((line) => line.includes("NOT AS STAGED"))).toHaveLength(1);
    expect(lines[0]).toContain("(2 of 3 reads)");
  });

  it("says cells for a terminal, which is not staged in points", () => {
    const [line] = stagingLines("terminal-narrow", [{
      outcome: "ok", markers: true, sizeAsStaged: false, scale: null,
      staged: {widthPt: null, heightPt: null, columns: 72, rows: 40},
      stats: {widthPx: 1426, heightPx: 880}
    }]);
    expect(line).toContain("NOT AS STAGED: captured 1426x880 px, staged 72x40 cells");
    expect(stagedPhrase({widthPt: null, heightPt: null, columns: null, rows: null})).toBe("nothing recorded");
  });

  it("says which marker was missing, and how much text came back", () => {
    const lines = stagingLines("terminal", [{
      outcome: "noMarkers", markers: false, sizeAsStaged: true,
      startFound: false, endFound: false, lineCount: 0, textLength: 0
    }]);
    expect(lines[0]).toContain("NO MARKERS: start false end false  lines 0 chars 0");
  });

  it("prints nothing at all for a clean run", () => {
    expect(stagingLines("chat-light-14", [{outcome: "ok", markers: true, sizeAsStaged: true}])).toEqual([]);
    expect(stagingLines("chat-light-14", [{outcome: "ok", markers: true, sizeAsStaged: null}])).toEqual([]);
  });

  it("puts the lines into the summary itself", () => {
    const printed = formatSummary({
      ...accepted,
      accuracy: [{...accepted.accuracy[0], repetitions: [wrongSize]}]
    });
    expect(printed).toContain("NOT AS STAGED: captured 1416x1768 px, staged 1268x708 pt");
  });

  it("explains the two refusals whose codes alone would not", () => {
    const small = formatSummary({error: "HARNESS", code: "DISPLAY_TOO_SMALL"});
    expect(small).toContain("READER_EVAL_FAILED HARNESS DISPLAY_TOO_SMALL");
    expect(small).toContain("does not fit this display's work area");

    // A different instruction to the owner: the window fits, the corner is wrong.
    const off = formatSummary({error: "HARNESS", code: "POSITION_OFF_DISPLAY"});
    expect(off).toContain("READER_EVAL_FAILED HARNESS POSITION_OFF_DISPLAY");
    expect(off).toContain("--position leaves the staged window off that display");
    expect(off).not.toContain("does not fit this display's work area");
  });

  it("says nothing extra for a refusal that speaks for itself", () => {
    expect(formatSummary({error: "HARNESS", code: "BAD_MODE"})).toBe("READER_EVAL_FAILED HARNESS BAD_MODE\n");
  });
});

/** Repair loop 2: the CLI's own copy of the two rules that changed. */
describe("the position the CLI will pass on", () => {
  it.each([
    ["a display to the left", "-2560,100"],
    ["a display above", "40,-900"],
    ["both", "-2560,-900"],
    ["the bound itself", "-20000,-20000"]
  ])("takes %s", (_label, raw) => {
    expect(parsePositionArg(raw)).toBe(raw);
    expect(parseEvalArgs(["accuracy", "--position", raw])).toMatchObject({ok: true, position: raw});
  });

  it("refuses a negative coordinate past the bound, and a lone minus", () => {
    expect(POSITION_MIN_PT).toBe(-20000);
    expect(parsePositionArg("-20001,60")).toBeNull();
    expect(parsePositionArg("-,60")).toBeNull();
    expect(parsePositionArg("40,-")).toBeNull();
  });

  it("says in the usage text that a coordinate may be negative", () => {
    expect(USAGE).toContain("-20000");
    expect(USAGE).toContain("negative coordinates");
  });
});

/**
 * A refusal code is a string read out of a file, so the hint table is asked for OWN properties only:
 * `HINTS["constructor"]` is otherwise a function, which the summary would happily print.
 */
describe("the hint table", () => {
  it("answers for its own codes and for nothing else", () => {
    expect(formatSummary({error: "HARNESS", code: "constructor"})).toBe("READER_EVAL_FAILED HARNESS constructor\n");
    expect(formatSummary({error: "HARNESS", code: "toString"})).toBe("READER_EVAL_FAILED HARNESS toString\n");
    expect(formatSummary({error: "HARNESS", code: "__proto__"})).toBe("READER_EVAL_FAILED HARNESS __proto__\n");
    expect(Object.keys(HINTS).sort()).toEqual(["DISPLAY_TOO_SMALL", "PAGE_SERVER", "POSITION_OFF_DISPLAY"]);
  });
});

/**
 * `--limit`: the option that exists because the toolbar path failed forty times out of forty on a
 * real screen, and a full failing run costs twenty-four minutes to learn what four cases would say.
 */
describe("a short run", () => {
  it("takes a whole number of cases", () => {
    expect(parseEvalArgs(["toolbar", "--limit", "4"])).toMatchObject({ok: true, mode: "toolbar", limit: 4});
    expect(countArg("1")).toBe(1);
    expect(countArg(String(LIMIT_MAX))).toBe(LIMIT_MAX);
  });

  it.each([
    ["nought", "0"],
    ["a fraction", "2.5"],
    ["a negative", "-4"],
    ["a word", "four"],
    ["nothing", ""],
    ["spaces", " 4"],
    ["past the bound", String(LIMIT_MAX + 1)],
    ["exponent notation", "1e2"],
    ["hexadecimal", "0x4"]
  ])("refuses %s", (_label, raw) => {
    expect(countArg(raw)).toBeNull();
    expect(parseEvalArgs(["toolbar", "--limit", raw])).toMatchObject({ok: false});
  });

  it("passes it to the bundle only when it was asked for", () => {
    expect(evalEnv({...DEFAULTS, limit: 4}, "/out/x.json", "abc").CLAVE_EVAL_LIMIT).toBe("4");
    expect(evalEnv(DEFAULTS, "/out/x.json", "abc").CLAVE_EVAL_LIMIT).toBeUndefined();
  });

  it("says in the summary that it was short, and never accepts it", () => {
    const printed = formatSummary({
      ...accepted,
      summary: {...accepted.summary, limited: {reason: "LIMITED", cases: 4, of: 40}, accepted: false}
    });
    expect(printed).toContain("LIMITED RUN: 4 of 40 cases — not an acceptance run");
    expect(printed).toContain("READER_EVAL SHORTFALL");
    expect(printed).not.toContain("READER_EVAL ACCEPTED");
  });

  it("exits 2, like any other run that was not accepted", () => {
    expect(exitCodeFor({summary: {limited: {reason: "LIMITED", cases: 4, of: 40}, accepted: false}})).toBe(2);
  });

  it("prints nothing of the sort for a full run", () => {
    expect(formatSummary(accepted)).not.toContain("LIMITED RUN");
    expect(formatSummary(accepted)).toContain("READER_EVAL ACCEPTED");
  });

  it("says in the usage text what it is for", () => {
    expect(USAGE).toContain("--limit");
    expect(USAGE).toContain("interleaved");
    expect(USAGE).toContain("NEVER an acceptance run");
  });
});

describe("where the CLI will pass a limit on", () => {
  it.each(["accuracy", "toolbar", "all"])("takes one in %s", (mode) => {
    expect(parseEvalArgs([mode, "--limit", "4"])).toMatchObject({ok: true, limit: 4});
  });

  it.each(["observe", "coldstart"])("refuses one in %s", (mode) => {
    expect(parseEvalArgs([mode, "--limit", "4"])).toMatchObject({ok: false, problem: "--limit"});
    expect(parseEvalArgs([mode])).toMatchObject({ok: true});
  });

  it.each(["04", "0004"])("refuses a zero-padded %s", (raw) => {
    expect(countArg(raw)).toBeNull();
  });
});
/** The refusal that fires when another local process holds the `::1` port (re-review D, Important 1). */
describe("a page server that could not get both loopback families", () => {
  it("is named, with what it means", () => {
    const printed = formatSummary({error: "HARNESS", code: "PAGE_SERVER"});
    expect(printed).toContain("READER_EVAL_FAILED HARNESS PAGE_SERVER");
    expect(printed).toContain("both loopback families");
    expect(printed).toContain("Nothing was opened");
  });

  it("exits 1, like every other run that produced no results", () => {
    expect(exitCodeFor({error: "HARNESS", code: "PAGE_SERVER"})).toBe(1);
  });
});
