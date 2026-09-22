/**
 * The privacy test for the results file.
 *
 * A whole run is driven with a helper whose every string is a sentinel — the recognised page, the
 * toolbar strip, each line box, the window title — and then the results are serialised and searched
 * for all of them. If a field is ever added upstream that carries recognised text, and a future
 * change lets it through into the file, this is the test that fails, on a machine with no screen,
 * before anybody runs the harness on a real one.
 */
import {describe, expect, it} from "vitest";
import type {AccuracyCase, ObserveCase, ToolbarCase} from "./cases";
import {BROWSER_WINDOW, DEFAULT_POSITION, SAFARI, stagedTitleOf} from "./cases";
import {createEvalHelper, permissionOf} from "./helper";
import {NO_STATS, serialiseError, serialiseObserveProgress, serialiseResults, INCOMPLETE_OUTCOMES, type EvalMode, type EvalResults, type ObserveProgressRow} from "./results";
import {EVAL_MODES, readEvalSettings} from "./config";
import {runAccuracyCase, runMode, runObserve, runToolbarCase, type RunDeps, type Stager} from "./run";
import {READY_TOKEN, readySizeToken} from "./stagedTitle";
import {summarise} from "./summary";
import {serialiseObserveReveal} from "./observe";
import {createFakeLink, createManualSchedule, respondTo} from "./testing/fakes";

const NONCE = "abc123";

/** Every string the helper could ever hand this harness, made findable. */
const SENTINELS = {
  text: "SENTINEL-PAGE-BODY-cardnumber-4111111111111111",
  toolbar: "SENTINEL-TOOLBAR-mybank.example.com",
  line: "SENTINEL-LINE-BOX-text",
  title: "SENTINEL-WINDOW-TITLE-Inbox",
  app: "SENTINEL-APP-NAME",
  /**
   * `permission` is the one field of the results file whose value comes from a helper answer's own
   * STRING rather than from a number or a name this harness invented, so it gets a sentinel of its
   * own: `permissionOf` must map anything that is not one of the helper's three words to `unknown`.
   */
  permission: "SENTINEL-PERMISSION-ANSWER"
};

/** A helper start time. A number, so it carries nothing; every mode's results hold one. */
const HELPER = {readyMs: 812};

const chatCase: AccuracyCase = {
  kind: "browser", name: "chat-light-14", group: "chat", app: "Google Chrome",
  page: "chat", theme: "light", sizePx: 14, truth: "chat", window: BROWSER_WINDOW
};
const terminalCase: AccuracyCase = {
  kind: "terminal", name: "terminal-narrow", group: "terminal", app: "Terminal",
  columns: 72, rows: 40, truth: "terminal"
};
const toolbarCase: ToolbarCase = {
  name: "incognito-app.clave.localhost-chat-light-14", app: "Google Chrome",
  host: "app.clave.localhost", page: "chat", theme: "light", sizePx: 14,
  mode: "incognito", expectPrivate: true, window: BROWSER_WINDOW
};
/**
 * The observe path is serialised by the ONE line of `serialiseResults` that spreads anything
 * (`{...toolbarCase(entry), app: entry.app}`), so it is the one that has to be driven through the
 * sentinels too rather than assumed safe by reading.
 */
const observeCase: ObserveCase = {
  name: "safari-private-chat-light-14", app: SAFARI, page: "chat", theme: "light", sizePx: 14, expectPrivate: true
};

/**
 * `ready` makes the staged window a FINISHED terminal one: the title carries the READY token and the
 * size the shell reported, with a sentinel after it.
 *
 * The terminal path is the only new path that touches a window title at all (`run.ts` answers a
 * terminal's `sizeAsStaged` with one `String.includes` on the approved window's title), and the
 * sentinel run did not drive it — a leak into that one line was invisible here (review B, Minor 4).
 */
function depsAnsweringWithSentinels(
  name: string,
  app = "Google Chrome",
  ready?: {columns: number; rows: number}
): RunDeps {
  const link = createFakeLink();
  const title = ready === undefined
    ? `${stagedTitleOf(name, NONCE)} ${SENTINELS.title}`
    : `${stagedTitleOf(name, NONCE)}${READY_TOKEN}${readySizeToken(ready.columns, ready.rows)} ${SENTINELS.title}`;
  respondTo(link, (request) => {
    if (request.op === "permission") return {permission: SENTINELS.permission};
    if (request.op === "frontWindow") {
      return {window: {app, bundleId: "com.google.Chrome", title}};
    }
    if (request.op === "read") {
      return {
        ok: true,
        window: {app: SENTINELS.app, bundleId: "com.google.Chrome", title: SENTINELS.title},
        // Deliberately short of 0.97 as well, so the confusion list is computed and searched too.
        text: `STARTMARKER ${SENTINELS.text} ENDMARKER`,
        toolbarText: `${SENTINELS.toolbar} * Incognito`,
        lines: [{text: SENTINELS.line, topPx: 55, bottomPx: 71, leftPx: 1, rightPx: 2}],
        stats: {bandPx: 82, captureMs: 31, recogniseMs: 198, cacheHit: false, width: 1268, height: 708}
      };
    }
    return null;
  });
  const stager: Stager = {
    run: async () => undefined,
    writeScript: async (n) => `/out/${n}`,
    writePreferences: async () => undefined,
    // Nothing of ours is ever alive in this fake, so no staging waits.
    matches: async () => false
  };
  let clock = 0;
  return {
    helper: createEvalHelper({link, schedule: createManualSchedule().schedule}),
    stager,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    nonce: NONCE,
    port: 51234,
    profileDir: "/out/chrome-profile",
    truth: {chat: "hello world\n", ticket: "t\n", code: "c\n", pt: "p\n", terminal: "term\n"},
    repetitions: 2,
    settleMs: 0,
    guard: {timeoutMs: 1_000, pollMs: 200}
  };
}

