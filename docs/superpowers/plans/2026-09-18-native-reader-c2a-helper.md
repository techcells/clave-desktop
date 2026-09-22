# Native Reader C-2a (Rust Helper, Core Rules, Wiring, Dev Bundle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the real native reader behind the `ReaderClient` of plan C-1: the Rust helper `clave-reader`, the two core rules the phase-0 findings require, log codes for the supervisor, the wiring in the shell, and a signed development bundle in which the owner sees the app read a real screen for the first time.

**Architecture:** `app/native/reader/` is a standalone Rust program speaking protocol 1 over stdin/stdout. Its platform-neutral half (protocol, scheduler, worker, text assembly with homoglyph repair, toolbar band, frame checks, same-pixels cache) is unit-tested with a fake platform; its macOS half (window server, ScreenCaptureKit by window id, greyscale + Vision, permission, focus on the main run loop) implements one `Platform` trait. The shell builds the real reader through a small testable factory (`shell/realReader.ts`) when the development switch `CLAVE_REAL_READER=1` is set, beside the stand-in backend. A thin signed launcher bundle in `~/Applications` gives macOS an app it can list, prompt for and revoke.

**Tech Stack:** Rust 1.98.1 (edition 2024) with objc2 0.6.4, block2 0.6.2, objc2-foundation / -core-foundation / -core-graphics / -screen-capture-kit / -vision 0.3.2, serde_json 1.0.151 — ALL already cached in `~/.cargo` from phase 0, built `--offline --locked`; TypeScript 7.0.2, vitest 5.0.1, Electron 44.4.1; macOS `codesign`, `plutil`, `patch`, `shasum`.

**Spec:** `docs/superpowers/specs/2026-09-18-native-reader-design.md` (sections 2, 3, 5, 8, 10.1). Findings: `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`. C-1: `docs/superpowers/plans/2026-09-18-native-reader-c1-client.md`.

**Payload:** `docs/superpowers/plans/2026-09-18-native-reader-c2a-files/` — the verified files this plan installs: `new/app/**` (30 files; `MANIFEST.sha256` lists all 36 payload files, the 30 new files and the six patches; copied as they are) and `patches/*.diff` (unified diffs against files that already exist; applied with `patch`). The crate is about 3,900 lines, so it travels as files, not as fenced blocks: byte-exact, checksummed, and nothing to retype. After execution the payload duplicates what is in `app/`; keep it, it is the record of what was verified.

## Global Constraints

