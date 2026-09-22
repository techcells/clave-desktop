# Ledger: packaging, signing and notarisation

Started 2026-09-22. Kept under docs/ because scratchpad ledgers were lost to reboots twice.
Design: docs/superpowers/specs/2026-09-22-packaging-design.md (DRAFT, awaiting approval).

## Owner statements (verbatim, dated)

- 2026-09-22 (session brief, binding): no superpowers skills; ONE action or ONE question per message,
  results first, the single question last, recommendations first among options; NO git at all in this
  repo; no downloads or installs without his approval for that execution; Rust only via build:native /
  test:native; owner-only: Apple Developer account, certificates, passwords/app-specific passwords/API
  keys, keychain prompts, System Settings, grants, tccutil, installing into /Applications; agents never
  launch a bundle by running its executable, only through `open`; never make the helper read a real
  window, never print window titles or recognised text; never open the Application Support folder except
  the two permitted greps on app.log.
- 2026-09-22: "Working on the task. Let's push the changes to the remote repository, and you also need
  to check if the tasks that you currently are assigned to are already done or not."
- 2026-09-22: "I pushed the changes to github" (the folder is now a git repo, origin
  git@github.com:techcells/clave-desktop.git, main = origin/main at e97e2d1).
- 2026-09-22: "Yes, I'll get one under TeamEx, write the design. But before that, can I test the final
  version myself, or send it to a couple of people I know to just see how the software works?"

- 2026-09-22 (to "do you approve the two-flavour scheme ..."): "yes, approved" = decision 1 of spec section 13 APPROVED.

- 2026-09-22 (to "do you approve running that install now?"): "yes, run the install".
- 2026-09-22 (replying to the earlier Developer-Program question): "I don't want to publish this app to
  the App Store. I just want to create a DMG file people can download and just run it on their machine.
  That's it." Consequence: unchanged; the design never targeted the App Store (section 1, out of scope).
  The Developer Program membership is still needed for the Developer ID certificate and notarisation,
  which is what lets a downloaded DMG open without the "Apple could not verify" block on macOS 15+.

- 2026-09-22 (to "do you allow that, or should it go to the C session?" about the self-exclusion edit in
  app/src/core/exclusions/): "yes, make the edit yourself".

- 2026-09-22 (first packaged launch): "I opened the DMG, dragged \"Clave Agent Internal\" to Applications,
  ejected. But tried launching it from Finder, but it didn't open".

- 2026-09-22 (second packaged launch, with two screenshots): "Reinstalled and launched, the tray dot and
  window appeared. But I see white screen in the window, and \"!\" in the tray dot".

- 2026-09-22 (third packaged launch, two screenshots): "Now I see the onboarding, but in the tray, I still see
  the \"!\". Is that okay?"

- 2026-09-22 (onboarding, six screenshots): "In the third step, it downloaded the model, but after it downloaded,
  it tried to check if it works on my machine. That checking process took around 20 to 30 seconds. Then I moved to
  the fourth step, where I opened the system settings and I attached all the screenshots. Before I even clicked,
  later, when I toggled on the permissions, it automatically moved on to the next step."

- 2026-09-22: "done, finished onboarding, switched on reading from the window itself and worked for 2 minutes
  across 2 apps: claude desktop and vscode"; then "reading off".

- 2026-09-22 (P6, two screenshots): "done, and the warning that screen recording is switched off appeared in
  about 3-5 seconds as soon as I toggled it off without even clicking the Later button. But I clicked the
  Later button eventually."

- 2026-09-22 (re-grant, screenshot): "It resumed almost instantly within 1 or 2 seconds. And yes, I clicked later after".

- 2026-09-22 (decision 3, bundle id): "`dev.clave.agent` is good. But what do you recommend?" -> recommendation
  given (keep it); APPROVED.
- 2026-09-22 (decision 4, copyright entity): "let's go with `Clave` instead" -> NSHumanReadableCopyright =
  "Copyright (c) <build year> Clave" (ruling R14 superseded); the internal bundle rebuilt with it.

- 2026-09-22 (decision 5, updates; to "Nothing, or the daily check?"): "Yes, I agree." = no update mechanism;
  About gets a click-only "Get the latest version" line (Task 9). Download page URL still to be named.

- 2026-09-22 (decision 6, icon): "Here is access to the frontend project. See if you can find anything useful
  regarding the icons." (added /Users/sardorastanov/techcells/clave-front as a working directory).

- 2026-09-22 (decision 6, the generated icon shown as a preview): "yes" = APPROVED for both flavours.

- 2026-09-22 (decision 7, model licence Apache-2.0 per the model card): "sure" = CONFIRMED; licences.fixed.json
  updated; a release build no longer refuses on MODEL_LICENCE_UNCONFIRMED.

## Rulings made on the owner's behalf (with cost if wrong)

- R1 (2026-09-22): no `git init`, commit or push by an agent even after his "let's push"; the folder had
  no repository at that moment and the rule on file is "no git here". Cost if wrong: none, he pushed himself.
- R2 (2026-09-22): read-only registry queries (`npm view <pkg> version`) were run to learn current tool
  versions; nothing was downloaded or installed. Cost if wrong: a few metadata requests left the machine.
- R3 (2026-09-22): the design recommends @electron/packager + @electron/fuses over electron-builder, and
  a build-time FLAVOUR (esbuild define) with an "internal" flavour (real reader + model, stub backend,
  distinct name/id/data folder, footer line) as the pre-D artefact. Cost if wrong: one design round.
- R4 (2026-09-22): arm64 only for v1. Cost if wrong: Intel users refused at the download page.
- R5 (2026-09-22): recommend no update mechanism in v1 (a click-only link). Cost if wrong: a later small
  feature plus a WHAT-LEAVES row.

## Facts found (2026-09-22)

