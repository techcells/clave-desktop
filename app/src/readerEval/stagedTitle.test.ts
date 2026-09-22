import {describe, expect, it} from "vitest";
import {
  READY_SIZE_END,
  READY_SIZE_MAX,
  READY_TOKEN,
  isStagedTitle,
  readySizeIn,
  readySizeToken,
  stagedTitleFor,
  STAGED_TITLE_PREFIX
} from "./stagedTitle";

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
/** Moved here from `stage.test.ts` (review C, Minor 6): this is where a reader looks for it. */
/**
 * The one place in the harness where a number is read out of a window title. Bounded, digits only,
 * both numbers or neither — see `readySizeIn` for why the exception exists at all.
 */
describe("reading the size back out of a ready title", () => {
  const staged = "CLAVE-EVAL terminal abc123";
  const titled = (token: string): string => `${staged}${READY_TOKEN} ${token}`;

  it("reads the two numbers the shell printed", () => {
    expect(readySizeIn(`${staged}${READY_TOKEN}${readySizeToken(140, 40)}`, staged)).toEqual({columns: 140, rows: 40});
    expect(readySizeIn(`${staged}${READY_TOKEN}${readySizeToken(72, 40)} - Terminal`, staged)).toEqual({columns: 72, rows: 40});
  });

  it("reads nothing from a title that is not this case's", () => {
    expect(readySizeIn(`CLAVE-EVAL other abc123${READY_TOKEN} 140x40.`, staged)).toEqual({columns: null, rows: null});
    expect(readySizeIn(`CLAVE-EVAL terminal 999999${READY_TOKEN} 140x40.`, staged)).toEqual({columns: null, rows: null});
    expect(readySizeIn(staged, staged)).toEqual({columns: null, rows: null});
  });

  it("stops at the closing sentinel rather than running on into whatever follows", () => {
    expect(readySizeIn(titled("140x40. some window name 9x9."), staged)).toEqual({columns: 140, rows: 40});
  });

  it.each([
    ["no closing sentinel", "140x40"],
    ["no separator", "140-40."],
    ["three numbers", "1x2x3."],
    ["a word", "axb."],
    ["a signed number", "+140x40."],
    ["a negative number", "-140x40."],
    ["a fraction", "140.5x40."],
    ["a space inside", "140 x40."],
    ["hexadecimal", "0x20x40."],
    ["nothing at all", "."],
    ["a zero", "0x40."],
    ["past the bound", "1001x40."],
    ["far past the bound", "99999x40."],
    ["an empty column count", "x40."]
  ])("reads nothing from %s", (_label, token) => {
    expect(readySizeIn(titled(token), staged)).toEqual({columns: null, rows: null});
  });

  /** A zero-padded number is not one this harness printed, so it is not read as one. */
  it.each(["072x40.", "0072x40.", "72x040.", "0001x0001."])("reads nothing from a padded %s", (token) => {
    expect(readySizeIn(titled(token), staged)).toEqual({columns: null, rows: null});
  });

  it("takes the bounds themselves", () => {
    expect(readySizeIn(titled("1x1."), staged)).toEqual({columns: 1, rows: 1});
    expect(readySizeIn(titled(`${READY_SIZE_MAX}x${READY_SIZE_MAX}.`), staged))
      .toEqual({columns: READY_SIZE_MAX, rows: READY_SIZE_MAX});
    expect(readySizeIn(titled(`${READY_SIZE_MAX + 1}x1.`), staged)).toEqual({columns: null, rows: null});
  });

  /** Both or neither: half a token is not a size, and a lone number invites a comparison. */
  it("gives up both numbers when either is not one", () => {
    expect(readySizeIn(titled("140x0."), staged)).toEqual({columns: null, rows: null});
    expect(readySizeIn(titled("0x40."), staged)).toEqual({columns: null, rows: null});
  });

  /** The shell prints `READY x.` when it could not measure at all. */
  it("reads nothing from the token an unmeasured shell prints", () => {
    expect(readySizeIn(titled("x."), staged)).toEqual({columns: null, rows: null});
    expect(READY_SIZE_END).toBe(".");
  });
});
