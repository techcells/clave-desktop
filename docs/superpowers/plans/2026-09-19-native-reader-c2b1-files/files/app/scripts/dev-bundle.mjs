// Assembles "Clave Agent Dev.app": the development build as macOS needs to see it for Screen Recording.
// Run from the repo root:  pnpm --dir app dev:bundle            (writes to ~/Applications)
//                          pnpm --dir app dev:bundle -- --out <folder>
//
// Why a bundle at all (phase 0, P1/P2): macOS lists, prompts for and lets the user revoke the grant only
// for an app in a location its app registry knows; from a temp folder or `electron .` the entry is
// invisible and the grant is attributed to whatever launched the process. The grant given to the bundle
// reaches the helper because the helper is started by the bundle's own process, and it survives
// rebuilding and re-signing with the same certificate.
//
// The bundle is a thin launcher: its main.js requires THIS checkout's app/scripts/dev-launcher.cjs by
// absolute path, which in turn requires app/dist/main.cjs, so rebuilding the app never requires
// rebuilding the bundle, and node-llama-cpp resolves from app/node_modules as usual. The indirection
// through dev-launcher.cjs (instead of requiring dist/main.cjs directly, as this script used to) is
// because macOS's own "Quit & Reopen" button -- offered after granting Screen Recording -- relaunches
// this bundle without going through `open --env`, so the development switches start-reader.mjs passes
// are missing on that relaunch; dev-launcher.cjs bakes working defaults in so the app still starts (see
// that file). Only the helper lives inside the bundle, next to the executable, because that is the
// layout that was measured. Re-run this script after `build:native`.
import {execFileSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "Clave Agent Dev";
const BUNDLE_ID = "dev.clave.agent.dev";

/**
 * Where this run writes, and whether that is the DEFAULT bundle.
 *
 * The question the guard below turns on is the DESTINATION, never the spelling of the command line:
 * `--out` with no path after it falls back to ~/Applications (see the fallback below), and
 * `--out ~/Applications` names it outright. Deciding on "was `--out` given" left both of those
 * writing to the granted bundle with the guard switched off. A `~` the shell did not expand is
 * expanded here for the same reason: it is the same destination to the person typing it.
 */
export function resolveOutDir(argv, home) {
  const defaultDir = resolve(join(home, "Applications"));
  const at = argv.indexOf("--out");
  const given = at >= 0 ? argv[at + 1] : undefined;
  const named = given === "~" ? home : given && given.startsWith("~/") ? join(home, given.slice(2)) : given;
  const dir = named ? resolve(named) : defaultDir;
  return {dir, defaultLocation: dir === defaultDir};
}

/**
 * What `pgrep`'s answer means for the build about to replace the bundle: `proceed`, `running`
 * (refuse, the app is up) or `unanswered` (refuse, the check did not happen).
 *
 * Pure, and exported, so the decision is unit-tested (scripts/dev-bundle.test.ts) without this
 * script ever running a process or touching a bundle.
 *
 * Only two answers are determinations: exit status 1 is pgrep's "nothing matched", and exit status 0
 * with at least one pid on stdout is "something is running from inside this bundle". EVERYTHING else
 * — status 2, a pgrep that could not be spawned at all (`status` is then null), even a status 0 that
 * names nobody — is the check not having run, and that refuses too. This is the step on which the
 * Screen Recording grant was lost once already, and it is run by hand immediately before a first-run
 * session: a guard that quietly degrades to no guard is worse than no guard, because the person
 * reading the output has no way to tell which one they got.
 *
 * A `--out` build is never refused: it is a copy somewhere else, that nothing has been granted to
 * and nothing is running from, so neither a running app nor an unanswered check says anything about it.
 */
export function runningAppCheck({defaultLocation, status, output}) {
  if (!defaultLocation) return "proceed";
  if (status === 1) return "proceed";
  if (status === 0 && output.split("\n").some((line) => line.trim() !== "")) return "running";
  return "unanswered";
}

function buildBundle() {
  const IDENTITY = process.env.CLAVE_SIGN_IDENTITY ?? "Clave Agent Dev";
  const {dir: outDir, defaultLocation} = resolveOutDir(process.argv, homedir());
  const bundle = join(outDir, `${NAME}.app`);

  const electron = join(app, "node_modules/electron/dist/Electron.app");
  const helper = join(app, "native/reader/target/release/clave-reader");
  const main = join(app, "dist/main.cjs");
  const launcher = join(app, "scripts/dev-launcher.cjs");
  const fail = (code, detail) => { console.error("DEV_BUNDLE_FAILED", code, detail ?? ""); process.exit(1); };
  if (process.platform !== "darwin") fail("NOT_MACOS");
  if (!existsSync(electron)) fail("ELECTRON_MISSING", electron);
  if (!existsSync(helper)) fail("HELPER_MISSING", "run: pnpm --dir app build:native");
  if (!existsSync(main)) fail("DIST_MISSING", "run: pnpm --dir app build");
  if (!existsSync(launcher)) fail("LAUNCHER_MISSING", launcher);

  const run = (file, args) => execFileSync(file, args, {stdio: ["ignore", "pipe", "pipe"]}).toString();

  // The app must not have its bundle replaced under it: macOS attributes the Screen Recording grant
  // to the bundle at this path, and swapping the executable out from under the running process is how
  // that grant was lost once already (first-run record: PERMISSION_LOST). `pgrep -f` on this bundle's
  // own Contents/MacOS path matches a process whose executable lives inside THIS bundle and nothing
  // else. Checked before anything is removed, written or signed.
  let probe = {defaultLocation, status: 1, output: ""};
  try { probe = {...probe, status: 0, output: run("/usr/bin/pgrep", ["-f", join(bundle, "Contents/MacOS")])}; }
  catch (error) { probe = {...probe, status: Number.isInteger(error?.status) ? error.status : null, output: String(error?.stdout ?? "")}; }
  const answer = runningAppCheck(probe);
  if (answer === "running") fail("APP_RUNNING", `quit "${NAME}" first`);
  if (answer === "unanswered") fail("PGREP_UNANSWERED");
  try { run("/usr/bin/security", ["find-identity", "-p", "codesigning"]).includes(`"${IDENTITY}"`) || fail("IDENTITY_MISSING", IDENTITY); }
  catch { fail("IDENTITY_LOOKUP_FAILED"); }

  // Only ever replaces a bundle this script made: same name AND our bundle id.
  const plist = join(bundle, "Contents/Info.plist");
  if (existsSync(bundle)) {
    let id = "";
    try { id = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]).trim(); } catch { /* not a bundle we know */ }
    if (id !== BUNDLE_ID) fail("REFUSING_TO_REPLACE", bundle);
    rmSync(bundle, {recursive: true, force: true});
  }
  mkdirSync(outDir, {recursive: true});
  cpSync(electron, bundle, {recursive: true, verbatimSymlinks: true});
  for (const [key, value] of [["CFBundleIdentifier", BUNDLE_ID], ["CFBundleName", NAME], ["CFBundleDisplayName", NAME]]) {
    run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }

  const resources = join(bundle, "Contents/Resources/app");
  mkdirSync(resources, {recursive: true});
  writeFileSync(join(resources, "package.json"), JSON.stringify({name: "clave-agent-dev", version: "0.0.0", main: "main.js"}) + "\n");
  writeFileSync(join(resources, "main.js"), `// Generated by app/scripts/dev-bundle.mjs. Requires the checkout's dev launcher, not dist/main.cjs\n// directly: macOS's own "Quit & Reopen" relaunches this bundle without \`open --env\`, and only the\n// launcher bakes the development switches back in. See app/scripts/dev-launcher.cjs.\nrequire(${JSON.stringify(launcher)});\n`);
  cpSync(helper, join(bundle, "Contents/MacOS/clave-reader"));

  // Inside out: the helper first, then the bundle around it.
  run("/usr/bin/codesign", ["--force", "--sign", IDENTITY, join(bundle, "Contents/MacOS/clave-reader")]);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", IDENTITY, bundle]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  console.log("DEV_BUNDLE_OK", bundle);
}

// `import.meta.main` is not available on this Node, so the program half is gated on argv instead:
// importing this module from a test never builds, signs or replaces anything. It once did -- a test
// that imported this file for the pure function above rebuilt ~/Applications/Clave Agent Dev.app on
// the spot -- which is why the gate is here and not merely a convention.
if (process.argv[1] && process.argv[1].endsWith("dev-bundle.mjs")) {
  buildBundle();
}
