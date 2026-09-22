# C-2b-1 Task 3 -- dev bundle bakes its development switches into its launcher

Scratch copy: `$S/ws/app` (S = `/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad`).
Real repo (read only): `/Users/sardorastanov/techcells/asset-to-evidence`.

## Files changed / added

- **Added** `app/scripts/dev-launcher.cjs` (111 lines). CommonJS, lives in the checkout. Exports the
  pure function `resolveLaunch({env, lastLaunch, appDir, home}) -> {set, entry}`. The bottom of the
  file (guarded by `if (process.versions.electron)`) reads `<appDir>/.dev-launch.json`, calls
  `resolveLaunch`, fills in whichever `process.env` keys are not already own-set, and `require(entry)`.
- **Added** `app/scripts/dev-launcher.test.ts` (127 lines, 13 tests, all passing).
- **Edited** `app/scripts/dev-bundle.mjs`: generated `Contents/Resources/app/main.js` is now
  `require("<absolute path to checkout's app/scripts/dev-launcher.cjs>")` instead of
  `require("<absolute path to app/dist/main.cjs>")`; added a `LAUNCHER_MISSING` fail-fast check
  alongside the existing `ELECTRON_MISSING` / `HELPER_MISSING` / `DIST_MISSING` checks; updated the
  file's top comment and the "why a bundle at all" paragraph to explain the indirection.
- **Edited** `app/scripts/start-reader.mjs`: writes `<app>/.dev-launch.json` (checkout app dir, not
  inside the bundle) to `{"CLAVE_SCRIPTED_MODEL":"1"}` when `--scripted` is passed, else `{}`, before
  calling `open`. Still passes all switches through `--env` exactly as before (explicit beats
  implicit -- unchanged). Updated the header comment to explain the new write and why it lives here
  rather than in the launcher.
- **Edited** `app/vitest.config.ts`: `test.include` extended from `["src/**/*.test.ts"]` to
  `["src/**/*.test.ts", "scripts/**/*.test.ts"]` -- there was no other way to get
  `dev-launcher.test.ts` picked up, since it can't live under `src/**` (those directories are the
  other concurrent agent's territory, and `dev-launcher.cjs` itself belongs next to the other
  `app/scripts/*.mjs` files it mirrors, not under `src/`).

`app/tsconfig.json` was **not** touched (not on the touch list, and turned out not to need it -- see
below).

## Design decisions / precedence, as implemented

- Four baked defaults, each independently overridable by an `env` own-property:
  `CLAVE_STANDINS=1`, `CLAVE_REAL_READER=1`,
  `CLAVE_DATA_DIR=<home>/Library/Application Support/Clave Agent Dev`,
  `CLAVE_FIXTURES=<appDir>/../eval/fixtures`.
