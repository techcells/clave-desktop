/**
 * The orchestration, end to end, against fakes: no window is ever opened, no process is ever
 * started, nothing is written. The assertions that matter most are negative ones — that no `read`
 * line was written at all — because that is the whole privacy claim of this harness.
 */
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import type {AccuracyCase, ToolbarCase, TruthName} from "./cases";
import {BROWSER_WINDOW, OBSERVE_CASES} from "./cases";
import {createEvalHelper} from "./helper";
import {bandPxOf, failureOutcome, hostInToolbar, linesOf, runAccuracyCase, runObserve, runToolbarCase, statsOf, toolbarFacts, type RunDeps, type Stager} from "./run";
import {stagedTitleFor} from "./stagedTitle";
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
}

/**
 * A world in which `front` is whatever window the window server would report and `answer` is what a
 * read comes back with.
 */
function world(options: {
  front: (asked: number) => FrontWindow | null;
  answer?: (readNumber: number) => Record<string, unknown>;
  repetitions?: number;
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
        : {ok: true, window: request.expect, text: "STARTMARKER hello world second line ENDMARKER", stats: {captureMs: 30, recogniseMs: 150, cacheHit: reads > 1, width: 1268, height: 708}};
    }
    return null;
  });
  const ran: {program: string; args: readonly string[]}[] = [];
  const scripts: {name: string; contents: string}[] = [];
  const preferences: Record<string, unknown>[] = [];
  const stager: Stager = {
    run: async (command) => { ran.push(command); },
    writeScript: async (name, contents) => { scripts.push({name, contents}); return `/out/${name}`; },
    writePreferences: async (value) => { preferences.push(value); }
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
    guard: {timeoutMs: 1_000, pollMs: 200}
  };
  return {deps, link, ran, scripts, preferences};
}

const readLines = (link: FakeLink): Record<string, unknown>[] =>
  link.sent.map((line) => JSON.parse(line) as Record<string, unknown>).filter((request) => request.op === "read");

const stagedWindow = (name: string, app = "Google Chrome"): FrontWindow =>
  ({app, bundleId: "com.google.Chrome", title: stagedTitleFor(name, NONCE)});

describe("nothing is read that was not staged", () => {
  it("writes no read line at all when another app is in front", async () => {
    const {deps, link} = world({front: () => ({app: "Mail", title: "Inbox (14)"})});
    const result = await runAccuracyCase(chatCase, deps);
    expect(readLines(link)).toEqual([]);
    expect(result.repetitions[0]?.outcome).toBe("notStaged");
    expect(result.incomplete).toBe(true);
  });

  it("writes no read line when the right app carries another run's nonce", async () => {
    const {deps, link} = world({front: () => ({app: "Google Chrome", title: `CLAVE-EVAL chat-light-14 999999`})});
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
    const {deps, ran, scripts} = world({front: () => stagedWindow("terminal-narrow", "Terminal")});
    const result = await runAccuracyCase(terminalCase, deps);
    expect(result.repetitions[0]?.outcome).toBe("ok");
    expect(scripts[0]?.name).toBe("terminal-narrow.command");
    expect(scripts[0]?.contents).toContain(stagedTitleFor("terminal-narrow", NONCE));
    expect(scripts[0]?.contents).toContain("terminal body");
    expect(ran.every((command) => command.program !== "/usr/bin/pkill")).toBe(true);
  });

  it("stages the narrow case at its own size", async () => {
    const {deps, scripts} = world({front: () => stagedWindow("terminal-narrow", "Terminal")});
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

  it("tears down its own Chrome even when the staging failed", async () => {
    const {deps, ran} = world({front: () => null});
    await runToolbarCase(toolbarCase, deps);
    expect(ran.filter((command) => command.program === "/usr/bin/pkill")).toHaveLength(1);
  });

  it("writes the bookmarks-bar preference only when that variant was asked for", async () => {
    const off = world({front: () => stagedWindow(toolbarCase.name)});
    await runToolbarCase(toolbarCase, off.deps);
    expect(off.preferences).toEqual([]);

    const on = world({front: () => stagedWindow(toolbarCase.name)});
    await runToolbarCase(toolbarCase, {...on.deps, variant: "bookmarks-bar"});
    expect(on.preferences).toEqual([{bookmark_bar: {show_on_all_tabs: true}}]);
  });
});

describe("observe mode", () => {
  const first = OBSERVE_CASES[0] as (typeof OBSERVE_CASES)[number];

  it("reads a window the OWNER staged, once, and files it under the case in its title", async () => {
    const {deps, link} = world({
      front: () => ({app: "Safari", title: stagedTitleFor(first.name, NONCE)}),
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
  });

  it("reads nothing at all when the owner never stages anything", async () => {
    const {deps, link} = world({front: () => ({app: "Safari", title: "Bank - Accounts"})});
    const results = await runObserve({...deps, seconds: 4}, [first]);
    expect(results).toEqual([]);
    expect(readLines(link)).toEqual([]);
  });

  it("refuses a staged title in the wrong app", async () => {
    const {deps, link} = world({front: () => ({app: "Google Chrome", title: stagedTitleFor(first.name, NONCE)})});
    expect(await runObserve({...deps, seconds: 4}, [first])).toEqual([]);
    expect(readLines(link)).toEqual([]);
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
