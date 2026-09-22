# Packaging, signing and notarisation: design

Written 2026-09-22. Status: **decisions 1-4 DECIDED 2026-09-22; decisions 5-7 of section 13 open; Tasks 0-6 of the plan executed and reviewed (see the ledger).** Nothing in this document has
been built. The ledger for this sub-project is
`docs/superpowers/plans/2026-09-22-packaging-files/ledger.md`.

What this sub-project delivers: the development build turned into an installable Mac app that a
stranger can open without a malware-style warning, signed and notarised under the owner's Apple
Developer identity, without weakening any privacy property in `docs/WHAT-LEAVES.md`, and with the
Screen Recording measurements that sub-project C carried here repeated under the real identity.

## 0. Facts this design rests on (measured 2026-09-22 on the owner's machine)

| Fact | Value |
|---|---|
| Machine | macOS 27.0 (26A428), arm64, Xcode 27.0 with `notarytool` and `stapler` present |
| Signing identities | one identity in the login keychain ("Clave Agent Dev", self-signed); `security` counts **0 valid** identities, so the dev bundle signs only because `dev-bundle.mjs` looks the name up without validation. No Developer ID exists yet |
| Electron | 44.4.1 (registry latest 44.4.3); `electron-v44.4.1-darwin-arm64.zip` is already in `~/Library/Caches/electron`, so a packager that fetches Electron through `@electron/get` runs **offline** |
| `Electron.app` on disk | 307 MB, all locales; it ships helper apps (GPU, Plugin, Renderer), Squirrel, Mantle and ReactiveObjC frameworks |
| The dev bundle | `~/Applications/Clave Agent Dev.app`, 288 MB, bundle id `dev.clave.agent.dev`, executable still named `Electron`, helper at `Contents/MacOS/clave-reader`, thin launcher requiring the checkout |
| `app/dist` | 3.6 MB: `main.cjs`, `preload.cjs`, `model-host.mjs`, `eval-gate.mjs`, `reader-eval.cjs`, `renderer/`, `standins-taxonomy.json`, `WHAT-LEAVES.md`, `native/clave-reader` (832 KB, arm64 only, ad-hoc linker-signed until the bundle step signs it) |
| Runtime `node_modules` the app needs | only `node-llama-cpp` 3.21.1 and its closure (react, react-dom and zod are bundled by esbuild). Mac-only closure: about 100 MB on disk, of which `node-llama-cpp` 40 MB (34 MB of it the `llama/` source tree used only for building from source), `@node-llama-cpp/mac-arm64-metal` 14 MB (one `.node`, four `.dylib`), the rest about 43 MB of plain JavaScript. The `pnpm list --prod` closure also names 14 other-platform binary packages and TypeScript (an optional peer); they must not ship |
| Licences in that closure | MIT 95, ISC 14, BlueOak-1.0.0 5, Apache-2.0 2, one triple-licensed; Electron, node-llama-cpp, llama.cpp, React, zod are MIT. The helper's 34 Rust crates are the objc2 family, serde, libc, memchr, itoa, bitflags, dispatch2, block2 and proc-macro crates (MIT or Apache-2.0 dual). The model (unsloth's Qwen3.5-4B GGUF) is downloaded, not bundled; its licence still has to be shown |
| Registry versions (read-only query, 2026-09-22) | `@electron/packager` 20.3.0, `@electron/fuses` 2.1.3, `@electron/osx-sign` 2.7.0, `@electron/notarize` 3.1.1, `@electron/asar` 4.3.0, `electron-builder` 26.15.3 on `latest` (26.16.1 published 2026-09-07 on another tag) |

Everything the measurements of phase 0 and C-2a/C-2b established about Screen Recording still holds
and shapes this design (spec C section 10, findings and first-run records): the grant follows the
**enclosing app bundle's identity** (bundle id plus certificate), reaches a helper started as a
child of the bundle's process, is named in the dialog and in the Settings list after the **.app file
name**, is invisible and irrevocable for an app in an unregistered location (temp folders), and
`requestPermission()` raises the system dialog only from an installed bundle.

