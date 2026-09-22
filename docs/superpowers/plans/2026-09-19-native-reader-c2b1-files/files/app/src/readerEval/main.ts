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
 *  - the helper does not answer `permission: granted` -> `{"error":"NO_GRANT"}` and quit.
 *    `requestPermission` is NEVER called: raising a system dialog is the app's business, not a
 *    measurement harness's.
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
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {app} from "electron";
import {READER_PROTOCOL} from "../main/reader/constants";
import {createChildHelperLink} from "../shell/readerLink";
import type {TruthName} from "./cases";
import {readEvalSettings} from "./config";
import {createEvalHelper, type EvalHelper} from "./helper";
import {serialiseError, serialiseResults, type EvalResults} from "./results";
import {createPageServer} from "./server";
import {runAccuracy, runObserve, runToolbar, type Stager} from "./run";
import {CHROME_PREFERENCES_PATH, evalScratchPaths, TERMINAL_SCRIPT_MODE, type EvalCommand} from "./stage";
import {stagedTitleFor} from "./stagedTitle";
import {summarise} from "./summary";
import {OBSERVE_CASES} from "./cases";

const TRUTH_NAMES: readonly TruthName[] = ["chat", "ticket", "code", "pt", "terminal"];

const outFile = process.env.CLAVE_EVAL_OUT ?? "";
const outDir = outFile === "" ? "" : dirname(outFile);
/**
 * Every other setting, checked rather than cast, in `config.ts` where it can be unit-tested. A run
 * whose mode or Chrome variant this harness does not recognise is refused outright below: it used to
 * run nothing and report `accepted: true`.
 */
const configured = readEvalSettings(process.env, () => randomBytes(6).toString("hex"));

/**
 * This run's own scratch folder: the Chrome profile and the generated `.command` files, under the
 * OS temp directory and removed when the run ends. Only the results JSON (and `observe-urls.json`,
 * which the owner reads) is written into `outDir`. See `evalScratchPaths` for why the profile in
 * particular must not live in the checkout.
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
  const temporary = `${path}.partial`;
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

const stager: Stager = {
  run: runCommand,
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

/** `observe` mode's URLs, written as soon as the port is known so the owner can be told what to open. */
function writeObserveUrls(port: number, nonce: string): void {
  writeAtomic(join(outDir, "observe-urls.json"), JSON.stringify({
    port,
    nonce,
    urls: OBSERVE_CASES.map((theCase) => ({
      case: theCase.name,
      expectPrivate: theCase.expectPrivate,
      url: `http://127.0.0.1:${port}/${theCase.page}.html?theme=${theCase.theme}&size=${theCase.sizePx}` +
        `&stagedTitle=${encodeURIComponent(stagedTitleFor(theCase.name, nonce))}`
    }))
  }, null, 2));
}

async function main(): Promise<void> {
  app.dock?.hide();
  if (outFile === "") throw new Error("OUT");
  mkdirSync(outDir, {recursive: true});
  if (!configured.ok) {
    // Before a window is opened, a page served or the helper started: a mode or a variant this
    // harness does not recognise is a caller's mistake, and the one thing it must not become is a
    // run that measures nothing and reports it as a pass.
    writeAtomic(outFile, serialiseError({error: "HARNESS", code: configured.code}));
    return;
  }
  const {mode, nonce, variant, repetitions, seconds} = configured.settings;
  mkdirSync(scratch.dir, {recursive: true});      // the profile and the .command files go in here
  const truth = readTruth();
  const server = await createPageServer(truth);
  if (mode === "observe" || mode === "all") writeObserveUrls(server.port, nonce);
  const helper = startHelper();
  try {
    const ready = await helper.waitReady();
    if (!ready.ok || ready.body.protocol !== READER_PROTOCOL) {
      writeAtomic(outFile, serialiseError({error: "PROTOCOL", code: "PROTOCOL"}));
      return;
    }
    const permission = await helper.permission();
    if (!permission.ok || permission.body.permission !== "granted") {
      writeAtomic(outFile, serialiseError({error: "NO_GRANT", code: "NO_GRANT"}));
      return;
    }
    const deps = {
      helper,
      stager,
      sleep,
      now: () => Date.now(),
      nonce,
      port: server.port,
      profileDir: scratch.profileDir,
      truth,
      repetitions,
      variant
    };
    const observeRan = mode === "observe" || mode === "all";
    const accuracy = mode === "accuracy" || mode === "all" ? await runAccuracy(deps) : [];
    const toolbar = mode === "toolbar" || mode === "all" ? await runToolbar(deps) : [];
    const observe = observeRan ? await runObserve({...deps, seconds}) : [];
    const results: EvalResults = {
      schema: 1,
      mode,
      nonce,
      repetitions,
      chromeVariant: variant,
      accuracy,
      toolbar,
      observe,
      summary: summarise(mode, accuracy, toolbar, observe)
    };
    writeAtomic(outFile, serialiseResults(results));
  } finally {
    helper.shutdown();
    server.close();
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
