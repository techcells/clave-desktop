// Builds or tests the native reader helper (app/native/reader) with cargo.
// Run from the repo root:  pnpm --dir app build:native   |   pnpm --dir app test:native
//
// cargo is called by absolute path and NEVER touches the network: `--offline --locked` builds from the
// crates already in ~/.cargo at exactly the versions in Cargo.lock. If a crate is missing, this fails —
// downloading is a decision for the owner, not for a build script. CLAVE_CARGO overrides the path.
import {spawnSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync} from "node:fs";
import {homedir} from "node:os";
import {delimiter, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const windows = process.platform === "win32";
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(app, "native/reader/Cargo.toml");
// rustup's own default on Windows is %USERPROFILE%\.cargo\bin; on macOS the toolchain is Homebrew's.
const cargo = process.env.CLAVE_CARGO ?? (windows ? join(homedir(), ".cargo", "bin", "cargo.exe") : "/opt/homebrew/opt/rustup/bin/cargo");
const helperName = windows ? "clave-reader.exe" : "clave-reader";
const testing = process.argv.includes("--test");

if (!existsSync(cargo)) { console.error("BUILD_NATIVE_FAILED CARGO_MISSING", cargo); process.exit(1); }
if (!existsSync(manifest)) { console.error("BUILD_NATIVE_FAILED MANIFEST_MISSING", manifest); process.exit(1); }

// cargo finds rustc through PATH; the toolchain is deliberately not on the user's PATH.
// Windows spells the variable `Path`, and a spread env keeps that spelling: set whichever one is there.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {...process.env, [pathKey]: `${dirname(cargo)}${delimiter}${process.env[pathKey] ?? ""}`};
const args = testing
  ? ["test", "--offline", "--locked", "--manifest-path", manifest]
  : ["build", "--release", "--offline", "--locked", "--manifest-path", manifest];
// Run inside the crate: cargo reads `.cargo/config.toml` from the directory it is started in, not
// from the manifest's, and that file is what links the Windows helper's C runtime statically.
const run = spawnSync(cargo, args, {stdio: "inherit", env, cwd: dirname(manifest)});
if (run.status !== 0) { console.error("BUILD_NATIVE_FAILED CARGO_EXIT", run.status); process.exit(1); }

if (!testing) {
  // `pnpm --dir app build` wipes dist/ and copies the helper in again by itself; this copy is for the
  // case where dist/ already exists and only the helper was rebuilt.
  const built = join(app, "native/reader/target/release", helperName);
  if (existsSync(join(app, "dist"))) {
    mkdirSync(join(app, "dist/native"), {recursive: true});
    cpSync(built, join(app, "dist/native", helperName));
  }
  console.log("BUILD_NATIVE_OK", built);
}