- `security find-identity -v -p codesigning`: 1 identity, 0 VALID (the self-signed cert is untrusted in
  security's eyes; codesign still signs with it; dev-bundle.mjs looks the name up without -v).
- Electron 44.4.1 zip is cached in ~/Library/Caches/electron (packager can run offline).
- Runtime node_modules = node-llama-cpp closure only; Mac-only about 100 MB (40 MB node-llama-cpp of
  which 34 MB `llama/` source; 14 MB mac-arm64-metal; ~43 MB JS deps). `pnpm list --prod` also names 14
  other-platform packages and TypeScript (optional peer) that must not ship.
- Licences in the closure: MIT 95, ISC 14, BlueOak-1.0.0 5, Apache-2.0 2, one triple.
- Helper: arm64 Mach-O, links only system frameworks, ad-hoc linker-signed in dist/native.
- Electron's template Info.plist carries camera/microphone/audio/Bluetooth usage strings (untrue for us).
- No packaging spec, plan, script or dependency existed before this session.

## Task list

Written 2026-09-22 after decision 1: docs/superpowers/plans/2026-09-22-packaging.md (Tasks 0-11). Task 0 = the install (decision 2), asked next.

## Task 0 record (2026-09-22)

`pnpm --dir app add -D -E @electron/packager@20.3.0 @electron/fuses@2.1.3` run with the owner's approval.
Result: 29 packages added, 264 changed lines in pnpm-lock.yaml; package.json devDependencies now pin
`@electron/fuses` 2.1.3 and `@electron/packager` 20.3.0. Came with it (not top-level): `@electron/osx-sign`
2.7.0, `@electron/notarize` 3.1.1, `@electron/asar` 4.3.0, `@electron/get` 5.1.0, `@electron/universal`
3.0.6, `@electron/windows-sign` 2.1.0. After: typecheck clean, `pnpm --dir app test` 2990 passed in 90
files (unchanged). pnpm printed an "update available 11.3.0 -> 12.5.1" banner; nothing was updated.

## Task 1 record (2026-09-22)

Owner: "Give me a prompt to hand it to D session and then start the task 1" (verbatim).
Built: app/scripts/flavour.mjs (pure: FLAVOURS, APP_NAMES, parseFlavour, flavourDefines) + flavour.test.ts;
app/src/shared/flavour.ts (FLAVOUR, APP_NAME via typeof; flavourFrom, appNameFrom) + flavour.test.ts;
app/src/renderer/copy.ts appName = APP_NAME; app/scripts/build.mjs parses --flavour (BUILD_FAILED
BAD_FLAVOUR on a bad value), passes `define` to every node bundle and to the renderer bundle, prints the
flavour. Suite 3006 passed in 92 files; typecheck clean; SMOKE OK (dev app not running). Builds: internal
-> "Clave Agent Internal" present once in main.cjs and once in renderer/main.js, no leftover __CLAVE_
identifiers; release and dev -> absent; `--flavour relaese` -> exit 1 BUILD_FAILED BAD_FLAVOUR.
Revert proofs: (1) copy.ts fixed string -> 1 test fails; (2) parseFlavour fallback -> 1 fails;
(3) flavourFrom unchecked -> 2 fail; (4) renderer define dropped in build.mjs -> caught by a manual
grep of dist only (KNOWN GAP: build.mjs does work at top level so no test imports it; the wiring is
verified by hand per build and by the reviewer). Ruling R6: the ambient globals are read through
`typeof` in one shared module so an undefined define can never throw; cost if wrong: none seen.
Review: independent subagent on a private copy, report -> 2026-09-22-packaging-files/task1-review.md.
The change request for D's session (above) is amended: D should import FLAVOUR from src/shared/flavour.ts
rather than read the global.

## Task 1 review record (2026-09-22)

Owner: "done, handed it to D. continue with task 2" (verbatim). Review (task1-review.md): APPROVE WITH
CHANGES. I1 the built-in self-exclusion is hard-coded "Clave Agent" in app/src/core/exclusions/defaults.ts
(C's folder, not editable by packaging) so an internal build would read its own window -> change request
below (owner decides who edits). I2 `--flavour=internal` and a repeated flag were silent dev builds -> FIXED
(both parsers refuse; tests added). I3 index.html's <title> overrode the window title -> FIXED
(main.tsx sets document.title = COPY.appName). M1 build.mjs wiring covered only by manual grep (known gap,
stands). M2 refused build leaves the old dist without a marker -> CLOSED by dist/build.json (Task 2).
M3 the --preview bundle ignored the flavour -> FIXED (same define). Reviewer note: the private copy ran
with a node_modules of per-package symlinks to the repo's packages, pnpm never run.

## Task 2 record (2026-09-22)

Built: scripts/package/stage.mjs (pure: shipList, runtimePackageJson, lockHas, pruneDecision, forbidden,
manifest, resolveOut, requestedFlavour, installedIds; impure stage()) + stage.test.ts (24 tests incl. one
over the real manifest when present); scripts/build.mjs writes dist/build.json (flavour, appName, version,
buildNumber = UTC YYYYMMDD.HHMM: ruling R7, the design said YYYYMMDD.N; cost if wrong: none); package.json
script `package:stage`; root .gitignore ignores app/out/.
Method for node_modules (ruling R8): NOT `pnpm deploy` (probe copied the whole 565 MB project before
refusing on a legacy flag) but an OFFLINE `pnpm install --prod --no-frozen-lockfile
--config.node-linker=hoisted --ignore-scripts` in staging/app with the app's pnpm-lock.yaml and
pnpm-workspace.yaml copied beside a generated package.json naming node-llama-cpp@3.21.1 only; every
installed name@version is then checked against the app lockfile's `packages:` lines (LOCK_MISMATCH
refuses). Probe: 111 packages, all at lockfile versions, 0 differences. Cost if wrong: a version drift
would be caught by the check, not by the install.
Result of a real run (internal): STAGE_OK, 1430 files, 59,283,615 bytes in the asar root, helper 793,632
bytes; 0 symlinks, 0 dotfiles, 0 .d.ts, 0 .map; only mac-arm64-metal and reflink-darwin-arm64 binaries
(mac-arm64-metal also holds two .so files: libggml-metal.so, libggml-cpu-apple_m2_m3.so). Largest file:
node-llama-cpp/llama/gitRelease.bundle 34,969,437 bytes (a git bundle of llama.cpp source; candidate for
Task 5's drop). DIST_FLAVOUR_MISMATCH refused `--flavour release` over an internal dist. Two defects found
by the run and fixed: CI=1 made pnpm freeze the lockfile (now --no-frozen-lockfile, CI unset); the
`@reflink/reflink` keep bypassed the .d.ts drop (now ordered; test added). Revert proofs: 6 mutations
(unlisted dist file shipped, dotfiles allowed, typescript kept, lockHas substring, Applications out-dir,
helper inside asar) each fail tests. dev dist restored after the run (dist/build.json says dev).

## Task 3 record (2026-09-22)

Built: scripts/package/licences.mjs (pure: ALLOWED, PREFERENCE, licenceField, chosenLicence, packageRoots,
licenceFilesIn, cleanText, checkEntries, modelSection, render; impure generateLicences), licences.fixed.json
(llama.cpp and ggml MIT entries with "Copyright (c) 2023-2024 The ggml authors"; the model entry with
licence null; standard texts MIT/ISC/Zlib/Unlicense/Apache-2.0 notice), licences.test.ts, walk.mjs (shared
directory walk), and stage.mjs now calls generateLicences after pruning: writes
dist/THIRD-PARTY-LICENSES.txt into the asar root and copies Electron's LICENSE and LICENSES.chromium.html
(20 MB) to staging/electron/ for the bundle step to put in Contents/Resources (ruling R9: ship the Chromium
file inside the bundle as electron-builder does; cost if wrong: 20 MB).
Facts: `cargo metadata --offline` needs `--filter-platform aarch64-apple-darwin` (without it cargo wants the
registry for other platforms' crates); 27 crates besides clave-reader, licences MIT / MIT OR Apache-2.0 /
Zlib OR Apache-2.0 OR MIT / Unlicense OR MIT; 92 LICENSE files in the closure, all UTF-8 and control-free;
five packages ship no licence file (simple-git, @reflink/reflink, @reflink/reflink-darwin-arm64,
@simple-git/argv-parser, @simple-git/args-pathspec) and get the appendix text of their declared licence.
Rulings: R10 for `A OR B` this distribution takes the first allowed option in PREFERENCE order (MIT first)
and prints the chosen licence's standard text once in an appendix; R11 the Apache-2.0 appendix entry is
the short notice pointing at the licence URL, not the full 11 KB text (no Apache-only component exists
today; the generator would still pass one; cost if wrong: add the full text later); R12 an unconfirmed
model licence REFUSES a release build (MODEL_LICENCE_UNCONFIRMED) and is stated plainly in an internal one.
Real run (internal): STAGE_OK 1431 files, 59,420,142 bytes, licences 115 packages + 27 crates; file 135,822
bytes, 146 "Licence:" lines, 23 dual-licence notes, 34 appendix references, appendix holds MIT only.
Revert proofs: 5 mutations (unknown single licence accepted, missing licence ignored, unconfirmed model in
release, nested package.json counted as a package, control characters kept) each fail tests (two of them
redone with exact-string edits after a sed pattern silently failed to match: lesson, mutate by exact string).
Suite after Task 3: 3068 passed in 97 files, typecheck clean. Review: independent subagent, report ->
task3-review.md.

## Task 2 review record (2026-09-22)

Review (task2-review.md): APPROVE WITH CHANGES, no Critical; 107 mutations, 31 survived (7 equivalent).
FIXED: I1 buildNumber/buildInfo untested -> 3 tests (UTC minute, month one-based, refusals, app name);
I2 dropping `parts.length >= 2` would have pruned the bare @node-llama-cpp scope and, parent-first, the Mac
package -> test that the bare scope folders are kept; I3 manifest header unasserted -> asserted; M2
forbidden() now applies the node_modules rules at EVERY nesting level and to .d.mts/.d.cts -> tests; M3
exact-semver regex anchored ($) -> tests for "3.21.1-beta" and "v3.21.1"; M4 the copied lockfile/workspace
files are removed even when the install fails; M5 the runtime package.json version now comes from
dist/build.json (one version); M8 the import gate is the exact basename. NOT changed: M1 the ledger said 2
.so files under mac-arm64-metal, the reviewer counted 5 (blas, cpu m1, cpu m2_m3, cpu m4, metal) -> 10
Mach-O files for Task 5 to sign (corrected here); M6 (only kept package.json files feed the lock check; the
20 non-package package.json files lack name+version) accepted; M7 (tsbuildinfo, yarn.lock, test/example
files inside packages still ship; node-llama-cpp/dist/cli/ CANNOT be dropped, 5 library files import it;
gitRelease.bundle is 59% of staging) carried to Task 5's measurement; M9 (scripts tests type-checked by
nobody) is the documented repo pattern.

## Task 4 record (2026-09-22)

Built: scripts/package/bundle.mjs (pure: BUNDLE_IDS, PLIST_REMOVE, PLIST_SET, ASAR_UNPACK, UNPACKED_ROOTS,
ASAR_REQUIRED/FORBIDDEN, bundleIdFor, copyrightFor, findElectronZip, packagerOptions, expectedPlist,
checkBundle; impure bundle()) + bundle.test.ts (incl. a from-disk check of a real bundle); package.json
script `package:bundle`. Facts from the installed tools: @electron/osx-sign 2.7.0's DEFAULT Developer-ID
entitlements (entitlements/default.darwin.plist) grant camera, audio-input, bluetooth, usb, print, location
and photos-library -> Task 5 must pass its own entitlements for every file, never the defaults;
@electron/fuses 2.1.3 knows a ninth fuse, WasmTrapHandlers (index 8), which `strictlyRequireAllFuses`
requires to be named (ruling R13: keep Electron's default, enabled); packager 20.3.0 embeds the asar
integrity digest into the framework binary (`asarIntegrityDigest`, ad-hoc re-sign, before osxSign);
`extendInfo` merges but cannot delete, so the five untrue usage strings are removed in the afterExtract
hook with plutil (the plist is read by packager after that hook: verified in mac.js updatePlistFiles);
@electron/asar takes ONE glob per option: unpack "*.node" (base-name match) and unpackDir
"node_modules/{node-llama-cpp,@node-llama-cpp}" (children inherit); Electron's zip is found in
~/Library/Caches/electron/<hash>/ and passed as electronZipDir, so no download happens (ELECTRON_ZIP_MISSING
refuses unless --allow-download); @electron/asar is resolved through packager (pnpm strict layout).
Rulings: R14 NSHumanReadableCopyright = "Copyright (c) <build year> TeamEx" (the owner's stated entity,
decision 4 still to confirm; env CLAVE_COPYRIGHT_ENTITY overrides); R15 the icon is app/build/icon.icns
when present, Electron's otherwise (decision 6 open); R16 dark-mode support on (NSRequiresAquaSystemAppearance
false), harmless for a tray app.
Real run (internal, unsigned, unfused): BUNDLE_OK in 7.3 s; 380,039,758 bytes on disk (365 MB), asar
6,784,519, unpacked 52,510,676; Contents/MacOS holds "Clave Agent Internal" and clave-reader (755, byte-
identical to staging); plist: id dev.clave.agent.internal, version 0.1.0, build 20260922.0815, LSUIElement,
LSMinimumSystemVersion 14.0, category, copyright, ElectronAsarIntegrity present, NO usage strings; unpacked
holds node-llama-cpp, @node-llama-cpp/mac-arm64-metal, @reflink/reflink-darwin-arm64 (the .node rule);
Resources has LICENSE + LICENSES.chromium.html and all Electron locale folders (pruning locales is a later
size step). codesign shows the template's ad-hoc identity "Electron" until Task 5 signs.

## Task 3 review record (2026-09-22)

Review (task3-review.md): APPROVE WITH CHANGES; 62 mutations, 24 survived. FIXED: C1 (Critical) the packages
esbuild inlines into the shipped bundles (react, react-dom, scheduler, zod) were named nowhere -> the build
now records them from esbuild's metafiles (scripts/bundled.mjs: nodeModulesInputs, packageDirOf,
uniquePackages) into dist/bundled-packages.json with licence field and text; the staging step consumes
that file (never ships it, DIST_STAGING_ONLY, required) and the licence file lists them as "(compiled
into the application code)"; a missing file or an empty list refuses (BUNDLED_PACKAGES_MISSING). I1 rc's
LICENSE.APACHE2 was printed under a MIT claim -> pickLicenceFile takes the file named after the chosen
licence, the only file, or none. I2 dangling appendix references -> render refuses APPENDIX_TEXT_MISSING;
BSD-2/BSD-3/0BSD texts added. I3 the Unlicense text was truncated -> replaced by the 197-word text copied
mechanically from memchr's UNLICENSE in the cargo registry. Minors: nested duplicate packages deduped by
name@version; sources printed only as https URLs (git@, git://, git+ normalised or dropped); cleanText
refuses DEL and C1; nameless package roots refuse (PACKAGE_UNNAMED); tests for the surviving mutations the
reviewer named (LF4, MS2, RN3, RN6, RN8, CT3). NOT changed: the llama.cpp copyright line is unverifiable on
this machine (no LICENSE in the llama/ tree, the git bundle is packed) -> owner to eyeball on GitHub
(decision 7 territory); crates are read from the checkout's Cargo.lock, not from the staged helper
(accepted: the helper is built from that lock, --locked); modelSection refuses release only (by design).

## Task 4 review record (2026-09-22)

Review (task4-review.md): APPROVE WITH CHANGES; every probed design point and all four packager facts
confirmed; 103 mutations, 35 survived. FIXED: I1 the running-app guard probed only the .app path while the
whole <out>/<flavour>/bundle folder was deleted -> the whole folder is probed, with the path escaped for
`pgrep -f` (pgrepPattern; a `(` in a folder name no longer makes the check unanswerable); I2 expectedPlist,
ASAR_REQUIRED, ASAR_FORBIDDEN and UNPACKED_ROOTS pinned literally in tests, and the from-disk test asserts
literal plist values; I3 the from-disk helper check on a signed bundle read stdout of `codesign -d` (which
writes to stderr; vacuous) -> reads stderr and requires Identifier=clave-reader and exit 0; `--flavour dev`
refused up front; findElectronZip tests reordered so endsWith/includes mutants die. NOT changed (minors):
the hook's plutil catch cannot tell "absent key" from "broken plist" (backstopped by PLIST_KEY_PRESENT);
`bytes.app` is a file-size sum; packager's out folder is mode 0700 and holds LICENSES.chromium.html beside
the .app (Task 6 takes report.appPath only). Fact corrected: mac-arm64-metal ships 10 Mach-O files (1 .node,
4 .dylib, 5 .so); the bundle holds 25 Mach-O files in all, 14 symlinks all under Contents/Frameworks, 55
lproj folders, an asar of 1793 entries and 102 packages. Reviewer's note: the real bundle was re-bundled
and signed by Task 5 while the review ran; findings were reproduced on the reviewer's own scratch build.

## Task 5 record (2026-09-22): fuses, entitlements, signing

Built: scripts/package/harden.mjs (FUSE_TABLE for all nine fuses of @electron/fuses 2.1.3, fuseConfig built
from the tool's own enums with strictlyRequireAllFuses and a refusal for any fuse the table does not name,
checkFuseWire, ENTITLEMENT_LEVELS ladder [jit+unsigned-memory+no-library-validation] -> [jit+unsigned-memory]
-> [jit], FORBIDDEN_ENTITLEMENTS, entitlementsFor per file, impure flip()); scripts/package/sign.mjs
(parseIdentities from `security find-identity -p codesigning` with trust flag and no hash kept,
identityDecision, parseSignArgs, signOptions for @electron/osx-sign with optionsForFile and
preAutoEntitlements off, checkEntitlements, impure signBundle: identity first, fuses, osx-sign, verify
--deep --strict, entitlements read back from the main executable and the helper, hardened-runtime flag
checked on both, report updated); sign.test.ts (incl. a from-disk check); package.json `package:sign`.
Facts: osx-sign's `walk` finds every Mach-O under Contents (helper, dylibs, .node, .so, helper apps,
frameworks) and its DEFAULT per-file entitlements are the camera/microphone/bluetooth/location set, so
entitlements are given explicitly for every file; osx-sign validates identities with `security -v`, which
does not list the self-signed certificate (CSSMERR_TP_NOT_TRUSTED), so identityValidation is on only for a
Developer ID; `codesign -dvv` writes to stderr; codesign's --timestamp contacted the timestamp server for
every file, so a self-signed signing pass takes about 2.5 minutes (149 s) — the only network traffic of
the pipeline besides notarisation. Ruling R17: the helper is signed with NO entitlements (nothing in it
needs one); R18: Electron's helper apps get JIT, the Plugin helper osx-sign's plugin set (unused helper).
Real run (internal, level 0, "Clave Agent Dev"): SIGN_OK; fuse wire read back = the table; app and helper
carry flags=0x10000(runtime); main entitlements exactly the three of level 0, helper none; `codesign
--verify --deep --strict --verbose=2` exit 0; Authority=Clave Agent Dev, TeamIdentifier not set (self-signed).
The reduction ladder (levels 1 and 2) and the `llama/` drop are MEASURED with the owner (Task 5's second
half) once D's session lands the start-guard edits: a packaged internal build still refuses to start today.
Revert proofs: 8 mutations (RunAsNode on, unlisted fuse inherited, helper gets JIT, level ignored, release
self-signed, release unsigned, Developer ID unvalidated, forbidden entitlement accepted) each fail tests.
Suite after Task 5: 3108 passed in 100 files, typecheck clean, dev dist restored (dist/build.json says dev).
Review: independent subagent (Task 5 + re-check of the Task 3 fixes), report -> task5-review.md.

