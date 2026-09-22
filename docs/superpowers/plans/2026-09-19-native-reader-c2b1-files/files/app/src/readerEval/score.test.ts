/**
 * The phase-0 scorer's own `--selftest` assertions, carried over verbatim, plus what the port added.
 *
 * They are here because the findings' numbers were produced by the Python; if this port disagrees
 * with it on any of these seven cases then a rerun of the evaluation is measuring something else and
 * nobody would know.
 *
 * Every accented string below is built from code points rather than typed, for the same reason the
 * truth files were extracted by script: a decomposed accent looks identical in a review and counts
 * as two characters here.
 */
import {describe, expect, it} from "vitest";
import {ACCENTED, accents, accuracy, between, confusions, lev, norm} from "./score";

const cp = (...points: number[]): string => String.fromCodePoint(...points);
/** "não está" and its unaccented twin. */
const NAO_ESTA = `n${cp(0x00e3)}o est${cp(0x00e1)}`;
const NAO_ESTA_PLAIN = "nao esta";

describe("score.py's selftest, ported", () => {
  it("lev('kitten','sitting') is 3", () => {
    expect(lev("kitten", "sitting")).toBe(3);
  });

  it("accuracy ignores how much whitespace there was", () => {
    expect(accuracy("hello world", "hello  world")).toBe(1);
  });

  it("between() finds the staged body and says so", () => {
    expect(between("tab bar STARTMARKER body ENDMARKER footer")).toEqual({body: " body ", found: true});
  });

  it("between() with no markers gives back the whole text and says it did not find them", () => {
    expect(between("no markers")).toEqual({body: "no markers", found: false});
  });

  /**
   * `re.I` in Python folds case over the whole of Unicode; JavaScript's `i` alone does not, and the
   * KELVIN SIGN is the pair that shows it. The original scored such a read; this port must too, or a
   * rerun is measuring a different thing from the findings it is checked against.
   */
  it("finds the markers through a Unicode case fold, exactly as re.I does", () => {
    expect(between(`STARTMAR${cp(0x212a)}ER body ENDMARKER`)).toEqual({body: " body ", found: true});
    expect(between("startmarker body endmarker")).toEqual({body: " body ", found: true});
  });

  it("one dropped character out of eleven", () => {
    expect(Math.abs(accuracy("helo world", "hello world") - (1 - 1 / 11))).toBeLessThan(1e-9);
  });

  it("losing every accent scores 0", () => {
    expect(accents(NAO_ESTA_PLAIN, NAO_ESTA)).toBe(0);
  });

  it("keeping every accent scores 1", () => {
    expect(accents(NAO_ESTA, NAO_ESTA)).toBe(1);
  });
});

describe("normalisation", () => {
  it("is NFC, so a decomposed accent equals the precomposed one", () => {
    const decomposed = `n${cp(0x0061, 0x0303)}o`;
    expect(norm(decomposed)).toBe(norm(`n${cp(0x00e3)}o`));
  });

  it("folds the whitespace Python's \\s folds and JavaScript's does not", () => {
    // U+0085 NEXT LINE and U+001E RECORD SEPARATOR: both whitespace to the Python original.
    expect(norm(`a${cp(0x0085)}b`)).toBe("a b");
    expect(norm(`a${cp(0x001e)}b`)).toBe("a b");
    expect(norm(`a${cp(0x00a0)}b`)).toBe("a b");
  });

  it("trims the ends, as the original did", () => {
    expect(norm("  a b  ")).toBe("a b");
  });

  /**
   * The one place JavaScript's `trim` and Python's `strip` disagree, and the disagreement is in the
   * direction that RAISES accuracy: `trim` strips U+FEFF, `strip` does not. This function exists to
   * be comparable with the phase-0 numbers, so it counts a zero-width no-break space as a character
   * the recogniser invented wherever it sits — at either end exactly as in the middle.
   */
  it("keeps a zero-width no-break space at either end, because score.py's strip does", () => {
    const bom = cp(0xfeff);
    expect(norm(`${bom}hello world`)).toBe(`${bom}hello world`);
    expect(norm(`hello world${bom}`)).toBe(`hello world${bom}`);
    expect(norm(`hello${bom}world`)).toBe(`hello${bom}world`);
  });

  it("still trims the whitespace the original did trim, at both ends and however much of it", () => {
    expect(norm(`${cp(0x0085)}a b${cp(0x001e)}`)).toBe("a b");
    expect(norm(`${cp(0x00a0)}${cp(0x3000)} a `)).toBe("a");
    expect(norm("   ")).toBe("");
  });
});

describe("the accented set", () => {
  it("is twelve lowercase letters and their uppercase twins", () => {
    expect([...ACCENTED]).toHaveLength(24);
    expect(ACCENTED.codePointAt(0)).toBe(0x00e1);
    expect([...ACCENTED].map((c) => c.codePointAt(0))).toContain(0x00e7);
    expect([...ACCENTED].map((c) => c.codePointAt(0))).toContain(0x00d5);
  });

  it("a recogniser that invents accents cannot score above 1", () => {
    expect(accents(`${NAO_ESTA} ${NAO_ESTA}`, NAO_ESTA)).toBe(1);
  });

  it("truth with no accent at all scores 1", () => {
    expect(accents("plain", "plain")).toBe(1);
  });
});

describe("confusions", () => {
  it("reports a single-character substitution with its count", () => {
    expect(confusions("a1c a1c", "alc alc")).toEqual([{from: "l", to: "1", count: 2}]);
  });

  it("reports nothing for an exact read", () => {
    expect(confusions("hello", "hello")).toEqual([]);
  });

  it("never reports an insertion or a deletion as a pair", () => {
    // "helo" lost an l; "helllo" gained one. Neither is a substitution of one character by one.
    expect(confusions("helo", "hello")).toEqual([]);
    expect(confusions("helllo", "hello")).toEqual([]);
  });

  it("is capped, and the most frequent pair comes first", () => {
    const truth = "aaaa bbb cc d";
    const ocr = "xxxx yyy zz w";
    const found = confusions(ocr, truth, 2);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({from: "a", to: "x", count: 4});
    expect(found[1]).toEqual({from: "b", to: "y", count: 3});
  });

  it("orders ties the same way every run, so two runs of one file agree", () => {
    const first = confusions("x y", "a b");
    const second = confusions("x y", "a b");
    expect(first).toEqual(second);
    expect(first.map((entry) => entry.from)).toEqual(["a", "b"]);
  });

  it("catches the backtick-to-apostrophe confusion phase 0 measured on the code page", () => {
    const truth = "const key = `x`;";
    const ocr = "const key = 'x';";
    expect(confusions(ocr, truth)).toEqual([{from: "`", to: "'", count: 2}]);
  });
});