describe("what reaches the results file", () => {
  it("carries not one string the helper sent", async () => {
    const accuracy = [
      await runAccuracyCase(chatCase, depsAnsweringWithSentinels(chatCase.name)),
      // the terminal path too: its `sizeAsStaged` is the one field computed from a window TITLE
      await runAccuracyCase(terminalCase, depsAnsweringWithSentinels(terminalCase.name, "Terminal", {columns: 72, rows: 40}))
    ];
    const toolbar = [await runToolbarCase(toolbarCase, depsAnsweringWithSentinels(toolbarCase.name))];
    /**
     * The progress file is driven by the SAME sentinel run, because it is written from inside the
     * watching loop with the whole row in scope: `progress` below is what `main.ts` would have put
     * on disk, and it is searched for the sentinels along with the results file.
     */
    const progress: string[] = [];
    const observe = await runObserve(
      {
        ...depsAnsweringWithSentinels(observeCase.name, SAFARI),
        seconds: 1,
        writeProgress: (rows, done) => {
          progress.push(serialiseObserveProgress({
            schema: 1, nonce: NONCE, expect: ["safari-private"], expected: 1, done, rows: [...rows]
          }));
        }
      },
      [observeCase]
    );
    const results: EvalResults = {
      schema: 5, mode: "all", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 3000, y: 140},
      accuracy, toolbar, observe, summary: summarise("all", accuracy, toolbar, observe)
    };
    // The run really did happen, or this test proves nothing.
    expect(accuracy[0]?.repetitions[0]?.outcome).toBe("ok");
    expect(accuracy[1]?.repetitions[0]?.outcome).toBe("ok");
    expect(accuracy[1]?.repetitions[0]?.sizeAsStaged).toBe(true);
    // the one measurement taken from a window title really was taken, from a title whose tail is a
    // sentinel — so "no sentinel reached the file" below is a statement about THIS path too
    expect(accuracy[1]?.repetitions[0]?.readyColumns).toBe(72);
    expect(accuracy[1]?.repetitions[0]?.readyRows).toBe(40);
    expect(toolbar[0]?.private).toBe(true);
    expect(toolbar[0]?.toolbarTextLength).toBeGreaterThan(0);
    expect(observe[0]?.outcome).toBe("ok");
    expect(observe[0]?.app).toBe(SAFARI);

    // the progress file really was written from that run, or the sweep below proves nothing of it
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toContain(observeCase.name);

    // The results file and every progress file that run would have written, swept together.
    for (const written of [serialiseResults(results), ...progress]) {
      for (const [field, sentinel] of Object.entries(SENTINELS)) {
        expect(written, `${field} reached a file this harness writes`).not.toContain(sentinel);
        expect(written, `${field} reached a file this harness writes`).not.toContain(sentinel.toLowerCase());
      }
      expect(written).not.toContain("SENTINEL");
      expect(written).not.toContain("4111111111111111");
      expect(written).not.toContain("Inbox");
      expect(written).not.toContain("READY");
      // Nor any fragment of them: the sentinels are built from words that would survive a substring,
      // nor the harness's own title grammar, which would mean a title had been copied rather than
      // tested.
      expect(written).not.toContain("CLAVE-EVAL");
    }
  });

  /**
   * The same sentinel run with `--reveal-toolbar` ON.
   *
   * This is the flag's whole safety claim, as one test: the toolbar sentinel appears in the REVEAL
   * channel, where the owner asked for it — and nowhere in the results file or in any progress file
   * the run would have written. The page-body sentinel appears in none of the three.
   */
  it("keeps a revealed strip out of the results file and out of the progress file", async () => {
    const progress: string[] = [];
    const reveal: string[] = [];
    const observe = await runObserve(
      {
        ...depsAnsweringWithSentinels(observeCase.name, SAFARI),
        seconds: 1,
        reveal: true,
        writeProgress: (rows, done) => {
          progress.push(serialiseObserveProgress({
            schema: 1, nonce: NONCE, expect: null, expected: 0, done, rows: [...rows]
          }));
        },
        writeReveal: (rows) => {
          reveal.push(serialiseObserveReveal({schema: 1, nonce: NONCE, rows: [...rows]}));
        }
      },
      [observeCase]
    );
    const written = serialiseResults({
      schema: 5, mode: "observe", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe, summary: summarise("observe", [], [], observe)
    });

    // the run really did read and really did reveal, or this proves nothing
    expect(observe[0]?.outcome).toBe("ok");
    expect(reveal.length).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);

    // the strip is in the reveal channel, which is what the flag is for
    expect(reveal.join("")).toContain(SENTINELS.toolbar);
    // and the page body is in NONE of the three, revealed or not
    for (const text of [written, ...progress, ...reveal]) {
      expect(text).not.toContain(SENTINELS.text);
      expect(text).not.toContain("4111111111111111");
      expect(text).not.toContain(SENTINELS.title);
      expect(text).not.toContain(SENTINELS.app);
    }
    // the two files that must never carry a strip do not carry this one
    for (const text of [written, ...progress]) {
      expect(text).not.toContain(SENTINELS.toolbar);
      expect(text).not.toContain("mybank");
      expect(text).not.toContain("SENTINEL");
    }
  });

  it("does carry the numbers and the codes it exists for", async () => {
    const accuracy = [await runAccuracyCase(chatCase, depsAnsweringWithSentinels(chatCase.name))];
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy, toolbar: [], observe: [], summary: summarise("accuracy", accuracy, [])
    })) as Record<string, unknown>;
    const first = (written.accuracy as Record<string, unknown>[])[0] as Record<string, unknown>;
    const repetition = (first.repetitions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(first.case).toBe("chat-light-14");
    expect(repetition.outcome).toBe("ok");
    expect(repetition.stats).toEqual({captureMs: 31, recogniseMs: 198, cacheHit: false, widthPx: 1268, heightPx: 708});
    expect(typeof repetition.accuracy).toBe("number");
    expect(written.helper).toEqual({readyMs: 812});
    expect(written.permission).toBe("granted");
    expect(written.position).toEqual({x: 40, y: 60});
  });

  /**
   * The corner is recorded whether or not anybody asked for one: a file that only carried a position
   * when `--position` was typed would leave every ordinary run's provenance implicit, which is the
   * half of spec 10.1 item 8 the field exists for. The value comes from `readEvalSettings`, so this
   * ties what the bundle was told to what the file says it did.
   */
  it("records the default corner when the option was not given, and the given one when it was", () => {
    const envelope = (env: Record<string, string | undefined>): unknown => {
      const read = readEvalSettings({CLAVE_EVAL_MODE: "accuracy", ...env}, () => "0123456789ab");
      if (!read.ok) throw new Error(read.code);
      const {position} = read.settings;
      return (JSON.parse(serialiseResults({
        schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 5, chromeVariant: "none",
        helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: position.xPt, y: position.yPt},
        accuracy: [], toolbar: [], observe: [], summary: summarise("accuracy", [], [])
      })) as Record<string, unknown>).position;
    };
    expect(envelope({})).toEqual({x: 40, y: 60});
    expect(envelope({})).toEqual({x: DEFAULT_POSITION.xPt, y: DEFAULT_POSITION.yPt});
    expect(envelope({CLAVE_EVAL_POSITION: "3000,140"})).toEqual({x: 3000, y: 140});
  });

  /** A mode that staged no window has no corner to report, and must not invent one. */
  it("records no position at all for a coldstart run", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "coldstart", nonce: NONCE, repetitions: 5, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: null,
      accuracy: [], toolbar: [], observe: [],
      summary: summarise("coldstart", [], [], [], {readyMs: HELPER.readyMs, permission: "granted"})
    })) as Record<string, unknown>;
    expect(written.position).toBeNull();
    expect("position" in written).toBe(true);
  });

  /**
   * `coldstart` writes results like any other mode, and this is the one mode whose file consists of
   * almost nothing BUT the two helper figures — so it is driven through the sentinels too rather
   * than assumed safe by reading. The helper here answers `permission` with a sentinel string.
   */
  it("carries no string the helper sent in a coldstart run either", async () => {
    const deps = depsAnsweringWithSentinels(chatCase.name);
    const runs = await runMode("coldstart", {...deps, seconds: 1});
    const permission = permissionOf(await deps.helper.permission());
    expect(permission).toBe("unknown");                       // not the sentinel the helper answered
    const written = serialiseResults({
      schema: 5, mode: "coldstart", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      helper: HELPER, permission, pageServerIpv6: null, position: null,
      accuracy: runs.accuracy, toolbar: runs.toolbar, observe: runs.observe,
      summary: summarise("coldstart", runs.accuracy, runs.toolbar, runs.observe, {readyMs: HELPER.readyMs, permission})
    });
    expect(written).not.toContain("SENTINEL");
    for (const sentinel of Object.values(SENTINELS)) expect(written).not.toContain(sentinel);
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed.helper).toEqual({readyMs: 812});
    expect(parsed.permission).toBe("unknown");
    expect(parsed.accuracy).toEqual([]);
    expect((parsed.summary as Record<string, unknown>).coldstart)
      .toEqual({readyMs: 812, permission: "unknown", passed: false});
  });

  /** Whatever the mode, the file says how long the helper took to start, and as a number. */
  it.each(EVAL_MODES)("records the helper start time in a %s run", (mode: EvalMode) => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode, nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: {readyMs: 43_912}, permission: "granted", pageServerIpv6: mode === "coldstart" ? null : true,
      position: mode === "coldstart" ? null : {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [], summary: summarise(mode, [], [], [], {readyMs: 43_912, permission: "granted"})
    })) as Record<string, unknown>;
    expect(written.helper).toEqual({readyMs: 43_912});
    expect(written.position, mode).toEqual(mode === "coldstart" ? null : {x: 40, y: 60});
    expect(typeof (written.helper as Record<string, unknown>).readyMs).toBe("number");
  });

  it("ignores a field that was never meant to be written, however it got in", () => {
    const smuggled = {
      case: "chat-light-14", group: "chat" as const, repetitions: [{
        outcome: "ok" as const, accuracy: 1, markers: true, accents: 1, stats: NO_STATS, repeat: null,
        text: "SMUGGLED-BODY"
      }],
      minAccuracy: 1, medianAccuracy: 1, minAccents: 1, incomplete: false, confusions: [],
      toolbarText: "SMUGGLED-STRIP"
    };
    const written = serialiseResults({
      schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      // The helper block is an object this harness built, so it is the obvious place for a field to
      // be added upstream and ride along. It is written out by hand for exactly this reason.
      helper: {readyMs: 812, hostname: "SMUGGLED-MACHINE-NAME"} as never,
      pageServerIpv6: true,
      permission: "granted",
      position: {x: 40, y: 60, display: "SMUGGLED-DISPLAY-NAME"} as never,
      accuracy: [smuggled as never], toolbar: [], observe: [],
      summary: {groups: [], missingGroups: [], toolbar: null, observe: null, coldstart: null, limited: null, accepted: true}
    });
    expect(written).not.toContain("SMUGGLED-BODY");
    expect(written).not.toContain("SMUGGLED-STRIP");
    expect(written).not.toContain("SMUGGLED-MACHINE-NAME");
    expect(written).not.toContain("SMUGGLED-DISPLAY-NAME");
  });

  /**
   * The same rule, for the two ROW shapes — and this is the half nothing held.
   *
   * The sentinel run above drives the observe path end to end, but `toolbarFacts` has already
   * reduced every string to a boolean or a pixel figure by the time a row exists, so driving it
   * proves nothing about the serialiser: replacing the hand-written `toolbarCase`/observe rows with
   * a spread of the row objects used to fail no test at all. These rows are handed to
   * `serialiseResults` already carrying what a future upstream field would carry — a recognised
   * body, a toolbar strip, a line box with its text, a window title, an app name — so the allow-list
   * is what has to drop them.
   *
   * The observe row is the likelier of the two to grow a field next: this task doubled it (Safari
   * and Chrome) and it is the one row with a field the toolbar row does not have (`app`).
   */
  it("ignores a field smuggled into a toolbar or an observe ROW", () => {
    const facts = {
      outcome: "ok" as const, host: true, hostDistance: 0, addressLine: true, hostBottomPx: 71, private: true,
      privateBottomPx: 70, readAttempts: 1,
      bandPx: 82, toolbarTextLength: 52, toolbarTextPresent: true, lineCount: 3, stats: NO_STATS
    };
    const written = serialiseResults({
      schema: 5, mode: "all", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [],
      toolbar: [{
        case: "incognito-mybank.example.localhost-chat-light-14", mode: "incognito", expectPrivate: true, ...facts,
        text: "SMUGGLED-BODY-TOOLBAR",
        toolbarText: "SMUGGLED-STRIP-TOOLBAR",
        lines: [{text: "SMUGGLED-LINE-TOOLBAR", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}],
        title: "SMUGGLED-TITLE-TOOLBAR"
      } as never],
      observe: [{
        case: "chrome-private-chat-light-14", app: SAFARI, mode: "incognito", expectPrivate: true, ...facts,
        text: "SMUGGLED-BODY-OBSERVE",
        toolbarText: "SMUGGLED-STRIP-OBSERVE",
        lines: [{text: "SMUGGLED-LINE-OBSERVE", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}],
        title: "SMUGGLED-TITLE-OBSERVE"
      } as never],
      summary: {groups: [], missingGroups: [], toolbar: null, observe: null, coldstart: null, limited: null, accepted: true}
    });
    for (const shape of ["TOOLBAR", "OBSERVE"]) {
      for (const field of ["BODY", "STRIP", "LINE", "TITLE"]) {
        expect(written, `${field} reached the ${shape} row`).not.toContain(`SMUGGLED-${field}-${shape}`);
      }
    }
    expect(written).not.toContain("SMUGGLED");
    // and the run really was serialised, or this proves nothing
    const parsed = JSON.parse(written) as Record<string, Record<string, unknown>[]>;
    expect(parsed.toolbar).toHaveLength(1);
    expect(parsed.observe).toHaveLength(1);
    expect(Object.keys(parsed.toolbar?.[0] ?? {}).sort()).toEqual([
      "addressLine", "bandPx", "case", "chromeWaitMs", "displayScale", "expectPrivate",
      "frontAppSeen", "host", "hostBottomPx", "hostDistance", "lineCount", "mode", "outcome",
      "pageRequests", "pageStatus", "private", "privateBottomPx", "refusedTitleLength", "scale",
      "sizeAsStaged", "stageAttempts", "stageMs", "staged", "stagedTitleSeen", "stats",
      "toolbarTextLength", "toolbarTextPresent"
    ]);
    expect(Object.keys(parsed.observe?.[0] ?? {}).sort()).toEqual([
      "addressLine", "app", "bandPx", "case", "chromeWaitMs", "displayScale", "expectPrivate",
      "frontAppSeen", "host", "hostBottomPx", "hostDistance", "lineCount", "mode", "outcome",
      "pageRequests", "pageStatus", "private", "privateBottomPx", "readAttempts",
      "refusedTitleLength", "scale", "sizeAsStaged", "stageAttempts", "stageMs", "staged",
      "stagedTitleSeen", "stats", "toolbarTextLength", "toolbarTextPresent"
    ]);
  });

  /**
   * The progress file, which is the other thing this harness writes to disk — and the riskier of the
   * two, because it is written REPEATEDLY, from inside the watching loop, with a whole
   * `ObserveCaseResult` in scope at the call site. One `...row` there would put a strip on disk once
   * every two seconds for the length of the run.
   */
  it("writes a progress row as six named fields, and drops anything smuggled beside them", () => {
    const written = serialiseObserveProgress({
      schema: 1, nonce: NONCE, expect: ["safari-private"], expected: 5, done: 1,
      rows: [{
        case: "safari-private-chat-light-14", outcome: "ok", host: true, addressLine: true,
        private: true, asExpected: true, readAttempts: 2,
        text: "SMUGGLED-BODY-PROGRESS",
        toolbarText: "SMUGGLED-STRIP-PROGRESS",
        lines: [{text: "SMUGGLED-LINE-PROGRESS", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}],
        title: "SMUGGLED-TITLE-PROGRESS"
      } as unknown as ObserveProgressRow]
    });
    expect(written).not.toContain("SMUGGLED");
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["done", "expect", "expected", "nonce", "rows", "schema"]);
    const row = (parsed.rows as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["addressLine", "asExpected", "case", "host", "outcome", "private", "readAttempts"]
    );
    expect(row).toEqual({
      case: "safari-private-chat-light-14", outcome: "ok", host: true, addressLine: true,
      private: true, asExpected: true, readAttempts: 2
    });
    expect(parsed.expect).toEqual(["safari-private"]);
  });

  /** An exploratory run's progress file says so, in the same `null` the verdict uses. */
  it("writes no expectation as null, not as an absent field", () => {
    const parsed = JSON.parse(serialiseObserveProgress({
      schema: 1, nonce: NONCE, expect: null, expected: 0, done: 0, rows: []
    })) as Record<string, unknown>;
    expect(parsed.expect).toBeNull();
    expect(Object.keys(parsed)).toContain("expect");
  });

  /**
   * Review, Important 2. The row key-set tests above catch a field that goes MISSING from the file;
   * nothing caught a field that is written as `null` on the way to it. Five separate probes —
   * nulling `hostDistance`, `readAttempts`, `expected`, `missingCases` and `reason` in
   * `serialiseResults` — left the whole suite green, and `hostDistance` is the one number the O5 fix
   * exists to deliver to the owner. So the values are asserted, not only the keys.
   */
  it("carries schema 4's new values onto disk, not only their keys", () => {
    const row = {
      case: "safari-private-chat-light-14", app: SAFARI, mode: "incognito" as const, expectPrivate: true,
      outcome: "ok" as const, host: false, hostDistance: 2, addressLine: true, hostBottomPx: 37, private: true,
      privateBottomPx: 36, bandPx: 41, toolbarTextLength: 52, toolbarTextPresent: true, lineCount: 9,
      readAttempts: 2, stats: NO_STATS, staged: {widthPt: null, heightPt: null, columns: null, rows: null},
      displayScale: null, scale: null, sizeAsStaged: null, chromeWaitMs: null, stageMs: null,
      stageAttempts: null, frontAppSeen: null, stagedTitleSeen: null, pageRequests: null,
      pageStatus: null, refusedTitleLength: null
    };
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "observe", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [],
      // the same row on both paths: `hostDistance` is a toolbar field that an observe row inherits
      toolbar: [{...row, hostDistance: 7}],
      observe: [row],
      summary: {
        groups: [], missingGroups: [], toolbar: null, coldstart: null, limited: null, accepted: false,
        observe: {
          staged: 4, read: 3, expect: ["safari-private"], expected: 5,
          missingCases: ["safari-private-code-light-11"], notCheckedCases: ["safari-normal-chat-light-14"],
          privateMissed: 0, falsePrivate: 0, incompleteCases: ["safari-private-pt-dark-11"],
          reason: "INCOMPLETE", passed: false
        }
      }
    })) as Record<string, Record<string, unknown>[] | Record<string, unknown>>;

    const observeRow = (written.observe as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(observeRow.hostDistance).toBe(2);
    expect(observeRow.readAttempts).toBe(2);
    expect(observeRow.addressLine).toBe(true);
    expect((written.toolbar as Record<string, unknown>[])[0]?.hostDistance).toBe(7);
    expect((written.toolbar as Record<string, unknown>[])[0]?.addressLine).toBe(true);

    const verdict = (written.summary as Record<string, unknown>).observe as Record<string, unknown>;
    expect(verdict).toEqual({
      staged: 4, read: 3, expect: ["safari-private"], expected: 5,
      missingCases: ["safari-private-code-light-11"], notCheckedCases: ["safari-normal-chat-light-14"],
      privateMissed: 0, falsePrivate: 0, incompleteCases: ["safari-private-pt-dark-11"],
      reason: "INCOMPLETE", passed: false
    });
    // and the key set of the verdict block, so a field smuggled into it is caught the way a row's is
    expect(Object.keys(verdict).sort()).toEqual([
      "expect", "expected", "falsePrivate", "incompleteCases", "missingCases", "notCheckedCases",
      "passed", "privateMissed", "read", "reason", "staged"
    ]);
  });

  /** An exploratory verdict reaches the file as the `null` and the word that say so. */
  it("carries an exploratory verdict onto disk as null and EXPLORATORY", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "observe", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [], summary: summarise("observe", [], [], [])
    })) as Record<string, Record<string, unknown>>;
    const verdict = written.summary?.observe as Record<string, unknown>;
    expect(verdict.expect).toBeNull();
    expect(verdict.expected).toBe(0);
    expect(verdict.reason).toBe("EXPLORATORY");
    expect(verdict.passed).toBe(false);
    expect(Object.keys(verdict)).toContain("expect");
  });

  /** A row that never had a strip writes the `null` rather than losing the field. */
  it("writes an absent host distance as null, and not as an absent field", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "observe", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [{
        case: "safari-private-chat-light-14", app: SAFARI, mode: "incognito", expectPrivate: true,
        outcome: "windowGone", host: null, hostDistance: null, addressLine: null, hostBottomPx: null, private: null,
        privateBottomPx: null, bandPx: null, toolbarTextLength: null, toolbarTextPresent: false,
        lineCount: null, readAttempts: 3, stats: NO_STATS,
        staged: {widthPt: null, heightPt: null, columns: null, rows: null},
        displayScale: null, scale: null, sizeAsStaged: null, chromeWaitMs: null, stageMs: null,
        stageAttempts: null, frontAppSeen: null, stagedTitleSeen: null, pageRequests: null,
        pageStatus: null, refusedTitleLength: null
      }],
      summary: summarise("observe", [], [], [])
    })) as Record<string, Record<string, unknown>[]>;
    const row = (written.observe as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(row.hostDistance).toBeNull();
    expect(Object.keys(row)).toContain("hostDistance");
    // "the rule was never asked" is a different statement from "the rule said no"
    expect(row.addressLine).toBeNull();
    expect(Object.keys(row)).toContain("addressLine");
    expect(row.readAttempts).toBe(3);
  });

  /**
   * Owner decision O8, on the way to disk: the boolean and the count, by value, and the count's
   * key-set beside the thresholds it is not one of.
   */
  it("carries the address-line finding onto disk, as a boolean and as a count", () => {
    const capture = (addressLine: boolean | null) => ({
      case: "normal-app.clave.localhost-chat-light-14", mode: "normal" as const, expectPrivate: false,
      outcome: "ok" as const, host: true, hostDistance: 0, addressLine, hostBottomPx: 71,
      private: false, privateBottomPx: null, bandPx: 82, toolbarTextLength: 40,
      toolbarTextPresent: addressLine !== null, lineCount: 3, stats: NO_STATS,
      staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null},
      displayScale: 2, scale: 2, sizeAsStaged: true, chromeWaitMs: 0, stageMs: 900, stageAttempts: 1,
      frontAppSeen: true, stagedTitleSeen: true, pageRequests: 1, pageStatus: 200,
      refusedTitleLength: null
    });
    const toolbar = [capture(true), capture(false), capture(null)];
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar, observe: [], summary: summarise("toolbar", [], toolbar)
    })) as Record<string, Record<string, unknown>[] | Record<string, unknown>>;

    const rows = written.toolbar as Record<string, unknown>[];
    expect(rows.map((row) => row.addressLine)).toEqual([true, false, null]);
    for (const row of rows) expect(Object.keys(row)).toContain("addressLine");

    const verdict = (written.summary as Record<string, unknown>).toolbar as Record<string, unknown>;
    expect(verdict.addressLines).toBe(1);
    // reported beside the thresholds, and not one of them: no `addressLinesMin` anywhere
    expect(Object.keys(verdict).sort()).toEqual([
      "addressLines", "captures", "falsePrivate", "falsePrivateMax", "hostHits", "hostHitsMin",
      "incompleteCases", "passed", "privateHits", "privateHitsMin"
    ]);
  });

  it("writes an error as a fixed code and nothing else", () => {
    expect(JSON.parse(serialiseError({error: "NO_GRANT", code: "NO_GRANT"}))).toEqual({error: "NO_GRANT", code: "NO_GRANT"});
  });

  /**
   * A refusal may carry ONE number: how long the helper had taken when it was refused.
   *
   * `coldstart` exists to answer "how long does a cold helper take" and "does the grant reach it",
   * and a helper still not ready after the 120 s deadline is precisely the interesting answer — the
   * run used to write `{"error":"PROTOCOL"}` and throw the measurement away. It is a number, so it
   * carries nothing, and it is written only when it is a usable one.
   */
  it("writes the elapsed helper time beside a refusal, and only when it is a real number", () => {
    expect(JSON.parse(serialiseError({error: "PROTOCOL", code: "PROTOCOL", readyMs: 120_000})))
      .toEqual({error: "PROTOCOL", code: "PROTOCOL", readyMs: 120_000});
    expect(JSON.parse(serialiseError({error: "NO_GRANT", code: "NO_GRANT", readyMs: 0})))
      .toEqual({error: "NO_GRANT", code: "NO_GRANT", readyMs: 0});
    for (const readyMs of [NaN, Infinity, -1]) {
      expect(JSON.parse(serialiseError({error: "PROTOCOL", code: "PROTOCOL", readyMs})))
        .toEqual({error: "PROTOCOL", code: "PROTOCOL"});
    }
    expect(JSON.parse(serialiseError({error: "HARNESS", code: "BAD_MODE"})))
      .toEqual({error: "HARNESS", code: "BAD_MODE"});
    // and nothing but the number rides along
    expect(serialiseError({error: "PROTOCOL", code: "PROTOCOL", readyMs: 7, why: "SMUGGLED-REASON"} as never))
      .not.toContain("SMUGGLED-REASON");
  });
});

