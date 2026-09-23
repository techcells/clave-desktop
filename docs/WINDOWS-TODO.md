# Windows version: what is left

State as of 2026-09-23, branch `windows-support`. Tick items off here as they land, and add new ones
with the same three parts: why, where, done when.

**Works today:**
- The app runs on Windows 11 from a checkout (`pnpm --dir app smoke` prints `SMOKE OK`).
- The native reader is built on Windows.Graphics.Capture and Windows.Media.Ocr.
- Edge and English-language Chrome are read, with private windows refused.
- The Windows wording and the Windows exclusions are in.
- The full test suite is green on Windows: 3,234 passed, 0 failed.
- `stage → bundle → sign (fuses only) → artefacts` makes an unsigned, per-user Inno Setup installer and a ZIP. The internal build has been installed and launched on the dev laptop.

Each item says why it matters, where to look, and when it counts as done.

---

## 1. Decisions (owner)

- [ ] **What to do about the model on slow hardware.**
  - Why: on the dev laptop (i5-10210U, Intel UHD, Vulkan), Qwen3.5-4B generates about 2 tokens/s. The core allows 700 tokens in 60 s per statement request (about 12 tokens/s needed) and 120 s for the self-test, so the self-test fails and reading stays blocked (fail-closed, correct).
  - Options: a stated minimum spec with a clear in-app message; longer time limits on slow machines; a smaller model (1–2B) for weak hardware, which needs its own release-gate run.
  - Where: `app/src/core/constants.ts` (`STATEMENT_LIMITS`), `app/src/main/constants.ts` (`MODEL_REQUEST_TIMEOUT_MS`, `SELF_TEST_TIMEOUT_MS`), `app/src/main/model/llamaBinding.ts`.
  - Done when: a decision is written down, and the app either works or says why it cannot on a machine below the bar.

- [ ] **Code signing for Windows release builds.**
  - Why: unsigned installers get a SmartScreen warning, and the pipeline refuses to make release-flavour Windows artefacts until they can be signed.
  - Options: Azure Trusted Signing, or an OV/EV certificate on a token or cloud HSM.
  - Where: `app/scripts/package/sign.mjs` (currently `WINDOWS_SIGNING_NOT_SET_UP` when `--sign` is given), `@electron/windows-sign` (already in the lockfile via packager). Sign the exe, `clave-reader.exe`, the native DLLs and `.node` files, and the installer, all with timestamps.
  - Also: `artefacts.mjs` `windowsArtefactDecision` (release requires `signed`), and the `windows-x64` job's `if:` in `.github/workflows/release.yml`.
  - Done when: a release-flavour Windows installer is signed, verifies with `signtool verify /pa`, and installs without a SmartScreen warning.

## 2. Verify what is built (no new code expected)

