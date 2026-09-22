# Task 6 review: notarisation, DMG, ZIP, Gatekeeper checks (2026-09-22)

Reviewed: app/scripts/package/artefacts.mjs, artefacts.test.ts, package.json `package:artefacts`, the real
run under app/out/internal/artefacts/ (report, DMG, ZIP). Private copy of app/ (no node_modules, dist,
dist-preview, out, native/reader/target, reader-eval/out) with symlinked packages; vitest run directly;
nothing in the repo edited except this file; nothing launched, re-signed or submitted.

## Verdict: APPROVE WITH CHANGES

The artefacts are what the design asks for and the order of operations is right. Three things must
change before the notarised run of Task 8: two spec-required records are missing from the report, and a
failed run leaves a final-named DMG with no report. The test file needs the check plan asserted in full.

## What matches the design (verified)

- Order (artefacts.mjs:151-177): notarise+staple the .app in place, THEN ditto-copy it into dmg-root,
  THEN hdiutil, codesign the DMG, submit+staple the DMG, THEN ZIP the original (stapled) app. The staple
  ticket (`Contents/CodeResources`, a plain file) is therefore inside both the DMG copy and the ZIP.
- @electron/notarize 3.1.1 (lib/index.js, notarytool.js, staple.js): `notarize({appPath, keychainProfile})`
  runs `codesign -vvv --deep --strict`, zips with `ditto --sequesterRsrc --keepParent` into a tmp dir,
  `xcrun notarytool submit <zip> --keychain-profile <name> --wait --output-format json`, fetches
  `notarytool log <id>`, then `xcrun stapler staple -v` with 3 retries (promise-retry). Failure = throw
  (tmp dir removed). No `tool:` option exists in v3 (notarytool only). Only the profile NAME is passed;
  the credential path is the keychain's. It also accepts a `.dmg` appPath (signature check skipped,
  submitted directly, stapled) — see Minor 6.
- No credential flag in any argv (test artefacts.test.ts:77-80); the report holds names, sizes, hashes,
  exit codes only. Nothing read from the keychain by the script.
- Release refuses without a profile (`NOTARIZE_REQUIRED`) and without a Developer ID
  (`NOTARIZE_NEEDS_DEVELOPER_ID`); unsigned refuses everywhere (`ARTEFACT_NEEDS_SIGNED`).
- Real DMG: `hdiutil imageinfo` = UDIF read-only compressed (zlib), HFS+ partition; mounts read-only on
  macOS 27.0 (`hfs` personality, volume "Clave Agent Internal", spaces fine). Root holds exactly
  `Clave Agent Internal.app` and `Applications -> /Applications`; no .DS_Store, no dotfiles (find -maxdepth
  1 -name ".*": 0). App inside: 1091 entries, 14 symlinks (bundle: 1091, 14); `codesign --verify --deep
  --strict` valid; CDHash ec949190…8cbc identical to the bundle's. DMG `codesign -dvv`: Authority=Clave
  Agent Dev, timestamped, Format=disk image; `--verify` valid; spctl 3 (rejected, self-signed); stapler
  validate 65 (no ticket). All as the report records.
- Real ZIP: one top-level entry (`Clave Agent Internal.app/`, 2181 entries, 0 `__MACOSX`, 0 .DS_Store);
  `ditto -x -k` round trip: 1091 entries, 14 symlinks, codesign verify valid, same CDHash.
- The from-disk test passes against the real run (12 tests with out/ present, 11 without).

## Findings

### Important

I1. The notarytool log is never saved and diagnostics are truncated away (artefacts.mjs:154, 168-170).
Spec 6.2 step 9 and the plan's Task 6 both list "`xcrun notarytool log` for the submission" in the run
report. For the app, @electron/notarize already fetches the log and puts it in the thrown error, but
line 154 keeps only `message.split("\n")[0]` ("Failed to notarize via notarytool"), so a rejected
submission leaves no reason anywhere. For the DMG, `r.stdout` (the submission id) is discarded and no
`notarytool log` is run. Neither the app's nor the DMG's submission id reaches artefacts-report.json.
Fix: write the notarize error text and the DMG submit transcript to `artefacts/notary-app.txt`,
`artefacts/notary-dmg.txt` (they contain ids, paths and issue lists, never a credential with a keychain
profile), run `notarytool log <id> --keychain-profile <name>` for the DMG, record both ids in the report.
Probe: read lib/notarytool.js lines "Diagnostics from notarytool log" vs artefacts.mjs:154.

