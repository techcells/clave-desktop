import {describe, expect, it} from "vitest";
import {EVAL_MODES} from "./config";
import {NO_STATS, type AccuracyCaseResult, type AccuracyRepetition, type ObserveCaseResult, type ToolbarCaseResult} from "./results";
import {ALL_GROUPS, finishAccuracyCase, isIncomplete, medianOf, minimumOf, summarise, summariseGroups, summariseObserve, summariseToolbar} from "./summary";
import type {AccuracyGroup} from "./thresholds";

const ok = (accuracy: number, accents = 1): AccuracyRepetition =>
  ({outcome: "ok", accuracy, markers: true, accents, stats: NO_STATS, repeat: null});
const bad = (outcome: AccuracyRepetition["outcome"]): AccuracyRepetition =>
  ({outcome, accuracy: null, markers: null, accents: null, stats: NO_STATS, repeat: null});

const caseOf = (name: string, group: AccuracyGroup, repetitions: AccuracyRepetition[]): AccuracyCaseResult =>
  finishAccuracyCase({case: name, group, repetitions, confusions: []});

describe("minimum and median", () => {
  it("the median of five is the third", () => {
    expect(medianOf([0.9, 1, 0.95, 0.99, 0.97])).toBe(0.97);
  });

  it("the median of an even count is the lower of the two middle values, which a read really scored", () => {
    expect(medianOf([0.9, 0.98])).toBe(0.9);
    expect(medianOf([0.9, 0.94, 0.96, 0.98])).toBe(0.94);
  });

  it("nothing measured is null, never zero", () => {
    expect(minimumOf([])).toBeNull();
    expect(medianOf([])).toBeNull();
  });
});

describe("a case", () => {
  it("takes its minimum from the worst read and its median from the middle one", () => {
    const result = caseOf("chat-light-14", "chat", [ok(1), ok(0.96), ok(0.99), ok(1), ok(0.98)]);
    expect(result.minAccuracy).toBe(0.96);
    expect(result.medianAccuracy).toBe(0.99);
    expect(result.incomplete).toBe(false);
  });

  /** A repetition that never happened is never averaged away: this is the rule the whole file exists for. */
  it.each(["notStaged", "windowGone", "black", "timeout", "failed", "locked", "down", "noMarkers"] as const)(
    "is incomplete when one repetition ended %s, however good the others were",
    (outcome) => {
      const result = caseOf("chat-light-14", "chat", [ok(1), ok(1), ok(1), ok(1), bad(outcome)]);
      expect(result.incomplete).toBe(true);
      expect(result.minAccuracy).toBe(1);
      expect(summariseGroups([result])[0]?.passed).toBe(false);
      expect(summariseGroups([result])[0]?.incompleteCases).toEqual(["chat-light-14"]);
    }
  );

  it("is incomplete when it was never read at all", () => {
    expect(isIncomplete([])).toBe(true);
    expect(caseOf("chat-light-14", "chat", []).incomplete).toBe(true);
  });
});

