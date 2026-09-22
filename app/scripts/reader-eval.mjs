// The terminal half of `reader:eval`, the staged-window evaluation.
// Run from the repo root:  pnpm --dir app reader:eval -- <mode> [options]
//
// The reading half is app/src/readerEval/ and runs INSIDE the granted development bundle
// (`~/Applications/Clave Agent Dev.app`), as dist/reader-eval.cjs, because macOS attributes screen
// access to the app bundle that started the helper: run from this terminal, the grant would be this
// terminal's and nothing measured would be true of the product. So this script only opens the bundle
// through LaunchServices with `open --env` (exactly as scripts/start-reader.mjs does), waits, reads
// the results file the bundle wrote, and prints it.
//
// The pure functions below are exported and unit-tested in scripts/reader-eval.test.ts (the same
// arrangement as dev-launcher.cjs / dev-launcher.test.ts: vitest's include already covers
// scripts/**/*.test.ts, and app/tsconfig.json's `include` is src/**/*.ts, so nothing in this folder
// is type-checked -- which is why everything below is plain, defensive JavaScript).
//
// Exit codes: 0 every acceptance check passed, 2 a shortfall, 1 a harness error (including being
// called wrong). Anything but 0 is a run the owner has to look at.

import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export const MODES = ["accuracy", "toolbar", "observe", "all", "coldstart"];

/** The modes that stage a table of cases, and so are the only ones `--limit` means anything for. */
export const LIMITED_MODES = ["accuracy", "toolbar", "all"];

/**
 * The modes that watch for windows the OWNER stages, and so the only ones `--expect` and `--host`
 * mean anything for. Mirrors `observesWindows` in `src/readerEval/config.ts`.
 */
export const OBSERVING_MODES = ["observe", "all"];

/**
 * The one ORDINARY mode `--reveal-toolbar` is allowed in. Not `all`: that run produces verdicts
 * somebody might act on, and a reveal run is a diagnostic session that can never be accepted. The
 * only other place it is allowed is `toolbar --not-secure`, which can never be accepted either —
 * see `NOT_SECURE_MODE` below and the fence in `parseEvalArgs`.
 */
export const REVEALING_MODE = "observe";

/**
 * `--not-secure` (owner decision "A", 2026-09-21): the one mode it is allowed in, the one value its
 * environment variable may hold, and the one reserved name the bundle then stages the toolbar pages
 * under. Mirrors `NOT_SECURE_ON` in `src/readerEval/config.ts` and `NOT_SECURE_HOST` in
 * `src/readerEval/stage.ts`, cross-checked in `reader-eval.notSecure.test.ts`.
 *
 * The name is here ONLY to be printed. It is never sent to the bundle — the flag has no value, and
 * `--host` keeps its loopback-only grammar, which refuses this very name.
 */
export const NOT_SECURE_MODE = "toolbar";
export const NOT_SECURE_ON = "1";
export const NOT_SECURE_HOST = "clave-eval.test";
export const VARIANTS = ["none", "bookmarks-bar"];

/**
 * The largest coordinate `--position` will take, in points. The same bound as
 * `src/readerEval/config.ts`'s `POSITION_MAX_PT`, and for the same reason: no screen is this large,
 * and a stray digit would stage every window off every display, turning a ten-minute session into a
 * run of `notStaged` that measured nothing. Refused here so the owner is told before a window opens.
 *
 * Declared above `USAGE`, which quotes it: these are plain top-level `const`s evaluated in order, so
 * a reference from above would be a `ReferenceError` the moment this module is imported.
 */
export const POSITION_MAX_PT = 20000;

/**
 * The smallest. Negative coordinates are how macOS addresses a display placed left of or above the
 * primary one, which is the arrangement `--position` exists for. Mirrors `POSITION_MIN_PT` in
 * `src/readerEval/config.ts`, for the reason the whole rule is in both places: the bundle must
 * refuse a bad position whatever started it, and the owner must be told here, before any window
 * opens.
 */
export const POSITION_MIN_PT = -20000;

/** The one value `CLAVE_EVAL_REVEAL_TOOLBAR` may hold. The same as `REVEAL_ON` in `config.ts`. */
export const REVEAL_ON = "1";

/** The largest `--limit`. The same bound as `LIMIT_MAX` in `src/readerEval/config.ts`. */
export const LIMIT_MAX = 1000;

/**
 * The sets `--expect` takes. The same six as `OBSERVE_EXPECT_SETS` in `src/readerEval/observe.ts`,
 * which derives them from the case table; kept here in the same way `MODES` and `VARIANTS` are, so
 * the owner is refused before a bundle opens, and cross-checked against the harness's own list in
 * `reader-eval.test.ts` so the two cannot drift.
 */
export const EXPECT_SETS = [
  "safari", "safari-normal", "safari-private",
  "chrome", "chrome-normal", "chrome-private"
];

/** The same bound as `OBSERVE_HOST_MAX`. */
export const HOST_MAX = 63;

/**
 * `--expect a,b`: one or more of `EXPECT_SETS`, comma separated, no repeats. `null` for anything
 * else, which the caller turns into a refusal.
 *
 * Refused here AND in the bundle, like the position and the limit, because this one decides what the
 * word ACCEPTED means for the run: an observe run with no readable expectation is exploratory and
 * can never pass, and an owner who typed `--expect safari-privat` must be told now rather than told
 * "exploratory" twenty minutes later.
 */
export function parseExpectArg(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  const chosen = [];
  for (const part of value.split(",")) {
    if (!EXPECT_SETS.includes(part)) return null;
    if (chosen.includes(part)) return null;
    chosen.push(part);
  }
  return chosen.join(",");
}

/**
 * `--host <name>`: lowercase letters, digits, dots and hyphens, at most `HOST_MAX` characters, and
 * either `127.0.0.1`, `localhost`, or a name ending in `.localhost`.
 *
 * The same closed grammar as `parseObserveHost` in `src/readerEval/observe.ts`, and the reason it is
 * closed is the same: this string goes into a URL the OWNER pastes into a browser, including a
 * private one, and a name outside the loopback reservation is a name his browser would resolve on
 * the network. Counted by hand, never a regular expression.
 */
export function parseHostArg(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > HOST_MAX) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 97 && code <= 122) ||                                 // a-z
      (code >= 48 && code <= 57) ||                                  // 0-9
      code === 46 ||                                                 // .
      code === 45;                                                   // -
    if (!allowed) return null;
  }
  for (const label of value.split(".")) {
    if (label.length === 0) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  if (value === "127.0.0.1" || value === "localhost") return value;
  return value.endsWith(".localhost") ? value : null;
}

