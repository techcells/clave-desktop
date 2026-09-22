import {describe, expect, it} from "vitest";
import {EVAL_MODES} from "./config";
import {NO_STAGED_SIZE, NO_STATS, type AccuracyCaseResult, type AccuracyRepetition, type ObserveCaseResult, type ToolbarCaseResult} from "./results";
import type {ObserveExpectation} from "./observe";
import {ALL_GROUPS, finishAccuracyCase, isIncomplete, medianOf, minimumOf, summarise, summariseColdstart, summariseGroups, summariseObserve, summariseToolbar} from "./summary";
import type {AccuracyGroup} from "./thresholds";

type StagingFacts = Pick<
  AccuracyRepetition,
  "staged" | "displayScale" | "scale" | "sizeAsStaged" | "startFound" | "endFound" | "lineCount"
  | "textLength" | "readyColumns" | "readyRows" | "chromeWaitMs" | "stageMs" | "stageAttempts"
  | "frontAppSeen" | "stagedTitleSeen" | "pageRequests" | "pageStatus" | "refusedTitleLength"
>;

/** A repetition whose window WAS the size it was staged at: the ordinary, passing case. */
const AS_STAGED: StagingFacts = {
  staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null},
  displayScale: 2, scale: 2, sizeAsStaged: true,
  startFound: true, endFound: true, lineCount: 14, textLength: 400,
  readyColumns: null, readyRows: null,
  frontAppSeen: true, stagedTitleSeen: true, pageRequests: 1, pageStatus: 200, refusedTitleLength: null,
  chromeWaitMs: 0, stageMs: 900, stageAttempts: 1
};

/** Nothing staged and nothing measured: what a repetition that never read carries. */
const NOT_MEASURED: StagingFacts = {
  staged: NO_STAGED_SIZE, displayScale: null, scale: null, sizeAsStaged: null,
  startFound: null, endFound: null, lineCount: null, textLength: null,
  readyColumns: null, readyRows: null,
  frontAppSeen: false, stagedTitleSeen: false, pageRequests: 0, pageStatus: null, refusedTitleLength: null,
  chromeWaitMs: null, stageMs: null, stageAttempts: 1
};

const ok = (accuracy: number, accents = 1): AccuracyRepetition =>
  ({outcome: "ok", accuracy, markers: true, accents, stats: NO_STATS, repeat: null, ...AS_STAGED});
const bad = (outcome: AccuracyRepetition["outcome"]): AccuracyRepetition =>
  ({outcome, accuracy: null, markers: null, accents: null, stats: NO_STATS, repeat: null, ...NOT_MEASURED});

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
  host: true, hostDistance: 0, addressLine: true, hostBottomPx: 71, private: mode === "incognito", privateBottomPx: mode === "incognito" ? 70 : null,
  bandPx: 82, toolbarTextLength: 40, toolbarTextPresent: true, lineCount: 3, stats: NO_STATS,
  staged: {widthPt: 1160, heightPt: 640, columns: null, rows: null},
  displayScale: 2, scale: 2, sizeAsStaged: true, chromeWaitMs: 0, stageMs: 900, stageAttempts: 1,
  frontAppSeen: true, stagedTitleSeen: true, pageRequests: 1, pageStatus: 200, refusedTitleLength: null, ...facts
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

  /**
   * Owner decision O8, reported and never judged. The thresholds are the spike's own pass marks and
   * are never added to by an agent; this count exists so the owner can see whether the rule his
   * product now depends on is satisfied by real Chrome strips at all.
   */
  it("counts the captures whose strip showed an address line", () => {
    expect(summariseToolbar(fullToolbarRun(), true)?.addressLines).toBe(40);
    const half = summariseToolbar(fullToolbarRun((entry, index) =>
      index % 2 === 0 ? {...entry, addressLine: false} : entry), true);
    expect(half?.addressLines).toBe(20);
  });

  it("counts only a strip the rule accepted, never one it was not asked about", () => {
    const verdict = summariseToolbar(fullToolbarRun((entry, index) =>
      index === 0 ? {...entry, addressLine: null} : entry), true);
    expect(verdict?.addressLines).toBe(38);
  });

  /**
   * The line this whole field lives or dies on: it is INFORMATION. A run in which not one strip
   * showed an address line still passes on the thresholds, and a run that fails a threshold is not
   * rescued by every strip showing one.
   */
  it("never changes the verdict, in either direction", () => {
    const none = summariseToolbar(fullToolbarRun((entry) => ({...entry, addressLine: false})), true);
    expect(none?.addressLines).toBe(0);
    expect(none?.passed).toBe(true);

    // two, because the host threshold is 19 of 20: one miss still clears it
    const all = summariseToolbar(fullToolbarRun((entry, index) =>
      entry.mode === "normal" && index <= 1 ? {...entry, host: false} : entry), true);
    expect(all?.addressLines).toBe(40);
    expect(all?.passed).toBe(false);

    // and the same, through the whole summary
    expect(summarise("toolbar", [], fullToolbarRun((entry) => ({...entry, addressLine: null}))).accepted).toBe(true);
  });

  /** It is a count, not a threshold: nothing beside it says how many there should be. */
  it("has no threshold of its own", () => {
    const verdict = summariseToolbar(fullToolbarRun(), true) as unknown as Record<string, unknown>;
    expect(Object.keys(verdict)).toContain("addressLines");
    expect(Object.keys(verdict).filter((key) => key.toLowerCase().includes("addressline")))
      .toEqual(["addressLines"]);
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
  host: true, hostDistance: 0, addressLine: true, readAttempts: 1, hostBottomPx: 37, private: expectPrivate, privateBottomPx: expectPrivate ? 36 : null,
  bandPx: 41, toolbarTextLength: 20, toolbarTextPresent: true, lineCount: 9, stats: NO_STATS,
  // An owner-staged window: this harness sized nothing, so there is nothing to be as staged.
  staged: NO_STAGED_SIZE, displayScale: null, scale: null, sizeAsStaged: null,
  chromeWaitMs: null, stageMs: null, stageAttempts: null,
  frontAppSeen: null, stagedTitleSeen: null, pageRequests: null, pageStatus: null, refusedTitleLength: null, ...facts
});