## Task 6 record (2026-09-22): notarisation, DMG, ZIP, Gatekeeper checks

Built: scripts/package/artefacts.mjs (pure: artefactBaseName, parseNotarizeArg, notarizeDecision, the
exact commands for ditto copy, hdiutil, codesign of the DMG, notarytool submit by keychain PROFILE NAME,
stapler, notaryStatus, checkPlan with mustPass per build kind, checkProblems; impure artefacts()) +
artefacts.test.ts (incl. a from-disk check of a real run); package.json `package:artefacts`. Order:
notarise+staple the .app through @electron/notarize (profile name only; it runs `xcrun notarytool submit
--wait` then staples) -> DMG root = ditto copy of the app + `Applications` symlink -> hdiutil UDZO HFS+ ->
codesign the DMG by identity name with a timestamp -> notarytool submit the DMG, staple it -> ZIP of the
stapled app with `ditto -c -k --keepParent` -> checks (codesign --verify app and DMG always must pass;
spctl app/DMG and stapler validate app/DMG must pass only for a notarised Developer ID build; every
result recorded). No command ever carries a credential flag (tested over the argv tokens).
Real run (internal, self-signed, not notarised): ARTEFACTS_OK in 30 s; DMG 186,660,711 bytes, ZIP
172,353,036 bytes, names Clave-Agent-Internal-0.1.0-<build>-arm64.{dmg,zip}; the DMG is signed by
"Clave Agent Dev"; spctl answers 3 (rejected, as expected for self-signed) and stapler validate 65 (no
ticket, as expected); both recorded, neither enforced for this build kind. Ruling R19: an internal
self-signed build may produce artefacts for the owner's own checks; nothing self-signed is for anyone
else (design section 2). Revert proofs: 6 mutations (unsigned bundle accepted, release skips
notarisation, self-signed notarisation attempted, Gatekeeper never enforced, only exit 1 counted,
notary status with suffix accepted) each fail tests. Notarisation itself is exercised in Task 8 (needs
the Developer ID and the keychain profile, Task 7, owner-only).