I2. The `codesign -dvv` chain and Team ID are not recorded (artefacts.mjs:83-92, 180-187). Spec step 9:
"`codesign -dvv` showing the Developer ID chain and the Team ID" recorded in the report. The plan has
only exit statuses; `codesign -dvv` is not in checkPlan at all, and spctl's `source=` line is dropped.
Fix: add `codesign-dvv-app` / `-dmg` to checkPlan (mustPass true), keep each check's stdout+stderr in
`artefacts/checks/<name>.txt`, and put the `Authority=`/`TeamIdentifier=` lines in the report.

I3. A failed run leaves a final-named artefact with no report (artefacts.mjs:142-147, 161-177, 188).
`rmSync(artefactDir)` runs first, the DMG is created under its final name, and every later `fail`
returns without cleaning up. Probe (private copy, scratch `--out`, fake bundle whose identity does not
exist): `ARTEFACTS_FAILED DMG_SIGN_FAILED 1`; afterwards artefacts/ holds `Fake-App-0.0.1-1-arm64.dmg`
(unsigned) and no report, the previous run's file is gone, and `dmg-root/` (a full app copy, 380 MB
for real) is left behind. A self-signed or unnotarised DMG named like a good one is exactly what
design section 2 says must not circulate. Fix: build into `artefacts.partial/` and rename on success,
or `rmSync` artefactDir and dmgRoot on every failure path.

I4. Tests do not pin the check plan (artefacts.test.ts:91-101). Surviving mutations M39, M41-M44 change
`mustPass` for spctl-dmg / stapler-* without a failure; M50/M51 turn `stapler validate` into
`stapler staple` (the checks would then WRITE to the artefacts); M49 changes the DMG spctl type/context.
Fix: `toEqual` the whole plan (name, cmd, args, mustPass) for `{developerId:false,notarized:false}`,
`{true,false}`, `{true,true}` and the impossible `{false,true}`; assert no `staple` token in any check.

### Minor