describe("a group's verdict", () => {
  /**
   * The rule the phase-0 terminal case demands: 0.9882 and 0.8686 have a median of 0.9882, which is
   * a pass, and a minimum of 0.8686, which is not. The reader runs all day on somebody's screen; one
   * bad read in five is a bad read on somebody's morning.
   */
  it("is the MINIMUM over its cases, not the median", () => {
    const cases = [
      caseOf("terminal", "terminal", [ok(0.9882), ok(0.9882), ok(0.9882), ok(0.9882), ok(0.8686)]),
      caseOf("terminal-narrow", "terminal", [ok(0.99), ok(0.99), ok(0.99), ok(0.99), ok(0.99)])
    ];
    const [verdict] = summariseGroups(cases);
    expect(verdict?.min).toBe(0.8686);
    expect(verdict?.median).toBeGreaterThan(0.95);
    expect(verdict?.passed).toBe(false);
  });

  it("passes when every case's worst read clears the threshold", () => {
    const [verdict] = summariseGroups([caseOf("chat-light-14", "chat", [ok(0.98), ok(0.99)])]);
    expect(verdict?.min).toBe(0.98);
    expect(verdict?.threshold).toBe(0.97);
    expect(verdict?.passed).toBe(true);
  });

  it("fails on the threshold itself minus a hair", () => {
    expect(summariseGroups([caseOf("chat-light-14", "chat", [ok(0.9699)])])[0]?.passed).toBe(false);
    expect(summariseGroups([caseOf("chat-light-14", "chat", [ok(0.97)])])[0]?.passed).toBe(true);
  });

  it("fails a group that measured nothing", () => {
    const [verdict] = summariseGroups([caseOf("chat-light-14", "chat", [bad("notStaged")])]);
    expect(verdict?.min).toBeNull();
    expect(verdict?.passed).toBe(false);
  });

  it("holds Portuguese to keeping every accent, on top of its accuracy", () => {
    const kept = summariseGroups([caseOf("pt-light-14", "pt", [ok(0.99, 1)])])[0];
    expect(kept?.accentsMin).toBe(1);
    expect(kept?.accentsThreshold).toBe(1);
    expect(kept?.passed).toBe(true);

    const lost = summariseGroups([caseOf("pt-light-14", "pt", [ok(0.99, 0.98)])])[0];
    expect(lost?.accentsMin).toBe(0.98);
    expect(lost?.passed).toBe(false);
  });

  it("says nothing about accents for any other group", () => {
    const [verdict] = summariseGroups([caseOf("chat-light-14", "chat", [ok(0.99, 0.2)])]);
    expect(verdict?.accentsMin).toBeNull();
    expect(verdict?.accentsThreshold).toBeNull();
    expect(verdict?.passed).toBe(true);
  });
});

const capture = (name: string, mode: "normal" | "incognito", facts: Partial<ToolbarCaseResult> = {}): ToolbarCaseResult => ({
  case: name, mode, expectPrivate: mode === "incognito", outcome: "ok",
  host: true, hostBottomPx: 71, private: mode === "incognito", privateBottomPx: mode === "incognito" ? 70 : null,
  bandPx: 82, toolbarTextLength: 40, toolbarTextPresent: true, lineCount: 3, stats: NO_STATS, ...facts
});

const fullToolbarRun = (adjust: (entry: ToolbarCaseResult, index: number) => ToolbarCaseResult = (entry) => entry): ToolbarCaseResult[] =>
  [...Array(20).keys()].map((index) => adjust(capture(`normal-${index}`, "normal"), index))
    .concat([...Array(20).keys()].map((index) => adjust(capture(`incognito-${index}`, "incognito"), index)));

describe("the toolbar verdict", () => {
  it("passes phase 0's own counts", () => {
    const verdict = summariseToolbar(fullToolbarRun(), true);
    expect(verdict).toMatchObject({captures: 40, hostHits: 20, privateHits: 20, falsePrivate: 0, passed: true});
  });

  it("allows one missed host out of twenty, and no more", () => {
    expect(summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "normal" && index === 0 ? {...entry, host: false} : entry), true)?.passed).toBe(true);
    expect(summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "normal" && index < 2 ? {...entry, host: false} : entry), true)?.passed).toBe(false);
  });

  it("allows no missed private badge at all", () => {
    expect(summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "incognito" && index === 0 ? {...entry, private: false} : entry), true)?.passed).toBe(false);
  });

  it("allows no false private on a normal window", () => {
    const verdict = summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "normal" && index === 0 ? {...entry, private: true} : entry), true);
    expect(verdict?.falsePrivate).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  it("refuses to accept a partial run, however good it looks", () => {
    const verdict = summariseToolbar([capture("normal-0", "normal"), capture("incognito-0", "incognito")], true);
    expect(verdict?.hostHits).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  it("refuses a run in which a capture failed", () => {
    const verdict = summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "normal" && index === 3 ? {...entry, outcome: "notStaged"} : entry), true);
    expect(verdict?.incompleteCases).toEqual(["normal-3"]);
    expect(verdict?.passed).toBe(false);
  });

  it("is null when the run had no toolbar mode at all", () => {
    expect(summariseToolbar([], false)).toBeNull();
    expect(summariseToolbar(fullToolbarRun(), false)).toBeNull();
  });

  /** A toolbar run with no capture at all measured nothing, which is a shortfall, not "no verdict". */
  it("fails a toolbar run in which nothing was captured", () => {
    expect(summariseToolbar([], true)).toMatchObject({captures: 0, hostHits: 0, privateHits: 0, passed: false});
  });
});