## 1. Scope

In: the packaging scripts and their tests; the bundle layout; Electron fuses, hardened runtime,
entitlements and Info.plist; signing inside-out; notarisation and stapling; the DMG and ZIP; the
Gatekeeper checks; a bundled third-party licence file and the About screen line that opens it; a
translocation check at first run; the measurement protocol for P1, P2, P6 and the new P7; the
smallest changes in app code that packaging needs (section 9, coordinated with the other sessions).

Out: auto-update (section 8 offers the owner one honest alternative); Windows and Linux; Mac App
Store; Sentry and usage events; a universal (Intel) build (section 4.3 explains); CI.

## 2. Two flavours, and what a pre-D build is for

The owner asked (2026-09-22) whether he can test the final version himself and send it to a couple
of people before it is finished. Sub-project D (the real clave-back client) is being designed in
another session; until it lands, `app.ts` wires the stub API, and a packaged build refuses to start
(`NO_READER_YET`, and `createEngine` refuses stand-ins when `production`). So packaging defines two
flavours, chosen at **build time** and baked into the code by esbuild (`define`), never by an
environment variable (every environment switch stays inert when `app.isPackaged`, exactly as today):

| | **internal** | **release** |
|---|---|---|
| Purpose | the owner's own testing, a couple of trusted people, and the permission measurements under the real identity | the build strangers install |
| Reader | real (`clave-reader`) | real |
| Model | real, downloaded and verified as today | real |
| Backend | the **stub**: any sign-in accepted, approved statements appended to `stub-uploads.jsonl` in the data folder, **nothing leaves the machine** except the model download | the real clave-back client from D |
| File name and `CFBundleName` | `Clave Agent Internal` (`.app` file, Settings entry, dialog name, onboarding copy and the app's self-exclusion all say the same thing) | `Clave Agent` |
| Bundle id | `dev.clave.agent.internal` | `dev.clave.agent` |
| Data folder | `~/Library/Application Support/Clave Agent Internal/` | `~/Library/Application Support/Clave Agent/` |
| Marking | a permanent line in the window's footer and in About: "Internal build. Nothing is uploaded; approved statements stay in a local file." | none |
| Signing | Developer ID when it exists; the self-signed "Clave Agent Dev" certificate until then (owner's machine only) | Developer ID only; the script refuses anything else |
| Notarised | yes, once a Developer ID exists | yes |
| Can be built today | yes, except signing under the real identity | **no**: the script refuses to build it while the stub API is what `app.ts` wires (a test over the built bundle asserts it) |

The start guard is not weakened: `production` becomes `app.isPackaged && FLAVOUR === "release"`, so
the release flavour still refuses stand-ins exactly as now, and the internal flavour is packaged,
signed and notarised but is not a production build, cannot be mistaken for one (different name, id,
data folder and footer), and cannot upload anything because it has no client that could.

Consequence for the owner's question: he can test the internal flavour himself as soon as it is
built (today's dev bundle already gives him the same behaviour); a couple of people can be given the
**notarised internal build** once the Developer ID exists. Before that, a self-signed build handed to
somebody else is blocked by Gatekeeper on macOS 15 and later with an "Apple could not verify" dialog
and can only be opened through System Settings → Privacy & Security → "Open Anyway", which is the
malware-style path this sub-project exists to avoid; the recommendation is not to send one.

## 3. Tooling

**Recommendation: `@electron/packager` 20.3.0 and `@electron/fuses` 2.1.3, as devDependencies.**
Packager brings `@electron/osx-sign`, `@electron/notarize`, `@electron/asar` and `@electron/get`
as its own dependencies. Adding them is an install and waits for the owner's approval of that
execution; the plan will pin the exact versions it verifies at that moment.

Why packager and not electron-builder: (1) the repo already assembles and signs a bundle by hand in
`dev-bundle.mjs`, and every layout decision here is unusual (the helper in `Contents/MacOS`, a
launcher that must never ship, a fixture that must not ship in one flavour) and is best made in a
script with pure, unit-tested functions, which is packager's API shape; (2) the signing step inside
packager is `@electron/osx-sign`, which signs the framework, the four helper apps, every dylib and
`.node` inside-out in the right order with per-file entitlements, which `codesign --deep` (what the
dev bundle uses) does not do correctly for nested code; (3) packager computes the
`ElectronAsarIntegrity` hash that the asar-integrity fuse checks; (4) all of it is maintained by the
Electron project; (5) electron-builder carries its own dependency collector that has its own rules
for pnpm layouts, a far larger dependency tree, and a config surface most of which this app does
not use. What packager does **not** do and this design does with system tools: the DMG (`hdiutil`),
notarising and stapling the DMG (`xcrun notarytool`, `xcrun stapler`), the Gatekeeper checks
(`spctl`, `codesign --verify`, `stapler validate`).

Alternative kept on file: electron-builder 26.x, one dependency, `electronFuses`, `mac.notarize`,
DMG target built in. Chosen against for the reasons above; if the owner prefers it the layout and
hardening decisions below are the same, only the script changes.

The runtime `node_modules` is assembled by `pnpm deploy --prod` into the staging folder (offline;
pnpm's own command for exactly this), then pruned by a tested allow-list to the Mac closure (section
4.2), rather than copied out of the symlinked pnpm store. Never run `pnpm` against a copy whose
`node_modules` is a symlink (rule on file).

## 4. Bundle layout

### 4.1 What goes where

```
Clave Agent.app/
  Contents/
    Info.plist                       packager's, then edited (section 5.3)
    MacOS/
      Clave Agent                    Electron's executable, renamed (app.isPackaged is true)
      clave-reader                   the Rust helper, next to the executable (the measured layout;
                                     chooseHelperPath looks here first)
    Frameworks/                      Electron Framework, the four helper apps, Squirrel, Mantle,
                                     ReactiveObjC (as shipped by Electron; Squirrel is unused)
    Resources/
      app.asar                       package.json, dist/main.cjs, preload.cjs, model-host.mjs,
                                     renderer/, WHAT-LEAVES.md, THIRD-PARTY-LICENSES.txt,
                                     node_modules/ (the pruned closure, JavaScript only)
      app.asar.unpacked/
        node_modules/node-llama-cpp/            unpacked whole (its own file structure is load-bearing)
        node_modules/@node-llama-cpp/mac-arm64-metal/   the .node and the four dylibs
      Clave Agent.icns               the app icon (owner to supply; Electron's until then)
      en.lproj/ …                    Electron's locale folders (kept; pruning them is a later size step)
```

The model host is forked with `utilityProcess.fork(here("model-host.mjs"))` from inside the asar,
which Electron supports; `node-llama-cpp` is imported from `node_modules` inside the asar and its
`dlopen` of `llama-addon.node` is redirected by Electron to `app.asar.unpacked`. Whether the `llama/`
source tree (34 MB) inside node-llama-cpp can be left out is **measured, not assumed**: the plan
ships it whole first, then drops it and re-runs the real-model smoke and gate; the what-must-not-ship
test records the result.

### 4.2 What must not ship (asserted by a test over the built bundle's file list)

- `dist/reader-eval.cjs` (the development harness) and `dist/eval-gate.mjs` (a plain-Node gate, no
  use inside the app);
- `scripts/` entirely (the dev launcher, `dev-bundle.mjs`, `start-reader.mjs`, `reader-eval.mjs`);
- `dist/standins-taxonomy.json`, `eval/fixtures/**` and the `standins` code path in the release
  flavour; in the internal flavour the stub API's taxonomy ships, and the `01-work-english.json`
  fixture ships only if `app.ts` still reads it when the real reader is on (section 9 asks D's
  session to stop reading it, so that no fake screen text ships in any flavour);
- `src/`, tests, `tsconfig*`, `vitest.config.ts`, `pnpm-lock.yaml`, `README.md`, `.dev-launch.json`,
  `reader-eval/out/`, `dist-preview/`;
- source maps (the build already sets `sourcemap: false`; the test asserts no `.map` file);
- every `@node-llama-cpp/*` package other than `mac-arm64-metal`, every `@reflink/*` binary other
  than darwin-arm64, TypeScript, and node-llama-cpp's `bin` CLI entry (harmless but unused);
- anything under `node_modules/.pnpm`, `.bin`, or a symlink: the staging folder is dereferenced and
  the test asserts there is no symlink inside the bundle other than the ones Electron's own
  frameworks ship;
- no `.git`, `.DS_Store`, `.env`, keychain export, certificate or password anywhere in the bundle.

### 4.3 Architecture

**arm64 only** for v1. Reasons: the helper is built arm64 only; the model host needs Metal for a 4 B
model to answer within the budgets measured in S1 (the `mac-x64` binaries are CPU only); decision 1
of spec C already requires macOS 14, and every machine measured so far is Apple silicon. An
arm64-only app on an Intel Mac does not open ("not supported on this Mac"); the download page must
say "Apple silicon, macOS 14 or later". A universal build is a later decision that would need an
x64 helper build and a measured x64 model path. Cost if wrong: Intel users are turned away at the
download page rather than at first run.

## 5. Hardening

### 5.1 Electron fuses (flipped on the packaged binary, all flavours)

| Fuse | Value | Why, and what it must not break |
|---|---|---|
| `RunAsNode` | **off** | the app never uses `ELECTRON_RUN_AS_NODE`; the model host is a `utilityProcess`, the helper is a plain Mach-O child (spec C decision 5 chose this shape so this fuse could be off). `child_process.fork` would throw, and nothing calls it |
| `EnableNodeOptionsEnvironmentVariable` | **off** | nobody may inject `NODE_OPTIONS` into a process that reads screens |
| `EnableNodeCliInspectArguments` | **off** | no `--inspect`, no `SIGUSR1` inspector |
| `EnableCookieEncryption` | on | the renderer session is in-memory and cookieless; harmless and recommended |
| `EnableEmbeddedAsarIntegrityValidation` | **on** | the app code is hashed into `Info.plist`; a modified `app.asar` refuses to start |
| `OnlyLoadAppFromAsar` | **on** | the integrity check cannot be bypassed through the app search path. Requires everything the main process loads to be in the asar, which section 4.1 satisfies; unpacked files are reached through the asar's own redirection |
| `LoadBrowserProcessSpecificV8Snapshot` | off (default) | not used |
| `GrantFileProtocolExtraPrivileges` | **off** | the renderer loads exactly one `file://` page and every other request is cancelled already; the fuse makes the same rule Electron's own |

Each flip is checked against how the model host and the helper start (a packaged smoke run with the
scripted model is not possible, since the scripted switch is inert when packaged; the check is the
real-model gate plus the manual checklist in the plan).

### 5.2 Hardened runtime and entitlements

Hardened runtime is on for every Mach-O (notarisation requires it). Entitlements start from what
`@electron/osx-sign` applies by default to a Developer ID app and are **reduced by measurement**, one
at a time, in this order, keeping the smallest set under which the window opens, the model answers
through the utility process, and the helper reads a staged window:

| Entitlement | Start | Expectation |
|---|---|---|
| `com.apple.security.cs.allow-jit` | on | needed by V8 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | on | probably removable on current Electron; measured |
| `com.apple.security.cs.disable-library-validation` | on | should be removable: every dylib and `.node` we load is signed by the same Team ID; measured with node-llama-cpp's Metal path |
| `com.apple.security.cs.allow-dyld-environment-variables` | **off from the start** | nothing needs it |
| camera, microphone, audio input, AppleEvents/automation, network server, app sandbox | **never** | the app captures no sound and no picture, drives no other app, listens on nothing. The dialog says "screen and audio" because that is the TCC category's wording, not because anything asks for audio |

The helper `clave-reader` is signed separately, first, with hardened runtime and **no entitlements**
(no JIT, no dynamic libraries beyond system frameworks, as `otool -L` shows). The four Electron
helper apps get the child entitlements osx-sign gives them. Every entitlements plist is generated by
a script from a JavaScript object and byte-checked (the file-writing tools' escape problem on file).

### 5.3 Info.plist

Set: `CFBundleIdentifier` and `CFBundleName`/`CFBundleDisplayName` per flavour (section 2);
`CFBundleShortVersionString` = the version in `app/package.json` (0.1.0 today, bumped per build);
`CFBundleVersion` = a build number `YYYYMMDD.N`; `LSMinimumSystemVersion` **14.0** (spec C decision 1;
Electron's template says 13.0); `LSUIElement` **true** (tray app: no Dock icon, no Cmd-Tab entry;
`app.dock.hide()` stays as belt and braces); `LSApplicationCategoryType`
`public.app-category.productivity`; `NSHumanReadableCopyright` naming the owner's legal entity;
`NSHighResolutionCapable` true (already).

Removed: the usage strings Electron's template plist carries that are **untrue for this app** and
would suggest capabilities it does not have: `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSBluetoothAlwaysUsageDescription`,
`NSBluetoothPeripheralUsageDescription`. Removal happens before signing (packager's extract hook, so
its own plist rewrite keeps the deletion). There is no usage-string key for Screen Recording: the
measured dialog is macOS's own wording and carries no app-supplied sentence, so the onboarding copy
(which already prepares the user for "screen and audio" and for the .app file name) is where the
truth is told.

## 6. Signing and notarisation

### 6.1 Roles: what only the owner does

Enrolling in the Apple Developer Program under **TeamEx** (organisation enrolment: needs the legal
entity, a D-U-N-S number and a person with signing authority; Apple's review typically takes days
and can take weeks, so it should be started now); creating the **Developer ID Application**
certificate in Xcode or the developer site and having its private key in the login keychain;
storing the notarisation credential in the keychain with
`xcrun notarytool store-credentials clave-notary` (an App Store Connect API key is preferred over an
app-specific password because it can be revoked on its own); every keychain prompt; installing into
`/Applications`; every System Settings action, grant, revocation and `tccutil`. Agents never see or
type a password, an app-specific password, an API key or a `.p8` file, never print one, and nothing
of the kind is ever written under the repo. The scripts take the identity by **name**
(`Developer ID Application: <legal name> (<TEAMID>)`) and the notarisation profile by **name**
(`clave-notary`); both are looked up in the keychain at run time and the run refuses if either is
missing, with a fixed code.

### 6.2 The pipeline (`pnpm --dir app package -- --flavour internal|release [--sign] [--notarize] [--out <dir>]`)

1. `build` and `build:native` as today (the build takes the flavour and bakes it in).
2. Stage: `dist/` minus what must not ship, a generated `package.json` (name, version, `main`,
   `dependencies: {node-llama-cpp}` only), `pnpm deploy --prod` into the staging folder, prune to
   the Mac closure, generate `THIRD-PARTY-LICENSES.txt` (section 10). Everything written to
   `app/out/<flavour>/` by default; the script **refuses** `~/Applications` and `/Applications` as
   `--out`, and refuses to touch a bundle under a running app (the `pgrep` guard from
   `dev-bundle.mjs`, reused).
3. Packager: Electron 44.4.1 from the local cache (a run that would download is refused unless
   `--allow-download` is given, and that is an owner decision), asar with the unpack list, prune,
   Info.plist per section 5.3, icon, the helper copied to `Contents/MacOS/clave-reader`.
4. Fuses flipped (`@electron/fuses`, `strictlyRequireAllFuses`).
5. Sign inside-out: the helper first (hardened runtime, no entitlements), then osx-sign over the
   bundle with the per-file entitlements of section 5.2. Timestamped.
6. Verify: `codesign --verify --deep --strict --verbose=2`, `codesign -d --entitlements`, and the
   packaging tests over the bundle.
7. Notarise the `.app` (`@electron/notarize`, keychain profile) and staple it.
8. Artefacts: a **DMG** (`hdiutil`, the app plus an `Applications` symlink, so the user drags it and
   translocation never happens), signed, notarised and stapled itself; and a **ZIP** of the stapled
   app (`ditto -c -k --keepParent`) for the internal flavour and for anyone who prefers it.
9. Gatekeeper checks, all recorded in the run's report: `spctl --assess --type execute -vv`,
   `stapler validate` on the app and the DMG, `codesign -dvv` showing the Developer ID chain and
   the Team ID, and `xcrun notarytool log` for the submission.

The program half of every script is gated on being the entry point, and every decision (file lists,
flavour, plist edits, entitlement sets, fuse table, argument parsing, refusal conditions) is a pure
function with tests. The run report contains fixed codes, sizes and hashes only.

### 6.3 Until the Developer ID exists

The internal flavour signs with "Clave Agent Dev" when `--sign` names it, for the owner's own
machine, so the whole pipeline except notarisation is exercised now; `--notarize` refuses without a
Developer ID. The release flavour refuses a non-Developer-ID identity outright.

## 7. First run, and what packaging changes about it

- **Quarantine and translocation.** A downloaded app carries the quarantine attribute; if the user
  opens it from where it was unzipped (Downloads) without a Finder move, macOS runs it from a random
  read-only path under `/private/var/folders/…/AppTranslocation/`. `chooseHelperPath` follows
  `process.execPath`, so the helper is still found; but the phase-0 lesson is that an app in an
  unregistered location gets a grant nobody can see or revoke, and whether a translocated app's grant
  survives the move is **unmeasured**. So: at start, before onboarding asks for the grant, main
  checks whether its own path is a translocation path; if it is, the window shows one screen: "Move
  Clave Agent to the Applications folder, then open it again", with a button that reveals the app in
  Finder, and does not ask for Screen Recording. The DMG's Applications link makes this the rare
  case. The check is a pure function over the path, tested.
- **Location.** The measured, supported location is `/Applications` (or `~/Applications`). The
  onboarding copy names the .app file; nothing else changes.
- **Model download.** Unchanged in substance: 2.74 GB from the pinned URL into
  `~/Library/Application Support/<name>/models/`, resumable, SHA-256 verified, with the existing
  free-space check (`DOWNLOAD_NO_SPACE`). What packaging changes: `CLAVE_MODEL_URL` is inert, so the
  URL is fixed; the download page must warn about the size before the install, and the internal and
  release flavours use different data folders and therefore download the model twice on the owner's
  machine (accepted; the alternative, sharing a folder between flavours, mixes data folders).
- **The self-signed dev bundle** keeps working beside both flavours (different ids, names, data
  folders). Two flavours running at once would mean two readers; the single-instance lock is per
  name, so it does not prevent that. The internal build's footer says so.

## 8. The Screen Recording measurements under the real identity

Repeated with the owner present, on an installed **internal** build under the Developer ID, one action
at a time, and recorded in a measurements file next to this spec's reviews:

| # | Question | Pass looks like |
|---|---|---|
| P1 | does the grant given to the notarised bundle reach the helper? | the helper's own `permission` answers granted and a staged read succeeds, in the log codes only |
| P2 | does `requestPermission()` raise the dialog from the installed build, and does a running helper pick up a fresh grant through the client's denied-refresh (with "Later")? Does macOS's "Quit & Reopen" bring the app back? | dialog seen (owner's screenshot, wording recorded), onboarding advances without a helper restart being forced by the owner, the app relaunches into the same mode |
| P6 | revocation while running | `PERMISSION_LOST` and `CAPTURE_OFF` within seconds, no `READER_PROBLEM`, reading resumes by itself on re-grant |
| **P7 (new)** | (a) does moving from the self-signed identity to the Developer ID reset the grant? (expected: yes, and it is a different bundle id anyway, so the answer is uninteresting; recorded for completeness) (b) does a **new version under the same identity and id**, installed over the old one while the app is quit, keep the grant? (expected: yes, because a Developer ID designated requirement is stable across versions) (c) the same, replaced while the app is running (expected: the `PERMISSION_LOST` seen on 2026-09-19, which is why the installer story is "quit first") | (b) is the one that matters: if it fails, every update costs the user a new grant and the app must say so at first start after an update |

What the app must tell the user if P7(b) fails is decided after the measurement, not before.

## 9. Changes needed in code that other sessions own (to coordinate, not to edit here)

- `app/src/shell/app.ts` (D's session): `production = app.isPackaged && FLAVOUR === "release"`;
  the flavour constant read from an esbuild `define`; do not read the `01-work-english.json` fixture
  when the real reader is on (so no fake screen text ships); the translocation check before
  onboarding; an `openLicences` IPC beside `openWhatLeaves`. The rest of the guard is untouched.
- `app/src/shell/lifecycle.ts` (D's session): one new start-failure code for a translocated app if
  the check is done as a start refusal rather than a screen (the screen is recommended).
- `app/src/renderer/copy.ts` and the About screen (nobody's session): `appName` per flavour from
  the same `define`, so the file name, the Settings entry, the onboarding copy and the self-exclusion
  agree; a "Licences" line in About; the internal footer line. The known gap in `copy.ts` about a
  "Dev" build's name being one word short goes away for the flavours (the dev bundle keeps it).
- `app/scripts/build.mjs` (packaging's): the `define` for the flavour and app name; nothing else.
- `docs/WHAT-LEAVES.md`: no new row. The internal flavour sends strictly less than the table says;
  the release flavour's table is D's to update.

## 10. Licences and About

`THIRD-PARTY-LICENSES.txt` is generated at package time from the shipped closure (each package's
name, version, licence field and the text of its LICENSE file), plus Electron's `LICENSE` and
`LICENSES.chromium.html` (copied into `Resources`), plus the helper's crates from `cargo metadata
--offline` (name, version, licence), plus a fixed paragraph for llama.cpp/ggml (MIT) and for the model
(the owner confirms the licence stated on the model card of `unsloth/Qwen3.5-4B-GGUF`; the app
downloads it and must name it and its licence). The generator fails the build if any package's
licence is missing or is not in an allow-list of permissive licences (MIT, ISC, BSD-2/3, Apache-2.0,
BlueOak-1.0.0, 0BSD, CC0, Unlicense), so a copyleft dependency cannot slip in silently.

About shows: version and build number, model name and hash (already), "What leaves this machine"
(already), "Third-party licences" (opens the text file), the flavour line for internal builds, and
the legal entity from `NSHumanReadableCopyright`.

## 11. Updates

Recommendation: **no update mechanism in v1**, not even a version check. About shows the version and
a "Get the latest version" line that opens the download page in the browser **only when clicked**;
nothing contacts any server on its own, so `WHAT-LEAVES.md`'s table stays exactly true. The only
alternative worth offering: a once-a-day GET of a small version file, which adds a row to that table
and a server that can see how many installs exist; an auto-updater that downloads and replaces the
app is out, because it changes the threat model (a server can then replace the code that reads
screens). The owner decides between "nothing" and "a daily version check".

## 12. Testing and review

- Every decision is a pure function with a test: the what-ships/what-must-not-ship lists over a
  file list; the Mac closure prune; the plist edit set; the entitlement sets per file; the fuse
  table; argument parsing and every refusal (bad `--out`, running app, missing identity or profile,
  release flavour without D, download needed); the translocation path check; the licence allow-list.
- A test over the **built bundle** (skipped when no bundle exists): no forbidden file, no symlink,
  no `.map`, the helper at `Contents/MacOS/clave-reader`, plist keys present and absent as specified,
  fuse state as specified (read back with `@electron/fuses`), the asar's unpack list, entitlements
  read back with `codesign -d --entitlements`, and for a signed bundle `codesign --verify --deep
  --strict` exit 0.
- Each new test is proved by reverting its fix once.
- After each task, an independent review by a fresh subagent on a private copy, with reproducing
  probes, asked to loosen each condition and list the mutations that survive.
- The real-model gate and the manual checklist run on the packaged internal build (the scripted
  model cannot be packaged, by design).

## 13. Open decisions for the owner, in order

1. ~~Approve the two-flavour scheme of section 2, including the coordination it needs in D's session.~~ **APPROVED 2026-09-22 ("yes, approved").**
2. ~~Approve the install of `@electron/packager` 20.3.0 and `@electron/fuses` 2.1.3 (or say
   electron-builder).~~ **APPROVED and done 2026-09-22 ("yes, run the install").**
3. ~~Confirm the bundle id family `dev.clave.agent` (from the dev bundle's `dev.clave.agent.dev`;
   it implies the owner controls `clave.dev`) or name another domain.~~ **DECIDED 2026-09-22: `dev.clave.agent`.**
4. ~~Confirm the legal name for `NSHumanReadableCopyright` and the Developer ID (TeamEx, as stated).~~ **DECIDED 2026-09-22: the copyright line says "Clave"; the Developer ID enrolment stays under TeamEx.**
5. Updates: nothing (recommended) or a daily version check.
6. An app icon: supply one, or ship Electron's for the internal flavour and decide before release.
7. Confirm the model's licence from its model card, for the licence file.

## 14. Notes added while building (2026-09-22, additions only)

- `@electron/osx-sign` 2.7.0's DEFAULT Developer ID entitlements grant camera, audio input, Bluetooth,
  USB, print, location and photos library to every file it signs; section 5.2's sets are therefore
  passed explicitly per file (`optionsForFile`), never the defaults. It signs 25 Mach-O files and 229
  other files (as extended-attribute signatures) with a timestamp each: about 2.5 minutes per pass.
- `@electron/fuses` 2.1.3 knows a ninth fuse, `WasmTrapHandlers`; it is kept at Electron's default
  (enabled) and named, since the flip uses `strictlyRequireAllFuses`.
- `@electron/packager` 20.3.0 embeds the asar integrity digest into the framework binary itself
  (`asarIntegrityDigest`) and ad-hoc re-signs the framework before signing; `extendInfo` merges but
  cannot delete a plist key, so the five untrue usage strings are removed in the `afterExtract` hook.
- The packages esbuild inlines into the bundles (react, react-dom, scheduler, zod) are recorded by the
  build from esbuild's metafiles into `dist/bundled-packages.json`, which the staging step consumes and
  never ships; without it the licence file could not name them (Task 3 review, C1).
- Section 5.3's "the app FILE name": the window title follows the flavour too (index.html's title was
  overriding the BrowserWindow title; Task 1 review I3).
- Section 6.2 step 5 as built: the helper is signed by osx-sign's own walk in the right order (it
  ranks `Contents/MacOS/clave-reader` as a bundle main executable), not by a separate first step.
- The self-exclusion of section 2's table follows the flavour through `PipelineConfig.selfApp`
  (edited in `core/exclusions` with the owner's permission, 2026-09-22).
- The release gate (section 2, "cannot be built") is `BUILD_FAILED STANDINS_IN_RELEASE` in
  `scripts/build.mjs`, over esbuild's metafile, and fires today.
- 2026-09-22, measured on the packaged internal build (self-signed, fused, hardened, in /Applications):
  P1 the grant reaches the helper (onboarding advanced by itself; two minutes of reading, kept 110,
  failed 0); P2 the dialog is raised from the installed build and names "Clave Agent Internal.app", and
  the running helper picked the grant up before the owner answered "Later"; P6 revocation noticed in
  3-5 s with PERMISSION_LOST and a clean CAPTURE_OFF, no READER_PROBLEM. Section 8's table stands; the
  same three plus P7 remain to be repeated under the Developer ID. Two facts section 5 did not know:
  a self-signed identity has no Team ID, so under the hardened runtime every executable that loads the
  Electron Framework needs `disable-library-validation` (the helper apps crashed at launch without it),
  and the ladder of 5.2 is measurable under a Team ID only; and a `file://` renderer needs the
  `GrantFileProtocolExtraPrivileges` fuse at its default (the window stayed white with it off), so 5.1's
  row for that fuse is now "on, until the renderer is served from a custom protocol".
