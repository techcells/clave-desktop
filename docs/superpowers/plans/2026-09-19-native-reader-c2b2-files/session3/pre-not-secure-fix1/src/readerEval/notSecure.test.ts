/**
 * `toolbar --not-secure`: the one variant of the toolbar run whose pages are NOT on a loopback NAME.
 *
 * Owner decision "A" (2026-09-21). Chrome draws its "Not secure" label only for an origin it does
 * not treat as trustworthy, and every host this harness has ever staged (`127.0.0.1`, `*.localhost`)
 * is one it does. So the variant stages the same forty pages under ONE fixed reserved name,
 * `clave-eval.test` (RFC 6761: `.test` never resolves on the network), and tells ONLY the eval's own
 * throw-away Chrome profile to send that name to the loopback address. The page server is bound
 * exactly as before. The run is exploratory and can never be accepted.
 *
 * Every test here is about a fence:
 *  - the name is a constant in code, never an input, and `--host` still refuses it;
 *  - the Chrome flag is on the eval's own launch only when asked, and an ordinary launch is
 *    byte-identical to what it was;
 *  - the server still binds the explicit loopback pair and nothing wider;
 *  - the run can never be accepted, whatever it measures — three independent locks;
 *  - `--reveal-toolbar` is allowed beside it and nowhere else new, behind every lock it already had.
 */
import {existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Server} from "node:http";
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import {BROWSER_WINDOW, TOOLBAR_CASES, TOOLBAR_HOSTS, interleavedToolbarCases, stagedTitleOf, type AccuracyCase, type ToolbarCase, type TruthName} from "./cases";
import {EVAL_MODES, NOT_SECURE_ON, REVEAL_ON, mayReveal, readEvalSettings} from "./config";
import {createEvalHelper} from "./helper";
import {
  REVEAL_REPLACEMENT,
  createRevealGate,
  expectationOf,
  observeAliveName,
  observeRevealName,
  parseObserveHost,
  revealFileNames,
  writeRevealFile,
  type ObserveRevealRow
} from "./observe";
import {NO_STATS, serialiseResults, type EvalResults, type ToolbarCaseResult} from "./results";
import {runAccuracyCase, runMode, runToolbar, runToolbarCase, toolbarHostOf, type RunDeps, type Stager} from "./run";
import {createPageServer} from "./server";
import {NOT_SECURE_HOST, NOT_SECURE_RESOLVER_FLAG, chromeStageCommand, chromeTeardownCommand} from "./stage";
import {exploratoryOf, summarise} from "./summary";
import {createFakeLink, createManualSchedule, respondTo} from "./testing/fakes";

const NONCE = "abc123abc123";
const PROFILE = "/tmp/clave-reader-eval-a1b2c3/chrome-profile";
const TRUTH: Record<TruthName, string> = {chat: "hello", ticket: "t", code: "c", pt: "p", terminal: "x"};

/** The flag, spelled out here in full so that a change to the constant is a change to this line too. */
const FLAG = "--host-resolver-rules=MAP clave-eval.test 127.0.0.1";

describe("the one fixed name", () => {
  it("is a constant, in the reserved .test domain, and not one a command line can supply", () => {
    expect(NOT_SECURE_HOST).toBe("clave-eval.test");
    expect(NOT_SECURE_HOST.endsWith(".test")).toBe(true);
    // `--host` keeps its loopback-only grammar: the very name this variant uses is refused there.
    expect(parseObserveHost(NOT_SECURE_HOST)).toBeNull();
    expect(parseObserveHost("clave-eval.test.localhost")).toBe("clave-eval.test.localhost");
  });

  it("is none of the ordinary toolbar hosts, all of which stay loopback names", () => {
    expect(TOOLBAR_HOSTS).not.toContain(NOT_SECURE_HOST);
    for (const host of TOOLBAR_HOSTS) expect(host.endsWith(".localhost")).toBe(true);
    for (const entry of TOOLBAR_CASES) expect(TOOLBAR_HOSTS).toContain(entry.host);
  });

  it("maps that name, and only that name, to the IPv4 loopback address", () => {
    expect(NOT_SECURE_RESOLVER_FLAG).toBe(FLAG);
    // one rule, one name, one address: no comma (a second rule), no wildcard, no EXCLUDE
    expect(NOT_SECURE_RESOLVER_FLAG.includes(",")).toBe(false);
    expect(NOT_SECURE_RESOLVER_FLAG.includes("*")).toBe(false);
    expect(NOT_SECURE_RESOLVER_FLAG.split(" ")).toEqual(["--host-resolver-rules=MAP", "clave-eval.test", "127.0.0.1"]);
  });

  it("is what a not-secure toolbar case is staged under and searched for, and nothing else is", () => {
    const first = TOOLBAR_CASES[0] as ToolbarCase;
    expect(toolbarHostOf(first, true)).toBe("clave-eval.test");
    expect(toolbarHostOf(first, false)).toBe(first.host);
    expect(toolbarHostOf(first, undefined)).toBe(first.host);
  });
});

