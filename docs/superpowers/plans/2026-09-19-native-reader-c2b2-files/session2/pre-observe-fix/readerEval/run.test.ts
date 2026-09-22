/**
 * The orchestration, end to end, against fakes: no window is ever opened, no process is ever
 * started, nothing is written. The assertions that matter most are negative ones — that no `read`
 * line was written at all — because that is the whole privacy claim of this harness.
 */
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import type {AccuracyCase, ToolbarCase, TruthName} from "./cases";
import {BROWSER_WINDOW, DEFAULT_POSITION, OBSERVE_CASES, stagedTitleOf} from "./cases";
import {createEvalHelper} from "./helper";
import {FIRST_STAGE_GUARD_TIMEOUT_MS, bandPxOf, guardTimeoutFor, runToolbar, withProgress, failureOutcome, hostInToolbar, linesOf, runAccuracy, runAccuracyCase, runMode, runObserve, runToolbarCase, statsOf, toolbarFacts, type ObserveDeps, type RunDeps, type Stager} from "./run";
import {READY_TOKEN, readySizeToken, readyTitleFor, stagedTitleFor} from "./stagedTitle";
import {GUARD_TIMEOUT_MS} from "./thresholds";
import {summarise} from "./summary";
import {createFakeLink, createManualSchedule, respondTo, type FakeLink} from "./testing/fakes";

const NONCE = "abc123";
const PROFILE = "/out/chrome-profile";

const TRUTH: Record<TruthName, string> = {
  chat: "hello world\nsecond line\n",
  ticket: "ticket body\n",
  code: "const a = 1;\n",
  pt: "linha\n",
  terminal: "terminal body\n"
};

const chatCase: AccuracyCase = {
  kind: "browser", name: "chat-light-14", group: "chat", app: "Google Chrome",
  page: "chat", theme: "light", sizePx: 14, truth: "chat", window: BROWSER_WINDOW
};
const terminalCase: AccuracyCase = {
  kind: "terminal", name: "terminal-narrow", group: "terminal", app: "Terminal",
  columns: 72, rows: 40, truth: "terminal"
};
const toolbarCase: ToolbarCase = {
  name: "incognito-mybank.example.localhost-chat-light-14", app: "Google Chrome",
  host: "mybank.example.localhost", page: "chat", theme: "light", sizePx: 14,
  mode: "incognito", expectPrivate: true, window: BROWSER_WINDOW
};

interface World {
  deps: RunDeps;
  link: FakeLink;
  ran: {program: string; args: readonly string[]}[];
  scripts: {name: string; contents: string}[];
  preferences: Record<string, unknown>[];
  /**
   * Everything the stager did, in ONE list and in order: `run <program>`, `pgrep <answer>`,
   * `preferences`, `script`. The order is the assertion in the wait-for-exit tests — a placement
   * written after the window opened, or a window opened while the last Chrome was still alive, is a
   * repair that does not repair anything, and only the sequence shows it.
   */
  log: string[];
}

/**
 * A world in which `front` is whatever window the window server would report and `answer` is what a
 * read comes back with.
 */
function world(options: {
  front: (asked: number) => FrontWindow | null;
  answer?: (readNumber: number) => Record<string, unknown>;
  repetitions?: number;
  /** What `pgrep` says, ask by ask: `true` is "this run's Chrome is still alive". */
  alive?: (asked: number) => boolean;
}): World {
  const link = createFakeLink();
  let asked = 0;
  let reads = 0;
  respondTo(link, (request) => {
    if (request.op === "frontWindow") { asked += 1; return {window: options.front(asked)}; }
    if (request.op === "read") {
      reads += 1;
      return options.answer
        ? options.answer(reads)
        : {ok: true, window: request.expect, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 30, recogniseMs: 150, cacheHit: reads > 1, width: 1160, height: 640}};
    }
    return null;
  });
  const ran: {program: string; args: readonly string[]}[] = [];
  const scripts: {name: string; contents: string}[] = [];
  const preferences: Record<string, unknown>[] = [];
  const log: string[] = [];
  let asks = 0;
  const stager: Stager = {
    run: async (command) => { ran.push(command); log.push(`run ${command.program}`); },
    writeScript: async (name, contents) => { scripts.push({name, contents}); log.push("script"); return `/out/${name}`; },
    writePreferences: async (value) => { preferences.push(value); log.push("preferences"); },
    matches: async () => {
      asks += 1;
      const answer = options.alive ? options.alive(asks) : false;
      log.push(`pgrep ${answer}`);
      return answer;
    }
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
    repetitions: options.repetitions ?? 1,
    settleMs: 0,
    guard: {timeoutMs: 1_000, pollMs: 200},
    chromeExit: {tries: 4, pollMs: 100}
  };
  return {deps, link, ran, scripts, preferences, log};
}

const readLines = (link: FakeLink): Record<string, unknown>[] =>
  link.sent.map((line) => JSON.parse(line) as Record<string, unknown>).filter((request) => request.op === "read");

/** A staged window as the harness now titles one: the case's SHORT id, never its name. */
const stagedWindow = (name: string, app = "Google Chrome"): FrontWindow =>
  ({app, bundleId: "com.google.Chrome", title: stagedTitleOf(name, NONCE)});

/**
 * A staged TERMINAL window that has finished printing: the staged title, the READY token, and the
 * size the shell says it got. This is what the guard now waits for, and what a real staged shell
 * prints once ENDMARKER is out (`terminalScript`).
 */
const readyTerminal = (name: string, columns = 72, rows = 40): FrontWindow =>
  ({app: "Terminal", title: `${stagedTitleOf(name, NONCE)}${READY_TOKEN}${readySizeToken(columns, rows)}`});

describe("nothing is read that was not staged", () => {
  it("writes no read line at all when another app is in front", async () => {
    const {deps, link} = world({front: () => ({app: "Mail", title: "Inbox (14)"})});
    const result = await runAccuracyCase(chatCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
    expect(result.incomplete).toBe(true);
  });

  it("writes no read line when the right app carries another run's nonce", async () => {
    const {deps, link} = world({front: () => ({app: "Google Chrome", title: stagedTitleOf("chat-light-14", "999999")})});
    const result = await runAccuracyCase(chatCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
  });

  it("writes no read line when the right app carries another case of this run", async () => {
    const {deps, link} = world({front: () => stagedWindow("ticket-dark-11")});
    await runAccuracyCase(chatCase, deps);
    expect(readLines(link)).toEqual([]);
  });

  it("writes no read line when the staged title is in the front window of the wrong app", async () => {
    const {deps, link} = world({front: () => stagedWindow("chat-light-14", "Safari")});
    await runAccuracyCase(chatCase, deps);
    expect(readLines(link)).toEqual([]);
  });

  it("reads exactly the window the window server reported, field for field", async () => {
    const front = stagedWindow("chat-light-14");
    const {deps, link} = world({front: () => front});
    await runAccuracyCase(chatCase, deps);
    const reads = readLines(link);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.expect).toEqual(front);
  });

  it("never sends a read without `expect`", async () => {
    const {deps, link} = world({front: () => stagedWindow("chat-light-14"), repetitions: 3});
    await runAccuracyCase(chatCase, deps);
    await runToolbarCase(toolbarCase, {...deps, nonce: NONCE});
    const reads = readLines(link);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.expect).toBeTruthy();
  });
});

