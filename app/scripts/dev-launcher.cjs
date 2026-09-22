// The dev bundle's ACTUAL launcher. Lives in the CHECKOUT (app/scripts/dev-launcher.cjs) and is
// never copied into the bundle: dev-bundle.mjs writes the bundle's Contents/Resources/app/main.js as
// a one-line `require()` of this file's absolute checkout path (see that script). Why a launcher
// file at all, instead of main.js requiring app/dist/main.cjs directly as it used to: start-reader.mjs
// passes the development switches (CLAVE_STANDINS, CLAVE_REAL_READER, CLAVE_DATA_DIR, CLAVE_FIXTURES,
// CLAVE_SCRIPTED_MODEL) via `open --env`, but macOS's own "Quit & Reopen" button -- offered after the
// user grants Screen Recording -- relaunches the bundle itself, WITHOUT going through `open --env`
// again, and the app then refuses to start with NO_READER_YET (design doc section 8, C-2a gap; review
// 2026-09-19 item 15). This file bakes the same switches in as defaults so a bare relaunch still
// starts in a working mode, and remembers CLAVE_SCRIPTED_MODEL -- the one switch whose value changes
// which mode "still working" means -- via a small JSON file start-reader.mjs writes before every
// deliberate launch.
//
// `resolveLaunch` below is pure (no fs, no process.env mutation, no require) so it is unit-tested
// directly, in plain Node, without Electron and without touching the real filesystem. Everything
// below it is the impure shell that only ever runs for real: it is gated on `process.versions.electron`
// being set, which is true exactly when this file is loaded inside the bundle's Electron process (the
// only place it is ever required as the launcher) and false under plain Node/vitest, so requiring this
// module from a test never tries to read `.dev-launch.json` from the real checkout or `require()` a
// dist file that may not exist yet.

"use strict";

const path = require("node:path");

// The switches that always need SOME value for the app to start unpackaged with the real reader.
// Keep this in sync with start-reader.mjs's own `switches` object -- that script still passes all of
// these explicitly through `open --env` too (explicit beats implicit; see precedence below), so this
// is only the fallback for a relaunch that skips `open` entirely.
function bakedDefaults(home, appDir) {
  return {
    CLAVE_STANDINS: "1",
    CLAVE_REAL_READER: "1",
    // Same fixed folder start-reader.mjs points at, so a relaunch never touches a real install's data.
    CLAVE_DATA_DIR: path.join(home, "Library", "Application Support", "Clave Agent Dev"),
    // appDir is the checkout's app/ folder (see resolveLaunch's caller below), so this resolves the
    // same way start-reader.mjs's CLAVE_FIXTURES does.
    CLAVE_FIXTURES: path.join(appDir, "..", "eval", "fixtures")
  };
}

/**
 * Pure. Decides what environment a relaunch should run with and which file to boot.
 *
 * Precedence per baked-default key: an own property already on `env` wins; otherwise the baked
 * default. CLAVE_SCRIPTED_MODEL has no baked default -- it is either present (env, or else a
 * validated `lastLaunch`) or simply left out of `set` altogether, which leaves the app in its own
 * default (real model).
 *
 * `lastLaunch` is whatever JSON.parse produced from a file on disk -- untrusted. The ONLY thing ever
 * accepted from it is the exact key CLAVE_SCRIPTED_MODEL holding the exact string "1"; every other
 * key or value in that object (CLAVE_DEV_ENTRY included) is ignored, on purpose, so a stray or
 * tampered file can only ever turn scripted mode on, never redirect an entry point or any other switch.
 *
 * @param {{env: Record<string, string|undefined>, lastLaunch: unknown, appDir: string, home: string}} args
 * @returns {{set: Record<string, string>, entry: string}}
 */
function resolveLaunch({env, lastLaunch, appDir, home}) {
  const defaults = bakedDefaults(home, appDir);
  const set = {};
  for (const key of Object.keys(defaults)) {
    set[key] = Object.hasOwn(env, key) ? env[key] : defaults[key];
  }

  if (Object.hasOwn(env, "CLAVE_SCRIPTED_MODEL")) {
    set.CLAVE_SCRIPTED_MODEL = env.CLAVE_SCRIPTED_MODEL;
  } else if (
    lastLaunch !== null && typeof lastLaunch === "object" && !Array.isArray(lastLaunch) &&
    Object.hasOwn(lastLaunch, "CLAVE_SCRIPTED_MODEL") && lastLaunch.CLAVE_SCRIPTED_MODEL === "1"
  ) {
    set.CLAVE_SCRIPTED_MODEL = "1";
  }

  // CLAVE_DEV_ENTRY is never read from lastLaunch, and only this one exact value redirects the entry
  // point -- a later task builds dist/reader-eval.cjs; anything else (including a bad/missing file)
  // falls back to the app's normal entry.
  const entry = Object.hasOwn(env, "CLAVE_DEV_ENTRY") && env.CLAVE_DEV_ENTRY === "reader-eval"
    ? path.join(appDir, "dist", "reader-eval.cjs")
    : path.join(appDir, "dist", "main.cjs");

  return {set, entry};
}

// --- Everything below only ever runs inside the bundle's Electron process; see the header note. ---
if (process.versions.electron) {
  const fs = require("node:fs");
  const os = require("node:os");

  const appDir = path.join(__dirname, "..");

  // Missing, unreadable, or not a JSON object: treat exactly like no last launch at all. This file is
  // written by start-reader.mjs, but it is still a file on disk -- never let a read failure here stop
  // the app from starting.
  let lastLaunch = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appDir, ".dev-launch.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) lastLaunch = parsed;
  } catch {
    lastLaunch = {};
  }

  const {set, entry} = resolveLaunch({env: process.env, lastLaunch, appDir, home: os.homedir()});
  // Only fill in what is not already set: an explicit `open --env` value (or anything else already in
  // this process's environment) always wins over what we would bake in.
  for (const [key, value] of Object.entries(set)) {
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
  require(entry);
}

module.exports = {resolveLaunch};