describe("the eval's own Chrome launch", () => {
  const url = "http://app.clave.localhost:51234/chat.html?theme=light&size=14";
  const ORDINARY = [
    "-na", "Google Chrome", "--args",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--window-size=1160,640",
    "--window-position=40,60",
    url
  ];

  it("is byte-identical to what it always was when the variant is off or absent", () => {
    expect(chromeStageCommand({profileDir: PROFILE, incognito: false, window: BROWSER_WINDOW, url}).args).toEqual(ORDINARY);
    expect(chromeStageCommand({profileDir: PROFILE, incognito: false, window: BROWSER_WINDOW, url, notSecure: false}).args).toEqual(ORDINARY);
    expect(JSON.stringify(chromeStageCommand({profileDir: PROFILE, incognito: false, window: BROWSER_WINDOW, url}).args))
      .not.toContain("host-resolver");
  });

  it("carries exactly the one rule, once, as ONE argument, beside its own profile, when the variant is on", () => {
    const args = chromeStageCommand({profileDir: PROFILE, incognito: false, window: BROWSER_WINDOW, url, notSecure: true}).args;
    expect(args).toEqual([
      "-na", "Google Chrome", "--args",
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLAG,
      "--new-window",
      "--window-size=1160,640",
      "--window-position=40,60",
      url
    ]);
    expect(args.filter((entry) => entry.includes("host-resolver"))).toEqual([FLAG]);
    // never a launch without this run's own profile: the rule must not reach the owner's browser
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
    expect(args.slice(0, 3)).toEqual(["-na", "Google Chrome", "--args"]);
  });

  it("only takes the literal `true`", () => {
    const loose = chromeStageCommand({
      profileDir: PROFILE, incognito: false, window: BROWSER_WINDOW, url, notSecure: "yes" as unknown as boolean
    }).args;
    expect(loose).toEqual(ORDINARY);
  });

  it("keeps --incognito beside it", () => {
    const args = chromeStageCommand({profileDir: PROFILE, incognito: true, window: BROWSER_WINDOW, url, notSecure: true}).args;
    expect(args).toContain("--incognito");
    expect(args).toContain(FLAG);
  });

  it("changes nothing about what is killed afterwards", () => {
    expect(chromeTeardownCommand(PROFILE).args).toEqual(["-f", "[-]-user-data-dir=/tmp/clave-reader-eval-a1b2c3/chrome-profile"]);
  });
});

describe("the page server under the variant", () => {
  it("still binds the explicit loopback pair and nothing wider", async () => {
    const asked: string[] = [];
    const server = await createPageServer(TRUTH, [stagedTitleOf((TOOLBAR_CASES[0] as ToolbarCase).name, NONCE)],
      async (socket: Server, host: string, port: number) => {
        asked.push(host);
        return await new Promise<boolean>((resolve) => {
          socket.once("error", () => { resolve(false); });
          socket.listen(port, host, () => { resolve(true); });
        });
      });
    try {
      expect(asked).toEqual(["127.0.0.1", "::1"]);
      for (const wildcard of ["0.0.0.0", "::", "", "localhost", NOT_SECURE_HOST]) expect(asked).not.toContain(wildcard);
      // and it answers a request that ARRIVES on loopback carrying the reserved name as its Host,
      // which is what the eval's Chrome sends once the rule has mapped the name
      const title = stagedTitleOf((TOOLBAR_CASES[0] as ToolbarCase).name, NONCE);
      const path = `/chat.html?theme=light&size=14&stagedTitle=${encodeURIComponent(title)}`;
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {headers: {host: `${NOT_SECURE_HOST}:${server.port}`}});
      expect(response.status).toBe(200);
      expect(server.served(title)).toEqual({count: 1, lastStatus: 200});
    } finally {
      server.close();
    }
  });

  it("has no notion of the variant at all", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).not.toContain("notSecure");
    expect(source).not.toContain("clave-eval");
    expect(source).toContain("listen(ipv4, \"127.0.0.1\", 0)");
    expect(source).toContain("listen(ipv6, \"::1\", port)");
  });
});