describe("the outcomes that make a case incomplete", () => {
  it("is every outcome but `ok`", () => {
    expect([...INCOMPLETE_OUTCOMES].sort()).toEqual(
      ["black", "down", "failed", "locked", "noMarkers", "notStaged", "timeout", "windowGone"]
    );
    expect(INCOMPLETE_OUTCOMES).not.toContain("ok");
  });
});
/**
 * The allow-list of a REPETITION, pinned by name.
 *
 * The staging and marker diagnostics added on 2026-09-20 are eight new fields on the one object of
 * this file that a future upstream change is likeliest to grow another. Every one of them is a
 * number or a boolean, and this is the test that fails if a ninth arrives without a diff somebody
 * read — or if one of these is quietly dropped, which is the mutation that would leave the next
 * screen run unable to tell an empty window from a scrolled one.
 */
/**
 * The version number does what its own doc says. Three fields were added to the rows in repair loop
 * 2 and one in loop 1; a file that says 2 is one that has them (review C, Minor 5).
 */
describe("the schema version", () => {
  it("is 5, and is written into the file", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "coldstart", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: null,
      accuracy: [], toolbar: [], observe: [],
      summary: summarise("coldstart", [], [], [], {readyMs: 1, permission: "granted"})
    })) as Record<string, unknown>;
    expect(written.schema).toBe(5);
  });
});