export const USAGE = `usage: pnpm --dir app reader:eval -- <mode> [options]

  modes
    accuracy   the staged pages and the two terminals, scored (default)
    toolbar    40 Chrome stagings: address host and the private badge
    observe    windows the OWNER stages by hand (Safari and Chrome, normal and
               private/incognito); a window staged private that shows no private
               marker fails the run, and so does a normal one flagged private.
               Say --expect, or the run is EXPLORATORY and can never be accepted
    all        all three, in that order
    coldstart  the helper only: how long it takes to be ready and what it says
               about the Screen Recording permission. No window is opened and
               nothing is read. Not part of "all"; ask for it by name.

  options
    --repetitions <n>   reads per accuracy case (default 5)
    --seconds <n>       how long observe mode watches at the OUTSIDE (default
                        120). It ends as soon as every expected case has been
                        read, or has failed its reads three times, so --expect
                        is what makes a run short.
    --expect <sets>     which observe cases this run is judged on, comma
                        separated: ${EXPECT_SETS.slice(0, 3).join(" | ")}
                        ${EXPECT_SETS.slice(3).join(" | ")}
                        The run passes only if EVERY case of those sets was read
                        and agreed with its own name; one missing or failed case
                        makes it INCOMPLETE. WITHOUT it an observe run is
                        EXPLORATORY: every row is printed and it can never be
                        accepted, whatever it read. Only for observe and all.
    --not-secure        EXPLORATORY variant of toolbar: stage the same pages
                        under the reserved name ${NOT_SECURE_HOST} instead of the
                        *.localhost hosts, so Chrome draws its "Not secure"
                        label, and measure how the strip is then recognised.
                        The name is fixed in code and is in .test, which never
                        resolves on the network; ONLY this harness's own
                        throw-away Chrome profile is told to send it to
                        127.0.0.1, where the page server listens exactly as in
                        every other run. Such a run can never be accepted,
                        whatever it measures: it prints the usual counts,
                        addressLine n/N and host found n/N against that name,
                        and ends SHORTFALL with exit code 2. Only for toolbar,
                        and not with --host. The first run to make is
                        toolbar --not-secure --limit 4 --reveal-toolbar
    --reveal-toolbar    PRINT the recognised toolbar strip of each staged window
                        on this terminal. Only in observe mode WITHOUT --expect,
                        or in toolbar mode WITH --not-secure: either way a run
                        that reveals can never be accepted.
                        It shows the address strip and the toolbar lines inside
                        the band of windows THIS HARNESS staged and identified
                        by a one-run title -- never the page body, never a line
                        below the band, never a window title. Use a SINGLE-TAB
                        window: other tabs' titles are drawn in that same band
                        and would be printed with it. Nothing revealed is
                        written to the results file; it is printed once and the
                        file it travelled in is deleted. To stop a run early,
                        press Ctrl-C in the terminal that RUNS it: a signal sent
                        to a pnpm or sh wrapper never reaches this process.
    --host <name>       the host the observe URLs use, and the one the address
                        strip is searched for (default 127.0.0.1; lowercase
                        letters, digits, dots and hyphens, at most ${HOST_MAX}, and
                        either 127.0.0.1, localhost, or a name ending in
                        .localhost). A word host is the realistic case: a bare
                        IP is the hardest thing on the strip to read. Only for
                        observe and all.
    --variant <name>    ${VARIANTS.join(" | ")} (default none)
    --limit <n>         stage only the first n cases of this mode's part (1 to
                        ${LIMIT_MAX}). The toolbar cases are taken interleaved, so
                        --limit 4 is two normal windows and two incognito ones.
                        A limited run is NEVER an acceptance run: it ends
                        LIMITED with exit code 2 whatever it measured. Use it to
                        find out why a run is failing without sitting through it.
    --position <x>,<y>  top-left corner of every staged Chrome window, in points
                        (default 40,60; whole numbers between ${POSITION_MIN_PT} and
                        ${POSITION_MAX_PT} — a display left of or above the main one
                        has negative coordinates). Use it
                        to stage the run on another display. It does not move a
                        Terminal window.

  Nothing is read but a window this harness staged and identified by a one-run title.
`;

/**
 * `--position x,y`: two whole numbers of points, neither of them negative, canonicalised back to a
 * string for the environment variable. Anything else is `null`, which the caller turns into a
 * refusal.
 *
 * It is the same rule as `readEvalSettings`'s in `src/readerEval/config.ts`, deliberately kept in
 * both places: the bundle must refuse a bad position whatever started it (anything that can set an
 * environment variable can), and the owner must be told here, before a bundle is opened and windows
 * begin appearing on their screen. Neither `Number()` nor a regular expression: `Number` accepts
 * ` 3 `, `3.0`, `-0`, `1e3`, `0x20` and `Infinity`, and a character class in this repo's tooling has
 * twice come back as a raw control byte on disk.
 */
/** `--limit`: digits only, at least one and at most `LIMIT_MAX`. `null` for anything else. */
export function countArg(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4) return null;
  // No leading zero, as in `parseLimit`.
  if (value.length > 1 && value.charCodeAt(0) === 48) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return null;                       // not one of 0-9
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= LIMIT_MAX ? number : null;
}

export function parsePositionArg(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const numbers = [];
  for (const part of parts) {
    const negative = part.startsWith("-");
    const digits = negative ? part.slice(1) : part;
    if (digits.length === 0) return null;                          // "" and a lone "-"
    for (let index = 0; index < digits.length; index += 1) {
      const code = digits.charCodeAt(index);
      if (code < 48 || code > 57) return null;                     // not one of 0-9
    }
    const number = Number(digits) * (negative ? -1 : 1);
    if (!Number.isSafeInteger(number) || number > POSITION_MAX_PT || number < POSITION_MIN_PT) return null;
    numbers.push(number);
  }
  return `${numbers[0]},${numbers[1]}`;
}

/**
 * May this command line reveal? The terminal's copy of `mayReveal` in `src/readerEval/config.ts`,
 * exported so its whole truth table is walked by a test: inside `parseEvalArgs` the second line is
 * shielded by the `--not-secure` fence above it, and a condition nothing can reach is one nothing
 * can prove.
 */
export function mayRevealArgs(options) {
  return (options.mode === REVEALING_MODE && options.expect === null) ||
    (options.mode === NOT_SECURE_MODE && options.notSecure === true);
}

/**
 * The command line. Pure.
 *
 * `pnpm ... -- <mode>` hands this script a leading `--`, so that is dropped rather than mistaken for
 * the mode, exactly as the model gate's own parser does.
 *
 * `position` defaults to `null`, not to a pair of numbers: an ABSENT `CLAVE_EVAL_POSITION` is what
 * tells the bundle to use `DEFAULT_POSITION`, so the default corner is written down once, in
 * `cases.ts`, beside the window size it belongs to — and never copied into this file, where nothing
 * would notice the two drifting apart.
 */
export function parseEvalArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const options = {
    mode: "accuracy", repetitions: 5, seconds: 120, variant: "none", position: null, limit: null,
    // Both default to nothing rather than to a value, for the reason `position` does: an ABSENT
    // variable is what tells the bundle to use its own default, so the default host lives in
    // `observe.ts` beside the rule that validates it and is never copied into this file.
    expect: null, host: null, reveal: false,
    // A switch with no value: the name it switches on is the bundle's constant, never an input.
    notSecure: false
  };
  let index = 0;
  if (args.length > 0 && !args[0].startsWith("--")) {
    options.mode = args[0];
    index = 1;
  }
  for (; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--repetitions" || flag === "--seconds") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) return {ok: false, problem: flag};
      options[flag === "--repetitions" ? "repetitions" : "seconds"] = number;
      index += 1;
      continue;
    }
    if (flag === "--limit") {
      // The same rule as `parseLimit` in `src/readerEval/config.ts`, kept in both places because the
      // bundle must refuse a bad limit whatever started it and the owner must be told here first —
      // and hand-rolled rather than a regex, like every other digit check in this harness.
      const number = countArg(value);
      if (number === null) return {ok: false, problem: flag};
      options.limit = number;
      index += 1;
      continue;
    }
    if (flag === "--expect") {
      const sets = parseExpectArg(value);
      if (sets === null) return {ok: false, problem: flag};
      options.expect = sets;
      index += 1;
      continue;
    }
    if (flag === "--reveal-toolbar") {
      // A flag with no value: it takes no argument, so the index is not advanced.
      options.reveal = true;
      continue;
    }
    if (flag === "--not-secure") {
      // No value either, and that is the point: nothing typed after it can become a host name.
      options.notSecure = true;
      continue;
    }
    if (flag === "--host") {
      const host = parseHostArg(value);
      if (host === null) return {ok: false, problem: flag};
      options.host = host;
      index += 1;
      continue;
    }
    if (flag === "--variant") {
      if (!VARIANTS.includes(value)) return {ok: false, problem: flag};
      options.variant = value;
      index += 1;
      continue;
    }
    if (flag === "--position") {
      const position = parsePositionArg(value);
      if (position === null) return {ok: false, problem: flag};
      options.position = position;
      index += 1;
      continue;
    }
    return {ok: false, problem: flag};
  }
  if (!MODES.includes(options.mode)) return {ok: false, problem: options.mode};
  // `--limit` only where there is a table to cut: `observe` waits for the owner's own windows and
  // `coldstart` opens none, so a limit there would block the acceptance of a run it never touched.
  if (options.limit !== null && !LIMITED_MODES.includes(options.mode)) return {ok: false, problem: "--limit"};
  // And the two observe options only where there are owner-staged windows to expect or to address.
  // An option the run would silently ignore is one the owner believes took effect.
  if (options.expect !== null && !OBSERVING_MODES.includes(options.mode)) return {ok: false, problem: "--expect"};
  // `--not-secure`: toolbar only, and never beside `--host`. Checked BEFORE the `--host` rule so
  // the owner is told which of the two options to drop (`NOT_SECURE_NOT_APPLICABLE` in `config.ts`).
  if (options.notSecure && (options.mode !== NOT_SECURE_MODE || options.host !== null)) {
    return {ok: false, problem: "--not-secure"};
  }
  if (options.host !== null && !OBSERVING_MODES.includes(options.mode)) return {ok: false, problem: "--host"};
  // The reveal fence, the same one the bundle keeps (`mayReveal` / `REVEAL_NOT_APPLICABLE` in
  // `config.ts`): an `observe` run with no expectation, or a `toolbar --not-secure` run. Both are
  // EXPLORATORY and can never pass; every other staged run stays refused.
  if (options.reveal && !mayRevealArgs(options)) {
    return {ok: false, problem: "--reveal-toolbar"};
  }
  return {ok: true, ...options};
}