describe("one accuracy case", () => {
  it("stages, reads, probes the cache, and tears down — once per repetition", async () => {
    const {deps, link, ran} = world({front: () => stagedWindow("chat-light-14"), repetitions: 3});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions).toHaveLength(3);
    // two reads per repetition: the scored one and the cache probe
    expect(readLines(link)).toHaveLength(6);
    const opens = ran.filter((command) => command.program === "/usr/bin/open");
    const kills = ran.filter((command) => command.program === "/usr/bin/pkill");
    expect(opens).toHaveLength(3);
    expect(kills).toHaveLength(3);
    expect(kills[0]?.args[1]).toContain(PROFILE);
  });

  it("asks for no line boxes when it is only scoring", async () => {
    const {deps, link} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, deps);
    for (const read of readLines(link)) expect(read.lines).toBeUndefined();
  });

  it("scores the body between the markers and keeps min, median and accents", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14"), repetitions: 3});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.minAccuracy).toBe(1);
    expect(result.medianAccuracy).toBe(1);
    expect(result.minAccents).toBe(1);
    expect(result.incomplete).toBe(false);
  });

  it("records only cacheHit and recogniseMs from the second read (carried item 27)", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.repeat).toEqual({cacheHit: true, recogniseMs: 150});
    expect(result.repetitions[0]?.stats.cacheHit).toBe(false);
  });

  it("records a read with no markers as noMarkers, not as a score", async () => {
    const {deps} = world({
      front: () => stagedWindow("chat-light-14"),
      answer: () => ({ok: true, window: {app: "Google Chrome", title: "x"}, text: "hello world", stats: {}})
    });
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("noMarkers");
    expect(result.repetitions[0]?.accuracy).toBeNull();
    expect(result.minAccuracy).toBeNull();
    expect(result.incomplete).toBe(true);
  });

  it.each(["black", "windowGone", "timeout", "failed", "locked"])("records a %s answer under its own code", async (reason) => {
    const {deps} = world({front: () => stagedWindow("chat-light-14"), answer: () => ({ok: false, reason})});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.outcome).toBe(reason);
    expect(result.incomplete).toBe(true);
  });

  it("computes confusions only for a case that fell short", async () => {
    const good = world({front: () => stagedWindow("chat-light-14")});
    expect((await runAccuracyCase(chatCase, good.deps)).confusions).toEqual([]);

    const bad = world({
      front: () => stagedWindow("chat-light-14"),
      // "he11o wor1d" against "hello world": three l -> 1 substitutions, well under 0.97
      answer: () => ({ok: true, window: {app: "Google Chrome", title: "x"}, text: "STARTMARKER he11o wor1d xxxxx ENDMARKER", stats: {}})
    });
    const result = await runAccuracyCase(chatCase, bad.deps);
    expect(result.minAccuracy).toBeLessThan(0.97);
    expect(result.confusions.length).toBeGreaterThan(0);
    expect(result.confusions[0]?.from).toBe("l");
  });
});

describe("the terminal cases", () => {
  it("writes a .command file with the staged title and never kills Terminal", async () => {
    const {deps, ran, scripts} = world({front: () => readyTerminal("terminal-narrow")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
    expect(scripts[0]?.name).toBe("terminal-narrow.command");
    expect(scripts[0]?.contents).toContain(stagedTitleOf("terminal-narrow", NONCE));
    expect(scripts[0]?.contents).toContain("terminal body");
    expect(ran.every((command) => command.program !== "/usr/bin/pkill")).toBe(true);
  });

  it("stages the narrow case at its own size", async () => {
    const {deps, scripts} = world({front: () => readyTerminal("terminal-narrow")});
    await runAccuracyCase(terminalCase, deps);
    expect(scripts[0]?.contents).toContain("[8;40;72t");
  });
});

describe("one toolbar case", () => {
  const lines = [
    {text: "mybank.example.localhost:51234/chat.html?th...", topPx: 55, bottomPx: 71, leftPx: 120, rightPx: 400},
    {text: "* Incognito", topPx: 55, bottomPx: 70, leftPx: 900, rightPx: 1000},
    {text: "STARTMARKER", topPx: 111, bottomPx: 125, leftPx: 20, rightPx: 120}
  ];

  it("asks for line boxes, and reads the strip with the product's own private rule", async () => {
    const {deps, link} = world({
      front: () => stagedWindow(toolbarCase.name),
      answer: () => ({
        ok: true, window: {app: "Google Chrome", title: "x"},
        text: "body", toolbarText: "mybank.example.localhost:51234/chat.html * Incognito",
        lines, stats: {bandPx: 82, captureMs: 30, recogniseMs: 150, cacheHit: false, width: 1268, height: 708}
      })
    });
    const result = await runToolbarCase(toolbarCase, deps);
    expect(readLines(link)[0]?.lines).toBe(true);
    expect(result.outcome).toBe("ok");
    expect(result.host).toBe(true);
    expect(result.private).toBe(true);
    expect(result.hostBottomPx).toBe(71);
    expect(result.privateBottomPx).toBe(70);
    expect(result.bandPx).toBe(82);
    expect(result.toolbarTextLength).toBe(52);
    expect(result.lineCount).toBe(3);
  });

  it("shows a badge that fell below the band, which is how a private window would be kept", async () => {
    const {deps} = world({
      front: () => stagedWindow(toolbarCase.name),
      answer: () => ({
        ok: true, window: {app: "Google Chrome", title: "x"}, text: "body",
        // the strip the helper cut at 82 px no longer holds the badge: the badge line sits at 140 px
        toolbarText: "mybank.example.localhost:51234/chat.html",
        lines: [
          {text: "mybank.example.localhost:51234/chat.html", topPx: 120, bottomPx: 136, leftPx: 120, rightPx: 400},
          {text: "* Incognito", topPx: 124, bottomPx: 140, leftPx: 900, rightPx: 1000}
        ],
        stats: {bandPx: 82}
      })
    });
    const result = await runToolbarCase(toolbarCase, deps);
    expect(result.private).toBe(false);
    expect(result.privateBottomPx).toBe(140);
    expect(result.bandPx).toBe(82);
    expect((result.privateBottomPx as number) > (result.bandPx as number)).toBe(true);
  });

  it("records a window that never came to the front without reading anything", async () => {
    const {deps, link} = world({front: () => ({app: "Google Chrome", title: "somebody's bank"})});
    const result = await runToolbarCase(toolbarCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.outcome).toBe("notStaged");
    expect(result.toolbarTextPresent).toBe(false);
  });

  /** Once per attempt, and the attempts are bounded at two: a failed staging leaves nothing behind. */
  it("tears down its own Chrome even when the staging failed", async () => {
    const {deps, ran} = world({front: () => null});
    const result = await runToolbarCase(toolbarCase, deps);
    expect(ran.filter((command) => command.program === "/usr/bin/pkill")).toHaveLength(2);
    expect(result.stageAttempts).toBe(2);
    expect(result.outcome).toBe("notStaged");
  });

  it("writes the bookmarks-bar preference only when that variant was asked for, beside the placement", async () => {
    const off = world({front: () => stagedWindow(toolbarCase.name)});
    await runToolbarCase(toolbarCase, off.deps);
    expect(off.preferences).toHaveLength(1);
    expect(off.preferences[0]).not.toHaveProperty("bookmark_bar");
    expect(off.preferences[0]).toHaveProperty("browser");

    const on = world({front: () => stagedWindow(toolbarCase.name)});
    await runToolbarCase(toolbarCase, {...on.deps, variant: "bookmarks-bar"});
    expect(on.preferences[0]).toMatchObject({bookmark_bar: {show_on_all_tabs: true}});
    // The two live in one file, so the variant must not have cost the placement or the other way
    // round: this is the half that a merge written the obvious way silently drops.
    expect(on.preferences[0]).toHaveProperty("browser");
  });
});

describe("where a staged window is put", () => {
  const positionOf = (ran: {program: string; args: readonly string[]}[]): string | undefined =>
    ran
      .find((command) => command.program === "/usr/bin/open")
      ?.args.find((arg) => arg.startsWith("--window-position="));

  it("puts every accuracy window at the default corner when nobody asked for one", async () => {
    const {deps, ran} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, deps);
    expect(positionOf(ran)).toBe("--window-position=40,60");
    expect(positionOf(ran)).toBe(`--window-position=${DEFAULT_POSITION.xPt},${DEFAULT_POSITION.yPt}`);
  });

  /** Spec 10.1 item 8: the only way to measure the 2x display is to stage the window ON it. */
  it("carries `--position` into the accuracy staging, size untouched", async () => {
    const {deps, ran} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, {...deps, position: {xPt: 3000, yPt: 140}});
    const open = ran.find((command) => command.program === "/usr/bin/open");
    expect(open?.args).toContain("--window-position=3000,140");
    expect(open?.args).toContain("--window-size=1160,640");
    expect(open?.args).not.toContain("--window-position=40,60");
  });

  it("carries `--position` into the toolbar staging too", async () => {
    const {deps, ran} = world({front: () => stagedWindow(toolbarCase.name)});
    await runToolbarCase(toolbarCase, {...deps, position: {xPt: 12, yPt: 0}});
    expect(positionOf(ran)).toBe("--window-position=12,0");
  });

  /**
   * A Terminal staging is a `.command` file and two xterm sequences — for SIZE and for TITLE. There
   * is no sequence here that moves the window, and the doc comment on `RunDeps.position` says so:
   * a run placed on another display stages its Chrome cases there and leaves the terminals where the
   * owner's Terminal opens them. This pins that the harness does not quietly pretend otherwise.
   */
  it("does not try to move a Terminal window", async () => {
    const {deps, ran, scripts} = world({front: () => readyTerminal("terminal-narrow")});
    await runAccuracyCase(terminalCase, {...deps, position: {xPt: 3000, yPt: 140}});
    expect(positionOf(ran)).toBeUndefined();
    expect(scripts[0]?.contents).not.toContain("3000");
  });
});

