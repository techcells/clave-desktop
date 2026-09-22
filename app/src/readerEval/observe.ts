/**
 * What an `observe` run is ASKED for, as values: the expected set, the host the URLs use, and the
 * rows the terminal side prints.
 *
 * It is a module of its own because the whole of finding O1 is that `observe` used to be asked for
 * nothing. The run of 2026-09-21 (ledger, "OBSERVE run #1") read ONE normal Safari page of the twenty
 * it printed and reported `READER_EVAL ACCEPTED`: every rule in `summariseObserve` was satisfied,
 * because every rule was about the rows that happened to arrive. A mode whose cases the OWNER stages
 * by hand cannot be judged on what arrived — it has to name what it wanted first, and then be held to
 * it. `--expect` is that name, and this file is the closed list of names, the table lookup from a name
 * to the cases it means, and the membership test the URL printing and the verdict both use, so all
 * three cannot drift apart.
 *
 * Nothing here opens, reads or writes anything: `main.ts` supplies the file writing, `run.ts` the
 * watching, `summary.ts` the verdict.
 */
import {OBSERVE_BROWSERS, OBSERVE_CASES, stagedTitleOf, type ObserveCase} from "./cases";
import {pageUrl} from "./stage";

/**
 * The sets `--expect` takes, derived from the case table rather than written out.
 *
 * Six names for two browsers: the browser alone (its ten cases, normal and private), and each half of
 * it. They are derived from `OBSERVE_BROWSERS` so that a third browser added to the table brings its
 * three set names with it and cannot be half-added — the list, the membership test below and the
 * usage text the owner reads all come from the same place.
 *
 * Why the halves exist at all: the two halves cost the owner different amounts of work. Five private
 * windows are five menu items and five pastes; the normal five are five pastes. The run of
 * 2026-09-21 ended with three private cases read and one never staged because the owner ran out of
 * session, and a run that cannot ask for "the private five, and tell me when you have them" is a run
 * that spends twenty minutes on twenty cases to measure five.
 */
export const OBSERVE_EXPECT_SETS: readonly string[] = OBSERVE_BROWSERS.flatMap((browser) =>
  [browser.slug, `${browser.slug}-normal`, `${browser.slug}-private`]
);

/** The two suffixes a half-set carries. Written once: the parser and the membership test share them. */
const NORMAL_SUFFIX = "-normal";
const PRIVATE_SUFFIX = "-private";

/**
 * Is this case one of the ones that set names?
 *
 * Decided on the case's own `app` and `expectPrivate` — the two fields the guard and the verdict use
 * — and never on its NAME. A name is a convenience for a reader; matching on it would make the set a
 * string rule over a string, and the one thing this harness must never do is decide what it read from
 * text rather than from the table it staged.
 */
export function inExpectSet(theCase: ObserveCase, set: string): boolean {
  const browser = OBSERVE_BROWSERS.find(
    (entry) => set === entry.slug || set === `${entry.slug}${NORMAL_SUFFIX}` || set === `${entry.slug}${PRIVATE_SUFFIX}`
  );
  if (browser === undefined || theCase.app !== browser.app) return false;
  if (set === `${browser.slug}${NORMAL_SUFFIX}`) return !theCase.expectPrivate;
  if (set === `${browser.slug}${PRIVATE_SUFFIX}`) return theCase.expectPrivate;
  return true;
}

/** The longest `--expect` this harness will look at: every set name, comma-separated, and room over. */
export const EXPECT_MAX_LENGTH = 200;

/**
 * `safari-private` or `safari-private,chrome-private`: one or more of the closed list, comma
 * separated, or `null` for anything else at all.
 *
 * Refused rather than narrowed, like the variant and the position: `--expect safari-privat` is a run
 * the owner believes is judging the private windows, and a harness that quietly judged something else
 * — or nothing — is the exact failure this option exists to end. Duplicates are refused as well,
 * because `safari,safari` is a command line somebody did not mean to write, and the sets a run was
 * judged on are written into the results file as the record of what was asked for.
 */