/**
 * The `open` arguments. Pure, and asserted in the tests, because this is the line that decides which
 * program gets the screen-recording grant and which entry point it loads.
 */
export function openArgs(bundle, env) {
  const args = ["-n", "-W", bundle];
  for (const [name, value] of Object.entries(env)) args.push("--env", `${name}=${value}`);
  return args;
}

export function evalEnv(options, outFile, nonce) {
  const env = {
    CLAVE_DEV_ENTRY: "reader-eval",
    CLAVE_EVAL_MODE: options.mode,
    CLAVE_EVAL_OUT: outFile,
    CLAVE_EVAL_NONCE: nonce,
    CLAVE_EVAL_REPETITIONS: String(options.repetitions),
    CLAVE_EVAL_SECONDS: String(options.seconds),
    CLAVE_EVAL_VARIANT: options.variant
  };
  // Set only when the owner asked for a short run; absent is the whole table.
  if (typeof options.limit === "number") env.CLAVE_EVAL_LIMIT = String(options.limit);
  // Absent is "expect nothing", which the bundle turns into an EXPLORATORY verdict — never a pass.
  // An EMPTY variable is a refusal there, not a default, so this must not pass one through.
  if (typeof options.expect === "string" && options.expect.length > 0) {
    env.CLAVE_EVAL_EXPECT = options.expect;
  }
  // Absent is the default host, which lives in `observe.ts` beside the grammar that validates it.
  if (typeof options.host === "string" && options.host.length > 0) {
    env.CLAVE_EVAL_HOST = options.host;
  }
  // Set ONLY when the owner asked to reveal, and only ever to the one value the bundle takes: it is
  // absent that means off, so a variable left over from an earlier shell cannot turn it on.
  if (options.reveal === true) env.CLAVE_EVAL_REVEAL_TOOLBAR = REVEAL_ON;
  // The same shape for `--not-secure`: the literal `true` only, the one value only, and NO host —
  // the reserved name is the bundle's constant and never travels through the environment.
  if (options.notSecure === true) env.CLAVE_EVAL_NOT_SECURE = NOT_SECURE_ON;
  // Set only when the owner asked for a position. Absent means "the default corner", which the
  // bundle takes from `DEFAULT_POSITION`; an EMPTY variable is a refusal there, not a default, so
  // this must not pass one through.
  if (typeof options.position === "string" && options.position.length > 0) {
    env.CLAVE_EVAL_POSITION = options.position;
  }
  return env;
}

/**
 * This run's two observe files, by name. The nonce is in the NAME, which is finding O3: the terminal
 * side used to wait for a file with a FIXED name, find the PREVIOUS run's already sitting
 * there and print its URLs — an old port under an old nonce, addresses this run could never approve,
 * and twenty minutes of the owner pasting them. This side mints the nonce, so it knows the exact
 * name to wait for, and the old fixed name is never read again by anything.
 *
 * The same two names as `observeUrlsName` / `observeProgressName` in `src/readerEval/observe.ts`.
 */
export function observeUrlsName(nonce) {
  return `observe-urls-${nonce}.json`;
}

export function observeProgressName(nonce) {
  return `observe-progress-${nonce}.json`;
}

/**
 * The reveal file (`--reveal-toolbar`). It carries the one thing every other file this harness
 * writes is built to exclude: recognised text, from the toolbar band of a window the guard approved.
 *
 * So it lives for as long as it takes to print it. The terminal deletes it the moment it has been
 * read, deletes it before the bundle starts, and deletes it again on the way out whatever happened
 * to the run — see `clearRevealFile`, `sweepReveal` and `withRevealCleanup`.
 */
export function observeRevealName(nonce) {
  return `observe-reveal-${nonce}.json`;
}

/** The heartbeat this side rewrites every poll, so the bundle knows somebody is still watching. */
export function observeAliveName(nonce) {
  return `observe-alive-${nonce}`;
}

/**
 * The half-written sibling `writeAtomic` renames into place on the bundle side.
 *
 * It has to be removed as well as the final file: a crash between the write and the rename leaves a
 * `.partial` holding recognised text, and nothing else in the system would ever clean it (review,
 * Minor 3).
 */
export function partialOf(name) {
  return `${name}.partial`;
}

/**
 * Where this side MOVES the reveal file before it prints from it.
 *
 * The rename is what stops a write landing mid-sweep from being deleted unread — and it is also a
 * name that can be left behind: a throw between the rename and the unlink (an EPIPE on the print
 * when the window is closed is the plausible one) leaves recognised text under it. It is in every
 * by-name cleanup list for that reason (re-review, Minor A). The orphan sweep already caught it by
 * prefix; the signal handlers and the `finally` did not.
 */
export function claimedOf(name) {
  return `${name}.claimed`;
}

/** Every name this run's strips can be on disk under, the final file first. */
export function revealFileNames(nonce) {
  const file = observeRevealName(nonce);
  return [file, partialOf(file), claimedOf(file)];
}

/**
 * Remove this run's reveal file, its `.partial` sibling and its heartbeat.
 *
 * Idempotent, never throws: it is called at start, on every path out, and from a signal handler.
 */
export function clearRevealFile(outDir, nonce) {
  for (const name of [...revealFileNames(nonce), observeAliveName(nonce)]) {
    try { rmSync(join(outDir, name), {force: true}); } catch { /* the out folder's problem */ }
  }
}

/** Every name that could hold a strip, whoever left it. */
export function isRevealOrphan(name) {
  return typeof name === "string" && (name.startsWith("observe-reveal-") || name.startsWith("observe-alive-"));
}

/**
 * Delete EVERY reveal file in the out folder, not only this run's.
 *
 * The case no in-process fix can reach: a terminal killed with SIGKILL, or a machine that lost
 * power, leaves a file of recognised text that this run's nonce-based cleanup will never name. So
 * the first thing a run does is sweep the folder — an orphan cannot outlive the next run, whatever
 * killed the run that made it. Never throws, and touches nothing but names it minted itself.
 */
export function sweepRevealOrphans(outDir, list = readdirSync, remove = rmSync) {
  let swept = 0;
  let names;
  try {
    names = list(outDir);
  } catch {
    return 0;                                        // no out folder yet: nothing to sweep
  }
  for (const name of names) {
    if (!isRevealOrphan(name)) continue;
    try { remove(join(outDir, name), {force: true}); swept += 1; } catch { /* the out folder's problem */ }
  }
  return swept;
}

/**
 * What a heartbeat holds: NOTHING.
 *
 * The bundle never reads this file's contents — only `statSync(...).mtimeMs` — so a heartbeat can
 * convey a timestamp and nothing else, whoever wrote it. Zero bytes is a stated property of the
 * channel, and this is the production function that makes it one: the contents and the mode are
 * chosen here, so a test that hands it the real `node:fs` is asserting what the terminal actually
 * writes rather than what the test wrote (re-review, Minor C).
 */
export const HEARTBEAT_CONTENTS = "";

export function writeHeartbeat(path, io) {
  io.writeFile(path, HEARTBEAT_CONTENTS, {mode: 0o600});
}

/** The signals a hands-on session actually ends with. */
export const REVEAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** What the shell reports for a run the owner interrupted. */
export const REVEAL_SIGNAL_EXIT = 130;

/**
 * Take the strips off the disk when the terminal is killed.
 *
 * The restructure that put the single `process.exit` outside `withRevealCleanup` rests on the fact
 * that `process.exit` does not run a `finally` — and Node's DEFAULT disposition for these three
 * signals is exactly that: terminate, no `finally`, nothing cleaned. Ctrl-C is the most likely way a
 * five-minute hands-on session ends, so it is the one path that most needs the handler.
 *
 * It closes only the half the terminal can reach. The bundle is started through `open -n -W` and is
 * not in this process group, so it survives the Ctrl-C — which is what the heartbeat in
 * `observe.ts` is for: once this process stops rewriting `observe-alive-<nonce>`, the bundle deletes
 * its reveal file and stops revealing for the rest of the run.
 *
 * `on` and `exit` are injected so the handler itself is a thing a test runs.
 */
export function installRevealSignalHandlers(outDir, nonce, io = {}) {
  const on = io.on ?? ((signal, handler) => { process.on(signal, handler); });
  const exit = io.exit ?? ((code) => { process.exit(code); });
  const clear = io.clear ?? clearRevealFile;
  for (const signal of REVEAL_SIGNALS) {
    on(signal, () => {
      clear(outDir, nonce);
      exit(REVEAL_SIGNAL_EXIT);
    });
  }
}