const observed = (name: string, expectPrivate: boolean, facts: Partial<ObserveCaseResult> = {}): ObserveCaseResult => ({
  case: name, app: "Safari", mode: expectPrivate ? "incognito" : "normal", expectPrivate, outcome: "ok",
  host: true, hostBottomPx: 37, private: expectPrivate, privateBottomPx: expectPrivate ? 36 : null,
  bandPx: 41, toolbarTextLength: 20, toolbarTextPresent: true, lineCount: 9, stats: NO_STATS, ...facts
});

/** A clean owner-staged pass: five normal windows and five private ones, each read as staged. */
const fullObserveRun = (adjust: (entry: ObserveCaseResult, index: number) => ObserveCaseResult = (entry) => entry): ObserveCaseResult[] =>
  [...Array(5).keys()].map((index) => adjust(observed(`safari-normal-${index}`, false), index))
    .concat([...Array(5).keys()].map((index) => adjust(observed(`safari-private-${index}`, true), index)));

describe("the observe verdict", () => {
  it("passes a run in which every window read as it was staged", () => {
    const verdict = summariseObserve(fullObserveRun(), true);
    expect(verdict).toMatchObject({staged: 10, read: 10, privateMissed: 0, falsePrivate: 0, passed: true});
  });

  /**
   * The failure this exists for. A window the owner staged PRIVATE whose read shows no private
   * marker is, in the product, a private window KEPT — carried item 29, "the single most
   * consequential unmeasured behaviour in the sub-project".
   */
  it("fails when one staged private window showed no private marker", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-2" ? {...entry, private: false, privateBottomPx: null} : entry), true);
    expect(verdict?.privateMissed).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  /**
   * `null` means the helper sent no toolbar strip at all. A badge that was never delivered never
   * skipped anything, so it counts as missed — not as inconclusive.
   */
  it("fails when a staged private window produced no toolbar strip at all", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-0" ? {...entry, private: null, toolbarTextPresent: false, toolbarTextLength: null} : entry), true);
    expect(verdict?.privateMissed).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  it("fails when one staged NORMAL window was flagged private", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-normal-1" ? {...entry, private: true, privateBottomPx: 30} : entry), true);
    expect(verdict?.falsePrivate).toBe(1);
    expect(verdict?.privateMissed).toBe(0);
    expect(verdict?.passed).toBe(false);
  });

  it("does not count a normal window with no strip as a false positive", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-normal-1" ? {...entry, private: null} : entry), true);
    expect(verdict?.falsePrivate).toBe(0);
    expect(verdict?.passed).toBe(true);
  });

  it("fails a row whose read did not come back, and names it", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-3" ? {...entry, outcome: "black"} : entry), true);
    expect(verdict?.incompleteCases).toEqual(["safari-private-3"]);
    expect(verdict?.read).toBe(9);
    expect(verdict?.passed).toBe(false);
  });

  it("does not judge a failed read's facts, only its failure", () => {
    const verdict = summariseObserve([observed("safari-private-0", true, {outcome: "notStaged", private: null})], true);
    expect(verdict?.privateMissed).toBe(0);
    expect(verdict?.read).toBe(0);
    expect(verdict?.passed).toBe(false);
  });

  /** An owner who staged nothing has measured nothing, and nobody is there to notice an empty table. */
  it("fails a run in which nothing at all was staged and read", () => {
    const verdict = summariseObserve([], true);
    expect(verdict).toMatchObject({staged: 0, read: 0, privateMissed: 0, falsePrivate: 0, passed: false});
  });

  it("is null when the run had no observe mode at all", () => {
    expect(summariseObserve([], false)).toBeNull();
    expect(summariseObserve(fullObserveRun(), false)).toBeNull();
  });

  it("passes a partial run in which everything read as staged", () => {
    expect(summariseObserve([observed("safari-private-0", true)], true)?.passed).toBe(true);
  });
});