describe("asking for the variant", () => {
  const NEW = () => NONCE;
  const toolbar = {CLAVE_EVAL_MODE: "toolbar"};

  it("is off when nobody asked, which is every ordinary run", () => {
    for (const mode of EVAL_MODES) {
      const read = readEvalSettings({CLAVE_EVAL_MODE: mode}, NEW);
      expect(read.ok && read.settings.notSecure).toBe(false);
    }
  });

  it("is on for the one value the variable may hold", () => {
    expect(NOT_SECURE_ON).toBe("1");
    const read = readEvalSettings({...toolbar, CLAVE_EVAL_NOT_SECURE: NOT_SECURE_ON}, NEW);
    expect(read.ok && read.settings.notSecure).toBe(true);
    expect(read.ok && read.settings.mode).toBe("toolbar");
  });

  it.each(["0", "false", "no", "", "true", "yes", "1 ", "clave-eval.test", "evil.example"])("refuses the value %p", (raw) => {
    expect(readEvalSettings({...toolbar, CLAVE_EVAL_NOT_SECURE: raw}, NEW)).toEqual({ok: false, code: "BAD_NOT_SECURE"});
  });

  it.each(["accuracy", "observe", "all", "coldstart"])("refuses it in %s, with a fixed code", (mode) => {
    expect(readEvalSettings({CLAVE_EVAL_MODE: mode, CLAVE_EVAL_NOT_SECURE: NOT_SECURE_ON}, NEW))
      .toEqual({ok: false, code: "NOT_SECURE_NOT_APPLICABLE"});
  });

  it("refuses it beside --host, with its own fixed code, whatever the host", () => {
    for (const host of ["127.0.0.1", "localhost", "a.localhost"]) {
      expect(readEvalSettings({...toolbar, CLAVE_EVAL_NOT_SECURE: NOT_SECURE_ON, CLAVE_EVAL_HOST: host}, NEW))
        .toEqual({ok: false, code: "NOT_SECURE_NOT_APPLICABLE"});
      expect(readEvalSettings({CLAVE_EVAL_MODE: "all", CLAVE_EVAL_NOT_SECURE: NOT_SECURE_ON, CLAVE_EVAL_HOST: host}, NEW))
        .toEqual({ok: false, code: "NOT_SECURE_NOT_APPLICABLE"});
    }
    // and --host itself is as closed as it was: the reserved name is still not a host it takes
    expect(readEvalSettings({CLAVE_EVAL_MODE: "observe", CLAVE_EVAL_HOST: NOT_SECURE_HOST}, NEW))
      .toEqual({ok: false, code: "BAD_HOST"});
    expect(readEvalSettings({...toolbar, CLAVE_EVAL_HOST: "a.localhost"}, NEW))
      .toEqual({ok: false, code: "HOST_NOT_APPLICABLE"});
  });

  it("combines with --limit, --position and --variant", () => {
    const read = readEvalSettings({
      ...toolbar, CLAVE_EVAL_NOT_SECURE: "1", CLAVE_EVAL_LIMIT: "4", CLAVE_EVAL_POSITION: "10,20", CLAVE_EVAL_VARIANT: "bookmarks-bar"
    }, NEW);
    expect(read.ok && read.settings).toMatchObject({notSecure: true, limit: 4, position: {xPt: 10, yPt: 20}, variant: "bookmarks-bar"});
  });
});

describe("revealing beside the variant", () => {
  const NEW = () => NONCE;

  it("is allowed in toolbar --not-secure, with and without --limit", () => {
    const env = {CLAVE_EVAL_MODE: "toolbar", CLAVE_EVAL_NOT_SECURE: "1", CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON};
    const whole = readEvalSettings(env, NEW);
    expect(whole.ok && whole.settings).toMatchObject({reveal: true, notSecure: true, limit: null});
    const short = readEvalSettings({...env, CLAVE_EVAL_LIMIT: "4"}, NEW);
    expect(short.ok && short.settings).toMatchObject({reveal: true, notSecure: true, limit: 4});
  });

  it("stays refused for an ordinary toolbar run, limited or not", () => {
    expect(readEvalSettings({CLAVE_EVAL_MODE: "toolbar", CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON}, NEW))
      .toEqual({ok: false, code: "REVEAL_NOT_APPLICABLE"});
    expect(readEvalSettings({CLAVE_EVAL_MODE: "toolbar", CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON, CLAVE_EVAL_LIMIT: "4"}, NEW))
      .toEqual({ok: false, code: "REVEAL_NOT_APPLICABLE"});
  });

  it.each(["accuracy", "all", "coldstart"])("stays refused in %s whatever else is said", (mode) => {
    expect(readEvalSettings({CLAVE_EVAL_MODE: mode, CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON}, NEW))
      .toEqual({ok: false, code: "REVEAL_NOT_APPLICABLE"});
    const both = readEvalSettings({CLAVE_EVAL_MODE: mode, CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON, CLAVE_EVAL_NOT_SECURE: "1"}, NEW);
    expect(both.ok).toBe(false);
  });

  it("keeps the observe fence exactly where it was", () => {
    expect(readEvalSettings({CLAVE_EVAL_MODE: "observe", CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON}, NEW).ok).toBe(true);
    expect(readEvalSettings({CLAVE_EVAL_MODE: "observe", CLAVE_EVAL_REVEAL_TOOLBAR: REVEAL_ON, CLAVE_EVAL_EXPECT: "safari"}, NEW))
      .toEqual({ok: false, code: "REVEAL_NOT_APPLICABLE"});
  });

  /** The whole truth table of the fence, so no cell of it is an accident. */
  it("may reveal in exactly two situations", () => {
    const allowed: string[] = [];
    for (const mode of EVAL_MODES) {
      for (const expect of [null, ["safari"]]) {
        for (const notSecure of [false, true]) {
          if (mayReveal(mode, expect, notSecure)) allowed.push(`${mode} ${expect === null ? "-" : "expect"} ${notSecure}`);
        }
      }
    }
    expect(allowed).toEqual([
      "toolbar - true", "toolbar expect true",      // the variant (an expectation there is refused upstream anyway)
      "observe - false", "observe - true"           // exploratory observe (the variant there is refused upstream)
    ]);
  });
});

