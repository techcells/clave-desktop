// The terminal half of `toolbar --not-secure` (owner decision "A", 2026-09-21). Same arrangement as
// reader-eval.test.ts: the script's program half is gated on argv[1], so importing it here never
// opens a bundle, a browser or a window.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {NOT_SECURE_ON as BUNDLE_NOT_SECURE_ON, readEvalSettings} from "../src/readerEval/config";
import {NOT_SECURE_HOST as BUNDLE_NOT_SECURE_HOST} from "../src/readerEval/stage";
import * as cli from "./reader-eval.mjs";

const {
  parseEvalArgs, mayRevealArgs, evalEnv, formatSummary, exitCodeFor, watchObserve, watchPlanFor, formatRevealRow, revealCaseName,
  fixedCode, observeUrlsName, observeProgressName, observeRevealName, observeAliveName,
  NOT_SECURE_ON, NOT_SECURE_HOST, NOT_SECURE_MODE, RESULTS_SCHEMA, USAGE, MODES
} = cli as {
  mayRevealArgs: (options: Record<string, unknown>) => boolean;
  parseEvalArgs: (argv: string[]) => Record<string, unknown> & {ok: boolean; problem?: string};
  evalEnv: (options: Record<string, unknown>, outFile: string, nonce: string) => Record<string, string>;
  formatSummary: (results: unknown) => string;
  exitCodeFor: (results: unknown) => number;
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