export function parseExpectSets(raw: string): string[] | null {
  if (raw.length === 0 || raw.length > EXPECT_MAX_LENGTH) return null;
  const parts = raw.split(",");
  const chosen: string[] = [];
  for (const part of parts) {
    if (!OBSERVE_EXPECT_SETS.includes(part)) return null;
    if (chosen.includes(part)) return null;
    chosen.push(part);
  }
  return chosen;
}

/**
 * The set names a run was asked for, beside the case names they mean.
 *
 * Both halves are kept because both are read by somebody: the NAMES go into the results file and the
 * terminal line, so a reader of either knows what the run was judging, and the CASES are what the
 * verdict counts against and what the run ends early on.
 */
export interface ObserveExpectation {
  /** Fixed codes from `OBSERVE_EXPECT_SETS`, in the order the owner wrote them. */
  sets: string[];
  /** The case names those sets resolve to, in table order, each one once. */
  cases: string[];
}

/** The expectation a run was given, or `null` for a run that was given none (an exploratory one). */
export function expectationOf(
  sets: readonly string[] | null,
  cases: readonly ObserveCase[] = OBSERVE_CASES
): ObserveExpectation | null {
  if (sets === null) return null;
  const names = cases.filter((theCase) => sets.some((set) => inExpectSet(theCase, set))).map((theCase) => theCase.name);
  return {sets: [...sets], cases: names};
}

/**
 * How many times one case's window is read before the run gives up on it, in `observe` mode.
 *
 * Finding O4: the private case `safari-private-chat-light-14` of run #2 came back `windowGone` — the
 * helper's own approved-window comparisons refused mid-read, which is what happens when the window
 * moves, the owner switches away, or a sheet opens over it in the fraction of a second between the
 * guard's approval and the capture. Nothing was read, and until this fix the case was CLOSED: the
 * run never looked at that window again although it stayed in front for another minute.
 *
 * So a failed read leaves the case open and the next poll tries again while the window is still
 * there. Bounded at three, because a window that fails three reads two seconds apart is not a window
 * that was merely moved, and an unbounded retry on a window the owner has left in front would spend
 * the whole run reading one case.
 */
export const OBSERVE_READ_ATTEMPTS_MAX = 3;

/**
 * Did this read deliver a toolbar strip at all?
 *
 * `private` is `null` exactly when the helper sent no `toolbarText` (`toolbarFacts` in `run.ts`), so
 * one field answers it. A read with no strip is a read in which the private-window rule was never
 * applied to anything: the product's own `hasPrivateToolbarMarker` was not called, because there was
 * nothing to call it on.
 */
export function noToolbarStrip(row: {outcome: string; private: boolean | null}): boolean {
  return row.outcome === "ok" && row.private === null;
}

/**
 * Did a read agree with the case it was filed under?
 *
 * ONLY for a read that succeeded. A read that failed showed nothing, so it agreed with nothing and
 * disagreed with nothing — which is finding O4 from the other side: run #2 printed "NOT AS EXPECTED:
 * private window would be KEPT" for a `windowGone` row, a sentence about a window that was never
 * read at all.
 *
 * The two directions treat a MISSING STRIP differently, and deliberately:
 *
 * - A PRIVATE case with no strip is not as expected. `private !== true`, not `private === false`: a
 *   badge that was never delivered is a badge that never skipped anything, so in the product that
 *   window's text crosses into the pipeline. It is a privacy finding, and the strongest one here.
 * - A NORMAL case with no strip is not as expected either, but for the opposite reason: nothing was
 *   checked. `private !== true` alone would call it a pass, so `--expect safari-normal` could be
 *   ACCEPTED over five reads in which the rule was never applied to anything — the run would have
 *   measured no strip and said the normal windows were fine (review, Minor 5). The core would not
 *   keep such a read either: with no strip it has no host to match an excluded site against.
 */