## Task 9 (pure part) and Task 11 (release gate) record (2026-09-22)

Built: app/src/shell/translocation.ts (isTranslocatedPath over process.execPath: the `AppTranslocation`
path segment; isInApplications for /Applications and ~/Applications) + test, for D's session to call
before onboarding (change request item 4; the renderer screen is Task 9's remaining half). The release
gate: scripts/bundled.mjs standinInputs(metafile) and scripts/build.mjs refuse `--flavour release` with
BUILD_FAILED STANDINS_IN_RELEASE while main.cjs would contain any file from src/standins/ (today:
src/standins/devReader.ts, so a release cannot be built by accident until D lands). Test in
bundled.test.ts. Proven for real: `node app/scripts/build.mjs --flavour release` refuses.

## Incident and state note (2026-09-22, after D's change request landed)

D's session landed all five items of the change request (its block at the end of this ledger), including
its own `app/src/shell/translocation.ts` "since it was needed for typecheck; replace it if yours differs".
Packaging wrote its version of that file and its test WITHOUT first noticing D's (the writing tool
reported "updated", which was the only sign): same export and signature (isTranslocatedPath(execPath)),
plus isInApplications; D's three tests were replaced by packaging's, extended afterwards with the
"/var/folders temporary folder that is NOT a translocation" negative that D's review had closed. app.ts
compiles and the suite passes with packaging's version. Lesson (ruling R20): before writing a file named
in a change request to another session, check for its existence and read it. Cost if wrong: none seen.
Consequence of D's landing: a PACKAGED INTERNAL BUILD CAN NOW START (launchMode: stub API, real reader,
real model, production=false); the chain was rebuilt on the current code (see the run below). Not yet
there: the renderer's "move to Applications" screen and About lines (Task 9); until then a translocated
build shows ordinary onboarding with an Allow button that does nothing (D's note), so the internal build
is for the owner only, installed in ~/Applications, never opened from Downloads or a DMG in place.
D's side note (standins-taxonomy.json copied into dist for every flavour): stage.mjs already ships it
for dev/internal only; the dist copy is harmless.

## Measurement M1 (2026-09-22 14:05 local): first launch of a packaged build — FAILED, cause found

Owner installed Clave-Agent-Internal-0.1.0-20260922.0849-arm64.dmg into /Applications and launched from
Finder: nothing appeared. Evidence (read-only, nothing launched by an agent): the installed app carries
no quarantine attribute (only com.apple.provenance), so Gatekeeper never assessed it; `spctl` rejects it
(origin=Clave Agent Dev, expected for self-signed); the MAIN process started and spawned clave-reader
(pid 16475 found running from /Applications, parent gone); the data folder "Clave Agent Internal" was
created at 14:05 but holds no app.log yet; FIVE crash reports "Clave Agent Internal Helper" at 14:05:57
(and five at 14:05:33): termination namespace DYLD, "Library missing", "Library not loaded:
@rpath/Electron Framework.framework/Electron Framework ... code signature ... not valid for use in
process: mapping process and mapped file (non-platform) have different Team IDs". So: under the hardened
runtime, dyld's library validation refuses our OWN Electron Framework inside the helper apps because a
self-signed identity has no Team ID; the main executable survived only because level 0 gives it
`disable-library-validation`; the helpers had `allow-jit` only. Nothing to do with the fuses, the asar
integrity check or only-load-from-asar (the main process got as far as spawning the reader helper).
FIX (ruling R22): entitlementsFor takes `{teamId}`; without a Team ID every executable that loads the
framework (main and the four helper apps) also gets `disable-library-validation`; `--level` above 0
refuses under a self-signed identity (LEVEL_NEEDS_DEVELOPER_ID); the read-back check uses the same
effective set. The entitlement ladder (levels 1 and 2) is therefore measurable ONLY under the Developer
ID (Task 8 onwards); design 5.2's expectation that library validation can be re-enabled holds for a
Team-ID identity only, by construction. Cost if wrong: none for the release (a Developer ID has a Team ID).
Side observation for sub-project C (not packaging's to fix): the clave-reader helper OUTLIVED its parent
(main died, the helper kept running as an orphan with stdin presumably closed); C's spec says the helper
should exit when its parent goes. Recorded here for the owner; the orphan (pid 16475) is the owner's to
end before reinstalling (the running-app guard would otherwise refuse the replacement, correctly).

## Measurement M2 (2026-09-22 ~14:20 local): second packaged launch — the app starts; window white

With the helper apps carrying disable-library-validation the packaged internal build STARTS from
/Applications: main process and clave-reader running as its child (pids seen), no new crash report, the
tray menu works (Reading is off / Review (0) / Pause / Settings / Quit) and the title bar reads "Clave
Agent Internal" (Task 1 I3 fix confirmed). So the fuses RunAsNode/NODE_OPTIONS/inspect OFF, asar
integrity ON and only-load-from-asar ON do not break start-up: MEASURED. Two observations:
(a) the window is white: the renderer page did not render. The asar holds index.html, main.js, main.css;
the page is file:// with CSP `script-src 'self'`. The one packaged-only difference on the renderer side
is the fuse GrantFileProtocolExtraPrivileges = OFF (design 5.1), whose effects Electron documents as
"incomplete" (fetch over file://, service workers, child-frame access). Ruling R23: the fuse goes back to
Electron's default (ON) — the app's own request handler already cancels every non-file request — and
the owner relaunches to confirm; the proper way to switch it off again is serving the renderer from a
custom protocol (Electron's recommendation), an app.ts change for another session, recorded as a later
item. Cost if wrong: the white window has another cause and one more relaunch is needed.
(b) the "!" in the tray is by design (sub-project B, trayState): before sign-in and before the Screen
Recording grant the blockers SIGNED_OUT / NO_PERMISSION are "problem" blockers and draw "!". Not a
packaging defect; whether a first run should look like a problem is B's question (noted for the owner).
(c) no app.log exists yet in the internal data folder: the log is appended on the first code and nothing
has fired; the permitted greps will work once onboarding runs.

## Measurement M3 (2026-09-22): third packaged launch — the window renders

With GrantFileProtocolExtraPrivileges back at Electron's default the onboarding renders (step 1 of 7,
the five promises, CONTINUE, "read what leaves this machine"), the masthead says CLAVE AGENT INTERNAL and
"Reading is off". So the white window of M2 WAS that fuse (ruling R23 confirmed by the relaunch): a
file:// renderer with its script and stylesheet beside it needs the fuse on; switching it off again
requires a custom protocol for the renderer (later item, another session's file). The "!" remains by
design until sign-in and the grant (see M2 b). Fused, hardened, self-signed internal build: STARTS AND
RENDERS from /Applications. Next: onboarding through sign-in (the stub accepts any) to the Screen
Recording step = P2 under a packaged build (dialog name, "Later", onboarding advancing by itself).

## Measurement M4 (2026-09-22): onboarding of the packaged internal build — model, dialog, grant pickup

From the owner's screenshots and account (packaged internal build in /Applications, fused, hardened
runtime, self-signed "Clave Agent Dev", entitlement level 0 with disable-library-validation on the main
executable and the helper apps):
- Step 3: the 2.7 GB model downloaded into the internal data folder (progress bar, PAUSE) and "Checking it
  works on your machine" took 20-30 s and passed: the REAL MODEL LOADS AND ANSWERS inside the packaged
  build — node-llama-cpp's Metal binaries in app.asar.unpacked under the hardened runtime, the model host
  as a utilityProcess forked from inside the asar with RunAsNode off. The 20-30 s is the first-load cost
  the B spec measured (about 21 s); later loads should be about 2 s.
- Step 4: pressing the app's button raised macOS's dialog: "“Clave Agent Internal.app” would like to
  record this computer's screen and audio. Grant access to this application in Privacy & Security
  settings, located in System Settings." with Open System Settings / Deny — the SAME softer wording as
  the dev bundle's first run (2026-09-18), naming the .app FILE, from a packaged build in /Applications.
  System Settings listed "Clave Agent Internal.app" by itself, toggle off. => P2's dialog half PASS.
- The owner switched the toggle on; macOS offered "Quit & Reopen" / "Later"; BEFORE he answered,
  onboarding advanced by itself to step 5 ("What is never read", the default exclusions). => the grant
  reached the running helper inside the signed bundle without any restart (P1's attribution and P2's
  pickup through the denied-refresh) PASS under this identity. The masthead marker changed from "!" to
  the hollow "off" mark once signed in and granted, as M2(b) predicted.
Not measured here: P6 (revocation) and P7 (identity/version change): with the owner later. The entitlement
ladder cannot be measured under this identity (LEVEL_NEEDS_DEVELOPER_ID). Next: finish onboarding, reading
on, two minutes of ordinary work, then the permitted greps on the internal build's app.log.

## Measurement M5 (2026-09-22): two minutes of real reading under the packaged internal build

app.log of the internal build (permitted greps): codes SELF_TEST_PASSED 1, CAPTURE_ON 1, CAPTURE_OFF 1;
no READER_*, no PERMISSION_LOST, no MODEL_PROBLEM, no BACKGROUND_TASK_FAILED. CAPTURE_OFF tallies: kept 110,
unchanged 9, windowGone 4, noWindow 1, empty 2, denied 8, failed 0, blockers 0 — about one read per
second across Claude Desktop and VS Code, with the exclusion rules refusing 8 cycles (the app's own window
under its flavour name among them: the selfApp exclusion at work). The packaged, fused, hardened,
self-signed build READS A REAL SCREEN end to end: the reader helper next to the executable, the grant
attributed to the bundle, the loop and the model host inside the asar. Nothing uploads (stub backend).
Rulings: R24 the llama/ source-tree drop (design 4.1) is measured on the first Developer ID build with a
version bump (the self-test only re-runs on a version or model change, so a same-version reinstall would
not prove the model still loads); R25 the entitlement ladder is likewise a Developer ID measurement
(LEVEL_NEEDS_DEVELOPER_ID). Task 5's second half is therefore complete for what a self-signed identity can
show; P1 and P2 hold under it; P6 and P7 are next with the owner.

## Measurement M6 (2026-09-22): P6 revocation under the packaged internal build — PASS

Reading on; the owner switched the "Clave Agent Internal.app" toggle off in System Settings; within 3-5 s,
before he answered macOS's "Quit & Reopen / Later" sheet, the window showed "Reading is off" with the
blocker "Screen Recording is switched off for this app." and OPEN SYSTEM SETTINGS. app.log: PERMISSION_LOST
1, CAPTURE_OFF (second) with blockers 1, kept 2, noWindow 2, denied 3, failed 0; no READER_PROBLEM, no
helper exit. Exactly spec C section 5.3 and the C-2b-2 Task 6 result, now under a packaged, fused,
hardened, self-signed bundle in /Applications. P1, P2 and P6 therefore hold under this identity; the
design's section 8 asks for them again under the Developer ID (Task 10), where P7 is added.

## Measurement M7 (2026-09-22): re-grant under the packaged internal build — reading resumed by itself

The owner switched the toggle back on; within 1-2 s, before answering "Later", the window showed
"Reading is on" (screenshot) with no button pressed; app.log gained a third CAPTURE_ON and nothing else.
The P6 pair (revocation noticed, automatic resume on re-grant) holds under the packaged build. This closes
what a self-signed identity can show: M1-M7. Remaining with the owner: decisions 3-7, the Developer
Program under TeamEx (Task 7), then Task 8 (notarised build with a version bump, the llama/ drop and the
entitlement ladder), Task 10 (P1/P2/P6 again plus P7 under the Developer ID). Remaining for packaging
without the owner: Task 9's renderer screen and About lines.

## Icon (decision 6) record (2026-09-22)

Found in clave-front: apps/mobile/assets/appicon-ios-1024.png (1024x1024, no alpha; the mobile app's icon
per app.json: an off-white "c" on #101114), icon.png (same), adaptive-icon.png (Android), apps/web/
public/favicon.svg (the same mark as text). Built: scripts/package/make-icon.swift (system frameworks
only: draws the source inside macOS's rounded square, 824/1024 of the canvas, corner radius 22.4 %, on
a transparent canvas, at the ten .iconset sizes) and make-icon.sh (swift + iconutil) -> app/build/
icon.icns (154 KB, "ic12" type) and app/build/icon-preview.png. bundle.mjs already takes
app/build/icon.icns when present (ruling R15). Proposed to the owner as decision 6: use the mobile
app's mark; nothing in the frontend repo was modified.

## Session plan: the first launch of a PACKAGED build (Task 5, second half; owner at the machine)

Artefact: app/out/internal/artefacts/Clave-Agent-Internal-0.1.0-20260922.0841-arm64.dmg (self-signed
"Clave Agent Dev", fused, hardened runtime, entitlement level 0, not notarised; built locally so it
carries no quarantine attribute and Gatekeeper does not assess it). Steps, ONE per message:
1. Owner: open the DMG, drag "Clave Agent Internal" to Applications, eject; launch it from Finder (never
   from a terminal). Expected: the tray dot appears and the window opens (that alone proves the fuses,
   the asar integrity check and only-load-from-asar did not break start-up). If nothing appears: the
   permitted grep on ~/Library/Application Support/Clave Agent Internal/app.log for START_FAILED.
2. Owner: onboarding to the Screen Recording step; the dialog must name "Clave Agent Internal.app";
   grant; "Later"; onboarding advances by itself (P2 under a packaged, fused, self-signed build).
3. Model: either let the app download it (2.7 GB into the internal data folder) or the owner copies
   the file from the dev data folder's models/ into ~/Library/Application Support/Clave Agent
   Internal/models/ (his files, his action), then the app verifies it.
4. Two minutes of ordinary work; the permitted tallies on app.log (CAPTURE_ON/OFF, READER_* codes).
5. Then the entitlement ladder: rebuild at --level 1, reinstall (quit first!), repeat 1-4; then --level 2.
6. Then drop node-llama-cpp's llama/ tree (pruneDecision dropLlamaSource) and repeat once.
The self-exclusion (I1) is in: the internal build never reads its own window.

## Task 5 review record and Task 3 re-check (2026-09-22)

Review (task5-review.md): A APPROVE WITH CHANGES; B (Task 3 fixes) CLOSED. Real bundle: 25 Mach-Os all
signed by "Clave Agent Dev" with runtime flag, 0 unsigned, 0 ad-hoc; entitlements exactly as designed;
fuse wire equals the table; 96 mutations, 21 survived (mostly equivalent). FIXED: I1 on any failure after
the fuse flip the report still said fused:false/signed:false -> every post-flip exit writes fused:true,
signed:false and a signError code (cleared on success); M4 dead helper-app branches removed (one
`<app> Helper` branch); tests for S12 (prefix, not substring), S18 (`--level 1x`), H24 (the forbidden
list pinned whole), BAD_APP_NAME. Re-check B1: build.mjs picked the first sorted licence file for a
bundled package (the rc pattern, latent) -> pickLicenceFile by chosen licence; B2: a bundled package
without a version was dropped silently -> BUILD_FAILED BUNDLED_PACKAGE_UNNAMED. Facts corrected: the
helper is signed by osx-sign's walk in the right order (ranked as a bundle main executable), not by a
separate first step; osx-sign also signs 229 non-Mach-O files (pak, icns, nib, dat, asar) as extended-
attribute signatures with a timestamp each, which is where the 149 s go; the plain "<app> Helper.app"
would have got osx-sign's full default set, so [JIT] for it is a reduction; sources are printed when
http(s), the one http:// homepage stays as declared (ruling R21). Not changed: pgrep -f can be fooled
by any command line holding the path (safe direction: refuses).

## Task 6 review record (2026-09-22)

Review (task6-review.md): APPROVE WITH CHANGES. Verified from @electron/notarize 3.1.1 source:
notarize({appPath, keychainProfile}) submits with `--wait --output-format json`, fetches the notary
log, staples with 3 retries, throws on failure, no `tool:` option in v3, accepts a .dmg path too. Real
DMG: UDIF zlib, HFS+, mounts on macOS 27.0; app + Applications link, no dotfiles; the app inside and
the ZIP round trip keep 1091 entries / 14 symlinks and the same CDHash. FIXED: I1 notary logs are now
saved (notary-app.log from @electron/notarize's error, notary-dmg-submit.log and notary-dmg.log from
`notarytool log <id>`), the DMG submission id and status kept in the report; I2 the signature chains
(Authority names, TeamIdentifier; never a hash) of the app, the helper and the DMG are recorded; I3 a
run builds in artefacts.partial/ (dmg-root inside it, removed in a finally) and renames into place only
after every check, so a failure leaves the previous artefacts intact and nothing under the final name;
I4 checkPlan pinned literally per check, plus the rule that no check may write ("staple" never among
a check's arguments); minors: blank or flag-like profile refused, notaryStatus "Rejected" and anchor
tested, notaryResult reads JSON first (stdout and stderr merged), artefactBaseName types tested,
`!== true` strictness tested. Not changed: hdiutil create/attach are deprecated on macOS 27 but work
(HFS+ still listed); @electron/notarize reached through packager's ^3.1.0 range (pinning it means one
more direct devDependency: owner's call, cost nil); a failed staple retry needs a resubmit; no pre-flight
profile check (the first `notarytool` call is the check).

## Task 9 record (2026-09-22): the renderer's half

Built (renderer only; the main-side pieces landed with D's change request): copy.ts gains
onboarding.translocated (title, lead, three steps naming the .app FILE via APP_FILE) and
settings.licences / licencesMissing / internalBuild / internalMark; Onboarding.tsx's permission step
renders MoveToApplications instead of the permission ask when `isTranslocated(appInfo)` (decided before
any hook; the ask moved into PermissionAsk unchanged); Settings.tsx About gains a "Third-party licences"
quiet button calling openLicences and showing "The licence file is not part of this build." on
LICENCES_MISSING, plus the internal-build note when FLAVOUR === "internal"; Frame.tsx's masthead shows
"internal build" in the attention colour for that flavour (.mark-flavour); views.ts isTranslocated
(exact true only) + tests; the translocation copy tested (names the file, says quit / move / open,
never says "system settings" or "allow"); mockBridge gains the "onboarding-translocated" scenario (the
permission step's state with translocated:true). Looked at in the dev preview (clave-preview server,
scenarios onboarding-translocated and settings): the step and the About lines render; the licences
button shows the missing note under the mock. Revert proofs: isTranslocated truthy -> 1 fails; copy
without the file name -> 1 fails. NOT built: the click-only "Get the latest version" line (needs the
download page URL, decision pending, and an openExternal-style IPC from D since the renderer cannot
open a browser; recorded as a request once the URL exists); the build number in About (AppInfo has no
such field; main would read dist/build.json — D's file; recorded as optional). Ruling R26: the UI
follows the existing screens' patterns (classes lede/steps/note/facts/actions) rather than a new
design pass: three lines and one step inside an established design.

## Self-exclusion edit record (Task 1 finding I1, 2026-09-22, owner-permitted)

Edited: src/core/types.ts (PipelineConfig.selfApp?: string), src/core/exclusions/index.ts (createExclusions
takes selfApp; a non-blank string joins the built-in set, trimmed and lower-cased; anything else is ignored
and "Clave Agent" stays built in), src/core/index.ts (passes config.selfApp), src/main/engine.ts (passes
APP_NAME from src/shared/flavour). Tests: two in exclusions/index.test.ts, one in core/pipeline.test.ts.
Revert proofs: A ignore selfApp -> 2 fail; B pipeline does not pass it -> 1 fails; C no trim/lower-case
-> 2 fail. Suite 3051 passed in 96 files, typecheck clean. The C-session change request above is CLOSED.

## Change request for C's session (CLOSED 2026-09-22: done by packaging with the owner's permission)

app/src/core/exclusions/defaults.ts line 5 hard-codes "Clave Agent" in BUILT_IN_EXCLUSIONS. The internal
flavour's app is named "Clave Agent Internal" (window-server owner name), so it would read its own window.
Smallest change: createExclusions(input) takes an optional `selfApp: string` and adds it (lower-cased,
exact match) to the built-in set; core/index.ts passes `config.selfApp`; PipelineConfig gains `selfApp?:
string`; the engine passes COPY.appName (or APP_NAME from src/shared/flavour). One test: a front window
whose app equals selfApp is `excludedApp`. Until it lands the internal build must not be handed to anyone.

## Change request for D's session (Task 1; files owned by D)

`app/src/shell/app.ts`:
1. Read the build-time flavour: `import {FLAVOUR} from "../shared/flavour"` (a `"dev" | "internal" |
   "release"` constant baked in by esbuild `define` in scripts/build.mjs via `--flavour`; `dev` when unbuilt).
2. The start guard: in the internal flavour a packaged build runs the real reader beside the stub API,
   so replace `if (!STANDINS) throw new Error("NO_READER_YET")` and the `REAL_READER` derivation with:
   packaged + internal => stand-in API, real reader, real model, no smoke; packaged + release => the real
   client from D (until D exists: throw NO_READER_YET as today); unpackaged => exactly today's switches.
   `production` passed to createEngine becomes `app.isPackaged && FLAVOUR === "release"`; `appInfo.standIns`
   stays true for internal.
3. Do not read `eval/fixtures/01-work-english.json` when the real reader is used (standIns() currently
   reads it before the dev reader is disposed); no fake screen text should ship in any flavour.
4. A translocation check before onboarding: `isTranslocatedPath(process.execPath)` (pure, packaging
   supplies it in app/src/shell/translocation.ts) => the window shows the "move to Applications" screen
   and does not ask for Screen Recording (renderer side is packaging's Task 9).
5. One IPC beside `openWhatLeaves`: `openLicences` opening `here("THIRD-PARTY-LICENSES.txt")` (file
   present only in packaged builds; a missing file is a fixed-code failure, not a crash).
`app/src/shell/lifecycle.ts`: no change unless D prefers a start-failure code for translocation.

## Open (waiting on the owner)

- All seven decisions of spec section 13 are made (2026-09-22). Still owner-only: the Developer Program (Task 7).
- The download page URL for About's click-only link, plus an `openDownloadPage` IPC from D's session (Task 9's last line).
- The change request for D's session was handed over by the owner (2026-09-22); Task 5's measurement waits for it.
- (closed) the self-exclusion edit was made by packaging with the owner's permission.
- Apple Developer Program enrolment under TeamEx (owner only).

## From D's session, 2026-09-22 — the change request landed (all five)

1. FLAVOUR imported from `shared/flavour` in `app/src/shell/app.ts`; no env read for it.
2. Start guard via the new pure `app/src/shell/launchMode.ts` (+ tests): packaged internal = stand-in
   API, real reader, real model, no smoke, `production=false`; packaged release (and any other
   packaged flavour value) = `production=true`, refused `NO_READER_YET` until D's client; unpackaged =
   the old switches exactly. `createEngine` gets `production: MODE.production`; `appInfo.standIns` is
   true for internal.
3. `standIns()` split into `standInApi()` / `standInReader()`: the fixture is read only when the dev
   reader is the reader.
4. `app/src/shell/translocation.ts` `isTranslocatedPath(execPath)` (+ tests) — D wrote it since it was
   needed for typecheck; replace it if yours differs. `AppInfo` gained OPTIONAL `translocated?: boolean`
   (optional so your `mockBridge` literal keeps compiling); when true the router's `requestPermission`
   is a no-op. The renderer screen (your Task 9) reads `appInfo.translocated === true`. Until then a
   translocated build shows ordinary onboarding with an Allow button that does nothing — do not hand
   an internal build to anyone before Task 9.
5. `openLicences` IPC: channel + `OpenLicencesResult = "opened" | "LICENCES_MISSING"` in
   `shared/ipc.ts`, router case, pure `app/src/shell/licences.ts` (+ tests), app.ts opens
   `here("THIRD-PARTY-LICENSES.txt")`. With the owner's say-so D added the two one-line entries in
   `renderer/bridge.ts` and `renderer/dev/mockBridge.ts` (mock answers `LICENCES_MISSING`); nothing else
   in renderer was touched. About's "Third-party licences" line is yours.
Verified: suite 3050 passed in 96 files, typecheck clean, `SMOKE OK`; independent review "approve with
reservations" (its two test gaps closed; mutation probes recorded in D's ledger). Side note from the
review, yours: `scripts/build.mjs` copies `standins-taxonomy.json` into dist for every flavour.
