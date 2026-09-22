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

export const MODES = ["accuracy", "toolbar", "observe", "all"];
export const VARIANTS = ["none", "bookmarks-bar"];

export const USAGE = `usage: pnpm --dir app reader:eval -- <mode> [options]

  modes
    accuracy   the staged pages and the two terminals, scored (default)
    toolbar    40 Chrome stagings: address host and the private badge
    observe    windows the OWNER stages by hand (Safari, private windows); a window
               staged private that shows no private marker fails the run, and so
               does a normal one flagged private
    all        all three, in that order

  options
    --repetitions <n>   reads per accuracy case (default 5)
    --seconds <n>       how long observe mode watches (default 120)
    --variant <name>    ${VARIANTS.join(" | ")} (default none)

  Nothing is read but a window this harness staged and identified by a one-run title.
`;

/**
 * The command line. Pure.
 *
 * `pnpm ... -- <mode>` hands this script a leading `--`, so that is dropped rather than mistaken for
 * the mode, exactly as the model gate's own parser does.
 */
export function parseEvalArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const options = {mode: "accuracy", repetitions: 5, seconds: 120, variant: "none"};
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
    if (flag === "--variant") {
      if (!VARIANTS.includes(value)) return {ok: false, problem: flag};
      options.variant = value;
      index += 1;
      continue;
    }
    return {ok: false, problem: flag};
  }
  if (!MODES.includes(options.mode)) return {ok: false, problem: options.mode};
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
  return {
    CLAVE_DEV_ENTRY: "reader-eval",
    CLAVE_EVAL_MODE: options.mode,
    CLAVE_EVAL_OUT: outFile,
    CLAVE_EVAL_NONCE: nonce,
    CLAVE_EVAL_REPETITIONS: String(options.repetitions),
    CLAVE_EVAL_SECONDS: String(options.seconds),
    CLAVE_EVAL_VARIANT: options.variant
  };
}

const pad = (value, width) => String(value).padEnd(width);
const num = (value, digits = 4) => (typeof value === "number" ? value.toFixed(digits) : "-");

/** The summary table and the verdicts. Pure: it is handed the parsed results and returns text. */
export function formatSummary(results) {
  if (results && typeof results === "object" && typeof results.error === "string") {
    // The code is the useful half whenever the error is the catch-all HARNESS: BAD_MODE and
    // BAD_VARIANT both arrive that way, and "the harness failed" alone would not tell the owner that
    // it was the CALL that was wrong. When the two are the same word, once is enough.
    const code = typeof results.code === "string" && results.code !== results.error ? ` ${results.code}` : "";
    return `READER_EVAL_FAILED ${results.error}${code}\n`;
  }
  const lines = [];
  const accuracy = Array.isArray(results.accuracy) ? results.accuracy : [];
  if (accuracy.length > 0) {
    lines.push(`case                      min      median   accents  outcomes`);
    for (const entry of accuracy) {
      const outcomes = (entry.repetitions ?? []).map((r) => r.outcome).join(",");
      lines.push(`${pad(entry.case, 25)} ${pad(num(entry.minAccuracy), 8)} ${pad(num(entry.medianAccuracy), 8)} ${pad(num(entry.minAccents), 8)} ${outcomes}`);
    }
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
  lines.push("");
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
        process.stdout.write("\nOpen these in Safari, one at a time, and leave each in front for a few seconds.\n");
        for (const entry of urls) {
          process.stdout.write(`  ${entry.expectPrivate ? "PRIVATE window" : "normal window "}  ${entry.url}\n`);
        }
        process.stdout.write("\n");
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
  process.stdout.write("Windows will open and close. Do not use the machine while it runs.\n");

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
