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
import {BROWSER_WINDOW, SAFARI} from "./cases";
import {createEvalHelper} from "./helper";
import {NO_STATS, serialiseError, serialiseResults, INCOMPLETE_OUTCOMES, type EvalResults} from "./results";
import {runAccuracyCase, runObserve, runToolbarCase, type RunDeps, type Stager} from "./run";
import {stagedTitleFor} from "./stagedTitle";
import {summarise} from "./summary";
import {createFakeLink, createManualSchedule, respondTo} from "./testing/fakes";

const NONCE = "abc123";

/** Every string the helper could ever hand this harness, made findable. */
const SENTINELS = {
  text: "SENTINEL-PAGE-BODY-cardnumber-4111111111111111",
  toolbar: "SENTINEL-TOOLBAR-mybank.example.com",
  line: "SENTINEL-LINE-BOX-text",
  title: "SENTINEL-WINDOW-TITLE-Inbox",
  app: "SENTINEL-APP-NAME"
};

const chatCase: AccuracyCase = {
  kind: "browser", name: "chat-light-14", group: "chat", app: "Google Chrome",
  page: "chat", theme: "light", sizePx: 14, truth: "chat", window: BROWSER_WINDOW
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

function depsAnsweringWithSentinels(name: string, app = "Google Chrome"): RunDeps {
  const link = createFakeLink();
  respondTo(link, (request) => {
    if (request.op === "frontWindow") {
      return {window: {app, bundleId: "com.google.Chrome", title: `${stagedTitleFor(name, NONCE)} ${SENTINELS.title}`}};
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
  const stager: Stager = {run: async () => undefined, writeScript: async (n) => `/out/${n}`, writePreferences: async () => undefined};
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
    const accuracy = [await runAccuracyCase(chatCase, depsAnsweringWithSentinels(chatCase.name))];
    const toolbar = [await runToolbarCase(toolbarCase, depsAnsweringWithSentinels(toolbarCase.name))];
    const observe = await runObserve(
      {...depsAnsweringWithSentinels(observeCase.name, SAFARI), seconds: 1},
      [observeCase]
    );
    const results: EvalResults = {
      schema: 1, mode: "all", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      accuracy, toolbar, observe, summary: summarise("all", accuracy, toolbar, observe)
    };
    const written = serialiseResults(results);

    // The run really did happen, or this test proves nothing.
    expect(accuracy[0]?.repetitions[0]?.outcome).toBe("ok");
    expect(toolbar[0]?.private).toBe(true);
    expect(toolbar[0]?.toolbarTextLength).toBeGreaterThan(0);
    expect(observe[0]?.outcome).toBe("ok");
    expect(observe[0]?.app).toBe(SAFARI);

    for (const [field, sentinel] of Object.entries(SENTINELS)) {
      expect(written, `${field} reached the results file`).not.toContain(sentinel);
      expect(written, `${field} reached the results file`).not.toContain(sentinel.toLowerCase());
    }
    // Nor any fragment of them: the sentinels are built from words that would survive a substring.
    expect(written).not.toContain("SENTINEL");
    expect(written).not.toContain("4111111111111111");
    expect(written).not.toContain("Inbox");
  });

  it("does carry the numbers and the codes it exists for", async () => {
    const accuracy = [await runAccuracyCase(chatCase, depsAnsweringWithSentinels(chatCase.name))];
    const written = JSON.parse(serialiseResults({
      schema: 1, mode: "accuracy", nonce: NONCE, repetitions: 2, chromeVariant: "none",
      accuracy, toolbar: [], observe: [], summary: summarise("accuracy", accuracy, [])
    })) as Record<string, unknown>;
    const first = (written.accuracy as Record<string, unknown>[])[0] as Record<string, unknown>;
    const repetition = (first.repetitions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(first.case).toBe("chat-light-14");
    expect(repetition.outcome).toBe("ok");
    expect(repetition.stats).toEqual({captureMs: 31, recogniseMs: 198, cacheHit: false, widthPx: 1268, heightPx: 708});
    expect(typeof repetition.accuracy).toBe("number");
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
      schema: 1, mode: "accuracy", nonce: NONCE, repetitions: 1, chromeVariant: "none",
      accuracy: [smuggled as never], toolbar: [], observe: [],
      summary: {groups: [], missingGroups: [], toolbar: null, observe: null, accepted: true}
    });
    expect(written).not.toContain("SMUGGLED-BODY");
    expect(written).not.toContain("SMUGGLED-STRIP");
  });

  it("writes an error as a fixed code and nothing else", () => {
    expect(JSON.parse(serialiseError({error: "NO_GRANT", code: "NO_GRANT"}))).toEqual({error: "NO_GRANT", code: "NO_GRANT"});
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