/** A small world: a fake helper, a recording stager, and a front window that follows the last launch. */
function world(options: {
  answer?: (readNumber: number) => Record<string, unknown>;
  front?: (title: string | null, launches: number) => FrontWindow | null;
} = {}): {deps: RunDeps; opens: () => (readonly string[])[]; reads: () => number} {
  const link = createFakeLink();
  const ran: {program: string; args: readonly string[]}[] = [];
  const lastTitle = (): string | null => {
    const open = [...ran].reverse().find((command) => command.program === "/usr/bin/open");
    const url = open?.args[open.args.length - 1];
    return url === undefined ? null : new URL(url).searchParams.get("stagedTitle");
  };
  let asked = 0;
  let reads = 0;
  respondTo(link, (request) => {
    if (request.op === "frontWindow") {
      asked += 1;
      const title = lastTitle();
      if (options.front) return {window: options.front(title, ran.filter((command) => command.program === "/usr/bin/open").length)};
      return {window: title === null ? null : {app: "Google Chrome", bundleId: "com.google.Chrome", title}};
    }
    if (request.op === "read") {
      reads += 1;
      return options.answer ? options.answer(reads) : GOOD_ANSWER;
    }
    return null;
  });
  const stager: Stager = {
    run: async (command) => { ran.push(command); },
    writeScript: async (name) => `/out/${name}`,
    writePreferences: async () => undefined,
    matches: async () => false
  };
  let clock = 0;
  const deps: RunDeps = {
    helper: createEvalHelper({link, schedule: createManualSchedule().schedule}),
    stager,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    nonce: NONCE,
    port: 51234,
    profileDir: PROFILE,
    truth: TRUTH,
    repetitions: 1,
    settleMs: 0,
    guard: {timeoutMs: 1_000, pollMs: 200},
    chromeExit: {tries: 2, pollMs: 10}
  };
  return {
    deps,
    opens: () => ran.filter((command) => command.program === "/usr/bin/open").map((command) => command.args),
    reads: () => reads
  };
}

const GOOD_ANSWER = {
  ok: true, window: {app: "Google Chrome", title: "x"},
  text: "STARTMARKER PAGE-BODY-SECRET ENDMARKER",
  toolbarText: "Not secure clave-eval.test:51234/chat.html",
  lines: [
    {text: "Not secure clave-eval.test:51234/chat.html", topPx: 50, bottomPx: 70, leftPx: 100, rightPx: 500},
    {text: "PAGE-BODY-SECRET", topPx: 200, bottomPx: 220, leftPx: 10, rightPx: 400}
  ],
  stats: {bandPx: 82, captureMs: 30, recogniseMs: 150, cacheHit: false, width: 1160, height: 640}
};

const first = TOOLBAR_CASES[0] as ToolbarCase;