/** Five groups, one clean case each: what a whole accuracy run looks like. */
const fullAccuracyRun = (worst: Partial<Record<AccuracyGroup, number>> = {}): AccuracyCaseResult[] =>
  ALL_GROUPS.map((group) => caseOf(`${group}-light-14`, group, [ok(worst[group] ?? 0.99)]));

describe("accepted", () => {
  it("expects a verdict for every group the thresholds name", () => {
    expect([...ALL_GROUPS]).toEqual(["chat", "ticket", "terminal", "pt", "code"]);
  });

  it("needs every verdict the run's mode asked for", () => {
    expect(summarise("accuracy", fullAccuracyRun(), []).accepted).toBe(true);
    expect(summarise("toolbar", [], fullToolbarRun()).accepted).toBe(true);
    expect(summarise("all", fullAccuracyRun(), fullToolbarRun(), fullObserveRun()).accepted).toBe(true);
  });

  it("refuses a run in which one group fell short", () => {
    expect(summarise("accuracy", fullAccuracyRun({chat: 0.5}), []).accepted).toBe(false);
  });

  it("refuses a run in which the toolbar counts fell short", () => {
    expect(summarise("toolbar", [], fullToolbarRun((entry) => ({...entry, host: false}))).accepted).toBe(false);
  });

  /**
   * The finding this exists for. `summarise` used to return `accepted: true` for a run with no
   * group, no toolbar verdict and no observe verdict, and the terminal side turned that into exit
   * code 0 — a run that staged nothing, read nothing and measured nothing reporting ACCEPTED. It was
   * reachable from any unrecognised `CLAVE_EVAL_MODE`, and it is the failure the observe addendum had
   * already removed one level down.
   */
  it.each(EVAL_MODES)("refuses a %s run that measured nothing", (mode) => {
    expect(summarise(mode, [], [], []).accepted).toBe(false);
  });

  it("names the accuracy groups the run should have covered and did not", () => {
    const summary = summarise("accuracy", [caseOf("chat-light-14", "chat", [ok(0.99)])], []);
    expect(summary.groups[0]?.passed).toBe(true);
    expect(summary.missingGroups).toEqual(["ticket", "terminal", "pt", "code"]);
    expect(summary.accepted).toBe(false);
  });

  it("asks for no accuracy group in a mode that does not run them", () => {
    expect(summarise("toolbar", [], fullToolbarRun()).missingGroups).toEqual([]);
    expect(summarise("observe", [], [], fullObserveRun()).missingGroups).toEqual([]);
  });

  it("gives a toolbar run with no capture a failing verdict rather than none at all", () => {
    const summary = summarise("toolbar", [], []);
    expect(summary.toolbar).toMatchObject({captures: 0, passed: false});
    expect(summary.accepted).toBe(false);
  });

  it("refuses an observe run with a private window that would have been kept", () => {
    const rows = fullObserveRun((entry) => entry.case === "safari-private-2" ? {...entry, private: false} : entry);
    expect(summarise("observe", [], [], rows).accepted).toBe(false);
    expect(summarise("observe", [], [], rows).observe?.privateMissed).toBe(1);
  });

  it("refuses an observe run with a normal window flagged private", () => {
    const rows = fullObserveRun((entry) => entry.case === "safari-normal-0" ? {...entry, private: true} : entry);
    expect(summarise("observe", [], [], rows).accepted).toBe(false);
  });

  it("refuses an observe run that measured nothing", () => {
    expect(summarise("observe", [], [], []).accepted).toBe(false);
    expect(summarise("observe", [], [], []).observe?.passed).toBe(false);
  });

  it("accepts an observe run in which every staged window read as staged", () => {
    expect(summarise("observe", [], [], fullObserveRun()).accepted).toBe(true);
  });

  it("says nothing about the modes that did not run", () => {
    const accuracyOnly = summarise("accuracy", fullAccuracyRun(), []);
    expect(accuracyOnly.observe).toBeNull();
    expect(accuracyOnly.toolbar).toBeNull();
    expect(accuracyOnly.accepted).toBe(true);
    const toolbarOnly = summarise("toolbar", [], fullToolbarRun());
    expect(toolbarOnly.groups).toEqual([]);
    expect(toolbarOnly.observe).toBeNull();
  });
});