/**
 * Run `body`, and delete the reveal file afterwards WHATEVER happened — a clean finish, a refusal, a
 * throw, a bundle that never wrote results.
 *
 * It is a wrapper rather than a line at the end of `main` because `main` leaves through half a dozen
 * exits, and `process.exit` does not run a `finally`. So the program half computes an exit CODE
 * inside this, and the single `process.exit` is outside it — which is the only arrangement in which
 * "deleted on every path" is a property of the shape rather than of somebody having remembered.
 */
export async function withRevealCleanup(outDir, nonce, body) {
  try {
    return await body();
  } finally {
    clearRevealFile(outDir, nonce);
  }
}

/**
 * Read one of this run's own observe files, or `null`.
 *
 * `null` covers all three of "not written yet", "half written" (the bundle renames into place, but
 * a reader may still catch a partial file on some filesystem) and "written by a run that is not
 * this one" — the last by construction, because the only path this ever opens carries THIS run's
 * nonce. A file belonging to another run is not skipped by a check; it is never looked at.
 */
export function readRunFile(outDir, name) {
  const path = join(outDir, name);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remove this run's own observe files before the bundle starts.
 *
 * They cannot ordinarily exist — the nonce is fresh random — but "ordinarily" is not a property a
 * run should depend on for correctness: a nonce given by hand, or a rerun after a crash, would leave
 * the terminal following a previous run's progress file and printing its rows as if they were this
 * one's. Never throws: a file that will not go is not a reason to refuse to measure.
 */
export function clearRunFiles(outDir, nonce) {
  for (const name of [observeUrlsName(nonce), observeProgressName(nonce), observeRevealName(nonce)]) {
    try { rmSync(join(outDir, name), {force: true}); } catch { /* the out folder's problem */ }
  }
}

/**
 * The lines that tell the owner which windows to open for `observe` mode. Pure, so the browser each
 * URL belongs to — the thing that decides whether the guard will ever look at that window — is
 * asserted in a test rather than read off a terminal during a session with him.
 *
 * With an expectation it prints ONLY the expected rows, and says which sets they are. That is the
 * other half of finding O1: run #1 printed twenty URLs, the owner opened the five he had time for,
 * and the harness accepted the run on one of them. A list of five windows the run will be judged on
 * is a list somebody can finish; a list of twenty is a list somebody stops in the middle of.
 */
export function formatObserveUrls(urls, expect) {
  const sets = Array.isArray(expect) && expect.length > 0 ? expect : null;
  const rows = sets === null ? (urls ?? []) : (urls ?? []).filter((entry) => entry.expected === true);
  const lines = sets === null
    ? [
      "", "EXPLORATORY: no --expect was given, so this run can never be ACCEPTED.",
      "Open these one at a time, and leave each in front for a few seconds."
    ]
    : [
      "", `Expecting ${sets.join(",")}: ${rows.length} window(s). The run ends as soon as all of them are read.`,
      "Open these one at a time, and leave each in front for a few seconds."
    ];
  for (const entry of rows) {
    const app = entry.app === "Google Chrome" ? "Chrome" : entry.app === "Safari" ? "Safari" : String(entry.app);
    // "incognito" is Chrome's own word for the window the owner has to open; "private" is Safari's.
    // The case name says `private` in both, because that is the expectation being judged.
    const kind = entry.expectPrivate ? (entry.app === "Google Chrome" ? "INCOGNITO window" : "PRIVATE window ") : "normal window  ";
    lines.push(`  ${pad(app, 7)} ${kind}  ${entry.url}`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/** Built from its code point: the rule the whole harness lives under (`bytes.test.ts`). */
const NL = String.fromCharCode(10);

/**
 * What a row is called once the read is in: the ONE rule, used by the running commentary and by the
 * summary alike (finding O4).
 *
 * `would be KEPT` is this harness's strongest sentence — it says a private window's text crossed
 * into the pipeline — and run #2 printed it for a case whose read had FAILED. `windowGone` means the
 * helper's own approved-window comparisons refused before it captured anything: nothing was read,
 * nothing was kept, and the sentence was about a window that was never looked at. So a failed read
 * says `NOT READ` and its outcome code, and the two `NOT AS EXPECTED` sentences are reserved for
 * reads that succeeded and showed the wrong thing.
 */
export function observeLabel(entry) {
  if (entry.outcome !== "ok") return `NOT READ: ${entry.outcome}`;
  if (entry.expectPrivate) {
    // `!== true` and not `=== false`: a null is a strip the helper never sent, and a badge that was
    // never delivered never skipped anything — in the product that window's text crosses into the
    // pipeline, which is the strongest thing this harness can say.
    return entry.private !== true ? "NOT AS EXPECTED: private window would be KEPT" : "as expected";
  }
  // A NORMAL window with no strip is the opposite case: nothing was checked. `private !== true`
  // alone would call it a pass, so `--expect safari-normal` could be accepted over five reads in
  // which the rule was never applied to anything (review, Minor 5).
  if (entry.private === null || entry.private === undefined) return "NOT CHECKED: no toolbar strip";
  return entry.private === true ? "NOT AS EXPECTED: normal window flagged private" : "as expected";
}

/**
 * One line of the running commentary, printed while the run is still watching (finding O6).
 *
 * Case name, outcome code and the three booleans — `host`, `private`, and whether the read agreed
 * with the case's own name. Nothing else can be printed from here: the progress file holds nothing
 * else (see `ObserveProgressRow`).
 */
export function formatProgressLine(row) {
  const outcome = fixedCode(row.outcome);
  const label = outcome === "ok"
    ? `host ${bool(row.host)} address ${bool(row.addressLine)} private ${bool(row.private)} as-expected ${bool(row.asExpected)}`
    : `NOT READ: ${outcome} (attempt ${count(row.readAttempts)})`;
  return `  read ${pad(fixedCode(row.case), 32)} ${label}${NL}`;
}

/**
 * The file this reads is this run's own — a random nonce in its name, deleted before the bundle
 * starts — so nothing else should ever be in it. These three are defence in depth all the same
 * (review, Minor 7): the terminal is the one place a string from a FILE reaches a human's screen,
 * and a value that is not a fixed code, a boolean or a small count is printed as `?` rather than
 * printed. Letters, digits and hyphens is the grammar of everything this harness mints on that path:
 * a case name (`safari-private-chat-light-14`) and an outcome code (`windowGone`). No space, no
 * slash, no dot, no control byte, and never longer than a case name.
 */
const FIXED_CODE_MAX = 64;

export function fixedCode(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > FIXED_CODE_MAX) return "?";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 97 && code <= 122) ||                                 // a-z
      (code >= 65 && code <= 90) ||                                  // A-Z, for a camelCase outcome
      (code >= 48 && code <= 57) ||                                  // 0-9
      code === 45;                                                   // -
    if (!allowed) return "?";
  }
  return value;
}

/**
 * A revealed row's case name: the `fixedCode` grammar plus the DOT, and nothing else.
 *
 * A toolbar case is named after its table host (`normal-mybank.example.localhost-pt-dark-11`), so
 * since a `toolbar --not-secure` run may reveal, the label of a `REVEAL` line can carry dots — and
 * `fixedCode` would print every one of them as `?`, leaving the owner four strips he cannot tell
 * apart. A dot does nothing to a terminal. `fixedCode` itself is not widened: every other fixed code
 * on this path is as closed as it was.
 */
export function revealCaseName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > FIXED_CODE_MAX) return "?";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 97 && code <= 122) ||                                 // a-z
      (code >= 65 && code <= 90) ||                                  // A-Z
      (code >= 48 && code <= 57) ||                                  // 0-9
      code === 45 ||                                                 // -
      code === 46;                                                   // .
    if (!allowed) return "?";
  }
  return value;
}

const bool = (value) => (value === true ? "true" : value === false ? "false" : "null");
const count = (value) => (Number.isSafeInteger(value) && value >= 0 && value < 1000 ? String(value) : "?");

/**
 * One revealed case, as the owner sees it — the ONE place this harness prints recognised text.
 *
 * Every line is marked `REVEAL <case name>:` so that it can never be mistaken for a measurement, and
 * so that a transcript of a session can be swept for the word. The strip comes first, because it is
 * the string `host` and `hostDistance` were computed from and the whole reason the flag exists; the
 * band's own lines follow with the boxes they were recognised in, which is what says whether a
 * TRANSLATE glyph sits where the address should be.
 *
 * The text arrives already capped and cleaned (`revealRowOf` in `observe.ts`); the lengths beside it
 * are the ORIGINAL lengths, so a truncation is visible rather than silent.
 */
