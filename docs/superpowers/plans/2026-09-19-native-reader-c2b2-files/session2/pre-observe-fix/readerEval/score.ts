/**
 * The phase-0 scorer (`$SPIKE/tools/score.py`), ported to TypeScript so the staged-window run can
 * score in memory and never write a recognised page to disk.
 *
 * Every function here is a deliberate port of the Python original, not a re-invention: the numbers
 * in `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md` were produced by that
 * script, and a run of this harness is only comparable with them if the arithmetic is the same. The
 * script's own `--selftest` assertions are carried over as unit tests for exactly that reason.
 *
 * `confusions` is the one addition. The spike brief asked its human operator to "diff the OCR body
 * against the truth by eye"; this does it mechanically, and only for cases that fell short.
 */
import {CONFUSIONS_MAX} from "./thresholds";

/**
 * The accented letters Portuguese accuracy is judged on, built from code points rather than typed.
 *
 * Typed literals are how this file would get quietly corrupted: several tools in this pipeline
 * decode a backslash-u escape into the character it names, and a retyped accent that lands as the
 * decomposed pair (letter + combining mark) would still LOOK right in a review while counting as a
 * different character here. Code points cannot be mistyped invisibly.
 *
 * The set is the Python original's `ACCENTED` string, lowercase then uppercase, in its order.
 */
const ACCENTED_CODE_POINTS = [
  0x00e1, 0x00e0, 0x00e2, 0x00e3, 0x00e7, 0x00e9, 0x00ea, 0x00ed, 0x00f3, 0x00f4, 0x00f5, 0x00fa,
  0x00c1, 0x00c0, 0x00c2, 0x00c3, 0x00c7, 0x00c9, 0x00ca, 0x00cd, 0x00d3, 0x00d4, 0x00d5, 0x00da
] as const;

export const ACCENTED = String.fromCodePoint(...ACCENTED_CODE_POINTS);

/**
 * What counts as whitespace, matching Python's `\s` for `str` patterns — which is what the original
 * collapsed runs of.
 *
 * It is spelled out because the two languages disagree at the edges and the disagreement is not
 * theoretical for recognised text: JavaScript's own `\s` folds U+FEFF (which Python's does not) and
 * does NOT fold U+0085 or U+001C-U+001F (which Python's does). `\p{White_Space}` covers U+0085 and
 * every Unicode space; the four separators are added by hand. U+FEFF is deliberately left out, so a
 * zero-width no-break space counts as a character the recogniser invented, exactly as it did in the
 * numbers this harness is compared against -- which is also why `norm` below does not use `trim`.
 *
 * It is built from a STRING with the separators spelled as escapes, not from a regex literal with
 * the characters themselves in it. This file once held the literal bytes: `file(1)` then called it
 * `data`, `grep` skipped it silently, and the class could have lost a byte in a copy with nothing
 * to show for it in a diff. `bytes.test.ts` holds the rule for the whole harness.
 */
const WHITESPACE_RUN = new RegExp("[\\p{White_Space}\\u001C-\\u001F]+", "gu");

/** The single space a leading (or trailing) whitespace run has already been collapsed into. */
const LEADING_SPACE = new RegExp("^ ");
const TRAILING_SPACE = new RegExp(" $");

/**
 * NFC, runs of whitespace collapsed to one space, ends trimmed. The Python `norm`.
 *
 * The ends are trimmed by hand rather than with `trim()`, and the difference is not cosmetic:
 * JavaScript's `trim` strips U+FEFF and Python's `str.strip()` does not, so `trim` would quietly
 * forgive a zero-width no-break space at either end of a read and score it 1.0 where the phase-0
 * scorer scored 0.998 — leniency, in the one function whose whole job is comparability with those
 * numbers. The collapse above has already turned every run of whitespace into exactly one U+0020,
 * so removing one leading and one trailing space is precisely what `strip()` would have removed.
 */
export function norm(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE_RUN, " ").replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

/** Levenshtein distance, the same two-row form the Python used. */
export function lev(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length] as number;
}

export interface Between { body: string; found: boolean }

/**
 * The staged body's bookends. `u` is not decoration: without it JavaScript's `i` canonicalises only
 * within ASCII, so a recognised KELVIN SIGN in `STARTMARKER` would not fold to `k` — and the Python
 * original, whose `re.I` folds over the whole of Unicode, scored exactly that read. With `u` the
 * two agree on all 25 cases of the differential against `score.py`, and the flag set matches
 * `WHITESPACE_RUN` above.
 */
const MARKED = new RegExp("STARTMARKER([\\s\\S]*)ENDMARKER", "iu");

/**
 * The staged body, between the two markers. Case-insensitive and greedy, like the original's
 * `re.S | re.I` with `(.*)`: the recogniser renders the markers in whatever case it reads them, and
 * the last `ENDMARKER` is the end of the page.
 *
 * `found: false` is not a scoring detail — it means the read did not contain the staged page's own
 * bookends, and the whole repetition is suspect (phase 0 used it to catch a marker the recogniser
 * had dropped, which is how the `.marker` opacity finding was made).
 */
export function between(text: string): Between {
  const match = MARKED.exec(text);
  return match ? {body: match[1] as string, found: true} : {body: text, found: false};
}

