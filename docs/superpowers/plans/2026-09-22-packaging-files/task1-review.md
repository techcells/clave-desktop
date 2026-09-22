# Task 1 review: the flavour, baked in at build time

Independent review, 2026-09-22. Scope: app/scripts/flavour.mjs (+test), app/src/shared/flavour.ts (+test),
app/src/renderer/copy.ts, app/scripts/build.mjs, against plan Task 1 and design section 2.
Method: a private copy of app/ (no node_modules, dist, dist-preview, native/reader/target, reader-eval/out)
under the session scratchpad; the real repo was not edited, no git, no installs, nothing launched.
Deviation recorded: the copy needed `<copy>/node_modules/` as a plain directory of per-package symlinks
(esbuild, react, react-dom, vitest, zod, electron, node-llama-cpp, typescript, @types/{node,react,react-dom})
because Vite's resolver and tsc's `types` ignore NODE_PATH; no `.pnpm`, `.bin` or `.modules.yaml` was linked
and pnpm was never run against it. The copy also needed `../docs/{WHAT-LEAVES,implementation-plan}.md` and
`../eval/fixtures` beside it (tests read them by relative path).

## Verdict: APPROVE WITH CHANGES

The build-time mechanism is correct and well tested. Two of the things the plan says must "agree per
flavour" do not yet follow it (the app's self-exclusion, the window title), and one spelling of the flag
silently produces the wrong flavour, which is the exact failure the code's own comment says it refuses.

## 1. Does it match the design?

- Flavour decided at build time only: yes. `parseFlavour(process.argv)` in build.mjs:29; no env read anywhere
  (src/shell/devEnv.ts untouched); src/shared/flavour.ts reads two ambient identifiers through `typeof`.
- `dev` default unchanged: yes. Six outputs of `build.mjs --flavour dev` and `build.mjs` (no flag) are
  byte-identical (SHA-256, main.cjs, preload.cjs, model-host.mjs, eval-gate.mjs, reader-eval.cjs, renderer/main.js).
- Names: internal -> "Clave Agent Internal", release -> "Clave Agent", dev -> "Clave Agent": yes (APP_NAMES).
- Bad `--flavour` refuses, no fallback: yes for the token forms (`--flavour`, `--flavour Internal`,
  `--flavour relaese`, `--flavour --preview` all exit 1 with `BUILD_FAILED BAD_FLAVOUR`). NOT for `--flavour=x`
  (finding 2).
- Defines reach main.cjs and renderer/main.js: yes. Internal build: "Clave Agent Internal" once in each, no
  `__CLAVE_` identifier left in any of the six outputs; release build: zero occurrences, `"release"` literal present.
- Fallback via `typeof` when not built with defines: yes. Under vitest (nothing defined) FLAVOUR is "dev" and
  APP_NAME "Clave Agent" (src/shared/flavour.test.ts); removing the guard throws ReferenceError at import (M11/M12).
- esbuild folding: with the define, `typeof "internal" === "string"` folds to `true`; the unminified node bundles
  keep `flavourFrom(true ? "internal" : void 0)` (copy dist/main.cjs:23777), the minified renderer keeps only the
  literal. Semantically correct in both.
- `declare const` at module scope: both tsconfigs typecheck clean; erased at emit; vitest's esbuild transform
  leaves an undeclared global that `typeof` reads as "undefined".
- `define` also reaching preload.cjs / model-host.mjs / eval-gate.mjs / reader-eval.cjs: harmless. esbuild
  replaces identifier expressions only; those four outputs contain neither identifier nor the name (0 hits).
- `app.setName(APP_NAME)` before the lock (app.ts:288): the lock and `userData` are keyed by the name, so
  internal and release instances coexist with separate data folders, as the design table wants. Note (unchanged
  by this task): an unpackaged dev run and an installed release both call themselves "Clave Agent" and would
  share the lock and `~/Library/Application Support/Clave Agent/` unless CLAVE_DATA_DIR is set.

## 2. Findings

