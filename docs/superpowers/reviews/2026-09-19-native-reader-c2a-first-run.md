# Native reader C-2a: first real run

Record of Task 6 of `docs/superpowers/plans/2026-09-18-native-reader-c2a-helper.md`: the first time
the compile-verified macOS layer of `clave-reader` met a real window, with the owner at the machine.
Two sessions, 2026-09-18 (first run, two defects found) and 2026-09-19 (second run, after three fix
rounds). Everything below is a log code, a count, a timing, a process fact or the owner's own words.
No recognised text and no window title was recorded anywhere, in this file or in the ledger it comes
from.

Source: the controller's ledger for this execution, plus `tasks-1-5-review.md`,
`fix-round-1-report.md`, `fix-round-2-report.md`, `fix-round-2-review.md`, `fix-round-3-report.md`.

## Setup

| | |
|---|---|
| Application | the development bundle `Clave Agent Dev.app` in `~/Applications`, bundle id `dev.clave.agent.dev` |
| Bundle shape | the thin launcher of D10: it `require`s this checkout's `app/dist/main.cjs`; only the helper is copied inside; the executable keeps the name `Electron` |
| Size on disk | 288 MB (the plan's Step 2 warning said "about 600 MB") |
| Signature | the self-signed certificate "Clave Agent Dev" in the owner's login keychain, for the bundle and separately for `Contents/MacOS/clave-reader` |
| Launch | through LaunchServices with the development switches, `pnpm --dir app start:reader:scripted` — never from a terminal |
| Model | scripted (`CLAVE_SCRIPTED_MODEL=1`): the statements the owner sees are canned sentences, by design |
| Backend | the local stand-in; sub-project D does not exist |
| Machine | macOS 27.0, main display a 1x external display |
| First run | bundle created and launched 2026-09-18 13:49:58Z; helper pid 91688, a child of the bundle's Electron |
| Second run | 2026-09-19, app launched 10:32 local; helper pid 24730 for the whole session |

## What was observed

### Permission (first run, 2026-09-18)

The owner pressed the app's own Screen Recording button at onboarding step 4 of 7. macOS raised a
dialog — so `requestPermission()` **from an installed bundle does raise the system prompt**. This is
the retest of spec 10.1 item 3, which phase 0 could only answer *false* from a bundle in a temp
folder. The owner's screenshots give the wording:

> “Clave Agent Dev.app” would like to record this computer's screen and audio. Grant access to this
> application in Privacy & Security settings, located in System Settings.

with the buttons **Open System Settings** / **Deny**. The entry that appeared in System Settings →
Screen & System Audio Recording is named **"Clave Agent Dev.app"** — the .app file name, as phase 0
predicted. After the owner enabled it, macOS showed a second dialog:

> “Clave Agent Dev.app” may not be able to record the contents of your screen until it is quit.

with **Quit & Reopen** / **Later**. This time macOS *did* offer "Quit & Reopen"; phase 0's twin
bundle was not offered it. The owner chose **Later**.

An earlier message from the owner ("dialog appeared, named Clave Agent, no restart needed") was sent
while onboarding was still on step 1. Which dialog that was is not established — possibly the
keychain `safeStorage` prompt. It is recorded here only so that it is not mistaken for evidence.

**Defect D-A — a running helper does not see a fresh grant.** After the grant and "Later", the
owner's screenshot showed onboarding still on step 4, "Waiting for Screen Recording". (An earlier
report that step 4 "moved on by itself" was the owner's mistake and was corrected by the same
screenshot.) Hypothesis at the time: `CGPreflightScreenCaptureAccess` is cached per process, and our
helper never attempts a capture while denied — unlike the phase-0 probe, whose every check captured
and thereby refreshed the cache. The test, and the evidence:

- the controller killed helper pid 91688 at 14:03:19Z;
- `READER_HELPER_EXIT` was logged — the one and only appearance of that code in the run;
- the supervisor started a fresh helper, pid 92311, within seconds;
- onboarding moved to step 5 **at once**, on the owner's screenshot.

So the grant was in force the whole time; only the process that was running when it arrived kept
answering `denied`. Confirmed defect, fixed in round 2 (see below).

### The first read end to end (first run, 2026-09-18)

The owner: "done, a statement appeared in the review screen", with a screenshot. Log codes for the
whole session, counted with `grep -o '"code":"[A-Z_]*"' … | sort | uniq -c`:

