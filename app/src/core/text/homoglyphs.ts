/**
 * Repairing script homoglyphs in recognised text, inside sub-project A.
 *
 * macOS text recognition returns characters that look like a Latin letter but are not one:
 * phase 0 measured `U+0410 CYRILLIC CAPITAL LETTER A` in place of Latin `A` in 5 of 17 reads, in the
 * same English words every time (spec 10.1 item 13). Every matcher in the core — the private-window
 * markers, the excluded-site hosts, the scrub and secret patterns, the guard, the name rules, the
 * English check — is plain substring and pattern matching, which one such character defeats in
 * silence.
 *
 * The native reader already repairs this in `app/native/reader/src/text.rs`
 * (`normalise_homoglyphs`), before it even cuts the toolbar strip. This module exists anyway,
 * because sub-project A must not assume that whatever produced a read had done the repair: the core
 * is handed text by the native reader today, by the stand-in reader in tests and dev, and by
 * whatever a later platform port brings. Spec 10.1 item 13's sub-project-A half is exactly this
 * requirement, and the 2026-09-19 C-2a review (item 34) recorded that nothing pinned it.
 *
 * The repair is idempotent, which is what makes doing it twice safe: the rule below only ever turns
 * a twin into its Latin letter, and a Latin letter is not a twin. The shared fixture
 * `app/native/reader/fixtures/homoglyphs.json` asserts that in both languages, for every case.
 *
 * THE RULE, applied to each whitespace-delimited word of the text on its own, and identical to the
 * reader's: **a word that itself contains at least one Latin letter** (ASCII, Latin-1 Supplement or
 * Latin Extended-A/B) **has every twin in it replaced**; any other word is returned exactly as it
 * came. Whitespace is copied back verbatim, so indentation and column alignment survive.
 *
 * A word rendered *entirely* in twins is therefore never rewritten, however English the rest of the
 * line looks: whole words of real Cyrillic and Greek are made of twins, and rewriting one silently
 * costs a bilingual user their own language on the way into the extraction model. The reader's doc
 * comment carries the full argument and the `MOCKBA` bug that proved it; this file must not diverge
 * from it, and the shared fixture is what holds the two together.
 */

/**
 * Cyrillic and Greek characters that are visually identical to a Latin letter, and that letter.
 *
 * Ported mechanically from `TWINS` in `app/native/reader/src/text.rs` — parsed out of that file by
 * script, never retyped — and kept as escapes for the same reason it is escaped there: a reviewer
 * can check a code point against the Unicode charts, and no editor, terminal, model or copy-paste
 * step can silently swap one of these for its Latin twin, which is the very bug the table undoes.
 * `homoglyphs.test.ts` re-parses the Rust table and fails if the two ever differ.
 */
const TWINS: ReadonlyMap<string, string> = new Map([
  // Cyrillic capitals
  ["\u0410", "A"], // CYRILLIC CAPITAL LETTER A
  ["\u0412", "B"], // CYRILLIC CAPITAL LETTER VE
  ["\u0415", "E"], // CYRILLIC CAPITAL LETTER IE
  ["\u041A", "K"], // CYRILLIC CAPITAL LETTER KA
  ["\u041C", "M"], // CYRILLIC CAPITAL LETTER EM
  ["\u041D", "H"], // CYRILLIC CAPITAL LETTER EN
  ["\u041E", "O"], // CYRILLIC CAPITAL LETTER O
  ["\u0420", "P"], // CYRILLIC CAPITAL LETTER ER
  ["\u0421", "C"], // CYRILLIC CAPITAL LETTER ES
  ["\u0422", "T"], // CYRILLIC CAPITAL LETTER TE
  ["\u0425", "X"], // CYRILLIC CAPITAL LETTER HA
  // Cyrillic small letters
  ["\u0430", "a"], // CYRILLIC SMALL LETTER A
  ["\u0435", "e"], // CYRILLIC SMALL LETTER IE
  ["\u043E", "o"], // CYRILLIC SMALL LETTER O
  ["\u0440", "p"], // CYRILLIC SMALL LETTER ER
  ["\u0441", "c"], // CYRILLIC SMALL LETTER ES
  ["\u0443", "y"], // CYRILLIC SMALL LETTER U
  ["\u0445", "x"], // CYRILLIC SMALL LETTER HA
  ["\u0456", "i"], // CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  ["\u0458", "j"], // CYRILLIC SMALL LETTER JE
  ["\u0455", "s"], // CYRILLIC SMALL LETTER DZE
  // Greek capitals
  ["\u0391", "A"], // GREEK CAPITAL LETTER ALPHA
  ["\u0392", "B"], // GREEK CAPITAL LETTER BETA
  ["\u0395", "E"], // GREEK CAPITAL LETTER EPSILON
  ["\u0396", "Z"], // GREEK CAPITAL LETTER ZETA
  ["\u0397", "H"], // GREEK CAPITAL LETTER ETA
  ["\u0399", "I"], // GREEK CAPITAL LETTER IOTA
  ["\u039A", "K"], // GREEK CAPITAL LETTER KAPPA
  ["\u039C", "M"], // GREEK CAPITAL LETTER MU
  ["\u039D", "N"], // GREEK CAPITAL LETTER NU
  ["\u039F", "O"], // GREEK CAPITAL LETTER OMICRON
  ["\u03A1", "P"], // GREEK CAPITAL LETTER RHO
  ["\u03A4", "T"], // GREEK CAPITAL LETTER TAU
  ["\u03A5", "Y"], // GREEK CAPITAL LETTER UPSILON
  ["\u03A7", "X"], // GREEK CAPITAL LETTER CHI
  // Greek small letters
  ["\u03BF", "o"], // GREEK SMALL LETTER OMICRON
  ["\u03BD", "v"], // GREEK SMALL LETTER NU
]);

