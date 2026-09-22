// Launches the dev bundle with the REAL native reader beside the stand-in backend.
// Run from the repo root:  pnpm --dir app start:reader            (real model)
//                          pnpm --dir app start:reader:scripted   (scripted model, no 2.7 GB file needed)
//
// The bundle must be started through LaunchServices (`open`), never by running its executable from a
// terminal: started from a terminal, macOS attributes screen access to the terminal program and
// nothing observed about the permission would be true of the app (phase 0).
// The bundle's executable keeps the name "Electron" on purpose: that is what makes `app.isPackaged`
// false, and only an unpackaged app reads the development switches passed below.
//
// Before opening the bundle, this also writes <app>/.dev-launch.json, read by app/scripts/dev-launcher.cjs
// (the bundle's actual launcher) on every start. It exists for exactly one case this script itself
// cannot cover: macOS's own "Quit & Reopen" button relaunches the bundle without going through `open
// --env` again, so none of the switches below reach that relaunch. dev-launcher.cjs bakes in working
// defaults for the others, but CLAVE_SCRIPTED_MODEL has no safe default -- scripted and real-model
// launches must each come back in the SAME mode after a bare relaunch, not always one or the other --
// so this file is how "the same mode as last time" survives a relaunch that skips this script entirely.
// Writing it here, not by the launcher, keeps the launcher's write path minimal and this script is the
// only place that already knows which mode was deliberately chosen. The switches are still also passed
// through `--env` below, unchanged: an explicit `open --env` value always wins over anything baked in.
import {spawnSync} from "node:child_process";
import {existsSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(homedir(), "Applications", "Clave Agent Dev.app");
if (!existsSync(bundle)) { console.error("START_READER_FAILED BUNDLE_MISSING run: pnpm --dir app dev:bundle"); process.exit(1); }

const scripted = process.argv.includes("--scripted");
writeFileSync(join(app, ".dev-launch.json"), JSON.stringify(scripted ? {CLAVE_SCRIPTED_MODEL: "1"} : {}) + "\n");

const switches = {
  CLAVE_STANDINS: "1",
  CLAVE_REAL_READER: "1",
  // A fixed folder of its own, so development never touches a real install's data and the log is
  // always in the same place: <this folder>/app.log.
  CLAVE_DATA_DIR: join(homedir(), "Library", "Application Support", "Clave Agent Dev"),
  // Inside the bundle `app.getAppPath()` is the launcher folder, so the fixtures the stand-in backend's
  // companion files sit next to are named explicitly.
  CLAVE_FIXTURES: join(app, "..", "eval", "fixtures"),
  ...(scripted ? {CLAVE_SCRIPTED_MODEL: "1"} : {})
};
const args = ["-n", bundle];
for (const [name, value] of Object.entries(switches)) args.push("--env", `${name}=${value}`);
const run = spawnSync("/usr/bin/open", args, {stdio: "inherit"});
if (run.status !== 0) { console.error("START_READER_FAILED OPEN_EXIT", run.status); process.exit(1); }
console.log("START_READER_OK", bundle);
