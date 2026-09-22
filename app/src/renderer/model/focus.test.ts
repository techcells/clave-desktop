import {describe, expect, it} from "vitest";
import {fetchSettled, focusRowAfterDecision} from "./focus";

describe("focusRowAfterDecision", () => {
  it("focuses the row that now stands where the answered one did", () => {
    expect(focusRowAfterDecision(2, 5)).toBe(2);
  });

  it("falls back to the row before it once the list has shrunk to end exactly there", () => {
    expect(focusRowAfterDecision(3, 3)).toBe(2);
  });

  it("falls back to the first row when the answered position and the one before it are both gone", () => {
    // Only possible with an answered index of 0 on a list that still has at least one row left —
    // index 0 is always in range once rowCount > 0, so this exercises the first branch, not a gap.
    expect(focusRowAfterDecision(0, 1)).toBe(0);
  });

  it("focuses the heading once the list has emptied", () => {
    expect(focusRowAfterDecision(0, 0)).toBeNull();
    expect(focusRowAfterDecision(4, 0)).toBeNull();
  });
});

describe("fetchSettled", () => {
  const viewA = {tag: "a"};
  const viewB = {tag: "b"};

  it("has not settled while nothing about the fetch it was scheduled against has changed", () => {
    expect(fetchSettled({view: viewA, refused: false}, {view: viewA, refused: false})).toBe(false);
  });

  it("has settled once a fresh view arrived", () => {
    expect(fetchSettled({view: viewA, refused: false}, {view: viewB, refused: false})).toBe(true);
  });

  it("has settled once the fetch was refused, even though the old view still stands", () => {
    expect(fetchSettled({view: viewA, refused: false}, {view: viewA, refused: true})).toBe(true);
  });

  it("has settled going the other way too: a refusal that then clears with a fresh view", () => {
    expect(fetchSettled({view: viewA, refused: true}, {view: viewB, refused: false})).toBe(true);
  });
});