/**
 * The Unicode `White_Space` property, spelled out, because this is where TypeScript and Rust do not
 * agree and the disagreement changes the answer.
 *
 * Rust's `char::is_whitespace` is exactly `White_Space`. JavaScript's `\s` is not: it leaves out
 * `U+0085 NEXT LINE` (which `White_Space` includes) and adds `U+FEFF ZERO WIDTH NO-BREAK SPACE`
 * (which it does not). Both differences are word-boundary decisions, so both change what this
 * function returns: with `\s`, a `U+0085` between a wholly-Cyrillic word and an English one would
 * glue them into one word with a Latin letter in it and rewrite the Cyrillic — the corruption the
 * rule exists to prevent — and a `U+FEFF` would split a word the reader keeps whole. Both are
 * fixture cases, asserted in both languages.
 *
 * Written as escapes, like the table above and for the same reason: every character in this class
 * is invisible, and several of them are the ones an editor is most likely to normalise away.
 */
const WHITE_SPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

/**
 * ASCII letters plus the Latin-1 Supplement and Latin Extended-A/B letter blocks, i.e. what the
 * Portuguese of a real read is written in. `U+00D7 MULTIPLICATION SIGN` and `U+00F7 DIVISION SIGN`
 * sit inside the Latin-1 range but are symbols, not letters. Mirrors `is_latin_letter` in `text.rs`.
 */
function isLatinLetter(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return true;
  if (c === 0xd7 || c === 0xf7) return false;
  return (c >= 0xc0 && c <= 0xff) || (c >= 0x100 && c <= 0x24f);
}

/** Every key of TWINS is Greek or Cyrillic, so the map lookup is the whole test — as in `is_twin`. */
const isTwin = (ch: string): boolean => TWINS.has(ch);

/** A word is repaired only on evidence it carries itself. Mirrors `should_normalise_word`. */
function shouldRepairWord(word: string): boolean {
  let twin = false;
  let latin = false;
  for (const ch of word) {
    if (isTwin(ch)) twin = true;
    else if (isLatinLetter(ch)) latin = true;
    if (twin && latin) return true;
  }
  return false;
}

interface Piece { text: string; space: boolean }

/**
 * Split into alternating runs of whitespace and non-whitespace, keeping both. Mirrors
 * `split_keeping_whitespace`; iteration is by code point, so an astral character is one unit here
 * exactly as it is in Rust.
 */
function splitKeepingWhitespace(text: string): Piece[] {
  const pieces: Piece[] = [];
  for (const ch of text) {
    const space = WHITE_SPACE.test(ch);
    const last = pieces[pieces.length - 1];
    if (last && last.space === space) last.text += ch;
    else pieces.push({text: ch, space});
  }
  return pieces;
}

/**
 * Replace Cyrillic and Greek look-alikes with their Latin twins, where doing so cannot corrupt real
 * Cyrillic or Greek text. See the rule at the top of this file.
 */
export function repairHomoglyphs(text: string): string {
  let any = false;
  for (const ch of text) if (isTwin(ch)) { any = true; break; }
  if (!any) return text; // The overwhelmingly common case: nothing to do, and nothing to allocate.
  let out = "";
  for (const piece of splitKeepingWhitespace(text)) {
    if (piece.space || !shouldRepairWord(piece.text)) { out += piece.text; continue; }
    for (const ch of piece.text) out += TWINS.get(ch) ?? ch;
  }
  return out;
}