export function readAsExpected(row: {outcome: string; expectPrivate: boolean; private: boolean | null}): boolean {
  if (row.outcome !== "ok") return false;
  if (noToolbarStrip(row)) return false;
  return row.expectPrivate ? row.private === true : row.private !== true;
}

/**
 * The host the observe URLs are served under, and the one the harness looks for in the toolbar strip.
 *
 * `127.0.0.1` by default, which is what every observe run before 2026-09-21 used and what its numbers
 * are comparable with. Finding O5 is why it is an OPTION now: the bare IP was recognised in 3 of 8
 * Safari reads, and a bare IP is the hardest thing on the strip to read — four one-character labels
 * and three dots, where every real host the product's site exclusions act on is a word. Whether
 * Safari resolves a `*.localhost` name to the loopback address at all is not something this harness
 * may assume (Chrome does; Safari was never measured), so the option exists and the owner finds out
 * with one run instead of the harness betting a session on it. The page server answers any Host.
 */
export const DEFAULT_OBSERVE_HOST = "127.0.0.1";

/** One DNS label's worth of room over the longest name anybody would type here. */
export const OBSERVE_HOST_MAX = 63;

const LOCALHOST = "localhost";
const DOT_LOCALHOST = ".localhost";

/**
 * `--host`: lowercase letters, digits, dots and hyphens, at most `OBSERVE_HOST_MAX` characters, and
 * either the loopback address, the bare name `localhost`, or a name ending in `.localhost`.
 *
 * The closed grammar is the point. This string goes into a URL the OWNER pastes into a browser, and
 * a name that is not loopback is a name the browser resolves on the network — a run that quietly
 * pointed the owner's private window at somebody else's server would be this harness leaking the one
 * thing it exists to protect. `.localhost` is reserved for the loopback address by RFC 6761, so the
 * grammar is also the reason no packet leaves the machine.
 *
 * Counted by hand rather than matched with a regular expression, like every other check in this
 * harness: a character class in this repo's tooling has twice come back from the file-writing tools
 * as the raw byte it named (`bytes.test.ts`). Uppercase is refused rather than lowercased, because
 * the toolbar comparison squashes and lowercases both sides and a host that differs from the one in
 * the URL by its case would be a second thing to reason about for no gain.
 */
export function parseObserveHost(raw: string): string | null {
  if (raw.length === 0 || raw.length > OBSERVE_HOST_MAX) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const allowed =
      (code >= 97 && code <= 122) ||                                   // a-z
      (code >= 48 && code <= 57) ||                                    // 0-9
      code === 46 ||                                                   // .
      code === 45;                                                     // -
    if (!allowed) return null;
  }
  // Every label non-empty and neither starting nor ending in a hyphen: `a..b`, `-a.localhost` and
  // `a-.localhost` are all names no resolver takes, and this refuses them before a session is spent.
  for (const label of raw.split(".")) {
    if (label.length === 0) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  if (raw === DEFAULT_OBSERVE_HOST || raw === LOCALHOST) return raw;
  return raw.endsWith(DOT_LOCALHOST) ? raw : null;
}

/**
 * One line of the file the owner's terminal reads: which window to open, where, and whether this run
 * is being judged on it.
 *
 * `expected` is written by the side that knows — the bundle validated `--expect` and owns the case
 * table — so the terminal half filters on a boolean rather than re-deriving set membership from a
 * case name. One rule, in one place; see `inExpectSet`.
 */
export interface ObserveUrlRow {
  case: string;
  app: string;
  expectPrivate: boolean;
  expected: boolean;
  url: string;
}

/**
 * The whole `observe-urls-<nonce>.json` file, as a value.
 *
 * The nonce is IN THE NAME as well as in the file, and that is finding O3: the terminal side used to
 * wait for a file with a FIXED name, find the PREVIOUS run's already sitting there, and print
 * its URLs — an older nonce on an older port. The owner of run #1 would have pasted addresses this
 * run could never approve and watched twenty minutes of nothing. A name carrying the nonce cannot be
 * satisfied by another run's file, and the terminal side generates the nonce, so it knows the exact
 * name to wait for.
 */
