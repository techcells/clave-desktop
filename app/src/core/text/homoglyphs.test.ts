import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {repairHomoglyphs} from "./homoglyphs";

/**
 * The fixture and the Rust source are read from disk on purpose. `imports.test.ts` forbids `node:fs`
 * in core *source* files, not in tests, and reading the two files is the only way these assertions
 * can prove the core and the native reader still agree rather than restating the core's own opinion.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = `${HERE}../../../native/reader/fixtures/homoglyphs.json`;
const RUST = `${HERE}../../../native/reader/src/text.rs`;

interface Case { name: string; in: string; out: string }
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;

/** Parse `('\u{XXXX}', 'c'),` pairs straight out of the reader's TWINS table. */
function rustTwins(): Array<[string, string]> {
  const source = readFileSync(RUST, "utf8");
  const table = /const TWINS: &\[\(char, char\)\] = &\[([\s\S]*?)\n\];/.exec(source);
  if (!table?.[1]) throw new Error("TWINS table not found in text.rs");
  return [...table[1].matchAll(/\('\\u\{([0-9A-Fa-f]{4})\}',\s*'(.)'\)/g)]
    .map((m) => [String.fromCodePoint(parseInt(m[1] as string, 16)), m[2] as string]);
}

describe("repairHomoglyphs", () => {
  it("has the fixture the native reader shares", () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
  });

  it.each(cases.map((c): [string, Case] => [c.name, c]))("%s", (_name, c) => {
    expect(repairHomoglyphs(c.in)).toBe(c.out);
  });

  it.each(cases.map((c): [string, Case] => [c.name, c]))("is idempotent: %s", (_name, c) => {
    expect(repairHomoglyphs(c.out)).toBe(c.out);
  });

  /**
   * The table is ported from `text.rs` by script, so the thing that can rot is the port, not the
   * port's source. Every pair the reader knows must repair the same way here; a pair dropped from
   * the TypeScript table leaves its character in place and fails on that row.
   */
  it("repairs every pair the reader's TWINS table carries, to the same letter", () => {
    const twins = rustTwins();
    expect(twins).toHaveLength(37);
    const wrong = twins.filter(([twin, latin]) => repairHomoglyphs(`x${twin}x`) !== `x${latin}x`);
    expect(wrong.map(([twin]) => twin.codePointAt(0)?.toString(16))).toEqual([]);
  });

  /**
   * The other direction: the core must not repair a character the reader leaves alone, or the two
   * would disagree on text the reader had already passed through.
   */
  it("changes nothing the reader's table does not list", () => {
    const known = new Set(rustTwins().map(([twin]) => twin));
    const surprises: string[] = [];
    for (let code = 0x0370; code <= 0x04ff; code++) {
      const ch = String.fromCodePoint(code);
      if (known.has(ch)) continue;
      if (repairHomoglyphs(`x${ch}x`) !== `x${ch}x`) surprises.push(code.toString(16));
    }
    expect(surprises).toEqual([]);
  });

  /**
   * The two characters where JavaScript's `\s` and Rust's `char::is_whitespace` disagree. Both are
   * also fixture cases; these assertions name the reason, so a future reader who swaps the explicit
   * class back for `\s` is told what broke rather than being handed a fixture row.
   */
  describe("word boundaries follow Unicode White_Space, not JavaScript's \\s", () => {
    it("treats U+0085 NEXT LINE as whitespace, which \\s does not", () => {
      expect(/\s/.test("\u0085")).toBe(false); // the JavaScript rule, for the record
      const moscow = "\u041c\u041e\u0421\u041a\u0412\u0410";
      expect(repairHomoglyphs(`${moscow}\u0085today`)).toBe(`${moscow}\u0085today`);
    });

    it("does not treat U+FEFF as whitespace, which \\s does", () => {
      expect(/\s/.test("\ufeff")).toBe(true); // the JavaScript rule, for the record
      const som = "\u0421\u041e\u041c";
      expect(repairHomoglyphs(`${som}\ufeffport`)).toBe("COM\ufeffport");
    });

    it("splits on the rest of White_Space, which the two agree about", () => {
      for (const space of ["\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680", "\u2003", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000"]) {
        const som = "\u0421\u041e\u041c";
        expect(repairHomoglyphs(`${som}${space}port`)).toBe(`${som}${space}port`);
      }
    });
  });
});
