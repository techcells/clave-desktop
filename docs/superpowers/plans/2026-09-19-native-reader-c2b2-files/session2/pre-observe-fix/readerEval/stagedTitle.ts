/**
 * The name the harness gives a window it staged, and the only name it will ever read.
 *
 * This is the privacy design in one string. The harness may capture a window only when the window
 * server reports that window's title contains a title built here, for THIS case and THIS run — so a
 * window the harness did not stage cannot be read even by accident, and a window staged by an
 * earlier run cannot be mistaken for this one. The nonce is what makes the second half true: an
 * abandoned Chrome window from a run ten minutes ago carries a different one.
 *
 * The prefix is also the rule a served page checks before it will put a title into `document.title`
 * at a visitor's request (`pages.ts`): a page that would set any title asked of it is a page that
 * could be told to impersonate somebody's real window.
 */
export const STAGED_TITLE_PREFIX = "CLAVE-EVAL ";

/** `CLAVE-EVAL <case name> <run nonce>`. */
export function stagedTitleFor(caseName: string, nonce: string): string {
  return `${STAGED_TITLE_PREFIX}${caseName} ${nonce}`;
}

/**
 * The READY token: the staged window says, in its own title, that it has finished printing.
 *
 * The first run against a screen (2026-09-20) recorded both Terminal cases as `noMarkers` with a
 * read that worked — `recogniseMs` 160 and 107, so text WAS recognised — and the guard had approved
 * the window, because the staged shell sets its title BEFORE it prints anything. So "the right
 * window is in front" and "the text is on it" were the same question, answered by the same title,
 * and the read could legitimately land on an empty window. This separates them: the title carries
 * the case and the nonce from the start, and gains this token only after ENDMARKER has been printed.
 *
 * It is NOT a loosening of the guard. The staged title for the case — exact app, this case's name,
 * this run's nonce — is still matched exactly as before, and this is an ADDITIONAL substring
 * demanded of a case that asks for it: `CLAVE-EVAL <case> <nonce> READY`. Another case's ready
 * title, or another run's, does not contain this case's staged title, so it can never be approved
 * here; `guard.test.ts` holds both directions.
 *
 * The leading space is part of the token so that the whole thing is one substring test: a title that
 * merely ends in a word starting with `READY…` cannot satisfy it without the separator the harness
 * itself printed.
 */
export const READY_TOKEN = " READY";

/**
 * What must follow the token: a space, and then something.
 *
 * Without it `READY` is a PREFIX test, and a title reading `<staged title> READYING` satisfies it
 * (review B, Minor 2). Only this harness's own shell writes the token today, so that was harmless —
 * but "harmless because nobody else writes it" is the argument the whole of `stagedTitle.ts` exists
 * to avoid making. The grammar is `<staged title> READY <something>`, and the shell always prints
 * the size after the token, so the separator is never the thing that keeps a real staging out.
 */
export const READY_SEPARATOR = " ";

/** `CLAVE-EVAL <case name> <run nonce> READY`; what a finished staged window's title contains. */
export function readyTitleFor(caseName: string, nonce: string): string {
  return `${stagedTitleFor(caseName, nonce)}${READY_TOKEN}`;
}

/**
 * The exact substring the guard demands of a case that waits for READY, built from THAT case's
 * staged title.
 *
 * Anchored on the left by the staged title — which carries the case name and this run's nonce — and
 * on the right by the separator. Both anchors are the point: `includes(READY_TOKEN)` alone would be
 * satisfied by a title that carries this case's staged title and a READY belonging to something
 * else (review B, Important 4), and `guard.test.ts` now holds exactly that title.
 */
export function readyMark(stagedTitle: string): string {
  return `${stagedTitle}${READY_TOKEN}${READY_SEPARATOR}`;
}

/**
 * What a finished TERMINAL window adds after the READY token: the size the shell actually got, in
 * cells, as the shell itself measured it (`tput cols` x `tput lines`).
 *
 * This is how `sizeAsStaged` is answered for a Terminal window without anybody looking at a screen.
 * There is no `--window-size` for Terminal and no point size to compare a capture against: the
 * harness asks for 140x40 or 72x40 with an xterm resize sequence, and whether Terminal honoured it
 * is exactly one of the things the first run could not tell (dev report section 6, unknown 4 — the
 * two terminal captures came back 1406x1754 px and 1426x880 px, which are not in the 140:72 ratio of
 * the two requests). The shell knows the answer; it puts two numbers in the title, which the harness
 * minted and matches as a substring. No title is ever recorded — only the boolean of this test.
 *
 * The guard does NOT demand it: a terminal staged at the wrong size is still read and still scored,
 * and it is the `sizeAsStaged: false` that makes the case incomplete. Demanding it would turn a size
 * we want measured into a window nobody ever read.
 */
