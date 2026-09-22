// Tests the pure half of app/scripts/reader-eval.mjs, in plain Node. Same arrangement as
// dev-launcher.test.ts: the script's program half is gated on argv[1], so importing it here never
// opens a bundle, and app/tsconfig.json's `include` is src/**/*.ts, so this file is run by vitest
// and type-checked by nobody -- which is why the interop below is a plain namespace import.
import {describe, expect, it} from "vitest";
import * as cli from "./reader-eval.mjs";

const {parseEvalArgs, openArgs, evalEnv, formatSummary, exitCodeFor, USAGE, MODES} = cli as {
  parseEvalArgs: (argv: string[]) => Record<string, unknown>;
  openArgs: (bundle: string, env: Record<string, string>) => string[];
  evalEnv: (options: Record<string, unknown>, outFile: string, nonce: string) => Record<string, string>;
  formatSummary: (results: unknown) => string;
  exitCodeFor: (results: unknown) => number;
  USAGE: string;
  MODES: string[];
};

describe("the command line", () => {
  it("defaults to the accuracy run with five repetitions", () => {
    expect(parseEvalArgs([])).toEqual({ok: true, mode: "accuracy", repetitions: 5, seconds: 120, variant: "none"});
  });

  it("drops the leading -- that pnpm adds", () => {
    expect(parseEvalArgs(["--", "toolbar"])).toMatchObject({ok: true, mode: "toolbar"});
  });

  it.each(["accuracy", "toolbar", "observe", "all"])("takes %s as a mode", (mode) => {
    expect(parseEvalArgs([mode])).toMatchObject({ok: true, mode});
    expect(MODES).toContain(mode);
  });

  it("refuses a mode it does not have", () => {
    expect(parseEvalArgs(["everything"])).toEqual({ok: false, problem: "everything"});
  });

  it("takes the three options", () => {
    expect(parseEvalArgs(["accuracy", "--repetitions", "3", "--seconds", "30", "--variant", "bookmarks-bar"]))
      .toEqual({ok: true, mode: "accuracy", repetitions: 3, seconds: 30, variant: "bookmarks-bar"});
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

  it("has a usage text that names every mode", () => {
    for (const mode of MODES) expect(USAGE).toContain(mode);
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
  schema: 1, mode: "accuracy", nonce: "abc", repetitions: 5, chromeVariant: "none",
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
