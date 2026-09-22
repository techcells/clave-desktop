# Task 5 review: fuses, entitlements, signing; re-check of the Task 3 fixes (2026-09-22, independent reviewer)

Verdict A (Task 5): **approve with changes**. The fuse table, the per-file entitlement sets, the identity
rules and the real bundle match design 5.1, 5.2, 6.2-6.3 and rulings R17/R18; every one of the 25 Mach-Os
in the bundle is signed by "Clave Agent Dev" with the hardened-runtime flag, the helper carries no
entitlement, no forbidden entitlement exists anywhere, `--verify --deep --strict` exits 0, the wire read
back is the table. One important gap (I1: the report is left false after a failed run), the rest minor.
Verdict B (Task 3 fixes): **closed**. C1, I1, I2, I3 and minors M1, M3 (mostly), M4, M6 are fixed and
proven by the real file and by tests; M2, M5, M7, M9 stand as the ledger accepts them; one new minor each
in build.mjs (B1, B2) and one leftover of M3 (B3).

Timing: the packaging session re-ran build/stage/bundle/sign under me (build .0829 -> .0841; sign.mjs pid
81379, 13:41:19-13:43:57). Every count below was taken on both signed states and is identical; the mid-run
state was itself a probe (I1). Nothing was launched, signed or deleted.

## A. Findings

### Critical
None.

### Important

I1. A failed run leaves the bundle fused (and possibly signed) while bundle-report.json says the opposite.
sign.mjs:156-159 sets `report.fused`/`report.fuses` in memory; the report is written only at :163 (skip) or
:191 (success). Every failure after the flip (CODESIGN_FAILED :171, VERIFY_FAILED :174,
ENTITLEMENTS_UNREADABLE :177, ENTITLEMENTS_WRONG :179, HARDENED_RUNTIME_MISSING :183) returns 1 without
writing, so the file on disk keeps the bundle step's `fused:false, signed:false` although the binary is
fused, ad-hoc re-signed by @electron/fuses (`resetAdHocDarwinSignature`: index.js:191-205, `codesign
--sign - --force --deep`), and in the VERIFY/ENTITLEMENTS/RUNTIME cases fully signed by the identity. The
sign.test.ts real-bundle block then skips both checks (`if (report.fused)`, `if (report.signed)`), and
design 6.2 says the report is the record of the run. Probe (observed, not induced): at 13:42:57 the
report read `fused:false, signed:false, identity:null` while `getCurrentFuseWire` already returned the
table and the main executable was `flags=0x2(adhoc)`. Fix: write the report on every exit after
flip() with `fused:true`, `signed:false` and `signError:<code>`; a rerun is otherwise fine (flipFuses is
idempotent, osx-sign uses `--force`).

### Minor

M1. The helper is not "signed separately, first" (design 6.2 step 5, plan Task 5); it is signed by
osx-sign's own walk. osx-sign 2.7.0 sign.js:49-73 ranks `Contents/MacOS/clave-reader` as a bundle main
executable (regex `\.app/Contents/MacOS/[^/]+$`), the same rank as the app executable, in readdir order.
The outcome is right (helper Timestamp 13:43:54, app 13:43:55; helper `flags=0x10000(runtime)`, identifier
`clave-reader`, `Info.plist=not bound`) and sign.mjs:176-183 would refuse a wrong outcome, so this is a
description mismatch in the ledger ("helper first") rather than a defect.

M2. osx-sign signs 229 non-Mach-O files (223 `.pak`, plus icns, nib, dat, bin, bundle and app.asar) as
extended-attribute signatures, one timestamp request each: util.js:70-75 uses `isbinaryfile`, not a Mach-O
check. Probe: `xattr` lists `com.apple.cs.CodeDirectory` on 229 files, none of them Mach-O. Harmless, but it
is the 149 s, and the ledger's "walk finds every Mach-O" understates what is signed; an `ignore` for
`\.pak$` would cut most of it.