| Code | Count |
|---|---|
| `SELF_TEST_PASSED` | 1 |
| `READER_HELPER_EXIT` | 1 (the controller's kill, above) |
| `CAPTURE_ON` | 1 |
| `CAPTURE_OFF` | 1 |
| `READER_PROBLEM`, `READER_HELPER_GAVE_UP`, `READER_HELPER_WEDGED`, `READER_HELPER_START_TIMEOUT`, `READER_PROTOCOL_MISMATCH` | 0 |

Helper facts: exactly one `clave-reader`, its parent the bundle's Electron process; RSS 28 MB; 17.5 s
of CPU time since 19:03:16 local. The capture duration was not recorded, so the helper's CPU share
per read is **not** computable from this — it is carried to C-2b. The statement the owner saw is the
scripted model's canned sentence, as designed.

### "It's not extracting anything" → `READER_PROBLEM` → the diagnostic → D-B

Later in the same session the owner reported that nothing was being extracted. The log had
`READER_PROBLEM` 1 and capture OFF; the helper had never exited and never wedged **during that episode** — the one `READER_HELPER_EXIT` of the session came later, from the controller's deliberate kill, and is recorded above.

The controller ran a diagnostic: a **temporary `dist/main.cjs` inside the granted bundle** that
recorded read outcomes, timings and text sizes only — never text, never a title. The bundle's `dist`
was rebuilt from the real sources afterwards. Over 36 reads:

| App | ok | black | failed (no front window) |
|---|---|---|---|
| VS Code | 15 | 1 | — |
| Safari (with `toolbarText`) | 8 | — | — |
| Linear | 2 | — | — |
| Wispr Flow | 2 | 2 | — |
| (no front window) | — | — | 6 |
| **Total** | **27** | **3** | **6** |

Timings of the `ok` reads, against the 1 500 ms budget: **54–573 ms**, median **230 ms**, max
**573 ms**. Focus events arrived from both sources. So the macOS layer itself worked on the first
try: capture by window id, greyscale, Vision, the Safari toolbar strip.

**Root cause D-B.** Whenever the frontmost app has no qualifying window at the moment of `read` — an
app switch in progress, an overlay or menubar app — the helper answered `failed`, and the capture
loop counts `failed` as the reader's own failure. Six of thirty-six reads landed there during
ordinary window switching; five such failures within ten minutes switch capture off through
`onReaderProblem`. Ordinary use therefore turned itself off.

Also seen, and **not** explained: `black` three times on real windows (Wispr Flow twice, VS Code
once). The loop does not count `black`, so it caused no harm here; the cause is not established and
is carried to C-2b.

**Owner's decision O4** (put to them as a question, 2026-09-18): add `windowGone` to the Reader
port's `ReadFailure`; the capture loop records it as its own outcome and does **not** count it as a
failure; the helper answers it when there is no front window at read time or the window vanished
between steps.

### The three fix rounds

| Round | What | How it was proven | Verdict |
|---|---|---|---|
| 1 (2026-09-18, before the first real read) | The seven findings of the Tasks 1–5 review: I-1 the homoglyph rule that rewrote genuine all-twin Cyrillic/Greek words beside Latin text was dropped; I-2 the core's `isBrowser` became a name-prefix match on a word boundary plus twelve more browsers (`isMeasuredBrowser` stays exact); I-3 both capture completion waits time out after 3 s; I-4 a new `focus_gate.rs` rate-limits title-only focus events to one per 5 s while id/pid changes pass at once; M-4 gutter stripping only inside a run of ≥3 left-edge numbers stepping by exactly 1; M-6 no blanket `Send`; M-7 `guard` inside both capture blocks | Every fix reverted on a backup copy and watched to fail. By finding, not in the order the fixes are listed above: I-1 5 failing tests; I-2 10 and then 5 (the prefix match, then the twelve new names); I-3 3, plus a reproduced hang (with `recv()` restored the suite never finished); I-4 4 and then 3; M-4 3. **M-6 has no failing test**: it is proven by a compile error — a probe sending a `*const u8` through `Sendable` fails with `E0277`, and the probe was then deleted. M-7 has no test either and says so: a panic inside an Objective-C completion block cannot be staged, and `guard` ends in `process::exit(70)`, which would take the harness with it | opus re-review **APPROVED** — all reverts reproduced, Chrome and Safari still read, payload = installed, MANIFEST 35/35 |
| 2 (2026-09-18, after the first real read) | D-B: `windowGone` added to the port and its zod enum, to the loop's `CycleOutcome` (explicitly not a fault), and to Rust as `FailReason::WindowGone` for "no front window" and for `CaptureError::Gone`. D-A: `CLIENT_DENIED_REFRESH_MS` 5 s plus `replaceCurrent()` — while the answer is `denied` and the helper is older than the interval, retire it (not a crash, no capture attempt, so no extra macOS prompt) and start a fresh one; the call still answers `denied`. Nine files; pre-edit copies kept | Five reverts by the fixer and a sixth by the reviewer: collapsing the zod enum back to four reasons makes the port row, the client row **and both** loop tests fail — i.e. the fix is load-bearing end to end, not a tautology | opus re-review: both defects **ADDRESSED**; the loop's privacy logic byte-identical to before; a revoked grant cannot hide behind `windowGone` — though by a different mechanism than that review gave: on revocation the preflight goes false, so the loop stops at `noWindow` and never reads, and the engine's 10 s permission poll switches capture off. One Important: while *truly* denied, the engine's 10 s tick would spawn a helper and a Vision warm-up every 10 s for ever. Five Minors |
| 3 (2026-09-18) | The round-2 review's Important 1 and Minors 1–3: the denied refresh backs off 5 s doubling to 60 s, resetting on any non-`denied` answer, on `requestPermission()` and on a new focus subscription; a `!gaveUp` guard so a `denied` answer cannot take the last working helper away; `dispose()` owns the helpers on their way out and `retire()` clears an old kill timer | Exact arithmetic pinned by test — spawns at 5, 15, 35, 75, 135, 195, 255 s, eight helpers in five minutes against 61 under the flat 5 s. The 61 is the unit test's rate (an asker every 5 s), not the app's: the engine's own tick is 10 s (`PIPELINE_TICK_MS`, `app/src/main/constants.ts:13`), which would give about 31. Reverts: dropping the doubling fails all four new tests; disabling the resets fails the three reset tests; dropping `!gaveUp` fails its test; `dispose` back to `[current, replacement]` fails both new dispose tests | sonnet re-review **clean**: reverts bite, the backoff arithmetic verified, three original C-1 probes still bite |

| 4 (2026-09-19, after the final whole-plan review) | **Critical C-1: the helper kept a window's recognised text after reading stopped.** `cache.rs`'s one entry was cleared only by `clear_unless(window_id)` inside a read, and that call sits after the lock check, the preflight check and `front_window()`. So when reading was switched off in the tray, when the screen locked, when the user walked away (`userAway` after five minutes) or when the app simply idled in the tray, the last window's full recognised text and toolbar strip stayed in the helper's heap until the process exited — in practice up to the planned restart at 6 hours, which the live log shows has never once fired. The app's own Privacy screen says *"Nothing older than an hour exists anywhere"* (`app/src/renderer/copy.ts:10`), and that sentence was not true. The fix: `worker.rs` waits for a job with `Condvar::wait_timeout` instead of for ever and empties the cache after `CACHE_IDLE_CLEAR` = 60 s with nothing asked; and every early return of `handle_read` that means "this window is not being read now" — locked, no grant, no front window, the window gone before the capture, the capture refused — now clears it too. Three files, platform-neutral, no protocol change and no new macOS call | Ten new tests. Three reverts, each watched to fail: leaving the cache alone on the idle timeout fails `a_worker_with_nothing_to_do_forgets_the_last_window`; removing the scheduler's clears fails all five of the new scheduler tests; clearing on **every** read instead (over-eager) fails `the_same_pixels_are_recognised_once_for_two_reads`, `the_cached_answer_carries_the_toolbar_strip_as_well` and `a_second_read_inside_the_idle_window_still_costs_nothing`, which is what pins the same-pixels shortcut against a careless fix | Native total **156 → 166**; TypeScript untouched at 914; zero warnings; handshake `ALL CHECKS PASSED` |

**Totals after the four rounds:** **166** native tests (133 as the payload was written, 155 after
round 1, 156 after round 2, 166 after round 4) and **914** TypeScript tests in **65 files**
(874 → 894 → 907 → 914; round 4 touched no TypeScript). Typecheck clean both configs, `build:native`
with zero compiler warnings, handshake `ALL CHECKS PASSED`, `SMOKE OK`.

### The second run (2026-09-19, after the three fix rounds)

The bundle was re-created from the rebuilt sources and relaunched. Results, in the order they were
taken:

- **Control, with free window switching** — two minutes of ordinary work across Safari/Chrome and an
  editor, which is exactly the pattern that produced `READER_PROBLEM` the day before: a statement
  appeared. Codes since launch at that point: `CAPTURE_ON` 2, `CAPTURE_OFF` 1, and **no `READER_*`
  code at all**. D-B is fixed in real use. Helper: 71 MB RSS, 6.14 s of CPU in about 4.5 minutes —
  roughly 2.3 % of one core, warm-up included.
- **The grant survives re-creating the bundle.** Re-created with the same bundle id and the same
  certificate, the owner saw **no new Screen Recording prompt** and reads worked at once.
- **An unlisted browser: not testable on this machine.** No browser other than Chrome and Safari is
  installed; the `~/Applications` "Brave/Edge/Helium Apps" folders are web-app shortcuts, not
  browsers. That the core refuses an unmeasured browser is covered by unit tests only.
- **Screen lock for about a minute, then unlock.** Totals since launch: `CAPTURE_ON` 3,
  `CAPTURE_OFF` 2 — one OFF/ON pair around the lock, i.e. the engine switches capture off on lock and
  on again on unlock. No `READER_*` code, the **same** helper alive throughout, and its CPU time
  rising again afterwards (0.51 s in 15 s, about 3.4 %): reading resumed.
- **Helper memory over time**, one process (pid 24730): 71 MB RSS after five minutes, **85 MB after three
  hours**. Growth to watch in C-2b; the planned restart after 500 reads or 6 hours bounds it. The first
  run's 28 MB belongs to a different process and a different build and is not a point on this curve.
- **Safari private window — consistent with the rule working, and no more than that.** On
  2026-09-18, with the pre-fix code, the review screen stayed empty for two minutes with a Safari
  private window in front and no problem code appeared. A control read in the **same** session was
  never completed — reading had been switched off by `READER_PROBLEM` around then — and the control
  of 2026-09-19 was a different session and a different code version. So this is consistent with the
  rule working, but it is **not** evidence that the helper delivered Safari's badge in `toolbarText`
  on the Rust greyscale path. An empty review screen has several other explanations, including a
  reader that read nothing at all. Carried to C-2b as item 29.
- **D-A was not re-tested in real use.** The grant was already in place when the app was relaunched,
  so the stale-`denied` path never arose. It is covered by the unit tests of round 2 and 3 and by the
  first run's measurement of the defect itself.

## What this run verified of the macOS layer

Everything in `app/native/reader/src/macos/` was compile-verified only until this run (the plan says
so in terms; spec 10.1 items 16 and 17 were explicitly not met by Tasks 1–5).

1. **Capture by window id, greyscale, Vision — on real windows.** 27 `ok` reads across four
   applications, 54–573 ms, median 230 ms, all inside the 1 500 ms budget. This is the first
   exercise of the production combination the Rust phase-0 probe never ran (it selected by
   application name and recognised the colour image).
2. **`toolbarText` for Safari** arrived on the Safari reads.
3. **Focus events work, from both sources** — the workspace activation observer and the 1 s poll
   (spec 10.1 item 17).
4. **Lock handling at the app level:** capture goes off on lock and on again on unlock, the helper
   survives, reading resumes, no problem code.
5. **Supervisor restart:** killing the helper produced `READER_HELPER_EXIT` and a fresh helper within
   seconds, with onboarding continuing immediately.
6. **`requestPermission()` from an installed bundle raises the system dialog** (spec 10.1 item 3,
   wording above), and the entry is listed under the .app file name — which also means the grant can
   be revoked, unlike phase 0's temp-folder bundle.
7. **The grant survives re-creating the bundle** with the same id and certificate.
8. **The dev bundle works as designed** (D10): the helper is found next to the executable and runs as
   a child of the bundle's Electron; the app runs from the checkout's `dist/main.cjs`.
9. **Memory and CPU of the helper.** Two different helper processes, not one growth curve: 28 MB at the
   first read is the **first run's** helper (2026-09-18, pre-fix-rounds-2-and-3 code), while 71 MB after
   five minutes and 85 MB after three hours are the **second run's** helper (2026-09-19, pid 24730). Only
   the 71 → 85 MB step is one process observed over time, and that is the figure item 12 carries forward.
   CPU: about 2.3 % of one core over 4.5 minutes of ordinary use.

## What it did **not** verify

1. **The refused path (−3801 → `Refused` → `failed` + flag) was never exercised.** No capture was
   refused in either session. Note what that path is **for**: a capture the system refuses while
   `CGPreflightScreenCaptureAccess` still says yes. It is not the revocation path — see below.
2. **Revocation was not exercised.** The grant was never switched off under a running helper in
   C-2a. (Phase 0's P6 measured it with a probe, not with this code.) And the mechanism is not the
   one earlier drafts of this record described: after a revocation the preflight goes **false**, so
   `front_window_of` (`input.rs:36`) answers null, the loop records `noWindow` (`loop.ts:90`) and
   **never calls `read` at all** — the −3801 → `Refused` → `failed` path is never reached. What
   protects the user is the engine's periodic permission poll: `refreshPermission()` runs on every
   tick (`app/src/main/engine.ts:451`, interval `PIPELINE_TICK_MS = 10_000`,
   `app/src/main/constants.ts:13`, used at `engine.ts:453`), sees `denied`, and switches capture off
   with `PERMISSION_LOST`. C-2b's revocation test must watch that poll, not the read path.
3. **2x / Retina displays.** Both sessions ran on a 1x external display, like all of phase 0.
4. **No accuracy number was measured in Rust-greyscale.** The reads produced text good enough for the
   scripted pipeline to make statements; nothing compared them against known text. The P4/P5 accuracy
   figures remain Swift-greyscale figures.
5. **No toolbar-band acceptance number.** Safari's strip was present; how often the band is right,
   and the private-window hit rate in Rust, are unmeasured.
6. **Cold start after a reboot.** D12's reading — that the ~45 s cold recognition belongs to the
   machine and not to the binary — was not re-tested after a reboot or a long idle.
7. **`black` on real windows.** Seen three times (Wispr Flow twice, VS Code once). Cause not
   established. The loop does not count it, so it is silent.
8. **D-A in real use after the fix** (see above).
9. **The helper's CPU share per read**, because the diagnostic did not record capture durations.
10. **An unlisted browser in real use** — not testable on this machine.
11. **The same-pixels cache** of spec 5.2 step 4: nothing measured whether successive captures of an
    unchanged window are pixel-identical often enough for it to hit.
12. **The helper's own `locked` answer.** The lock test exercised the engine's behaviour (capture off
    and on); no `read` was observed answering `locked`.

## Owner's observations about the app's UI (sub-project B)

These are about the app the reader was watched through, not about the reader. They belong to
sub-project B and are recorded so they are not lost.

1. **The clock icon of the review-time input is not visible** in the dark theme.
2. **The "What is never read" list shows a trailing `::`** on its entries.
3. **The scripted statement "has nothing to do with me."** Expected: with `CLAVE_SCRIPTED_MODEL=1`
   the statement is a canned sentence and has no relation to what was read. The app should say so, or
   the run should be explained to whoever sees it first.
4. **The only way to bring the window back is the tray icon.** The owner asked the controller to
   reopen the app rather than finding it themselves.

## Carried to plan C-2b

Everything deferred anywhere in the ledger, in the plan and in the five reviews, de-duplicated.
Items 1–7 come from the plan's own "Deferred to plan C-2b" paragraph, minus
`requestPermission()` from an installed bundle, which this run answered; that paragraph lists eight
things and removing one leaves seven. Item 8 comes from spec 10.2, not from that paragraph.

1. `reader:eval`: the staged-window run with **fixed, recorded window sizes** and each case read
   several times (five is the spec's suggestion), reporting minimum and median, including a narrow
   terminal (spec 10.1 item 15).
2. The **accuracy numbers in Rust-greyscale**, and the toolbar band acceptance numbers, re-measured
   on the production combination (spec 10.1 item 16's second half).
3. The **manual checklist** of spec section 7 (overlapping windows, the owner's real VS Code, a
   second display, a full-screen app, the locked screen, the grant revoked mid-run, the helper killed
   mid-read).
4. **Cold recognition cost after a reboot** and after a long idle (D12; spec 10.1 item 2).
5. **Onboarding copy** for the macOS 27 dialog's wording, for the entry being named after the .app
   file name, and — measured here — the sentence "After you allow it, the app has to restart once."
   is **wrong** for the normal path and must go.
6. The **four design inputs deferred from C-1's review**: register `HelperLink.onLine` synchronously
   after spawn; cap line length in `readerLink.ts` before buffering; retire a helper gracefully when
   calls are in flight on the automatic-restart path; reviving after a protocol mismatch respawns the
   same binary once per subscription.
7. **Measuring further browsers** — a band per bundle id; nothing may be borrowed from another
   browser.
8. **2x / Retina displays** for both the accuracy numbers and the band figures.
9. **Surface any long run of barren cycles** — `noWindow`, `windowGone`, `black`, `windowChanged`,
   `denied`/`notKept` — as a counter in the log and a gentle notice, never a failure.
   `CaptureLoop.stats()` is never called anywhere (`loop.ts:21,186`), so the tray says "Reading is
   on" while nothing whatever is read, indefinitely and invisibly. The cure is one rule written
   against *every* non-`kept` outcome rather than against two of them: a counter plus a one-off code
   (e.g. `READER_NOTHING_TO_READ`) when N consecutive cycles end without anything being kept and
   nothing has been ingested for M minutes. Scoped this way it closes **five of the eight silent
   states** the final review ranked — endless `noWindow`, `windowGone`, `black`, `windowChanged` and
   `denied`/`notKept` (items 10, 11, 31, 32, 33) — and it is the single highest-value item on this
   list. It is also what would make item 10 visible.
10. **Residual risk behind `windowGone`:** if macOS ever answered the shareable-content fetch with
    success and a list that silently omits the window while the preflight still said true, the app
    would sit with capture on, every read answering `windowGone`, nothing counted and nothing logged.
    Theoretical on the evidence (phase 0 measured −3801 *and* preflight false on revocation); the
    cure is item 9.
11. **`black` on real windows** (three times here): establish the cause, and decide whether it should
    be observable.
12. **Helper RSS growth**, 71 MB after five minutes to 85 MB after three hours: watch it, and confirm
    the planned restart (500 reads / 6 h) really bounds it.
13. **The helper's CPU share per read**, which needs capture durations recorded.
14. **D-A in real use after the fix:** grant Screen Recording while the app is already running and
    watch onboarding continue without the controller killing anything.
15. **The dev bundle should bake its development switches into its launcher** (`main.js`) instead of
    relying on `open --env`: macOS's own "Quit & Reopen" relaunches the bundle **without** them, which
    means `NO_READER_YET`.
16. **A numbered list at the left edge** ("1 Install / 2 Configure / 3 Run") loses its numerals to the
    gutter stripper, and `text.rs`'s comment says otherwise. Fix the comment, or the rule.
17. **Up to two reads per 5 s** for a window whose title changes every second, against spec 5.4's
    "at most once per 5 s". Reconcile the spec or add the loop-side minimum interval.
18. **Id ranges disagree across the protocol:** Rust accepts any `u64` and echoes it; TypeScript
    rejects anything beyond `Number.MAX_SAFE_INTEGER` and treats the line as unreadable. Unreachable
    in practice; neither document says so.
19. **`scheduler.rs`'s `handle_read` doc over-claims:** "`None` means say nothing at all" is only true
    up to the last checkpoint; a cancel landing after it still produces a line, which the client drops
    because it has already forgotten the id. Say "best effort; the client forgets the id".
20. **A read that runs past its budget during recognition is thrown away without being cached**, so a
    marginal window is re-recognised from scratch every cycle. Move the store above the final
    checkpoint (the answer must still be `timeout`).
21. **`normalise_homoglyphs` runs twice per line** (scheduler and `text::assemble`). Idempotent, so
    only wasted work, but `assemble`'s doc makes the scheduler's call look redundant when it is
    deliberate.
22. **The twelve new browser names were never checked against what macOS actually reports** as
    `kCGWindowOwnerName`, and `helium` also matches the Helium video player (as `chrome` prefix-matches
    "Chrome Remote Desktop"). Both are the safe direction — those apps are not read — but the cost is
    unmeasured.
23. **The task-4 brief's probe wording** ("skip the cancellation check between capture and
    recognition") reads as one check where there are three; the coverage is real, the wording is not.
24. **The two stand-in producers** `standins/devReader.ts` and `main/testing/fakeReader.ts` still
    answer `failed` for "no window" rather than `windowGone`. Unreachable through the loop; align them
    or record why not.
25. **The wire vocabulary grew without a `READER_PROTOCOL` bump.** Harmless while the binary ships
    inside the bundle (an older app collapses an unknown reason to `failed`), but it must be
    remembered if the helper is ever shipped separately.
26. **Whether the three resets of the denied-refresh backoff** (a non-`denied` answer,
    `requestPermission()`, a new focus subscription) really cover the moments a user is about to
    grant, is a judgement about onboarding that only a session with the owner settles. Granting after
    a long denied stretch can cost up to 60 s plus the asker's own poll.
27. **The same-pixels cache** of spec 5.2 step 4 is still unmeasured.
28. **A revocation against this code**, and the helper's own `locked` answer, neither of which this
    run exercised. **Test it against the permission poll, not the read path** — see the corrected revocation reasoning earlier in this record (after a revocation the preflight is false, `frontWindow` answers null, the loop records `noWindow` and never calls `read`; the engine's 10 s permission poll switches capture off) for why
    the read path is the wrong place to look.

Added by the final whole-plan review (2026-09-19). The first three are privacy-relevant and must be
measured before the reader ships.

29. **Observe a Safari private window being skipped.** The one thing that stops a Safari private
    window being kept is `after()` matching the badge inside `toolbarText`; Safari does not announce
    a private window in its title. That depends on the 41 pt band being right for that window *and*
    on Vision recognising a small glyph-plus-word badge, and both were measured in phase 0 in Swift,
    at 1x, with a default toolbar — never on the Rust greyscale path. What to do: with a Safari
    private window and a normal Safari window in the **same** session, see the private one skipped,
    the normal one kept, and `toolbarText` containing the badge (codes and lengths only, never the
    text). **This is the single most consequential unmeasured behaviour in the sub-project.**
30. **Non-default browser toolbars, on the two measured browsers.** A bookmarks bar, an extensions
    row, a side panel, a tab group strip or a theme pushes Chrome's content down; the 82 pt band then
    holds the wrong strip and the Incognito badge can fall **outside** it — in which case a private
    Chrome window is **kept**. This is a privacy failure mode, not a coverage gap, and item 2 is too
    vague to be read as covering it. Safari's compact and multi-tab layouts are the same family with
    the same consequence (spec 10.2: "the compact layout may shorten or hide the host").
31. **Endless `windowChanged`.** A window whose title changes faster than a read completes (~230 ms
    measured, up to 573 ms) — a terminal writing the running command, a player writing a timestamp, a
    chat app writing an unread count — is recognised and then thrown away every cycle, costing a full
    recognition every 5 s for nothing, unbounded and unlogged. `focus_gate.rs` rate-limits the
    *events*; the loop's own 5 s poll is not rate-limited. Closed by item 9.
32. **Endless core `denied`/`notKept`.** The core refuses every cycle (excluded app, unmeasured
    browser, private window, a user rule) and the result is indistinguishable from a broken reader —
    exactly what the owner saw during the two minutes of Safari private. Closed by item 9.
33. **Endless `noWindow` from a lock that `powerMonitor` did not report** (a screensaver, display
    sleep, fast user switching). `input.rs:36` answers `frontWindow: null` while locked, `loop.ts:90`
    returns `noWindow`, which is not counted, and the loop never calls `read` at all. Unbounded and
    invisible. Closed by item 9.
34. **Spec 10.1 item 13's sub-project-A half.** "Anything in A which string-matches recognised text
    must not assume ASCII" is **not** done: the whole defence sits in the helper's
    `normalise_homoglyphs`. `core/exclusions/sites.ts`, `rules.ts` and the guard all match against
    text one Rust function has already normalised, and nothing pins that invariant.
35. **The helper pausing its own focus poll while locked** is still unverified (spec 10.2). Item 28
    carries the helper's `locked` *answer*, not this.
36. **Chrome's toolbar band has never produced a real `toolbarText`.** Chrome does not appear in the
    diagnostic table at all: only Safari's 41 pt band has ever been exercised on real pixels. No
    document said otherwise; none said this either.
37. **`read` should carry the window main approved, and the helper should refuse to capture anything
    else.** Today main asks the core about the front window and the helper then resolves the front
    window **again, independently** (`scheduler.rs`). In the gap the user can switch to an excluded
    app — 1Password, a private Safari window, a user-excluded title — and the helper captures it,
    recognises it and sends the text to main, which discards it as `windowChanged`. Nothing is kept,
    and the design intends main to judge the window around the read, but the text of an explicitly
    excluded window does cross the pipe. Carrying the approved window id in the `read` op and having
    the helper answer `windowGone` when the front window is not that one closes it.
38. **The `recentApp` subscription** (`app.ts:215`) asks the reader for the front window on every
    focus event whether or not reading is on, and is never unsubscribed. Only the app *name* is
    retained, so it is not a leak — but it is why "reading is off" does not mean "the helper is
    idle", and it kept a helper alive next to the cache finding above.
39. **The denied-refresh baseline is a unit-test rate, not the app's.** "Eight helpers in five
    minutes against 61" assumes an asker every 5 s. The engine's own tick is **10 s**
    (`PIPELINE_TICK_MS`, `app/src/main/constants.ts:13`, used at `engine.ts:453`), which gives about
    31, not 61. Do not re-derive the wrong baseline.

40. **The focus gate keeps the last window's TITLE.** The cache fix removed every retained copy of recognised TEXT from the helper (final re-review, question 1(b): none survives). The window TITLE is another matter: `focus_gate.rs` holds the last seen (window id, title) for the life of the process so that it can tell a change from no change, and nothing clears it on lock, revocation or idleness. While the poll runs it is overwritten every second by the current front window's title; while the screen is locked the poll pauses and the last title stays for as long as the lock lasts. Decide in C-2b whether to keep only a hash of the title (enough to detect a change) instead of the title itself.

Carried to **packaging**, not to C-2b: repeating P1, P2 and P6 under a real Developer ID. Changing
the signing identity changes the designated requirement and is expected to reset the grant, which was
never measured.

## The running dev bundle is older than the last fix

The helper inside `~/Applications/Clave Agent Dev.app` was built on 2026-09-18 21:53 (local); the cache-retention fix
was made on 2026-09-19 14:07. Until `pnpm --dir app dev:bundle` is run again (with the app quit first), the
development app keeps the OLD behaviour: after reading is switched off, the last window's recognised text can
stay in that helper's memory until the helper is replaced or the app quits. Memory only, never disk. The
owner was told in chat on 2026-09-19.

### Update, 2026-09-19 15:28 (local): bundle refreshed

The bundle was re-created with the fixed helper and the app is stopped. How it went is worth keeping: the
controller asked the app to quit through AppleScript, the app (a tray app) ignored it, and the controller's
script replaced the bundle UNDER the running process — a mistake. The log's codes for that minute, in order:
`READER_HELPER_REPLACED`, `CAPTURE_OFF`, `PERMISSION_LOST`, `CAPTURE_ON`. Read with care (one event, codes
only): the running app lost its permission when its bundle changed underneath it and switched reading off,
and reading came back on by itself shortly after — consistent with the client replacing a denying helper with
a fresh one that then held the grant (the D-A fix), but not isolated as such. The app was then stopped with a
normal TERM signal. For C-2b: `dev:bundle` should refuse to run while the app is running.

## Leftovers on the machine from this run

`~/Applications/Clave Agent Dev.app` (about 290 MB, holding a live Screen Recording grant) and its
data folder `~/Library/Application Support/Clave Agent Dev/`. See `docs/HANDOFF.md` section 6 for how
to remove them.

## Status of the carried items after plan C-2b-1 (2026-09-19)

C-2b was split by the owner (decision O5) into C-2b-1 — code, run by agents, nothing that needs a
real screen — and C-2b-2, the measurements and the acceptance, with the owner present. C-2b-1 was
executed and reviewed on 2026-09-19: plan
`docs/superpowers/plans/2026-09-19-native-reader-c2b1-code.md`, its execution record at the end of
that file.

The rule used below is deliberately strict: an item is **closed** only where code and tests closed it
without a screen. Where C-2b-1 built the thing that will do the measuring, the item is "instrument
built" and the number is still owed. Nothing in this plan met a real window.

| # | Item | Status after C-2b-1 |
|---|---|---|
| 1 | `reader:eval` with fixed sizes and repeated reads | Instrument built, measurement carried to C-2b-2 (D10; five repetitions, minimum and median, narrow and wide terminal, a fresh staging per repetition) |
| 2 | Accuracy in Rust-greyscale, band acceptance numbers | Instrument built, measurement carried to C-2b-2 (the `accuracy` and `toolbar` modes) |
| 3 | The manual checklist of spec section 7 | Carried to C-2b-2 |
| 4 | Cold recognition cost after a reboot and a long idle | Carried to C-2b-2 |
| 5 | Onboarding copy for the dialog and the .app file name | Closed by C-2b-1 (Task 7, `src/renderer/copy.ts`): the step now leads with what the dialog says and what is true, names the entry after the .app file, mentions the + button, and the measured-wrong sentence "After you allow it, the app has to restart once." is gone with a test keeping it out. Two things stay open and are listed below: nobody has seen the surface rendered, and D16's dev-build file name |
| 6 | C-1's four deferred design inputs | Closed by C-2b-1 (D14, Task 5): the `HelperLink` contract and its 64-line pre-registration buffer, the line cap applied while reading, draining instead of killing on the cure and denied-refresh paths, and a permanent protocol mismatch |
| 7 | Measuring further browsers (a band per bundle id) | Carried to C-2b-2 — and no other browser is installed on this machine |
| 8 | 2x / Retina displays | Carried to C-2b-2 |
| 9 | Surface any long run of barren cycles | Closed by C-2b-1 (D6, Tasks 2 and 7): every outcome classified productive / barren / neutral by an exhaustive table, `READER_NOTHING_TO_READ` once per streak at 24 cycles AND 10 minutes, a tray label and a Home line, `CAPTURE_OFF` carrying the run's tallies. How it behaves over a real day is a new item below |
| 10 | Residual risk behind `windowGone` | Closed by C-2b-1: `windowGone` is a barren outcome, counted in the streak and in the run's tallies, so the state this item describes now surfaces |
| 11 | `black` on real windows: establish the cause | Carried to C-2b-2. `black` is now counted as barren, so an endless run of it is visible; the cause is still not established |
| 12 | Helper RSS growth, 71 MB to 85 MB | Carried to C-2b-2 |
| 13 | The helper's CPU share per read | Instrument built, measurement carried to C-2b-2 (D3: `stats.captureMs` and `stats.recogniseMs` on `ok` and `black` answers, read only by `reader:eval`) |
| 14 | D-A in real use after the fix | Carried to C-2b-2 (needs a grant arriving under a running app, so it needs the owner) |
| 15 | The dev bundle should bake its switches into its launcher | Closed by C-2b-1 (D9, Task 3): `scripts/dev-launcher.cjs` in the checkout, the bundle's `main.js` a one-line `require` of it, `CLAVE_SCRIPTED_MODEL` remembered through `app/.dev-launch.json`. That the real bundle survives macOS's own "Quit & Reopen" is carried below — it was proven in a dry-run bundle and by unit tests only |
| 16 | `1 Install / 2 Configure / 3 Run` loses its numerals | Closed by C-2b-1 (D7, Task 4): the comment was fixed rather than the rule, and both shapes are pinned by tests — the flush-left bare-number list loses its numerals, `1. Install` and `1) Install` keep every character |
| 17 | Up to two reads per 5 s for a ticking title | Closed by C-2b-1 as a decision (D4): no loop-side minimum interval, because one would delay reads after a real window switch; a dated note in spec 5.4 instead, and the cost now shows in the barren-cycle counter |
| 18 | Id ranges disagree across the protocol | Closed by C-2b-1 (D13, Task 4): the helper ignores an id or cancel target above 2^53 − 1 and reads such a `budgetMs` as 0; documented on both sides |
| 19 | `handle_read`'s doc over-claims about silence | Closed by C-2b-1 (Task 4): the doc now says silence is best effort and that the client forgets the id |
| 20 | A read past its budget is thrown away uncached | Closed by C-2b-1 (Task 4): the store moved above the last checkpoint; the answer is still `timeout`, and what enforces the retention rule is the cache clear on the post-recognition mismatch, which the comment and a test now say |
| 21 | `normalise_homoglyphs` runs twice per line | Closed by C-2b-1 (Task 4): both calls documented as deliberate, on both sides, with idempotence pinned |
| 22 | The twelve browser names were never checked against `kCGWindowOwnerName` | Carried to C-2b-2 |
| 23 | The task-4 brief's probe wording ("three checks") | Document-only — Task 10's fix in plan C-2a |
| 24 | The two stand-in producers answer `failed` for "no window" | Closed by C-2b-1 (Task 1): `standins/devReader.ts` and `main/testing/fakeReader.ts` both answer `windowGone`, for "no window" and for a mismatch against `expect` |
| 25 | The wire vocabulary grew without a `READER_PROTOCOL` bump | Closed by C-2b-1 (owner decision O7): the number is 2, and spec section 3's C-2a note is superseded by a dated note saying why |
| 26 | Whether the three denied-refresh resets cover the moments before a grant | Carried to C-2b-2 (a judgement about onboarding that only a session with the owner settles) |
| 27 | The same-pixels cache is unmeasured | Instrument built, measurement carried to C-2b-2 (D3's `stats.cacheHit`, and D10's extra immediate re-read per staging, which exists only to record it) |
| 28 | A revocation against this code, and the helper's own `locked` answer | Carried to C-2b-2 — and against the engine's permission poll, not the read path |
| 29 | Observe a Safari private window being skipped | Instrument built, measurement carried to C-2b-2 (`reader:eval observe`, which by D17 FAILS the run when a staged private window shows no marker, when a normal one is flagged private, or when nothing was read) |
| 30 | Non-default browser toolbars | Instrument built, measurement carried to C-2b-2 (D11's eval-only `lines` with pixel boxes and `stats.bandPx`, plus the `--variant bookmarks-bar` staging; the harness prints a badge below the band, and has never seen one) |
| 31 | Endless `windowChanged` | Closed by C-2b-1 (D6): barren, counted, and it raises the notice |
| 32 | Endless core `denied` / `notKept` | Closed by C-2b-1 (D6). `empty` was split out as its own outcome so that a video player or a blank terminal is not reported as a rule the user has to go and find |
| 33 | Endless `noWindow` from an unreported lock | Closed by C-2b-1 (D6) |
| 34 | Spec 10.1 item 13's sub-project-A half | Closed by C-2b-1 (D5, Task 6): the core repairs `text` and `toolbarText` at the top of `ingest`, never titles, with the same rule and the same 37-pair table as `text.rs`, pinned by one shared pure-ASCII fixture both languages assert |
| 35 | The helper pausing its own focus poll while locked | Carried to C-2b-2. The design half is closed (D12: the rule moved into `focus_gate.rs` and BOTH sources now go through it — the workspace notification was not gated at all), but the lines that wire it to the system are compile-verified only and no locked screen has been watched |
| 36 | Chrome's toolbar band has never produced a real `toolbarText` | Instrument built, measurement carried to C-2b-2 (40 Chrome stagings in `toolbar` mode) |
| 37 | `read` should carry the window main approved | Closed by C-2b-1 (owner decisions O6 and O7, D1, D2, Task 1): `expect` on the wire, refused before the capture and re-checked after the capture and after recognition, every mismatch clearing the cache. That it holds against real window titles is carried below |
| 38 | The `recentApp` subscription | Closed by C-2b-1 (D8, Task 2): kept, because Settings' "Exclude <app>" needs it, unsubscribed at teardown, and documented — reading being off does not mean the helper is idle |
| 39 | The denied-refresh baseline is a unit-test rate | Closed by C-2b-1 (Task 5): the one comment that cited "61 in five minutes" now says that 60 is a rate only the unit test reaches and that the engine's own 10 s tick gives about 31. The correction already stands in this record's fix-round-3 row |
| 40 | The focus gate keeps the last window's TITLE | Closed by C-2b-1 (D12, Task 4): a 64-bit hash of the title, never the title |

### New items opened by C-2b-1 for C-2b-2

1. **The grant, after the incident of 2026-09-19 ~20:03.** An agent's new test imported
   `scripts/dev-bundle.mjs`, which had no argv gate, and running the module re-created and re-signed
   the owner's real `~/Applications/Clave Agent Dev.app`. Nothing was launched, nothing was running
   from the bundle, no read was sent and the data folder was untouched; `codesign --verify --deep
   --strict` exited 0. The root cause is fixed and verified. The owner must still confirm that Screen
   Recording is granted to "Clave Agent Dev" before anything is launched, and re-run `dev:bundle` by
   hand (Task 9).
2. **Nobody has seen the two renderer surfaces rendered** — the rewritten permission step and the
   nothing-read line. Both are pinned by unit tests of the copy and the view model only.
3. **D16's open choice for the owner.** The permission step names the file as `${COPY.appName}.app`,
   so a DEV build says "Clave Agent.app" where System Settings lists "Clave Agent Dev.app". Curing it
   means one more field on `AppInfo`, which is a main-process change nobody made for a
   development-only difference.
4. **R-1: a gap in which no cycle ran counts as presence.** Only a `userAway` cycle takes time off
   the nothing-read clock. A machine that slept and is woken by a keypress reports idle 0, so the
   first cycle after an eight-hour sleep can raise the notice, dated before the sleep. Check in
   C-2b-2 whether the engine's suspend/resume handling stops the loop first, which would reset the
   clock.
5. **The re-entrancy hazard in `macos/focus.rs`.** `screen_is_locked` is now called inside
   `gate.borrow_mut()`. On one run loop the two sources cannot interleave, so it is sound today; if a
   CoreGraphics call ever pumped the run loop, the second entry is a `BorrowMutError` panic, which
   the helper's guard turns into `E_PANIC` and exit 70 — a counted helper exit. Watch that code's
   count in the first real run, together with the compile-verified-only lines (`focus.rs:47`, `:105`,
   `:136`, `:142`; `recognise.rs:108`).
6. **The 22 things only a screen decides about `reader:eval`**, listed in section 6 of
   `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/dev-reports/task8-dev-report.md`. In
   outline: whether Terminal honours the window-title escape sequence (if not, every terminal
   repetition is `notStaged` and nothing is read) and the resize sequence; whether Chrome honours
   `--window-size` and `--window-position`, and in an incognito window; the exact `app` and `title`
   strings the window server reports for these windows, which the guard compares strictly; whether
   `pkill` matches the eval's own profile in practice; `lines`, `bandPx` and `cacheHit` on real reads;
   the bundle path `CLAVE_DEV_ENTRY=reader-eval` end to end, including whether a window-less Electron
   app stays alive and whether the grant reaches the helper it spawns; and every timing in the
   harness, which is a reasoned guess. They fail loudly rather than produce wrong numbers.
7. **Deferred minors, carried whole.** `app.ts` has no test file at all, so the tray label and D8's
   unsubscribe were verified by reading (T2-F4). `retire()` clears the kill timer but not the healthy
   timer (T5-M2). The new line splitter does not split on a lone carriage return, which `readline`
   did — harmless, undocumented until now (T5-M3). A dev report's "not changed" list is wrong about
   `fakeReaderHelper.ts` (T5-M4). A line arriving while the 64-line pre-registration buffer is full
   and a flush is pending is dropped (unreachable in the product). A NUL survives the eval's `norm`,
   so the confusion-separator comment slightly overstates. `dist/reader-eval.cjs` is always built,
   which belongs to packaging. `cycleClass` and the public `should_observe` are dead weight. A
   symlinked or case-different spelling of `~/Applications` bypasses `dev:bundle`'s running-app
   guard, and an unrelated process holding that path in its command line makes it refuse — the safe
   direction, which the owner closes by closing that process.
8. **`app/reader-eval/out/` lives inside the repo**, on purpose (agents may not open the dev data
   folder). It holds results JSON and `observe-urls.json` only — the Chrome profile was moved to a
   per-run folder under the OS temp directory — but the "copy `app/` without `node_modules`, `dist`,
   `target`" recipes should exclude it, and this repo has no ignore file of any kind.
9. **Inherent, and unchanged by this plan:** an app does not update its window title and its pixels
   atomically, so a capture taken in the instant a browser has painted tab B while the window server
   still says title A passes all three comparisons. Main had the same limit before.
