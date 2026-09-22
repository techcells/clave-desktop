# Task 4 review: the bundle (2026-09-22, independent reviewer)

**Verdict: approve with changes.** The bundle matches design 4.1, 4.2 and 5.3 in every probed
respect and every refusal fires; the changes are one guard gap in `bundle()` and test pinning.
Reviewed on a private copy under `scratchpad/review-task4/` (no pnpm, no git, no install, nothing
launched); the copy's `bundle.mjs` was run for real against a scratch `--out` (`out2`) with the
repo's staging copied in. Note: the repo's `app/out/internal/bundle` was re-bundled (13:26:07) and
ad-hoc signed (13:26:10, `_CodeSignature` appeared) by another session while this review ran, and
`bundle.test.ts` was edited on disk after my read; the findings below are against the version I
read (`bundle.mjs` is unchanged). Probes of "the real bundle" were taken at 13:16-13:20 (unsigned)
and repeated on my own scratch build, which reproduces the report byte for byte.

## Findings

### Important

I1. The running-app guard protects less than `rmSync` deletes. `bundle.mjs:238-245`: `pgrep` is
run only when `appPath` exists and only for `appPath/Contents/MacOS`, but line 245 removes the whole
`<out>/<flavour>/bundle` folder. Probe A2: a process holding `<bundleOut>/Other.app/Contents/MacOS`
in its command line (a marker `node` process, no app launched) -> `BUNDLE_OK`, `Other.app` gone.
Realistic after a rename of the app or once Task 5/6 leave a signed copy beside it. Fix: when
`bundleOut` exists, probe `pgrep -f <bundleOut>` (the folder that is deleted), not `appPath`.

I2. The design's plist and asar assertions are pinned only through the function under test.
`bundle.test.ts:113` builds `goodBundle`'s plist from `expectedPlist(options)` and the from-disk test
(`:156-166`) derives its expectation the same way, so dropping any of `CFBundleName`,
`CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleShortVersionString`, `CFBundleVersion`,
`LSMinimumSystemVersion`, `LSApplicationCategoryType`, `NSHumanReadableCopyright` from
`expectedPlist` (`bundle.mjs:110-123`) survives every test, with and without a bundle (E2-E6,
E8-E10 below). Same pattern: 7 of 8 `ASAR_REQUIRED` entries (`bundle.mjs:47`), 3 of 4 required
bundle files (`:138`), `eval-gate.mjs` in `ASAR_FORBIDDEN` (`:48`). Fix: `toEqual` the constants and
`expectedPlist(options)` output literally (as `PLIST_REMOVE`/`PLIST_SET` already are); in the
from-disk test assert `LSMinimumSystemVersion === "14.0"`, `LSUIElement === true`,
`CFBundleIdentifier === BUNDLE_IDS[flavour]` as literals; one `codes()` case per required entry.

I3. The from-disk test as reviewed (`bundle.test.ts:169`) asserts the helper is byte-identical to
staging, which is false as soon as Task 5 signs in place (design 12 says the bundle test also runs
on a signed bundle). Observed: after the 13:26 signing the test fails at line 169 (`cmp` differs at
byte 1729; helper identifier now `clave-reader-5555...`). The Task 5 session has since patched the
test on disk to gate on `report.signed`; not re-reviewed here, but note for its reviewer that
`codesign -d` writes to stderr (probe 1: stdout empty, 9 stderr lines), so the new
`expect(stdout).toBe("")` at line 173 passes vacuously, and the report still said `signed: false`
two seconds after signing.

### Minor