export function formatRevealRow(row) {
  const name = revealCaseName(row.case);
  const lines = [
    `  REVEAL ${name}: band ${count(row.bandPx)}px  strip[${count(row.toolbarTextLength)}] ${quoted(row.toolbarText)}`
  ];
  for (const line of row.lines ?? []) {
    lines.push(
      `  REVEAL ${name}: line ${count(line.topPx)}-${count(line.bottomPx)}px` +
      ` x${count(line.leftPx)}-${count(line.rightPx)}px [${count(line.length)}] ${quoted(line.text)}`
    );
  }
  const shown = (row.lines ?? []).length;
  if (count(row.linesInBand) !== "?" && row.linesInBand > shown) {
    lines.push(`  REVEAL ${name}: ${row.linesInBand - shown} more line(s) in the band, not shown`);
  }
  return lines.join(NL) + NL;
}

/**
 * A revealed string, in quotes, with anything the shaping missed turned into a question mark.
 *
 * The bundle has already replaced control characters and cut the text to length; this is the second
 * half of the same rule, applied where the bytes actually reach a terminal. A quote inside the text
 * is replaced rather than escaped: this is a line for a person to read, not a value to parse back.
 */
export function quoted(value) {
  if (typeof value !== "string") return "?";
  let out = "";
  for (const character of [...value].slice(0, 200)) {
    const code = character.codePointAt(0) ?? 0;
    out += revealUnsafeCodePoint(code) || character === "\"" ? "?" : character;
  }
  return `"${out}"`;
}

/**
 * The code points a revealed string may not reach a terminal with, as RANGES built from numbers.
 *
 * The same table as `REVEAL_UNSAFE_RANGES` in `src/readerEval/observe.ts`, kept here because this
 * file cannot import that one — and cross-checked against it, code point by code point, in
 * `reader-eval.test.ts`. Numbers and never literal characters: most of these are invisible, and a
 * review cannot see one that went missing from a string.
 *
 * Why it is here at all, when the bundle has already replaced them: this is the place the bytes
 * actually reach a tty. The bundle's filter is the one that must hold; this is the one that holds
 * if the file was written by something else, or by a bundle from another build.
 */
const REVEAL_UNSAFE_RANGES = [
  [0x0000, 0x001f],   // C0, ESC among them
  [0x007f, 0x009f],   // DEL and C1; U+009B is the 8-bit CSI an xterm decodes as a control
  [0x061c, 0x061c],   // ARABIC LETTER MARK
  [0x200b, 0x200f],   // zero-width space/non-joiner/joiner, LRM, RLM
  [0x2028, 0x202e],   // line and paragraph separators, bidi embeddings and overrides
  [0x2060, 0x2060],   // WORD JOINER
  [0x2066, 0x2069],   // bidi isolates
  [0xfeff, 0xfeff]    // ZERO WIDTH NO-BREAK SPACE
];

export function revealUnsafeCodePoint(code) {
  for (const [from, to] of REVEAL_UNSAFE_RANGES) {
    if (code >= from && code <= to) return true;
  }
  return false;
}

/**
 * What makes one progress line different from the one before it for the same case.
 *
 * A case is printed again when its OUTCOME changes or when another attempt was made on it, and not
 * otherwise: the bundle rewrites the whole table after every read, so the terminal would otherwise
 * reprint every finished case once a second. A retry is worth a line — it is the owner's cue that
 * the window is being tried again rather than ignored.
 */
export function progressKey(row) {
  return `${fixedCode(row.case)} ${fixedCode(row.outcome)} ${count(row.readAttempts)}`;
}

/**
 * What a fixed refusal code means, in one line each. The display is the one NEAREST the staging
 * position, which is the display `--position` was pointing at.
 */
export const HINTS = {
  PAGE_SERVER: "      the page server could not get both loopback families on one port; another" + NL +
    "      local process may hold it. Nothing was opened." + NL,
  DISPLAY_TOO_SMALL: "      the staged window does not fit this display's work area; nothing was opened" + NL,
  POSITION_OFF_DISPLAY: "      --position leaves the staged window off that display's work area; nothing was opened" + NL
};

const pad = (value, width) => String(value).padEnd(width);
/**
 * The width of the case-name column in a `--not-secure` summary: the longest name in the toolbar
 * table (`incognito-mybank.example.localhost-ticket-light-14` and its like, 49 characters), compared
 * with the table itself in `reader-eval.notSecure.test.ts`. It was 48, which pushed exactly those
 * lines one column to the right (review, Minor 7).
 */
export const CASE_NAME_WIDTH = 49;
const num = (value, digits = 4) => (typeof value === "number" ? value.toFixed(digits) : "-");

/**
 * The staged size of one read, as a phrase: points for a browser window, cells for a terminal.
 *
 * Two units, because the harness asks for two different things and neither converts to the other
 * without knowing a font. A staging with neither pair filled says so rather than printing `-x- pt`,
 * which would read as a measurement that came back empty.
 */
export function stagedPhrase(staged) {
  if (!staged || typeof staged !== "object") return "nothing recorded";
  if (typeof staged.widthPt === "number" && typeof staged.heightPt === "number") {
    return `${staged.widthPt}x${staged.heightPt} pt`;
  }
  if (typeof staged.columns === "number" && typeof staged.rows === "number") {
    return `${staged.columns}x${staged.rows} cells`;
  }
  return "nothing recorded";
}

/**
 * The two staging lines of one case: a window that was not the size it was staged at, and a read
 * that came back without the staged page's markers.
 *
 * Both exist because of the first run against a screen (2026-09-20). Every Chrome capture came back
 * 1416 x 1768 px against a staged 1268 x 708 pt and nothing printed said so — the numbers all
 * passed. Both Terminal cases came back `noMarkers` with a read that had plainly worked, and there
 * was no way to tell an empty window from a scrolled one from a misread marker. A size that is not
 * as staged also makes the case INCOMPLETE, so the verdict line above already says the group did not
 * pass; this says why, in the numbers that would otherwise only be in the JSON.
 *
 * One line per case, not per repetition: five identical lines would bury the rest of the summary.
 * Pure, and tested in `reader-eval.test.ts`.
 */
export function stagingLines(name, repetitions) {
  const lines = [];
  const wrongSize = repetitions.filter((entry) => entry.sizeAsStaged === false);
  const first = wrongSize[0];
  if (first) {
    const px = `${first.stats?.widthPx}x${first.stats?.heightPx}`;
    lines.push(
      `      ${pad(name, 25)} NOT AS STAGED: captured ${px} px, staged ${stagedPhrase(first.staged)}` +
      `  (${wrongSize.length} of ${repetitions.length} reads)`
    );
  }
  const missing = repetitions.filter((entry) => entry.markers === false);
  const worst = missing[0];
  if (worst) {
    lines.push(
      `      ${pad(name, 25)} NO MARKERS: start ${worst.startFound} end ${worst.endFound}` +
      `  lines ${worst.lineCount} chars ${worst.textLength}  (${missing.length} of ${repetitions.length} reads)`
    );
  }
  return lines;
}

/**
 * The summary table and the verdicts. Pure: it is handed the parsed results and returns text.
 *
 * `options` is what THIS terminal parsed from its own command line. It is used for one thing only:
 * a run this terminal started with `--not-secure` is never printed ACCEPTED, whatever the file says
 * (see `typedNotSecure`).
 */
