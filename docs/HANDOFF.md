# Handoff: where the work stopped and what is flagged

Written 2026-09-17. Read this before resuming. It covers the state of the core pipeline
implementation plan, everything flagged along the way, and leftovers on the machine.

## 1. Where things stand

| Piece | State |
|---|---|
| Overall plan, decisions, spike results | Done: `docs/implementation-plan.md` (draft 6) |
| Spike S1 (model in Electron) | Done, passed. Throwaway code removed; findings are in `docs/implementation-plan.md` |
| Spike S2 (accessibility reader) | Done. Approach later dropped for screenshots only. Throwaway code removed; findings are in the plan |
| Spec A: core pipeline | Approved, then amended to match the verified plan: `docs/superpowers/specs/2026-09-17-core-pipeline-design.md` |
| Plan A: core pipeline | **COMPLETE AND VERIFIED** (repaired 2026-09-17): `docs/superpowers/plans/2026-09-17-core-pipeline.md`, 12 tasks |
| Spec B: desktop app | Approved 2026-09-17: `docs/superpowers/specs/2026-09-17-desktop-app-design.md` |
| Plan B-1: desktop engine (no Electron) | **Executed and hardened 2026-09-17**: `app/src/main/`, `app/src/standins/`, `app/src/eval/`; 545 tests, typecheck clean. Every task reviewed by probe, findings fixed in five rounds. Record, decisions and open items: `docs/superpowers/reviews/2026-09-17-desktop-engine-review.md` |
| Plan B-2: Electron shell, real model host, UI | **Executed and hardened 2026-09-18**: 768 tests, typecheck clean, `SMOKE OK`, real-model gate safe (one quality note). Run it: `pnpm --dir app start:scripted` (stand-ins + scripted model) or `pnpm --dir app start` (real model). Still stand-ins: the reader (C) and clave-back (D); a packaged build refuses to start. Nobody has looked at the real window yet. Record: `docs/superpowers/reviews/2026-09-18-desktop-shell-review.md` |
| Spec C: native reader | Spec approved 2026-09-18: `docs/superpowers/specs/2026-09-18-native-reader-design.md`. **Phase 0 spikes done 2026-09-18, all six passed** (P1 to P6); findings in the spec's section 10 and in full in `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`. **Build split in two (2026-09-18).** C-1, the TypeScript reader client, is EXECUTED and reviewed: `app/src/main/reader/`, `app/src/main/testing/fakeReaderHelper.ts`, `app/src/shell/readerLink.ts` (+ fixture and tests), 61 new tests, suite 835, typecheck clean, `SMOKE OK`; it is NOT wired into `app.ts`. Plan and decisions D1–D11: `docs/superpowers/plans/2026-09-18-native-reader-c1-client.md`. ~~**C-2 (Rust helper `clave-reader`, wiring, log codes, `reader:eval`) NOT WRITTEN**~~ — superseded 2026-09-19: C-2 was split again. **C-2a is EXECUTED and hardened 2026-09-18/19**: the Rust helper crate `app/native/reader/` (protocol 1, scheduler, text assembly with homoglyph repair, toolbar band, black check and same-pixels cache, and the macOS layer — window server, ScreenCaptureKit by window id, greyscale + Vision, permission, focus), the two core rules (`MEASURED_BROWSERS`; Safari's bare-word badge), six `READER_*` log codes, the shell wiring behind `CLAVE_REAL_READER=1`, `build:native`, and the signed dev bundle `~/Applications/Clave Agent Dev.app`. **166** native and **914** TypeScript tests in 65 files, typecheck clean, `SMOKE OK`. The owner watched the app read a real screen for the first time on 2026-09-18, which found two defects (a running helper not seeing a fresh grant; ordinary window switching counted as reader failures) fixed in three reviewed rounds and confirmed on 2026-09-19; a fourth round on 2026-09-19 fixed the final whole-plan review's one Critical finding — the helper's same-pixels cache outliving the reading it came from, against the app's "Nothing older than an hour exists anywhere" — with a 60 s idle clear in the worker and a clear at every early return that means the window is not being read. Plan and decisions O1–O4, D1–D14: `docs/superpowers/plans/2026-09-18-native-reader-c2a-helper.md`; first-run record, what it verified, what it did not, and the full carried list: `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`. ~~**C-2b (`reader:eval` with repeated reads at fixed sizes, the accuracy and band numbers in Rust-greyscale, the manual checklist, the onboarding copy, the deferred minors) NOT WRITTEN**~~ — superseded 2026-09-19: C-2b was split by the owner (decision O5) into C-2b-1 and C-2b-2. **C-2b-1 is EXECUTED and reviewed 2026-09-19.** It is the half that needs no real screen: protocol 2, with `read` carrying the window main approved (`expect`) and the helper refusing to capture anything else, plus numbers-only `stats` and an eval-only `lines`; a nothing-read counter and notice so that a long run of cycles that read nothing stops being invisible; the dev bundle's switches baked into a launcher in the checkout, and `dev:bundle` refusing to replace a bundle under a running app; the homoglyph repair moved into the core so A no longer depends on which reader produced the text; the onboarding permission copy rewritten from what macOS really does; the C-1 and C-2a deferred minors; and `reader:eval` — built, unit-tested, and **never yet run against a screen**. **1563** TypeScript tests in 87 files and **231** native tests, typecheck clean, zero compiler warnings, handshake `ALL CHECKS PASSED` (protocol 2), `SMOKE OK`. Eight independent topic reviews, one fix round, a final whole-plan review, two fix waves, each re-reviewed. Plan, decisions O5–O7 and D1–D18, and the execution record (including the rulings taken on the owner's behalf and an incident in which an agent's test import re-created the owner's real dev bundle): `docs/superpowers/plans/2026-09-19-native-reader-c2b1-code.md`; payload `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/` (99 files, `install.py --verify` 99 of 99). Its Task 9 — the owner quitting the app and rebuilding the bundle — is **not done**. **C-2b-2 (the measurements and the acceptance with the owner: accuracy and band numbers on the Rust-greyscale path, the private-window observation, the manual checklist, the real-day behaviour of everything C-2b-1 built) NOT WRITTEN** **C-2b-2 EXECUTED 2026-09-19 to 2026-09-22: every measurement made or recorded as a named gap; sub-project C awaits the owner's acceptance (two qualifications), see the 2026-09-22 (12:00) block in section 0.** |
| Spec D (clave-back API), packaging/telemetry | Not started |
| Any product code (`app/`) | **Plan A executed 2026-09-17**: `app/src/core/` and `eval/`, 257 tests / 16 files pass, typecheck clean, on the pinned toolchain. Final review found defects in the plan's own code; C1, C2, I1 to I5 and the `model.open()` wedge fixed; only the Minor items remain: `docs/superpowers/reviews/2026-09-17-core-pipeline-final-review.md`. Section 0 below is done; decide on that review before sub-project B |

## 0. START HERE (decided 2026-09-18)

**Update 2026-09-19 (evening) — this is now the only current "Next", and it has two parts, in
order.**

**Update 2026-09-19 (late): the bundle half of Task 9 is DONE** — on the owner's "continue with the plan" the app was confirmed not running, `build:native` and `dev:bundle` were run (`DEV_BUNDLE_OK`, signature verified), so the bundle holds the current protocol-2 helper and the new launcher. What is left of Task 9 is the owner's alone: confirm the Screen Recording grant in System Settings, and the first launch, which opens plan C-2b-2. The paragraph below is kept as it was written earlier the same evening.

**First, Task 9 of plan C-2b-1, which is the OWNER's and nobody else's.** Confirm that Screen
Recording is still granted to "Clave Agent Dev" in System Settings → Privacy & Security — an agent's
test import re-created and re-signed that bundle by accident at 20:03 on 2026-09-19 (nothing was
launched, nothing was running from it, no read was sent, the data folder was untouched, `codesign
--verify --deep --strict` exited 0, and the root cause is fixed and verified). Then quit the app from
the tray, and run `pnpm --dir app build:native` and `pnpm --dir app dev:bundle`. Checked 2026-09-19
without launching anything: the bundle as the accident left it holds the helper that was in
`target/release` at 20:03 — built after the payload was installed, so it should speak protocol 2 —
and the new one-line launcher; every later change to the Rust sources was comment-only. That is an
inference from file times and sizes, not a handshake with that binary, and the bundle was made with
nobody watching: re-creating it by hand is still the step to take before anything is launched. The optional third step — two minutes of ordinary work under
`start:reader:scripted`, then counting the log codes — may move into the first session of C-2b-2 if
the owner prefers.

**Update 2026-09-22 (12:00) — plan C-2b-2 is COMPLETE; sub-project C is ready for the owner's acceptance. The single current Next: the owner reads the final summary (ledger, end of Session 5) and the section-9 table in `docs/superpowers/reviews/2026-09-21-native-reader-c2b2-measurements.md`, accepts or refuses the two qualifications (Task 7 sampled a morning, about 1,170 reads, instead of six hours; Task 6 Step 6 machine sleep not testable with `SleepDisabled 1`), and names what comes next (sub-project D is already started per the project memory).** Measured today: accuracy x5 and toolbar ACCEPTED at 2x (`accuracy-d6fdec16da23.json`, `toolbar-39912ad56508.json`, position 2600,600; the Retina sits at origin 2560,540 in a 1440x900-pt scaled mode); Safari private at 2x 5/5; Task 6 Steps 1–5 PASS; helper killed x3 PASS; full-screen + second display PASS; Task 9 not testable here (owner). Named gaps: VS Code gutter check and overlapping-windows content judgement need the REAL model (`start:reader`); excluded app in full screen not done; `READER_NOTHING_TO_READ` never fired in real use; the one `READER_PROBLEM` of 2026-09-20 never reproduced (today: `failed` 1 = `captureError` and `black` 1 in about 1,200 cycles). Spec: six dated notes appended 2026-09-22 (sections 5.2, 5.3, 5.5, 7, 10.1, 10.2; additions only, verified by diff). Gates: 2990/90, typecheck clean, native 251, `SMOKE OK`. Machine: app quit; grant ON; yabai not running (the owner restarts it with `yabai --start-service` if he wants it). Carried to packaging: repeat P1/P2/P6 under a Developer ID (unchanged). The block below is kept as history.

**Update 2026-09-22 (00:10) — this is the single current Next: plan C-2b-2, Task 6 STEP 6 only (machine sleep and the nothing-read clock, ~17 min; the Clave Agent window itself is an excluded app that can sit in front), then Tasks 7, 8, 9, 10 — with the owner, ONE action at a time.** Task 6 Steps 1–5 PASSED on 2026-09-21 night (record: measurements file, "Session 4"): a grant given under a running app is picked up at once with "Later" (also after 14 minutes on the blocker), Quit & Reopen brings the app back in the same mode, revocation is noticed in ~7 s with `PERMISSION_LOST` + `CAPTURE_OFF` and no `READER_PROBLEM`, reading resumes by itself on a re-grant, lock and display sleep pause the poll (tallied as `noWindow`; the `locked` tally stayed 0). No code changed; suite 2990 in 90 files. State left: dev app running with reading off, grant ON, yabai running (acceptance runs need `yabai --stop-service` by the owner). Quit the app with Cmd+Q while its window is frontmost, then check `pgrep` — once it did not quit. The block below is kept as history (its open list is superseded by this one).

**Update 2026-09-21 (night) — this is the single current Next: plan C-2b-2 from Task 6 onwards, with the owner, ONE action at a time.** Done this evening (record: `docs/superpowers/reviews/2026-09-21-native-reader-c2b2-measurements.md`, "Session 3"; ledger as before; reports `…/c2b2-files/session2/o8-rereview3.md` and `…/c2b2-files/session3/`): O8 core rule COMPLETE (re-review 3 → fix round 4 → re-check ALL ADDRESSED; zero-padded ports no longer count); Chrome toolbar run ACCEPTED again with `addressLine` 40/40; owner decision "A" → `toolbar --not-secure` (loopback server, resolver rule only in the eval’s own Chrome profile, never accepted, schema 6), reviewed/fixed/re-checked, RUN: Chrome 153 draws "Not Secure" as its own recognised line, `addressLine` 4/4 and 39/40 (the miss an incognito read); Task 4 COMPLETE (in-app control PASS: normal kept 41 / private kept 0; Safari private 5/5 and normal 0/5 in compact-8-tabs and SEPARATE-8-tabs layouts — every earlier Safari number was compact/one tab). Suite: `pnpm --dir app test` 2990 passed in 90 files, typecheck clean, native 251 (unchanged; Rust untouched). The dev app may still be running with reading off; the owner restarted yabai at the end of the session (acceptance runs need it stopped again: `yabai --stop-service`). Task 5 is DONE too (bookmarks bar shown: ACCEPTED, `addressLine` 40/40; the owner's own Chrome with tab group + side panel + pinned extensions, normal and incognito: 5/5 each; NO band-rule change). STILL OPEN, in order: Task 6 (permission in real use, about an hour, disruptive: `tccutil reset`, onboarding, revoke/re-grant, lock, sleep), 6, 7, 8 (incl. both acceptance runs at 2x with `--position`), 9, 10. Open observations: two transient reads with the host present but no address-only line (one Safari compact, one Chrome incognito) → evidence for the design item "the reader hands the core the address ROW"; deferred test-only minors of O8 (F25–F27, F30) and of the not-secure variant (M1–M4) are listed in the ledger; S1-F1 cause still unknown; S1-Q2 not reproduced. The block below is kept as history.

**Update 2026-09-21 (evening) — current Next: finish plan C-2b-2 from Task 4's remainder onwards, with the owner, ONE action at a time.** Done since the block below was written (record: `docs/superpowers/reviews/2026-09-21-native-reader-c2b2-measurements.md`, "Session 2"; ledger: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session1/ledger.md`): Safari private windows skipped 5/5 and normal ones not flagged 5/5 (item 29 PASS at 1x); root cause of Safari's missing host found ("Translation Available" replaces the host for seconds after a load); **owner decision O8: a Chrome/Safari read whose strip shows no address line is not kept** — built in `app/src/core/exclusions/sites.ts` + `index.ts`, three review rounds, last verdict "approved with reservations", fix round 3 done, its re-check report is `…/c2b2-files/session2/o8-rereview3.md` (READ IT FIRST: if it lists findings, they are the first thing to fix); owner-approved KNOWN_LIMITS sentence added; harness: `--expect`, progress, retries, `hostDistance`, `--host`, `--reveal-toolbar` (owner-approved debug flag), `addressLine`, schema 5. Suite at hand-over: `pnpm --dir app test` 2714 passed in 88 files, typecheck clean, native 251, `SMOKE OK`. **Standing instructions from the owner (2026-09-21): do NOT use any `superpowers:*` skill any more; give him ONE action per message.** In a fresh shell `pnpm` may not be on PATH: `export PATH="$HOME/Library/pnpm/bin:$PATH"`. STILL OPEN, in order: (1) a two-minute Chrome toolbar run (`reader:eval -- toolbar`, yabai stopped by the owner) to read `addressLine n/40` — does the real omnibox satisfy O8's per-line rule; (2) how Chrome's "Not secure" label is recognised (loopback pages never show it — needs an owner decision about serving a staged page on a non-loopback address); (3) Task 4 Step 3 in-app control (normal Safari window → statements, private → none) and Step 4 Safari compact layout with many tabs; (4) Task 5 Chrome bookmarks bar and other toolbars, band-rule decision; (5) Task 6 permission in real use; (6) Task 7 a working day of sampling; (7) Task 8 manual checklist + the two acceptance runs on the 2x display (`--position`); (8) Task 9 browser names; (9) Task 10 acceptance of sub-project C, spec notes (O8 and protocol/harness changes need dated notes in the spec), HANDOFF. Also open: the cause of the one `READER_PROBLEM` of 2026-09-20 (failed-read detail codes will name it next time); an off/on toggle that left no log line; the design item "the reader hands the core the address ROW"; the side observation that a private window detected in `after()` never marks the user away. The paragraph below is kept as history.

**Update 2026-09-21 — the current Next is plan C-2b-2's Task 4 onwards (needs the owner at the machine).** Sessions of 2026-09-20/21 are recorded in `docs/superpowers/reviews/2026-09-21-native-reader-c2b2-measurements.md` (ledger and every report: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session1/`). DONE: Task 1; Session 1 (first launch, cold start after a reboot 150 ms, grant survived, harness shake-down in three reviewed repair loops); **Task 3 acceptance at 1x: accuracy x5 ACCEPTED (chat 1.0, ticket 0.9983, code 0.9709, pt 1.0 accents 1.0, terminal 0.9902 minimums) and toolbar ACCEPTED (host 20/20, private 20/20, false-private 0/20; badge 70–75 px inside an 82 px band)**; failure DETAIL codes end to end (a `failed` read now names its stage in the `CAPTURE_OFF` tallies). Suite: `pnpm --dir app test` 2076 passed in 87 files, native 251, typecheck clean. OPEN: the cause of the `READER_PROBLEM` seen once in real use on 2026-09-20 (not reproduced; the next trip names its stage); an off/on toggle that left no log line; Tasks 4–10. **Standing facts for every eval run on this machine:** the owner runs the tiling window manager yabai — acceptance runs are made with `yabai --stop-service` (the owner's command; he restarts it with `--start-service`), because a title rule misses ~2 % of stagings; closing the app's window does NOT quit it (tray app) — check `pgrep -f "Applications/Clave Agent Dev.app/Contents/MacOS"` before `dev:bundle`; the smoke run prints nothing while the dev app is running; a session ledger belongs under `docs/`, not only in the scratchpad (a reboot wiped `/private/tmp` on 2026-09-19). The owner prefers ONE action at a time. The paragraph below is kept as history.

**Update 2026-09-19 (night): plan C-2b-2 APPROVED by the owner ("yes") and its Task 1 EXECUTED and reviewed** — `coldstart` with `helper.readyMs`, `--position`, Chrome in `observe`, a numbers-only `position` in results; suite 1679 passed in 87 files, typecheck clean, `SMOKE OK`; reports in `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/`. **The current Next is its Task 2, Session 1, which needs the owner at the machine:** confirm the Screen Recording grant, first launch, a look at the two new surfaces, a bare relaunch, `coldstart`, then the one-repetition shake-down of `reader:eval`. The sentence below is kept as written earlier.

**Update 2026-09-19 (late): plan C-2b-2 is WRITTEN and awaits the owner's approval** — `docs/superpowers/plans/2026-09-19-native-reader-c2b2-acceptance.md`: one agents-only task (three small harness additions: `coldstart` with `readyMs`, `--position`, Chrome in `observe`) and seven sessions with the owner, opening with the first launch and a shake-down of `reader:eval`. The paragraph below is what it was written from.

**Then write plan C-2b-2.** Start from the new table at the end of
`docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`, "Status of the carried items
after plan C-2b-1", which says for each of the 40 carried items whether it is closed, whether the
instrument exists and the number is still owed, or whether it was always going to need a screen; and
from the list of new items under it. Start the plan with the things only a screen decides, in this
order: the Safari private window actually being skipped (the single most consequential unmeasured
behaviour in the sub-project), the accuracy and toolbar-band numbers on the Rust-greyscale path
through `reader:eval`, then the non-default browser toolbars, the manual checklist, and the real-day
behaviour of the nothing-read notice. Note that `reader:eval` has never met a screen: its dev report
lists 22 things the first run will find out, several of which will simply make every repetition
`notStaged` until they are adjusted. Method that worked three times now: brainstorm the plan, keep
the per-task independent reviews with reproducing probes, and never re-extract an executed plan's
code blocks over the code.

_Superseded 2026-09-19 (evening) by the block above (C-2b was split into C-2b-1, now executed, and
C-2b-2); kept as history:_ **Update 2026-09-19 — this is now the only current "Next": write plan C-2b.** Plan C-2a is executed
and hardened (see the status table): the real native reader runs, and on 2026-09-18/19 the owner
watched the app read his own screen through it for the first time, from the signed dev bundle in
`~/Applications`. Two defects were found in that first run and fixed in three independently reviewed
rounds; the second run on 2026-09-19 confirmed the fixes in real use. Start C-2b from the
**"Carried to plan C-2b"** list in `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`
— it is the complete, de-duplicated set of everything deferred by the plan, the ledger and the three
reviews (28 items), and the same file's "What this run verified" / "What it did not" say exactly how
far the macOS layer is proven. The spec's sections 10.1 and 10.2 now carry the same state per item.
The four UI observations the owner made during the run belong to sub-project B, not to C-2b, and are
in the same record. Method that worked twice now: brainstorm the plan, keep the per-task independent
reviews with reproducing probes, and never re-extract an executed plan's code blocks over the code.

**2026-09-18 — phase 0 of sub-project C (native reader) is finished. All six spikes passed**, each
finding independently reviewed. Full records: `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`;
summary and consequences: section 10 of `docs/superpowers/specs/2026-09-18-native-reader-design.md`.
Everything was measured on one machine (macOS 27.0, 1x display, self-signed certificate, single runs).
The branch chosen per spike:
- P1: the standalone helper of spec section 2 is the design — no Node-child form, no capture-in-main
  fallback. (Corrected 2026-09-18: Electron's `desktopCapturer` in main worked only in app processes
  launched after the grant — 5 records — and failed in all 26 records of processes that were already
  running when the grant arrived; the helper needs no restart. So the fallback was not needed, not
  broken, and would have cost an app relaunch after the grant.)
- P2: a helper restart is enough — spec section 5.3 keeps `needsRestart` and the one automatic helper
  restart; the app-level restart branch is not needed. `requestPermission()` still needs a retest from
  an installed build.
- P3: Rust with the objc2 crates is fast and accurate enough — no Swift static library.
- P4: recognition quality passes all five thresholds at 1x; spec section 5.2 step 5 unchanged.
- P5: Chrome and Safari private detection is reliable in this sample; the toolbar band becomes
  per browser, in points × display scale.
- P6: spec section 5.3 stands as written; no adjustment to the failure table.

_Superseded 2026-09-19 by the block at the top of this section (plan C-2 was split into C-2a and C-2b; C-2a is executed); kept as history:_ **Update 2026-09-18 (evening) — this is now the only current "Next": write plan C-2.** The owner accepted P4
(threshold unchanged) and chose to execute C-1 first; C-1 is done (see the status table). Plan C-2 covers
the Rust helper `clave-reader` (spec 10.1 items 1, 2, 8–11, 13, 16, 17), wiring the real reader into
`app/src/shell/app.ts` beside the stub API, log codes for the client's six events, `build:native` and
`reader:eval`. Design inputs deferred from C-1's review: `HelperLink.onLine` must be registered
synchronously after spawn; cap line length in `readerLink.ts` before buffering; the automatic-restart
path should retire a helper gracefully when calls are in flight; reviving after a protocol mismatch
respawns the same binary once per subscription. The objc2 crates are cached in `~/.cargo`, so the Rust
can be built offline while planning. Method that worked for C-1: develop the code in a scratch
workspace that links `app/node_modules` and the real ports, then generate the plan from those files.

_Superseded 2026-09-18 (evening) by the block above; kept as history:_ **Next: the owner decides whether to write the build plan for C**
(`superpowers:writing-plans`), which must start from the spec's section 10.1. A final whole-phase
review on 2026-09-18 corrected three facts and filled nine gaps in the spec's section 10 — read 10.1
and 10.2 as they now stand, not as they were on the morning of 2026-09-18. One item there is an
owner decision: the terminal recognition case passed at 0.9882 in the recorded run, but an earlier
discarded run of the same staged window scored 0.8686, below its 0.95 threshold, so the P4 numbers
are single samples and run-to-run variance is unquantified.

Carried to packaging: repeat P1, P2 and P6 under a real Developer ID.

Leftovers on the machine from phase 0: the self-signed certificate "Clave Agent Dev" is kept in the
login keychain on purpose (the build plan's dev workflow uses it); Rust crates are cached in
`~/.cargo` (the objc2 family, serde_json); and the spike's app bundle in the temp folder can neither
be listed nor reset in System Settings (`tccutil` answers -10814) — its grant is inert once the bundle
is deleted.

Sub-projects A (core pipeline) and B (desktop engine + Electron shell + UI) are built and hardened:
768 tests, `pnpm --dir app smoke` prints `SMOKE OK`, the real model passes the release gate as safe.
The reader and clave-back are still stand-ins. ~~**Next: the spec for sub-project C, the native reader**
(the owner's choice, 2026-09-18), in a new chat, with the `superpowers:brainstorming` skill
(architectural path: questions one at a time, approaches, sectioned design, written spec, then
`superpowers:writing-plans`).~~
Superseded 2026-09-18: that spec was written and approved and its phase 0 is finished; the current
"Next" is the dated block at the top of this section. Kept above as history.

What the spec for C started from (historical; phase 0 has since answered the spike questions in the
last bullet):
- The contract is fixed: the `Reader` port in `app/src/main/ports/reader.ts` (permission,
  requestPermission, frontWindow, read with a budget, onFocusChange, dispose). Everything crossing it
  is validated in main. `app/src/standins/devReader.ts` is what C replaces.
- Decided earlier (memory `local-evidence-app-brief`): SCREENSHOTS ONLY plus the OS's built-in text
  recognition; no accessibility layer; on Mac the only permission is Screen Recording; Rust via
  napi-rs is allowed for this one native piece; capture the focused window, recognise, delete the
  image at once; browsers also return the recognised toolbar strip (`toolbarText`).
- Requirements the B reviews put on C: answer `failed`, not `black`, when Screen Recording is
  revoked; `read()` may be re-entered after main gave up on a call (serialise or cancel, never
  answer a later call with an earlier frame); `onFocusChange` must support several subscribers;
  main enforces its own timeouts (`READ_BUDGET_MS` 1.5 s + `READER_CALL_TIMEOUT_MS` 5 s).
- Unverified risks C must settle first (spikes): does the Screen Recording grant reach a child
  process (S2 showed the Accessibility grant does not reach Electron's helper; fallback: capture in
  main, recognise in a child); Apple Vision + window capture from Rust; terminal apps; Portuguese
  accents; messy real screens; Chrome private-window detection from the toolbar strip.
- Measured before (memory `ocr-reliability-test`): Mac text recognition 97-100% on chat/tickets,
  about 90% on code (punctuation), about 150 ms per frame.

Rules that still apply to every session:
- No git: never init, commit, branch or push. Plans use "Checkpoint" steps instead.
- Run commands from the repo root with `pnpm --dir app <script>`. Do not `cd`.
- No downloads or installs without the owner's approval for that execution.
- Never re-extract a plan's code blocks over the code: all three executed plans were fixed after
  review and no longer match their documents.
- Plans whose code was run beforehand still had real defects; keep the per-task independent reviews
  with reproducing probes.
- **Never run `pnpm` against a copy of `app/` whose `node_modules` is a symlink** (incident
  2026-09-19: pnpm's deps-status check tried to reinstall and wanted to PURGE the modules directory
  through the link; it stopped only because there was no TTY). In a scratch copy call the tools
  directly: `node <repo>/app/node_modules/vitest/vitest.mjs run --root <copy>`,
  `node <repo>/app/node_modules/typescript/bin/tsc --noEmit -p <copy>/tsconfig.json`,
  `node <copy>/scripts/build-native.mjs [--test]`.
- **The file-writing tools decode backslash escapes into literal characters**, inconsistently.
  Anything containing escapes is generated by a script from code points, or written with exact-string
  edits, and the bytes on disk are checked afterwards. This is not theoretical: two files of the eval
  harness sat in the payload holding raw NUL bytes, which `file(1)` reports only as `data` and which
  plain grep cannot see, so every audit sweep was blind to them.
- **A test must never import a script whose top level DOES something.** On 2026-09-19 importing
  `scripts/dev-bundle.mjs` from its own test ran the script and re-created the owner's real
  `~/Applications/Clave Agent Dev.app`. Scripts gate their program half on being the entry point.

**Incident, 2026-09-17:** `docs/implementation-plan.md` was found missing from disk. No command in
any session transcript deleted it, so the cause is unknown. It was rebuilt exactly (685 lines,
draft 6) by replaying, in an isolated scratch folder, the nine commands from the session
transcript that had created and edited it. If it ever disappears again, the same method works:
the transcripts are under `~/.claude/projects/-Users-sardorastanov-techcells-asset-to-evidence/`.

## 2. What happened to the plan file

The plan was cut off mid-Task 9 (inside the `COMMON_WORDS` list, with an open code fence) when the
model was switched mid-session. It was repaired and finished on 2026-09-17: Task 9 completed,
Tasks 10 to 12 written, self-review done.

## 3. Flags on the plan

**F1 (closed). The plan's code is verified.** Every file block was extracted from the plan and
run: 164 tests pass, strict type check clean, leak test and all 8 evaluation fixtures pass. See
the plan's "Verification record". Running it caught two mistakes, both fixed.

**F2 (open). The pinned toolchain was never installed.** `typescript@7.0.2`, `vitest@5.0.1`,
`zod@4.6.5`. Verification used Bun 1.4.2, TypeScript 6.0.3 and Zod 4.4.3 that were already on
disk. Expect small friction in Task 1; adjust config or call shape, never behaviour.

**F3 (closed, needs the owner's eyes). The approved spec was amended** to match the verified
plan: app-only exclusion rules, hint table for ambiguous skill names, stricter phone rule,
narrower person-name detection, simpler English check, `takeCounters()` instead of a daily
reset, import guard as a test only, evaluation set starting at 8 fixtures. The plan's
"Deviations" table gives the reason for each. If any is unwanted, say so before execution.

**F4 (open). Known limits of the guard:** all-caps names ("ACME") are not recognised as proper
nouns, and a confidential fact phrased in generic words cannot be detected. The review screen and
`docs/WHAT-LEAVES.md` must say so.

**F5 (open). Known limit of skill matching:** a skill that is shown but never named on screen is
never offered to the model. Competencies partly cover this. Revisit after the experiment.

**F6. No git.** The repo is not a git repository and the owner forbids init, commit, branch or
push unless he asks. The plan uses "Checkpoint" steps instead of commits.

**F7. Tool quirk when editing the plan:** a backslash-u escape in a heredoc is decoded into a
real control character and the command is rejected. Write such classes as `[\x00-\x1f]`.

## 4. Flags carried over from the design work

- **Screen Recording grant and child processes: unverified.** S2 proved the Accessibility grant
  does not reach Electron's helper program. The same must be tested for Screen Recording before
  the reader spec is written. Fallback: capture in the main process, recognise in a child.
- **Text recognition from Rust is unverified** (Apple Vision bindings, window capture API).
  Only a Swift prototype was tested, on synthetic English screens.
- **Untested inputs:** terminal apps, Portuguese text with accents, messy real screens
  (overlapping windows, images), Windows and Linux recognition engines.
- **VS Code is recognition-only territory** and is where the target users spend their day, so
  recognition quality on code (about 90%, punctuation errors) matters more than first assumed.
- **Known limit of the guard:** it cannot detect a confidential fact phrased in generic words.
  The review screen must say so plainly.
- **Chrome private windows** rely on recognising the "Incognito" label in the toolbar strip.
  Plausible, not yet verified against a real capture.

## 5. Open decisions for the owner

1. How private evidence appears on the profile next to call evidence (label or blend).
   Recommendation on file: label it.
2. Whether to open-source the desktop client. It changes the pitch; settle before outreach.
3. Apple Developer account for signing and notarisation. Without it, installs show a
   malware-style warning.
4. Where usage counts go: the company's analytics tool or a small clave-back endpoint.
   (The Amplitude connector needs re-authorising before it can be inspected.)
5. The clave-back change for evidence without a call (sub-project D) is agreed in principle and
   will be done in these sessions, but has no design yet.

## 6. Leftovers on the machine

The `spikes/` folder (both throwaway spikes, their dependencies, and `samples.jsonl`, which held
real screen text from the S2 run) was moved to the Trash on 2026-09-17 at the owner's request, as
`asset-to-evidence-spikes-20260917-165114`. It is gone from the project. **It is only permanently
gone once the owner empties the Trash**, which the assistant is not permitted to do.

| What | Where | Note |
|---|---|---|
| Spikes folder incl. real screen text | Trash | Empty the Trash to destroy it for good |
| Accessibility permission | System Settings, granted to the dev `Electron.app` | No longer needed since accessibility was dropped. Remove it |
| Model file, 2.74 GB | `~/.cache/clave-agent/models/` | Keep; later phases reuse it |
| Rust toolchain, about 1.3 GB | `/opt/homebrew/opt/rustup/bin`, `~/.rustup` | Not on PATH; the shell profile was deliberately not edited |
| Development app bundle, about 290 MB (C-2a, 2026-09-18) | `~/Applications/Clave Agent Dev.app` | **Holds a live Screen Recording grant** (bundle id `dev.clave.agent.dev`). Keep while C-2b runs. To remove it completely: `rm -rf "$HOME/Applications/Clave Agent Dev.app"` **and** `tccutil reset ScreenCapture dev.clave.agent.dev` — deleting the bundle alone leaves the grant behind. Bundle refreshed 2026-09-19 15:28 (local) with the helper that has the cache-retention fix; the app is NOT running. Lesson from that refresh: `tell application … to quit` does not stop this tray app — check `pgrep` and stop it with a normal TERM before running `dev:bundle`, never replace the bundle under a running app (doing so made the running app log `PERMISSION_LOST`). **2026-09-19:** re-created by accident at 20:03 by an agent's test import of `scripts/dev-bundle.mjs`, from the protocol-2 checkout — nothing launched, nothing running from it, no read sent, the data folder untouched, `codesign --verify --deep --strict` exit 0; the script now gates its program half on being the entry point, and it also refuses to replace a bundle at this location while the app is running. **The owner is to confirm the Screen Recording grant still holds.** The warning above that the bundle carries a stale helper inside is superseded once Task 9's `pnpm --dir app dev:bundle` has been run |
| Its data folder (C-2a) | `~/Library/Application Support/Clave Agent Dev/` | Holds `app.log` and the app's own state from the real runs. `rm -rf` it with the bundle |
| `app/.dev-launch.json` (C-2b-1, 2026-09-19) | repo | Written by `start:reader` before every deliberate launch so that macOS's own "Quit & Reopen" can restore the launch mode. Holds `{}` or `{"CLAVE_SCRIPTED_MODEL":"1"}`, and `CLAVE_SCRIPTED_MODEL` = `"1"` is the ONLY thing ever read back from it. Safe to delete; it is rewritten at the next launch |
| `app/reader-eval/out/` (C-2b-1, 2026-09-19) | repo | Does not exist until `reader:eval` has been run. It then holds the results JSON and `observe-urls.json` — numbers, booleans, fixed codes and the harness's own case names, never recognised text and never a foreign window title. It is inside the repo on purpose (agents may not open the dev data folder), so exclude it from any "copy `app/` without `node_modules`, `dist`, `target`" recipe. The eval's Chrome profile is NOT here: it lives in a per-run folder under the OS temp directory and is removed when the run ends |
| Self-signed certificate "Clave Agent Dev" | login keychain | Kept on purpose since phase 0: the dev bundle is signed with it, and the Screen Recording grant survives re-creating the bundle only while the certificate is the same. Deleting it means re-granting |
| Rust crate cache, the objc2 family and serde_json | `~/.cargo` | Kept on purpose: `build:native` and `test:native` run `--offline --locked` and will fail if it is cleared |

## 7. Tools that were unavailable

- The MongoDB connectors failed all session with a JSON-schema dialect error, so taxonomy sizes
  were taken from Zafar's estimate (3 to 4 thousand skills, about 25 competencies).
- Amplitude, composio and several data connectors need authorisation in connector settings.
