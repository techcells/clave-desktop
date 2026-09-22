/**
 * Every threshold, pinned to its exact value.
 *
 * The point is not that these numbers are hard to remember. It is that lowering one is the single
 * cheapest way to make a failing evaluation pass, and the only defence against it is that doing so
 * cannot be quiet: this test turns a lowered threshold into a failing build with the old number and
 * the new one side by side in the output, in front of whoever is reviewing the change.
 *
 * **A shortfall goes to the owner with the numbers. An agent never lowers one of these.**
 */
import {describe, expect, it} from "vitest";
import {
  ACCURACY_THRESHOLDS,
  CONFUSIONS_MAX,
  DEFAULT_REPETITIONS,
  GUARD_POLL_MS,
  GUARD_TIMEOUT_MS,
  OBSERVE_POLL_MS,
  OBSERVE_SECONDS_DEFAULT,
  PT_ACCENTS_MIN,
  TOOLBAR_CAPTURES_PER_MODE,
  TOOLBAR_THRESHOLDS
} from "./thresholds";

describe("the spec's numbers", () => {
  it("accuracy thresholds are exactly spec section 6's P4 row", () => {
    expect(ACCURACY_THRESHOLDS).toEqual({chat: 0.97, ticket: 0.97, terminal: 0.95, pt: 0.95, code: 0.9});
  });

  it("chat and ticket are 0.97, not 0.96", () => {
    expect(ACCURACY_THRESHOLDS.chat).toBe(0.97);
    expect(ACCURACY_THRESHOLDS.ticket).toBe(0.97);
  });

  it("terminal and Portuguese are 0.95 and code is 0.90", () => {
    expect(ACCURACY_THRESHOLDS.terminal).toBe(0.95);
    expect(ACCURACY_THRESHOLDS.pt).toBe(0.95);
    expect(ACCURACY_THRESHOLDS.code).toBe(0.9);
  });

  it("Portuguese loses no accent at all", () => {
    expect(PT_ACCENTS_MIN).toBe(1);
  });

  it("toolbar counts are spec section 6's P5 row plus phase 0's zero false positives", () => {
    expect(TOOLBAR_THRESHOLDS).toEqual({hostHitsMin: 19, privateHitsMin: 20, falsePrivateMax: 0});
    expect(TOOLBAR_CAPTURES_PER_MODE).toBe(20);
  });

  it("five repetitions per case, as spec 10.1 item 15 asks", () => {
    expect(DEFAULT_REPETITIONS).toBe(5);
  });

  it("the guard's patience and poll, and observe mode's, are what the brief set", () => {
    expect(GUARD_TIMEOUT_MS).toBe(15_000);
    expect(GUARD_POLL_MS).toBe(500);
    expect(OBSERVE_SECONDS_DEFAULT).toBe(120);
    expect(OBSERVE_POLL_MS).toBe(2_000);
  });

  it("at most five confusion pairs are ever reported", () => {
    expect(CONFUSIONS_MAX).toBe(5);
  });
});