M3. Ledger fact to correct: osx-sign's default.darwin.plist is jit + audio-input + bluetooth + camera +
print + usb + location + photos-library, and it applies to EVERY file without (Plugin)/(GPU)/(Renderer) in
its path (sign.js:106-129): dylibs, .node, the helper and the plain `<App> Helper.app`. So entitlementsFor
giving the plain helper `[JIT]` is a reduction, not "what osx-sign would" (sign.test.ts:76 title).

M4. harden.mjs:90: the `(GPU).app` and `(Renderer).app` tests are dead given the `${appName} Helper` test on
the same line (mutants H18, H25 survive), and `Electron Helper.app` never matches a packager bundle (helpers
are renamed; H19 survives). Equivalent code, but the comment at :79-80 reads as four cases.

M5. sign.mjs:143 `pgrep -f <appPath>/Contents/MacOS` matches any command line containing the path (a
`codesign`, a `file`), so APP_RUNNING can refuse falsely; safe direction, reused as the plan asked.

M6. parseIdentities: `security find-identity -p codesigning` prints "Matching" and "Valid identities only"
sections, so a trusted identity appears twice (probe: 3 entries for 2 identities); `find` takes the first.

Logic questions from the brief, answered: identity is decided before the flip (:149-154, good); the flip
happens without `--sign` by design (header :5-6) and before signing is known to succeed (I1);
readEntitlements on an executable with no entitlements: `codesign -d --entitlements - --xml` exits 0 with
0 bytes (probed on libffmpeg.dylib, on the ad-hoc dev helper, and on the ad-hoc mid-run main executable),
which :107 turns into `{}`, and the helper's empty-dict plist converts to `{}` too; the `flags=` regex on
-dvv stderr yields `0x10000(runtime)` on every signed file here (thin arm64; a fat binary would print one
CodeDirectory per slice and the first is taken, acceptable); nothing runs at import (importing sign.mjs and
harden.mjs in the copy: 8 and 7 exports, no output, no `out/` created; dev-bundle.mjs and stage.mjs are gated).

## A. Design match and tool facts

Fuses: RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments,
GrantFileProtocolExtraPrivileges off; EnableCookieEncryption, EnableEmbeddedAsarIntegrityValidation,
OnlyLoadAppFromAsar on; LoadBrowserProcessSpecificV8Snapshot off and WasmTrapHandlers on = Electron's
defaults; all nine named in FUSE_TABLE, and fuseConfig refuses an unlisted or unknown one. The enum in
@electron/fuses 2.1.3 config.js:10-18 is exactly 0..8 with WasmTrapHandlers = 8; FuseState DISABLE 48 /
ENABLE 49 / REMOVED 114 / INHERIT 144 (constants.js:4-7); `resetAdHocDarwinSignature` index.js:191-205.
Entitlements: main executable = level 0 (three keys), helper = none, GPU/Renderer/plain helper = jit,
Plugin helper = jit + unsigned-memory + no-library-validation; frameworks, 6 dylibs, 2 .node, 5 .so,
chrome_crashpad_handler, ShipIt = none. No forbidden key on any of the 25 Mach-Os. Release: SIGN_REQUIRED
without --sign, RELEASE_NEEDS_DEVELOPER_ID for the self-signed name, IDENTITY_NOT_TRUSTED for an untrusted
Developer ID (mutants S6, S9, S10 killed). Identity handled as a name only: sign.mjs keeps `trusted` and
`name`, never the hash (test :108); the report holds the name; osx-sign validates with `security
find-identity -v` (util-identities.js:13) only when `identityValidation` is true, i.e. for a Developer ID;
`security find-identity -p codesigning` on this machine: 1 identity, "Clave Agent Dev", not trusted, 0 valid.

## A. Real bundle (paths relative to the .app; counts only)

