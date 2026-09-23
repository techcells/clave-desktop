/**
 * The five truth files are the measurement's rulers. If one of them changes by a byte, every
 * accuracy number this harness has ever produced stops being comparable with the phase-0 findings —
 * silently, because a slightly different ruler still measures.
 *
 * They were produced by extracting the five fenced blocks of
 * `docs/superpowers/plans/2026-09-18-native-reader-phase0-spikes.md` (Task 1, Step 2) with a script,
 * twice, in two languages, and comparing the SHA-256 of both extractions. They were never retyped:
 * `terminal.txt` carries U+2713, U+276F and U+00D7 and `pt.txt` carries nine accented letters, and
 * the tools in this pipeline have been measured turning a backslash-u escape into the character it
 * names and a curly quote into an ASCII one.
 *
 * So this file pins them three ways: the hashes, the specific characters by CODE POINT (never by a
 * typed literal, which is the very failure being guarded against), and NFC — a decomposed accent
 * would score as two characters here and one on the screen.
 */
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const TRUTH_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "reader-eval", "truth");

const read = (name: string): string => readFileSync(join(TRUTH_DIR, `${name}.txt`), "utf8");
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Both independent extractions produced exactly these. */
const HASHES: Readonly<Record<string, string>> = {
  chat: "266057a13b5e448a771f85a2e619d2169a45082be75e41330f845c6d98482209",
  ticket: "cf6a381ea569ca7af69f75a478c9926eab7a74a01a75f1e027365e336b23ca3c",
  code: "cb626eaa30deb699773777c83552d17e5ce65d224908466fee7e05bf6e9d0dff",
  pt: "01c7da18062f136f5d46b1839f29bcc1597cd06443b3e782f687efc2ee5f7316",
  terminal: "31300e14e1120d043784f46e65ad2a9423cc6c66192f6217182eb42f1038e6be"
};

/** Named by code point on purpose: this test cannot be defeated by the corruption it looks for. */
const CHECK = 0x2713;        // the vitest tick of terminal.txt
const CHEVRON = 0x276f;      // the "running file" chevron
const MULTIPLY = 0x00d7;     // the failed-assertion cross
const C_CEDILLA = 0x00e7;
const A_TILDE = 0x00e3;
const O_TILDE = 0x00f5;
const E_ACUTE = 0x00e9;
const I_ACUTE = 0x00ed;

const has = (value: string, codePoint: number): boolean => [...value].some((c) => c.codePointAt(0) === codePoint);

describe("the staged truth files", () => {
  it.each(Object.keys(HASHES))("%s.txt is byte for byte what was extracted from the phase-0 plan", (name) => {
    expect(sha256(read(name))).toBe(HASHES[name]);
  });

  it("terminal.txt still carries the three symbols a retyping would flatten", () => {
    const terminal = read("terminal");
    expect(has(terminal, CHECK), "U+2713").toBe(true);
    expect(has(terminal, CHEVRON), "U+276F").toBe(true);
    expect(has(terminal, MULTIPLY), "U+00D7").toBe(true);
  });

  it("pt.txt still carries the accented letters the pt threshold is about", () => {
    const pt = read("pt");
    for (const [label, codePoint] of [
      ["c cedilla", C_CEDILLA], ["a tilde", A_TILDE], ["o tilde", O_TILDE],
      ["e acute", E_ACUTE], ["i acute", I_ACUTE]
    ] as const) {
      expect(has(pt, codePoint), label).toBe(true);
    }
  });

  it("every file is NFC, so an accent is one character here and one on the screen", () => {
    for (const name of Object.keys(HASHES)) {
      const value = read(name);
      expect(value.normalize("NFC"), name).toBe(value);
    }
  });

  it("every file ends with a newline and none is empty", () => {
    for (const name of Object.keys(HASHES)) {
      const value = read(name);
      expect(value.length, name).toBeGreaterThan(300);
      expect(value.endsWith("\n"), name).toBe(true);
    }
  });
});