- `CLAVE_SCRIPTED_MODEL` has **no** baked default: `env` wins if present; else a `lastLaunch` object
  whose own `CLAVE_SCRIPTED_MODEL` property is the exact string `"1"`; else it is left out of `set`
  entirely (the app's own default, real model, applies).
- Every other key/value in `lastLaunch` -- including a same-named `CLAVE_DATA_DIR`, `CLAVE_SMOKE`, or
  `CLAVE_DEV_ENTRY` -- is ignored. `lastLaunch` that is `null`, an array, or a non-object is treated
  exactly like `{}`.
- `entry` is `<appDir>/dist/main.cjs` unless `env.CLAVE_DEV_ENTRY` (own property) is the **exact**
  string `"reader-eval"`, in which case it is `<appDir>/dist/reader-eval.cjs`. `CLAVE_DEV_ENTRY` is
  never taken from `lastLaunch`.
- Inherited (prototype) properties on `env` or `lastLaunch` never count as "set" -- checked with
  `Object.hasOwn` throughout, matching the existing convention in `src/shell/devEnv.ts`.

## Test count

**13 tests, all passing**, in `app/scripts/dev-launcher.test.ts`, run with:
```
node <repo>/app/node_modules/vitest/vitest.mjs run --root $S/ws/app scripts/dev-launcher.test.ts
```
Result: `Test Files 1 passed (1)`, `Tests 13 passed (13)`.

Typecheck: `node <repo>/app/node_modules/typescript/bin/tsc --noEmit -p $S/ws/app/tsconfig.json`.
`app/tsconfig.json`'s `include` is `src/**/*.ts` only, so `app/scripts/**` -- `.mjs`, `.cjs`, and the
new `.test.ts` alike -- is out of that config's scope entirely, same as the pre-existing `.mjs`
scripts in that folder; there was nothing to reconcile about importing a `.cjs` from a `.ts` test
because the file was never going to be typechecked by the project config either way. Vitest itself
only transpiles (esbuild), never typechecks, so the CommonJS interop
(`import * as launcher from "./dev-launcher.cjs"`, then destructuring `resolveLaunch` off it, typed by
hand in the test) runs cleanly regardless.

This ran clean (exit 0, no errors) the first several times during this task. A later run, taken right
before writing this report, shows ~30 `TS2741`/`TS2345`/`TS2304` errors, all in
`src/main/reader/readerClient.ts`, `src/main/reader/protocol.test.ts`, `src/main/capture/loop.ts`,
`src/shell/readerLink.test.ts`, `src/standins/standins.test.ts` and their `*.test.ts` siblings (an
`expect: FrontWindow` property newly required on a `read` op's argument, missing at several call
sites, plus an undefined `onTheWire` reference) -- all inside the directories the brief names as the
concurrent agent's territory (`src/main/**`, `src/standins/**`, `src/shell/readerLink*`), mid-edit.
**None of these errors are in any file this task touched**; confirmed by grepping the error list for
`scripts/` (no matches). Reporting this only because the brief asked to run the typecheck and report
what's found; not something to fix here.

## Mutation table (prove the tests bite)

Procedure per row: `cp dev-launcher.cjs dev-launcher.cjs.bak`, edit in place, run the test file, record
failures, `cp .bak` back over the file, `cmp` to confirm byte-identical restoration, delete the `.bak`.

| # | Mutation | Result | Failing test(s) |
|---|---|---|---|
| a | Accept every key from `lastLaunch` (not just `CLAVE_SCRIPTED_MODEL="1"`) -- replaced the whitelist check with `Object.assign(set, lastLaunch)` | **FAIL** (2 tests) | `ignores every OTHER key in lastLaunch, even ones that share a name with a real switch`; `ignores a lastLaunch CLAVE_SCRIPTED_MODEL value other than the exact string "1"` |
| b | Let `lastLaunch` override `env` -- swapped the `if`/`else if` order so the `lastLaunch` branch is checked first | **FAIL** (1 test) | `an env value for CLAVE_SCRIPTED_MODEL wins over lastLaunch` |
| c | Accept any `CLAVE_DEV_ENTRY` value as a path -- `path.join(appDir, "dist", \`${env.CLAVE_DEV_ENTRY}.cjs\`)` whenever the key is present, dropping the `=== "reader-eval"` check | **FAIL** (1 test, loop stops at first bad value) | `any other CLAVE_DEV_ENTRY value, from env, falls back to the main entry` |
| d | Drop the baked `CLAVE_REAL_READER` default -- removed the key from `bakedDefaults`'s return object | **FAIL** (3 tests) | `bakes in all four defaults and the main entry when nothing else is set`; `an env value already set wins over the baked default, for each of the four keys`; `ignores every OTHER key in lastLaunch, even ones that share a name with a real switch` |

After each mutation and restore, `cmp` reported the restored file byte-identical to the pre-mutation
backup; the final `dev-launcher.cjs` on disk is the un-mutated version, re-verified green (13/13) and
typecheck-clean after the last restore.

## The exact generated `main.js` text

From the scratch checkout (`$S/ws/app`), what `dev-bundle.mjs` would write to
`Contents/Resources/app/main.js`:

```js
// Generated by app/scripts/dev-bundle.mjs. Requires the checkout's dev launcher, not dist/main.cjs
// directly: macOS's own "Quit & Reopen" relaunches this bundle without `open --env`, and only the
// launcher bakes the development switches back in. See app/scripts/dev-launcher.cjs.
require("/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/ws/app/scripts/dev-launcher.cjs");
```

(In the real repo this would instead be
`require("/Users/sardorastanov/techcells/asset-to-evidence/app/scripts/dev-launcher.cjs");` -- same
template, different absolute path.) This text was generated by running the exact same
`JSON.stringify(launcher)` / template-literal expression `dev-bundle.mjs` uses, in isolation, so it did
not depend on the electron/helper/dist artefacts described next.

## Scratch bundle dry-run: NOT done

`node $S/ws/app/scripts/dev-bundle.mjs --out $S/bundle-test` was **not** run. Checked prerequisites in
the scratch copy:

- `$S/ws/app/node_modules/electron/dist/Electron.app` -- **present** (via the `node_modules` symlink).
- `$S/ws/app/dist/main.cjs` -- **absent**. The scratch copy has no `dist/` at all yet.
- `$S/ws/app/native/reader/target/release/clave-reader` -- **absent**. No `native/reader/target` in
  the scratch copy at all.

Both missing artefacts exist in the real repo (`$R/app/dist/main.cjs`,
`$R/app/native/reader/target/release/clave-reader`). The brief allows pointing the dry-run at the real
repo's artefacts "ONLY IF that is clean" via temporary env vars. I judged it **not clean**:
`dev-bundle.mjs`'s path resolution (`electron`, `helper`, `main`) is currently three unconditional
`join(app, ...)` expressions with no override hook, and this task's own scope is the launcher
indirection, not adding an env-var escape hatch to the bundling script for a one-off manual test --
that would be scope creep into a script whose only in-scope change here is the `main.js` content and
the new `LAUNCHER_MISSING` check. So, per the brief's fallback: **skipped the dry-run** and instead
verified:

1. The generated `main.js` text directly (above), by running the same code `dev-bundle.mjs` runs to
   build it.
2. `LAUNCHER_MISSING`'s check (`if (!existsSync(launcher)) fail("LAUNCHER_MISSING", launcher)`) by
   code inspection -- it is textually identical in form to the three checks already in the file
   (`ELECTRON_MISSING`, `HELPER_MISSING`, `DIST_MISSING`), all of which are exercised together every
   real run of this script, so this is high-confidence without a live run.
3. `resolveLaunch`'s behaviour -- the part that actually matters for whether a bare "Quit & Reopen"
   relaunch works -- through the 13 unit tests and the four mutations above, which is the "verify
   through a unit-testable function instead" fallback the brief names explicitly.

No `DEV_BUNDLE_OK` / codesign output to report; no `$S/bundle-test` folder was created, so nothing
needed deleting.

## Decisions made, with cost if wrong

1. **The auto-apply side effect at the bottom of `dev-launcher.cjs` is gated on
   `process.versions.electron` being set**, rather than on `require.main === module` or any other
   mechanism. Reasoning: `dev-launcher.cjs` is *always* `require()`'d by something else (the bundle's
   generated `main.js`, or -- in tests -- `dev-launcher.test.ts`), so it is never Node's
   `require.main` in either case; `require.main === module` would in fact be `false` in the real
   bundle too, since `require.main` there is the bundle's `main.js`. `process.versions.electron` is
   `undefined` under plain Node (verified: `node -e "console.log(process.versions.electron)"` prints
   `undefined`) and a version string when Electron loads the file, which is exactly the "am I really
   the launcher" question this needs answered, and is the only place this file is ever required as the
   launcher per the brief. **Cost if wrong:** if this file were ever required from a plain-Node context
   that was *meant* to be a real launch (not a test), the auto-apply would silently no-op -- nothing
   would happen, no crash, no `require(entry)`. That failure mode is loud in practice (the app simply
   never starts), and the design's only real invocation path is Electron-loaded, so I judged this safe.