export function formatSummary(results, options) {
  if (results && typeof results === "object" && typeof results.error === "string") {
    // The code is the useful half whenever the error is the catch-all HARNESS: BAD_MODE and
    // BAD_VARIANT both arrive that way, and "the harness failed" alone would not tell the owner that
    // it was the CALL that was wrong. When the two are the same word, once is enough.
    const code = typeof results.code === "string" && results.code !== results.error ? ` ${results.code}` : "";
    // Two refusals are facts about the MACHINE rather than about the call, so the code alone would
    // leave the owner guessing. They are different instructions: one says the window cannot be
    // staged on that display at any corner, the other says move it.
    // Own properties only: `code` is a string from a file, and `HINTS["constructor"]` would
    // otherwise be a function, which `??` would happily print.
    const hint = Object.prototype.hasOwnProperty.call(HINTS, results.code) ? HINTS[results.code] : "";
    return `READER_EVAL_FAILED ${results.error}${code}\n${hint}`;
  }
  const lines = [];
  // A file this formatter does not know how to read (review, Minor 8). Only reachable by pointing
  // it at an older run's results, which the normal flow never does — but a version-3 file read by
  // this formatter would print `expect (none)` with no EXPLORATORY line, which is the one sentence
  // that must never be missing from a run that cannot be accepted. Said plainly, and `exitCodeFor`
  // refuses it.
  if (!knownSchema(results)) {
    lines.push(`OLD RESULTS FILE: schema ${results.schema}, this terminal reads schema ${RESULTS_SCHEMA}`);
    lines.push("      its observe verdict cannot be read here; re-run rather than believe this summary");
    lines.push("");
  }
  // Every mode records it, so every mode prints it: the number is the answer to spec 10.1 item 4
  // (how long a cold helper takes) and it is the first thing that explains a run that felt slow.
  const readyMs = results.helper?.readyMs;
  if (typeof readyMs === "number") lines.push(`helper ready in ${readyMs} ms`, "");
  const accuracy = Array.isArray(results.accuracy) ? results.accuracy : [];
  if (accuracy.length > 0) {
    lines.push(`case                      min      median   accents  outcomes`);
    for (const entry of accuracy) {
      const outcomes = (entry.repetitions ?? []).map((r) => r.outcome).join(",");
      lines.push(`${pad(entry.case, 25)} ${pad(num(entry.minAccuracy), 8)} ${pad(num(entry.medianAccuracy), 8)} ${pad(num(entry.minAccents), 8)} ${outcomes}`);
    }
    for (const entry of accuracy) lines.push(...stagingLines(entry.case, entry.repetitions ?? []));
    lines.push("");
  }
  const groups = results.summary?.groups ?? [];
  for (const group of groups) {
    const accents = group.accentsThreshold === null || group.accentsThreshold === undefined
      ? ""
      : `  accents ${num(group.accentsMin)} (need ${num(group.accentsThreshold, 1)})`;
    const incomplete = group.incompleteCases?.length ? `  INCOMPLETE: ${group.incompleteCases.join(" ")}` : "";
    lines.push(`${group.passed ? "PASS" : "SHORT"}  ${pad(group.group, 9)} min ${num(group.min)} (need ${num(group.threshold, 2)})  median ${num(group.median)}${accents}${incomplete}`);
  }
  // A group with no verdict at all is a part of the screen nobody measured. Printed by name, because
  // an absent line is exactly what made a run that measured nothing look like a run that went fine.
  const missingGroups = results.summary?.missingGroups ?? [];
  if (missingGroups.length > 0) {
    lines.push(`SHORT  groups    MISSING: ${missingGroups.join(" ")}  (no verdict: nothing in them was measured)`);
  }
  const toolbar = results.summary?.toolbar;
  if (toolbar) {
    lines.push("");
    lines.push(`${toolbar.passed ? "PASS" : "SHORT"}  toolbar   captures ${toolbar.captures}  host ${toolbar.hostHits}/${toolbar.hostHitsMin}+  private ${toolbar.privateHits}/${toolbar.privateHitsMin}  false-private ${toolbar.falsePrivate}/${toolbar.falsePrivateMax} max`);
    // INFORMATION, and said so in the line itself: owner decision O8 made the core drop a read whose
    // strip shows no address line, and this is the first measurement of whether real Chrome strips
    // satisfy it. It has no threshold and it decides nothing — a low count is a finding about the
    // core to take to the owner, not a run that failed.
    if (typeof toolbar.addressLines === "number") {
      lines.push(`      addressLine ${toolbar.addressLines}/${toolbar.captures}  (information only: the core keeps a read only when some toolbar LINE is an address)`);
    }
    // `--not-secure` only: the host count over EVERY capture (the verdict's `host` above counts the
    // normal windows alone, as spike P5 did), and one line per case. Numbers, booleans, fixed
    // outcome codes and this harness's own case names — the results file holds nothing else.
    if (isNotSecure(results)) {
      const rows = Array.isArray(results.toolbar) ? results.toolbar : [];
      const found = rows.filter((entry) => entry?.host === true).length;
      lines.push(`      host found ${found}/${rows.length}  (measured against ${NOT_SECURE_HOST}, every capture, normal and incognito)`);
      for (const entry of rows) {
        lines.push(
          `      ${pad(revealCaseName(entry?.case), CASE_NAME_WIDTH)} outcome ${pad(fixedCode(entry?.outcome), 10)} host ${bool(entry?.host)}` +
          ` dist ${count(entry?.hostDistance)} address ${bool(entry?.addressLine)} private ${bool(entry?.private)}` +
          ` band ${count(entry?.bandPx)}`
        );
      }
    }
    if (toolbar.incompleteCases?.length) lines.push(`      INCOMPLETE: ${toolbar.incompleteCases.join(" ")}`);
    // A band measured in a window of an unknown size is a number about an unknown window.
    for (const entry of results.toolbar ?? []) lines.push(...stagingLines(entry.case, [entry]));
    // A badge below the band is carried item 30's privacy failure mode: a private window KEPT.
    for (const entry of results.toolbar ?? []) {
      if (entry.privateBottomPx !== null && entry.bandPx !== null && entry.privateBottomPx > entry.bandPx) {
        lines.push(`      BELOW BAND  ${entry.case}  badge bottom ${entry.privateBottomPx}px > band ${entry.bandPx}px  private=${entry.private}`);
      }
    }
  }
  const observeVerdict = results.summary?.observe;
  const observe = results.observe ?? [];
  if (observeVerdict || observe.length > 0) {
    lines.push("");
    for (const entry of observe) {
      // Both directions are failures, and a read that never happened is neither of them: see
      // `observeLabel`. `hostDistance` is beside `host` because a boolean cannot tell an address
      // Safari never drew from one whose `1`s came back as `l`s (finding O5).
      lines.push(
        `  ${pad(entry.case, 32)} outcome ${pad(entry.outcome, 10)} host ${entry.host} dist ${entry.hostDistance}` +
        ` address ${entry.addressLine}` +
        ` private ${entry.private} band ${entry.bandPx} badge ${entry.privateBottomPx}  ${observeLabel(entry)}`
      );
    }
    if (observeVerdict) {
      const expect = Array.isArray(observeVerdict.expect) && observeVerdict.expect.length > 0
        ? observeVerdict.expect.join(",")
        : "(none)";
      lines.push(
        `${observeVerdict.passed ? "PASS" : "SHORT"}  observe   expect ${expect}` +
        `  expected ${observeVerdict.expected ?? 0}  staged ${observeVerdict.staged}  read ${observeVerdict.read}` +
        `  private-missed ${observeVerdict.privateMissed}  false-private ${observeVerdict.falsePrivate}`
      );
      // The finding this line exists for: a run that was asked for nothing cannot have proved
      // anything, however clean its rows are. It used to print ACCEPTED on one read of twenty.
      if (observeVerdict.reason === "EXPLORATORY") {
        lines.push("      EXPLORATORY: no --expect, so this run proves nothing and can never be accepted");
      }
      if (observeVerdict.missingCases?.length) {
        lines.push(`      INCOMPLETE: expected but never read: ${observeVerdict.missingCases.join(" ")}`);
      }
      // A normal window that was read and carried no strip: the rule was never applied to anything,
      // so there is nothing in it to call a pass (review, Minor 5).
      if (observeVerdict.notCheckedCases?.length) {
        lines.push(`      NOT CHECKED: no toolbar strip: ${observeVerdict.notCheckedCases.join(" ")}`);
      }
      if (observeVerdict.read === 0) lines.push("      INCOMPLETE: nothing was staged and read, so nothing was measured");
      if (observeVerdict.incompleteCases?.length) lines.push(`      INCOMPLETE: ${observeVerdict.incompleteCases.join(" ")}`);
    }
  }
  // `coldstart`: both figures, printed plainly, because they ARE the measurement. `permission` is
  // the one that blocks the rest of the plan — a helper spawned by the window-less evaluation entry
  // answering anything but `granted` means the grant does not reach it.
  const coldstart = results.summary?.coldstart;
  if (coldstart) {
    lines.push("");
    const ready = typeof coldstart.readyMs === "number" ? `${coldstart.readyMs} ms` : "not measured";
    lines.push(`${coldstart.passed ? "PASS" : "SHORT"}  coldstart ready ${ready}  permission ${coldstart.permission}`);
    if (coldstart.permission !== "granted") {
      lines.push("      the grant does not reach a helper spawned by the evaluation entry");
    }
  }
  lines.push("");
  // A short run says so in one line, above the verdict, because every number above it is about the
  // cases it staged and not about the table. It can never be an acceptance run.
  const limited = results.summary?.limited;
  if (limited) {
    lines.push(`LIMITED RUN: ${limited.cases} of ${limited.of} cases — not an acceptance run`);
  }
  // And so does an exploratory one. Two INDEPENDENT reasons, either enough (review, Important 1):
  // what this terminal typed itself, and what the file says. With either, the word ACCEPTED is never
  // printed, whatever the file's own `accepted` says: the third lock, after `summarise` and
  // `serialiseResults` — and the only one that does not hang from the bundle's own wiring.
  const typed = typedNotSecure(options);
  if (typed || isNotSecure(results)) {
    lines.push(`EXPLORATORY RUN: --not-secure (pages staged under ${NOT_SECURE_HOST}) — can never be accepted`);
  }
  // The terminal asked for the variant and the file does not carry the marker such a run always
  // writes: the bundle's wiring is wrong, and the owner is told so in a fixed code.
  if (typed && results.notSecure !== true) lines.push(MARKER_MISSING_LINE);
  lines.push(results.summary?.accepted === true && !typed && !isNotSecure(results) ? "READER_EVAL ACCEPTED" : "READER_EVAL SHORTFALL");
  return lines.join("\n") + "\n";
}