M-a. artefactBaseName (artefacts.mjs:21-24): non-string appName throws instead of returning null (M02);
a non-string version leaks "undefined" into the name (M04); `split(/\s+/)` and the character strip are
untested (M06, M07). One test with `{appName: 7}`, `{version: undefined}`, `"Clave  Agent/β"` closes it.
M-b. parseNotarizeArg (:33): a blank profile and a single-dash profile ("-p") are accepted at this level
(M14, M16); "-p" would reach notarytool as `--keychain-profile -p`. Refuse `startsWith("-")`, test blank.
M-c. notarizeDecision (:43, 45): `signed: "yes"` / `developerId: "yes"` behave like true under the
`!==`→`!` mutations (M19, M25) and no test pins the strict boolean. One test with string values.
M-d. notaryStatus (:75): "Rejected" is untested (M36) and the `^\s*` anchor is untested (M32); also
it reads stdout only, while @electron/notarize merges both streams and parses `--output-format json`.
Use `--output-format json` and `JSON.parse(...).status` (unverified here which stream notarytool uses).
M-e. `hdiutil create`/`attach` print "deprecated, use diskutil image ..." on macOS 27.0 (still work,
exit 0; HFS+ remains in the `-fs` list beside APFS). Record this in the design's section 0 facts; keep
HFS+ (widest mountability) unless the owner decides otherwise.
M-f. The DMG's submit/status/staple trio (:65-77, 167-173) re-implements what `mod.notarize({appPath:
dmgPath, keychainProfile})` already does for `.dmg` (JSON parsing, log fetch, staple with retry).
Reusing it would delete notarySubmitCommand, notaryStatus, stapleCommand and close I1 for the DMG.
M-g. @electron/notarize is reached through @electron/packager's `^3.1.0` range (package.json has no
direct entry); pin `"@electron/notarize": "3.1.1"` as a devDependency so the version is the app's own.
M-h. If the staple retry (3 tries, ~7 s) fails after a successful submission, the run reports
`NOTARIZE_FAILED Failed to staple your application with code: N` and a rerun re-submits the whole app;
acceptable (Apple returns quickly for already-notarised content) but the report should say "resubmit".
M-i. No pre-flight check that the keychain profile exists (plan Task 6 asks for a fixed code); the
failure surfaces only after the 380 MB app is zipped. `xcrun notarytool history --keychain-profile
<name>` would be the probe but it is a network call; decide, and record the decision.

## Surviving mutations (tested; each listed with the meaning of the survival)

- M02 artefactBaseName: drop `typeof appName !== "string"` (throws on non-string).
- M03 drop `!appName.trim()` (equivalent: caught by `if (!name)` at :23).
- M04 drop `typeof version !== "string"` ("undefined" in the name).
- M06 `split(/\s+/)`→`split(" ")`; M07 drop the `[^A-Za-z0-9.-]` strip; M08 drop `if (!name)` (equiv.).
- M14 parseNotarizeArg: drop `!value.trim()`; M16 `startsWith("--")`→`startsWith("-")`.
- M19 `signed !== true`→`!signed`; M21 `=== null || === undefined`→`!profile` (equiv.); M25 `developerId
  !== true`→`!developerId`.
- M32 notaryStatus: drop `^\s*`; M35 drop `String()` (equiv.); M36 drop `Rejected`.
- M39 spctl-app mustPass→`notarized`; M41 spctl-dmg→`notarized`; M42 spctl-dmg→`developerId`;
  M43 stapler-app→`developerId && notarized`; M44 stapler-dmg→`developerId`.
- M48 codesign-verify-dmg drop `--verbose=2`; M49 spctl-dmg `open`+context→`execute`;
  M50/M51 `stapler validate`→`stapler staple` (app, dmg); M57 symlink name "Applications " (impure, no test).
- Killed (33): M05, M11-M13, M15, M17, M18, M20, M23, M26-M30, M33, M34, M37, M38, M40, M45, M46,
  M52-M56, M58-M61 (incl. the ledger's six: unsigned accepted, release skips, self-signed notarised,
  Gatekeeper never enforced [one form], only exit 1 counted, status with suffix). M09 hit a comment only.

## Commands run (results as counts/codes)

- vitest run --root <copy> scripts/package/artefacts.test.ts: 11 passed; with out/ symlinked: 12 passed.
- 55 mutations applied one at a time (node string replace, restore after each): 22 survived, 33 killed.
- hdiutil imageinfo <dmg>: UDIF read-only compressed (zlib), CRC32, 186,614,876 encoded bytes.
- codesign -dvv <dmg>: exit 0, Authority=Clave Agent Dev, Timestamp present, TeamIdentifier=not set.
- codesign --verify --verbose=2 <dmg>: 0. spctl --type open --context context:primary-signature: 3.
  xcrun stapler validate <dmg>: no ticket (report: 65).
- hdiutil attach -readonly -nobrowse -mountpoint <scratch>: mounted hfs read-only; root entries 2
  (app + Applications symlink to /Applications); hidden entries 0; app entries 1091; symlinks 14;
  codesign --verify --deep --strict: valid; CDHash equal to bundle; hdiutil detach: ejected.
- unzip -l <zip>: 2181 entries, 1 top-level name, 0 __MACOSX, 0 .DS_Store; ditto -x -k into scratch:
  1091 entries, 14 symlinks, verify valid, same CDHash.
- Failure probe (scratch --out, fake bundle, nonexistent identity): DMG_SIGN_FAILED 1; artefacts/ = 1
  unsigned DMG, 0 reports, previous file gone; dmg-root/ = 2 entries left.
- hdiutil create -help: deprecation warning; -fs list contains HFS+ and APFS. Xcode 27.0, macOS 27.0.