/** A short run says so in the FILE as well as on the terminal, with its fixed reason and counts. */
describe("a limited run in the results file", () => {
  const write = (limited: {reason: "LIMITED"; cases: number; of: number} | null): Record<string, unknown> =>
    JSON.parse(serialiseResults({
      schema: 5, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [],
      summary: {...summarise("toolbar", [], [], [], undefined, limited)}
    })) as Record<string, unknown>;

  it("carries the reason and the two counts", () => {
    const summary = write({reason: "LIMITED", cases: 4, of: 40}).summary as Record<string, unknown>;
    expect(summary.limited).toEqual({reason: "LIMITED", cases: 4, of: 40});
    expect(summary.accepted).toBe(false);
  });

  it("says null for a full run, and never invents one", () => {
    const summary = write(null).summary as Record<string, unknown>;
    expect(summary.limited).toBeNull();
  });

  /**
   * The reason is WRITTEN here, not copied from the input — the property that makes this file an
   * allow-list rather than a filter (review D, Minor 6).
   */
  it("writes the fixed code itself, whatever it was handed", () => {
    const summary = write({reason: "SMUGGLED-REASON" as never, cases: 4, of: 40}).summary as Record<string, unknown>;
    expect(summary.limited).toEqual({reason: "LIMITED", cases: 4, of: 40});
    expect(JSON.stringify(summary)).not.toContain("SMUGGLED");
  });
});