/** Printed when `--not-secure` was typed and the results file does not say `notSecure: true`. */
export const MARKER_MISSING_LINE = "READER_EVAL_FAILED MARKER_MISSING";

/**
 * Did THIS terminal start the run with `--not-secure`? Decided from the options this process parsed
 * from its own command line, never from the file: the terminal typed the flag itself, so its lock on
 * "never accepted" needs nothing the bundle wrote (review, Important 1).
 *
 * Fail-closed: only `false`, or no answer at all, is an ordinary run. `parseEvalArgs` only ever
 * produces the two booleans, so anything else is a caller this function does not know — and the one
 * thing it must not do with such a caller is accept its run.
 */
export function typedNotSecure(options) {
  if (options === null || options === undefined) return false;
  return options.notSecure !== false && options.notSecure !== undefined;
}

/**
 * Is this a results file this terminal must treat as a `toolbar --not-secure` run? FAIL-CLOSED
 * (review, Important 1): the one and only shape of an ordinary run is `notSecure: false` at the top
 * BESIDE `exploratory: null` in the summary, which is what `serialiseResults` writes for every
 * ordinary run. Everything else is treated as marked — a marker that is absent, a marker that is not
 * a boolean (`"true"`, `1`), any value under `exploratory` whatever its type or reason, the two
 * disagreeing, and whatever the mode says. A file whose markers cannot be read is a run this terminal
 * must not call accepted.
 */
export function isNotSecure(results) {
  if (!results || typeof results !== "object") return false;
  return !(results.notSecure === false && results.summary?.exploratory === null);
}

/**
 * The results shape this terminal half reads. The same number `EvalResults.schema` demands in
 * `src/readerEval/results.ts`, kept here so the two are compared rather than assumed equal.
 */
export const RESULTS_SCHEMA = 6;

/** Is this a file this formatter understands? A missing schema is taken as one — see `exitCodeFor`. */
export function knownSchema(results) {
  return results?.schema === undefined || results.schema === RESULTS_SCHEMA;
}

/**
 * What a throw that reached the top of the program half prints, and what it exits with.
 *
 * A fixed code and nothing else. Node's unhandled-rejection path prints a stack full of absolute
 * paths, and a path carries a name — the rule `src/readerEval/main.ts` states for the bundle's own
 * refusals, applied to this half. By the time this runs the reveal file and the heartbeat are
 * already gone: the `finally` in `withRevealCleanup` is inside the call that threw.
 *
 * `write` and `exit` are injected so the handler is a thing a test runs (re-review, Minor C).
 */
export const HARNESS_FAILURE_LINE = "READER_EVAL_FAILED HARNESS\n";
export const HARNESS_FAILURE_EXIT = 1;

export function reportHarnessFailure(io = {}) {
  const write = io.write ?? ((text) => process.stderr.write(text));
  const exit = io.exit ?? ((code) => { process.exit(code); });
  write(HARNESS_FAILURE_LINE);
  exit(HARNESS_FAILURE_EXIT);
}

/**
 * 0 accepted, 2 a shortfall, 1 a run that never produced results. Pure.
 *
 * A file of a schema this terminal does not read is a SHORTFALL, not a harness error: the run may
 * well have been fine, but this half cannot say so, and 0 is the one answer it must not give
 * (review, Minor 8).
 */
export function exitCodeFor(results, options) {
  if (!results || typeof results !== "object") return 1;
  if (typeof results.error === "string") return 1;
  // This terminal typed `--not-secure`: never 0, whatever the file says (see `typedNotSecure`).
  if (typedNotSecure(options)) return 2;
  if (!knownSchema(results)) return 2;
  // An exploratory run is a shortfall whatever its `accepted` says (the third lock; see `isNotSecure`).
  if (isNotSecure(results)) return 2;
  return results.summary?.accepted === true ? 0 : 2;
}

// --- everything below runs only when this file is the program ---------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", () => { resolve(1); });
    child.once("exit", (code) => { resolve(code ?? 1); });
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** How often the running commentary asks the progress file what has happened. */
export const PROGRESS_POLL_MS = 1000;
/** How long the URL list is waited for before the watch gives up on it: 80 x 250 ms = 20 s. */
export const URLS_WAIT_TRIES = 80;
export const URLS_POLL_MS = 250;

/**
 * The two files this run may open, and the only two. Pure, so the NAMES are a thing a test asserts
 * rather than a thing somebody reads off the source.
 *
 * Finding O3 was here, at the call site: the terminal used to open a file with a FIXED name, find
 * the previous run's already sitting there, and print its URLs — an old port under an old nonce,
 * addresses this run could never approve, and twenty minutes of the owner pasting them. The first
 * fix put the nonce in the name; this makes the call site testable, because the fix can be reverted
 * one line above the helper and nothing would have noticed (review, Important 1).
 */
export function observeFilesFor(nonce) {
  return {
    urls: observeUrlsName(nonce),
    progress: observeProgressName(nonce),
    reveal: observeRevealName(nonce),
    // Where a strip is moved to before it is printed, and the heartbeat that says this side is alive.
    claimed: claimedOf(observeRevealName(nonce)),
    alive: observeAliveName(nonce)
  };
}

/**
 * Print the URLs for THIS run, then follow it: one line per case as it is read, until the bundle
 * exits (findings O3 and O6).
 *
 * Every file it opens comes from `observeFilesFor(nonce)`, so a previous run's file is not skipped
 * by a check — it is never named. `io` is injected so the whole loop runs in a test with no
 * filesystem, no clock and no terminal: `read(name)` answers a parsed file or `null`, `print(text)`
 * takes the output, and `wait(ms)` is the sleep (which is also where a test ends the run).
 *
 * The final sweep after the loop is not belt and braces: the bundle writes the last case's progress
 * and then exits, and without it the case the owner was waiting for would be the one line he never
 * saw.
 */
/**
 * Does the terminal follow this run while it goes, and how? `null` for a run it does not follow.
 *
 * - An OBSERVING run is followed exactly as before: the URL list, the running commentary, and the
 *   strips when it was asked to reveal.
 * - A `toolbar --not-secure --reveal-toolbar` run is followed for the strips alone. It has no URL
 *   list to wait for — the harness stages those windows itself — so `urls` is false and the watch
 *   goes straight to beating and sweeping. The HEARTBEAT is the reason this cannot be skipped: the
 *   bundle reveals only while `observe-alive-<nonce>` is fresh, and only the watch rewrites it.
 * - No other run is followed, an ordinary toolbar run included.
 *
 * Pure, so the three cases are a thing a test asserts; the program half calls this and nothing else.
 */
export function watchPlanFor(options) {
  if (OBSERVING_MODES.includes(options.mode)) return {reveal: options.reveal === true, urls: true};
  if (options.mode === NOT_SECURE_MODE && options.notSecure === true && options.reveal === true) {
    return {reveal: true, urls: false};
  }
  return null;
}