export interface ObserveUrlsFile {
  schema: 2;
  port: number;
  nonce: string;
  host: string;
  /** The set names this run is judged on, or `null` for an exploratory run. */
  expect: string[] | null;
  urls: ObserveUrlRow[];
}

/** The file name for THIS run. The terminal half computes the same one from the nonce it minted. */
export function observeUrlsName(nonce: string): string {
  return `observe-urls-${nonce}.json`;
}

/** And the progress file's, beside it, in the same folder and under the same nonce. */
export function observeProgressName(nonce: string): string {
  return `observe-progress-${nonce}.json`;
}

/**
 * Every observe case as a row: the page URL carrying this run's staged title, the app the window must
 * be in, and whether the run is judged on it.
 *
 * The whole table is listed whatever the expectation is — an exploratory run prints all of it, and a
 * run with an expectation has the rest available to a reader of the file — and the terminal side is
 * what narrows the printing to `expected` rows.
 */
export function observeUrlsFile(
  options: {port: number; nonce: string; host: string; expect: readonly string[] | null},
  cases: readonly ObserveCase[] = OBSERVE_CASES
): ObserveUrlsFile {
  const {port, nonce, host, expect} = options;
  return {
    schema: 2,
    port,
    nonce,
    host,
    expect: expect === null ? null : [...expect],
    urls: cases.map((theCase): ObserveUrlRow => ({
      case: theCase.name,
      app: theCase.app,
      expectPrivate: theCase.expectPrivate,
      expected: expect !== null && expect.some((set) => inExpectSet(theCase, set)),
      url: pageUrl({
        host,
        port,
        page: theCase.page,
        theme: theCase.theme,
        sizePx: theCase.sizePx,
        stagedTitle: stagedTitleOf(theCase.name, nonce)
      })
    }))
  };
}

/**
 * ============================================================================================
 * The reveal channel: the ONE place in this harness where recognised text is shown to a human.
 * ============================================================================================
 *
 * Everything else here is built on the opposite rule — the results file and the progress file are
 * allow-lists of numbers, booleans, case names and fixed codes, written out by hand, and
 * `results.test.ts` drives a whole run of sentinels through them to prove nothing else gets in.
 * This is a deliberate, bounded exception, and it exists because of a measurement numbers cannot
 * settle.
 *
 * **What was measured (real screen, Safari 27, 2026-09-21).** The host `127.0.0.1` is plainly in
 * Safari's address field, and on three page kinds — `chat-light-14`, `chat-dark-11`, `pt-dark-11` —
 * the recognised strip holds nothing resembling it: `hostDistance` 8-9, deterministically, on the
 * same pages every time. Those three are the pages where Safari draws a TRANSLATE glyph beside the
 * host. A distance of 8 says "the host is not on this strip"; it cannot say whether Vision returned
 * the address with the glyph's characters spliced into it, returned a different line of the toolbar
 * entirely, or returned nothing for that region. Those need different repairs, and the only way to
 * choose is to look at what came back.
 *
 * **Why it is safe to look at.** Nothing is ever read but a window the guard approved: exact app,
 * plus a title carrying this case's short staged title and THIS run's nonce (`guard.ts`), and the
 * helper re-checks the same window before it captures. So a revealed strip is always the strip of a
 * window this harness staged, at a URL it minted, showing a page it wrote.
 *
 * **What it can still contain.** The toolbar band of the owner's own browser window. If he staged
 * the page in a window that has OTHER TABS, their titles are in that band and will be revealed. The
 * usage text tells him to use a single-tab window, and the flag is refused outside an exploratory
 * `observe` run so it can never be on during a run that means anything.
 *
 * **Since 2026-09-21 it is also allowed in `toolbar --not-secure`** (owner decision "A"; the fence is
 * `mayReveal` in `config.ts`). That run can never be accepted either, and what it can reveal is
 * narrower still: the band of a window THIS HARNESS opened, in its own throw-away Chrome profile,
 * with one tab, on a page it wrote at an address it minted. Everything below — the shaping, the
 * caps, the character filter, the file of its own, its mode, the liveness gate — is the same code
 * on the same path; `runToolbarCase` in `run.ts` adds a third lock (the variant itself) to the two
 * `runObserve` has. An ORDINARY toolbar or accuracy run still cannot reveal anything.
 *
 * **What is never revealed:** the page body (`text`), any line below the toolbar band, and any
 * window title. Capped, control characters replaced, and carried to the terminal in a file of its
 * own that the terminal prints and deletes — it is never in the results file or the progress file.
 */