M1. `findElectronZip` test (`bundle.test.ts:52`) lists the x64 and `44.4.10` candidates after the
wanted one, so `endsWith`, `includes` and `startsWith`-without-arch all survive (Z2-Z4). Put the
x64 zip first.
M2. `--flavour dev` is accepted by `requestedFlavour` and refused late: `STAGING_MISSING` with no
dev staging (probe P3), `DEV_FLAVOUR_NOT_PACKAGED` only when one exists (P5). Refuse up front.
M3. `bundle.mjs:253` swallows every `plutil -remove` failure; probe 4: absent key, missing file and
present key give exit 1, 1, 0, so a broken plist or path is indistinguishable from "not present".
Backstopped by `PLIST_KEY_PRESENT` at the end (fails safe, misleading code). Check presence first.
M4. `bundle.mjs:239` passes the app path to `pgrep -f` unescaped: `.` matches any character
(harmless) and a `--out` containing `(` gives exit 2 (probe 2) -> `PGREP_UNANSWERED`, a safe but
puzzling refusal.
M5. `bundle.mjs:214`: a manifest that exists but does not parse reports `STAGING_MISSING`.
M6. `bundle.mjs:245` removes the previous bundle and report before the Electron zip is extracted; a
`PACKAGER_FAILED` leaves nothing behind. Acceptable, but say so in the script's header.
M7. The packager's out folder `<name>-darwin-arm64` is mode 0700 (inherited from its `mkdtemp`) and
holds `LICENSE`, `LICENSES.chromium.html` (20 MB) and `version` beside the `.app`; Task 6 must
take `report.appPath` only.
M8. `report.bytes.app` is the sum of file sizes (380,039,758; on-disk blocks give 383,000,576); the
ledger's "on disk" wording is inexact.
M9. `checkBundle` is flavour-blind: `dist/standins-taxonomy.json` ships in the internal asar (allowed
by 4.2) and nothing here would refuse it in a release asar; stage.mjs's tests own that today.
M10. Design 4.1 says mac-arm64-metal holds "the .node and the four dylibs"; it ships 10 Mach-O files
(1 `.node`, 4 `.dylib`, 5 `.so`). Task 5 signs 25 Mach-O files in total (list below).
M11. `bundle.mjs:234` assumes packager keeps `info.appName` verbatim; packager applies
`filenamify(name, "-")` (common.js:7-11). True for both fixed names, so only a note.

## Design match (item 1)

All present in the real bundle and in the scratch build: helper at `Contents/MacOS/clave-reader`,
mode 755, byte-identical to staging (before signing); executable `Clave Agent Internal`;
`CFBundleIdentifier dev.clave.agent.internal`, helpers `dev.clave.agent.internal.helper`; asar
with `node_modules/node-llama-cpp` (incl. its nested `node_modules`) and
`@node-llama-cpp/mac-arm64-metal` unpacked whole plus reflink's `.node`; no `Resources/app`;
`LICENSE` + `LICENSES.chromium.html` in Resources; plist has `LSUIElement`, `LSMinimumSystemVersion
14.0`, category, copyright "Copyright © 2026 TeamEx", version 0.1.0, build 20260922.0815,
`ElectronAsarIntegrity`, `NSRequiresAquaSystemAppearance false`, and none of the five usage strings
(the cached template plist has all five, so the hook did remove them). Refusals probed on the copy:
`OUT_IS_APPLICATIONS`, `ELECTRON_ZIP_MISSING` (cache pointed at a missing dir, no download),
`STAGING_MISSING`, `FLAVOUR_REQUIRED staged: internal,release`, `DEV_FLAVOUR_NOT_PACKAGED`,
`STAGING_FLAVOUR_MISMATCH`, `APP_RUNNING` (marker process, probe A1). All fired.

## Packager 20.3.0 facts (item 2): all four confirmed

- afterExtract before the plist is read: `packager.js:113-124` (`createApp`: extract, `runHooks
  afterExtract` at 92-100, then `app.create()`), `mac.js:581-596` (`initialize` then
  `updatePlistFiles`), `mac.js:257-261` (`loadPlist` reads the template only there).
- `asarIntegrityDigest`: `mac.js:432-443` -> `setIntegrityDigest` writes the digest into
  `Electron Framework` (`:454-517`), `resetFrameworkAdHocSignature` runs `codesign --sign - --force
  --deep` (`:527-540`), before `signAppIfSpecified` (`:591-593`). Empirically the framework shows
  `flags=0x2(adhoc)`, no longer linker-signed, while the app and helper keep the template's
  `linker-signed` state until Task 5.
- `extendInfo` cannot delete: `mac.js:212-223` is `Object.assign`; `types.d.ts:401-413`.
- Out folder: `common.js:10-15` `${sanitizeAppName(name)}-${platform}-${arch}`.
- Also confirmed: `electronZipDir` never downloads (`packager.js:141-154`); `@electron/asar` 4.3.0
  `unpack` is one minimatch with `matchBase` (`asar.js:107`) and `unpackDir` matches the brace
  pattern then children by prefix (`asar.js:15-22`). Nothing in the ledger's Task 4 record was
  left unconfirmed.

