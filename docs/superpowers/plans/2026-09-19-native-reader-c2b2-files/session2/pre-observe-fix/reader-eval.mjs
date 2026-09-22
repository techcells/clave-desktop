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
import {existsSync, mkdirSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export const MODES = ["accuracy", "toolbar", "observe", "all", "coldstart"];

/** The modes that stage a table of cases, and so are the only ones `--limit` means anything for. */
export const LIMITED_MODES = ["accuracy", "toolbar", "all"];
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

/** The largest `--limit`. The same bound as `LIMIT_MAX` in `src/readerEval/config.ts`. */
export const LIMIT_MAX = 1000;

export const USAGE = `usage: pnpm --dir app reader:eval -- <mode> [options]

  modes
    accuracy   the staged pages and the two terminals, scored (default)
    toolbar    40 Chrome stagings: address host and the private badge
    observe    windows the OWNER stages by hand (Safari and Chrome, normal and
               private/incognito); a window staged private that shows no private
               marker fails the run, and so does a normal one flagged private
    all        all three, in that order
    coldstart  the helper only: how long it takes to be ready and what it says
               about the Screen Recording permission. No window is opened and
               nothing is read. Not part of "all"; ask for it by name.

  options
    --repetitions <n>   reads per accuracy case (default 5)
    --seconds <n>       how long observe mode watches (default 120)
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
  const options = {mode: "accuracy", repetitions: 5, seconds: 120, variant: "none", position: null, limit: null};
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
  // Set only when the owner asked for a position. Absent means "the default corner", which the
  // bundle takes from `DEFAULT_POSITION`; an EMPTY variable is a refusal there, not a default, so
  // this must not pass one through.
  if (typeof options.position === "string" && options.position.length > 0) {
    env.CLAVE_EVAL_POSITION = options.position;
  }
  return env;
}

/**
 * The lines that tell the owner which windows to open for `observe` mode. Pure, so the browser each
 * URL belongs to — the thing that decides whether the guard will ever look at that window — is
 * asserted in a test rather than read off a terminal during a session with him.
 */
export function formatObserveUrls(urls) {
  const lines = ["", "Open these one at a time, and leave each in front for a few seconds."];
  for (const entry of urls ?? []) {
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

/** The summary table and the verdicts. Pure: it is handed the parsed results and returns text. */
export function formatSummary(results) {
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
      // Both directions are failures. A staged PRIVATE window that shows no marker is the one that
      // matters most: in the product that window would be KEPT.
      const wrong = entry.expectPrivate ? entry.private !== true : entry.private === true;
      const agreed = wrong
        ? (entry.expectPrivate ? "NOT AS EXPECTED: private window would be KEPT" : "NOT AS EXPECTED: normal window flagged private")
        : "as expected";
      lines.push(`  ${pad(entry.case, 32)} outcome ${pad(entry.outcome, 10)} host ${entry.host} private ${entry.private} band ${entry.bandPx} badge ${entry.privateBottomPx}  ${agreed}`);
    }
    if (observeVerdict) {
      lines.push(`${observeVerdict.passed ? "PASS" : "SHORT"}  observe   staged ${observeVerdict.staged}  read ${observeVerdict.read}  private-missed ${observeVerdict.privateMissed}  false-private ${observeVerdict.falsePrivate}`);
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
  lines.push(results.summary?.accepted ? "READER_EVAL ACCEPTED" : "READER_EVAL SHORTFALL");
  return lines.join("\n") + "\n";
}

/** 0 accepted, 2 a shortfall, 1 a run that never produced results. Pure. */
export function exitCodeFor(results) {
  if (!results || typeof results !== "object") return 1;
  if (typeof results.error === "string") return 1;
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

/** Prints the observe URLs as soon as the bundle has written them (it picks the port, not us). */
async function announceObserveUrls(outDir, running) {
  const path = join(outDir, "observe-urls.json");
  for (let tries = 0; tries < 80 && !running.done; tries += 1) {
    if (existsSync(path)) {
      try {
        const {urls} = JSON.parse(readFileSync(path, "utf8"));
        process.stdout.write(formatObserveUrls(urls));
        return;
      } catch {
        // half-written; the next try reads the renamed file
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
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

  const outDir = join(appDir, "reader-eval", "out");
  mkdirSync(outDir, {recursive: true});
  const nonce = randomBytes(6).toString("hex");
  const outFile = join(outDir, `${options.mode}-${nonce}.json`);

  process.stdout.write(`READER_EVAL ${options.mode} nonce ${nonce}\n`);
  process.stdout.write(options.mode === "coldstart"
    ? "No window will open: this measures the helper's start and its permission answer.\n"
    : "Windows will open and close. Do not use the machine while it runs.\n");

  const child = spawn("/usr/bin/open", openArgs(bundle, evalEnv(options, outFile, nonce)), {stdio: "inherit"});
  const running = {done: false};
  const finished = waitForExit(child).then((code) => { running.done = true; return code; });
  if (options.mode === "observe" || options.mode === "all") await announceObserveUrls(outDir, running);
  const code = await finished;
  if (code !== 0) { process.stderr.write(`READER_EVAL_FAILED OPEN_EXIT ${code}\n`); process.exit(1); }

  if (!existsSync(outFile)) { process.stderr.write("READER_EVAL_FAILED NO_RESULTS\n"); process.exit(1); }
  let results;
  try {
    results = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    process.stderr.write("READER_EVAL_FAILED UNREADABLE_RESULTS\n");
    process.exit(1);
  }
  process.stdout.write(formatSummary(results));
  process.stdout.write(`results: ${outFile}\n`);
  process.exit(exitCodeFor(results));
}

// `import.meta.main` is not available on this Node, so the program half is gated on argv instead:
// importing this module from a test never opens anything.
if (process.argv[1] && process.argv[1].endsWith("reader-eval.mjs")) {
  await main();
}