### Important

I1. The app's self-exclusion does not follow the flavour. `src/core/exclusions/defaults.ts:5` hard-codes
"Clave Agent"; `createExclusions` matches the front app EXACTLY (src/core/exclusions/index.ts:34,46); the reader
reports `kCGWindowOwnerName` (native/reader/src/macos/windows.rs:158), i.e. the bundle's name. An internal build
is named "Clave Agent Internal", so its own window is not excluded and the app reads itself. Plan Task 1 lists
"the app's self-exclusion" among what must agree per flavour and app.ts:32's comment claims it; copy.ts wiring
alone does not deliver it. (The dev bundle "Clave Agent Dev" has had the same gap all along.)
Probe: `grep -rn "Clave Agent" app/src/core` -> defaults.ts:5 only; `grep -rn "appName\|APP_NAME" app/src/core app/src/main` -> nothing.
Fix: derive the built-in entry from `APP_NAME` (src/shared/flavour.ts is pure and typeof-guarded, safe for the
core to import) or pass it into `createEngine`; add a test that `BUILT_IN_EXCLUSIONS` contains `APP_NAME`.
If the core is not this task's to edit, it belongs in the change request.

I2. `--flavour=internal` silently builds dev. `parseFlavour` (scripts/flavour.mjs:30) finds only the exact token
"--flavour"; the `=` spelling is invisible and falls to the default. Exit 0, last line "flavour dev".
Probe: `node <copy>/scripts/build.mjs --flavour=internal` -> exit 0, `built <dist> flavour dev`, 0 x "Clave Agent Internal" in main.cjs.
Also: a repeated flag takes the first and ignores the second (`--flavour internal --flavour release` -> internal).
Fix: refuse any argv entry that starts with "--flavour" and is not exactly "--flavour" (or parse the `=` form),
and refuse a second occurrence; add both cases to the "never a silent fallback" test.

