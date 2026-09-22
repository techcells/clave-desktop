# Packaging, signing and notarisation: task list

Written 2026-09-22 from the approved design `docs/superpowers/specs/2026-09-22-packaging-design.md`
(decision 1 approved; decisions 2 to 7 of its section 13 are parameters of the tasks below and are
asked one at a time when a task needs them). Ledger: `2026-09-22-packaging-files/ledger.md`.

Rules for every task: test first where testable, prove each new test by reverting its fix once,
then an independent review by a fresh subagent on a private copy with reproducing probes (loosen each
condition, list the surviving mutations); the program half of every script is gated on being the
entry point; every script writes to `app/out/` by default and refuses `~/Applications` and
`/Applications`; no bundle is ever launched by running its executable, only through `open`; no
window title or recognised text is ever printed; nothing under `app/src/core/exclusions/**`,
`app/src/readerEval/**`, `app/src/shell/app.ts`, `app/src/shell/lifecycle.ts` or the users of
`app/src/main/ports/claveApi.ts` is edited by this sub-project (section 9 of the design lists what
those owners are asked to change). Suite at the start: `pnpm --dir app test` 2990 passed in 90
files, typecheck clean, `test:native` 251, `SMOKE OK`.

Script layout: `app/scripts/package/` with one module per step and one entry, `app/scripts/package.mjs`,
run as `pnpm --dir app package -- --flavour internal|release [--sign <identity name>] [--notarize
<profile name>] [--out <dir>] [--allow-download]`. Every decision is a pure exported function in a
module that does nothing at import; the impure half lives in the entry only.

## Task 0 (owner): the install

Add `@electron/packager` **20.3.0** and `@electron/fuses` **2.1.3** as exact devDependencies
(`pnpm --dir app add -D -E @electron/packager@20.3.0 @electron/fuses@2.1.3`). Needs the owner's
approval of that execution (decision 2). Record: lockfile delta, the versions of `@electron/osx-sign`,
`@electron/notarize`, `@electron/asar`, `@electron/get` that came with it (the plan's later tasks
read their documentation through Context7 at those versions), and that the suite still passes.
Nothing else in this plan installs anything; the Electron zip is already cached.

## Task 1: the flavour, baked in at build time

`scripts/build.mjs` gains `--flavour dev|internal|release` (default `dev`, which is today's build,
byte-identical in behaviour) and passes esbuild `define`s for the flavour and the app name
(`Clave Agent`, `Clave Agent Internal`). `src/renderer/copy.ts` takes `appName` from the define with
`Clave Agent` as the fallback, so the .app file, `CFBundleName`, the onboarding copy and the app's
self-exclusion agree per flavour. Tests: the define table as a pure function; a build with each
flavour produces a `main.cjs`/`renderer/main.js` containing the expected name and flavour and nothing
of the other; the `dev` build is unchanged (hash comparison against a build without the flag).