- `codesign --verify --deep --strict --verbose=2`: exit 0 (22 lines; "valid on disk", "satisfies its
  Designated Requirement").
- `codesign -dvv`: app and main executable Identifier=dev.clave.agent.internal, Format=app bundle Mach-O
  thin arm64, flags=0x10000(runtime), Authority=Clave Agent Dev, TeamIdentifier=not set, Sealed Resources
  files=436; clave-reader Identifier=clave-reader, runtime, Info.plist=not bound; Helper (Renderer).app
  Identifier=dev.clave.agent.internal.helper, runtime; Electron Framework.framework
  Identifier=com.github.Electron.framework, runtime, Sealed Resources files=231.
- Mach-Os: 25 (691 regular files, 14 symlinks). Signed 25, unsigned 0, ad-hoc 0, without runtime flag 0.
  With a non-empty entitlement set: 5 (main + 4 helper executables); with an empty dict: 3 (clave-reader,
  chrome_crashpad_handler, ShipIt); 17 with no entitlement blob at all.
- Fuse wire via getCurrentFuseWire (repo node_modules): the nine values equal the table; keys 0..8 + version.
- Report: fused true, signed true, identity "Clave Agent Dev", developerId false, level 0, entitlements
  main = the three of level 0, helper = [], codesignFlags 0x10000(runtime) both.

## B. The Task 3 fixes

- C1 CLOSED. Real file: `react 19.2.0`, `react-dom 19.2.0`, `scheduler 0.27.0`, `zod 4.6.5`, each
  "(compiled into the application code)", source https, "Licence: MIT", followed by its own MIT text with
  copyright line (4 lines matched; Licence lines 146 = 1 + 2 + 27 + 111 deduped roots + 4 bundled + 1).
  dist/bundled-packages.json: 4 entries, all with text; absent from staging/app/dist (DIST_STAGING_ONLY,
  stage.test.ts:43-45 requires it and refuses shipping it). Refusals: build.mjs:95 BUNDLED_PACKAGE_UNRESOLVED;
  licences.mjs:234/236/237 BUNDLED_PACKAGES_MISSING (missing, unparseable, empty) and :268 (none bundled).
- I1 CLOSED. rc 1.2.8 block (lines 1769-1842) prints LICENSE.MIT ("The MIT License / Copyright (c) 2011
  Dominic Tarr"); 0 "Apache License" in it; pickLicenceFile tests :106-116; mutants L1, L2, L5 killed.
- I2 CLOSED. render refuses APPENDIX_TEXT_MISSING (licences.mjs:188-189; test :180-184; L13 killed); texts
  now MIT 162, ISC 111, Zlib 132, Unlicense 197, Apache-2.0 notice 78, BSD-2 185, BSD-3 216, 0BSD 97 words.
- I3 CLOSED. Unlicense in licences.fixed.json = 197 words, word sequence identical to
  ~/.cargo/registry/src/*/memchr-2.8.3/UNLICENSE (0 only-in-fixed, 0 only-in-reference).
- M1 CLOSED (ansi-regex 5.0.1 and strip-ansi 6.0.1 once each; generateLicences dedupes by name@version at
  :218). M3 MOSTLY: 0 git@/git:///git+ lines; but normaliseSource keeps `http://` (regex `https?`, mutant
  L12 survives) and the real file prints `http://kael.me/` (line 1035) while the ledger says "only as https
  URLs" (B3, minor). M4 CLOSED (DEL and C1 refused, tests :99-100; L20, L21 killed). M6 CLOSED
  (PACKAGE_UNNAMED :217 and :239). M5, M2, M7, M9: unchanged, as the ledger records. The six mutants the
  Task 3 review named (LF4, MS2, RN3, RN6, RN8, CT3) now have tests (:34, :142, :163, :161, :180, :99-100).
- B1 (minor). build.mjs:97 takes `readdirSync(dir).filter(licence).sort()[0]`: the I1 pattern again for a
  bundled package with several licence files (none today: react, react-dom, scheduler, zod ship one each).
  Use pickLicenceFile, or store all files and choose at staging.
- B2 (minor). build.mjs:98-105 pushes `pkg.version` unchecked and uniquePackages (bundled.mjs:41) silently
  drops an entry whose version is not a string, so a bundled package.json without a version would vanish
  from the licence file instead of refusing (PACKAGE_UNNAMED at licences.mjs:239 never sees it). Refuse in
  build.mjs before uniquePackages.
- B3 (minor). http:// sources, above.

## Surviving mutations (21 of 96; 0 not applied; each by exact string in the copy, vitest re-run each time)

harden: H15 main-executable test loosened to `/Contents/MacOS/${appName}` (equivalent here); H16 helper
branch removed (falls through to `[]`, equivalent); H18 `(GPU).app` removed, H25 `(Renderer).app` removed,
H19 `Electron Helper.app` removed (all dead code, M4); H22 backslash normalisation removed; H24
allow-dyld-environment-variables dropped from FORBIDDEN_ENTITLEMENTS (worth a test: assert the whole list
of design 5.2); H26 `(Plugin).app` -> `(Plugin)`. sign: S1 hash length `{40}` -> `+`; S12 isDeveloperId
startsWith -> includes (worth a test: "X Developer ID Application: Y" must refuse); S18 level regex
unanchored (`--level 1x` -> 1; worth a test). bundled: B1 `startsWith("node_modules/")` removed and B2
`includes("/node_modules/")` removed (pnpm paths satisfy both; a hoisted layout would not: worth one
fixture each); B5, B6, B7, B8 loop-bound and scope/dot guards (no fixture with a `.pnpm/package.json` or
`@scope/package.json`). licences: L3 `named.length === 1` -> first match (worth a test with two files
naming the licence); L4 empty-token guard removed (equivalent while L3 holds); L12 `https?` -> `https`
(B3: decide which is wanted, then test it); L14 blank standard text accepted (worth a test).

## Commands run (copy at scratchpad/review-task5/app, node_modules = per-package symlinks; no pnpm, no git)

- `node .../vitest/vitest.mjs run --root <copy> scripts`: Test Files 11 passed, Tests 414 passed (real-
  bundle and real-file blocks skip in the copy; the 4 sign/licence/bundled test files are among the 11).
- mutate.mjs: 96 mutations (28 harden, 33 sign, 15 bundled, 20 licences), 75 killed, 21 survived.
- `tsc -p <copy>/tsconfig.json --noEmit`: 1 error, the unlinked node-llama-cpp module; 0 under scripts/.
- Import test: `import(sign.mjs)`, `import(harden.mjs)` in the copy: exit 0, no output, no files.
- Real bundle: `file` over 691 files -> 25 Mach-O; `codesign -dvv` x 25 + 5; `codesign -d --entitlements -
  --xml` x 25 (+ 3 probes of the empty case); `codesign --verify --deep --strict --verbose=2` x 2 (exit 0
  both); `xattr` over 691 files (229 signed non-Mach-O); getCurrentFuseWire x 3; `security find-identity
  -p codesigning` x 1; `plutil -extract CFBundleIdentifier` x 4 (all four helpers:
  dev.clave.agent.internal.helper).
- Real licence file (13:41:13): 2634 lines, 135,185 bytes, 146 Licence lines, 34 appendix references, 1
  appendix section [MIT], 23 "distributed here under", 0 DEL/C1/C0/U+FFFD/CR, 0 git spellings, 1 http://.
- Tool sources read: osx-sign 2.7.0 sign.js, util.js:70-75,114-145, util-identities.js:10-26, the
  default.darwin*.plist files; @electron/fuses 2.1.3 config.js, constants.js, index.js; packager 20.3.0
  resolves @electron/osx-sign to 2.7.0 (symlink checked).