I3. The window title stays "Clave Agent" in every flavour (unmeasured; from Electron's documented behaviour).
`src/renderer/index.html:6` has `<title>Clave Agent</title>`; `BrowserWindow({title: APP_NAME})` (app.ts:135) is
ignored once the loaded page defines a `<title>`, and app.ts handles no `page-title-updated`. The window is framed
(no `frame:false` / `titleBarStyle`), so the title bar is visible.
Probe: `grep -n "page-title-updated\|titleBarStyle\|frame:" app/src/shell/app.ts` -> none.
Fix: `document.title = COPY.appName` in src/renderer/main.tsx (renderer, this task's side), or drop the `<title>`.

### Minor

M1. No test covers the define wiring in build.mjs; only a manual grep of dist/ does (the ledger says so; confirmed:
mutations M16, M17, M18b below survive every test). The plan's Task 1 tests ("a build with each flavour produces
main.cjs/renderer/main.js containing ... nothing of the other; hash comparison for dev") exist only as hand-run
probes. Cheapest fix: move the six-target option table into a pure module (as rendererBuildOptions.mjs already is)
and assert every target carries `define`; or give build.mjs an `--out <dir>` so a test can spawn it into a temp dir.

M2. A refused build leaves the previous dist/ in place (parse at build.mjs:29 runs before `rmSync` at :37), and
dist/ carries no record of its flavour; dev-bundle.mjs and dev-launcher.cjs wrap whatever main.cjs is there.
Probe: internal build, then `--flavour relaese` -> exit 1, dist/main.cjs still has "Clave Agent Internal" (1).
Suggest build.mjs write a small `dist/flavour.json` that Task 2's stage script asserts.

M3. The `--preview` bundle ignores the flavour (build.mjs:101-107 passes no `define`): dist-preview/preview.js
keeps 2 `__CLAVE_` identifiers and shows "Clave Agent" for `--preview --flavour internal`. Harmless (typeof
guard, dev-only output) but inconsistent; spread `define` there too.

## 3. Mutation results (scripts/flavour.test.ts + src/shared/flavour.test.ts, 13 tests; baseline 13 passed)

Killed (tests fail): M1 drop `FLAVOURS.includes` in parseFlavour (1 fails); M2 missing value -> dev (1);
M3 drop the throw in flavourDefines (1); M4 no JSON.stringify on flavour (1); M5 no JSON.stringify on app name
(3); M6 no-flag default "internal" (1); M7 APP_NAMES.internal = "Clave Agent" (4); M8 flavourFrom without the
membership check (2); M9 appNameFrom without the non-empty check (1); M10 appNameFrom `value ? String(value)`
(1); M11/M12 drop the `typeof` guard on either global (suite crashes at import: ReferenceError, 1 file failed);
M14 copy.ts `appName: "Clave Agent"` (1); M15 copy.ts `appName: "Clave Agent Internal"` (1).

SURVIVED:
- M13 `typeof X === "string"` -> `typeof X !== "undefined"` in flavour.ts:28 -- equivalent mutant (flavourFrom /
  appNameFrom reject any non-string anyway); not a gap.
- M16 build.mjs:55 renderer `define: rendererBuildOptions.define` (flavour define dropped) -- 13 passed; build
  exit 0; renderer/main.js has 0 x "Clave Agent Internal", main.cjs 1. Caught only by grep of dist/.
- M17 build.mjs:40 `define` removed from the node option set -- 13 passed; main.cjs 0, renderer 1. Grep only.
- M18b build.mjs:30-34 refusal replaced by `parsed.flavour ?? "dev"` -- 13 passed; `--flavour relaese` exits 0
  and builds dev. Grep only.
build.mjs does its work at top level and is imported by no test; these three are the KNOWN GAP (finding M1).

## 4. Boundary tests

src/renderer/bundle.guard.test.ts and src/renderer/model/views.test.ts pass on the copy (the regex guard walks
src/shared and accepts flavour.ts: `declare const` and `typeof` of a bare identifier trip nothing).

## 5. Commands run (all against the copy C; R = the real app/, read-only)

- rsync -a --exclude node_modules --exclude dist --exclude dist-preview --exclude native/reader/target --exclude reader-eval/out R/ C/
- node R/node_modules/vitest/vitest.mjs run --root C scripts/flavour.test.ts src/shared/flavour.test.ts src/renderer/bundle.guard.test.ts src/renderer/model/views.test.ts
  -> Test Files 4 passed, Tests 118 passed (after copying ../docs/implementation-plan.md beside the copy)
- node R/node_modules/typescript/bin/tsc --noEmit -p C/tsconfig.json -> exit 0
- node R/node_modules/typescript/bin/tsc --noEmit -p C/tsconfig.renderer.json -> exit 0
- node C/scripts/build.mjs --flavour internal -> exit 0; "Clave Agent Internal": main.cjs 1, renderer/main.js 1,
  preload/model-host/eval-gate/reader-eval 0; `grep -l __CLAVE_` over all six -> none
- node C/scripts/build.mjs --flavour release -> exit 0; "Clave Agent Internal" 0 in both; `"release"` present; no __CLAVE_
- node C/scripts/build.mjs --flavour dev  vs  node C/scripts/build.mjs -> six SHA-256 IDENTICAL; no __CLAVE_
- --flavour | --flavour Internal | --flavour relaese | --flavour --preview -> each exit 1, BUILD_FAILED BAD_FLAVOUR
- --flavour=internal -> exit 0, "flavour dev" (I2); --flavour internal --flavour release -> "flavour internal"
- --preview --flavour internal -> dist-preview/preview.js: 2 x __CLAVE_, 0 x "Clave Agent Internal" (M3)
- 18 mutations via a replace-once script, tests after each, files restored and cmp'd against pristine copies
- full suite: node R/node_modules/vitest/vitest.mjs run --root C -> Test Files 91 passed | 1 skipped (92),
  Tests 3005 passed | 1 skipped (3006) (after copying ../eval/fixtures beside the copy; the skip is the
  native-helper test, target excluded from the copy)
