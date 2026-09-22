// Tests the pure half of app/scripts/reader-eval.mjs, in plain Node. Same arrangement as
// dev-launcher.test.ts: the script's program half is gated on argv[1], so importing it here never
// opens a bundle, and app/tsconfig.json's `include` is src/**/*.ts, so this file is run by vitest
// and type-checked by nobody -- which is why the interop below is a plain namespace import.
import {describe, expect, it} from "vitest";
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_POSITION} from "../src/readerEval/cases";
import {OBSERVE_EXPECT_SETS, OBSERVE_HOST_MAX, parseObserveHost, revealFileNames as bundleRevealFileNames, revealUnsafeCodePoint as bundleUnsafe} from "../src/readerEval/observe";
import * as cli from "./reader-eval.mjs";

const {parseEvalArgs, openArgs, evalEnv, formatObserveUrls, formatSummary, exitCodeFor, parsePositionArg, parseExpectArg, parseHostArg, countArg, stagedPhrase, stagingLines, observeLabel, formatProgressLine, progressKey, fixedCode, readRunFile, clearRunFiles, observeUrlsName, observeProgressName, observeRevealName, observeAliveName, partialOf, claimedOf, revealFileNames, writeHeartbeat, HEARTBEAT_CONTENTS, reportHarnessFailure, HARNESS_FAILURE_EXIT, sweepRevealOrphans, isRevealOrphan, installRevealSignalHandlers, REVEAL_SIGNALS, REVEAL_SIGNAL_EXIT, observeFilesFor, watchObserve, clearRevealFile, withRevealCleanup, formatRevealRow, quoted, REVEAL_ON, REVEALING_MODE, revealUnsafeCodePoint, knownSchema, RESULTS_SCHEMA, HINTS, LIMIT_MAX, HOST_MAX, EXPECT_SETS, OBSERVING_MODES, POSITION_MAX_PT, POSITION_MIN_PT, USAGE, MODES} = cli as {
  parseEvalArgs: (argv: string[]) => Record<string, unknown>;
  openArgs: (bundle: string, env: Record<string, string>) => string[];
  evalEnv: (options: Record<string, unknown>, outFile: string, nonce: string) => Record<string, string>;
  formatObserveUrls: (urls: unknown, expect?: unknown) => string;
  parseExpectArg: (value: unknown) => string | null;
  parseHostArg: (value: unknown) => string | null;
  observeLabel: (entry: Record<string, unknown>) => string;
  formatProgressLine: (row: Record<string, unknown>) => string;
  progressKey: (row: Record<string, unknown>) => string;
  readRunFile: (outDir: string, name: string) => Record<string, unknown> | null;
  clearRunFiles: (outDir: string, nonce: string) => void;
  observeUrlsName: (nonce: string) => string;
  observeProgressName: (nonce: string) => string;
  observeRevealName: (nonce: string) => string;
  observeAliveName: (nonce: string) => string;
  partialOf: (name: string) => string;
  claimedOf: (name: string) => string;
  revealFileNames: (nonce: string) => string[];
  writeHeartbeat: (path: string, io: {writeFile: (path: string, contents: string, options: {mode: number}) => void}) => void;
  HEARTBEAT_CONTENTS: string;
  reportHarnessFailure: (io?: {write?: (text: string) => void; exit?: (code: number) => void}) => void;
  HARNESS_FAILURE_EXIT: number;
  sweepRevealOrphans: (outDir: string, list?: unknown, remove?: unknown) => number;
  isRevealOrphan: (name: unknown) => boolean;
  installRevealSignalHandlers: (
    outDir: string, nonce: string,
    io: {on: (signal: string, handler: () => void) => void; exit: (code: number) => void; clear: (outDir: string, nonce: string) => void}
  ) => void;
  REVEAL_SIGNALS: string[];
  revealUnsafeCodePoint: (code: number) => boolean;
  REVEAL_SIGNAL_EXIT: number;
  clearRevealFile: (outDir: string, nonce: string) => void;
  withRevealCleanup: <T>(outDir: string, nonce: string, body: () => Promise<T>) => Promise<T>;
  formatRevealRow: (row: Record<string, unknown>) => string;
  quoted: (value: unknown) => string;
  REVEAL_ON: string;
  REVEALING_MODE: string;
  observeFilesFor: (nonce: string) => {urls: string; progress: string; reveal: string};
  watchObserve: (
    outDir: string, nonce: string, running: {done: boolean},
    io: {
      read: (name: string) => unknown; print: (text: string) => void;
      wait: (ms: number) => Promise<void>; remove?: (name: string) => void;
      claim?: (from: string, to: string) => boolean; beat?: (name: string) => void;
    },
    options?: {reveal?: boolean}
  ) => Promise<void>;
  knownSchema: (results: unknown) => boolean;
  RESULTS_SCHEMA: number;
  fixedCode: (value: unknown) => string;
  HOST_MAX: number;
  EXPECT_SETS: string[];
  OBSERVING_MODES: string[];
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
const DEFAULTS = {
  mode: "accuracy", repetitions: 5, seconds: 120, variant: "none", position: null, limit: null,
  // Both absent by default, which is what tells the bundle to use its own: an observe run that was
  // asked for nothing is EXPLORATORY, and the default host lives in `observe.ts`.
  expect: null, host: null, reveal: false, notSecure: false
};

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

  it("takes the five options a staged run has", () => {
    expect(parseEvalArgs(["accuracy", "--repetitions", "3", "--seconds", "30", "--variant", "bookmarks-bar", "--position", "120,80", "--limit", "4"]))
      .toEqual({
        ok: true, mode: "accuracy", repetitions: 3, seconds: 30, variant: "bookmarks-bar",
        position: "120,80", limit: 4, expect: null, host: null, reveal: false, notSecure: false
      });
  });

  /** And the two an owner-staged run has. */
  it("takes --expect and --host together", () => {
    expect(parseEvalArgs(["observe", "--expect", "safari-private", "--host", "app.clave.localhost"]))
      .toEqual({
        ok: true, mode: "observe", repetitions: 5, seconds: 120, variant: "none", position: null,
        limit: null, expect: "safari-private", host: "app.clave.localhost", reveal: false, notSecure: false
      });
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
  schema: 6, notSecure: false, mode: "accuracy", nonce: "abc", repetitions: 5, chromeVariant: "none",
  helper: {readyMs: 812}, permission: "granted",
  accuracy: [{
    case: "chat-light-14", group: "chat", minAccuracy: 1, medianAccuracy: 1, minAccents: 1,
    incomplete: false, confusions: [], repetitions: [{outcome: "ok"}, {outcome: "ok"}]
  }],
  toolbar: [], observe: [],
  summary: {
    groups: [{group: "chat", threshold: 0.97, min: 1, median: 1, accentsMin: null, accentsThreshold: null, incompleteCases: [], passed: true}],
    toolbar: null, exploratory: null, accepted: true
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

  /**
   * Finding O4, as the label rule. Run #2 printed "private window would be KEPT" for a case whose
   * read had FAILED: `windowGone` means the helper refused before it captured anything, so nothing
   * was read and nothing was kept. The sentence is this harness's strongest and it must be reserved
   * for a read that succeeded and showed the wrong thing.
   */
  it.each(["windowGone", "timeout", "black", "failed", "notStaged"])(
    "says NOT READ, never KEPT, for a %s row",
    (outcome) => {
      const entry = {case: "safari-private-chat-light-14", outcome, host: null, hostDistance: null, private: null, expectPrivate: true, bandPx: null, privateBottomPx: null};
      expect(observeLabel(entry)).toBe(`NOT READ: ${outcome}`);
      const printed = formatSummary({
        ...accepted,
        observe: [entry],
        summary: {
          ...accepted.summary,
          observe: {
            staged: 1, read: 0, expect: ["safari-private"], expected: 5,
            missingCases: ["safari-private-chat-light-14"], privateMissed: 0, falsePrivate: 0,
            incompleteCases: ["safari-private-chat-light-14"], reason: "INCOMPLETE", passed: false
          },
          accepted: false
        }
      });
      expect(printed).toContain(`NOT READ: ${outcome}`);
      expect(printed).not.toContain("would be KEPT");
      expect(printed).toContain("expected but never read: safari-private-chat-light-14");
    }
  );

  /** And the label is kept for the read that really did show no marker. */
  it("keeps the KEPT sentence for a read that succeeded and showed no private marker", () => {
    expect(observeLabel({outcome: "ok", expectPrivate: true, private: false}))
      .toBe("NOT AS EXPECTED: private window would be KEPT");
    expect(observeLabel({outcome: "ok", expectPrivate: true, private: null}))
      .toBe("NOT AS EXPECTED: private window would be KEPT");
    expect(observeLabel({outcome: "ok", expectPrivate: false, private: true}))
      .toBe("NOT AS EXPECTED: normal window flagged private");
    expect(observeLabel({outcome: "ok", expectPrivate: true, private: true})).toBe("as expected");
    expect(observeLabel({outcome: "ok", expectPrivate: false, private: false})).toBe("as expected");
  });

  /**
   * Review, Minor 5. A NORMAL window read with no strip at all had nothing checked in it: the
   * product's rule was never applied, and there is no host on which an excluded site could have
   * been matched. It is not "as expected", and the run it belongs to is INCOMPLETE.
   */
  it("says NOT CHECKED for a normal window that came back with no toolbar strip", () => {
    expect(observeLabel({outcome: "ok", expectPrivate: false, private: null}))
      .toBe("NOT CHECKED: no toolbar strip");
    const printed = formatSummary({
      ...accepted,
      observe: [{case: "safari-normal-chat-light-14", outcome: "ok", host: null, hostDistance: null, private: null, expectPrivate: false, bandPx: null, privateBottomPx: null}],
      summary: {
        ...accepted.summary,
        observe: {
          staged: 1, read: 1, expect: ["safari-normal"], expected: 5, missingCases: [],
          notCheckedCases: ["safari-normal-chat-light-14"], privateMissed: 0, falsePrivate: 0,
          incompleteCases: [], reason: "INCOMPLETE", passed: false
        },
        accepted: false
      }
    });
    expect(printed).toContain("NOT CHECKED: no toolbar strip");
    expect(printed).toContain("READER_EVAL SHORTFALL");
  });

  /**
   * Finding O1 in the summary the owner reads: a run that was asked for nothing says so, in the same
   * place it used to say ACCEPTED.
   */
  it("calls a run with no expectation exploratory, and refuses it", () => {
    const results = {
      ...accepted,
      observe: [{case: "safari-normal-chat-light-14", outcome: "ok", host: true, hostDistance: 0, private: false, expectPrivate: false, bandPx: 41, privateBottomPx: null}],
      summary: {
        ...accepted.summary,
        observe: {
          staged: 1, read: 1, expect: null, expected: 0, missingCases: [], privateMissed: 0,
          falsePrivate: 0, incompleteCases: [], reason: "EXPLORATORY", passed: false
        },
        accepted: false
      }
    };
    const printed = formatSummary(results);
    expect(printed).toContain("SHORT  observe   expect (none)");
    expect(printed).toContain("EXPLORATORY: no --expect");
    expect(printed).toContain("READER_EVAL SHORTFALL");
    expect(exitCodeFor(results)).toBe(2);
  });

  /** Finding O5: the number beside the boolean, so "absent" and "misread" are different lines. */
  it("prints the host distance beside the host boolean", () => {
    const printed = formatSummary({
      ...accepted,
      observe: [{case: "safari-normal-chat-light-14", outcome: "ok", host: false, hostDistance: 2, private: false, expectPrivate: false, bandPx: 41, privateBottomPx: null}],
      summary: {
        ...accepted.summary,
        observe: {staged: 1, read: 1, expect: ["safari-normal"], expected: 5, missingCases: [], privateMissed: 0, falsePrivate: 0, incompleteCases: [], reason: "INCOMPLETE", passed: false},
        accepted: false
      }
    });
    expect(printed).toContain("host false dist 2");
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
    schema: 6, notSecure: false, mode: "coldstart", nonce: "abc", repetitions: 5, chromeVariant: "none",
    helper: {readyMs: 43_912}, permission: "granted",
    accuracy: [], toolbar: [], observe: [],
    summary: {
      groups: [], missingGroups: [], toolbar: null, observe: null,
      coldstart: {readyMs: 43_912, permission: "granted", passed: true},
      exploratory: null,
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
    {case: "safari-normal-chat-light-14", app: "Safari", expectPrivate: false, expected: false, url: "http://127.0.0.1:1/a"},
    {case: "safari-private-chat-light-14", app: "Safari", expectPrivate: true, expected: true, url: "http://127.0.0.1:1/b"},
    {case: "chrome-normal-chat-light-14", app: "Google Chrome", expectPrivate: false, expected: false, url: "http://127.0.0.1:1/c"},
    {case: "chrome-private-chat-light-14", app: "Google Chrome", expectPrivate: true, expected: false, url: "http://127.0.0.1:1/d"}
  ];

  /**
   * The other half of finding O1. Run #1 printed twenty URLs, the owner opened the five he had time
   * for, and the harness accepted the run on one of them. A list of the windows the run will be
   * judged on is a list somebody can finish.
   */
  it("prints ONLY the expected URLs, and says which sets they are", () => {
    const printed = formatObserveUrls(urls, ["safari-private"]);
    expect(printed).toContain("safari-private");
    expect(printed).toContain("http://127.0.0.1:1/b");
    for (const other of ["/a", "/c", "/d"]) expect(printed).not.toContain(`http://127.0.0.1:1${other}`);
    expect(printed).toContain("1 window(s)");
  });

  /** And with no expectation it prints them all, under the word that says the run cannot pass. */
  it("prints every URL on an exploratory run, and says it can never be accepted", () => {
    const printed = formatObserveUrls(urls, null);
    expect(printed).toContain("EXPLORATORY");
    expect(printed).toContain("never be ACCEPTED");
    for (const each of ["/a", "/b", "/c", "/d"]) expect(printed).toContain(`http://127.0.0.1:1${each}`);
  });

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

/**
 * Owner decision O8 on the terminal: the boolean beside the host on every observe row and progress
 * line, and the count beside the toolbar thresholds it is not one of.
 */
describe("the address-line finding, printed", () => {
  it("prints the boolean beside the host on an observe row", () => {
    const printed = formatSummary({
      ...accepted,
      observe: [{
        case: "safari-normal-chat-light-14", outcome: "ok", host: true, hostDistance: 0,
        addressLine: false, private: false, expectPrivate: false, bandPx: 41, privateBottomPx: null
      }],
      summary: {
        ...accepted.summary,
        observe: {
          staged: 1, read: 1, expect: null, expected: 0, missingCases: [], notCheckedCases: [],
          privateMissed: 0, falsePrivate: 0, incompleteCases: [], reason: "EXPLORATORY", passed: false
        },
        accepted: false
      }
    });
    expect(printed).toContain("host true dist 0 address false");
  });

  it("prints it on a progress line too", () => {
    const line = formatProgressLine({
      case: "safari-normal-chat-light-14", outcome: "ok", host: true, addressLine: false,
      private: false, asExpected: true, readAttempts: 1
    });
    expect(line).toContain("host true address false private false");
    // and a rule that was never asked prints as null, not as false
    expect(formatProgressLine({
      case: "c", outcome: "ok", host: null, addressLine: null, private: null,
      asExpected: false, readAttempts: 1
    })).toContain("address null");
  });

  /** The count, and the words that stop it being read as a threshold. */
  it("prints the toolbar count as information, not as a pass mark", () => {
    const printed = formatSummary({
      ...accepted,
      summary: {
        ...accepted.summary,
        toolbar: {
          captures: 40, hostHits: 20, hostHitsMin: 19, privateHits: 20, privateHitsMin: 20,
          falsePrivate: 0, falsePrivateMax: 0, addressLines: 3, incompleteCases: [], passed: true
        }
      }
    });
    expect(printed).toContain("addressLine 3/40");
    expect(printed).toContain("information only");
    // the verdict above it is untouched by the count
    expect(printed).toContain("PASS  toolbar");
  });

  /** A run whose every strip failed the rule still reports the verdict its thresholds decided. */
  it("does not turn a passing toolbar run into a failing one", () => {
    const results = {
      ...accepted,
      summary: {
        ...accepted.summary,
        toolbar: {
          captures: 40, hostHits: 20, hostHitsMin: 19, privateHits: 20, privateHitsMin: 20,
          falsePrivate: 0, falsePrivateMax: 0, addressLines: 0, incompleteCases: [], passed: true
        },
        accepted: true
      }
    };
    expect(formatSummary(results)).toContain("addressLine 0/40");
    expect(formatSummary(results)).toContain("PASS  toolbar");
    expect(formatSummary(results)).toContain("READER_EVAL ACCEPTED");
    expect(exitCodeFor(results)).toBe(0);
  });

  /** An older file that carries no count says nothing rather than printing an invented one. */
  it("says nothing about it when the file has no such count", () => {
    const printed = formatSummary({
      ...accepted,
      summary: {
        ...accepted.summary,
        toolbar: {
          captures: 40, hostHits: 20, hostHitsMin: 19, privateHits: 20, privateHitsMin: 20,
          falsePrivate: 0, falsePrivateMax: 0, incompleteCases: [], passed: true
        }
      }
    });
    expect(printed).not.toContain("addressLine");
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

/**
 * `--expect`, the option finding O1 is about. Run #1 printed twenty URLs, one window was read, and
 * the harness said ACCEPTED — because nothing in the run had ever said what it wanted.
 */
describe("--expect", () => {
  /** The same six the bundle has, which derives them from the case table. */
  it("offers exactly the harness's own sets", () => {
    expect([...EXPECT_SETS].sort()).toEqual([...OBSERVE_EXPECT_SETS].sort());
  });

  it.each([...EXPECT_SETS])("takes %s", (set) => {
    expect(parseExpectArg(set)).toBe(set);
    expect(parseEvalArgs(["observe", "--expect", set])).toMatchObject({ok: true, expect: set});
  });

  it("takes a comma list", () => {
    expect(parseExpectArg("safari-private,chrome-private")).toBe("safari-private,chrome-private");
  });

  it.each([
    ["a set it does not have", "safari-privat"],
    ["a set differing only in case", "Safari-private"],
    ["nothing at all", ""],
    ["a trailing comma", "safari,"],
    ["a repeat", "safari,safari"],
    ["spaces", "safari, chrome"],
    ["a missing value", undefined]
  ])("refuses %s, so the owner is told before a window opens", (_label, value) => {
    expect(parseExpectArg(value)).toBeNull();
    expect(parseEvalArgs(["observe", "--expect", value as string])).toEqual({ok: false, problem: "--expect"});
  });

  it.each(["accuracy", "toolbar", "coldstart"])("refuses one in %s, which stages its own windows", (mode) => {
    expect(OBSERVING_MODES).not.toContain(mode);
    expect(parseEvalArgs([mode, "--expect", "safari"])).toEqual({ok: false, problem: "--expect"});
  });

  it.each(["observe", "all"])("takes one in %s", (mode) => {
    expect(OBSERVING_MODES).toContain(mode);
    expect(parseEvalArgs([mode, "--expect", "safari"])).toMatchObject({ok: true, expect: "safari"});
  });

  /** The owner has to be able to find out what to type, and what happens if he does not. */
  it("is in the usage text, with every set and what its absence costs", () => {
    expect(USAGE).toContain("--expect");
    for (const set of EXPECT_SETS) expect(USAGE).toContain(set);
    expect(USAGE).toContain("EXPLORATORY");
  });

  /** Absent is "expect nothing", and an EMPTY variable is a refusal in the bundle, not a default. */
  it("reaches the bundle only when it was given", () => {
    expect(evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", expect: "safari-private"}, "/out/x.json", "n"))
      .toMatchObject({CLAVE_EVAL_EXPECT: "safari-private"});
    expect(Object.keys(evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", expect: null}, "/out/x.json", "n")))
      .not.toContain("CLAVE_EVAL_EXPECT");
  });
});

/** `--host`: the address the OWNER pastes into a browser, so the grammar is closed (finding O5). */
describe("--host", () => {
  it.each(["127.0.0.1", "localhost", "app.clave.localhost", "mail-2.corp.localhost"])("takes %s", (raw) => {
    expect(parseHostArg(raw)).toBe(raw);
    expect(parseEvalArgs(["observe", "--host", raw])).toMatchObject({ok: true, host: raw});
  });

  it.each([
    ["a name off the loopback reservation", "example.com"],
    ["an address that is not the loopback one", "10.0.0.1"],
    ["an uppercase name", "App.localhost"],
    ["a name with a port", "clave.localhost:8080"],
    ["a name with a path", "clave.localhost/x"],
    ["an empty label", "a..localhost"],
    // the three the bundle's own table has and this one was missing (review, Minor 6)
    ["the bare suffix", ".localhost"],
    ["a label starting with a hyphen", "-a.localhost"],
    ["a label ending with a hyphen", "a-.localhost"],
    ["nothing at all", ""],
    ["a missing value", undefined]
  ])("refuses %s, rather than pointing a private window at it", (_label, value) => {
    expect(parseHostArg(value)).toBeNull();
    expect(parseEvalArgs(["observe", "--host", value as string])).toEqual({ok: false, problem: "--host"});
  });

  /** The two grammars are held to the same table, not merely to the same bound (review, Minor 6). */
  it("agrees with the bundle's own rule on every value either table has", () => {
    for (const raw of [
      "127.0.0.1", "localhost", "app.clave.localhost", "mail-2.corp.localhost",
      "example.com", "10.0.0.1", "App.localhost", "clave.localhost:8080", "clave.localhost/x",
      ".localhost", "a..localhost", "-a.localhost", "a-.localhost", "", `${"a".repeat(64)}.localhost`
    ]) {
      expect(parseHostArg(raw), raw).toBe(parseObserveHost(raw));
    }
  });

  it("has the same length bound as the bundle", () => {
    expect(HOST_MAX).toBe(OBSERVE_HOST_MAX);
    expect(parseHostArg(`${"a".repeat(HOST_MAX)}.localhost`)).toBeNull();
    expect(USAGE).toContain("--host");
  });

  it.each(["accuracy", "toolbar", "coldstart"])("refuses one in %s, which prints no URL", (mode) => {
    expect(parseEvalArgs([mode, "--host", "app.clave.localhost"])).toEqual({ok: false, problem: "--host"});
  });

  it("reaches the bundle only when it was given", () => {
    expect(evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", host: "app.clave.localhost"}, "/out/x.json", "n"))
      .toMatchObject({CLAVE_EVAL_HOST: "app.clave.localhost"});
    expect(Object.keys(evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", host: null}, "/out/x.json", "n")))
      .not.toContain("CLAVE_EVAL_HOST");
  });
});

/**
 * Finding O3. The terminal side used to wait for a file with a fixed name, find the PREVIOUS run's
 * already there, and print its URLs: an old nonce on an old port, which this run could never approve.
 */
describe("this run's own files", () => {
  const withDir = (body: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-files-"));
    try { body(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
  };

  it("is named with the nonce, and the old fixed name is never one of them", () => {
    expect(observeUrlsName("abc123")).toBe("observe-urls-abc123.json");
    expect(observeProgressName("abc123")).toBe("observe-progress-abc123.json");
  });

  it("ignores a stale file left by another run, and reads this run's", () => {
    withDir((dir) => {
      // what run #1 printed: the previous run's file, under the old fixed name and under its nonce
      writeFileSync(join(dir, "observe-urls.json"), JSON.stringify({port: 1, nonce: "old", urls: [{url: "http://127.0.0.1:1/stale"}]}));
      writeFileSync(join(dir, observeUrlsName("older")), JSON.stringify({port: 2, nonce: "older", urls: [{url: "http://127.0.0.1:2/stale"}]}));
      expect(readRunFile(dir, observeUrlsName("mine"))).toBeNull();

      writeFileSync(join(dir, observeUrlsName("mine")), JSON.stringify({port: 3, nonce: "mine", expect: null, urls: []}));
      expect(readRunFile(dir, observeUrlsName("mine"))).toMatchObject({port: 3, nonce: "mine"});
    });
  });

  it("answers null for a file that is not there and for one that is half written", () => {
    withDir((dir) => {
      expect(readRunFile(dir, observeProgressName("mine"))).toBeNull();
      writeFileSync(join(dir, observeProgressName("mine")), "{\"rows\": [");
      expect(readRunFile(dir, observeProgressName("mine"))).toBeNull();
    });
  });

  it("clears this run's own two files before the bundle starts, and leaves other runs' alone", () => {
    withDir((dir) => {
      writeFileSync(join(dir, observeUrlsName("mine")), "{}");
      writeFileSync(join(dir, observeProgressName("mine")), "{}");
      writeFileSync(join(dir, observeUrlsName("other")), "{}");
      clearRunFiles(dir, "mine");
      expect(readRunFile(dir, observeUrlsName("mine"))).toBeNull();
      expect(readRunFile(dir, observeProgressName("mine"))).toBeNull();
      expect(readRunFile(dir, observeUrlsName("other"))).toEqual({});
      // and it never throws on a folder with nothing in it
      expect(() => clearRunFiles(dir, "mine")).not.toThrow();
    });
  });
});

/** The running commentary (finding O6): the owner waited twenty minutes with nothing on the terminal. */
describe("the progress lines", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    case: "safari-private-chat-light-14", outcome: "ok", host: true, addressLine: true,
    private: true, asExpected: true, readAttempts: 1, ...over
  });

  it("names the case, and prints the three booleans and nothing else", () => {
    const line = formatProgressLine(row());
    expect(line).toContain("safari-private-chat-light-14");
    expect(line).toContain("host true");
    expect(line).toContain("private true");
    expect(line).toContain("as-expected true");
  });

  /** A read that failed says so and says which attempt it was, rather than showing empty booleans. */
  it("says NOT READ and the outcome code for a read that failed", () => {
    const line = formatProgressLine(row({outcome: "windowGone", host: null, private: null, asExpected: false, readAttempts: 2}));
    expect(line).toContain("NOT READ: windowGone");
    expect(line).toContain("attempt 2");
    expect(line).not.toContain("as-expected");
  });

  /**
   * The whole table is rewritten after every read, so a finished case must not be printed once a
   * second — but a retry is worth a line, because it is the owner's cue that his window is being
   * tried again rather than ignored.
   */
  it("prints a case again when its outcome or its attempt count changed, and not otherwise", () => {
    expect(progressKey(row())).toBe(progressKey(row()));
    expect(progressKey(row())).not.toBe(progressKey(row({readAttempts: 2})));
    expect(progressKey(row())).not.toBe(progressKey(row({outcome: "windowGone"})));
    expect(progressKey(row())).not.toBe(progressKey(row({case: "safari-private-code-light-11"})));
    // a boolean changing is not a new line: the case is the same case, read the same number of times
    expect(progressKey(row())).toBe(progressKey(row({host: false})));
  });
});


/**
 * Review, Important 1 — the CALL SITE of the O3 fix, which had no test: reverting one line back to
 * the fixed file name left the whole suite green, so finding O3 could come straight back.
 *
 * `watchObserve` is driven here with no filesystem, no clock and no terminal: `read` records every
 * name it is asked for and answers only this run's, `print` collects the output, and `wait` is where
 * the fake run ends.
 */
describe("what the terminal watches while the run goes", () => {
  const NONCE = "abc123def456";
  const urlsFile = {
    port: 51234, nonce: NONCE, host: "127.0.0.1", expect: ["safari-private"],
    urls: [
      {case: "safari-private-chat-light-14", app: "Safari", expectPrivate: true, expected: true, url: "http://127.0.0.1:51234/mine"},
      {case: "safari-normal-chat-light-14", app: "Safari", expectPrivate: false, expected: false, url: "http://127.0.0.1:51234/other"}
    ]
  };
  const progressFile = (rows: Record<string, unknown>[]) => ({schema: 1, nonce: NONCE, expect: ["safari-private"], expected: 1, done: 0, rows});

  /**
   * The stale file finding O3 is about, sitting in the folder under the OLD fixed name and under
   * another run's nonce, answered eagerly by the fake. A watch that opens either prints its URLs.
   */
  const world = (rows: Record<string, unknown>[] = [], reveal: unknown = null) => {
    const asked: string[] = [];
    const printed: string[] = [];
    const removed: string[] = [];
    const claimed: string[] = [];
    const beats: string[] = [];
    const running = {done: false};
    let waits = 0;
    const stale = {port: 1, nonce: "old", expect: null, urls: [{case: "stale-case", app: "Safari", expectPrivate: false, expected: true, url: "http://127.0.0.1:1/STALE"}]};
    const io = {
      read: (name: string) => {
        asked.push(name);
        if (name === observeUrlsName(NONCE)) return urlsFile;
        if (name === observeProgressName(NONCE)) return progressFile(rows);
        // no reveal file unless the test made one: an ordinary run never writes it
        if (name === `${observeRevealName(NONCE)}.claimed`) return reveal;
        // anything else — the old fixed name, another run's nonce — is answered, on purpose
        return stale;
      },
      print: (text: string) => { printed.push(text); },
      wait: async () => { waits += 1; if (waits >= 2) running.done = true; },
      remove: (name: string) => { removed.push(name); },
      claim: (from: string, to: string) => { claimed.push(`${from} -> ${to}`); return reveal !== null; },
      beat: (name: string) => { beats.push(name); }
    };
    return {asked, printed, removed, claimed, beats, running, io, waits: () => waits};
  };

  it("opens this run's own files and NOTHING else", async () => {
    const {asked, beats, running, io} = world();
    await watchObserve("/out", NONCE, running, io);
    expect(asked.length).toBeGreaterThan(0);
    expect([...new Set(asked)].sort())
      .toEqual([observeProgressName(NONCE), observeUrlsName(NONCE)].sort());
    // and the heartbeat it rewrites is this run's too
    expect([...new Set(beats)]).toEqual([observeAliveName(NONCE)]);
    // the exact bug: the fixed name is never among them
    expect(asked).not.toContain("observe-urls.json");
    for (const name of asked) expect(name).toContain(NONCE);
  });

  it("prints this run's URLs and never a stale file's", async () => {
    const {printed, running, io} = world();
    await watchObserve("/out", NONCE, running, io);
    const all = printed.join("");
    expect(all).toContain("http://127.0.0.1:51234/mine");
    expect(all).not.toContain("STALE");
    // and only the expected row of this run's own file
    expect(all).not.toContain("http://127.0.0.1:51234/other");
  });

  /** Finding O6: a line per newly finished case, and not one per poll. */
  it("prints one line per case as it finishes, and does not repeat it", async () => {
    const {printed, running, io} = world([
      {case: "safari-private-chat-light-14", outcome: "ok", host: true, private: true, asExpected: true, readAttempts: 1}
    ]);
    await watchObserve("/out", NONCE, running, io);
    const lines = printed.join("").split(String.fromCharCode(10)).filter((line) => line.startsWith("  read "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("safari-private-chat-light-14");
    expect(lines[0]).toContain("as-expected true");
  });

  /**
   * The symmetrical tripwire to `main.ts`'s (`helper.test.ts`): the string that WAS the bug does not
   * appear in this half at all, in code or in a comment, so a revert cannot hide in either.
   */
  it("holds the fixed file name nowhere in its source", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("observe-urls.json");
    expect(source).toContain("observe-urls-${nonce}.json");
  });

  it("names the files it may open, and none of them is a fixed name", () => {
    expect(observeFilesFor(NONCE)).toEqual({
      urls: `observe-urls-${NONCE}.json`,
      progress: `observe-progress-${NONCE}.json`,
      reveal: `observe-reveal-${NONCE}.json`,
      claimed: `observe-reveal-${NONCE}.json.claimed`,
      alive: `observe-alive-${NONCE}`
    });
    expect(observeFilesFor("other").urls).not.toBe(observeFilesFor(NONCE).urls);
  });
});

/** Review, Minor 7: the terminal is where a string from a file reaches a human's screen. */
describe("what the terminal will print from a file", () => {
  it("prints a case name and an outcome code, and a question mark for anything else", () => {
    expect(fixedCode("safari-private-chat-light-14")).toBe("safari-private-chat-light-14");
    expect(fixedCode("windowGone")).toBe("windowGone");
    for (const bad of ["../../etc", "a b", "a/b", "a.b", "", 7, null, undefined, "x".repeat(65)]) {
      expect(fixedCode(bad)).toBe("?");
    }
  });

  it("keeps a smuggled string out of a progress line and out of its key", () => {
    const row = {case: "rm -rf /tmp SMUGGLED", outcome: "ok\nSMUGGLED", host: "SMUGGLED", private: "SMUGGLED", asExpected: "SMUGGLED", readAttempts: 1e9};
    expect(formatProgressLine(row)).not.toContain("SMUGGLED");
    expect(progressKey(row)).not.toContain("SMUGGLED");
  });
});

/** Review, Minor 8: a file of a schema this half cannot read must not be summarised as a pass. */
describe("a results file from another schema", () => {
  const old = {...accepted, schema: 4};

  it("says so, and never reports exit 0 for it", () => {
    expect(knownSchema(accepted)).toBe(true);
    expect(knownSchema(old)).toBe(false);
    expect(formatSummary(old)).toContain("OLD RESULTS FILE: schema 4");
    expect(exitCodeFor(old)).toBe(2);
    // the schema this terminal reads is the one the bundle stamps
    expect(RESULTS_SCHEMA).toBe(6);
  });

  it("still reads a file that carries no schema at all, as it always did", () => {
    const {schema: _ignored, ...bare} = accepted;
    expect(knownSchema(bare)).toBe(true);
    expect(exitCodeFor(bare)).toBe(0);
  });
});

/**
 * The reveal flag on the terminal side. It is the only channel in this harness that prints
 * recognised text, so the tests are about the fence: refused outside an exploratory observe run,
 * printed once, deleted at once, and deleted again however the run ends.
 */
describe("--reveal-toolbar", () => {
  it("is taken in an exploratory observe run", () => {
    expect(parseEvalArgs(["observe", "--reveal-toolbar"])).toMatchObject({ok: true, mode: "observe", reveal: true});
    expect(REVEALING_MODE).toBe("observe");
  });

  /** Both fences, on the terminal side, matching `REVEAL_NOT_APPLICABLE` in the bundle. */
  it.each(["accuracy", "toolbar", "all", "coldstart"])("is refused in %s", (mode) => {
    expect(parseEvalArgs([mode, "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
  });

  it("is refused beside an expectation, in either order", () => {
    expect(parseEvalArgs(["observe", "--reveal-toolbar", "--expect", "safari"]))
      .toEqual({ok: false, problem: "--reveal-toolbar"});
    expect(parseEvalArgs(["observe", "--expect", "safari-private", "--reveal-toolbar"]))
      .toEqual({ok: false, problem: "--reveal-toolbar"});
  });

  it("takes no value of its own", () => {
    // the flag does not swallow the next argument
    expect(parseEvalArgs(["observe", "--reveal-toolbar", "--seconds", "30"]))
      .toMatchObject({ok: true, reveal: true, seconds: 30});
  });

  it("reaches the bundle only when it was asked for, and only as the one value", () => {
    const on = evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", reveal: true}, "/out/x.json", "n");
    expect(on.CLAVE_EVAL_REVEAL_TOOLBAR).toBe(REVEAL_ON);
    const off = evalEnv({mode: "observe", repetitions: 5, seconds: 120, variant: "none", reveal: false}, "/out/x.json", "n");
    expect(Object.keys(off)).not.toContain("CLAVE_EVAL_REVEAL_TOOLBAR");
  });

  /** The owner has to be told the one thing that decides what lands on his terminal. */
  it("tells the owner in the usage text what it shows and to use a single-tab window", () => {
    expect(USAGE).toContain("--reveal-toolbar");
    expect(USAGE).toContain("SINGLE-TAB");
    expect(USAGE).toContain("never the page body");
    expect(USAGE).toContain("without");
  });
});

describe("the revealed lines", () => {
  const row = {
    case: "safari-normal-chat-light-14", bandPx: 41, toolbarText: "127.0.0.1/chat.html",
    toolbarTextLength: 19, linesInBand: 1,
    lines: [{text: "127.0.0.1/chat.html", length: 19, topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200}]
  };

  it("marks every line REVEAL and names the case it came from", () => {
    const printed = formatRevealRow(row);
    for (const line of printed.split(String.fromCharCode(10)).filter((entry) => entry.length > 0)) {
      expect(line).toContain("REVEAL safari-normal-chat-light-14:");
    }
    expect(printed).toContain("strip[19] \"127.0.0.1/chat.html\"");
    expect(printed).toContain("line 16-37px x10-200px [19]");
  });

  it("says how many lines of the band it is not showing", () => {
    expect(formatRevealRow({...row, linesInBand: 5})).toContain("4 more line(s) in the band, not shown");
    expect(formatRevealRow(row)).not.toContain("more line(s)");
  });

  /** A terminal is the one place a raw control byte must not land, whatever is in the file. */
  it("prints no control character and no stray quote, whatever the file holds", () => {
    const nasty = `a${String.fromCharCode(27)}[2Jb${String.fromCharCode(0)}c"d`;
    const printed = formatRevealRow({...row, toolbarText: nasty, lines: [{...row.lines[0], text: nasty}]});
    expect(printed).not.toContain(String.fromCharCode(27));
    expect(printed).not.toContain(String.fromCharCode(0));
    expect(quoted(nasty)).toBe("\"a?[2Jb?c?d\"");
    expect(quoted(7)).toBe("?");
  });
});

/**
 * Where the revealed text goes, and how long it lives: printed once, deleted at once, and deleted
 * again on the way out however the run ended.
 */
describe("the reveal file's life", () => {
  const NONCE = "abc123def456";
  const revealFile = {
    schema: 1, nonce: NONCE,
    rows: [{
      case: "safari-normal-chat-light-14", bandPx: 41, toolbarText: "127.0.0.1/chat.html",
      toolbarTextLength: 19, linesInBand: 1,
      lines: [{text: "127.0.0.1/chat.html", length: 19, topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200}]
    }]
  };
  const claimedName = `${observeRevealName(NONCE)}.claimed`;
  const watching = (reveal: unknown) => {
    const printed: string[] = [];
    const removed: string[] = [];
    const claims: string[] = [];
    const running = {done: false};
    let waits = 0;
    /** The file as the bundle left it; a claim moves it, so it can never be read twice. */
    let onDisk = reveal;
    let held: unknown = null;
    const io = {
      read: (name: string) => {
        if (name === observeUrlsName(NONCE)) return {port: 1, nonce: NONCE, expect: null, urls: []};
        if (name === observeProgressName(NONCE)) return {schema: 1, rows: []};
        if (name === claimedName) return held;
        return null;
      },
      print: (text: string) => { printed.push(text); },
      wait: async () => { waits += 1; if (waits >= 3) running.done = true; },
      remove: (name: string) => { removed.push(name); if (name === claimedName) held = null; },
      // rename: it succeeds only when the bundle's file is there, and it MOVES it
      claim: (from: string, to: string) => {
        claims.push(`${from} -> ${to}`);
        if (onDisk === null) return false;
        held = onDisk;
        onDisk = null;
        return true;
      },
      beat: () => undefined
    };
    return {printed, removed, claims, running, io};
  };

  it("prints the strip once and deletes the file at once", async () => {
    const {printed, removed, claims, running, io} = watching(revealFile);
    await watchObserve("/out", NONCE, running, io, {reveal: true});
    const lines = printed.join("").split(String.fromCharCode(10)).filter((line) => line.includes("REVEAL"));
    expect(lines).toHaveLength(2);                       // the strip and its one line
    expect(printed.join("")).toContain("127.0.0.1/chat.html");
    // claimed by rename first, so a write landing mid-sweep cannot be deleted unread
    expect(claims[0]).toBe(`${observeRevealName(NONCE)} -> ${claimedName}`);
    expect(removed).toContain(claimedName);
    // and it is not printed again on the next poll, even if the bundle rewrites the file
    expect(lines.filter((line) => line.includes("strip["))).toHaveLength(1);
  });

  it("removes nothing and prints nothing when the run never revealed", async () => {
    const {printed, removed, running, io} = watching(null);
    await watchObserve("/out", NONCE, running, io, {reveal: true});
    expect(printed.join("")).not.toContain("REVEAL");
    expect(removed).toEqual([]);
  });

  /**
   * Review, Important 2, terminal half: an ordinary run cannot PRINT a strip even if one is sitting
   * beside it — but it still sweeps the file away. Two independent locks, as everywhere else here.
   */
  it("sweeps a stray strip away without printing it when the run did not ask to reveal", async () => {
    const {printed, removed, running, io} = watching(revealFile);
    await watchObserve("/out", NONCE, running, io, {reveal: false});
    expect(printed.join("")).not.toContain("REVEAL");
    expect(printed.join("")).not.toContain("127.0.0.1/chat.html");
    expect(removed).toContain(claimedName);
  });

  /** And the default is the closed one: no options at all is a run that did not ask. */
  it("does not print a strip when it was given no options at all", async () => {
    const {printed, running, io} = watching(revealFile);
    await watchObserve("/out", NONCE, running, io);
    expect(printed.join("")).not.toContain("REVEAL");
  });

  it("is one of the files cleared before the bundle starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-reveal-"));
    try {
      writeFileSync(join(dir, observeRevealName(NONCE)), "{}");
      writeFileSync(join(dir, observeRevealName("other")), "{}");
      clearRunFiles(dir, NONCE);
      expect(readRunFile(dir, observeRevealName(NONCE))).toBeNull();
      expect(readRunFile(dir, observeRevealName("other"))).toEqual({});
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /**
   * And gone on EVERY path out: `process.exit` does not run a `finally`, which is why the run
   * computes an exit code inside this wrapper and the single exit is outside it.
   */
  it("is deleted after a clean finish, after a refusal and after a throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-reveal-"));
    try {
      const put = () => writeFileSync(join(dir, observeRevealName(NONCE)), JSON.stringify(revealFile));

      put();
      expect(await withRevealCleanup(dir, NONCE, async () => 0)).toBe(0);
      expect(readRunFile(dir, observeRevealName(NONCE))).toBeNull();

      put();
      expect(await withRevealCleanup(dir, NONCE, async () => 1)).toBe(1);
      expect(readRunFile(dir, observeRevealName(NONCE))).toBeNull();

      put();
      await expect(withRevealCleanup(dir, NONCE, async () => { throw new Error("OPEN_EXIT"); }))
        .rejects.toThrow("OPEN_EXIT");
      expect(readRunFile(dir, observeRevealName(NONCE))).toBeNull();

      // and it never throws on a folder with nothing in it
      expect(() => clearRevealFile(dir, NONCE)).not.toThrow();
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /** The program half leaves through one exit, and that exit is outside the cleanup wrapper. */
  it("wraps the whole run in that cleanup, in the source", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).toContain("process.exit(await withRevealCleanup(outDir, nonce, () => runEval(options, outDir, nonce)))");
    // and `runEval` returns codes rather than exiting, or the `finally` would never run
    expect(source.slice(source.indexOf("async function runEval"), source.indexOf("async function main")))
      .not.toContain("process.exit");
  });
});

/**
 * Review, Important 1a and 1b: the two paths that leave recognised text on disk when the terminal
 * does not get to run its `finally` — a signal, and a kill that runs nothing at all.
 */
describe("a terminal that is killed", () => {
  const NONCE = "abc123def456";

  it("clears this run's strips and exits, on each of the three signals", () => {
    const handlers: Record<string, () => void> = {};
    const cleared: string[] = [];
    const exits: number[] = [];
    installRevealSignalHandlers("/out", NONCE, {
      on: (signal, handler) => { handlers[signal] = handler; },
      exit: (code) => { exits.push(code); },
      clear: (dir, nonce) => { cleared.push(`${dir}/${nonce}`); }
    });
    expect(Object.keys(handlers).sort()).toEqual([...REVEAL_SIGNALS].sort());
    expect(REVEAL_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    for (const signal of REVEAL_SIGNALS) {
      handlers[signal]?.();
    }
    expect(cleared).toEqual([`/out/${NONCE}`, `/out/${NONCE}`, `/out/${NONCE}`]);
    expect(exits).toEqual([REVEAL_SIGNAL_EXIT, REVEAL_SIGNAL_EXIT, REVEAL_SIGNAL_EXIT]);
    expect(REVEAL_SIGNAL_EXIT).toBe(130);
  });

  /** The clearing takes the `.partial` and the heartbeat with it, not only the final file. */
  it("clears the half-written sibling and the heartbeat too", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-kill-"));
    try {
      for (const name of [observeRevealName(NONCE), partialOf(observeRevealName(NONCE)), observeAliveName(NONCE)]) {
        writeFileSync(join(dir, name), "SMUGGLED-STRIP");
      }
      clearRevealFile(dir, NONCE);
      for (const name of [observeRevealName(NONCE), partialOf(observeRevealName(NONCE)), observeAliveName(NONCE)]) {
        expect(existsSync(join(dir, name)), name).toBe(false);
      }
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /**
   * And the case no in-process fix can reach: SIGKILL, or a machine that lost power, leaves a file
   * this run's nonce will never name. The next run sweeps the folder.
   */
  it("sweeps every run's orphaned strips at start, not only this run's", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-orphan-"));
    try {
      const orphans = [
        observeRevealName("deadbeef0001"),
        partialOf(observeRevealName("deadbeef0002")),
        observeAliveName("deadbeef0003"),
        observeRevealName(NONCE)
      ];
      for (const name of orphans) writeFileSync(join(dir, name), "SMUGGLED-STRIP");
      // and files that are NOT ours, which must survive
      const keep = ["observe-urls-deadbeef0001.json", "observe-progress-deadbeef0001.json", "accuracy-deadbeef0001.json"];
      for (const name of keep) writeFileSync(join(dir, name), "{}");

      expect(sweepRevealOrphans(dir)).toBe(orphans.length);
      for (const name of orphans) expect(existsSync(join(dir, name)), name).toBe(false);
      for (const name of keep) expect(existsSync(join(dir, name)), name).toBe(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("knows which names are its own to sweep", () => {
    expect(isRevealOrphan(observeRevealName("x"))).toBe(true);
    expect(isRevealOrphan(partialOf(observeRevealName("x")))).toBe(true);
    expect(isRevealOrphan(observeAliveName("x"))).toBe(true);
    for (const other of ["observe-urls-x.json", "observe-progress-x.json", "accuracy-x.json", "", 7, null]) {
      expect(isRevealOrphan(other as never), String(other)).toBe(false);
    }
  });

  it("never throws on a folder that is not there", () => {
    expect(sweepRevealOrphans(join(tmpdir(), "clave-eval-no-such-folder-12345"))).toBe(0);
  });

  /** The program half has to actually install them, and sweep, before it opens anything. */
  it("installs the handlers and sweeps orphans before the bundle is launched", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    const swept = source.indexOf("sweepRevealOrphans(outDir)");
    const installed = source.indexOf("installRevealSignalHandlers(outDir, nonce)");
    const launched = source.indexOf("process.exit(await withRevealCleanup");
    expect(swept).toBeGreaterThan(-1);
    expect(installed).toBeGreaterThan(swept);
    expect(launched).toBeGreaterThan(installed);
  });
});

/**
 * Review, Minor 1: the terminal keeps the same table as the bundle, because it cannot import it.
 * This is what holds the two to the same answer.
 */
describe("the terminal's unsafe-character table", () => {
  it("agrees with the bundle's on every boundary of every range", () => {
    const boundaries = [
      0x00, 0x01, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x9b, 0x9f, 0xa0,
      0x061b, 0x061c, 0x061d, 0x200a, 0x200b, 0x200f, 0x2010,
      0x2027, 0x2028, 0x2029, 0x202a, 0x202e, 0x202f,
      0x205f, 0x2060, 0x2061, 0x2065, 0x2066, 0x2069, 0x206a,
      0xfefe, 0xfeff, 0xff00, 0x1f600
    ];
    for (const code of boundaries) {
      expect(revealUnsafeCodePoint(code), `U+${code.toString(16)}`).toBe(bundleUnsafe(code));
    }
  });

  it("keeps the reviewer's probe string off the terminal", () => {
    const probe = `safe${String.fromCodePoint(0x202e)}gpj.exe${String.fromCodePoint(0x200b)}${String.fromCodePoint(0x9b)}[2J`;
    expect(quoted(probe)).toBe("\"safe?gpj.exe??[2J\"");
    for (const code of [0x202e, 0x200b, 0x9b]) {
      expect(quoted(probe)).not.toContain(String.fromCodePoint(code));
    }
  });
});

/**
 * The re-review's four residual minors, on the terminal side.
 */
describe("the last names the strips can be under", () => {
  const NONCE = "abc123def456";

  /** Re-review, Minor A: `.claimed` holds the strips between the rename and the unlink. */
  it("clears the claimed copy as well as the file, its partial and the heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-claimed-"));
    try {
      const names = [...revealFileNames(NONCE), observeAliveName(NONCE)];
      expect(names).toContain(claimedOf(observeRevealName(NONCE)));
      for (const name of names) writeFileSync(join(dir, name), "SMUGGLED-STRIP");
      clearRevealFile(dir, NONCE);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /** And a crash between the rename and the unlink leaves nothing the next start does not sweep. */
  it("sweeps a claimed copy left by a crash, whatever run it belonged to", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-claimed-"));
    try {
      const orphans = [
        claimedOf(observeRevealName("deadbeef0001")),
        claimedOf(observeRevealName(NONCE)),
        partialOf(observeRevealName("deadbeef0002"))
      ];
      for (const name of orphans) {
        expect(isRevealOrphan(name), name).toBe(true);
        writeFileSync(join(dir, name), "SMUGGLED-STRIP");
      }
      expect(sweepRevealOrphans(dir)).toBe(orphans.length);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("agrees with the bundle on what those names are", () => {
    expect(revealFileNames(NONCE)).toEqual(bundleRevealFileNames(NONCE));
  });
});

/** Re-review, Minor B: the folder mode, at the place the production code creates it. */
describe("the folder the strips live in", () => {
  it("is created for the owner alone by the program half", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).toContain("mkdirSync(outDir, {recursive: true, mode: 0o700})");
  });
});

/** Re-review, Minor C: two things that were right and untested. */
describe("a throw that reaches the top of the program half", () => {
  it("prints a fixed code and exits 1, with no stack and no path", () => {
    const written = [];
    const exits = [];
    reportHarnessFailure({write: (text) => written.push(text), exit: (code) => exits.push(code)});
    expect(written).toEqual(["READER_EVAL_FAILED HARNESS\n"]);
    expect(written.join("")).not.toContain("/");
    expect(exits).toEqual([HARNESS_FAILURE_EXIT]);
    expect(HARNESS_FAILURE_EXIT).toBe(1);
  });

  /** And by the time it runs, the strips are already gone: the `finally` is inside the call. */
  it("leaves no strip behind when the run it wrapped threw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-throw-"));
    try {
      const NONCE = "abc123def456";
      for (const name of [...revealFileNames(NONCE), observeAliveName(NONCE)]) {
        writeFileSync(join(dir, name), "SMUGGLED-STRIP");
      }
      const written = [];
      const exits = [];
      await expect(withRevealCleanup(dir, NONCE, async () => { throw new Error("EPIPE"); }))
        .rejects.toThrow("EPIPE");
      reportHarnessFailure({write: (text) => written.push(text), exit: (code) => exits.push(code)});
      expect(readdirSync(dir)).toEqual([]);
      expect(written).toEqual(["READER_EVAL_FAILED HARNESS\n"]);
      expect(exits).toEqual([1]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("is what the program half's catch calls", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).toContain("  try {\n    await main();\n  } catch {\n    reportHarnessFailure();\n  }");
  });
});

/** Re-review, Minor C: a heartbeat carries a timestamp and nothing else. */
describe("the heartbeat", () => {
  it("holds zero bytes, and is the owner's alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-beat-"));
    try {
      const path = join(dir, observeAliveName("abc123def456"));
      writeHeartbeat(path, {writeFile: writeFileSync});
      expect(statSync(path).size).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(HEARTBEAT_CONTENTS).toBe("");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("carries nothing about the run, not even its nonce", () => {
    const seen = [];
    writeHeartbeat("/out/observe-alive-abc123def456", {
      writeFile: (path, contents, options) => { seen.push({path, contents, mode: options.mode}); }
    });
    expect(seen).toEqual([{path: "/out/observe-alive-abc123def456", contents: "", mode: 0o600}]);
  });
});

/** Re-review, Minor D: the first beat comes before the URL wait, not after it. */
describe("when the heartbeat starts", () => {
  const NONCE = "abc123def456";

  it("beats before it waits for the URL file, and again inside the wait", async () => {
    const order = [];
    const running = {done: false};
    let waits = 0;
    await watchObserve("/out", NONCE, running, {
      // the URL file never arrives, so the whole first stretch is the wait
      read: (name) => { order.push(`read ${name}`); return null; },
      print: () => undefined,
      wait: async () => { waits += 1; if (waits >= 3) running.done = true; },
      remove: () => undefined,
      claim: () => false,
      beat: (name) => { order.push(`beat ${name}`); }
    }, {reveal: true});
    expect(order[0]).toBe(`beat ${observeAliveName(NONCE)}`);
    // and it kept beating while it waited, rather than waiting twenty seconds in silence
    expect(order.filter((entry) => entry.startsWith("beat"))).not.toHaveLength(1);
    expect(order.indexOf(`beat ${observeAliveName(NONCE)}`))
      .toBeLessThan(order.indexOf(`read ${observeUrlsName(NONCE)}`));
  });

  /** The order is structural, not incidental: the source says so too. */
  it("has its first beat above the URL wait in the source", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    const watch = source.indexOf("export async function watchObserve");
    const firstBeat = source.indexOf("beat(files.alive);", watch);
    const urlWait = source.indexOf("for (let tries = 0; tries < URLS_WAIT_TRIES", watch);
    expect(firstBeat).toBeGreaterThan(-1);
    expect(urlWait).toBeGreaterThan(-1);
    expect(firstBeat).toBeLessThan(urlWait);
  });
});

/** The one thing the real run taught: a signal to a wrapper never reaches this process. */
describe("how to stop a run", () => {
  it("says to press Ctrl-C in the terminal that runs it", () => {
    expect(USAGE).toContain("Ctrl-C in the terminal that RUNS it");
    expect(USAGE).toContain("pnpm or sh wrapper");
  });
});