describe("the coldstart mode", () => {
  /**
   * The whole claim of this mode, asserted on the lines a fake helper RECEIVED rather than on the
   * code reading as if it sends none: `coldstart` opens no window, so it has no staged window to ask
   * about and nothing it is allowed to read. The `permission` question is `main.ts`'s, in every mode.
   */
  it("writes no read and no frontWindow line at all", async () => {
    const {deps, link, ran, scripts} = world({front: () => stagedWindow("chat-light-14")});
    const runs = await runMode("coldstart", {...deps, seconds: 4});
    expect(link.sent).toEqual([]);
    expect(link.ops()).not.toContain("read");
    expect(link.ops()).not.toContain("frontWindow");
    expect(runs).toEqual({accuracy: [], toolbar: [], observe: []});
    // and it stages nothing: no window opened, no script written, no teardown
    expect(ran).toEqual([]);
    expect(scripts).toEqual([]);
  });

  it.each(["accuracy", "toolbar", "observe"] as const)("is not what %s does", async (mode) => {
    const {deps, link} = world({front: () => stagedWindow("chat-light-14")});
    await runMode(mode, {...deps, seconds: 4});
    expect(link.sent.length).toBeGreaterThan(0);
  });
});

describe("observe mode", () => {
  const first = OBSERVE_CASES[0] as (typeof OBSERVE_CASES)[number];

  it("reads a window the OWNER staged, once, and files it under the case in its title", async () => {
    const {deps, link} = world({
      front: () => ({app: "Safari", title: stagedTitleOf(first.name, NONCE)}),
      answer: () => ({
        ok: true, window: {app: "Safari", title: "x"}, text: "body", toolbarText: "127.0.0.1",
        lines: [{text: "@ 127.0.0.1", topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200}], stats: {bandPx: 41}
      })
    });
    const results = await runObserve({...deps, seconds: 4}, [first]);
    expect(results).toHaveLength(1);
    expect(results[0]?.case).toBe(first.name);
    expect(results[0]?.app).toBe("Safari");
    expect(results[0]?.host).toBe(true);
    expect(readLines(link)).toHaveLength(1);
    /**
     * Safari's read asks for the line boxes too, and it is the one that matters most: carried item
     * 29 — a Safari private window, "the single most consequential unmeasured behaviour in the
     * sub-project" — is measured through `privateBottomPx` against `bandPx`, and neither exists
     * without them. Chrome's half of this call is pinned in its own describe; this is the mirror,
     * so a change that dropped either browser's boxes fails here.
     */
    expect(readLines(link)[0]?.lines).toBe(true);
    expect(results[0]?.privateBottomPx).toBeNull();
    expect(results[0]?.bandPx).toBe(41);
  });

  it("reads nothing at all when the owner never stages anything", async () => {
    const {deps, link} = world({front: () => ({app: "Safari", title: "Bank - Accounts"})});
    const results = await runObserve({...deps, seconds: 4}, [first]);
    expect(results).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });

  it("refuses a staged title in the wrong app", async () => {
    const {deps, link} = world({front: () => ({app: "Google Chrome", title: stagedTitleOf(first.name, NONCE)})});
    expect(await runObserve({...deps, seconds: 4}, [first])).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });
});

/**
 * Chrome, hand-staged. The same guard, the same rule and the same `lines: true` as Safari — the only
 * thing that differs is the app name, which is compared exactly. These three are the guard's whole
 * surface for a Chrome case: wrong app, wrong run, right window.
 */
describe("observe mode, in Chrome", () => {
  const chromePrivate = OBSERVE_CASES.find((entry) => entry.name === "chrome-private-chat-light-14");
  const chromeNormal = OBSERVE_CASES.find((entry) => entry.name === "chrome-normal-ticket-dark-14");
  if (chromePrivate === undefined || chromeNormal === undefined) throw new Error("the chrome observe cases must exist");

  const chromeAnswer = (): Record<string, unknown> => ({
    ok: true, window: {app: "Google Chrome", title: "x"}, text: "body",
    toolbarText: "127.0.0.1:51234/chat.html * Incognito",
    lines: [
      {text: "127.0.0.1:51234/chat.html", topPx: 60, bottomPx: 76, leftPx: 120, rightPx: 400},
      {text: "* Incognito", topPx: 60, bottomPx: 75, leftPx: 900, rightPx: 1000}
    ],
    stats: {bandPx: 82, captureMs: 30, recogniseMs: 150, cacheHit: false, width: 1268, height: 708}
  });

  it("reads nothing when a SAFARI window carries a chrome case's staged title", async () => {
    const {deps, link} = world({
      front: () => ({app: "Safari", title: stagedTitleOf(chromePrivate.name, NONCE)}),
      answer: chromeAnswer
    });
    expect(await runObserve({...deps, seconds: 4}, [chromePrivate])).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });

  it("reads nothing when the right app carries another run's nonce", async () => {
    const {deps, link} = world({
      front: () => ({app: "Google Chrome", title: stagedTitleOf(chromePrivate.name, "999999")}),
      answer: chromeAnswer
    });
    expect(await runObserve({...deps, seconds: 4}, [chromePrivate])).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });

  it("reads nothing when the right app carries another chrome case of this run", async () => {
    const {deps, link} = world({
      front: () => ({app: "Google Chrome", title: stagedTitleOf(chromeNormal.name, NONCE)}),
      answer: chromeAnswer
    });
    expect(await runObserve({...deps, seconds: 4}, [chromePrivate])).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });

  /**
   * `lines: true` is not a detail: `hostBottomPx`, `privateBottomPx` and `stats.bandPx` are the three
   * numbers carried item 30 is about — a badge measured BELOW the band is a private window the
   * product would have KEPT — and without the line boxes none of them is recorded at all.
   */
  it("reads the window it was shown exactly once, with the line boxes", async () => {
    const front: FrontWindow = {
      app: "Google Chrome", bundleId: "com.google.Chrome", title: `${stagedTitleOf(chromePrivate.name, NONCE)} - Google Chrome`
    };
    const {deps, link} = world({front: () => front, answer: chromeAnswer});
    const results = await runObserve({...deps, seconds: 8}, [chromePrivate]);
    const reads = readLines(link);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.expect).toEqual(front);
    expect(reads[0]?.lines).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      case: chromePrivate.name, app: "Google Chrome", mode: "incognito", expectPrivate: true,
      outcome: "ok", host: true, hostBottomPx: 76, private: true, privateBottomPx: 75, bandPx: 82
    });
  });

  /**
   * The app string this harness hands the product's rule is the CASE's, which the guard has already
   * matched exactly against the window — and the two browsers' rules are not the same rule.
   *
   * Safari's badge is the bare word (`SAFARI_BADGE` in `core/exclusions/privateWindows.ts`); Chrome's
   * is "Incognito", and the core deliberately does NOT let the bare word count for Chrome, because a
   * perfectly ordinary address can contain it as a path segment. Hand "Safari" to a Chrome case and
   * a normal Chrome window on `…/acme/private-api` is recorded `private: true` — a `falsePrivate`
   * that fails a run for a reason that is not real, while the harness quietly stops measuring
   * Chrome's actual rule at all. One strip, both browsers, opposite answers.
   */
  const privateWordInAnAddress = "127.0.0.1:51234/acme/private-api  Private";

  it("does not call a normal CHROME window private for the word `private` inside an address", async () => {
    const {deps} = world({
      front: () => ({app: "Google Chrome", title: stagedTitleOf(chromeNormal.name, NONCE)}),
      answer: () => ({
        ok: true, window: {app: "Google Chrome", title: "x"}, text: "body",
        toolbarText: privateWordInAnAddress,
        lines: [{text: privateWordInAnAddress, topPx: 60, bottomPx: 76, leftPx: 120, rightPx: 400}],
        stats: {bandPx: 82}
      })
    });
    const rows = await runObserve({...deps, seconds: 4}, [chromeNormal]);
    expect(rows[0]).toMatchObject({outcome: "ok", host: true, private: false, expectPrivate: false});
    const verdict = summarise("observe", [], [], rows).observe;
    expect(verdict?.falsePrivate).toBe(0);
    expect(verdict?.passed).toBe(true);
  });

  it("does call a SAFARI window private for that same bare word, which is Safari's badge", async () => {
    const safariPrivate = OBSERVE_CASES.find((entry) => entry.name === "safari-private-chat-light-14");
    if (safariPrivate === undefined) throw new Error("the safari observe cases must exist");
    const {deps} = world({
      front: () => ({app: "Safari", title: stagedTitleOf(safariPrivate.name, NONCE)}),
      answer: () => ({
        ok: true, window: {app: "Safari", title: "x"}, text: "body",
        toolbarText: privateWordInAnAddress,
        lines: [{text: privateWordInAnAddress, topPx: 20, bottomPx: 37, leftPx: 120, rightPx: 400}],
        stats: {bandPx: 41}
      })
    });
    const rows = await runObserve({...deps, seconds: 4}, [safariPrivate]);
    expect(rows[0]).toMatchObject({outcome: "ok", private: true, expectPrivate: true, privateBottomPx: 37});
    expect(summarise("observe", [], [], rows).observe?.privateMissed).toBe(0);
  });

  /** The product's own rule, called with Chrome's name: a normal window is not flagged private. */
  it("does not call a normal Chrome window private", async () => {
    const {deps} = world({
      front: () => ({app: "Google Chrome", title: stagedTitleOf(chromeNormal.name, NONCE)}),
      answer: () => ({
        ok: true, window: {app: "Google Chrome", title: "x"}, text: "body",
        toolbarText: "127.0.0.1:51234/ticket.html",
        lines: [{text: "127.0.0.1:51234/ticket.html", topPx: 60, bottomPx: 76, leftPx: 120, rightPx: 400}],
        stats: {bandPx: 82}
      })
    });
    const results = await runObserve({...deps, seconds: 4}, [chromeNormal]);
    expect(results[0]).toMatchObject({outcome: "ok", host: true, private: false, expectPrivate: false});
  });
});