/** A clean owner-staged pass: five normal windows and five private ones, each read as staged. */
const fullObserveRun = (adjust: (entry: ObserveCaseResult, index: number) => ObserveCaseResult = (entry) => entry): ObserveCaseResult[] =>
  [...Array(5).keys()].map((index) => adjust(observed(`safari-normal-${index}`, false), index))
    .concat([...Array(5).keys()].map((index) => adjust(observed(`safari-private-${index}`, true), index)));

/**
 * The names a full run's ten cases have, as an expectation — what `--expect safari` resolves to for
 * this fake table. Since finding O1 a verdict can only pass against one of these: a run that was
 * asked for nothing is `EXPLORATORY`, whatever its rows say.
 */
const EXPECT_ALL_TEN: ObserveExpectation = {
  sets: ["safari"],
  cases: fullObserveRun().map((entry) => entry.case)
};

/** The private half of it, which is what an owner with five minutes asks for. */
const EXPECT_PRIVATE_FIVE: ObserveExpectation = {
  sets: ["safari-private"],
  cases: fullObserveRun().filter((entry) => entry.expectPrivate).map((entry) => entry.case)
};

describe("the observe verdict", () => {
  it("passes a run in which every expected window read as it was staged", () => {
    const verdict = summariseObserve(fullObserveRun(), true, EXPECT_ALL_TEN);
    expect(verdict).toMatchObject({
      staged: 10, read: 10, expected: 10, privateMissed: 0, falsePrivate: 0,
      missingCases: [], expect: ["safari"], reason: null, passed: true
    });
  });

  /**
   * Finding O1, as one assertion. Run #1 of 2026-09-21 read ONE normal Safari page of the twenty it
   * printed and reported `READER_EVAL ACCEPTED`, because every rule in this file was a rule about
   * the rows that arrived and one correct row is a table with nothing wrong in it. A run that named
   * nothing cannot pass, however clean it is.
   */
  it("never passes a run that was asked for nothing, however perfectly it read", () => {
    const verdict = summariseObserve(fullObserveRun(), true);
    expect(verdict).toMatchObject({read: 10, privateMissed: 0, falsePrivate: 0, reason: "EXPLORATORY", passed: false});
    expect(verdict?.expect).toBeNull();
    expect(verdict?.expected).toBe(0);
    // and the one-read run that started all this is refused on the same line
    expect(summariseObserve([observed("safari-normal-0", false)], true)?.passed).toBe(false);
  });

  /**
   * The other half of O1: an expectation is a promise about EVERY case in it. Four of five read is
   * `INCOMPLETE`, and the missing one is named, because the owner's next action is to open exactly
   * that window.
   */
  it("fails when one expected case was never read at all, and names it", () => {
    const rows = fullObserveRun().filter((entry) => entry.case !== "safari-private-3");
    const verdict = summariseObserve(rows, true, EXPECT_PRIVATE_FIVE);
    expect(verdict?.read).toBe(9);
    expect(verdict?.missingCases).toEqual(["safari-private-3"]);
    expect(verdict?.reason).toBe("INCOMPLETE");
    expect(verdict?.passed).toBe(false);
  });

  /** A case that was seen and whose read FAILED is missing in exactly the same way: nothing was read. */
  it("fails when an expected case was read and the read failed", () => {
    const rows = fullObserveRun((entry) =>
      entry.case === "safari-private-1" ? {...entry, outcome: "windowGone", private: null, readAttempts: 3} : entry);
    const verdict = summariseObserve(rows, true, EXPECT_PRIVATE_FIVE);
    expect(verdict?.missingCases).toEqual(["safari-private-1"]);
    expect(verdict?.incompleteCases).toEqual(["safari-private-1"]);
    expect(verdict?.reason).toBe("INCOMPLETE");
    expect(verdict?.passed).toBe(false);
    // Finding O4: nothing was read, so nothing was kept. This is not a privacy result.
    expect(verdict?.privateMissed).toBe(0);
  });

  /**
   * A row OUTSIDE the expected set whose read failed says nothing about the five that were asked
   * for. It is listed and printed; it does not fail the run.
   */
  it("does not fail an expected set because an unexpected window failed to read", () => {
    const rows = fullObserveRun((entry) =>
      entry.case === "safari-normal-2" ? {...entry, outcome: "black", private: null} : entry);
    const verdict = summariseObserve(rows, true, EXPECT_PRIVATE_FIVE);
    expect(verdict?.incompleteCases).toEqual(["safari-normal-2"]);
    expect(verdict?.missingCases).toEqual([]);
    expect(verdict?.passed).toBe(true);
  });

  /** An expectation that names no case has nothing missing from it, and must still not pass. */
  it("fails an expectation that resolved to no case at all", () => {
    const verdict = summariseObserve(fullObserveRun(), true, {sets: [], cases: []});
    expect(verdict?.reason).toBe("INCOMPLETE");
    expect(verdict?.passed).toBe(false);
  });

  /**
   * The failure this exists for. A window the owner staged PRIVATE whose read shows no private
   * marker is, in the product, a private window KEPT — carried item 29, "the single most
   * consequential unmeasured behaviour in the sub-project".
   */
  it("fails when one staged private window showed no private marker", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-2" ? {...entry, private: false, privateBottomPx: null} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.privateMissed).toBe(1);
    expect(verdict?.reason).toBe("NOT_AS_EXPECTED");
    expect(verdict?.passed).toBe(false);
  });

  /**
   * `null` means the helper sent no toolbar strip at all. A badge that was never delivered never
   * skipped anything, so it counts as missed — not as inconclusive.
   */
  it("fails when a staged private window produced no toolbar strip at all", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-0" ? {...entry, private: null, toolbarTextPresent: false, toolbarTextLength: null} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.privateMissed).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  it("fails when one staged NORMAL window was flagged private", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-normal-1" ? {...entry, private: true, privateBottomPx: 30} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.falsePrivate).toBe(1);
    expect(verdict?.privateMissed).toBe(0);
    expect(verdict?.passed).toBe(false);
  });

  /**
   * Review, Minor 5. It is not a false positive — nothing was flagged — but it is not a pass
   * either: with no strip the product's rule was never applied to anything and there is no host to
   * match an excluded site against. The run is INCOMPLETE and the case is named.
   */
  it("does not count a normal window with no strip as a false positive, and does not pass it", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-normal-1" ? {...entry, private: null, toolbarTextPresent: false, toolbarTextLength: null} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.falsePrivate).toBe(0);
    expect(verdict?.privateMissed).toBe(0);
    expect(verdict?.notCheckedCases).toEqual(["safari-normal-1"]);
    expect(verdict?.reason).toBe("INCOMPLETE");
    expect(verdict?.passed).toBe(false);
  });

  /** A PRIVATE window with no strip is the stronger statement, and stays where it was. */
  it("calls a private window with no strip a missed badge, not an unchecked one", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-1" ? {...entry, private: null} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.notCheckedCases).toEqual([]);
    expect(verdict?.privateMissed).toBe(1);
    expect(verdict?.passed).toBe(false);
  });

  /** An unchecked window OUTSIDE the expected set does not fail the set that was asked for. */
  it("does not fail an expected set because an unexpected normal window had no strip", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-normal-1" ? {...entry, private: null} : entry), true, EXPECT_PRIVATE_FIVE);
    expect(verdict?.notCheckedCases).toEqual(["safari-normal-1"]);
    expect(verdict?.passed).toBe(true);
  });

  it("fails a row whose read did not come back, and names it", () => {
    const verdict = summariseObserve(fullObserveRun((entry) =>
      entry.case === "safari-private-3" ? {...entry, outcome: "black"} : entry), true, EXPECT_ALL_TEN);
    expect(verdict?.incompleteCases).toEqual(["safari-private-3"]);
    expect(verdict?.read).toBe(9);
    expect(verdict?.passed).toBe(false);
  });

  it("does not judge a failed read's facts, only its failure", () => {
    const verdict = summariseObserve([observed("safari-private-0", true, {outcome: "notStaged", private: null})], true, EXPECT_ALL_TEN);
    expect(verdict?.privateMissed).toBe(0);
    expect(verdict?.read).toBe(0);
    expect(verdict?.passed).toBe(false);
  });

  /** An owner who staged nothing has measured nothing, and nobody is there to notice an empty table. */
  it("fails a run in which nothing at all was staged and read", () => {
    const verdict = summariseObserve([], true, EXPECT_ALL_TEN);
    expect(verdict).toMatchObject({staged: 0, read: 0, privateMissed: 0, falsePrivate: 0, passed: false});
    expect(verdict?.missingCases).toHaveLength(10);
    // and with no expectation it is the same refusal under the other code
    expect(summariseObserve([], true)).toMatchObject({reason: "EXPLORATORY", passed: false});
  });

  it("is null when the run had no observe mode at all", () => {
    expect(summariseObserve([], false)).toBeNull();
    expect(summariseObserve(fullObserveRun(), false, EXPECT_ALL_TEN)).toBeNull();
  });

  /** A run asked for one case, which was read: it proved exactly what it said it would. */
  it("passes a run whose expectation was one case, and that case read as staged", () => {
    const one = {sets: ["safari-private"], cases: ["safari-private-0"]};
    expect(summariseObserve([observed("safari-private-0", true)], true, one)?.passed).toBe(true);
  });
});

