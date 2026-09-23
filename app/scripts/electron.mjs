// Starts `electron .` from app/ with the given environment switches, on any platform.
//   node scripts/electron.mjs CLAVE_STANDINS=1 CLAVE_SCRIPTED_MODEL=1 [--temp-data-dir]
//
// The package.json scripts used to say `CLAVE_STANDINS=1 electron .`, which only a POSIX shell can
// run; pnpm runs scripts with cmd.exe on Windows. `--temp-data-dir` stands in for
// `CLAVE_DATA_DIR="$(mktemp -d)"`: a fresh, empty data folder the run cannot share with any other.
import {spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {...process.env};
for (const arg of process.argv.slice(2)) {
  if (arg === "--temp-data-dir") { env.CLAVE_DATA_DIR = mkdtempSync(join(tmpdir(), "clave-")); continue; }
  const eq = arg.indexOf("=");
  if (eq <= 0) { console.error("ELECTRON_LAUNCH_BAD_ARG", arg); process.exit(2); }
  env[arg.slice(0, eq)] = arg.slice(eq + 1);
}

// The `electron` package's main export is the path of its binary.
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], {cwd: app, env, stdio: "inherit"});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