describe("one toolbar case under the variant", () => {
  it("is staged at the reserved name on the run's own port, with the rule on the launch", async () => {
    const {deps, opens} = world();
    const result = await runToolbarCase(first, {...deps, notSecure: true});
    expect(opens()).toHaveLength(1);
    const args = opens()[0] as readonly string[];
    const url = new URL(args[args.length - 1] as string);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("clave-eval.test");
    expect(url.port).toBe("51234");
    expect(args.filter((entry) => entry.includes("host-resolver"))).toEqual([FLAG]);
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
    // the case keeps its table name, so its staged id and its row are what they always were
    expect(result.case).toBe(first.name);
    expect(result.outcome).toBe("ok");
  });

  it("is staged exactly as before when the variant is off", async () => {
    const {deps, opens} = world();
    await runToolbarCase(first, deps);
    const args = opens()[0] as readonly string[];
    const url = args[args.length - 1] as string;
    expect(new URL(url).hostname).toBe(first.host);
    expect(args).toEqual([
      "-na", "Google Chrome", "--args", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check",
      "--new-window", "--window-size=1160,640", "--window-position=40,60", url
    ]);
    const off = world();
    await runToolbarCase(first, {...off.deps, notSecure: false});
    expect(off.opens()[0]).toEqual(args);
  });

  it("measures the host against the reserved name, not against the name in the case", async () => {
    const hit = world();
    const found = await runToolbarCase(first, {...hit.deps, notSecure: true});
    expect(found.host).toBe(true);
    expect(found.hostDistance).toBe(0);
    expect(found.hostBottomPx).toBe(70);
    // the same strip in an ORDINARY run does not carry that case's own host
    const ordinary = world();
    const missed = await runToolbarCase(first, ordinary.deps);
    expect(missed.host).toBe(false);
    // and a strip carrying the case's localhost host is a miss under the variant
    const other = world({answer: () => ({...GOOD_ANSWER, toolbarText: `${first.host}:51234/chat.html`, lines: []})});
    const wrong = await runToolbarCase(first, {...other.deps, notSecure: true});
    expect(wrong.host).toBe(false);
    expect(wrong.hostDistance).toBeGreaterThan(0);
  });

  it("keeps the rule on the second launch when the first never came to the front", async () => {
    const {deps, opens} = world({
      front: (title, launches) => (launches < 2 || title === null ? null : {app: "Google Chrome", title})
    });
    const result = await runToolbarCase(first, {...deps, notSecure: true});
    expect(result.stageAttempts).toBe(2);
    expect(opens()).toHaveLength(2);
    for (const args of opens()) expect(args.filter((entry) => entry.includes("host-resolver"))).toEqual([FLAG]);
  });

  it("never reaches an accuracy staging, which stays on the loopback address", async () => {
    const chat: AccuracyCase = {
      kind: "browser", name: "chat-light-14", group: "chat", app: "Google Chrome",
      page: "chat", theme: "light", sizePx: 14, truth: "chat", window: BROWSER_WINDOW
    };
    const {deps, opens} = world();
    await runAccuracyCase(chat, {...deps, notSecure: true});
    const args = opens()[0] as readonly string[];
    expect(JSON.stringify(args)).not.toContain("host-resolver");
    expect(new URL(args[args.length - 1] as string).hostname).toBe("127.0.0.1");
  });
});