/** The same two words, each on its own, with the same flags `MARKED` uses. */
const START_MARKER = new RegExp("STARTMARKER", "iu");
const END_MARKER = new RegExp("ENDMARKER", "iu");

/**
 * Which of the two bookends the read contained — DIAGNOSTICS, and nothing else.
 *
 * It scores nothing, it is not consulted by `between`, `accuracy`, `accents` or `confusions`, and no
 * verdict anywhere depends on it. It exists because `noMarkers` is one outcome covering four
 * different failures, and the first run against a screen produced it for both Terminal cases with no
 * way to tell them apart (dev report section 6): the read may have happened before the shell printed
 * anything, or the output may have scrolled so that one marker left the window, or Terminal may have
 * restored an older window, or a marker may simply have been misrecognised. `start` without `end`
 * is the scrolled or truncated case; neither, with nothing else read, is the empty window; both,
 * with `between` still failing, cannot happen and would say the two disagree.
 *
 * Two booleans. Nothing recognised is kept, here or downstream.
 */
export function markerHits(text: string): {start: boolean; end: boolean} {
  return {start: START_MARKER.test(text), end: END_MARKER.test(text)};
}

/** Character accuracy of a recognised body against its truth, never below zero. */
export function accuracy(ocr: string, truth: string): number {
  const o = norm(ocr);
  const t = norm(truth);
  return Math.max(0, 1 - lev(o, t) / Math.max(1, [...t].length));
}

function countOf(haystack: string, character: string): number {
  let seen = 0;
  for (const c of haystack) if (c === character) seen += 1;
  return seen;
}

/**
 * The share of the truth's accented letters that survived recognition, counted per character and
 * capped at what the truth actually contains (the Python's `min(o.count(c), t.count(c))`), so a
 * recogniser that invents accents cannot score above 1.0. A truth with no accents scores 1.0.
 */
export function accents(ocr: string, truth: string): number {
  const o = ocr.normalize("NFC");
  const t = truth.normalize("NFC");
  let want = 0;
  let got = 0;
  for (const character of ACCENTED) {
    const inTruth = countOf(t, character);
    want += inTruth;
    got += Math.min(countOf(o, character), inTruth);
  }
  return want === 0 ? 1 : got / want;
}

/**
 * What separates the two halves of a confusion tally key. A NUL, because no character `norm` can
 * produce is one, so no pair of recognised characters can forge a key -- a space could, since a
 * space is exactly what a collapsed whitespace run becomes.
 *
 * Built from its code point rather than typed: a literal NUL in this file is the byte that made it
 * invisible to `grep` and `file(1)` once already. See `bytes.test.ts`.
 */
const CONFUSION_KEY_SEPARATOR = String.fromCharCode(0);

export interface Confusion {
  /** The character the truth has. */
  from: string;
  /** The single character the recogniser put there instead. */
  to: string;
  count: number;
}

/**
 * The most frequent single-character substitutions between a recognised body and its truth.
 *
 * Only substitutions of one character by one character are reported — never an insertion, a deletion
 * or a run — because the point is a table the owner can read ("backtick became apostrophe, three
 * times"), and because a pair of single characters is the smallest thing that can be said about a
 * misread without quoting the screen. Ties are broken by the pair itself so two runs of the same
 * data produce the same list.
 *
 * The alignment is the Levenshtein edit path, walked backwards through the full matrix. The strings
 * are one staged page each (hundreds of characters), so the matrix is small; this is not on any hot
 * path — it runs for a case that already failed.
 */
export function confusions(ocrBody: string, truth: string, max: number = CONFUSIONS_MAX): Confusion[] {
  const o = [...norm(ocrBody)];
  const t = [...norm(truth)];
  // rows: the truth, columns: what was recognised. cost[i][j] = distance between the first i of the
  // truth and the first j of the read.
  const cost: number[][] = [];
  for (let i = 0; i <= t.length; i += 1) {
    const row = new Array<number>(o.length + 1);
    row[0] = i;
    cost.push(row);
  }
  const first = cost[0] as number[];
  for (let j = 0; j <= o.length; j += 1) first[j] = j;
  for (let i = 1; i <= t.length; i += 1) {
    const row = cost[i] as number[];
    const above = cost[i - 1] as number[];
    for (let j = 1; j <= o.length; j += 1) {
      const same = t[i - 1] === o[j - 1];
      row[j] = Math.min((above[j] as number) + 1, (row[j - 1] as number) + 1, (above[j - 1] as number) + (same ? 0 : 1));
    }
  }

  const tally = new Map<string, number>();
  let i = t.length;
  let j = o.length;
  while (i > 0 && j > 0) {
    const here = (cost[i] as number[])[j] as number;
    const diagonal = (cost[i - 1] as number[])[j - 1] as number;
    const same = t[i - 1] === o[j - 1];
    if (here === diagonal + (same ? 0 : 1)) {
      if (!same) {
        const key = `${t[i - 1] as string}${CONFUSION_KEY_SEPARATOR}${o[j - 1] as string}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      i -= 1;
      j -= 1;
      continue;
    }
    if (here === ((cost[i - 1] as number[])[j] as number) + 1) { i -= 1; continue; }   // the truth had a character the read lost
    j -= 1;                                                                            // the read had one the truth does not
  }

  return [...tally.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(CONFUSION_KEY_SEPARATOR) as [string, string];
      return {from, to, count};
    })
    .sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .slice(0, max);
}