describe("reading an answer", () => {
  it("takes the host rule from toolbar.py: squashed, lowercased, substring", () => {
    expect(hostInToolbar("MyBank . Example . LocalHost :8765/x", "mybank.example.localhost")).toBe(true);
    expect(hostInToolbar("app.clave.localhost:8765", "mybank.example.localhost")).toBe(false);
  });

  it("maps every answer to a fixed outcome code", () => {
    expect(failureOutcome({ok: true, body: {ok: true}})).toBe("ok");
    expect(failureOutcome({ok: true, body: {ok: false, reason: "black"}})).toBe("black");
    expect(failureOutcome({ok: true, body: {ok: false, reason: "something new"}})).toBe("failed");
    expect(failureOutcome({ok: false, why: "timeout"})).toBe("timeout");
    expect(failureOutcome({ok: false, why: "down"})).toBe("down");
  });

  it("reads stats and drops anything that is not a number", () => {
    expect(statsOf({stats: {captureMs: 30, recogniseMs: 150, cacheHit: true, width: 1268, height: 708}}))
      .toEqual({captureMs: 30, recogniseMs: 150, cacheHit: true, widthPx: 1268, heightPx: 708});
    expect(statsOf({stats: {captureMs: "thirty"}}).captureMs).toBeNull();
    expect(statsOf({})).toEqual({captureMs: null, recogniseMs: null, cacheHit: null, widthPx: null, heightPx: null});
    expect(bandPxOf({stats: {bandPx: 82}})).toBe(82);
    expect(bandPxOf({})).toBeNull();
  });

  it("keeps only line boxes that are whole", () => {
    expect(linesOf({lines: [
      {text: "a", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4},
      {text: "b", topPx: 1},
      "not an object"
    ]})).toEqual([{text: "a", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}]);
    expect(linesOf({})).toEqual([]);
  });

  it("says nothing about a browser whose strip the helper did not send", () => {
    const facts = toolbarFacts({text: "x"}, {host: "app.clave.localhost", app: "Google Chrome"});
    expect(facts.host).toBeNull();
    expect(facts.private).toBeNull();
    expect(facts.toolbarTextPresent).toBe(false);
    expect(facts.toolbarTextLength).toBeNull();
  });

  it("accepts Safari's bare 'Private' badge and Chrome's Incognito, as the product's rule does", () => {
    expect(toolbarFacts({toolbarText: "127.0.0.1 - Private"}, {host: "127.0.0.1", app: "Safari"}).private).toBe(true);
    expect(toolbarFacts({toolbarText: "github.com/acme/private-api"}, {host: "github.com", app: "Google Chrome"}).private).toBe(false);
    expect(toolbarFacts({toolbarText: "x * Incognito"}, {host: "x", app: "Google Chrome"}).private).toBe(true);
  });
});
/**
 * H1, the staging half: a Chrome window is only sized by the flags that reach the process which
 * opens it, so the run must make sure that process is a NEW one — and say, in numbers, whether it
 * worked.
 */
describe("staging Chrome so that its size can be honoured", () => {
  it("waits for the previous staged Chrome to be gone before it opens the next window", async () => {
    const {deps, log} = world({front: () => stagedWindow("chat-light-14"), alive: (ask) => ask <= 2});
    const result = await runAccuracyCase(chatCase, deps);
    const opened = log.indexOf("run /usr/bin/open");
    expect(log.slice(0, opened)).toEqual(["pgrep true", "pgrep true", "pgrep false", "preferences"]);
    // and the wait is recorded, so a run in which this mattered says so
    expect(result.repetitions[0]?.chromeWaitMs).toBe(200);
  });

  it("costs one ask when nothing of ours is left running", async () => {
    const {deps, log} = world({front: () => stagedWindow("chat-light-14")});
    const result = await runAccuracyCase(chatCase, deps);
    expect(log.slice(0, log.indexOf("run /usr/bin/open"))).toEqual(["pgrep false", "preferences"]);
    expect(result.repetitions[0]?.chromeWaitMs).toBe(0);
  });

  /** Bounded: a Chrome that will not go must not hang a session the owner is sitting through. */
  it("gives up waiting after a bounded number of asks and stages anyway", async () => {
    const {deps, log} = world({front: () => stagedWindow("chat-light-14"), alive: () => true});
    const result = await runAccuracyCase(chatCase, deps);
    expect(log.filter((entry) => entry.startsWith("pgrep"))).toHaveLength(4);
    expect(log).toContain("run /usr/bin/open");
    expect(result.repetitions[0]?.outcome).toBe("ok");
  });

  it("writes the placement into the profile before the window is opened", async () => {
    const {deps, log, preferences} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, deps);
    expect(log.indexOf("preferences")).toBeLessThan(log.indexOf("run /usr/bin/open"));
    expect(preferences[0]).toMatchObject({browser: {window_placement: {left: 40, top: 60, right: 1200, bottom: 700}}});
  });

  it("puts the work area it was given into the placement, and nothing when it has none", async () => {
    const {deps, preferences} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, {...deps, workArea: {xPt: 0, yPt: 25, widthPt: 1280, heightPt: 775}});
    expect(preferences[0]).toMatchObject({browser: {window_placement: {work_area_right: 1280, work_area_bottom: 800}}});
    const without = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracyCase(chatCase, without.deps);
    expect(JSON.stringify(without.preferences[0])).not.toContain("work_area");
  });

  it("waits and writes the placement for a toolbar staging too", async () => {
    const {deps, log} = world({front: () => stagedWindow(toolbarCase.name), alive: (ask) => ask <= 1});
    await runToolbarCase(toolbarCase, deps);
    expect(log.slice(0, log.indexOf("run /usr/bin/open"))).toEqual(["pgrep true", "pgrep false", "preferences"]);
  });

  /** A Terminal staging is neither killed nor waited for: there is no Chrome of ours in it at all. */
  it("asks nothing of pgrep for a terminal case", async () => {
    const {deps, log} = world({front: () => readyTerminal("terminal-narrow")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(log.filter((entry) => entry.startsWith("pgrep"))).toEqual([]);
    expect(result.repetitions[0]?.chromeWaitMs).toBeNull();
  });
});

