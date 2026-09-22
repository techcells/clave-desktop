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

/**
 * `toolbar.py`'s own squash, character for character the one `hostInToolbar` uses in `run.ts`:
 * lowercased, every run of whitespace removed.
 *
 * Written out here rather than imported from `run.ts` because `run.ts` imports THIS file, and copied
 * rather than made the single definition because `hostInToolbar`'s rule is a measured one — the
 * `host` boolean of every run so far was produced by it, and widening it (this file's `norm` folds
 * four ASCII separators that `\p{White_Space}` does not) would quietly change what those numbers
 * mean. The distance below and the boolean must be two measurements of ONE string, so the class is
 * the same class; `score.test.ts` holds the two functions to the same answer on the same pair.
 */
const HOST_WHITESPACE_RUN = new RegExp("\\p{White_Space}+", "gu");

const squashed = (value: string): string => value.toLowerCase().replace(HOST_WHITESPACE_RUN, "");

/**
 * The largest distance this function will report. A number, bounded, so a pathological strip cannot
 * put an arbitrary magnitude in the results file; and large enough that every distance below it is a
 * real comparison (the longest host in any table here is 24 characters).
 */
export const HOST_DISTANCE_MAX = 64;

/**
 * How much of the toolbar strip is scanned. Measured: the observe run of 2026-09-21 reported
 * `toolbarTextLength` 15-26 on normal Safari windows and 50-96 on private ones, so 1024 is ten times
 * the longest strip anybody has seen out of this helper. It is a bound on the work, not a rule about
 * hosts: the scan is O(strip x host squared), and a helper that one day returned a whole page as its
 * strip would otherwise spend the owner's session in this loop.
 */
export const HOST_STRIP_SCAN_MAX = 1024;

/** The high half of a surrogate pair: the two code units an astral character is stored as. */
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/**
 * The part of the strip that is scanned: the first `HOST_STRIP_SCAN_MAX` characters, and never half
 * of one.
 *
 * `slice` counts UTF-16 units, so a cut landing between the two halves of an astral character would
 * leave a lone high surrogate at the end — `lev` spreads to code points and would compare it as a
 * character of its own. Bounded and harmless either way, but it would perturb a distance for a
 * reason that has nothing to do with the host, so the dangling half is dropped (review, Minor 4).
 *
 * **Exported because it cannot be observed through `hostDistance`.** A lone surrogate scores exactly
 * as any other one-character mismatch does, and every host in this harness is ASCII, so no pair of
 * strips can be built whose distances differ by this alone — which means a test written through the
 * public function would pass whether the half is dropped or kept. The property is about the string
 * this function returns, so that is what `score.test.ts` asserts.
 */
export function scannedStrip(strip: string): string {
  if (strip.length <= HOST_STRIP_SCAN_MAX) return strip;
  const cut = strip.slice(0, HOST_STRIP_SCAN_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? cut.slice(0, -1) : cut;
}

/**
 * How far the toolbar strip is from carrying the expected host — a NUMBER where `host` is a boolean.
 *
 * Finding O5, and it is the only reason this exists. The observe run of 2026-09-21 recognised the
 * address host in 3 of 8 Safari reads and the results file could not say which of two very different
 * things had happened: the host line was not on the strip at all (Safari had not drawn it, or the
 * helper's band missed it), or it was there and one character came back wrong. Those need opposite
 * repairs, and the product's own site exclusions turn on exactly this — a host the reader cannot find
 * is an excluded site KEPT — so "0 of 8" and "8 of 8 off by one" are not the same finding.
 *
 * The measurement: the smallest Levenshtein distance between the squashed host and any window of the
 * squashed strip whose length is within two of the host's. Within two, because a distance is only
 * interesting here when it is small, and a window that differs in length by more than two cannot be
 * closer than two anyway — while unbounded windows would make the answer "the strip is long" rather
 * than "the host is nearly there". 0 means present (and `hostInToolbar` is true for the same pair);
 * 1 or 2 is a misread of a character or two, which for `127.0.0.1` is the `l`-for-`1` and the dropped
 * dot the phase-0 confusion tables are full of; a large one is a strip with no host on it.
 *
 * `null` is "there was nothing to measure": no strip at all, an empty strip, or an empty host. It is
 * deliberately NOT a large number — a strip that was never delivered is not a strip in which the host
 * was far away.
 *
 * Nothing recognised is kept. It takes the strip, walks it, and answers with one bounded integer.
 */
export function hostDistance(toolbarText: string | null, host: string): number | null {
  if (toolbarText === null) return null;
  const strip = scannedStrip(squashed(toolbarText));
  const needle = squashed(host);
  if (strip.length === 0 || needle.length === 0) return null;
  const shortest = Math.max(1, needle.length - 2);
  const longest = needle.length + 2;
  let best = HOST_DISTANCE_MAX;
  for (let width = shortest; width <= longest; width += 1) {
    for (let start = 0; start + width <= strip.length; start += 1) {
      const distance = lev(needle, strip.slice(start, start + width));
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return Math.min(best, HOST_DISTANCE_MAX);
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