describe("what a toolbar run reveals", () => {
  const collect = (): {rows: ObserveRevealRow[][]; take: (rows: readonly ObserveRevealRow[]) => void} => {
    const rows: ObserveRevealRow[][] = [];
    return {rows, take: (given) => { rows.push(given.map((row) => ({...row}))); }};
  };

  it("hands over the strip and the band's own line, never the page body, when all three locks are open", async () => {
    const {rows, take} = collect();
    const {deps} = world();
    await runToolbarCase(first, {...deps, notSecure: true, reveal: true, writeReveal: take});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]?.[0]).toMatchObject({case: first.name, bandPx: 82, linesInBand: 1, toolbarText: "Not secure clave-eval.test:51234/chat.html"});
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  /** Three independent conditions for one widening: the writer, the setting, and the variant. */
  it.each([
    ["the variant is off", {reveal: true, notSecure: false}],
    ["the variant is absent", {reveal: true}],
    ["the setting is off", {reveal: false, notSecure: true}],
    ["the setting is absent", {notSecure: true}],
    ["both are absent", {}]
  ])("never calls a reveal writer when %s, even when one is handed to it", async (_label, flags) => {
    const {rows, take} = collect();
    const {deps, reads} = world();
    const result = await runToolbarCase(first, {...deps, ...flags, writeReveal: take});
    expect(result.outcome).toBe("ok");
    expect(reads()).toBe(1);                                   // the read really happened
    expect(rows).toEqual([]);
  });

  it("shapes nothing when no writer exists", async () => {
    const {deps} = world();
    const result = await runToolbarCase(first, {...deps, notSecure: true, reveal: true});
    expect(result.outcome).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("Not secure");
  });

  it("reveals nothing for a read that failed, or a window that never came to the front", async () => {
    const failed = collect();
    const bad = world({answer: () => ({ok: false, reason: "windowGone"})});
    await runToolbarCase(first, {...bad.deps, notSecure: true, reveal: true, writeReveal: failed.take});
    expect(failed.rows).toEqual([]);
    const absent = collect();
    const none = world({front: () => null});
    await runToolbarCase(first, {...none.deps, notSecure: true, reveal: true, writeReveal: absent.take});
    expect(absent.rows).toEqual([]);
  });

  it("never puts a revealed character into the row that goes to the results file", async () => {
    const {take} = collect();
    const {deps} = world();
    const result = await runToolbarCase(first, {...deps, notSecure: true, reveal: true, writeReveal: take});
    const written = JSON.stringify(result);
    expect(written).not.toContain("Not secure");
    expect(written).not.toContain("clave-eval");
    expect(written).not.toContain("SECRET");
  });

  it("builds ONE cumulative table over a limited run, in the interleaved order", async () => {
    const {rows, take} = collect();
    const {deps, opens} = world();
    const results = await runToolbar({...deps, notSecure: true, reveal: true, writeReveal: take, limit: 4});
    const order = interleavedToolbarCases().slice(0, 4).map((entry) => entry.name);
    expect(results.map((row) => row.case)).toEqual(order);
    expect(results.map((row) => row.mode)).toEqual(["normal", "incognito", "normal", "incognito"]);
    expect(rows.map((table) => table.map((row) => row.case))).toEqual([
      order.slice(0, 1), order.slice(0, 2), order.slice(0, 3), order.slice(0, 4)
    ]);
    // every one of the four launches carried the rule, and the incognito ones their own flag too
    expect(opens()).toHaveLength(4);
    for (const args of opens()) expect(args).toContain(FLAG);
    expect(opens().filter((args) => args.includes("--incognito"))).toHaveLength(2);
  });

  it("goes through runMode the same way, and runs no other part", async () => {
    const {rows, take} = collect();
    const {deps} = world();
    const runs = await runMode("toolbar", {...deps, notSecure: true, reveal: true, writeReveal: take, limit: 2});
    expect(runs.toolbar).toHaveLength(2);
    expect(runs.accuracy).toEqual([]);
    expect(runs.observe).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("reveals nothing in an ordinary limited toolbar run handed the same writer", async () => {
    const {rows, take} = collect();
    const {deps} = world();
    await runMode("toolbar", {...deps, reveal: true, writeReveal: take, limit: 2});
    expect(rows).toEqual([]);
  });
});

/**
 * The whole reveal path under the variant, against a REAL folder and wired the way `main.ts` wires
 * it: the run's writer is the gate, the gate's three lines of `fs` are the production ones. Every
 * safety property the observe reveal has must hold here too, because it is the same code — and this
 * is the test that fails if somebody gives the toolbar reveal a path of its own.
 */
describe("the reveal channel, end to end, under the variant", () => {
  const ESC = String.fromCharCode(27);
  const RLO = String.fromCodePoint(0x202e);
  const nasty = {
    ...GOOD_ANSWER,
    toolbarText: `Not secure ${ESC}[2J${RLO}clave-eval.test:51234/chat.html`,
    lines: [
      {text: `Not secure ${ESC}[2Jclave-eval.test`, topPx: 50, bottomPx: 70, leftPx: 100, rightPx: 500},
      {text: "PAGE-BODY-SECRET", topPx: 200, bottomPx: 220, leftPx: 10, rightPx: 400}
    ]
  };

  const wired = (heartbeatAgeMs: (dir: string) => number | null) => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-ns-"));
    const path = join(dir, observeRevealName(NONCE));
    const gate = createRevealGate(NONCE, {
      heartbeatAgeMs: () => heartbeatAgeMs(dir),
      write: (contents) => { writeRevealFile(path, contents, {writeFile: writeFileSync, rename: renameSync}); },
      remove: () => { for (const name of revealFileNames(NONCE)) rmSync(join(dir, name), {force: true}); }
    });
    return {dir, path, gate};
  };
  const mtimeAge = (dir: string): number | null => {
    try { return Date.now() - statSync(join(dir, observeAliveName(NONCE))).mtimeMs; } catch { return null; }
  };

  it("writes the strips privately, filtered, and without the page, while the terminal is alive", async () => {
    const {dir, path, gate} = wired(mtimeAge);
    try {
      writeFileSync(join(dir, observeAliveName(NONCE)), "");
      const {deps} = world({answer: () => nasty});
      await runToolbar({...deps, notSecure: true, reveal: true, limit: 2, writeReveal: (rows) => { gate.reveal(rows); }});
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain(ESC);
      expect(text).not.toContain(RLO);
      expect(text).not.toContain("SECRET");
      const file = JSON.parse(text) as {nonce: string; rows: {case: string; toolbarText: string; lines: unknown[]}[]};
      expect(file.nonce).toBe(NONCE);
      expect(file.rows.map((row) => row.case)).toEqual(interleavedToolbarCases().slice(0, 2).map((entry) => entry.name));
      expect(file.rows[0]?.toolbarText).toBe(`Not secure ${REVEAL_REPLACEMENT}[2J${REVEAL_REPLACEMENT}clave-eval.test:51234/chat.html`);
      expect(file.rows[0]?.lines).toHaveLength(1);              // the line below the band is not there
      // no half-written sibling is left behind
      expect(readdirSync(dir).sort()).toEqual([observeAliveName(NONCE), observeRevealName(NONCE)].sort());
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("writes nothing at all when no terminal is there, and stops for the rest of the run", async () => {
    const {dir, gate} = wired(mtimeAge);                       // no heartbeat file was ever written
    try {
      const {deps, reads} = world();
      await runToolbar({...deps, notSecure: true, reveal: true, limit: 3, writeReveal: (rows) => { gate.reveal(rows); }});
      expect(reads()).toBe(3);
      expect(readdirSync(dir)).toEqual([]);
      expect(gate.stopped()).toBe(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("takes the strips off the disk when the terminal dies mid-run, every name they can be under", async () => {
    let asks = 0;
    const {dir, path, gate} = wired(() => { asks += 1; return asks === 1 ? 0 : 60_000; });
    try {
      const {deps} = world();
      // what a terminal that died mid-print leaves behind
      writeFileSync(`${path}.claimed`, "SENTINEL-STRIP");
      await runToolbar({...deps, notSecure: true, reveal: true, limit: 3, writeReveal: (rows) => { gate.reveal(rows); }});
      expect(asks).toBe(2);                                    // written once, found stale once, never asked again
      expect(readdirSync(dir)).toEqual([]);
      expect(gate.stopped()).toBe(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("deletes the last strip at the end of a run whose terminal is gone, and leaves it for one that is alive", async () => {
    let age = 0;
    const {dir, path, gate} = wired(() => age);
    try {
      const {deps} = world();
      await runToolbar({...deps, notSecure: true, reveal: true, limit: 1, writeReveal: (rows) => { gate.reveal(rows); }});
      gate.end();
      expect(existsSync(path)).toBe(true);                     // alive: the terminal's final sweep claims it
      age = 60_000;
      gate.end();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

const capture = (name: string, mode: "normal" | "incognito"): ToolbarCaseResult => ({
  case: name, mode, expectPrivate: mode === "incognito", outcome: "ok",
  host: true, hostDistance: 0, addressLine: true, hostBottomPx: 70,
  private: mode === "incognito", privateBottomPx: mode === "incognito" ? 70 : null, bandPx: 82,
  toolbarTextLength: 40, toolbarTextPresent: true, lineCount: 3, stats: NO_STATS,
  staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null}, displayScale: 1, scale: 1, sizeAsStaged: true,
  chromeWaitMs: 0, stageMs: 900, stageAttempts: 1, frontAppSeen: true, stagedTitleSeen: true,
  pageRequests: 1, pageStatus: 200, refusedTitleLength: null
});
const perfectToolbarRun = (): ToolbarCaseResult[] => TOOLBAR_CASES.map((entry) => capture(entry.name, entry.mode));

describe("a not-secure run can never be accepted", () => {
  it("names the variant with a fixed code, or nothing", () => {
    expect(exploratoryOf(true)).toEqual({reason: "NOT_SECURE"});
    expect(exploratoryOf(false)).toBeNull();
    expect(exploratoryOf("1" as unknown as boolean)).toBeNull();
  });

  it("is not accepted although all forty captures pass every count", () => {
    const rows = perfectToolbarRun();
    const ordinary = summarise("toolbar", [], rows);
    expect(ordinary.accepted).toBe(true);
    expect(ordinary.exploratory).toBeNull();

    const variant = summarise("toolbar", [], rows, [], undefined, null, null, exploratoryOf(true));
    expect(variant.toolbar).toEqual(ordinary.toolbar);         // the counts are the usual ones, untouched
    expect(variant.toolbar?.passed).toBe(true);
    expect(variant.toolbar?.addressLines).toBe(40);
    expect(variant.exploratory).toEqual({reason: "NOT_SECURE"});
    expect(variant.accepted).toBe(false);
  });

  it("is not accepted when limited either, and says both", () => {
    const rows = perfectToolbarRun().slice(0, 4);
    const summary = summarise("toolbar", [], rows, [], undefined, {reason: "LIMITED", cases: 4, of: 40}, null, exploratoryOf(true));
    expect(summary.accepted).toBe(false);
    expect(summary.limited).toEqual({reason: "LIMITED", cases: 4, of: 40});
    expect(summary.exploratory).toEqual({reason: "NOT_SECURE"});
  });

  it("leaves every ordinary mode's acceptance exactly as it was", () => {
    expect(summarise("toolbar", [], perfectToolbarRun(), [], undefined, null, null, null).accepted).toBe(true);
    expect(summarise("toolbar", [], perfectToolbarRun(), [], undefined, null, expectationOf(null)).accepted).toBe(true);
    expect(summarise("coldstart", [], [], [], {readyMs: 10, permission: "granted"}).accepted).toBe(true);
  });
});

describe("what the results file says about the variant", () => {
  const results = (notSecure: boolean, accepted: boolean, exploratory: {reason: "NOT_SECURE"} | null): EvalResults => ({
    schema: 6, notSecure, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
    helper: {readyMs: 10}, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
    accuracy: [], toolbar: perfectToolbarRun(), observe: [],
    summary: {...summarise("toolbar", [], perfectToolbarRun(), [], undefined, null, null, exploratory), accepted}
  });

  it("is schema 6, with a boolean marker and a fixed code", () => {
    const written = JSON.parse(serialiseResults(results(true, false, {reason: "NOT_SECURE"}))) as Record<string, unknown>;
    expect(written.schema).toBe(6);
    expect(written.notSecure).toBe(true);
    expect((written.summary as Record<string, unknown>).exploratory).toEqual({reason: "NOT_SECURE"});
    expect((written.summary as Record<string, unknown>).accepted).toBe(false);
  });

  it("says false and null for an ordinary run, and leaves its acceptance alone", () => {
    const written = JSON.parse(serialiseResults(results(false, true, null))) as Record<string, unknown>;
    expect(written.notSecure).toBe(false);
    expect((written.summary as Record<string, unknown>).exploratory).toBeNull();
    expect((written.summary as Record<string, unknown>).accepted).toBe(true);
  });

  /** The second lock: the wiring in `main.ts` cannot be executed by a test, so the writer refuses too. */
  it("never writes accepted: true beside either marker, whatever it was handed", () => {
    const marked = JSON.parse(serialiseResults(results(true, true, null))) as {summary: {accepted: boolean}};
    expect(marked.summary.accepted).toBe(false);
    const coded = JSON.parse(serialiseResults(results(false, true, {reason: "NOT_SECURE"}))) as {summary: {accepted: boolean}};
    expect(coded.summary.accepted).toBe(false);
  });

  it("writes the literal code and a real boolean, never what it was handed", () => {
    const SENTINEL = "SENTINEL-WINDOW-TITLE";
    const handed = results(true, false, {reason: SENTINEL as unknown as "NOT_SECURE"});
    const text = serialiseResults({...handed, notSecure: SENTINEL as unknown as boolean});
    expect(text).not.toContain(SENTINEL);
    const written = JSON.parse(text) as {notSecure: unknown; summary: {exploratory: unknown; accepted: unknown}};
    expect(written.notSecure).toBe(false);                     // not the literal `true`, so not the variant...
    expect(written.summary.exploratory).toEqual({reason: "NOT_SECURE"});
    expect(written.summary.accepted).toBe(false);              // ...and still never accepted
  });

  it("holds no string but case names, fixed codes and the nonce, and never the reserved name", () => {
    const text = serialiseResults(results(true, false, {reason: "NOT_SECURE"}));
    expect(text).not.toContain("clave-eval");
    expect(text).not.toContain("host-resolver");
    const allowed = new Set<string>([
      NONCE, "toolbar", "none", "granted", "ok", "normal", "incognito", "NOT_SECURE", ...TOOLBAR_CASES.map((entry) => entry.name)
    ]);
    const walk = (value: unknown): void => {
      if (typeof value === "string") expect(allowed.has(value), value).toBe(true);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
    };
    walk(JSON.parse(text));
  });
});

/** `main.ts` cannot be imported by a test, so its wiring of the variant is read off its source. */
describe("the entry point's wiring of the variant", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("takes the variant from the validated settings and from nowhere else", () => {
    expect(source).toContain("limit, expect, host, reveal, notSecure} = configured.settings;");
    expect(source).not.toContain("CLAVE_EVAL_NOT_SECURE");
    expect(source).not.toContain("clave-eval");
    expect(source).not.toContain("host-resolver");
  });

  it("hands it to the run, records it, and judges the run by it", () => {
    expect(source).toContain("        notSecure,");
    expect(source.indexOf("await runMode(")).toBeLessThan(source.indexOf("        notSecure,"));
    // the RESULTS line, held to its neighbour so the run's own (deeper) line cannot stand in for it
    expect(source).toContain(["      notSecure,", "      mode,"].join(String.fromCharCode(10)));
    expect(source).toContain("limited, observeExpect, exploratoryOf(notSecure))");
    expect(source).toContain("schema: 6,");
  });

  it("serves the pages exactly as before", () => {
    expect(source).toContain("createPageServer(truth, titles)");
  });
});