- NO git at all. Tasks end with a "Checkpoint" step.
- Never `cd`. Absolute paths; project scripts as `pnpm --dir app <script>` from the repo root; `patch -d <repo root> -p0 < <diff>`; `cp -R`.
- No downloads, no installs. cargo runs ONLY through `pnpm --dir app build:native` / `test:native`, which pass `--offline --locked`. If cargo reports a missing crate, STOP and report; do not remove the flags.
- Install files ONLY from the payload, by `cp` and `patch`. Never retype, never "improve" a payload file while installing it. After every task: `shasum -a 256` of each installed NEW file must equal its line in `MANIFEST.sha256`. If `patch` reports a rejected hunk or fuzz, STOP and report — the target file is not what this plan was verified against. (Never re-extract an older plan's code over the code.)
- PRIVACY while executing: implementers and reviewers must NOT make the helper capture or recognise any window, and must not print window titles. Allowed without the owner: unit tests, the handshake (synthetic warm-up image, `permission`, `shutdown`, stdin EOF). Anything that reads a real screen happens only in Task 6, with the owner present, inside the app, and the text stays in the app.
- The helper writes nothing to stderr except the fixed codes `E_PANIC` (exit 70) and `E_STDIN` (exit 71). The client logs only the six `READER_*` codes. No text, title or path in any log.
- OWNER steps (marked **OWNER**) are never done by an agent: running `dev:bundle` for `~/Applications` the first time (writes about 600 MB outside the repo; approved in chat 2026-09-18, confirm again at execution), granting Screen Recording, switching capture on, looking at the screen.
- Launch the dev bundle only through `pnpm --dir app start:reader[:scripted]` (LaunchServices). Never run its executable from a terminal: macOS would attribute screen access to the terminal.
- Each task is reviewed independently with reproducing probes before the next begins. A new or changed test must be proven by reverting its fix on a backup copy and watching it fail (lesson of C-1).
- At the end: `pnpm --dir app test` → 914 passed in 65 files (835 before this plan; 913 and one skipped where the helper is not built), `pnpm --dir app typecheck` clean, `pnpm --dir app test:native` → 166 passed, `pnpm --dir app smoke` → `SMOKE OK`.

## Decisions

Owner's decisions (chat, 2026-09-18): **O1** Safari's private badge, the bare word "Private", counts as a marker for toolbar text only. **O2** Browsers without a measured toolbar band are not read until measured. **O3** Development runs from a signed bundle in `~/Applications`. **O4** (taken during Task 6, after the first real read) `windowGone` is added to the Reader port's `ReadFailure`: the helper answers it when there is no front window at read time or the window vanished between steps, and the capture loop records it as its own outcome and does **not** count it as a fault of the reader.

Decisions this plan makes (flag any before execution):

| # | Decision | Why |
|---|---|---|
| D1 | The bare word counts for **Safari only** (`hasPrivateToolbarMarker(toolbarText, app)`), not for every browser. | Chrome shows the whole address in its strip, where "private" is an everyday path segment (`github.com/acme/private-api`); accepting it there would skip ordinary work all day. Safari's field shows the host only. Known, accepted cost (O1): a Safari tab whose title contains the word, shown in the compact tab bar, skips that read. Other languages' badges are not measured and not guessed. |
| D2 | O2 is enforced twice in the core: `before()` refuses a listed browser that is not in `MEASURED_BROWSERS` (nothing is captured), and `after()` never keeps a browser read that arrives without `toolbarText`. Reason reported: the existing `excludedApp` / `unknownWindow`; no new `SkipReason`. | Before-capture is the privacy rule; after is the safety net if names and bundle ids ever disagree. No IPC or UI type changes. |
| D3 | The onboarding sentence "Private browser windows are always skipped." becomes "Chrome and Safari are read, except their private windows. Other browsers are not read yet." and is also shown under Settings → Excluded apps. | The old sentence overclaims. The five pitch claims and `WHAT-LEAVES.md` are untouched ("private browser windows it can recognise" stays true). |
| D4 | Homoglyph repair runs on every recognised line BEFORE the toolbar strip is cut, so `toolbarText` is repaired too. | The private-window and host checks match inside `toolbarText`; a Cyrillic "А" there would silently defeat them (phase 0: 5 of 50 strips). |
| D5 | The black check samples at most three channels (never alpha). | BGRA alpha is 255 in every pixel; with it `black` would be unreachable. |
| D6 | `budgetMs` 0 means "no deadline of the helper's own"; the budget clock starts when the worker takes the job. | The client sends 0 for an unusable budget and keeps its own timer; queue time is time the app caused. |
| D7 | Background threads never call `NSWorkspace`. The main thread keeps the frontmost pid in an atomic (seeded before the run loop, updated by the activation observer and the 1 s poll); other threads read the pid, find the window in the window-server list and take the bundle id from `NSRunningApplication` (documented thread-safe). `window.app` is `kCGWindowOwnerName`. | AppKit is not thread-safe in general. The owner name is what phase 0 matched on and what the core's browser list expects. |
| D8 | The helper silences Rust's default panic hook and wraps every thread so a panic is exit 70 with `E_PANIC`. | The default hook prints a source path and an arbitrary message to stderr. |
| D9 | The helper is looked for next to the app's executable first (`Contents/MacOS/clave-reader`), then in `dist/native/`. | Next to the executable is the measured layout and where a packaged build will put it. |
| D10 | The dev bundle is a thin launcher that `require`s this checkout's `app/dist/main.cjs`; only the helper is copied into it. Its executable keeps the name `Electron`. | Rebuilding the app never needs a new bundle; `node-llama-cpp` resolves as usual; an executable named `Electron` keeps `app.isPackaged` false, which is what lets the development switches work. |
| D11 | The real reader runs only with `CLAVE_STANDINS=1` AND `CLAVE_REAL_READER=1`, never in the smoke run; a packaged build still refuses to start (the backend is a stand-in until sub-project D). | Spec section 8: the clave-back half of the start guard is untouched. |
| D12 | The cold recognition cost (43.3 s measured while planning) belongs to the MACHINE, not to the binary: freshly rebuilt, byte-different binaries were ready in 0.1–0.6 s afterwards. The warm-up before `ready` stays. | New evidence; corrects the open question in the findings. A reboot and a long idle remain untested (C-2b). |
| D13 (taken during Task 6, fix rounds 2 and 3) | While `permission()` answers `denied` and the current helper is older than the refresh interval, the client retires that helper (not a crash, no capture attempt) and starts a fresh one, still answering `denied` for that call. The interval starts at 5 s and doubles to at most 60 s while the answer stays `denied`; it resets on any non-`denied` answer, on `requestPermission()` and on a new focus subscription, and no refresh happens after the supervisor has given up. | Measured defect D-A: `CGPreflightScreenCaptureAccess` is cached per process and this helper never attempts a capture while denied, so the helper that was running when the grant arrived answered `denied` for ever. A capture attempt would refresh the cache but can raise a macOS prompt, which is not ours to raise. The backoff is the round-2 review's Important 1: at a flat 5 s the engine's 10 s tick means a process spawn plus a Vision warm-up every 10 s for ever on the machine of somebody who has simply declined. Accepted cost: granting after a long denied stretch can be noticed up to ~60 s plus the asker's own poll late, unless the user pressed the permission button first. |
| D14 (taken during Task 6, fix round 3) | `dispose()` owns the helpers that are on their way out: it awaits, and if necessary kills, every retired-but-not-gone helper as well as `current` and `replacement`, and `retire()` clears an existing kill timer before arming a new one. | Without it a helper retired by a promotion or by D13 was held by nothing but its own kill timer, which outlived the client; and retiring the same helper twice orphaned the first timer. One helper, one kill timer, always the latest. |

Deferred to plan C-2b (needs the real helper running in the bundle first): `reader:eval` with fixed window sizes and repeated reads, the accuracy and band acceptance numbers in Rust-greyscale, the manual checklist, cold cost after reboot, `requestPermission()` observed from the installed bundle, onboarding copy for the macOS 27 dialog and for "no restart needed", the four design inputs from C-1's review, measuring further browsers. (Updated 2026-09-19: `requestPermission()` **was** observed from the installed bundle in Task 6 and is no longer deferred — see the execution record. The complete, de-duplicated list carried to C-2b now lives in `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`, "Carried to plan C-2b".)

## File Structure

| Path | Responsibility | How |
|---|---|---|
| `app/src/core/exclusions/privateWindows.ts` (+ test) | Safari-only bare-word badge | patch `task1` |
| `app/src/core/exclusions/defaults.ts`, `index.ts` (+ test) | `MEASURED_BROWSERS`; refuse before, never keep after; pass the app to the marker check | patch `task2` |
| `app/src/renderer/copy.ts`, `screens/Settings.tsx` | The corrected sentence, shown twice | patch `task2` |
| `app/src/main/log.ts`, `engine.ts` | Six `READER_*` codes; `engine.noteReaderEvent` | patch `task3` |
| `app/src/main/engine.readerEvents.test.ts` | Closed mapping, nothing after quit | new |
| `app/native/reader/**` | The helper crate (see its module table in Task 4) | new |
| `app/scripts/build-native.mjs` | cargo, offline and locked; copies the helper into an existing `dist/` | new |
| `app/package.json` | `build:native`, `test:native`, `dev:bundle`, `start:reader`, `start:reader:scripted` | patch `task7` |
| `app/src/shell/realReader.ts` (+ 2 tests) | `chooseHelperPath`, `createRealReader` (missing helper = start failure; early events buffered) | new |
| `app/src/shell/lifecycle.ts`, `devEnv.ts`, `app.ts`, `app/scripts/build.mjs` | `READER_HELPER_MISSING`; `CLAVE_REAL_READER`; the wiring; helper copied on every build | patch `task6` |
| `app/scripts/dev-bundle.mjs`, `start-reader.mjs` | The signed launcher bundle; launching it with the switches | new |
| `app/src/main/ports/reader.ts`, `app/src/main/capture/loop.ts` (+ both tests) | `windowGone` as a fifth read failure reason and as the loop's own outcome, never a fault (O4) | patch `task6b-window-gone.diff`, applied **after** Task 5 — the record of fix round 2, not part of the original task list. Its Rust half (`protocol.rs`, `scheduler.rs`) is in the payload's crate files; its client half (D13, D14, in `app/src/main/reader/`) belongs to plan C-1 and was re-synced there |

In every command below: `REPO=/Users/sardorastanov/techcells/asset-to-evidence`, `PAY=$REPO/docs/superpowers/plans/2026-09-18-native-reader-c2a-files`. Shell state does not persist between commands; start each with those two assignments.

---

### Task 1: Safari's private badge (core)

**Files:**
- Modify: `app/src/core/exclusions/privateWindows.ts`, `app/src/core/exclusions/privateWindows.test.ts` (patch `task1-safari-badge.diff`)

**Interfaces:**
- Produces: `hasPrivateToolbarMarker(toolbarText: string, app?: string): boolean` — the second parameter is optional, so the existing caller keeps compiling until Task 2 passes the app.

- [ ] **Step 1: Apply the patch, then prove the new tests bite.** `patch -d "$REPO" -p0 --dry-run < "$PAY/patches/task1-safari-badge.diff"` must report two files and no rejects; then the same command without `--dry-run` and with `--no-backup-if-mismatch`. The patch carries tests and code together, so "red first" is shown the other way round: copy the patched `privateWindows.ts` aside, make `hasPrivateToolbarMarker` return only `TOOLBAR_MARKERS.test(toolbarText)` again, run the test file and record that the five "flags Safari's badge as recognised" cases fail, then put the patched file back.
- [ ] **Step 2: Run** `pnpm --dir app test src/core/exclusions/privateWindows.test.ts` → PASS, 28 tests.
- [ ] **Step 3: Reviewer's probes** (backup, mutate, run, restore): (a) delete `isSafari(app) &&` → "accepts the bare word for Safari only" fails; (b) change `SAFARI_BADGE` to `/private/i` → "does not flag Safari's strip @ privately.example.com" fails; (c) confirm the must-not-match title list of `isPrivateTitle` is untouched by the patch.
- [ ] **Step 4: Checkpoint.** `pnpm --dir app typecheck` clean.

### Task 2: Browsers without a measured strip are not read (core + copy)

**Files:**
- Modify: `app/src/core/exclusions/defaults.ts`, `index.ts`, `index.test.ts`, `app/src/renderer/copy.ts`, `app/src/renderer/screens/Settings.tsx` (patch `task2-unmeasured-browsers.diff`)

**Interfaces:**
- Consumes: `hasPrivateToolbarMarker(toolbarText, app)` (Task 1).
- Produces: `MEASURED_BROWSERS = ["google chrome", "safari"]`; `before()` answers `excludedApp` for a listed browser outside it; `after()` answers `unknownWindow` for a browser read without `toolbarText` (an empty string is a strip; `undefined` is not); `after()` passes `front.app` to the marker check, which is what makes Safari's badge effective end to end.

- [ ] **Step 1: Apply** `patch -d "$REPO" -p0 --no-backup-if-mismatch < "$PAY/patches/task2-unmeasured-browsers.diff"` (dry-run first; five files, no rejects). One EXISTING assertion changes on purpose: a Firefox private title used to report `privateWindow`; Firefox is now refused earlier as `excludedApp`, so that line now uses a Chrome incognito title.
- [ ] **Step 2: Run** `pnpm --dir app test src/core/exclusions` → 95 tests pass; `pnpm --dir app test src/renderer` → 112 pass; `pnpm --dir app typecheck` clean (both configs).
- [ ] **Step 3: Check the fixtures still mean what they meant:** `pnpm --dir app test src/eval` passes — every browser read in `eval/fixtures/` is Google Chrome with a `toolbarText`.
- [ ] **Step 4: Reviewer's probes:** (a) remove the `isBrowser(front.app) && !isMeasuredBrowser(front.app)` line → the "does not read …" cases fail (19 of them since the review's fix round); (b) remove `if (toolbarText === undefined) return "unknownWindow";` → "never keeps a browser read that arrives without its toolbar strip" fails; (c) revert `hasPrivateToolbarMarker(toolbarText, front.app)` to one argument → "recognises Safari's private badge…" fails; (d) read `copy.ts`: the five pitch claims are byte-identical to before (`pnpm --dir app test src/renderer/model/views.test.ts` passes).
- [ ] **Step 5: Checkpoint.**