The three edits the design's section 9 asks of `app.ts` (`production = app.isPackaged && FLAVOUR ===
"release"`; the flavour constant from the define; do not read the `01-work-english.json` fixture
when the real reader is on) and the one for `lifecycle.ts` if a start code is chosen are written as a
short change request in the ledger and given to the owner for D's session. Until they land, a
packaged internal build still refuses to start; every other task can proceed.

## Task 2: staging and pruning

`scripts/package/stage.mjs`: pure `shipList(distFiles, flavour)` (what from `dist/` ships;
`reader-eval.cjs`, `eval-gate.mjs`, `standins-taxonomy.json` in release, source maps, never);
`generatedPackageJson(version, flavour)`; `pruneClosure(paths)` (the Mac-only allow-list: keep
`node-llama-cpp`, `@node-llama-cpp/mac-arm64-metal`, `@reflink/reflink-darwin-arm64`, the JavaScript
closure; drop every other platform package, TypeScript, `.bin`); `forbidden(filePath)` (the
must-not-ship list of design section 4.2, including symlinks and dotfiles). The impure half runs
`pnpm deploy --prod` into `app/out/<flavour>/staging/`, applies the lists, dereferences symlinks and
writes a manifest of relative paths with sizes and SHA-256. Tests over the pure functions with
fixture file lists; a test that runs the forbidden check over the real manifest when one exists.
Measurement recorded in the ledger: staging size with and without node-llama-cpp's `llama/` tree
(the decision to drop it is taken in Task 5 by running the model, not here).

## Task 3: the licence file

`scripts/package/licences.mjs`: `collectLicences(packages)` over the staged closure's `package.json`
and LICENSE files, Electron's `LICENSE` and `LICENSES.chromium.html`, `cargo metadata --offline` for
the helper's crates (through the same absolute cargo path as `build-native.mjs`), and fixed
paragraphs for llama.cpp/ggml and for the model (text and licence name supplied by the owner,
decision 7). `checkAllowed(licence)` with the permissive allow-list; the build fails with a fixed code
on a missing or non-allowed licence. Output `THIRD-PARTY-LICENSES.txt` in staging, byte-checked
(no control characters, UTF-8). Tests: allow-list decisions, a package with no LICENSE file, a
dual-licence expression, the failure path.

## Task 4: the bundle

`scripts/package/bundle.mjs`: `packagerOptions(flavour, paths)` (pure: name, executable name,
bundle id, version and build number, `LSMinimumSystemVersion 14.0`, `extendInfo` with `LSUIElement`,
category, copyright, icon, asar with the unpack list of design 4.1, prune off since staging is
already pruned, `derefSymlinks`, Electron 44.4.1 from the local cache with download refused unless
`--allow-download`); `plistEdits()` (the keys to remove, applied in packager's extract hook; the keys
to assert present afterwards); the helper copy into `Contents/MacOS/clave-reader`. Guards from
`dev-bundle.mjs` reused: the out-dir refusal and the running-app `pgrep` check. Tests: the options
object per flavour, the plist edit set, the guards; the bundle test (skipped when no bundle exists):
helper present, executable name, plist keys present and absent, no forbidden file, no `.map`, no
symlink outside Electron's frameworks, unpack folder contains exactly the two packages, asar contains
`main.cjs`, `preload.cjs`, `model-host.mjs`, `renderer/`, `WHAT-LEAVES.md`, `THIRD-PARTY-LICENSES.txt`.

## Task 5: fuses, entitlements, signing, verification

`scripts/package/harden.mjs`: `fuseTable()` (design 5.1) flipped with `strictlyRequireAllFuses` and
read back; `entitlementsFor(filePath, level)` returning the plist object per file (helper: none;
main: the current level of the reduction ladder of design 5.2; Electron helper apps: the child set);
the plist files generated from objects by script and byte-checked. `scripts/package/sign.mjs`:
`identityDecision(flavour, identityName, found)` (release refuses anything but a Developer ID
Application identity; internal accepts the self-signed name; a missing identity refuses with a fixed
code), the helper signed first with hardened runtime, then osx-sign over the bundle with
`optionsForFile`, then `codesign --verify --deep --strict --verbose=2` and `codesign -d
--entitlements` captured into the run report. Tests: the fuse table read back from the built bundle,
the entitlement objects per file, the identity decision; on a signed bundle, verification exit 0.

Then the measurement that closes the ladder, with the owner: the internal flavour, signed with
"Clave Agent Dev", installed by the owner into `~/Applications` **only after D's session has landed
the Task 1 edits** (before that the packaged build refuses to start, which is itself the first
check: `START_FAILED NO_READER_YET` from a bundle whose fuses are flipped proves the fuses did not
break start-up). The owner launches it with `open`; the model is either downloaded by the app into
the internal data folder or copied there by the owner from the dev folder (his files, his action);
the real-model gate and the staged-window checklist run; then one entitlement at a time is removed
and the same checks repeated; then node-llama-cpp's `llama/` tree is dropped and the checks repeated.
The results fix the entitlement set and the unpack list; the tests are updated to assert them.

## Task 6: notarisation, the DMG, the ZIP, the Gatekeeper checks

`scripts/package/notarize.mjs` and `artefacts.mjs`: notarise the `.app` through `@electron/notarize`
with a keychain profile name only (refuses with a fixed code if the profile is not in the keychain or
the identity is not a Developer ID); staple; DMG with `hdiutil` from a folder holding the app and an
`Applications` symlink, signed, submitted with `xcrun notarytool submit --wait`, stapled; ZIP with
`ditto -c -k --keepParent`; checks `spctl --assess --type execute -vv`, `stapler validate` on app and
DMG, `codesign -dvv` chain, `notarytool log` saved; a run report of fixed codes, sizes and hashes.
Tests: the decisions and argument parsing; the notarisation and Gatekeeper steps are exercised only
in Task 8 because they need the Developer ID.

## Task 7 (owner): the Apple Developer identity

Enrol under TeamEx; create the Developer ID Application certificate with its key in the login
keychain; store the notarisation credential with `xcrun notarytool store-credentials clave-notary`
(API key preferred). Tell the agent only the two names: the identity's display name and the profile
name. Nothing else is ever typed, printed or stored by an agent.

## Task 8: the first notarised internal build

`pnpm --dir app package -- --flavour internal --sign "<identity>" --notarize clave-notary`; the run
report and the Gatekeeper checks recorded; the owner installs the DMG's app into `/Applications` by
dragging (the translocation screen of Task 9 must be in by now, or the owner must move the app first
and the ledger says so); first launch through Finder; the app opens with no warning. Only then is the
build the one that can be sent to a couple of people, with the download page text of design 4.3.

## Task 9: translocation screen, About lines, footer

Renderer only (`copy.ts`, the About screen, the footer): the "move to Applications" screen shown
when main reports a translocated path; "Third-party licences" in About opening the bundled text
file; the internal footer line and About line; the version and build number. The main-side pieces
(the path check, `openLicences`) are in the change request of Task 1. `isTranslocatedPath(path)` is
a pure function with tests. The screen and About are looked at by the owner on the internal build.

## Task 10: the measurements under the real identity (owner present)

P1, P2, P6 and P7(a)(b)(c) exactly as design section 8, one action per message, recorded in
`docs/superpowers/reviews/2026-09-DD-packaging-measurements.md` with codes and counts only. P7(b)
needs a second internal build with a bumped version; the app is quit before it is replaced. What the
app tells the user if P7(b) fails is decided then.

## Task 11: the release gate and the records

A test asserting the release flavour refuses to build while `app.ts` wires the stub API (until D
lands), and, once D lands, that a release bundle contains no stand-in module and no fixture. Dated
notes appended (additions only) to the design's section 0 facts, to `docs/HANDOFF.md` (status table
and section 0 block, the leftovers table for `app/out/`, the new bundles in `~/Applications`, the
Developer ID and the keychain profile as owner-held items) and to spec C's section 10.2 (the
Developer ID re-check closed or not). The decision on decision 5 (updates) is recorded wherever it
lands: About's link text or a WHAT-LEAVES row.

## Order and dependencies

Tasks 1 to 4 and 9's pure parts need nothing from the owner but Task 0. Task 5's measurement waits
for D's session to land the Task 1 edits. Tasks 6 and 8 wait for Task 7. Task 10 waits for Task 8.
Task 11 closes.