export function readySizeToken(columns: number, rows: number): string {
  return `${READY_SEPARATOR}${columns}x${rows}${READY_SIZE_END}`;
}

/**
 * The closing sentinel of the size token.
 *
 * `includes(" 140x40")` is satisfied by a title ending ` 140x400` (review B, Minor 1): the left side
 * of the token is anchored by the staged title, the right side by nothing at all. A row count that
 * merely STARTS with the staged one would then read as "as staged". Implausible for rows — and it
 * stops being implausible the moment a Terminal profile appends its own text to the title, which is
 * an open unknown of this very sub-project (dev report section 6, unknown 5). One character closes
 * it; the shell prints it in the same `printf`.
 */
export const READY_SIZE_END = ".";

/**
 * The bounds on the two numbers the READY token carries: a terminal has at least one column and one
 * row, and no terminal window on this machine has a thousand of either.
 */
export const READY_SIZE_MIN = 1;
export const READY_SIZE_MAX = 1000;

/**
 * The size the staged shell reported, read back out of the window title.
 *
 * **This is the one place in the harness where a number is parsed out of a window title, and it is a
 * deliberate exception with a reason.** The first staged run against a screen (2026-09-21, after the
 * owner stopped his tiling window manager re-tiling eval windows) had both terminal cases come back
 * `sizeAsStaged: false` with captures that looked right — 1560 x 967 px for a 140 x 40 staging — and
 * nothing in the results said what the shell had actually reported, so nobody could tell a terminal
 * that ignored the resize from a `tput` that answered 80 x 24 down a pipe. A boolean was not enough;
 * the two numbers are.
 *
 * What makes the exception safe is that every part of the value is this harness's own:
 *
 * - the substring is located by `readyMark(stagedTitle)`, which carries THIS case's name and THIS
 *   run's nonce, so nothing outside a title we minted is ever looked at;
 * - it ends at `READY_SIZE_END`, so the reader cannot run on into whatever a Terminal profile
 *   appended;
 * - only digits are accepted, one `x` between them, and each number must be a whole number inside
 *   [`READY_SIZE_MIN`, `READY_SIZE_MAX`] — there is no path by which an arbitrary string, or an
 *   arbitrarily large number, becomes a value;
 * - the result is two `number | null`s, which is what the results file may hold. `results.test.ts`
 *   drives a terminal case whose title carries a sentinel and asserts the file holds neither the
 *   sentinel nor any other string.
 *
 * Both numbers or neither: a half-read token is not a size, and reporting one of the pair would
 * invite somebody to compare it with the staged cells.
 */
export function readySizeIn(title: string, stagedTitle: string): {columns: number | null; rows: number | null} {
  const none = {columns: null, rows: null};
  const mark = readyMark(stagedTitle);
  const at = title.indexOf(mark);
  if (at < 0) return none;
  const rest = title.slice(at + mark.length);
  const end = rest.indexOf(READY_SIZE_END);
  if (end < 0) return none;
  const parts = rest.slice(0, end).split("x");
  if (parts.length !== 2) return none;
  const columns = boundedCount(parts[0] as string);
  const rows = boundedCount(parts[1] as string);
  return columns === null || rows === null ? none : {columns, rows};
}

/**
 * Digits and nothing else, inside the bounds. Deliberately not `Number()` (which takes ` 3 `, `3.0`,
 * `-0`, `1e3`, `0x20` and `Infinity`) and deliberately not a regular expression: every character
 * class in this harness has been a place where the tooling turned an escape into a raw byte
 * (`bytes.test.ts`), and a digit check does not need one. The same rule `config.ts` applies to a
 * `--position` coordinate, held here for a value that arrives from a window title.
 */
function boundedCount(raw: string): number | null {
  if (raw.length === 0 || raw.length > 4) return null;
  // No leading zero on a longer count: `printf %s` of a shell variable never writes one, so `0072`
  // is not a number this harness printed — and recording it as `72` would put a value in the file
  // that differs character for character from what was on the title (review C, Minor 4).
  if (raw.length > 1 && raw.charCodeAt(0) === 48) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return null;                       // not one of 0-9
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= READY_SIZE_MIN && value <= READY_SIZE_MAX ? value : null;
}

/**
 * Is this a title this harness could have minted? Prefix only — the case name and the nonce are
 * checked by whoever knows which case is being staged, which is not the page.
 */
export function isStagedTitle(value: string): boolean {
  return value.startsWith(STAGED_TITLE_PREFIX) && value.length > STAGED_TITLE_PREFIX.length;
}
