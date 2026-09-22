import {describe, expect, it} from "vitest";
import {isStagedTitle, stagedTitleFor, STAGED_TITLE_PREFIX} from "./stagedTitle";

describe("the staged title", () => {
  it("is the prefix, the case name and the run's nonce", () => {
    expect(stagedTitleFor("chat-light-14", "abc123")).toBe("CLAVE-EVAL chat-light-14 abc123");
    expect(STAGED_TITLE_PREFIX).toBe("CLAVE-EVAL ");
  });

  it("differs between runs of the same case, which is what makes a leftover window unreadable", () => {
    expect(stagedTitleFor("chat-light-14", "abc123")).not.toBe(stagedTitleFor("chat-light-14", "def456"));
  });

  it("differs between cases of the same run", () => {
    expect(stagedTitleFor("chat-light-14", "abc123")).not.toBe(stagedTitleFor("chat-dark-14", "abc123"));
  });

  it.each([
    ["one of ours", "CLAVE-EVAL chat-light-14 abc123", true],
    ["the prefix and something", "CLAVE-EVAL x", true],
    ["the bare prefix", "CLAVE-EVAL ", false],
    ["the prefix with no space", "CLAVE-EVAL", false],
    ["an empty title", "", false],
    ["somebody's window", "Inbox (14)", false],
    ["the prefix somewhere in the middle", "Mail CLAVE-EVAL x", false],
    ["the wrong case", "clave-eval x", false]
  ])("recognises %s as %s", (_label, value, expected) => {
    expect(isStagedTitle(value)).toBe(expected);
  });
});