## Real bundle (item 4), counts only

- `Contents/MacOS`: 2 files (`Clave Agent Internal`, `clave-reader`). `Contents/Resources`: 5
  entries + 55 `.lproj` folders. `Contents/Frameworks`: 4 helper apps (all
  `dev.clave.agent.internal.helper`), Electron Framework (`com.github.Electron.framework`), Mantle
  (`com.electron.mantle`), ReactiveObjC (`com.electron.reactive`), Squirrel (`com.github.Squirrel`).
- asar: 1793 entries (12 under `dist/`, 1780 under `node_modules/`, 102 packages, `package.json`);
  none of 4.2's must-not-ship patterns matched except `dist/standins-taxonomy.json` (allowed for
  internal); no `.map`, no fixtures, no `scripts/`, no `src/`, no `.pnpm`/`.bin`, no dotfiles.
- `app.asar.unpacked`: 423 files, 67 dirs, 0 links; folders `node-llama-cpp`,
  `@node-llama-cpp/mac-arm64-metal`, `@reflink/reflink-darwin-arm64`; the only file outside the two
  roots is reflink's `.node`.
- Mach-O: 25 (10 in mac-arm64-metal `bins/`, 1 reflink `.node`, 2 in `Contents/MacOS`, 4 helper
  app executables, 4 framework binaries, 2 Electron Framework `Libraries`, 1 Framework `Helpers`,
  1 Squirrel `Resources`). Symlinks: 14, all under `Contents/Frameworks/*.framework`.
- `ElectronAsarIntegrity`: one key `Resources/app.asar` -> `{algorithm: SHA256, hash: 64 hex}`.
- `codesign -dvv` (13:16 build): app `Identifier=Electron`, `flags=0x20002(adhoc,linker-signed)`,
  `Sealed Resources=none`; helper `Identifier=clave_reader-cb34ab3beaa8eacd`, same flags; framework
  `flags=0x2(adhoc)`. (By 13:26 the repo's copy was ad-hoc signed by the Task 5 session.)

## Surviving mutations (item 3; copy; each run with and without a bundle reachable)

Z1 backslash normalisation removed; Z2 basename equality -> `endsWith`; Z3 -> `includes`; Z4 arch
dropped + `startsWith`; P2 `!info` guard dropped (throws instead of an error object); P5 version
check removed; P6 empty version allowed; P9 Electron regex loses `$`; P10 loses `^`; E2-E6, E8-E10
`expectedPlist` drops each named key; E11 `LSMinimumSystemVersion` literal `"13.0"` (survives only
without a bundle); K4 exec bit owner-only; K6/K7/K9 required file `app.asar` / `LICENSE` /
`Info.plist` dropped; K10 `has()` ignores kind; K15 listing-level `.map` rule removed; K18 `!==`
-> `!=`; K21 integrity inner-key check removed; K23 x7 `ASAR_REQUIRED` entries other than
`THIRD-PARTY-LICENSES.txt`; K25 `eval-gate.mjs` dropped from `ASAR_FORBIDDEN`; K33
`startsWith(root)` without the slash. 35 of 103 survived; all others killed (list in
`scratchpad/review-task4/mutate.mjs`).

## Commands run (results as counts)

- `vitest run --root <copy> scripts/package`: 3 files, 51 passed. `bundle.test.ts` alone: 10
  passed (no bundle), 11 passed (bundle linked). Mutation harness: 103 mutations x 2 runs.
- `node <copy>/scripts/package/bundle.mjs --out <scratch>/out2`: `BUNDLE_OK` in 3.3 s, bytes
  380039758 / asar 6784519 / unpacked 52510676 (identical to the repo's report). Six refusal probes
  and two marker-process probes as listed above.
- `find | xargs file | grep Mach-O`: 25. `find -type l`: 14. `ls *.lproj`: 55. asar `listPackage`:
  1793. `cmp` helper vs staging: identical (unsigned build). `plutil -convert json` on the plist:
  29 keys, 0 of the 5 usage strings; `unzip -p` of the cached template plist: 5 usage strings.