describe("the coldstart verdict", () => {
  it("accepts a helper that was ready in a measured time and answered granted", () => {
    expect(summariseColdstart({readyMs: 812, permission: "granted"}, true))
      .toEqual({readyMs: 812, permission: "granted", passed: true});
  });

  it("accepts a helper that was ready at once", () => {
    expect(summariseColdstart({readyMs: 0, permission: "granted"}, true)?.passed).toBe(true);
  });

  /**
   * Reporting the permission is this mode's job; accepting it is not. A helper spawned by the
   * window-less evaluation entry that is not granted is the finding that blocks every other mode of
   * the measurement plan, so it is recorded AND it fails.
   */
  it.each(["denied", "refused", "unknown"] as const)("refuses a helper that answered %s", (permission) => {
    const verdict = summariseColdstart({readyMs: 812, permission}, true);
    expect(verdict).toEqual({readyMs: 812, permission, passed: false});
  });

  /**
   * A number that is not one is not a measurement, and `null` beside `passed: true` would be a lie.
   *
   * A NEGATIVE one is the same thing wearing a plausible face. The helper start is 43-90 s (spec
   * 10.1 item 4), which is long enough for a clock step to land inside it; the harness reads a
   * monotonic clock (`main.ts`) so it should never happen, and this is the second half of that —
   * a duration that ran backwards is refused here whatever clock produced it.
   */
  it.each([["NaN", NaN], ["Infinity", Infinity], ["minus Infinity", -Infinity], ["a negative duration", -500]])(
    "refuses a readyMs of %s and records no number",
    (_label, readyMs) => {
      expect(summariseColdstart({readyMs, permission: "granted"}, true))
        .toEqual({readyMs: null, permission: "granted", passed: false});
    }
  );

  it("refuses a run whose helper start time ran backwards, however small", () => {
    expect(summarise("coldstart", [], [], [], {readyMs: -1, permission: "granted"}).accepted).toBe(false);
    expect(summarise("coldstart", [], [], [], {readyMs: 0, permission: "granted"}).accepted).toBe(true);
  });

  it("is null when the run was not a coldstart", () => {
    expect(summariseColdstart({readyMs: 812, permission: "granted"}, false)).toBeNull();
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
    expect(summarise("all", fullAccuracyRun(), fullToolbarRun(), fullObserveRun(), undefined, null, EXPECT_ALL_TEN).accepted).toBe(true);
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
    expect(summarise("observe", [], [], fullObserveRun(), undefined, null, EXPECT_ALL_TEN).missingGroups).toEqual([]);
  });

  it("gives a toolbar run with no capture a failing verdict rather than none at all", () => {
    const summary = summarise("toolbar", [], []);
    expect(summary.toolbar).toMatchObject({captures: 0, passed: false});
    expect(summary.accepted).toBe(false);
  });

  it("refuses an observe run with a private window that would have been kept", () => {
    const rows = fullObserveRun((entry) => entry.case === "safari-private-2" ? {...entry, private: false} : entry);
    const summary = summarise("observe", [], [], rows, undefined, null, EXPECT_ALL_TEN);
    expect(summary.accepted).toBe(false);
    expect(summary.observe?.privateMissed).toBe(1);
  });

  it("refuses an observe run with a normal window flagged private", () => {
    const rows = fullObserveRun((entry) => entry.case === "safari-normal-0" ? {...entry, private: true} : entry);
    expect(summarise("observe", [], [], rows, undefined, null, EXPECT_ALL_TEN).accepted).toBe(false);
  });

  it("refuses an observe run that measured nothing", () => {
    expect(summarise("observe", [], [], []).accepted).toBe(false);
    expect(summarise("observe", [], [], []).observe?.passed).toBe(false);
  });

  /**
   * The default is the strict one. A caller that does not pass an expectation gets a run that cannot
   * be accepted — never one that is accepted for having been asked nothing (finding O1).
   */
  it("refuses an observe run that named nothing, even when every window read as staged", () => {
    const summary = summarise("observe", [], [], fullObserveRun());
    expect(summary.observe?.reason).toBe("EXPLORATORY");
    expect(summary.accepted).toBe(false);
  });

  it("accepts an observe run in which every EXPECTED window read as staged", () => {
    expect(summarise("observe", [], [], fullObserveRun(), undefined, null, EXPECT_ALL_TEN).accepted).toBe(true);
  });

  it("says nothing about the modes that did not run", () => {
    const accuracyOnly = summarise("accuracy", fullAccuracyRun(), []);
    expect(accuracyOnly.observe).toBeNull();
    expect(accuracyOnly.toolbar).toBeNull();
    expect(accuracyOnly.coldstart).toBeNull();
    expect(accuracyOnly.accepted).toBe(true);
    const toolbarOnly = summarise("toolbar", [], fullToolbarRun());
    expect(toolbarOnly.groups).toEqual([]);
    expect(toolbarOnly.observe).toBeNull();
    expect(toolbarOnly.coldstart).toBeNull();
  });

  /**
   * A `coldstart` run's three lists are ALWAYS empty — it reads nothing — so without a verdict of
   * its own it would be exactly the "a run that measured nothing reports ACCEPTED" failure this
   * whole signature exists to remove.
   */
  it("accepts a coldstart run only for both of its figures", () => {
    const granted = summarise("coldstart", [], [], [], {readyMs: 812, permission: "granted"});
    expect(granted.coldstart).toEqual({readyMs: 812, permission: "granted", passed: true});
    expect(granted.accepted).toBe(true);
    expect(granted.groups).toEqual([]);
    expect(granted.missingGroups).toEqual([]);

    expect(summarise("coldstart", [], [], [], {readyMs: 812, permission: "denied"}).accepted).toBe(false);
    expect(summarise("coldstart", [], [], [], {readyMs: NaN, permission: "granted"}).accepted).toBe(false);
  });

  /** `all` is the staged-window run; a helper start time has nothing to add to it. */
  it("keeps coldstart out of every other mode, `all` included", () => {
    for (const mode of EVAL_MODES) {
      const summary = summarise(mode, [], [], [], {readyMs: 812, permission: "granted"});
      expect(summary.coldstart === null, mode).toBe(mode !== "coldstart");
    }
  });

  /**
   * The default exists so the four staged-window modes need not pass figures they have no use for.
   * It must be fail-closed: a coldstart summary built without them measured nothing.
   */
  it("refuses a coldstart summary built with no helper figures at all", () => {
    const summary = summarise("coldstart", [], [], []);
    expect(summary.coldstart).toEqual({readyMs: null, permission: "unknown", passed: false});
    expect(summary.accepted).toBe(false);
  });
});
/**
 * The acceptance half of H1 (2026-09-20): a read of a window that was not the size it was staged at
 * is a real measurement of the wrong thing. It is reported in full and it never counts.
 */
