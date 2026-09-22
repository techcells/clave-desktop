/**
 * The Electron entry of `reader:eval` — `dist/reader-eval.cjs`, loaded by the granted development
 * bundle instead of the app (`CLAVE_DEV_ENTRY=reader-eval`, see `scripts/dev-launcher.cjs`).
 *
 * It runs inside the bundle because macOS attributes screen access to the app bundle that started
 * the helper: run from a terminal, the grant would be the terminal's, and nothing measured would be
 * true of the product. So this is the reading half, and `scripts/reader-eval.mjs` is the half the
 * owner types.
 *
 * Kept deliberately thin. Everything it does that could be got wrong — the guard, the scoring, the
 * staging commands, what may be written down — lives in the modules beside it and is unit-tested
 * against fakes. What is here is only the parts that need a real machine: an Electron app with no
 * window, a local server, a child process, and one file written at the end.
 *
 * Three refusals, in order, before anything is read:
 *  - the helper does not announce protocol 2      -> `{"error":"PROTOCOL"}` and quit
 *  - the helper does not answer `permission: granted` -> `{"error":"NO_GRANT"}` and quit, in every
 *    mode BUT `coldstart`, whose job is to report that answer rather than to refuse on it — its
 *    verdict in `summary.ts` is what then fails the run. `requestPermission` is NEVER called, in any
 *    mode: raising a system dialog is the app's business, not a measurement harness's.
 *  - the mode or the Chrome variant is not one this harness has
 *                                                 -> `{"error":"HARNESS","code":"BAD_MODE"|"BAD_VARIANT"}`
 *    and quit. This one is refused before anything is staged, and before the two above, because it
 *    is a question about the request rather than about the machine: a run that does not say what to
 *    measure used to measure nothing and report `accepted: true` (see `config.ts`).
 *  - anything at all throws                       -> `{"error":"HARNESS","code":"<fixed code>"}`.
 *    A fixed code, never a message: a message carries paths, and paths carry names.
 */
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {performance} from "node:perf_hooks";
import {app, screen} from "electron";
import {READER_PROTOCOL} from "../main/reader/constants";
import {createChildHelperLink} from "../shell/readerLink";
import {ACCURACY_CASES, TOOLBAR_CASES, allStagedIds, displayRefusal, type TruthName, type WorkArea} from "./cases";
import {stagedTitleFor} from "./stagedTitle";
import type {LimitedRun, ObserveProgressRow} from "./results";
import {NONCE_BYTES, observesWindows, readEvalSettings, stagesWindows} from "./config";
import {
  REVEAL_PARTIAL_SUFFIX,
  createRevealGate,
  expectationOf,
  observeAliveName,
  observeProgressName,
  observeRevealName,
  observeUrlsFile,
  observeUrlsName,
  revealFileNames,
  writeRevealFile,
  type RevealGate
} from "./observe";
import {createEvalHelper, permissionOf, spawnHelper, waitReadyFrom, type EvalHelper} from "./helper";
import {serialiseError, serialiseObserveProgress, serialiseResults, type EvalResults} from "./results";
import {PAGE_SERVER_REFUSAL, createPageServer, type PageServer} from "./server";
import {runMode, type Stager} from "./run";
import {CHROME_PREFERENCES_PATH, evalScratchPaths, TERMINAL_SCRIPT_MODE, type EvalCommand} from "./stage";

import {exploratoryOf, summarise} from "./summary";

const TRUTH_NAMES: readonly TruthName[] = ["chat", "ticket", "code", "pt", "terminal"];

const outFile = process.env.CLAVE_EVAL_OUT ?? "";
const outDir = outFile === "" ? "" : dirname(outFile);
/**
 * Every other setting, checked rather than cast, in `config.ts` where it can be unit-tested. A run
 * whose mode or Chrome variant this harness does not recognise is refused outright below: it used to
 * run nothing and report `accepted: true`.
 */
const configured = readEvalSettings(process.env, () => randomBytes(NONCE_BYTES).toString("hex"));

/**
 * This run's own scratch folder: the Chrome profile and the generated `.command` files, under the
 * OS temp directory and removed when the run ends. Only the results JSON and this run's two
 * nonce-named observe files (`observe-urls-<nonce>.json` and `observe-progress-<nonce>.json`, which
 * the terminal side reads while the run goes) are written into `outDir`. See `evalScratchPaths` for
 * why the profile in particular must not live in the checkout.
 *
 * Its name is a fresh random string rather than the run's `nonce`: the nonce may come from the
 * environment, and a path is not a place to find out what somebody put in it.
 */
