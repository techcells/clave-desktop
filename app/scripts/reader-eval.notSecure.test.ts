// The terminal half of `toolbar --not-secure` (owner decision "A", 2026-09-21). Same arrangement as
// reader-eval.test.ts: the script's program half is gated on argv[1], so importing it here never
// opens a bundle, a browser or a window.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {TOOLBAR_CASES} from "../src/readerEval/cases";
import {NOT_SECURE_ON as BUNDLE_NOT_SECURE_ON, readEvalSettings} from "../src/readerEval/config";
import {NO_STATS, serialiseResults} from "../src/readerEval/results";
import {exploratoryOf, summarise} from "../src/readerEval/summary";
import {NOT_SECURE_HOST as BUNDLE_NOT_SECURE_HOST} from "../src/readerEval/stage";
import * as cli from "./reader-eval.mjs";

const {
  parseEvalArgs, mayRevealArgs, evalEnv, formatSummary, exitCodeFor, watchObserve, watchPlanFor, formatRevealRow, revealCaseName,
  fixedCode, observeUrlsName, observeProgressName, observeRevealName, observeAliveName,
  NOT_SECURE_ON, NOT_SECURE_HOST, NOT_SECURE_MODE, RESULTS_SCHEMA, USAGE, MODES,
  isNotSecure, typedNotSecure, MARKER_MISSING_LINE, CASE_NAME_WIDTH
} = cli as {
  isNotSecure: (results: unknown) => boolean;
  typedNotSecure: (options: unknown) => boolean;
  MARKER_MISSING_LINE: string;
  CASE_NAME_WIDTH: number;
  mayRevealArgs: (options: Record<string, unknown>) => boolean;
  parseEvalArgs: (argv: string[]) => Record<string, unknown> & {ok: boolean; problem?: string};
  evalEnv: (options: Record<string, unknown>, outFile: string, nonce: string) => Record<string, string>;
  formatSummary: (results: unknown, options?: unknown) => string;
  exitCodeFor: (results: unknown, options?: unknown) => number;
  watchObserve: (
    outDir: string, nonce: string, running: {done: boolean}, io?: Record<string, unknown>, options?: Record<string, unknown>
  ) => Promise<void>;
  watchPlanFor: (options: Record<string, unknown>) => {reveal: boolean; urls: boolean} | null;
  formatRevealRow: (row: Record<string, unknown>) => string;
  revealCaseName: (value: unknown) => string;
  fixedCode: (value: unknown) => string;
  observeUrlsName: (nonce: string) => string;
  observeProgressName: (nonce: string) => string;
  observeRevealName: (nonce: string) => string;
  observeAliveName: (nonce: string) => string;
  NOT_SECURE_ON: string;
  NOT_SECURE_HOST: string;
  NOT_SECURE_MODE: string;
  RESULTS_SCHEMA: number;
  USAGE: string;
  MODES: string[];
};

const NONCE = "abc123def456";
const NL = String.fromCharCode(10);

describe("asking for the variant on the command line", () => {
  it("is off unless asked", () => {
    expect(parseEvalArgs(["toolbar"])).toMatchObject({ok: true, notSecure: false});
    expect(parseEvalArgs([])).toMatchObject({ok: true, notSecure: false});
  });

  it("is a flag with no value, for toolbar only", () => {
    expect(NOT_SECURE_MODE).toBe("toolbar");
    expect(parseEvalArgs(["toolbar", "--not-secure"])).toMatchObject({ok: true, mode: "toolbar", notSecure: true});
    // it takes no argument: what follows it is still read as a flag
    expect(parseEvalArgs(["toolbar", "--not-secure", "--limit", "4"])).toMatchObject({ok: true, notSecure: true, limit: 4});
    expect(parseEvalArgs(["toolbar", "--not-secure", "clave-eval.test"])).toMatchObject({ok: false});
    expect(parseEvalArgs(["toolbar", "--not-secure=evil.example"])).toMatchObject({ok: false});
  });

  it.each(["accuracy", "observe", "all", "coldstart"])("is refused in %s", (mode) => {
    expect(parseEvalArgs([mode, "--not-secure"])).toEqual({ok: false, problem: "--not-secure"});
  });

  it("is refused with no mode at all, which is accuracy", () => {
    expect(parseEvalArgs(["--not-secure"])).toEqual({ok: false, problem: "--not-secure"});
  });

  it("is refused beside --host, in any order, and --host is as closed as it was", () => {
    expect(parseEvalArgs(["toolbar", "--not-secure", "--host", "a.localhost"])).toEqual({ok: false, problem: "--not-secure"});
    expect(parseEvalArgs(["toolbar", "--host", "127.0.0.1", "--not-secure"])).toEqual({ok: false, problem: "--not-secure"});
    expect(parseEvalArgs(["all", "--host", "a.localhost", "--not-secure"])).toEqual({ok: false, problem: "--not-secure"});
    expect(parseEvalArgs(["observe", "--host", "clave-eval.test"])).toEqual({ok: false, problem: "--host"});
    expect(parseEvalArgs(["toolbar", "--host", "a.localhost"])).toEqual({ok: false, problem: "--host"});
  });

  it("takes the first real run as the owner will type it", () => {
    expect(parseEvalArgs(["--", "toolbar", "--not-secure", "--limit", "4", "--reveal-toolbar"]))
      .toMatchObject({ok: true, mode: "toolbar", notSecure: true, limit: 4, reveal: true, host: null, expect: null});
  });
});