describe("a window that was not the size it was staged at", () => {
  const wrongSize = (accuracy: number): AccuracyRepetition => ({...ok(accuracy), sizeAsStaged: false, scale: null});

  it("makes its case incomplete although every read was `ok`", () => {
    expect(isIncomplete([ok(1), wrongSize(1)])).toBe(true);
    const entry = caseOf("chat-light-14", "chat", [wrongSize(1)]);
    expect(entry.incomplete).toBe(true);
    // and the numbers are all still there
    expect(entry.minAccuracy).toBe(1);
    expect(entry.repetitions[0]?.outcome).toBe("ok");
  });

  it("fails its group, however good the numbers are", () => {
    const [verdict] = summariseGroups([caseOf("chat-light-14", "chat", [wrongSize(1)])]);
    expect(verdict?.min).toBe(1);
    expect(verdict?.incompleteCases).toEqual(["chat-light-14"]);
    expect(verdict?.passed).toBe(false);
  });

  it("fails the whole run's acceptance", () => {
    const cases = ALL_GROUPS.map((group) => caseOf(`${group}-light-14`, group, [group === "chat" ? wrongSize(1) : ok(1)]));
    expect(summarise("accuracy", cases, []).accepted).toBe(false);
    expect(summarise("accuracy", ALL_GROUPS.map((group) => caseOf(`${group}-light-14`, group, [ok(1)])), []).accepted).toBe(true);
  });

  /** `null` is "there was nothing to compare", which is not the same statement and must not fail. */
  it("does not fail a case whose size could not be judged", () => {
    expect(isIncomplete([{...ok(1), sizeAsStaged: null, scale: null}])).toBe(false);
  });

  it("makes a toolbar capture incomplete, so the band is never accepted from an unknown window", () => {
    const run = fullToolbarRun((entry) => (entry.case === "normal-3" ? {...entry, sizeAsStaged: false, scale: null} : entry));
    const verdict = summariseToolbar(run, true);
    expect(verdict?.incompleteCases).toEqual(["normal-3"]);
    expect(verdict?.passed).toBe(false);
  });
});
/**
 * A limited run can never be an acceptance run. Every verdict in it is about the cases it staged,
 * and the option exists to diagnose a failing run in two minutes — never to shorten the run that
 * accepts the sub-project.
 */