const scratch = evalScratchPaths(tmpdir(), randomBytes(6).toString("hex"));
/** Never throws: a scratch folder that will not go is not a reason to fail a run that has finished. */
function removeScratch(): void {
  try { rmSync(scratch.dir, {recursive: true, force: true}); } catch { /* the temp directory's problem */ }
}

/** Written to a temporary name and renamed: a reader of this file never sees half of it. */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}${REVEAL_PARTIAL_SUFFIX}`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function runCommand(command: EvalCommand): Promise<void> {
  return new Promise((resolve) => {
    // `pkill` exits 1 when nothing matched, which is the ordinary case for a teardown after a window
    // has already gone. Every command here is fire-and-forget: a staging that did not happen shows
    // up as `notStaged`, which is a recorded outcome, not an exception.
    const child = spawn(command.program, [...command.args], {stdio: "ignore"});
    child.once("error", () => { resolve(); });
    child.once("exit", () => { resolve(); });
  });
}

/**
 * Did anything match? The exit code, and nothing else: `stdio: "ignore"` means `pgrep`'s output —
 * pids, and with other flags command lines — is never read by this process at all. 0 is a match, 1
 * is none, and anything else (or a spawn that failed) is taken as "none": a wait that cannot ask
 * must not become a wait that never ends.
 */
function commandMatches(command: EvalCommand): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command.program, [...command.args], {stdio: "ignore"});
    child.once("error", () => { resolve(false); });
    child.once("exit", (code) => { resolve(code === 0); });
  });
}

const stager: Stager = {
  run: runCommand,
  matches: commandMatches,
  writeScript: async (name, contents) => {
    const path = join(scratch.dir, name);
    writeFileSync(path, contents, {mode: TERMINAL_SCRIPT_MODE});
    return path;
  },
  writePreferences: async (preferences) => {
    const directory = join(scratch.profileDir, CHROME_PREFERENCES_PATH[0]);
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, CHROME_PREFERENCES_PATH[1]), JSON.stringify(preferences));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The only clock this entry point uses: monotonic, and whole milliseconds.
 *
 * A wall clock can step — an NTP correction, the user changing the time — and a
 * cold helper start is 43-90 s (spec 10.1 item 4), which is long enough for a step to land inside
 * one. A stepped wall clock would put a `readyMs` in the results file that is wrong by the size of
 * the step, or negative; it would also shorten or lengthen the guard's own timeouts mid-poll.
 * `performance.now()` cannot go backwards. Rounded at the reading rather than at the subtraction, so
 * every duration this harness reports is a whole number of milliseconds and no path has to remember
 * to round; the cost is at most one millisecond of precision on a figure measured in seconds.
 */
const now = (): number => Math.round(performance.now());

function readTruth(): Record<TruthName, string> {
  const directory = join(__dirname, "..", "reader-eval", "truth");
  const truth = {} as Record<TruthName, string>;
  for (const name of TRUTH_NAMES) truth[name] = readFileSync(join(directory, `${name}.txt`), "utf8");
  return truth;
}

function startHelper(): EvalHelper {
  // Next to the bundle's own executable: the layout in which the Screen Recording grant was measured
  // to reach the helper (phase 0, P1), and the same path `src/shell/app.ts` uses.
  const helperPath = join(dirname(process.execPath), "clave-reader");
  const link = createChildHelperLink(() => spawn(helperPath, [], {stdio: ["pipe", "pipe", "pipe"]}));
  return createEvalHelper({
    link,
    schedule: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return () => { clearTimeout(timer); };
    }
  });
}

/**
 * `observe` mode's URLs, written as soon as the port is known so the owner can be told what to open.
 *
 * `app` is on every row because the list spans two browsers: the same page, at the same size, is
 * staged once in Safari and once in Chrome, and the owner has to be told which window to put each
 * URL in — the guard compares the app name exactly, so a Chrome case opened in Safari is simply
 * never read.
 *
 * **The file's NAME carries this run's nonce** (finding O3). The terminal side used to wait for a
 * file with a fixed name, find the previous run's already there, and print URLs on an old port under
 * an old nonce — addresses this run could never approve. The rows themselves are built
 * by `observeUrlsFile`, which is pure and tested; this writes them.
 */
function writeObserveUrls(port: number, nonce: string, host: string, expect: string[] | null): void {
  writeAtomic(
    join(outDir, observeUrlsName(nonce)),
    JSON.stringify(observeUrlsFile({port, nonce, host, expect}), null, 2)
  );
}

/**
 * The progress file, rewritten after every read attempt (finding O6).
 *
 * Atomically, like every other file this entry point writes: the terminal side polls it every second
 * while the run is going, and a reader must never see half of it. Its contents are the allow-list's,
 * written out by hand in `serialiseObserveProgress` — case names, fixed outcome codes, booleans and
 * counts, and nothing that was on the screen.
 */
function observeProgressWriter(nonce: string, expect: string[] | null, expected: number) {
  const path = join(outDir, observeProgressName(nonce));
  return (rows: readonly ObserveProgressRow[], done: number): void => {
    // A progress file that cannot be written is not a reason to fail a run that is measuring: the
    // owner loses the running commentary, not the result.
    try {
      writeAtomic(path, serialiseObserveProgress({schema: 1, nonce, expect, expected, done, rows: [...rows]}));
    } catch { /* the terminal side simply sees no new line */ }
  };
}

/**
 * The reveal file (`--reveal-toolbar`), behind the liveness gate.
 *
 * A file of its OWN, beside the results and the progress file and never inside either: this is the
 * one channel in the harness that carries recognised text, and the separation is what makes "the
 * results file is free of it" true by shape rather than by care.
 *
 * Every DECISION about that file — whether to write it, when to delete it, when to stop for good —
 * is in `createRevealGate`, which is pure and unit-tested. What is here is the three lines of `fs`
 * it cannot have: how old the terminal's heartbeat file is, how to write privately and atomically,
 * and how to remove the file and the `.partial` sibling `writeAtomic` leaves if it is interrupted.
 *
 * The WALL clock is read here and nowhere else in this file: every duration this harness reports
 * comes off a
 * monotonic clock (`now()` above), but a file's mtime is a wall-clock stamp and the only thing it
 * can be compared against is the same wall clock. Nothing it decides is a measurement — it decides
 * whether a debug file exists — and `heartbeatFresh` treats a stepped clock's negative age as fresh
 * for exactly that reason. `helper.test.ts` pins the count of wall-clock readings at one.
 */
function revealGateFor(nonce: string): RevealGate {
  const path = join(outDir, observeRevealName(nonce));
  const alivePath = join(outDir, observeAliveName(nonce));
  return createRevealGate(nonce, {
    heartbeatAgeMs: () => {
      try {
        return Date.now() - statSync(alivePath).mtimeMs;
      } catch {
        return null;                                  // no heartbeat file: the terminal is not there
      }
    },
    // 0600, chosen inside `writeRevealFile`: every other file in the out folder is numbers, and
    // this one is not. The mode is not passed from here, so it cannot be dropped from here.
    write: (contents) => {
      try {
        writeRevealFile(path, contents, {writeFile: writeFileSync, rename: renameSync});
      } catch { /* the owner sees no strip */ }
    },
    // Every name this run's strips can be under, the terminal's `.claimed` included: this runs when
    // the heartbeat is stale, so the terminal is five seconds gone and cannot be mid-print of it.
    remove: () => {
      for (const name of revealFileNames(nonce)) {
        try { rmSync(join(outDir, name), {force: true}); } catch { /* the out folder's problem */ }
      }
    }
  });
}

async function main(): Promise<void> {
  app.dock?.hide();
  if (outFile === "") throw new Error("OUT");
  // 0700 on BOTH sides (the terminal's `mkdirSync` says the same): the folder holding the one file
  // that can carry screen text is the owner's alone. It applies when the folder is CREATED — an
  // existing folder keeps the mode it has, which is why this is best-effort and not an assertion
  // about any particular machine.
  mkdirSync(outDir, {recursive: true, mode: 0o700});
  if (!configured.ok) {
    // Before a window is opened, a page served or the helper started: a mode or a variant this
    // harness does not recognise is a caller's mistake, and the one thing it must not become is a
    // run that measures nothing and reports it as a pass.
    writeAtomic(outFile, serialiseError({error: "HARNESS", code: configured.code}));
    return;
  }
  const {mode, nonce, variant, repetitions, seconds, position, limit, expect, host, reveal, notSecure} = configured.settings;
  /**
   * What the `observe` part was asked for, resolved from the case table once: the set names go into
   * the results file, the case names end the run early and are what the verdict is held to.
   * `null` for a run that named nothing, whose verdict is then `EXPLORATORY` (finding O1).
   */
  const observeExpect = expectationOf(expect);
  /**
   * The reveal channel, or nothing at all. Built ONLY when the validated setting says so, so an
   * ordinary run has no gate, no writer and no path — `--reveal-toolbar` is refused outside an
   * exploratory `observe` run and a `toolbar --not-secure` run (`mayReveal` in `config.ts`), so
   * `reveal` is false in every run that could be accepted.
   */
  const revealGate: RevealGate | null = reveal ? revealGateFor(nonce) : null;
  /**
   * The display, asked once, before anything opens.
   *
   * `workArea` is the screen less the menu bar and the Dock, in points — the area a window can
   * actually occupy. Two uses, and both are new on 2026-09-20: a run whose staged window would not
   * fit is REFUSED with a fixed code instead of being staged at whatever size macOS allows (the
   * first run against a screen measured sixteen windows at a size nobody chose and reported every
   * group as a pass), and the numbers go into the staged profile's `browser.window_placement`, which
   * is the mechanism Chrome itself uses to place a window.
   *
   * **The display is the one NEAREST the staging position, not the primary one** (review B,
   * Important 2). `--position` exists to stage on ANOTHER display — it is the only way to measure
   * recognition on the 2x panel (spec 10.1 item 8) — and in macOS's global coordinate space a second
   * display lies outside the primary's work area by definition, so asking the primary would have
   * refused the Retina run before it opened anything, with a code saying the display was too small.
   * `getDisplayNearestPoint` answers with the display the corner is on, or the nearest one when the
   * corner is on none; `fitsWorkArea` then does the rest, and a corner that really does hang the
   * window off that display is `POSITION_OFF_DISPLAY`.
   *
   * Its `scaleFactor` comes back with it, and goes to the run: it is what turns the staged points
   * into the pixels a capture should have, and asking is better than inferring.
   *
   * Only for a mode that stages something. `coldstart` opens no window and asks no display.
   */
  const display = stagesWindows(mode) ? screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt}) : null;
  const workArea: WorkArea | null = display === null
    ? null
    : {
      xPt: display.workArea.x,
      yPt: display.workArea.y,
      widthPt: display.workArea.width,
      heightPt: display.workArea.height
    };
  const displayScale: number | null = display === null ? null : display.scaleFactor;
  if (workArea !== null) {
    const refusal = displayRefusal(workArea, position, [...ACCURACY_CASES.filter(
      (entry): entry is Extract<typeof entry, {kind: "browser"}> => entry.kind === "browser"
    ), ...TOOLBAR_CASES]);
    if (refusal !== null) {
      // Before the helper is spawned and before a page is served: the run cannot be made at the
      // size or the corner it was asked for, and the owner is told which of the two it is rather
      // than being sat through ten minutes of windows whose numbers would all be incomplete.
      writeAtomic(outFile, serialiseError({error: "HARNESS", code: refusal}));
      return;
    }
  }
  /**
   * The staging side of the run, or nothing at all.
   *
   * `coldstart` measures the helper, not the screen: it needs no scratch folder for a Chrome profile
   * and `.command` files, no truth to score against and no page server listening on the loopback
   * address — so none of the three is created for it. `stagesWindows` is the single place that says
   * which modes those are, and `config.test.ts` pins it for every one.
   */
  let staging: {truth: Record<TruthName, string>; server: PageServer} | null = null;
  if (stagesWindows(mode)) {
    mkdirSync(scratch.dir, {recursive: true});    // the profile and the .command files go in here
    const truth = readTruth();
    // Every title this run could mint, so the server's counters are a fixed-size map keyed by this
    // run's own nonce and nothing else.
    const titles = allStagedIds().map((id) => stagedTitleFor(id, nonce));
    try {
      staging = {truth, server: await createPageServer(truth, titles)};
    } catch {
      // Caught HERE rather than by the catch-all at the bottom, which would write the generic
      // `HARNESS` code and leave the owner unable to tell this apart from any other throw. This
      // refusal fires when no matched pair of loopback sockets can be had — most likely because
      // some OTHER local process holds the `::1` port, which is the case in which the staged URLs,
      // nonce and all, would have gone to that process as Chrome's first attempt. It is the one
      // failure that most needs naming.
      writeAtomic(outFile, serialiseError({error: "HARNESS", code: PAGE_SERVER_REFUSAL}));
      return;
    }
  }
  // Before the helper is started, not after: the terminal side gives up watching for this file after
  // twenty seconds, and a cold helper takes up to ninety to say `ready`.
  if (staging && observesWindows(mode)) writeObserveUrls(staging.server.port, nonce, host, expect);
  // The spawn is outside the `try` and the WAIT is inside it, so from the moment a helper process
  // exists it is one the `finally` below will shut down. The clock is read before the spawn, so
  // `readyMs` covers the process creation and the recogniser's warm-up as well as the `ready` line.
  const started = spawnHelper({start: startHelper, now});
  const helper = started.helper;
  try {
    const {ready, readyMs} = await waitReadyFrom(started, now);
    if (!ready.ok || ready.body.protocol !== READER_PROTOCOL) {
      // With the elapsed time: a helper still not ready after the 120 s deadline is exactly what
      // `coldstart` was asked to find out, and a bare code would throw that measurement away.
      writeAtomic(outFile, serialiseError({error: "PROTOCOL", code: "PROTOCOL", readyMs}));
      return;
    }
    // Through the product's own parser and a closed union: what comes back is another process's
    // JSON, and this one goes into the file.
    const permission = permissionOf(await helper.permission());
    if (mode !== "coldstart" && permission !== "granted") {
      writeAtomic(outFile, serialiseError({error: "NO_GRANT", code: "NO_GRANT", readyMs}));
      return;
    }
    const runs = staging === null
      ? {accuracy: [], toolbar: [], observe: []}
      : await runMode(mode, {
        helper,
        stager,
        sleep,
        now,
        nonce,
        port: staging.server.port,
        profileDir: scratch.profileDir,
        truth: staging.truth,
        repetitions,
        variant,
        position,
        workArea,
        displayScale,
        // The page server's own counters, so a `notStaged` row can say whether the browser ever
        // asked for the page it was pointed at.
        pageStats: staging.server.served,
        limit,
        seconds,
        // The observe half of the run: what it is judged on, what host its URLs carried, and where
        // to report each finished case while the owner waits.
        expect: observeExpect === null ? null : observeExpect.cases,
        observeHost: host,
        writeProgress: observesWindows(mode)
          ? observeProgressWriter(nonce, expect, observeExpect === null ? 0 : observeExpect.cases.length)
          : undefined,
        // Absent unless the run asked for it, so an ordinary run shapes nothing and writes nothing —
        // and `reveal` goes with it, because `runObserve` demands BOTH before it shapes a strip.
        reveal,
        writeReveal: reveal ? (rows) => { revealGate?.reveal(rows); } : undefined,
        // `toolbar --not-secure`: the reserved name and the one resolver rule, on the toolbar stagings
        // of the eval's own Chrome and nothing else. The validated boolean, and the same one the
        // results and the verdict below are given.
        notSecure,
      });
    /**
     * What `--limit` cut, counted on the rows the run actually produced against the tables the
     * mode would have staged in full. `null` when nobody asked for a limit, which is the only way
     * a run can be accepted. A mode with no table to cut refuses the option outright
     * (`LIMIT_NOT_APPLICABLE`), so the two counts here are never both zero.
     */
    const limited: LimitedRun | null = limit === null
      ? null
      : {
        reason: "LIMITED",
        cases: runs.accuracy.length + runs.toolbar.length,
        of: (mode === "accuracy" || mode === "all" ? ACCURACY_CASES.length : 0) +
          (mode === "toolbar" || mode === "all" ? TOOLBAR_CASES.length : 0)
      };
    const results: EvalResults = {
      schema: 6,
      // Said once, at the top: every toolbar row of such a run was staged under the reserved name.
      notSecure,
      mode,
      nonce,
      repetitions,
      chromeVariant: variant,
      helper: {readyMs},
      permission,
      // A run that got here has a matched pair of loopback sockets, or no page server at all.
      pageServerIpv6: staging === null ? null : staging.server.ipv6,
      // The corner the Chrome stagings of THIS run were actually put at, default included — and
      // nothing at all for a mode that staged no window.
      position: staging === null ? null : {x: position.xPt, y: position.yPt},
      accuracy: runs.accuracy,
      toolbar: runs.toolbar,
      observe: runs.observe,
      summary: summarise(mode, runs.accuracy, runs.toolbar, runs.observe, {readyMs, permission}, limited, observeExpect, exploratoryOf(notSecure))
    };
    writeAtomic(outFile, serialiseResults(results));
  } finally {
    // However the run ended: if the terminal that asked for the strips is gone, they come off the
    // disk here. If it is still there, the file is left for its final sweep — see `createRevealGate`.
    revealGate?.end();
    helper.shutdown();
    staging?.server.close();
  }
}

void app.whenReady().then(async () => {
  try {
    await main();
  } catch {
    // No message, no stack: the one place a path or a window title could reach a file.
    try { if (outFile !== "") writeAtomic(outFile, serialiseError({error: "HARNESS", code: "HARNESS"})); } catch { /* nothing left to do */ }
  } finally {
    // However the run ended: the profile Chrome wrote, and the scripts, go with it. Here rather than
    // inside `main` so that every path out — the three refusals included — is covered by one line.
    removeScratch();
    app.quit();
  }
});