describe("revealing on the command line", () => {
  it("is allowed beside toolbar --not-secure and stays refused for every other staged run", () => {
    expect(parseEvalArgs(["toolbar", "--not-secure", "--reveal-toolbar"])).toMatchObject({ok: true, reveal: true});
    expect(parseEvalArgs(["toolbar", "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
    expect(parseEvalArgs(["toolbar", "--limit", "4", "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
    expect(parseEvalArgs(["accuracy", "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
    expect(parseEvalArgs(["all", "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
    expect(parseEvalArgs(["coldstart", "--reveal-toolbar"])).toEqual({ok: false, problem: "--reveal-toolbar"});
    for (const mode of ["accuracy", "all", "coldstart"]) {
      expect(parseEvalArgs([mode, "--not-secure", "--reveal-toolbar"]).ok).toBe(false);
    }
  });

  it("may reveal in exactly the two situations the bundle allows", () => {
    const allowed: string[] = [];
    for (const mode of MODES) {
      for (const expect of [null, "safari"]) {
        for (const notSecure of [false, true, "1"]) {
          if (mayRevealArgs({mode, expect, notSecure})) allowed.push(`${mode} ${expect === null ? "-" : "expect"} ${String(notSecure)}`);
        }
      }
    }
    expect(allowed).toEqual(["toolbar - true", "toolbar expect true", "observe - false", "observe - true", "observe - 1"]);
  });

  it("keeps the observe fence where it was", () => {
    expect(parseEvalArgs(["observe", "--reveal-toolbar"])).toMatchObject({ok: true, reveal: true});
    expect(parseEvalArgs(["observe", "--reveal-toolbar", "--expect", "safari"])).toEqual({ok: false, problem: "--reveal-toolbar"});
  });
});

describe("what the bundle is told", () => {
  const base = {mode: "toolbar", repetitions: 5, seconds: 120, variant: "none"};

  it("sets the variable only when asked, and only to the one value the bundle takes", () => {
    expect(NOT_SECURE_ON).toBe(BUNDLE_NOT_SECURE_ON);
    expect(evalEnv({...base, notSecure: true}, "/o.json", NONCE).CLAVE_EVAL_NOT_SECURE).toBe("1");
    expect("CLAVE_EVAL_NOT_SECURE" in evalEnv(base, "/o.json", NONCE)).toBe(false);
    expect("CLAVE_EVAL_NOT_SECURE" in evalEnv({...base, notSecure: false}, "/o.json", NONCE)).toBe(false);
    expect("CLAVE_EVAL_NOT_SECURE" in evalEnv({...base, notSecure: "1"}, "/o.json", NONCE)).toBe(false);
  });

  it("never sends a host: the name is the bundle's constant, not an input", () => {
    const env = evalEnv({...base, notSecure: true, limit: 4, reveal: true, host: null}, "/o.json", NONCE);
    expect("CLAVE_EVAL_HOST" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain("clave-eval");
    expect(NOT_SECURE_HOST).toBe(BUNDLE_NOT_SECURE_HOST);
    expect(NOT_SECURE_HOST).toBe("clave-eval.test");
  });

  it("is accepted by the bundle's own reading of it, end to end", () => {
    const parsed = parseEvalArgs(["toolbar", "--not-secure", "--limit", "4", "--reveal-toolbar"]);
    const env = evalEnv(parsed, "/o.json", NONCE);
    const read = readEvalSettings(env, () => NONCE);
    expect(read.ok && read.settings).toMatchObject({mode: "toolbar", notSecure: true, reveal: true, limit: 4});
  });
});

describe("which runs the terminal watches", () => {
  it("watches an observing run exactly as before, URLs included", () => {
    expect(watchPlanFor({mode: "observe", reveal: false})).toEqual({reveal: false, urls: true});
    expect(watchPlanFor({mode: "observe", reveal: true})).toEqual({reveal: true, urls: true});
    expect(watchPlanFor({mode: "all", reveal: false})).toEqual({reveal: false, urls: true});
  });

  it("watches a revealing not-secure toolbar run, with no URL list to wait for", () => {
    expect(watchPlanFor({mode: "toolbar", notSecure: true, reveal: true})).toEqual({reveal: true, urls: false});
  });

  it("watches no other run", () => {
    expect(watchPlanFor({mode: "toolbar", notSecure: false, reveal: false})).toBeNull();
    expect(watchPlanFor({mode: "toolbar", notSecure: true, reveal: false})).toBeNull();
    expect(watchPlanFor({mode: "toolbar", notSecure: false, reveal: true})).toBeNull();
    expect(watchPlanFor({mode: "toolbar", notSecure: "1", reveal: true})).toBeNull();
    expect(watchPlanFor({mode: "accuracy", notSecure: true, reveal: true})).toBeNull();
    expect(watchPlanFor({mode: "coldstart"})).toBeNull();
  });

  it("is what the program half asks, so the plan cannot be bypassed", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).toContain("const plan = watchPlanFor(options);");
    expect(source).toContain("if (plan !== null) await watchObserve(outDir, nonce, running, {}, plan);");
    expect(source.split("await watchObserve(")).toHaveLength(2);           // the one call
  });
});

describe("watching a revealing toolbar run", () => {
  const caseName = "normal-app.clave.localhost-chat-light-14";
  const revealFile = {
    schema: 1, nonce: NONCE, rows: [{
      case: caseName, bandPx: 82, toolbarText: "Not secure clave-eval.test:51234/chat.html",
      toolbarTextLength: 42, linesInBand: 1,
      lines: [{text: "Not secure clave-eval.test:51234/chat.html", length: 42, topPx: 50, bottomPx: 70, leftPx: 100, rightPx: 500}]
    }]
  };
  const claimedName = `${observeRevealName(NONCE)}.claimed`;
  const watching = (reveal: unknown) => {
    const asked: string[] = [];
    const printed: string[] = [];
    const removed: string[] = [];
    const beats: string[] = [];
    const waited: number[] = [];
    const running = {done: false};
    let onDisk = reveal;
    let held: unknown = null;
    const io = {
      read: (name: string) => { asked.push(name); return name === claimedName ? held : null; },
      print: (text: string) => { printed.push(text); },
      wait: async (ms: number) => { waited.push(ms); if (waited.length >= 3) running.done = true; },
      remove: (name: string) => { removed.push(name); if (name === claimedName) held = null; },
      claim: () => { if (onDisk === null) return false; held = onDisk; onDisk = null; return true; },
      beat: (name: string) => { beats.push(name); }
    };
    return {asked, printed, removed, beats, waited, running, io};
  };

  it("beats from the first moment, never waits for a URL list, prints the strip once and deletes it", async () => {
    const {asked, printed, removed, beats, waited, running, io} = watching(revealFile);
    await watchObserve("/out", NONCE, running, io, {reveal: true, urls: false});
    expect(asked).not.toContain(observeUrlsName(NONCE));
    expect(waited.every((ms) => ms === 1000)).toBe(true);                   // never the 250 ms URL poll
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(beats)]).toEqual([observeAliveName(NONCE)]);
    const lines = printed.join("").split(NL).filter((line) => line.includes("REVEAL"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`REVEAL ${caseName}:`);
    expect(lines[0]).toContain("Not secure clave-eval.test:51234/chat.html");
    expect(removed).toContain(claimedName);
    expect(printed.join("")).not.toContain("EXPLORATORY: no --expect");
  });

  it("still waits for the URL list in an observing run, which is the default", async () => {
    const {asked, running, io} = watching(null);
    await watchObserve("/out", NONCE, running, io, {reveal: true});
    expect(asked).toContain(observeUrlsName(NONCE));
    expect(asked).toContain(observeProgressName(NONCE));
  });

  it("sweeps a strip away unprinted when the plan does not reveal", async () => {
    const {printed, removed, running, io} = watching(revealFile);
    await watchObserve("/out", NONCE, running, io, {reveal: false, urls: false});
    expect(printed.join("")).not.toContain("REVEAL");
    expect(printed.join("")).not.toContain("Not secure");
    expect(removed).toContain(claimedName);
  });
});

/**
 * Deletion on every way out — a clean finish, a refusal, a throw, a signal — is a property of the
 * program half's SHAPE, and that shape must not depend on the mode: a revealing toolbar run leaves
 * through the same wrapper and the same handlers as a revealing observe run.
 */
describe("the cleanup a revealing toolbar run leaves through", () => {
  const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
  const from = source.indexOf("  const nonce = randomBytes(6).toString(\"hex\");");
  const to = source.indexOf("process.exit(await withRevealCleanup(outDir, nonce, () => runEval(options, outDir, nonce)));");

  it("sweeps, clears, installs the signal handlers and wraps the run for EVERY mode", () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const between = source.slice(from, to);
    for (const call of ["sweepRevealOrphans(outDir);", "clearRunFiles(outDir, nonce);", "installRevealSignalHandlers(outDir, nonce);"]) {
      expect(between).toContain(call);
    }
    // unconditional: no branch on the mode, the variant or the flag stands between them
    expect(between).not.toContain("if (");
    expect(between).not.toContain("options.");
  });

  it("creates the out folder for the owner alone, whatever the mode", () => {
    expect(source).toContain("mkdirSync(outDir, {recursive: true, mode: 0o700});");
  });
});

describe("a revealed toolbar case's name", () => {
  it("is printed whole although it carries dots, and nothing looser gets through", () => {
    expect(revealCaseName("normal-mybank.example.localhost-pt-dark-11")).toBe("normal-mybank.example.localhost-pt-dark-11");
    expect(revealCaseName("safari-private-chat-light-14")).toBe("safari-private-chat-light-14");
    for (const bad of ["a b", "a/b", "a:b", `a${String.fromCharCode(27)}[2J`, "", "x".repeat(65), 7, null, "a\"b"]) {
      expect(revealCaseName(bad)).toBe("?");
    }
    // the grammar of every OTHER fixed code is as closed as it was
    expect(fixedCode("a.b")).toBe("?");
  });

  it("is what a reveal row is labelled with", () => {
    const printed = formatRevealRow({case: "incognito-mail.corp.localhost-chat-dark-11", bandPx: 82, toolbarText: "x", toolbarTextLength: 1, linesInBand: 0, lines: []});
    expect(printed).toContain("REVEAL incognito-mail.corp.localhost-chat-dark-11:");
  });
});

const row = (name: string, mode: string, host: boolean | null, addressLine: boolean | null, extra: Record<string, unknown> = {}) => ({
  case: name, mode, expectPrivate: mode === "incognito", outcome: "ok", host, hostDistance: host ? 0 : 9, addressLine,
  hostBottomPx: 70, private: mode === "incognito", privateBottomPx: null, bandPx: 82, sizeAsStaged: true, ...extra
});

const notSecureRun = (accepted: boolean) => ({
  schema: 6, notSecure: true, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
  helper: {readyMs: 900}, permission: "granted", accuracy: [], observe: [],
  toolbar: [
    row("normal-app.clave.localhost-chat-light-14", "normal", true, true),
    row("incognito-app.clave.localhost-chat-light-14", "incognito", true, false),
    row("normal-app.clave.localhost-ticket-dark-14", "normal", false, false),
    row("incognito-app.clave.localhost-ticket-dark-14", "incognito", null, null, {outcome: "notStaged"})
  ],
  summary: {
    groups: [], missingGroups: [],
    toolbar: {captures: 4, hostHits: 1, hostHitsMin: 19, addressLines: 1, privateHits: 1, privateHitsMin: 20, falsePrivate: 0, falsePrivateMax: 0, incompleteCases: [], passed: false},
    observe: null, coldstart: null,
    limited: {reason: "LIMITED", cases: 4, of: 40},
    exploratory: {reason: "NOT_SECURE"},
    accepted
  }
});

describe("the printed summary of a not-secure run", () => {
  it("reads schema 6", () => {
    expect(RESULTS_SCHEMA).toBe(6);
  });

  it("prints the usual counts, addressLine n/N, and host found n/N against the reserved name", () => {
    const printed = formatSummary(notSecureRun(false));
    expect(printed).toContain("toolbar   captures 4  host 1/19+  private 1/20  false-private 0/0 max");
    expect(printed).toContain("addressLine 1/4");
    expect(printed).toContain("host found 2/4  (measured against clave-eval.test");
    expect(printed).toContain("LIMITED RUN: 4 of 40 cases");
  });

  it("prints one line per case: fixed codes, booleans and numbers only", () => {
    const printed = formatSummary(notSecureRun(false));
    expect(printed).toContain("normal-app.clave.localhost-chat-light-14");
    const line = printed.split(NL).find((entry) => entry.includes("incognito-app.clave.localhost-ticket-dark-14")) ?? "";
    expect(line).toContain("outcome notStaged");
    expect(line).toContain("host null");
    const hit = printed.split(NL).find((entry) => entry.includes("incognito-app.clave.localhost-chat-light-14")) ?? "";
    expect(hit).toContain("host true dist 0 address false private true");
  });

  /** The file is this run's own, but the terminal is where a string from a FILE reaches a screen. */
  it("prints a question mark for anything in a row that is not a fixed code, a boolean or a small count", () => {
    const ESC = String.fromCharCode(27);
    const run = notSecureRun(false);
    run.toolbar = [row(`evil${ESC}[2J title`, "normal", "yes" as unknown as boolean, "no" as unknown as boolean, {
      outcome: `gone${ESC}[2J`, hostDistance: "far", bandPx: `82${ESC}`, private: "maybe"
    })];
    const printed = formatSummary(run);
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain("evil");
    expect(printed).not.toContain("far");
    expect(printed).not.toContain("maybe");
    const line = printed.split(NL).find((entry) => entry.includes("outcome ?")) ?? "";
    expect(line).toContain("host null dist ? address null private null band ?");
    expect(line.trimStart().startsWith("? ")).toBe(true);
  });

  it("says EXPLORATORY, names the variant, and ends SHORTFALL", () => {
    const printed = formatSummary(notSecureRun(false));
    expect(printed).toContain("EXPLORATORY RUN: --not-secure");
    expect(printed).toContain("can never be accepted");
    expect(printed).toContain("READER_EVAL SHORTFALL");
    expect(printed).not.toContain("READER_EVAL ACCEPTED");
  });

  /** The third lock: even a results file that SAYS accepted is not printed or exited as one. */
  it("never prints ACCEPTED or exits 0 for a marked file, whatever the file claims", () => {
    const lying = notSecureRun(true);
    expect(formatSummary(lying)).toContain("READER_EVAL SHORTFALL");
    expect(formatSummary(lying)).not.toContain("READER_EVAL ACCEPTED");
    expect(exitCodeFor(lying)).toBe(2);
    // either marker alone is enough
    const markerOnly = {...lying, summary: {...lying.summary, exploratory: null, limited: null}};
    expect(exitCodeFor(markerOnly)).toBe(2);
    expect(formatSummary(markerOnly)).not.toContain("READER_EVAL ACCEPTED");
    const codeOnly = {...lying, notSecure: false, summary: {...lying.summary, limited: null}};
    expect(exitCodeFor(codeOnly)).toBe(2);
    expect(formatSummary(codeOnly)).not.toContain("READER_EVAL ACCEPTED");
  });

  it("changes nothing for an ordinary accepted run", () => {
    const ordinary = {
      schema: 6, notSecure: false, mode: "toolbar", nonce: NONCE, accuracy: [], toolbar: [], observe: [],
      summary: {groups: [], missingGroups: [], toolbar: null, observe: null, coldstart: null, limited: null, exploratory: null, accepted: true}
    };
    expect(exitCodeFor(ordinary)).toBe(0);
    const printed = formatSummary(ordinary);
    expect(printed).toContain("READER_EVAL ACCEPTED");
    expect(printed).not.toContain("EXPLORATORY");
    expect(printed).not.toContain("host found");
    expect(printed).not.toContain("clave-eval");
  });
});

describe("the usage text", () => {
  it("names the flag, the reserved name, the fences and the first run", () => {
    expect(USAGE).toContain("--not-secure");
    expect(USAGE).toContain("clave-eval.test");
    expect(USAGE).toContain("can never be accepted");
    expect(USAGE).toContain("Only for toolbar");
    expect(USAGE).toContain("not with --host");
    expect(USAGE).toContain("toolbar --not-secure --limit 4 --reveal-toolbar");
    // and the reveal paragraph no longer says observe is the only place
    expect(USAGE).toContain("or in toolbar mode WITH --not-secure");
    expect(MODES).toContain("toolbar");
  });
});

/**
 * Fix round 1 (review of 2026-09-21). Everything below pins a property the review found stated in a
 * comment and held by no test; each test names the review's mutant it exists to fail.
 */
const cleanAccepted = () => ({
  schema: 6, notSecure: false as unknown, mode: "toolbar", nonce: NONCE, accuracy: [], toolbar: [], observe: [],
  summary: {
    groups: [], missingGroups: [], toolbar: null, observe: null, coldstart: null, limited: null,
    exploratory: null as unknown, accepted: true as unknown
  }
});

describe("revealing is never implied by the variant, on the terminal side", () => {
  const base = {mode: "toolbar", repetitions: 5, seconds: 120, variant: "none"};

  /** Review mutant T8: `--not-secure` also sets `options.reveal`. */
  it("does not ask to reveal unless --reveal-toolbar was typed", () => {
    expect(parseEvalArgs(["toolbar", "--not-secure"])).toEqual({
      ok: true, mode: "toolbar", repetitions: 5, seconds: 120, variant: "none", position: null, limit: null,
      expect: null, host: null, reveal: false, notSecure: true
    });
    expect(parseEvalArgs(["toolbar", "--not-secure", "--limit", "4"]).reveal).toBe(false);
    expect(parseEvalArgs(["--", "toolbar", "--limit", "4", "--not-secure"]).reveal).toBe(false);
    // and the terminal neither watches nor prints for such a run
    expect(watchPlanFor(parseEvalArgs(["toolbar", "--not-secure"]))).toBeNull();
  });

  /** Review mutant T9: `evalEnv` also sets the reveal variable. The WHOLE environment, key by key. */
  it("tells the bundle exactly these variables for toolbar --not-secure, and no reveal variable", () => {
    const env = evalEnv(parseEvalArgs(["toolbar", "--not-secure"]), "/o.json", NONCE);
    expect(env).toEqual({
      CLAVE_DEV_ENTRY: "reader-eval",
      CLAVE_EVAL_MODE: "toolbar",
      CLAVE_EVAL_OUT: "/o.json",
      CLAVE_EVAL_NONCE: NONCE,
      CLAVE_EVAL_REPETITIONS: "5",
      CLAVE_EVAL_SECONDS: "120",
      CLAVE_EVAL_VARIANT: "none",
      CLAVE_EVAL_NOT_SECURE: "1"
    });
    expect("CLAVE_EVAL_REVEAL_TOOLBAR" in env).toBe(false);
    expect("CLAVE_EVAL_REVEAL_TOOLBAR" in evalEnv({...base, notSecure: true, reveal: false}, "/o.json", NONCE)).toBe(false);
    // and with the flag typed, exactly one more
    const asked = evalEnv(parseEvalArgs(["toolbar", "--not-secure", "--reveal-toolbar"]), "/o.json", NONCE);
    expect(Object.keys(asked).sort()).toEqual([...Object.keys(env), "CLAVE_EVAL_REVEAL_TOOLBAR"].sort());
  });

  it("is read by the bundle as a run that does not reveal, end to end", () => {
    const read = readEvalSettings(evalEnv(parseEvalArgs(["toolbar", "--not-secure"]), "/o.json", NONCE), () => NONCE);
    expect(read.ok && read.settings.reveal).toBe(false);
    expect(read.ok && read.settings.notSecure).toBe(true);
  });
});

/**
 * Important 1. The terminal typed the flag itself, so it never needs the file to tell it: with
 * `--not-secure` typed, no file — however clean, however accepted — is printed ACCEPTED or exits 0.
 */
describe("the terminal's own lock: it typed --not-secure", () => {
  it("never prints ACCEPTED or exits 0, whatever the file says", () => {
    // the file review mutant N1b produces: an unmarked, accepted, schema-6 file
    const unmarked = cleanAccepted();
    expect(exitCodeFor(unmarked)).toBe(0);                               // the file alone would pass...
    expect(exitCodeFor(unmarked, {notSecure: true})).toBe(2);            // ...the terminal knows better
    const printed = formatSummary(unmarked, {notSecure: true});
    expect(printed).not.toContain("READER_EVAL ACCEPTED");
    expect(printed.endsWith(`READER_EVAL SHORTFALL${NL}`)).toBe(true);
    expect(printed).toContain("EXPLORATORY RUN: --not-secure");
  });

  it("says MARKER_MISSING when the file does not carry the marker the run must have written", () => {
    expect(MARKER_MISSING_LINE).toBe("READER_EVAL_FAILED MARKER_MISSING");
    expect(formatSummary(cleanAccepted(), {notSecure: true}).split(NL)).toContain(MARKER_MISSING_LINE);
    // only the literal `true` is the marker
    expect(formatSummary({...cleanAccepted(), notSecure: "true"}, {notSecure: true}).split(NL)).toContain(MARKER_MISSING_LINE);
    // a properly marked file is not complained about, and an ordinary run never is
    expect(formatSummary(notSecureRun(false), {notSecure: true})).not.toContain("MARKER_MISSING");
    expect(formatSummary(cleanAccepted(), {notSecure: false})).not.toContain("MARKER_MISSING");
    expect(formatSummary(cleanAccepted())).not.toContain("MARKER_MISSING");
  });

  it("fails closed on what was typed: anything but false or nothing counts as typed", () => {
    for (const typed of [true, "1", 1, "true", null, {}, "false"]) {
      expect(typedNotSecure({notSecure: typed}), String(typed)).toBe(true);
      expect(exitCodeFor(cleanAccepted(), {notSecure: typed}), String(typed)).toBe(2);
      expect(formatSummary(cleanAccepted(), {notSecure: typed}), String(typed)).not.toContain("READER_EVAL ACCEPTED");
    }
    for (const options of [undefined, null, {}, {notSecure: false}, {notSecure: undefined}]) {
      expect(typedNotSecure(options)).toBe(false);
      expect(exitCodeFor(cleanAccepted(), options)).toBe(0);
      expect(formatSummary(cleanAccepted(), options)).toContain("READER_EVAL ACCEPTED");
    }
  });

  it("leaves a run that produced no results a harness failure, exit 1", () => {
    expect(exitCodeFor({error: "HARNESS", code: "BAD_NOT_SECURE"}, {notSecure: true})).toBe(1);
    expect(exitCodeFor(null, {notSecure: true})).toBe(1);
  });

  it("is what the program half asks, with the options it parsed itself", () => {
    const source = readFileSync(new URL("./reader-eval.mjs", import.meta.url), "utf8");
    expect(source).toContain("  process.stdout.write(formatSummary(results, options));");
    expect(source).toContain("  return exitCodeFor(results, options);");
    // the one call of each, so no second, option-less verdict can stand beside it
    expect(source.split("formatSummary(results").length).toBe(3);        // the definition and the call
    expect(source.split("exitCodeFor(results").length).toBe(3);
    expect(source).not.toContain("formatSummary(results)");
    expect(source).not.toContain("exitCodeFor(results)");
  });
});

/** Important 1, second half, and review mutants T1 and T2: the file's markers, read fail-closed. */
describe("the file's markers are read fail-closed", () => {
  const shortfall = (file: unknown, label: string) => {
    expect(isNotSecure(file), label).toBe(true);
    expect(exitCodeFor(file), label).toBe(2);
    const printed = formatSummary(file);
    expect(printed, label).not.toContain("READER_EVAL ACCEPTED");
    expect(printed, label).toContain("READER_EVAL SHORTFALL");
  };

  it("takes only notSecure === false beside exploratory === null as an ordinary run", () => {
    expect(isNotSecure(cleanAccepted())).toBe(false);
    expect(exitCodeFor(cleanAccepted())).toBe(0);
  });

  /** The three rows of the review's table that printed ACCEPTED and exited 0. */
  it("refuses a schema-6 accepted file whose markers are absent, a string or a number", () => {
    const {notSecure: _dropped, ...noTop} = cleanAccepted();
    const {exploratory: _gone, ...noCode} = cleanAccepted().summary;
    shortfall({...noTop, summary: noCode}, "both absent");
    shortfall(noTop, "top marker absent");
    shortfall({...cleanAccepted(), summary: noCode}, "summary code absent");
    shortfall({...cleanAccepted(), notSecure: "true"}, "string marker");
    shortfall({...cleanAccepted(), notSecure: 1}, "number marker");
    shortfall({...cleanAccepted(), notSecure: null}, "null marker");
    shortfall({...cleanAccepted(), notSecure: 0}, "zero marker");
    shortfall({...cleanAccepted(), notSecure: "false"}, "the word false");
  });

  it("does so for a file that carries no schema as well, which this terminal also reads", () => {
    const {schema: _none, ...bare} = cleanAccepted();
    expect(exitCodeFor(bare)).toBe(0);
    const {notSecure: _dropped, ...unmarked} = bare;
    shortfall(unmarked, "no schema, no marker");
    shortfall({...bare, notSecure: "true"}, "no schema, string marker");
    shortfall({...bare, summary: {...bare.summary, exploratory: undefined}}, "no schema, no code");
  });

  /** T1: only an object under `exploratory` counted. */
  it.each([false, 0, "x", "", [], {reason: "SOMETHING_ELSE"}, {}])("refuses exploratory = %j", (value) => {
    shortfall({...cleanAccepted(), summary: {...cleanAccepted().summary, exploratory: value}}, JSON.stringify(value));
  });

  /** T2: the top marker counted only in toolbar mode. */
  it.each(["all", "accuracy", "observe", "coldstart", undefined, 7])("refuses notSecure: true in mode %j", (mode) => {
    shortfall({...cleanAccepted(), notSecure: true, mode}, String(mode));
  });

  it("refuses an inconsistent pair, either way round", () => {
    shortfall({...cleanAccepted(), notSecure: true}, "marker without code");
    shortfall({...cleanAccepted(), summary: {...cleanAccepted().summary, exploratory: {reason: "NOT_SECURE"}}}, "code without marker");
  });

  it("refuses a file with no summary at all, and is false for what is not a file", () => {
    shortfall({schema: 6, notSecure: false, mode: "toolbar"}, "no summary");
    expect(isNotSecure(null)).toBe(false);
    expect(isNotSecure("x")).toBe(false);
  });

  it("never lets a non-boolean accepted through either", () => {
    for (const value of ["yes", 1, "true", {}, []]) {
      const file = {...cleanAccepted(), summary: {...cleanAccepted().summary, accepted: value}};
      expect(exitCodeFor(file)).toBe(2);
      expect(formatSummary(file)).not.toContain("READER_EVAL ACCEPTED");
    }
  });
});

/**
 * The variable in the BUNDLE's environment without the flag on the command line (review, ordinary-run
 * difference 4; only possible through launchd). It must fail safe on every side at once.
 */
describe("the variable present in the bundle's environment although nobody typed the flag", () => {
  const typedNothing = parseEvalArgs(["toolbar"]);
  const env = {...evalEnv(typedNothing, "/o.json", NONCE), CLAVE_EVAL_NOT_SECURE: "1"};

  it("makes an ordinary toolbar run the marked variant: no reveal, never accepted, on both sides", () => {
    const read = readEvalSettings(env, () => NONCE);
    expect(read.ok && read.settings).toMatchObject({mode: "toolbar", notSecure: true, reveal: false});
    if (!read.ok) return;
    const rows = TOOLBAR_CASES.map((entry) => ({
      case: entry.name, mode: entry.mode, expectPrivate: entry.mode === "incognito", outcome: "ok" as const,
      host: true, hostDistance: 0, addressLine: true, hostBottomPx: 70,
      private: entry.mode === "incognito", privateBottomPx: entry.mode === "incognito" ? 70 : null, bandPx: 82,
      toolbarTextLength: 40, toolbarTextPresent: true, lineCount: 3,
      stats: NO_STATS,
      staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null}, displayScale: 1, scale: 1, sizeAsStaged: true,
      chromeWaitMs: 0, stageMs: 900, stageAttempts: 1, frontAppSeen: true, stagedTitleSeen: true,
      pageRequests: 1, pageStatus: 200, refusedTitleLength: null
    }));
    // a run whose every count passes: the ordinary verdict would be ACCEPTED
    expect(summarise("toolbar", [], rows as never).accepted).toBe(true);
    const summary = summarise("toolbar", [], rows as never, [], undefined, null, null, exploratoryOf(read.settings.notSecure));
    expect(summary.accepted).toBe(false);
    const file = JSON.parse(serialiseResults({
      schema: 6, notSecure: read.settings.notSecure, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: {readyMs: 10}, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: rows as never, observe: [], summary
    })) as Record<string, unknown>;
    expect(file.notSecure).toBe(true);
    // the terminal typed nothing, and still refuses: the file's own markers are enough
    expect(exitCodeFor(file, typedNothing)).toBe(2);
    expect(formatSummary(file, typedNothing)).not.toContain("READER_EVAL ACCEPTED");
    expect(formatSummary(file, typedNothing)).toContain("EXPLORATORY RUN: --not-secure");
    expect(watchPlanFor(typedNothing)).toBeNull();
  });

  it.each(["accuracy", "observe", "all", "coldstart"])("refuses a %s run outright", (mode) => {
    const other = {...evalEnv(parseEvalArgs([mode]), "/o.json", NONCE), CLAVE_EVAL_NOT_SECURE: "1"};
    expect(readEvalSettings(other, () => NONCE)).toEqual({ok: false, code: "NOT_SECURE_NOT_APPLICABLE"});
  });

  it("refuses every mode for a value that is not the one value", () => {
    for (const mode of MODES) {
      const bad = {...evalEnv(parseEvalArgs([mode]), "/o.json", NONCE), CLAVE_EVAL_NOT_SECURE: "true"};
      expect(readEvalSettings(bad, () => NONCE)).toEqual({ok: false, code: "BAD_NOT_SECURE"});
    }
  });
});

describe("the per-case lines of a not-secure summary", () => {
  /** Review mutant T13: any truthy `host` counted as found. */
  it("counts a host as found only for the literal true", () => {
    const run = notSecureRun(false);
    run.toolbar = [
      ...run.toolbar,
      row("normal-mail.corp.localhost-chat-dark-11", "normal", "yes" as unknown as boolean, true),
      row("incognito-mail.corp.localhost-chat-dark-11", "incognito", 1 as unknown as boolean, true)
    ];
    expect(formatSummary(run)).toContain("host found 2/6  (measured against clave-eval.test");
  });

  /** Review, Minor 7: the column was 48 wide and the longest name is 49. */
  it("pads the case name to the longest name in the table, so every column lines up", () => {
    const longest = Math.max(...TOOLBAR_CASES.map((entry) => entry.name.length));
    expect(longest).toBe(49);
    expect(CASE_NAME_WIDTH).toBe(longest);
    const run = notSecureRun(false);
    run.toolbar = TOOLBAR_CASES.map((entry) => row(entry.name, entry.mode, true, true));
    const lines = formatSummary(run).split(NL).filter((line) => line.includes(" outcome ok "));
    expect(lines).toHaveLength(TOOLBAR_CASES.length);
    expect([...new Set(lines.map((line) => line.indexOf(" outcome ")))]).toEqual([6 + longest]);
  });
});