/**
 * Whether the page server got both loopback families is the one fact that says whether the
 * `*.localhost` repair was in effect at all, so it is in the file (review D, Important 1).
 */
describe("the page server's loopback families in the file", () => {
  it("records that both were bound", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "toolbar", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [], summary: summarise("toolbar", [], [])
    })) as Record<string, unknown>;
    expect(written.pageServerIpv6).toBe(true);
  });

  it("says null for a mode that served no page", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "coldstart", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: null, position: null,
      accuracy: [], toolbar: [], observe: [],
      summary: summarise("coldstart", [], [], [], {readyMs: 1, permission: "granted"})
    })) as Record<string, unknown>;
    expect(written.pageServerIpv6).toBeNull();
    expect(Object.keys(written)).toContain("pageServerIpv6");
  });
});

describe("the shape of a repetition in the file", () => {
  it("holds these fields and no others, all of them numbers, booleans or fixed codes", async () => {
    const accuracy = [await runAccuracyCase(chatCase, depsAnsweringWithSentinels(chatCase.name))];
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy, toolbar: [], observe: [], summary: summarise("accuracy", accuracy, [])
    })) as Record<string, Record<string, unknown>[]>;
    const first = (written.accuracy?.[0]?.repetitions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual([
      "accents", "accuracy", "chromeWaitMs", "displayScale", "endFound", "frontAppSeen",
      "lineCount", "markers", "outcome", "pageRequests", "pageStatus", "readyColumns", "readyRows",
      "refusedTitleLength", "repeat", "scale", "sizeAsStaged", "stageAttempts", "stageMs", "staged",
      "stagedTitleSeen",
      "startFound", "stats", "textLength"
    ]);
    expect(first.staged).toEqual({widthPt: 1160, heightPt: 640, columns: null, rows: null});
    expect(typeof first.textLength).toBe("number");
    expect(typeof first.lineCount).toBe("number");
    expect(first.startFound).toBe(true);
    expect(first.endFound).toBe(true);
    // Every value that is not a fixed code is a number, a boolean or null — never a string, at ANY
    // depth. A shallow `typeof` would miss a string inside `staged` or `stats` (review B, Minor 4).
    const noStrings = (value: unknown, path: string): void => {
      if (typeof value === "string") { throw new Error(`a string at ${path}`); }
      if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          if (path === "" && key === "outcome") continue;
          noStrings(inner, `${path}.${key}`);
        }
      }
    };
    expect(() => noStrings(first, "")).not.toThrow();
    // and the walker really does bite
    expect(() => noStrings({stats: {widthPx: "1160"}}, "")).toThrow("a string at .stats.widthPx");
  });
});
/**
 * Re-review D, Important 2: the same number, through the serialiser, on both row shapes — and the
 * TOP-LEVEL fields pinned by name, which is the half the key-set tests did not cover.
 */