export async function watchObserve(outDir, nonce, running, io = {}, options = {}) {
  const files = observeFilesFor(nonce);
  const read = io.read ?? ((name) => readRunFile(outDir, name));
  const print = io.print ?? ((text) => process.stdout.write(text));
  const wait = io.wait ?? delay;
  // Injected like the rest, so a test can prove the reveal file is deleted the moment it is read.
  const remove = io.remove ?? ((name) => { try { rmSync(join(outDir, name), {force: true}); } catch { /* the out folder's problem */ } });
  /**
   * Take the file out of the bundle's way before reading it, so a write that lands between the read
   * and the delete cannot be thrown away unread (review, Minor 5).
   *
   * `rename` is atomic within a directory: either this side has the file or the bundle still does,
   * never neither. It is the same trick `writeAtomic` uses, turned around — and it matters for
   * exactly one case, which is the one the session is for: the bundle's LAST write lands moments
   * before it exits, and a delete-by-name would drop that strip with nothing to say it had.
   */
  const claim = io.claim ?? ((from, to) => {
    try { renameSync(join(outDir, from), join(outDir, to)); return true; } catch { return false; }
  });
  /** The heartbeat the bundle watches: rewritten every poll, private like the file it guards. */
  const beat = io.beat ?? ((name) => {
    try { writeHeartbeat(join(outDir, name), {writeFile: writeFileSync}); } catch { /* the out folder's problem */ }
  });
  // The print is gated on the flag as well as on the file existing (review, Important 2): an
  // ordinary run cannot print a strip even if one somehow exists beside it. The REMOVAL is not
  // gated — a stray file is swept whether this run asked for one or not.
  const revealing = options.reveal === true;
  /**
   * The heartbeat starts BEFORE the URL wait, and is rewritten inside it.
   *
   * The bundle asks how old this file is before its FIRST reveal write, and a missing heartbeat is
   * not "not yet" — it is "the terminal is dead", which deletes the file and stops revealing for the
   * whole run, silently and with no way back. The URL wait can run for 20 s (80 x 250 ms), so a
   * heartbeat that only began after it would leave that whole window uncovered. It is safe today
   * only because the bundle writes the URLs file before it spawns the helper, so this loop breaks
   * within 250 ms of the bundle starting — a dependency between two files in two processes that
   * nothing states and nothing tests. One call here removes it (re-review, Minor D).
   */
  beat(files.alive);
  // `urls: false` — a revealing toolbar run — has no URL list to wait for, and must not spend twenty
  // seconds looking for one. Only the literal `false` skips it: absent is an observing run.
  const waitForUrls = options.urls !== false;
  for (let tries = 0; tries < URLS_WAIT_TRIES && !running.done && waitForUrls; tries += 1) {
    beat(files.alive);
    const file = read(files.urls);
    if (file) {
      print(formatObserveUrls(file.urls, file.expect));
      break;
    }
    await wait(URLS_POLL_MS);
  }
  const printed = new Set();
  const revealed = new Set();
  /**
   * The reveal file is printed and then DELETED, at once, every time it is found.
   *
   * The bundle rewrites the whole table after every successful read, so deleting it mid-run costs
   * nothing — the next write brings back what is still to come, and `revealed` keeps a case from
   * being printed twice. What it buys is that the recognised text is on disk for at most one poll,
   * and that a run interrupted between two polls leaves at most one poll's worth behind (which the
   * cleanup on the way out then removes).
   */
  const sweepReveal = () => {
    // Claimed first: from here on this side owns the file, whatever the bundle writes next.
    if (!claim(files.reveal, files.claimed)) return;
    const reveal = read(files.claimed);
    for (const row of revealing ? reveal?.rows ?? [] : []) {
      const name = typeof row?.case === "string" ? row.case : "";
      if (revealed.has(name)) continue;
      revealed.add(name);
      print(formatRevealRow(row));
    }
    remove(files.claimed);
  };
  const sweep = () => {
    const progress = read(files.progress);
    for (const row of progress?.rows ?? []) {
      const key = progressKey(row);
      if (printed.has(key)) continue;
      printed.add(key);
      print(formatProgressLine(row));
    }
    sweepReveal();
  };
  while (!running.done) {
    // The heartbeat first, so a poll that finds nothing still tells the bundle somebody is here.
    beat(files.alive);
    sweep();
    await wait(PROGRESS_POLL_MS);
  }
  // The final sweep runs AFTER the bundle has exited and before the cleanup in `withRevealCleanup`,
  // so the last case's strip is printed rather than deleted unread.
  sweep();
}

/**
 * The run itself, once the call has been checked and the nonce minted: it RETURNS an exit code
 * rather than calling `process.exit`, so that every path out of it — a clean finish, a refusal, a
 * bundle that wrote nothing, a throw — passes through the `finally` in `withRevealCleanup` that
 * deletes the reveal file. `process.exit` does not run a `finally`, so a single exit outside the
 * wrapper is the only arrangement in which that deletion is a property of the shape.
 */
async function runEval(options, outDir, nonce) {
  const bundle = join(homedir(), "Applications", "Clave Agent Dev.app");
  const outFile = join(outDir, `${options.mode}-${nonce}.json`);

  process.stdout.write(`READER_EVAL ${options.mode} nonce ${nonce}\n`);
  process.stdout.write(options.mode === "coldstart"
    ? "No window will open: this measures the helper's start and its permission answer.\n"
    : "Windows will open and close. Do not use the machine while it runs.\n");
  if (options.notSecure) {
    process.stdout.write(`EXPLORATORY: --not-secure stages the toolbar pages under ${NOT_SECURE_HOST}, which only\n`);
    process.stdout.write("this run's own throw-away Chrome profile can reach. This run can never be ACCEPTED.\n");
  }
  if (options.reveal) {
    process.stdout.write("REVEALING the toolbar strip of every staged window on this terminal.\n");
    process.stdout.write("Use a SINGLE-TAB window: other tabs' titles are drawn in the same band.\n");
    process.stdout.write("Interrupting this run is safe: the strips are deleted on the way out, and\n");
    process.stdout.write("the bundle stops writing them within five seconds of this terminal going.\n");
  }

  const child = spawn("/usr/bin/open", openArgs(bundle, evalEnv(options, outFile, nonce)), {stdio: "inherit"});
  const running = {done: false};
  const finished = waitForExit(child).then((code) => { running.done = true; return code; });
  const plan = watchPlanFor(options);
  if (plan !== null) await watchObserve(outDir, nonce, running, {}, plan);
  const code = await finished;
  if (code !== 0) { process.stderr.write(`READER_EVAL_FAILED OPEN_EXIT ${code}\n`); return 1; }

  if (!existsSync(outFile)) { process.stderr.write("READER_EVAL_FAILED NO_RESULTS\n"); return 1; }
  let results;
  try {
    results = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    process.stderr.write("READER_EVAL_FAILED UNREADABLE_RESULTS\n");
    return 1;
  }
  // Both are handed the options THIS process parsed: a `--not-secure` run is never printed ACCEPTED
  // and never exits 0, whatever the bundle wrote (pinned in `reader-eval.notSecure.test.ts`).
  process.stdout.write(formatSummary(results, options));
  process.stdout.write(`results: ${outFile}\n`);
  return exitCodeFor(results, options);
}

async function main() {
  const options = parseEvalArgs(process.argv.slice(2));
  if (!options.ok) { process.stderr.write(USAGE); process.exit(1); }

  const bundle = join(homedir(), "Applications", "Clave Agent Dev.app");
  if (!existsSync(bundle)) {
    process.stderr.write("READER_EVAL_FAILED BUNDLE_MISSING run: pnpm --dir app dev:bundle\n");
    process.exit(1);
  }
  const entry = join(appDir, "dist", "reader-eval.cjs");
  if (!existsSync(entry)) {
    process.stderr.write("READER_EVAL_FAILED ENTRY_MISSING run: pnpm --dir app build\n");
    process.exit(1);
  }

  // 0700: the folder holding the one file that can carry screen text is the owner's alone. The
  // mode applies when the folder is created; an existing one keeps whatever it has.
  const outDir = join(appDir, "reader-eval", "out");
  mkdirSync(outDir, {recursive: true, mode: 0o700});
  const nonce = randomBytes(6).toString("hex");
  // EVERY run's orphaned strips, not only this one's: a terminal killed with SIGKILL, or a machine
  // that lost power, leaves a file this run's nonce could never name.
  sweepRevealOrphans(outDir);
  // This run's own observe files, the reveal file included, gone before the bundle starts.
  clearRunFiles(outDir, nonce);
  // Ctrl-C is how a hands-on session ends, and Node's default disposition runs no `finally`.
  installRevealSignalHandlers(outDir, nonce);
  // And gone again on the way out, however the run ended.
  process.exit(await withRevealCleanup(outDir, nonce, () => runEval(options, outDir, nonce)));
}

// `import.meta.main` is not available on this Node, so the program half is gated on argv instead:
// importing this module from a test never opens anything.
if (process.argv[1] && process.argv[1].endsWith("reader-eval.mjs")) {
  // A fixed code, never a stack: Node's unhandled-rejection path prints absolute paths, and a path
  // carries a name (the rule `src/readerEval/main.ts` states for the bundle's own refusals). The
  // cleanup has already run by the time a throw reaches here — the `finally` is inside the wrapper.
  try {
    await main();
  } catch {
    reportHarnessFailure();
  }
}