/** H1, the recording half: whatever the staging did, the results say what was asked for and what came. */
describe("the size a window was actually read at", () => {
  it("records the staged points, the capture, the scale and that they agree", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const result = await runAccuracyCase(chatCase, deps);
    const first = result.repetitions[0];
    expect(first?.staged).toEqual({widthPt: 1160, heightPt: 640, columns: null, rows: null});
    expect(first?.stats.widthPx).toBe(1160);
    expect(first?.scale).toBe(1);
    expect(first?.sizeAsStaged).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it("sees a 2x capture of the staged window as staged", async () => {
    const {deps} = world({
      front: () => stagedWindow("chat-light-14"),
      answer: () => ({ok: true, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 30, recogniseMs: 150, cacheHit: false, width: 2320, height: 1280}})
    });
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.scale).toBe(2);
    expect(result.repetitions[0]?.sizeAsStaged).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  /**
   * The first run against a screen, reproduced: the read works, the accuracy is perfect, and the
   * window is not the one that was asked for. The numbers are still reported; the case is INCOMPLETE,
   * so nothing about it can be read as a pass.
   */
  it("still scores a window of the wrong size, and makes its case incomplete", async () => {
    const {deps} = world({
      front: () => stagedWindow("chat-light-14"),
      answer: () => ({ok: true, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 30, recogniseMs: 150, cacheHit: false, width: 1416, height: 1768}})
    });
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
    expect(result.minAccuracy).toBe(1);
    expect(result.repetitions[0]?.scale).toBeNull();
    expect(result.repetitions[0]?.sizeAsStaged).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it("records the size of a toolbar capture the same way", async () => {
    const {deps} = world({
      front: () => stagedWindow(toolbarCase.name),
      answer: () => ({ok: true, toolbarText: "Incognito", lines: [], stats: {captureMs: 9, recogniseMs: 9, cacheHit: false, width: 1416, height: 1768}})
    });
    const result = await runToolbarCase(toolbarCase, deps);
    expect(result.staged).toEqual({widthPt: 1160, heightPt: 640, columns: null, rows: null});
    expect(result.sizeAsStaged).toBe(false);
    expect(summarise("toolbar", [], [result]).toolbar?.incompleteCases).toEqual([toolbarCase.name]);
  });

  it("says nothing about a size for a staging that never read", async () => {
    const {deps} = world({front: () => null});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.sizeAsStaged).toBeNull();
    expect(result.repetitions[0]?.scale).toBeNull();
    expect(result.repetitions[0]?.stageMs).toBeNull();
  });

  it("records how long the staging took to reach the guard", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const result = await runAccuracyCase(chatCase, {...deps, settleMs: 1_500});
    expect(result.repetitions[0]?.stageMs).toBe(1_500);
  });
});