- [ ] **Notifications appear.** Two test toasts were sent (dev id, then the installed internal build's `dev.clave.agent.internal`); Electron reported `show` both times, but nobody has confirmed seeing one. The installed Start-menu shortcut carries the right AppUserModelID. Done when a toast is seen from the installed app, with its name and icon.
- [ ] **The CI job's first run.** Actions → Release → Run workflow (internal).
  - Watch for: the `windows-x64` job waits for `macos-arm64`, which needs the macOS signing secrets, so a Mac failure skips Windows.
  - Also watch: `choco install innosetup`; that the VC++ redistributable is found on the runner's Visual Studio; the pnpm metadata warm-up; and `CLAVE_PNPM` pointing at a `.cmd` shim that `pnpmInvocation` can resolve.
  - Done when the run attaches the installer, ZIP and SHA256SUMS.
  - Consider dropping `needs: macos-arm64` in favour of a separate publish job, so Windows can build even when the Mac job cannot.
- [ ] **The release gate on capable hardware.** `node app/dist/eval-gate.mjs <model.gguf> eval/fixtures` has never passed on Windows; every run here timed out. Run it on a Windows PC with a discrete GPU. Done when it prints `GATE PASSED`.
- [ ] **An hour of real use.** The installed app, with the real reader and real model, used for normal work. Check:
  - focus events;
  - lock and unlock (`WTSSessionInfoEx`);
  - that the app never reads its own window;
  - that the review digest arrives.
- [ ] **Real sign-in and storage.** The Google sign-in through the browser plus the loopback callback, and the session saved with Electron `safeStorage` (DPAPI on Windows). Every run so far used the stand-in backend (`start:api` exists for a real-API dev run).
- [ ] **Upgrade and uninstall.**
  - Upgrade: install version N, then N+1 over it while the app is running. `CloseApplications=yes` should close it, and the `[InstallDelete]` of `resources`/`locales` should leave no stale files.
  - Uninstall: run the uninstaller from Apps & features; the app goes, and `%APPDATA%\Clave Agent Internal` stays.
- [ ] **Other Windows setups:**
  - Windows 10 (1903+): the capture border cannot be hidden there, and `SetIsBorderRequired` fails harmlessly.
  - Two monitors at different scales: the toolbar band is in points times the window's own DPI.
  - A window of an app running as administrator.
  - A UWP app: the name should come through `ApplicationFrameHost.exe` to the real app.

## 3. Reading gaps

- [ ] **Brave on Windows.** Your everyday browser; today it is refused before capture as an unmeasured browser.
  - Measure its toolbar band. Use the opt-in test `a_browser_band_is_measured` in `app/native/reader/src/win/mod.rs`, with a throwaway `--user-data-dir` profile and a local page (see how Edge and Chrome were measured, in the comment on `BANDS` in `app/native/reader/src/toolbar.rs`).
  - Its private-window badge is the bare word "Private", which `hasPrivateToolbarMarker` (`app/src/core/exclusions/privateWindows.ts`) accepts for Safari only. Brave needs the same kind of scoped exception, checked against how Brave's address field shows URLs.
  - Add `"brave browser": ["brave.exe"]` to `MEASURED_BROWSERS` (`app/src/core/exclusions/defaults.ts`) only together with the band.
  - Check the interface-language question the other session hit with Chrome: is Brave's badge translated?
- [ ] **Firefox and others.** Same process as Brave. Firefox's private indicator is an icon, not a word, and may need a different approach.
- [ ] **Chrome in other languages.** Refused today (`band_withheld`, `app/native/reader/src/win/chrome.rs`), because the Russian Incognito badge was not recognised. Either add the translated badge words per language, or find a language-independent signal.
- [ ] **Portuguese OCR.** Windows OCR reads only installed language packs; pt-BR users need the "Portuguese (Brazil)" pack with its OCR component. The app neither detects nor mentions this.
  - Where: `app/native/reader/src/win/recognise.rs` (`OcrEngine::AvailableRecognizerLanguages`).
  - Done when a missing pack is reported to the app and explained in the UI. Also measure how the English engine does on accented text.
- [ ] **Screen savers.** Not excluded by name; their descriptions vary. Lock detection covers the password-protected case. Consider refusing any front window whose exe ends in `.scr` (the reader knows the exe name as `bundle_id`).

## 4. Packaging loose ends

- [ ] **Long Windows user names.** The deepest file in the app folder is 173 characters below it (inside node-llama-cpp's `dist/`), and the internal install root is `%LOCALAPPDATA%\Programs\Clave Agent Internal\`. A Windows user name longer than about 33 characters (42 for the release app's shorter name) passes the 260-character limit at install time. Options: a shorter install folder, dropping node-llama-cpp's `llama/` sources (below), or checking long-path behaviour on a real long-name account.
- [ ] **node-llama-cpp's `llama/` source tree is shipped** (34 MB; both platforms). `pruneDecision` already has `dropLlamaSource`, pending a check that the app runs without it. It would shrink the installer and shorten no path (the deepest ones are in `dist/`).
- [ ] **`artefacts/` keeps the generated `.iss`,** which contains local paths. It is not uploaded by CI (the upload globs name `*.exe`, `*.zip`, `SHA256SUMS` and the report), but it could be moved out of the artefacts folder or deleted after compiling.
- [ ] **Windows ARM64.** Not built. `@node-llama-cpp/win-arm64` exists; the helper would need the `aarch64-pc-windows-msvc` target (its CRT flag is already in `.cargo/config.toml`), an arm64 Electron zip and a second installer.

## 5. Docs and the PR

- [ ] **Update the PR description.** It still lists packaging, CI and the Windows wording under "Not in this PR"; all three are now on the branch.
- [ ] **README.** It says Windows "runs from a checkout for now; there is no Windows installer yet", which is no longer true. Describe the installer, where it installs, that it is unsigned for now, and the Windows build requirements: VS Build Tools with C++ and the Windows SDK (which also provides the VC++ redistributable staging copies) and Inno Setup 6.

## 6. Shared with macOS (not Windows gaps)

- Start at login, and auto-update: neither exists on either platform.

---

Useful commands (repo root, Windows):

```bash
pnpm --dir app build -- --flavour internal
```

```bash
pnpm --dir app package:stage -- --flavour internal
```

```bash
pnpm --dir app package:bundle -- --flavour internal
```

```bash
pnpm --dir app package:sign -- --flavour internal
```

```bash
pnpm --dir app package:artefacts -- --flavour internal
```

```bash
powershell -NoProfile -File app/scripts/package/make-icon.ps1
```