/** At most this many toolbar lines per case. The measured Safari band holds two or three. */
export const REVEAL_LINES_MAX = 8;

/** And at most this many characters each. Measured strips were 15-96 characters long. */
export const REVEAL_LINE_MAX = 120;

/** What an unsafe character becomes. A terminal is the one place a raw control byte must not land. */
export const REVEAL_REPLACEMENT = "?";

/**
 * The code points a revealed string may not contain, as RANGES built from numbers.
 *
 * Numbers rather than literal characters, and a table rather than a regular expression, for the rule
 * the whole harness lives under (`bytes.test.ts`): a character class written out has twice come back
 * from this repo's file-writing tools as the raw byte it named, and several of the code points below
 * are invisible ones that no review would catch.
 *
 * Four groups, and each is here for a reason the reviewer probed with an actual string:
 *
 * - **C0 and DEL** (0x00-0x1f, 0x7f). ESC is in here, which is what makes an ANSI escape sequence
 *   impossible to assemble out of recognised text.
 * - **C1** (0x80-0x9f). U+009B is the EIGHT-BIT CSI: xterm in UTF-8 mode decodes it as a control
 *   introducer, so `U+009B` + `[2J` is a screen-clear that the 7-bit filter alone lets through.
 * - **Bidi controls** (U+061C, U+200E-U+200F, U+202A-U+202E, U+2066-U+2069). These do not execute
 *   anything; they make the line RENDER in a different order from the characters it holds. The whole
 *   point of this channel is the owner reading a strip to decide what Vision returned, and a line
 *   that reads backwards is a line that sends the repair the wrong way.
 * - **Zero-width and separators** (U+200B-U+200D, U+2060, U+FEFF, U+2028-U+2029). Characters that
 *   are there and cannot be seen, and two that break a line in the middle of a `REVEAL` row.
 *
 * U+2028/U+2029 sit inside the `0x2028-0x202e` range below together with the bidi embeddings, which
 * is why that range is written as one.
 */
const REVEAL_UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],   // C0
  [0x007f, 0x009f],   // DEL and C1, U+009B (8-bit CSI) among them
  [0x061c, 0x061c],   // ARABIC LETTER MARK
  [0x200b, 0x200f],   // zero-width space/non-joiner/joiner, LRM, RLM
  [0x2028, 0x202e],   // line and paragraph separators, and the bidi embeddings and overrides
  [0x2060, 0x2060],   // WORD JOINER
  [0x2066, 0x2069],   // the bidi isolates
  [0xfeff, 0xfeff]    // ZERO WIDTH NO-BREAK SPACE
];

/**
 * May this code point be printed?
 *
 * Exported because the terminal half keeps the same table (it cannot import this module) and a test
 * holds the two to the same answer on every boundary of every range above.
 */