/** H2: the Terminal repairs, over the orchestration. */
describe("a terminal window that has not finished printing", () => {
  it("is never read: the title alone is not the text", async () => {
    const {deps, link} = world({front: () => stagedWindow("terminal-narrow", "Terminal")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
    expect(result.incomplete).toBe(true);
  });

  it("is read once the shell has said READY", async () => {
    const {deps} = world({front: () => readyTerminal("terminal-narrow")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
  });

  it("is refused when another case's shell says READY", async () => {
    const {deps, link} = world({front: () => readyTerminal("terminal")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
  });

  it("is refused when the ready title carries another run's nonce", async () => {
    const title = `${stagedTitleFor("t99", "999999")}${READY_TOKEN}${readySizeToken(72, 40)}`;
    const {deps, link} = world({front: () => ({app: "Terminal", title})});
    await runAccuracyCase(terminalCase, deps);
    expect(readLines(link)).toEqual([]);
  });

  it("takes the shell's own word for the size it got", async () => {
    const asStaged = world({front: () => readyTerminal("terminal-narrow", 72, 40)});
    const first = await runAccuracyCase(terminalCase, asStaged.deps);
    expect(first.repetitions[0]?.staged).toEqual({widthPt: null, heightPt: null, columns: 72, rows: 40});
    expect(first.repetitions[0]?.sizeAsStaged).toBe(true);
    expect(first.incomplete).toBe(false);

    // Terminal ignored the resize and gave the profile's own 80 x 24: read, scored, incomplete.
    const ignored = world({front: () => readyTerminal("terminal-narrow", 80, 24)});
    const second = await runAccuracyCase(terminalCase, ignored.deps);
    expect(second.repetitions[0]?.outcome).toBe("ok");
    expect(second.repetitions[0]?.sizeAsStaged).toBe(false);
    expect(second.incomplete).toBe(true);
  });
});

/** H2's diagnostics: which half of `noMarkers` happened, without anybody seeing a word of it. */
describe("what a read came back with", () => {
  const readThat = (text: string) => ({
    ok: true, text, stats: {captureMs: 30, recogniseMs: 150, cacheHit: false, width: 1160, height: 640}
  });

  it("records both markers, the line count and the length of a good read", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.startFound).toBe(true);
    expect(first?.endFound).toBe(true);
    expect(first?.lineCount).toBe(1);
    expect(first?.textLength).toBe("STARTMARKER hello world second line ENDMARKER".length);
  });

  it("tells a lost ENDMARKER from an empty window", async () => {
    const scrolled = world({front: () => stagedWindow("chat-light-14"), answer: () => readThat("STARTMARKER hello world")});
    const one = (await runAccuracyCase(chatCase, scrolled.deps)).repetitions[0];
    expect(one?.outcome).toBe("noMarkers");
    expect(one?.startFound).toBe(true);
    expect(one?.endFound).toBe(false);
    expect(one?.textLength).toBeGreaterThan(0);

    const empty = world({front: () => stagedWindow("chat-light-14"), answer: () => readThat("")});
    const two = (await runAccuracyCase(chatCase, empty.deps)).repetitions[0];
    expect(two?.outcome).toBe("noMarkers");
    expect(two?.startFound).toBe(false);
    expect(two?.endFound).toBe(false);
    expect(two?.lineCount).toBe(0);
    expect(two?.textLength).toBe(0);
  });

  it("counts the lines of a multi-line read", async () => {
    const text = ["STARTMARKER", "one", "two", "ENDMARKER"].join(String.fromCharCode(10));
    const {deps} = world({front: () => stagedWindow("chat-light-14"), answer: () => readThat(text)});
    expect((await runAccuracyCase(chatCase, deps)).repetitions[0]?.lineCount).toBe(4);
  });
});
/** The repairs that came out of review B, over the orchestration. */
describe("the order a Chrome staging happens in", () => {
  /**
   * Important 1. The process that is QUITTING also writes `browser.window_placement` — Chrome
   * persists it as a window closes and flushes its prefs on shutdown — so a placement written before
   * that process is gone is overwritten by the size we are trying to repair. Wait, then write, then
   * open: pinned here as data, so the old order cannot come back unnoticed.
   */
  it("waits for the old Chrome, THEN writes the placement, THEN opens", async () => {
    const {deps, log} = world({front: () => stagedWindow("chat-light-14"), alive: (ask) => ask <= 2});
    await runAccuracyCase(chatCase, deps);
    const upToOpen = log.slice(0, log.indexOf("run /usr/bin/open"));
    expect(upToOpen).toEqual(["pgrep true", "pgrep true", "pgrep false", "preferences"]);
    // stated as the rule rather than only as a list: nothing of ours is alive when we write, and
    // nothing happens between the write and the launch that reads it
    expect(upToOpen.lastIndexOf("preferences")).toBe(upToOpen.length - 1);
    expect(upToOpen.indexOf("preferences")).toBeGreaterThan(upToOpen.lastIndexOf("pgrep true"));
  });

  it("keeps that order for a toolbar staging", async () => {
    const {deps, log} = world({front: () => stagedWindow(toolbarCase.name), alive: (ask) => ask <= 3});
    await runToolbarCase(toolbarCase, deps);
    const upToOpen = log.slice(0, log.indexOf("run /usr/bin/open"));
    expect(upToOpen[upToOpen.length - 1]).toBe("preferences");
    expect(upToOpen.filter((entry) => entry === "preferences")).toHaveLength(1);
  });
});

describe("the display the run was staged on", () => {
  it("records the scale the display itself reported, beside the inferred one", async () => {
    const {deps} = world({
      front: () => stagedWindow("chat-light-14"),
      answer: () => ({ok: true, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 1, recogniseMs: 1, cacheHit: false, width: 2320, height: 1280}})
    });
    const first = (await runAccuracyCase(chatCase, {...deps, displayScale: 2})).repetitions[0];
    expect(first?.displayScale).toBe(2);
    expect(first?.scale).toBe(2);
    expect(first?.sizeAsStaged).toBe(true);
  });

  /** The display says 1x, so a 2x-sized capture is NOT the staged window however neatly it divides. */
  it("believes the display over the arithmetic", async () => {
    const {deps} = world({
      front: () => stagedWindow("chat-light-14"),
      answer: () => ({ok: true, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 1, recogniseMs: 1, cacheHit: false, width: 2320, height: 1280}})
    });
    const result = await runAccuracyCase(chatCase, {...deps, displayScale: 1});
    expect(result.repetitions[0]?.sizeAsStaged).toBe(false);
    expect(result.repetitions[0]?.scale).toBe(2);
    expect(result.incomplete).toBe(true);
  });

  it("carries it onto a toolbar row, which this harness did stage", async () => {
    const {deps} = world({front: () => stagedWindow(toolbarCase.name)});
    expect((await runToolbarCase(toolbarCase, {...deps, displayScale: 2})).displayScale).toBe(2);
  });

  /**
   * And NEVER onto an observe row: the owner opened that window, on whatever display he opened it
   * on, and the scale of the display the harness would have staged on says nothing about it.
   */
  it("says nothing about the display of a window the owner staged", async () => {
    const observeCase = OBSERVE_CASES[0] as {name: string; app: string};
    const {deps} = world({front: () => stagedWindow(observeCase.name, observeCase.app)});
    const rows = await runObserve({...deps, displayScale: 2, seconds: 1}, [OBSERVE_CASES[0] as never]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.displayScale).toBeNull();
    expect(rows[0]?.stageAttempts).toBeNull();
    expect(rows[0]?.chromeWaitMs).toBeNull();
  });

  it("is null when nobody asked a display", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    expect((await runAccuracyCase(chatCase, deps)).repetitions[0]?.displayScale).toBeNull();
  });
});

/** Minor 1, end to end: a row count that merely starts with the staged one is not the staged size. */
describe("a terminal that reports a longer number than it was asked for", () => {
  it("is not as staged", async () => {
    const longer = world({front: () => readyTerminal("terminal-narrow", 72, 400)});
    const result = await runAccuracyCase(terminalCase, longer.deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
    expect(result.repetitions[0]?.sizeAsStaged).toBe(false);
    expect(result.incomplete).toBe(true);
  });
});
/**
 * Repair loop 2, P2. In two of the three staged runs of 2026-09-21 the FIRST Chrome case of the run
 * came back `notStaged` with `chromeWaitMs` about 20 ms and no `stageMs` — the window never came to
 * the front and nothing was read — while every later case staged easily.
 */
describe("a Chrome window that never came to the front", () => {
  /** `front` answers null until the second staging's window appears. */
  const lateWorld = (appearsAfter: number) => {
    let asked = 0;
    return world({front: () => { asked += 1; return asked > appearsAfter ? stagedWindow("chat-light-14") : null; }});
  };

  it("is staged once more before it is recorded as notStaged", async () => {
    const {deps, log} = lateWorld(6);
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
    expect(result.repetitions[0]?.stageAttempts).toBe(2);
    // the second attempt is a whole fresh staging, in the repaired order
    expect(log.filter((entry) => entry === "run /usr/bin/open")).toHaveLength(2);
    expect(log.filter((entry) => entry === "preferences")).toHaveLength(2);
    expect(log.filter((entry) => entry === "run /usr/bin/pkill").length).toBeGreaterThanOrEqual(2);
    const secondOpen = log.lastIndexOf("run /usr/bin/open");
    expect(log.lastIndexOf("preferences")).toBeLessThan(secondOpen);
    expect(log.lastIndexOf("pgrep false")).toBeLessThan(log.lastIndexOf("preferences"));
  });

  it("gives up after exactly one more attempt", async () => {
    const {deps, log} = world({front: () => null});
    const result = await runAccuracyCase(chatCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
    expect(result.repetitions[0]?.stageAttempts).toBe(2);
    expect(log.filter((entry) => entry === "run /usr/bin/open")).toHaveLength(2);
  });

  /** A re-stage is a NEW window, never a second read of the same one. */
  it("reads once, from the staging that worked", async () => {
    const {deps, link} = lateWorld(6);
    await runAccuracyCase(chatCase, deps);
    // the scored read plus the one cache probe, and not one more
    expect(readLines(link)).toHaveLength(2);
  });

  /** A Terminal window is never killed by this harness, so re-staging one would leave two. */
  it("is not done for a terminal case", async () => {
    const {deps, log} = world({front: () => stagedWindow("terminal-narrow", "Terminal")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
    expect(result.repetitions[0]?.stageAttempts).toBe(1);
    expect(log.filter((entry) => entry === "run /usr/bin/open")).toHaveLength(1);
  });

  it("counts one attempt when the window was there at once", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    expect((await runAccuracyCase(chatCase, deps)).repetitions[0]?.stageAttempts).toBe(1);
  });
});

/** The first Chrome window of a RUN waits longer than the rest. */
describe("the first staging of a run", () => {
  it("is 30 s, against the guard's ordinary 15 s", () => {
    expect(FIRST_STAGE_GUARD_TIMEOUT_MS).toBe(30_000);
    expect(FIRST_STAGE_GUARD_TIMEOUT_MS).toBeGreaterThan(GUARD_TIMEOUT_MS);
  });

  /** The rule itself: who gets the generous wait, and who may override it. */
  it("gives it to the first Chrome staging of a run and to nothing else", () => {
    const base = world({front: () => null}).deps;
    const fresh = {...base, guard: {pollMs: 200}, progress: {chromeStagings: 1}};
    expect(guardTimeoutFor(fresh, true)).toBe(FIRST_STAGE_GUARD_TIMEOUT_MS);
    // the run has moved on: the ordinary timeout (the guard's own default) applies
    expect(guardTimeoutFor({...fresh, progress: {chromeStagings: 2}}, true)).toBeUndefined();
    // a terminal staging never gets it: there is no first Chrome window in it
    expect(guardTimeoutFor(fresh, false)).toBeUndefined();
    // and a caller that named a timeout keeps it, which is what the tests here rely on
    expect(guardTimeoutFor({...fresh, guard: {timeoutMs: 1_000}}, true)).toBe(1_000);
  });

  /**
   * And the behaviour, measured on the FIRST attempt only: the clock runs on across a re-stage, so
   * an absolute reading would pass however short each attempt was.
   */
  it("keeps asking past the ordinary timeout before it gives up on the first attempt", async () => {
    const asks: number[] = [];
    let clock = 0;
    let opens = 0;
    const base = world({front: () => null});
    const deps: RunDeps = {
      ...base.deps,
      stager: {...base.deps.stager, run: async (command) => {
        if (command.program === "/usr/bin/open") opens += 1;
      }},
      guard: {pollMs: 1_000},
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      progress: {chromeStagings: 0}
    };
    const counting: RunDeps = {
      ...deps,
      helper: {
        ...deps.helper,
        frontWindow: async () => { if (opens === 1) asks.push(clock); return {ok: true as const, body: {window: null}}; }
      }
    };
    await runAccuracyCase(chatCase, counting);
    const firstAttempt = Math.max(...asks) - Math.min(...asks);
    expect(firstAttempt).toBeGreaterThan(GUARD_TIMEOUT_MS);
    expect(firstAttempt).toBeLessThanOrEqual(FIRST_STAGE_GUARD_TIMEOUT_MS);
  });

  /** One counter for the whole run, so the generosity is spent once and not per case. */
  it("counts the run's Chrome stagings in one place", async () => {
    const progress = {chromeStagings: 0};
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    await runAccuracy({...deps, progress}, [chatCase, chatCase]);
    expect(progress.chromeStagings).toBe(2);
  });
});

/**
 * Repair loop 2, P1 and P3. What the shell said about its own window, and which display's scale a
 * row may claim.
 */
describe("what a terminal reported about itself", () => {
  it("records the two numbers from the ready title", async () => {
    const {deps} = world({front: () => readyTerminal("terminal-narrow", 72, 40)});
    const first = (await runAccuracyCase(terminalCase, deps)).repetitions[0];
    expect(first?.readyColumns).toBe(72);
    expect(first?.readyRows).toBe(40);
    expect(first?.sizeAsStaged).toBe(true);
  });

  /** The first run's failure, now legible: the shell said 80x24 where 72x40 was asked for. */
  it("records what it said even when that is not what was asked for", async () => {
    const {deps} = world({front: () => readyTerminal("terminal-narrow", 80, 24)});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(result.repetitions[0]?.readyColumns).toBe(80);
    expect(result.repetitions[0]?.readyRows).toBe(24);
    expect(result.repetitions[0]?.sizeAsStaged).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it("records nothing about a size for an unreadable token", async () => {
    const title = `${stagedTitleOf("terminal-narrow", NONCE)}${READY_TOKEN} x.`;
    const {deps} = world({front: () => ({app: "Terminal", title})});
    const first = (await runAccuracyCase(terminalCase, deps)).repetitions[0];
    expect(first?.outcome).toBe("ok");
    expect(first?.readyColumns).toBeNull();
    expect(first?.readyRows).toBeNull();
    expect(first?.sizeAsStaged).toBe(false);
  });

  it("says nothing about a display it cannot know the window is on", async () => {
    const {deps} = world({front: () => readyTerminal("terminal-narrow", 72, 40)});
    const first = (await runAccuracyCase(terminalCase, {...deps, displayScale: 2})).repetitions[0];
    // the harness neither sizes nor places a Terminal window: the 2026-09-21 run put one terminal on
    // the 1x display and the other on the 2x one
    expect(first?.displayScale).toBeNull();
    expect(first?.scale).toBeNull();
  });

  it("keeps the display's scale on a Chrome case", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    expect((await runAccuracyCase(chatCase, {...deps, displayScale: 2})).repetitions[0]?.displayScale).toBe(2);
  });

  it("records no ready size for a browser case", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.readyColumns).toBeNull();
    expect(first?.readyRows).toBeNull();
  });
});
/**
 * Review C, Important 1. A repetition that was staged twice must report the SECOND attempt's wait
 * beside its own `stageMs` and `stageAttempts`: `chromeWaitMs` is the number the first-Chrome-case
 * failure of 2026-09-21 was diagnosed from, and a row whose wait belongs to a staging that was
 * thrown away makes the next diagnosis unfalsifiable from the file.
 */
describe("what a re-staged row says about the wait", () => {
  /**
   * The reviewer's world: the old Chrome is GONE for the first staging (one `pgrep`, 0 ms of
   * waiting) and ALIVE for two polls of the second (200 ms), and the staged window only appears
   * after the first guard has given up.
   */
  const reStagedWorld = () => {
    let asked = 0;
    let pgreps = 0;
    return world({
      front: () => { asked += 1; return asked > 6 ? stagedWindow("chat-light-14") : null; },
      alive: () => { pgreps += 1; return pgreps > 1 && pgreps <= 3; }
    });
  };

  it("reports the second staging's wait on an accuracy row", async () => {
    const {deps} = reStagedWorld();
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.stageAttempts).toBe(2);
    expect(first?.outcome).toBe("ok");
    expect(first?.chromeWaitMs).toBe(200);
  });

  it("reports it the same way on a toolbar row", async () => {
    let asked = 0;
    let pgreps = 0;
    const {deps} = world({
      front: () => { asked += 1; return asked > 6 ? stagedWindow(toolbarCase.name) : null; },
      alive: () => { pgreps += 1; return pgreps > 1 && pgreps <= 3; }
    });
    const row = await runToolbarCase(toolbarCase, deps);
    expect(row.stageAttempts).toBe(2);
    expect(row.outcome).toBe("ok");
    expect(row.chromeWaitMs).toBe(200);
  });

  /** And a row that was staged once still reports its own wait, not somebody's default. */
  it("reports the only staging's wait when there was no re-stage", async () => {
    let pgreps = 0;
    const {deps} = world({front: () => stagedWindow("chat-light-14"), alive: () => { pgreps += 1; return pgreps <= 2; }});
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.stageAttempts).toBe(1);
    expect(first?.chromeWaitMs).toBe(200);
  });
});

/** Review C, Minors 2 and 3: whose counter, and what a caller without one gets. */
describe("who gets the generous first-staging wait", () => {
  it("is nobody, when the caller brought no counter at all", () => {
    const bare = {...world({front: () => null}).deps, guard: {pollMs: 200}};
    expect(guardTimeoutFor(bare, true)).toBeUndefined();
  });

  /** One counter for the whole run: `all` gives the generous wait once, not once per part. */
  it("is one staging of a whole `all` run, not one of each part", async () => {
    const {deps} = world({front: () => null});
    const progress = {chromeStagings: 0};
    const shared = {...deps, progress};
    await runAccuracy(shared, [chatCase]);
    await runToolbar(shared, [toolbarCase]);
    expect(progress.chromeStagings).toBeGreaterThan(2);
    // the counter the parts share is the one that was handed in, not one minted per part
    expect(withProgress(shared).progress).toBe(progress);
  });

  /**
   * The whole `all` run, measured on the only thing that is observable without a screen: how long
   * each staging was prepared to keep asking. Exactly ONE staging in the run may poll past the
   * ordinary timeout — with a counter per PART, the toolbar part's first window would get it too.
   */
  it("spends the generosity once in an `all` run, not once per part", async () => {
    let clock = 0;
    let staging = 0;
    const asks: {staging: number; at: number}[] = [];
    const base = world({front: () => null});
    const deps: ObserveDeps = {
      ...base.deps,
      seconds: 0,
      repetitions: 1,
      guard: {pollMs: 5_000},
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      stager: {
        ...base.deps.stager,
        run: async (command) => { if (command.program === "/usr/bin/open") staging += 1; }
      },
      helper: {
        ...base.deps.helper,
        frontWindow: async () => { asks.push({staging, at: clock}); return {ok: true as const, body: {window: null}}; }
      }
    };
    await runMode("all", deps);
    const spans = new Map<number, {first: number; last: number}>();
    for (const ask of asks) {
      const span = spans.get(ask.staging);
      if (span === undefined) spans.set(ask.staging, {first: ask.at, last: ask.at});
      else span.last = ask.at;
    }
    const generous = [...spans.values()].filter((span) => span.last - span.first > GUARD_TIMEOUT_MS);
    expect(spans.size).toBeGreaterThan(2);              // the run really did stage, many times over
    expect(generous).toHaveLength(1);
  });
});
/**
 * The fingerprint of the first real toolbar run (nonce 38f0f465d288, 2026-09-21): forty rows of
 * `notStaged`, two attempts each, nothing read, and no way to tell from the file whether Chrome had
 * opened at all, opened on somebody else's window, or opened on a page that was not ours.
 */
describe("what a notStaged row now says about itself", () => {
  const pageStats = (answer: {count: number; lastStatus: number | null}) => () => answer;

  it("separates a window that is not ours from one of ours showing the wrong page", async () => {
    const foreign = world({front: () => ({app: "Mail", title: "Inbox (14)"})});
    const first = (await runAccuracyCase(chatCase, foreign.deps)).repetitions[0];
    expect(first?.outcome).toBe("notStaged");
    expect(first?.frontAppSeen).toBe(false);
    expect(first?.stagedTitleSeen).toBe(false);

    // our browser, a page that is not ours: a connection error carries the HOST as its title
    const errored = world({front: () => ({app: "Google Chrome", title: "mybank.example.localhost"})});
    const second = (await runAccuracyCase(chatCase, errored.deps)).repetitions[0];
    expect(second?.frontAppSeen).toBe(true);
    expect(second?.stagedTitleSeen).toBe(false);
  });

  it("says whether the browser ever asked the page server for that case", async () => {
    const never = world({front: () => ({app: "Google Chrome", title: "mybank.example.localhost"})});
    const unasked = (await runAccuracyCase(chatCase, {...never.deps, pageStats: pageStats({count: 0, lastStatus: null})})).repetitions[0];
    // 0 requests puts the failure BEFORE the page: the URL, the host or the launch
    expect(unasked?.pageRequests).toBe(0);
    expect(unasked?.pageStatus).toBeNull();

    const asked = world({front: () => ({app: "Google Chrome", title: "mybank.example.localhost"})});
    const served = (await runAccuracyCase(chatCase, {...asked.deps, pageStats: pageStats({count: 1, lastStatus: 200})})).repetitions[0];
    // 1 request answered 200 with no staged title in front puts it AFTER the page
    expect(served?.pageRequests).toBe(1);
    expect(served?.pageStatus).toBe(200);
    expect(served?.stagedTitleSeen).toBe(false);
  });

  it("records the same four on a toolbar row", async () => {
    const {deps} = world({front: () => ({app: "Google Chrome", title: "mybank.example.localhost"})});
    const row = await runToolbarCase(toolbarCase, {...deps, pageStats: pageStats({count: 2, lastStatus: 404})});
    expect(row.outcome).toBe("notStaged");
    expect(row.frontAppSeen).toBe(true);
    expect(row.stagedTitleSeen).toBe(false);
    expect(row.pageRequests).toBe(2);
    expect(row.pageStatus).toBe(404);
  });

  it("asks the page server under THIS case's staged title, on both paths", async () => {
    const askedToolbar: string[] = [];
    const first = world({front: () => null});
    await runToolbarCase(toolbarCase, {
      ...first.deps,
      pageStats: (title) => { askedToolbar.push(title); return {count: 0, lastStatus: null}; }
    });
    expect(askedToolbar.length).toBeGreaterThan(0);
    expect(askedToolbar.every((title) => title === stagedTitleOf(toolbarCase.name, NONCE))).toBe(true);

    // the accuracy path asks under its own case's title, which is a different string
    const askedAccuracy: string[] = [];
    const second = world({front: () => null});
    await runAccuracyCase(chatCase, {
      ...second.deps,
      pageStats: (title) => { askedAccuracy.push(title); return {count: 0, lastStatus: null}; }
    });
    expect(askedAccuracy.length).toBeGreaterThan(0);
    expect(askedAccuracy.every((title) => title === stagedTitleOf(chatCase.name, NONCE))).toBe(true);
    expect(askedAccuracy[0]).not.toBe(askedToolbar[0]);
  });

  it("says both are true on a row that was staged and read", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.frontAppSeen).toBe(true);
    expect(first?.stagedTitleSeen).toBe(true);
  });

  it("says nothing about them when nothing was measured", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const observed = await runObserve({...deps, seconds: 0}, [OBSERVE_CASES[0] as never]);
    expect(observed).toEqual([]);
  });
});