describe("a run that staged only part of its table", () => {
  const perfect = () => ALL_GROUPS.map((group) => caseOf(`${group}-light-14`, group, [ok(1)]));
  const LIMITED = {reason: "LIMITED" as const, cases: 4, of: 40};

  it("is not accepted although every row is perfect", () => {
    const full = summarise("accuracy", perfect(), []);
    expect(full.accepted).toBe(true);
    expect(full.limited).toBeNull();

    const short = summarise("accuracy", perfect(), [], [], undefined, LIMITED);
    expect(short.accepted).toBe(false);
    expect(short.limited).toEqual(LIMITED);
    // and every group still reports what it measured: the numbers are not thrown away
    expect(short.groups.every((group) => group.passed)).toBe(true);
  });

  it("is not accepted for a toolbar run either", () => {
    const rows = fullToolbarRun();
    expect(summarise("toolbar", [], rows).accepted).toBe(true);
    expect(summarise("toolbar", [], rows, [], undefined, LIMITED).accepted).toBe(false);
  });

  it("carries a fixed reason and the two counts", () => {
    const short = summarise("toolbar", [], fullToolbarRun(), [], undefined, LIMITED);
    expect(short.limited?.reason).toBe("LIMITED");
    expect(short.limited?.cases).toBe(4);
    expect(short.limited?.of).toBe(40);
  });
});