### Task 3: Log codes for the reader's supervisor

**Files:**
- Modify: `app/src/main/log.ts`, `app/src/main/engine.ts` (patch `task3-reader-log-codes.diff`)
- Create: `app/src/main/engine.readerEvents.test.ts` (payload)

**Interfaces:**
- Consumes: `ReaderClientEvent` from `app/src/main/reader/readerClient.ts` (C-1).
- Produces: `Engine.noteReaderEvent(event: ReaderClientEvent): void`; log codes `READER_HELPER_EXIT`, `READER_HELPER_START_TIMEOUT`, `READER_HELPER_WEDGED`, `READER_PROTOCOL_MISMATCH`, `READER_HELPER_GAVE_UP`, `READER_HELPER_REPLACED`.

- [ ] **Step 1: Test first.** `cp "$PAY/new/app/src/main/engine.readerEvents.test.ts" "$REPO/app/src/main/"`, run `pnpm --dir app test src/main/engine.readerEvents.test.ts` → FAIL (`noteReaderEvent` is not a function).
- [ ] **Step 2: Apply** `patch -d "$REPO" -p0 --no-backup-if-mismatch < "$PAY/patches/task3-reader-log-codes.diff"`.
- [ ] **Step 3: Run** the same test → 3 pass; `pnpm --dir app test src/main` all pass; typecheck clean.
- [ ] **Step 4: Reviewer's probes:** (a) drop the `Object.hasOwn(READER_EVENT_CODES, event)` guard → "writes nothing for a value that is not one of the six" fails (`"toString"` reaches the prototype); (b) drop `stopped ||` → "logs nothing after quit" fails; (c) confirm any other object typed `Engine` in the repo still compiles (typecheck covers it).
- [ ] **Step 5: Checkpoint.**