describe("the refused title's length reaches the file", () => {
  const withLength = (value: number) => {
    const repetition = {
      outcome: "notStaged" as const, accuracy: null, markers: null, accents: null, stats: NO_STATS,
      repeat: null, staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null},
      displayScale: 1, scale: null, sizeAsStaged: null, startFound: null, endFound: null,
      lineCount: null, textLength: null, readyColumns: null, readyRows: null,
      frontAppSeen: true, stagedTitleSeen: true, pageRequests: 2, pageStatus: 200,
      refusedTitleLength: value, chromeWaitMs: 0, stageMs: null, stageAttempts: 2
    };
    return JSON.parse(serialiseResults({
      schema: 5, mode: "all", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [{
        case: "chat-light-14", group: "chat", repetitions: [repetition],
        minAccuracy: null, medianAccuracy: null, minAccents: null, incomplete: true, confusions: []
      }],
      toolbar: [{
        case: "normal-app.clave.localhost-chat-light-14", mode: "normal", expectPrivate: false,
        outcome: "notStaged", host: null, hostDistance: null, addressLine: null, hostBottomPx: null, private: null, privateBottomPx: null,
        bandPx: null, toolbarTextLength: null, toolbarTextPresent: false, lineCount: null,
        stats: NO_STATS, staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null},
        displayScale: 1, scale: null, sizeAsStaged: null, chromeWaitMs: 0, stageMs: null,
        stageAttempts: 2, frontAppSeen: true, stagedTitleSeen: true, pageRequests: 2,
        pageStatus: 200, refusedTitleLength: value
      }],
      observe: [], summary: summarise("all", [], [], [])
    })) as Record<string, Record<string, unknown>[]>;
  };

  it("carries the number on an accuracy repetition", () => {
    const written = withLength(27);
    const first = (written.accuracy?.[0]?.repetitions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(first.refusedTitleLength).toBe(27);
  });

  it("carries it on a toolbar row", () => {
    expect(withLength(27).toolbar?.[0]?.refusedTitleLength).toBe(27);
  });

  it("carries a null as a null, and not as an absent field", () => {
    const written = withLength(0);
    expect(written.toolbar?.[0]?.refusedTitleLength).toBe(0);
    expect(Object.keys(written.toolbar?.[0] ?? {})).toContain("refusedTitleLength");
  });
});

/**
 * The TOP-LEVEL shape of the file, pinned by name — the half the row key-set tests never covered,
 * which is how `pageServerIpv6` could be dropped from the serialiser with nothing failing.
 */
describe("the shape of the file itself", () => {
  it("holds these fields and no others", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 5, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [], summary: summarise("accuracy", [], [])
    })) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([
      "accuracy", "chromeVariant", "helper", "mode", "nonce", "observe", "pageServerIpv6",
      "permission", "position", "repetitions", "schema", "summary", "toolbar"
    ]);
  });

  it("holds these summary fields and no others", () => {
    const written = JSON.parse(serialiseResults({
      schema: 5, mode: "accuracy", nonce: NONCE, repetitions: 5, chromeVariant: "none",
      helper: HELPER, permission: "granted", pageServerIpv6: true, position: {x: 40, y: 60},
      accuracy: [], toolbar: [], observe: [], summary: summarise("accuracy", [], [])
    })) as Record<string, Record<string, unknown>>;
    expect(Object.keys(written.summary ?? {}).sort()).toEqual([
      "accepted", "coldstart", "groups", "limited", "missingGroups", "observe", "toolbar"
    ]);
  });
});