export function revealUnsafeCodePoint(code: number): boolean {
  return REVEAL_UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/**
 * One revealed string: unsafe characters replaced, then cut to `max` CODE POINTS.
 *
 * Code points rather than UTF-16 units, so the cut cannot split an astral character and put half of
 * one on the owner's terminal. The original length is reported beside the text as a number — also in
 * code points (`revealLength`), so the two agree.
 */
export function revealSafe(value: string, max: number = REVEAL_LINE_MAX): string {
  return [...value]
    .map((character) => (revealUnsafeCodePoint(character.codePointAt(0) ?? 0) ? REVEAL_REPLACEMENT : character))
    .slice(0, max)
    .join("");
}

/**
 * How long a revealed string was BEFORE the cut, in the unit the cut counts.
 *
 * `String.prototype.length` counts UTF-16 units, so a strip of 120 astral characters is not
 * truncated at all and would have reported `[240]` — the number that exists to make a truncation
 * visible saying the opposite of the truth (review, Minor 2).
 */
export function revealLength(value: string): number {
  return [...value].length;
}

/** One toolbar line, as it is shown: the text and the box it was recognised in. */
export interface ObserveRevealLine {
  text: string;
  /** The length BEFORE truncation, so a cut line says so in a number. */
  length: number;
  topPx: number;
  bottomPx: number;
  leftPx: number;
  rightPx: number;
}

export interface ObserveRevealRow {
  case: string;
  bandPx: number | null;
  /** The assembled strip the `host` boolean and `hostDistance` were computed from. */
  toolbarText: string;
  toolbarTextLength: number;
  lines: ObserveRevealLine[];
  /** How many lines were inside the band before `REVEAL_LINES_MAX` cut the list. */
  linesInBand: number;
}

export interface ObserveRevealFile {
  schema: 1;
  nonce: string;
  rows: ObserveRevealRow[];
}

/** This run's reveal file, beside the other two and under the same nonce. */
export function observeRevealName(nonce: string): string {
  return `observe-reveal-${nonce}.json`;
}

/**
 * The two siblings of the reveal file that can hold recognised text, and so belong in every list
 * that cleans it.
 *
 * - `.partial` is what an atomic write renames into place; a crash between the write and the rename
 *   leaves one holding a whole table of strips.
 * - `.claimed` is where the TERMINAL moves the file before printing from it — the rename that stops
 *   a mid-sweep write from being deleted unread. A throw between that rename and the unlink (an
 *   EPIPE on the print when the window is closed is the plausible one) leaves it behind.
 *
 * Both begin `observe-reveal-`, so the orphan sweep already catches them by prefix; they are named
 * here so that the lists which work by NAME catch them too (re-review, Minor A).
 */
export const REVEAL_PARTIAL_SUFFIX = ".partial";
export const REVEAL_CLAIMED_SUFFIX = ".claimed";

/** Every name under which this run's strips can be on disk, the final file first. */
export function revealFileNames(nonce: string): string[] {
  const file = observeRevealName(nonce);
  return [file, `${file}${REVEAL_PARTIAL_SUFFIX}`, `${file}${REVEAL_CLAIMED_SUFFIX}`];
}

/**
 * The mode the one file that carries screen text is created with: the owner, and nobody else.
 *
 * It lives beside the function that USES it, and that function is production code a test can run —
 * see `writeRevealFile`. A constant a test only reads is a constant a call site can stop passing
 * with nothing failing, which is exactly what the re-review's X12 probe showed.
 */
export const REVEAL_FILE_MODE = 0o600;

/** The two filesystem calls the reveal writer needs. `main.ts` passes `node:fs`; a test passes it too. */
export interface RevealWriteIo {
  writeFile(path: string, contents: string, options: {mode: number}): void;
  rename(from: string, to: string): void;
}

/**
 * Write the reveal file: privately, and atomically.
 *
 * **Production code that a test can run**, which is the whole point of its shape. The mode is chosen
 * HERE, not by the caller, so a test that hands this function the real `node:fs` and then reads the
 * mode off the resulting file is asserting the mode the bundle actually writes with — not one the
 * test supplied itself. The arrangement before this pinned only the constant's declaration, and
 * dropping it from the call site left every test green (re-review, Minor B).
 *
 * Atomic for the reason every other file here is: the terminal polls this path once a second and
 * must never read half a table.
 */
export function writeRevealFile(path: string, contents: string, io: RevealWriteIo): void {
  const temporary = `${path}${REVEAL_PARTIAL_SUFFIX}`;
  io.writeFile(temporary, contents, {mode: REVEAL_FILE_MODE});
  io.rename(temporary, path);
}

/**
 * One case's revealed strip, from the pieces `run.ts` already extracted.
 *
 * **Only lines INSIDE the band.** `bandPx` is how far down the capture the helper judged the
 * toolbar to reach, and a line below it is page content — the thing this channel must never show.
 * A read with no band at all reveals no lines: "which of these are toolbar lines" has no answer
 * then, and the safe answer is none. The assembled strip is still shown, because the helper builds
 * it from the band itself.
 */
export function revealRowOf(options: {
  case: string;
  toolbarText: string | null;
  lines: readonly {text: string; topPx: number; bottomPx: number; leftPx: number; rightPx: number}[];
  bandPx: number | null;
}): ObserveRevealRow {
  const {bandPx} = options;
  const inBand = bandPx === null ? [] : options.lines.filter((line) => line.bottomPx <= bandPx);
  const toolbarText = options.toolbarText ?? "";
  return {
    case: options.case,
    bandPx,
    toolbarText: revealSafe(toolbarText),
    toolbarTextLength: revealLength(toolbarText),
    linesInBand: inBand.length,
    lines: inBand.slice(0, REVEAL_LINES_MAX).map((line): ObserveRevealLine => ({
      text: revealSafe(line.text),
      length: revealLength(line.text),
      topPx: line.topPx,
      bottomPx: line.bottomPx,
      leftPx: line.leftPx,
      rightPx: line.rightPx
    }))
  };
}

/**
 * The reveal file, written out by hand — for the same reason `serialiseResults` is, turned around.
 *
 * It lives HERE rather than in `results.ts` on purpose: that file's whole claim is that nothing it
 * writes was ever on a screen, and a serialiser for recognised text sitting beside it would make
 * that claim something a reader has to check function by function. This one admits exactly six
 * fields per row and six per line, each rebuilt by name, so the only text that can reach the file is
 * the text `revealRowOf` already capped and cleaned.
 */
export function serialiseObserveReveal(file: ObserveRevealFile): string {
  return JSON.stringify({
    schema: 1,
    nonce: file.nonce,
    rows: file.rows.map((row) => ({
      case: row.case,
      bandPx: row.bandPx,
      toolbarText: row.toolbarText,
      toolbarTextLength: row.toolbarTextLength,
      linesInBand: row.linesInBand,
      lines: row.lines.map((line) => ({
        text: line.text,
        length: line.length,
        topPx: line.topPx,
        bottomPx: line.bottomPx,
        leftPx: line.leftPx,
        rightPx: line.rightPx
      }))
    }))
  }, null, 2);
}

/**
 * ---------------------------------------------------------------------------------------------
 * The liveness gate: the bundle reveals only while the terminal that asked for it is still there.
 * ---------------------------------------------------------------------------------------------
 *
 * **The failure this closes.** The terminal launches the bundle with `open -n -W`, so the bundle is
 * started by LaunchServices and is NOT in the terminal's process group. Ctrl-C therefore kills the
 * terminal and leaves the bundle reading windows for the rest of `--seconds` — rewriting a file of
 * recognised text with nobody left to print it or delete it. The terminal's own signal handlers
 * (`reader-eval.mjs`) close the half they can reach; this closes the half they cannot.
 *
 * **The signal needs no new channel.** The terminal rewrites a small file, `observe-alive-<nonce>`,
 * every time it polls — once a second — and the bundle asks how old it is before every write. Fresh
 * (at most `REVEAL_HEARTBEAT_MAX_AGE_MS`) means somebody is there to print and delete; anything else
 * means the terminal is gone, and the bundle then deletes the file and STOPS REVEALING for the rest
 * of the run. It does not resume: a terminal that died was not the one that asked.
 *
 * Both sides are the same folder and the same nonce, so there is nothing to agree on beyond a name.
 */

/** How often the terminal rewrites its heartbeat: every poll of the watch. */
export const REVEAL_HEARTBEAT_MS = 1_000;

/**
 * How old the heartbeat may be and still count as alive: five beats.
 *
 * Generous on purpose. A terminal is a process competing with a browser, a helper and a recogniser
 * for a laptop, and the cost of calling a live terminal dead is that the owner loses the diagnosis
 * he is sitting there for. The cost of the opposite — five seconds of a file existing after the
 * terminal died — is bounded by the same check at the next write, by the bundle's own end of run,
 * and by the next run's orphan sweep.
 */
export const REVEAL_HEARTBEAT_MAX_AGE_MS = 5_000;

/** The heartbeat file for this run, beside the other three and under the same nonce. */
export function observeAliveName(nonce: string): string {
  return `observe-alive-${nonce}`;
}

/**
 * Is the terminal still there?
 *
 * `null` — no heartbeat file at all — is NOT fresh: a bundle that cannot see a terminal must not
 * write recognised text on the chance that one exists. A NEGATIVE age is fresh: a wall clock that
 * stepped between the write and the read can put a file's mtime in the future, and "the file was
 * written after now" is not a reason to call the terminal dead.
 */
export function heartbeatFresh(ageMs: number | null, maxAgeMs: number = REVEAL_HEARTBEAT_MAX_AGE_MS): boolean {
  return ageMs !== null && ageMs <= maxAgeMs;
}

/** What the gate needs from the machine. `main.ts` supplies three lines of `fs`; a test supplies none. */
export interface RevealGateDeps {
  /** How old the terminal's heartbeat file is, in milliseconds, or `null` when it is not there. */
  heartbeatAgeMs(): number | null;
  /** Write the reveal file, atomically and privately. */
  write(contents: string): void;
  /** Remove the reveal file and its `.partial` sibling. */
  remove(): void;
}

export interface RevealGate {
  /** Called after every successful read, with the whole cumulative table. */
  reveal(rows: readonly ObserveRevealRow[]): void;
  /** Called once, however the run ended. */
  end(): void;
  /** Has the gate stopped for good? For the doc's sake and for the tests; nothing branches on it. */
  stopped(): boolean;
}

/**
 * The gate. Every decision about whether recognised text exists on disk is in this function.
 *
 * `end()` deserves its own sentence, because it is the one place two instructions pull opposite ways:
 * the bundle should delete its own file when the run ends, AND the last case's strip must not be
 * dropped — it is written moments before the bundle quits and the terminal's final sweep reads it
 * after. Both are satisfied by asking the same question again: if the heartbeat is stale the terminal
 * is gone, nobody will ever print that file, and it is deleted; if the heartbeat is fresh the
 * terminal is alive and will claim it within one poll, so it is left for exactly that. Nothing is
 * orphaned either way — a terminal that dies in that one-poll window is caught by its own signal
 * handlers, and failing those by the next run's orphan sweep.
 */
export function createRevealGate(nonce: string, deps: RevealGateDeps): RevealGate {
  let stopped = false;
  const alive = (): boolean => heartbeatFresh(deps.heartbeatAgeMs());
  return {
    reveal: (rows) => {
      if (stopped) return;
      if (!alive()) {
        // The terminal that asked for this is gone. Take the text off the disk and do not write
        // again for the rest of the run.
        stopped = true;
        deps.remove();
        return;
      }
      deps.write(serialiseObserveReveal({schema: 1, nonce, rows: [...rows]}));
    },
    end: () => {
      if (stopped) return;
      if (!alive()) {
        stopped = true;
        deps.remove();
      }
    },
    stopped: () => stopped
  };
}