### Task 4: The helper crate

**Files:**
- Create: `app/native/reader/**` (payload: `Cargo.toml`, `Cargo.lock`, `rustfmt.toml`, `src/*.rs`, `src/macos/*.rs`, `tools/handshake_check.py`), `app/scripts/build-native.mjs`
- Modify: `app/package.json` (patch `task7-package-scripts.diff`)

**Interfaces:**
- Produces: the executable `app/native/reader/target/release/clave-reader` speaking protocol 1 exactly as `app/src/main/reader/protocol.ts` expects (answers' keys come out alphabetically sorted; the client does not care); `pnpm --dir app build:native` and `test:native`.

| Module | Responsibility |
|---|---|
| `main.rs` | Start-up order: silent panic hook → window-server prologue (`CGPreflightScreenCaptureAccess` + `CGWindowListCopyWindowInfo`; without the latter the process ABORTS at the first `SCContentFilter`) → seed the frontmost pid → warm-up recognition of a synthetic 400×120 grey image → `ready` → input thread, worker thread, run loop |
| `runtime.rs` | One writer for stdout lines; fixed stderr codes; `guard` turning a panic into exit 70 |
| `protocol.rs` | `parse_request`, every answer builder (no serde derive) |
| `input.rs` | The input thread: `permission` (`denied` / `refused` / `granted`), `requestPermission`, `frontWindow` (null without the grant or when locked), `cancel`, `shutdown`, EOF → exit 0 |
| `worker.rs` | One read at a time; the latest `read` wins; a cancelled job answers nothing |
| `scheduler.rs` | `handle_read`: locked → front window → capture by window id → black → same pixels → greyscale + recognise → repair + assemble → toolbar strip → cache → answer; a cancellation/deadline check between every step |
| `text.rs` | Row ordering, homoglyph repair (rule and measured cases in the doc comment), editor-gutter stripping |
| `toolbar.rs` | The per-browser band in POINTS × display scale: `com.google.Chrome` 82.0, `com.apple.Safari` 41.0; `None` for any other bundle id |
| `frame.rs`, `cache.rs` | Black grid (never alpha), two independent 64-bit pixel hashes, the one-entry cache |
| `focus_gate.rs` | When a focus event is owed: a window-id or frontmost-pid change at once; a title-only change at most once per 5 s, held and never lost (added in the review's fix round) |
| `platform.rs`, `stub.rs` | The `Platform` trait; the non-macOS stub (no grant), so the crate builds and tests anywhere |
| `macos/*` | `windows` (front window by pid snapshot + window-server list; lock state), `capture` (by window id; −3801 → `Refused`; both completion waits time out after 3 s → `Other`), `recognise` (DeviceGray redraw + Vision accurate, correction off, en-US + pt-BR), `permission`, `focus` (activation observer + 1 s poll on the main run loop, both through one shared `FocusGate`) |

- [ ] **Step 1: Install.** `mkdir -p "$REPO/app/native"`, `cp -R "$PAY/new/app/native/reader" "$REPO/app/native/"`, `cp "$PAY/new/app/scripts/build-native.mjs" "$REPO/app/scripts/"`, then `patch -d "$REPO" -p0 --no-backup-if-mismatch < "$PAY/patches/task7-package-scripts.diff"`. Verify checksums: for every `new/app/native/…` and the script line in `$PAY/MANIFEST.sha256`, `shasum -a 256` of the installed file matches.
- [ ] **Step 2: Unit tests.** `pnpm --dir app test:native` → `test result: ok. 166 passed; 0 failed` (text 37, protocol 26, scheduler 32, input 14, frame 13, toolbar 11, worker 11, focus_gate 9, cache 8, macos::capture 5; the 27th scheduler test came with fix round 2 and the last ten with fix round 4, see Task 6).
- [ ] **Step 3: Build.** `pnpm --dir app build:native` → `BUILD_NATIVE_OK …/clave-reader` with ZERO compiler warnings (about 12 s from cached crates).
- [ ] **Step 4: Handshake.** `python3 "$REPO/app/native/reader/tools/handshake_check.py" "$REPO/app/native/reader/target/release/clave-reader"` → `ALL CHECKS PASSED` (`ready` first; a `permission` answer; exit 0 at stdin EOF; empty stderr; garbage and unknown ops ignored; `shutdown` → exit 0). Record the time to `ready` (expect under 1 s; about 45 s if this machine's recognition cache is cold).
- [ ] **Step 5: Reviewer's probes** (on backup copies of the `.rs` files; run `pnpm --dir app test:native` after each; restore; finish with the checksums of Step 1 matching again):

| Mutation | Must fail |
|---|---|
| `frame.rs`: sample all `bytes_per_pixel` channels instead of `min(bytes_per_pixel, 3)` | `opaque_alpha_over_black_colour_is_still_black` |
| `toolbar.rs`: make an unknown bundle id fall back to Chrome's band | `an_unknown_bundle_id_has_no_toolbar` |
| `toolbar.rs`: compute the band as a fraction of `image_height_px` | `the_band_does_not_depend_on_the_capture_height` |
| `text.rs`: remove the Cyrillic `А`→`A` pair | `a_latin_word_with_one_cyrillic_capital_is_repaired`, `a_latin_identifier_with_one_cyrillic_capital_is_repaired` |
| `text.rs`: repair words that are entirely Cyrillic | `real_cyrillic_text_is_left_alone` |
| `scheduler.rs`: do not set the refused flag on `CaptureError::Refused` | `a_refused_capture_sets_the_flag_and_fails` |
| `scheduler.rs`: skip the cancellation check between capture and recognition | `a_job_cancelled_during_the_capture_says_nothing_and_does_not_recognise` |
| `scheduler.rs`: cut the toolbar strip BEFORE the homoglyph repair | `homoglyphs_are_repaired_in_the_toolbar_strip_too` |
| `worker.rs`: a new `read` no longer cancels the running one | `a_new_read_cancels_the_running_one` |

- [ ] **Step 6: Reviewer reads the macOS layer.** `macos/*.rs` is COMPILE-VERIFIED ONLY — no window was captured while planning. Read it against `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md` (P3: the measured Rust calls; the prologue) and spec section 5: window chosen by id from the window-server list; capture by that id; greyscale before Vision; every `unsafe` has a SAFETY line; autorelease pools around Objective-C work on Rust threads; no `NSWorkspace` call off the main thread (D7); nothing but fixed codes reaches stderr. List concerns for Task 6, where this code first meets a real window.
- [ ] **Step 7: Checkpoint.** No file under `app/native/reader` differs from the payload except `target/`.

### Task 5: Wiring

**Files:**
- Create: `app/src/shell/realReader.ts`, `realReader.test.ts`, `realReader.binary.test.ts` (payload)
- Modify: `app/src/shell/lifecycle.ts`, `devEnv.ts`, `app.ts`, `app/scripts/build.mjs` (patch `task6-wiring.diff`)

**Interfaces:**
- Consumes: `createReaderClient`, `ReaderClientEvent` (C-1), `createChildHelperLink` (C-1), `Engine.noteReaderEvent` (Task 3), the built helper (Task 4).
- Produces: `chooseHelperPath(candidates: readonly [string, ...string[]], exists): string`; `createRealReader({helperPath, exists, spawnChild, now}): {reader: ReaderClient; attach(sink: {noteReaderEvent(e): void}): void}` — throws `Error("READER_HELPER_MISSING")` when the helper is absent; start failure `READER_HELPER_MISSING`; development switch `CLAVE_REAL_READER`.

- [ ] **Step 1: Tests first.** Copy the three payload files into `app/src/shell/`; run `pnpm --dir app test src/shell/realReader.test.ts` → FAIL (cannot resolve `./realReader`)… it resolves, because the implementation came with it: instead prove the tests bite in Step 4.
- [ ] **Step 2: Apply** `patch -d "$REPO" -p0 --no-backup-if-mismatch < "$PAY/patches/task6-wiring.diff"` (four files, no rejects).
- [ ] **Step 3: Run** `pnpm --dir app test src/shell` → 31 tests pass (30, plus the real-binary test now that Task 4 built the helper; it takes under 2 s warm); typecheck clean; `pnpm --dir app build` succeeds and `ls "$REPO/app/dist/native/clave-reader"` exists; `pnpm --dir app smoke` → `SMOKE OK` (the smoke run must still use the stand-in reader: `REAL_READER` is false whenever `CLAVE_SMOKE=1`).
- [ ] **Step 4: Reviewer's probes:** (a) in `realReader.ts` remove the `exists` check → "refuses to be built without the helper binary" fails; (b) drop the `early` buffer (call the sink only when attached) → "keeps the events that happen before the engine exists" fails; (c) in `chooseHelperPath` return the LAST candidate → two cases fail; (d) read the `app.ts` hunk: the real reader is built only when `STANDINS && !SMOKE && CLAVE_REAL_READER === "1"`; the unused stand-in reader is disposed; `real?.attach(current)` comes right after the engine exists; a packaged build still throws `NO_READER_YET`/refuses stand-ins exactly as before; (e) `pgrep -fl clave-reader` prints nothing after the test run.
- [ ] **Step 5: Checkpoint.**

### Task 6: The dev bundle and the first real read (with the owner)

**Files:**
- Create: `app/scripts/dev-bundle.mjs`, `app/scripts/start-reader.mjs` (payload)

**Interfaces:**
- Consumes: `build:native` output, `dist/main.cjs`, the certificate "Clave Agent Dev" in the owner's login keychain, the package scripts of Task 4.
- Produces: `~/Applications/Clave Agent Dev.app` (bundle id `dev.clave.agent.dev`); data folder `~/Library/Application Support/Clave Agent Dev/` with `app.log`.

- [ ] **Step 1: Install and dry-run.** Copy the two scripts into `app/scripts/`; checksums match. `pnpm --dir app exec node --check` on both. Bundle into a SCRATCH folder first: `pnpm --dir app dev:bundle -- --out <scratchpad>/bundle-test` → `DEV_BUNDLE_OK`; `codesign -dvv` shows `Identifier=dev.clave.agent.dev`, `Authority=Clave Agent Dev` for the bundle and `Identifier=clave-reader`, same authority, for `Contents/MacOS/clave-reader`; a second run replaces its own bundle; a folder of the same name that is NOT ours → `DEV_BUNDLE_FAILED REFUSING_TO_REPLACE`. Delete the scratch bundle.
- [ ] **Step 2: OWNER — make the real bundle.** Tell the owner: this writes about 600 MB to `~/Applications/Clave Agent Dev.app`; removable with `rm -rf` of that one path. On their yes: `pnpm --dir app dev:bundle`.
- [ ] **Step 3: OWNER — first launch, scripted model.** Tell the owner first, plainly: from the moment capture is switched on, the app reads the text of whatever window is in front — that is the product. It stays on this machine: the model is scripted, the backend is a local stand-in, and nothing is uploaded without approval in the review screen. Suggest they keep an editor or a terminal with ordinary work in front, and not a browser other than Chrome or Safari (those are not read). Then `pnpm --dir app start:reader:scripted`. The tray icon appears.
- [ ] **Step 4: OWNER — permission, observed.** In onboarding the owner presses the button that asks for Screen Recording. RECORD, in their words: did a macOS dialog appear, what did it say and name; is "Clave Agent Dev" in System Settings → Screen & System Audio Recording; after enabling it, did the app need a restart or did it carry on (phase 0 predicts: carries on; the helper picks the grant up). This is the retest of spec 10.1 item 3.
- [ ] **Step 5: Evidence that it reads, without ever printing what it read.** After the owner switches capture on and works for three minutes in a non-excluded app: `grep -o '"code":"[A-Z_]*"' "$HOME/Library/Application Support/Clave Agent Dev/app.log" | sort | uniq -c` shows `CAPTURE_ON` and NO `READER_PROBLEM`, `READER_HELPER_GAVE_UP`, `READER_HELPER_WEDGED`, `READER_HELPER_START_TIMEOUT`, `READER_PROTOCOL_MISMATCH`; `pgrep -fl clave-reader` shows ONE helper whose parent (`ps -o ppid= -p <pid>`) is the bundle's Electron process; `ps -o rss= -p <pid>` is recorded (expect roughly 60 MB; the scripted model produces statements from kept reads, so the owner sees pending statements appear in the review screen — that is the end-to-end proof). Do NOT open, print or copy any file of that data folder other than `app.log`.
- [ ] **Step 6: Negative checks with the owner:** a Safari private window in front for a minute, then a Firefox (or any unlisted browser) window if installed: no new statements come from them. Locking the screen for a minute and unlocking: reading resumes, and no `READER_*` problem code appears.
- [ ] **Step 7: If anything in Steps 4–6 fails:** do not patch around it. Record exactly what happened (codes, counts, the owner's observations — never screen text), stop the app, and report: the macOS layer is where this plan is least verified, and a failure here is a finding for a fix round with its own review.
- [ ] **Step 8: Checkpoint.** Record the observations in `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md` (codes, counts, timings, the owner's answers; no text, no titles).

**Fix round 2 (2026-09-18), between Step 5 and the second run — not part of the original task list.** The first real read found two defects, D-A and D-B (see the execution record). Their TypeScript half for the port and the capture loop is `patches/task6b-window-gone.diff` (`ports/reader.ts`, `ports.test.ts`, `capture/loop.ts`, `loop.test.ts`), applied on top of Task 5; their Rust half is in the payload's crate files (`protocol.rs`, `scheduler.rs`); the client half (D13, D14) is in `app/src/main/reader/`, which belongs to plan C-1. Fix round 3 followed from the round-2 review and is TypeScript-only.

### Task 7: Whole-suite check, documents

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-native-reader-design.md` (dated notes only), `docs/HANDOFF.md`

- [ ] **Step 1:** `pnpm --dir app test` → 914 passed, 65 files. `pnpm --dir app typecheck` clean. `pnpm --dir app test:native` → 166. `pnpm --dir app smoke` → `SMOKE OK`. Every `new/` file's checksum still matches `MANIFEST.sha256` unless a reviewed fix round changed it (then list which, and why).
- [ ] **Step 2: Spec notes** (appended at the END of the named sections, format `Note <date> (C-2a): …`, never altering approved sentences): 5.2 step 7 — the fixed browser list is Google Chrome and Safari, and the core does not read other browsers (O2, D2); 5.3 — what Task 6 Step 4 observed about `requestPermission()`; 10.2 — the cold recognition cost belongs to the machine, not the binary (D12), and whatever Task 6 verified or failed to verify of the macOS layer.
- [ ] **Step 3: HANDOFF** — status row for C and the single current "Next": plan C-2b (the deferred list above).
- [ ] **Step 4: Checkpoint.**

---

## Execution record (2026-09-18)

Tasks 1–5 were installed from the payload (every dry-run clean, checksums matched) and reviewed independently: 18 of 18 mutation probes bite; core rules, protocol agreement, scheduler, wiring and leak checks held; the macOS layer was reviewed by reading. The review found four Important defects, all fixed in one round by the crate's author, each proven by reverting its fix: (I-1) the homoglyph rule that rewrote genuine all-twin Cyrillic/Greek words beside Latin text ("МОСКВА today" → "MOCKBA today") was DROPPED — a word is repaired only if it contains a Latin letter itself; (I-2) the core's `isBrowser` is now a name-prefix match on a word boundary and knows twelve more browsers, so "Google Chrome Canary", "Safari Technology Preview", "Opera GX" are browsers without a measured strip and are not read, while `isMeasuredBrowser` stays exact (accepted cost: "Chrome Remote Desktop" and the video player "Helium" are not read either); (I-3) both capture completion waits time out after 3 s; (I-4) title-only focus changes are rate-limited to one per 5 s in the helper (`focus_gate.rs`) — worst case for a window whose title changes every second is now about two reads per 5 s, not one per second. Also fixed: gutter stripping only in runs of at least three lines stepping by exactly 1 ("404 Not Found" survives), no blanket `Send`, `guard` inside the capture blocks. The payload, `patches/task2-unmeasured-browsers.diff` and `MANIFEST.sha256` were regenerated so this plan still equals the code; totals after that round were 155 native and 894 TypeScript tests. The "Verification record" below describes the payload as first written (133 / 874). Known limits carried to C-2b: a numbered list at the left edge ("1 Install / 2 Configure / 3 Run") loses its numerals and `text.rs`'s comment wrongly says otherwise; two reads per 5 s against spec 5.4's one; ids are u64 in Rust and safe integers in JS; a timed-out recognition is not cached; the twelve new browser names were not checked against what macOS reports for those apps.

**Task 6 — the dev bundle and the first real read (2026-09-18/19).** The owner made the bundle (288 MB in `~/Applications`, bundle id `dev.clave.agent.dev`, self-signed, launched through LaunchServices with the development switches, scripted model, stand-in backend, macOS 27.0, 1x external display) and pressed the app's Screen Recording button: macOS **did** raise the system dialog from an installed bundle — the retest of spec 10.1 item 3, which phase 0 could only answer *false* from a temp folder — the entry is listed under the .app file name, and this time macOS also offered "Quit & Reopen", which the owner declined. Onboarding then stayed on "Waiting for Screen Recording": **defect D-A**, a helper that was running when the grant arrived keeps answering `denied` because `CGPreflightScreenCaptureAccess` is cached per process and this helper never attempts a capture while denied; killing it (one `READER_HELPER_EXIT`, a fresh helper from the supervisor within seconds) moved onboarding on at once. The first read then worked end to end — `SELF_TEST_PASSED` 1, `CAPTURE_ON` 1, `CAPTURE_OFF` 1, no problem code, one helper at 28 MB RSS as a child of the bundle's Electron, a statement in the review screen — but ordinary window switching soon produced `READER_PROBLEM` and capture off: **defect D-B**, found with a temporary diagnostic `dist/main.cjs` inside the granted bundle that recorded outcomes, timings and sizes only (dist rebuilt afterwards). That diagnostic also proved the macOS layer itself: 36 reads, 27 `ok` across four apps at 54–573 ms (median 230 ms) inside the 1 500 ms budget, `toolbarText` present for Safari, focus events from both sources, 3 unexplained `black`, and 6 `failed` with no front window — mid app-switch or under an overlay app — which the loop counted as the reader's fault, five in ten minutes being enough to switch capture off. The owner's decision **O4** made that its own outcome (`windowGone`), and three reviewed fix rounds followed: round 1 the Tasks 1–5 review's four Important findings (opus: APPROVED), round 2 D-A and D-B (opus: both ADDRESSED, the loop's privacy logic byte-identical, a revoked grant cannot hide behind `windowGone` — by the permission poll, not by the −3801 path, see the first-run record; one Important — a spawn plus a Vision warm-up every 10 s for ever while truly denied), round 3 that Important plus three Minors as **D13** and **D14** (sonnet: clean, the backoff arithmetic verified). Totals after the three rounds: **156** native and **914** TypeScript tests in 65 files, typecheck clean, zero compiler warnings, handshake `ALL CHECKS PASSED`, `SMOKE OK`. A **fourth round on 2026-09-19** followed the final whole-plan review's one Critical finding: the helper's same-pixels cache was cleared only inside a read, so the last window's full recognised text stayed in the helper's heap after reading was switched off (or the screen locked, or the user walked away) for up to the 6-hour planned restart — contradicting the app's own Privacy sentence "Nothing older than an hour exists anywhere" (`app/src/renderer/copy.ts:10`). The worker now waits for a job with a timeout and empties the cache after `CACHE_IDLE_CLEAR` = 60 s of nothing being asked, and every early return of `handle_read` that means "this window is not being read now" (locked, no grant, no front window, window gone, capture refused) clears it too; three crate files, ten new tests, three reverts watched to fail, native total **156 → 166**, TypeScript unchanged at 914. The second run on 2026-09-19 (same helper for the session) showed D-B fixed in real use — two minutes of free window switching produced a statement with no `READER_*` code at all — the grant surviving re-creation of the bundle with the same id and certificate (no new prompt), lock and unlock handled (one `CAPTURE_OFF`/`CAPTURE_ON` pair, the same helper alive, reading resumed), and the helper at 71 MB RSS and about 2.3 % of one core after five minutes, 85 MB after three hours. Not verified by this run: an unlisted browser (none installed — the `~/Applications` "Brave/Edge/Helium Apps" folders are web-app shortcuts), D-A in real use after the fix, revocation, the −3801 path, 2x displays, accuracy in Rust-greyscale, cold start after a reboot, and the cause of `black`. The full record, with every count and timing and the owner's own words, is `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`; its "Carried to plan C-2b" list is the complete, de-duplicated set of everything deferred.

**What the rulings of this execution cost or bought, as the record of what was traded away:**

- I-1 (drop homoglyph rule 2): a word the recogniser rendered *entirely* in twin letters stays unrepaired. Never measured; the two measured phase-0 cases contain Latin letters in the same word and are still repaired.
- I-2 (`isBrowser` prefix-matches on a word boundary, twelve more browsers): an app whose name merely begins with a browser's name — "Chrome Remote Desktop", the video player "Helium" — is not read. The safe direction (O2: unknown means no); the twelve names were never checked against `kCGWindowOwnerName`.
- I-3 (3 s `recv_timeout` on both capture completion waits): a capture slower than 3 s fails instead of wedging the worker. The read budget is 1.5 s anyway.
- I-4 (title-only focus events rate-limited in the helper, not in the loop): a tab switch can be noticed up to 5 s late; the loop's own 5 s poll would catch it. Privacy does not depend on focus events — the loop re-checks the title before and after every read and discards on a change.
- M-4 (gutter stripping only in runs of ≥3 lines stepping by exactly 1): a line number is sometimes left in the text, and a numbered list at the left edge still loses its numerals; content such as "404 Not Found" is never eaten.
- O4/D-B (`windowGone` is not a fault): a state that means "there is nothing to read" no longer switches capture off — and, because the loop's counters are never surfaced, an endless run of it is invisible. The counter or log code is C-2b's.
- D13 (denied-refresh with backoff): a grant given after minutes of denial can be noticed up to ~60 s plus the asker's own poll late, unless the user pressed the permission button first, which resets the interval.
- Deferred rather than fixed: the round-2 review's Minor 4 (surface the loop's outcome counts) and every item listed in the first-run record.

## Verification record (2026-09-18)

This record predates the execution: it describes the payload as it was first written (133 native / 874 TypeScript tests), before the three fix rounds above, and is kept as history rather than as the current state.

The payload was produced from working code, then verified as a payload: the patches and new files were applied to a FRESH copy of `app/` (linked to the real `node_modules`, `docs/` and `eval/`): every hunk applied without fuzz; `vitest` → 65 files, 874 passed (privateWindows 28, exclusions folder 75, renderer 112, `engine.readerEvents` 3, `realReader` 6, shell folder 30 + the real-binary test); `tsc --noEmit` clean for both configs. From that same copy `build-native.mjs --test` → 133 passed, `build-native.mjs` → zero warnings, `handshake_check.py` → ALL CHECKS PASSED. The real binary was driven through the real TypeScript client (`ready`, `permission`, `dispose` in under 0.9 s, no events). `dev-bundle.mjs` was run into a scratch folder: both signatures correct, self-replacement works, a foreign bundle is refused. `start-reader.mjs` was only syntax-checked and run to its `BUNDLE_MISSING` failure. The payload was grepped for personal paths: none.

The Rust probe table in Task 4 names tests that exist (checked by name), but those mutations were NOT pre-run while planning, unlike C-1's; a probe whose mutation does not make its named test fail is a finding for the reviewer to report, not to work around. The TypeScript probes of Tasks 1–3 and 5 were likewise not pre-run as mutations; the tests they name were run green.

NOT verified, stated plainly: everything in `app/native/reader/src/macos/` that touches a real window — window choice by pid snapshot, capture by window id, the −3801 mapping, greyscale + Vision on real pixels, the black check and the pixel hash on real captures, both toolbar bands in Rust, focus events, lock detection, 2× displays — is compile-verified only, by design: no window was captured while planning. It is a port of calls phase 0 measured working (Rust: ScreenCaptureKit + Vision; Swift: window id, greyscale) but the combination first runs in Task 6. Also not verified: launching the real bundle, the grant reaching THIS helper, the app's behaviour inside the bundle (`app.getAppPath()` differs there; fixtures are passed explicitly), and everything listed under "Deferred to plan C-2b".

## Self-review record

- Spec coverage: section 2 (crate layout, standalone helper) → Task 4; section 3 protocol → Task 4 (`protocol.rs`) against C-1's tested parser; section 5.1–5.3, 5.5 → Task 4 (D4–D8), first exercised in Task 6; section 8 (`build:native`, helper in `dist/native`, start guard's clave-back half untouched, smoke on the stand-in) → Tasks 4–5 (D9, D11); 10.1 item 1 (prologue) and 2 (warm-up before `ready`) → Task 4; item 3 (requestPermission retest) → Task 6 Step 4; item 6 (registered location) → Task 6 (O3, D10); item 7 (permission only from the helper's own check; −3801 → failed; `frontWindow` gated on the grant) → Task 4; items 8–9 (per-browser band in points × scale, unlisted browsers, case-insensitive word) → Tasks 1, 2, 4 (O1, O2, D1, D2); items 10–11 → nothing to build (documented behaviour); item 12 → this architecture; item 13 (homoglyphs) → Task 4 (D4); item 14 (about 60 MB) → measured in Task 6 Step 5; item 16 (window id + greyscale in Rust) → implemented in Task 4, first proven in Task 6; item 17 (focus detection) → implemented in Task 4, observed in Task 6 (capture follows window switches). Items 4, 5, 15 and the acceptance numbers → C-2b, listed above.
- Known weak point, stated rather than hidden: Task 6 is where compile-verified code meets reality with the owner watching; Step 7 says what to do when it does not work.
- One wording trap fixed while writing: Task 5 Step 1 cannot show a classic "red" run because the implementation file arrives with its tests; the task says so and relies on the revert probes instead.
## Note 2026-09-19 (C-2b-1)

Plan C-2b-1 changed files this payload carries. The payload's `new/` files were re-synchronised from the code and `MANIFEST.sha256` regenerated for them, so they again equal `app/`. The `patches/*.diff` were NOT regenerated and are kept as the record of C-2a: a diff from the pre-C-2a state cannot be rebuilt without that state (there is no git), and replaying them yields C-2a's code, not today's. Patched files that C-2b-1 changed afterwards: `app/src/renderer/copy.ts`, `app/src/main/log.ts`, `app/src/main/engine.ts`, `app/src/shell/app.ts`, `app/scripts/build.mjs`, `app/src/main/ports/reader.ts`, `app/src/main/ports/ports.test.ts`, `app/src/main/capture/loop.ts`, `app/src/main/capture/loop.test.ts`, `app/package.json`. Their current versions are in `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/files/`. One wording fix to Task 4's probe table: "skip the cancellation check between capture and recognition" reads as one check where there are several; the coverage is real, the wording was not (carried item 23).