/** The run stages what the limit asked for, in the order a short run needs. */
describe("a limited run", () => {
  it("stages the first n accuracy cases and no more", async () => {
    const {deps, log} = world({front: () => stagedWindow("chat-light-14")});
    const results = await runAccuracy({...deps, limit: 2}, [chatCase, chatCase, chatCase, chatCase]);
    expect(results).toHaveLength(2);
    expect(log.filter((entry) => entry === "run /usr/bin/open")).toHaveLength(2);
  });

  it("stages the first n toolbar cases INTERLEAVED", async () => {
    const {deps} = world({front: () => null});
    const results = await runToolbar({...deps, limit: 4});
    expect(results.map((entry) => entry.mode)).toEqual(["normal", "incognito", "normal", "incognito"]);
  });

  it("stages the whole table when nobody asked for a limit", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    expect(await runAccuracy(deps, [chatCase, chatCase])).toHaveLength(2);
  });
});
/**
 * Review D, Important 4: the diagnostics could be disconnected from a real run with nothing
 * failing. These two are the net.
 */
describe("the diagnostics are wired to the rows that carry them", () => {
  it("carries the page counters on a SUCCESSFUL accuracy repetition, not only on a failed one", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    const first = (await runAccuracyCase(chatCase, {
      ...deps,
      pageStats: () => ({count: 3, lastStatus: 200})
    })).repetitions[0];
    expect(first?.outcome).toBe("ok");
    expect(first?.pageRequests).toBe(3);
    expect(first?.pageStatus).toBe(200);
  });

  it("carries them on a successful toolbar row too", async () => {
    const {deps} = world({front: () => stagedWindow(toolbarCase.name)});
    const row = await runToolbarCase(toolbarCase, {...deps, pageStats: () => ({count: 1, lastStatus: 200})});
    expect(row.outcome).toBe("ok");
    expect(row.pageRequests).toBe(1);
    expect(row.pageStatus).toBe(200);
  });
});
/**
 * Re-review D, Important 2. The number this loop says will decide the next run could be replaced by
 * a hard `null` in four places with nothing failing. These drive it end to end.
 */