2. **`vitest.config.ts`'s `include` was extended** rather than left alone, because there was no
   directory under `src/**` this test could live in without colliding with the other agent's scope or
   contradicting the design's explicit file path (`app/scripts/dev-launcher.cjs`, a sibling of the
   other `.mjs` build scripts, not part of the `src/` tree that gets bundled). **Cost if wrong:** a
   future stray `*.test.ts` anywhere under `app/scripts/` would now also be picked up by `vitest run`;
   low risk, easy to narrow later if it matters.
3. **Kept `dev-bundle.mjs`'s `DIST_MISSING` (main.cjs) check** even though the generated `main.js` no
   longer references `dist/main.cjs` directly at bundle-build time (only `dev-launcher.cjs` does, at
   run time). Reasoning: a bundle built without `dist/main.cjs` present would be non-functional the
   moment it's launched, so failing fast at bundle-build time is still the right UX. **Cost if wrong:**
   none functionally -- worst case it's a redundant check that could be dropped later.
4. **`.dev-launch.json` is written to the checkout's `app/` root** (`join(app, ".dev-launch.json")` in
   `start-reader.mjs`, i.e. a sibling of `package.json`), not inside the bundle. This has to match
   where `dev-launcher.cjs` reads it from (`path.join(__dirname, "..")`, i.e. also the checkout's
   `app/` root, since `dev-launcher.cjs` lives at `app/scripts/dev-launcher.cjs` in the checkout, never
   copied into the bundle). Verified consistent by inspection of both files' path math using the same
   `app`/`appDir` variable name and the same `join(x, "..")` shape. **Cost if wrong:** the write and
   read locations would silently diverge and `CLAVE_SCRIPTED_MODEL` would never survive a bare
   relaunch -- the exact bug this task exists to fix, just moved rather than fixed. I did not find a
   way to verify this end-to-end without either building `dist/` in the scratch copy or running the
   real bundle, both out of scope/forbidden here; flagging this as the one path-matching claim that is
   inspection-only, not test-covered.
5. No new `.gitignore` entry was added for `.dev-launch.json`: neither `app/` nor the repo root has a
   `.gitignore` file at all (checked; the environment also reports "Is a git repository: false"), so
   there was nothing to add it to.

## Not done

- The scratch bundle dry-run itself (see above) -- deliberately skipped per the brief's own fallback
  instructions, with the reasoning recorded.
- End-to-end verification that a real "Quit & Reopen" relaunch actually starts working (would require
  a real grant, a real relaunch, and touching `~/Applications/Clave Agent Dev.app`, all explicitly out
  of bounds for this task).
- `dist/reader-eval.cjs` does not exist yet (a later task builds it, per the brief) -- `resolveLaunch`
  computes its path correctly and this is unit-tested, but nothing was run against a real file there.