describe("the refused title's length reaches the row", () => {
  /** A front window that is OURS and carries OUR prefix, with a title something shortened. */
  const truncated = (name: string): string => stagedTitleOf(name, NONCE).slice(0, 20);

  it("is on a notStaged accuracy repetition", async () => {
    const {deps} = world({front: () => ({app: "Google Chrome", title: truncated("chat-light-14")})});
    const first = (await runAccuracyCase(chatCase, deps)).repetitions[0];
    expect(first?.outcome).toBe("notStaged");
    expect(first?.frontAppSeen).toBe(true);
    expect(first?.stagedTitleSeen).toBe(true);
    expect(first?.refusedTitleLength).toBe(20);
  });

  it("is on a notStaged toolbar row", async () => {
    const {deps} = world({front: () => ({app: "Google Chrome", title: truncated(toolbarCase.name)})});
    const row = await runToolbarCase(toolbarCase, deps);
    expect(row.outcome).toBe("notStaged");
    expect(row.refusedTitleLength).toBe(20);
  });

  it("is null on a row whose window was approved", async () => {
    const {deps} = world({front: () => stagedWindow("chat-light-14")});
    expect((await runAccuracyCase(chatCase, deps)).repetitions[0]?.refusedTitleLength).toBeNull();
  });
});
