# Final whole-plan review — C-2b-1 (2026-09-19)

Paths: `app/…` = /Users/sardorastanov/techcells/asset-to-evidence/app/… ; backup = `$S/exec/c2b1-backup/app`.
Everything below was read in the installed code (post fix round 1). Nothing under the repo was modified.
No helper was sent `read`/`frontWindow`, no bundle launched, no data folder opened.

## What I ran (private copy `$S/exec/final/app`)

| Check | Result |
|---|---|
| vitest, whole suite | 86 files; 1537 passed, 1 skipped (helper binary not built in the copy), **1 failed**: `src/main/engine.test.ts > prompts once at the review time…` — 5000 ms timeout |
| the same test on PRE-plan code (`$S/exec/final/pre/app` = copy + backup overlay, `cmp` confirmed) | fails identically (5020 ms), 3 of 3. Machine load average was **169** at the time. Not a regression of this plan (see M7) |
| `tsc --noEmit`, both configs | clean (exit 0, 0) |
| `build-native.mjs --test` | 231 passed, 0 failed |
| `install.py <repo> --verify` (read-only) | **INSTALLED 59 of 93** (see I1) |
| my own probe `finalprobe.lunch.test.ts` (written, run, deleted) | notice IS raised right after a locked lunch (see M1) |

## Answers

### 1. End to end — can text of a window the core did not approve for THAT call reach main, be cached or be logged?

I found no such path.

- Loop: `front` is parsed, judged (`loop.ts:182-185`), and the same object is sent as `expect` (`loop.ts:189`). Both after-checks are unchanged (`loop.ts:201-204`; `diff` against the backup shows only the `expect` argument and the comment). `parseFrontWindow` does not trim or normalise (`ports/reader.ts:61-66`), so what the helper said is byte-for-byte what it gets back — no "never equal again" trap, and `bundleId` absent stays absent (`readerClient.ts:302-306` → `protocol.rs:119-122`, `None == None`).
- Client: three named fields only (`readerClient.ts:302-306, 326-328`); `ToHelper` has no `lines` member (`protocol.ts:8`), so the app cannot ask for geometry. The file logs nothing; events are six fixed codes (`readerClient.ts:13-14`).
- Helper: `expect` is all-or-nothing (`protocol.rs:113-124`); `None` → `failed`, nothing captured (`scheduler.rs:299-302`). Compared before capture (`:312`), after capture with the window id (`:372`), after recognition with the window id (`:440`); every mismatch clears the cache.
- **Re-entry / whose `expect`:** `Jobs::submit` cancels the running job and REPLACES the queued one; each `Job` owns its `expect` (`worker.rs:59-66`), `turn` passes `job.expect` of the job it took (`worker.rs:154-163`). Pinned by `the_newest_reads_approved_window_is_the_one_used` (`worker.rs:381`). A cancelled read A that stored its text above the last checkpoint (`scheduler.rs:447, 477`) passed 8b for A's own `expect`; the next read B either expects the same window (legitimate hit, only if pixel-identical) or a different one, in which case `:312-314` (front ≠ expect → `clear`) or `:317` (`clear_unless`) empties it before anything is looked up. A `timeout` answer carries no text (`protocol.rs:200-205`).
- **Drained helper finishing a read:** it answers the read it was sent, with that read's `expect`; the client only settles ids still in THAT helper's `pending` (`readerClient.ts:231-236`). Main's after-check then goes to the NEW helper, which answers `null` while starting → `windowChanged` (conservative). Timing makes two live reads impossible in the product: the client's read deadline (1500+4000 ms, `constants.ts:19`) is shorter than the loop's (1500+5000 ms, `main/constants.ts:10-12`), so the old read is always settled (and a wedged helper killed) before the loop can issue another.
- **Planned replacement:** promoted only between calls (`readerClient.ts:192-200`); focus events of a non-current helper are ignored (`:211`).
- **`cancel`:** marks only a job with that id (`worker.rs:69-76`); ids come from one client-wide counter (`readerClient.ts:70`), so they cannot collide across helpers.
- **`lines`:** only a literal `true` (`protocol.rs:101`); only on an un-cached `ok` (`protocol.rs:182-198`, `scheduler.rs:448-462`); strings are the cleaned lines of `text`. zod strips it in main anyway (`ports/reader.ts:54-57`).
- **Cache hit:** reached only after 4b (`scheduler.rs:372-384`); the answer carries the CURRENT `window`, the text is a function of the identical pixels.
- **Cache key vs `expect` (same id, title A → B → A):** safe. While B is in front and excluded, main sends no read; a stale `expect: A` is refused and clears (`:312-314`); back on A with identical pixels the hit returns A's own text. A title is never part of the key and does not need to be: text depends on pixels only, and every answer is gated on the title by 4b immediately before the lookup.
- Residual, inherent and unchanged by this plan (for C-2b-2 to keep in mind, not a finding): title and pixels are not updated atomically by an app. A capture taken in the instant a browser has painted tab B while the window server still says title A passes all three comparisons. Main had the same limit before.

### 2. Retention

Helper, between reads:
- The cache entry (text + toolbar strip of ONE window): until a different/unapproved window is seen, any refusal, or 60 s with no `read` (`worker.rs:129, 143-146`). While the same unmoved window keeps being read every 5 s the entry is kept and re-served — it is always the text currently on screen, so not in tension with "Nothing older than an hour".
- **Job slots / the approved TITLE:** `slots.running` holds a clone of the job (title included) only while it runs; `finished()` sets it to `None` (`worker.rs:102-105`), the local `job` drops at the end of `turn`. `queued` is either taken at once or replaced. So an `expect` title lives for the duration of its read (≤ budget, or until Vision returns) and no longer. A finished job keeps nothing. No tension with the C-2a fix. (The input thread's `line: String` is dropped per iteration, `input.rs:46-50`.)
- Focus gate: `pid`, `window_id`, a 64-bit title hash, one owed hash, one `Instant` (`focus_gate.rs:44-49, 85-91`) — for the life of the process, across a lock. No `String`. The hash is unsalted/deterministic (`focus_gate.rs:64-68`), so a memory dump allows guess-testing a title; negligible, and D12 accepted a hash.
- `refused` flag, frontmost pid snapshot. Nothing else.

Main:
- Client `pending`: `{op, timer, settle}` per call — no text, no title (`readerClient.ts:30`); the `ask` closure holds `expect` until the promise settles or its deadline fires.
- Loop: `front`/`result` are locals of one cycle; long-lived state is numbers only (`loop.ts:89-104`).
- `recentApp`: one app NAME, until the next foreign app comes forward, for the life of the app (`app.ts:226-227`); unsubscribed at teardown (`:228`). D8, accepted.

### 3. Seams (files read whole)

- `loop.ts`: coherent; no dead variable. Only `cycleClass` (`:49`) is test-only. One behaviour/comment mismatch → M1.
- `scheduler.rs`: comments S-a/S-b in M4. The store-order comment (`:431-439`) is now honest.
- `readerClient.ts`: coherent after the fix round; both spawn doors (`start` `:268`, `maybePlanReplacement` `:279`) are shut by `gaveUp`/`mismatched`. T5-M1/M2 still open (deferred).
- Engine × loop seam → **I2**.
- `focus.rs:136` keeps a pre-check with the now-public `should_observe` and `front_window_of` asks `locked` a third time (`input.rs:36`): three lock calls per tick, harmless, the gate is still the one nothing bypasses.

### 4. Everything new that reaches disk

| What | Where | Can it carry a title / screen-chosen app name / text / user path? |
|---|---|---|
| `READER_NOTHING_TO_READ` + counts; `CAPTURE_OFF` + `blockers` + per-run outcome tallies | `app.log` | No. Code and keys are checked against closed sets at runtime, values must be finite numbers (`log.ts:51-57`); keys are the 14 outcome names (`log.ts:26-30`), compile-time tied to `CycleOutcome` (`engine.ts:64`) |
| `app/.dev-launch.json` | repo | `{}` or `{"CLAVE_SCRIPTED_MODEL":"1"}` only (`start-reader.mjs:32`) |
| `app/reader-eval/out/<mode>-<nonce>.json`, `observe-urls.json` | repo | Numbers, booleans, fixed case/app names from the case table (`results.ts:108-111`), localhost URLs with the nonce. No path, no foreign title (Task 8 sentinel test + re-review) |
| `out/*.command` | repo | The harness's own title and the repo's truth text (`stage.ts:171-183`). No user path |
| `out/chrome-profile/` | repo | Written by Chrome itself. Not screen data, but Chrome's own files typically hold absolute paths containing the macOS user name (default download directory etc.) and machine-specific state → M5 |
| generated bundle `main.js` | `~/Applications/…` | The checkout's absolute path (user name). Outside the repo; by D9 |

Location: `app/reader-eval/out/` is inside the repo on purpose (agents may not open the dev data folder, so results must live where they can be read). Consequences in M5.

### 5. The nothing-read notice vs "a gentle notice, never a failure"

- It cannot switch capture off or block: `blockers()` is untouched (diff), the callback only sets a field, logs and emits (`engine.ts:232-242`); the tray GLYPH is unchanged (`trayState.ts:33-36`), only the first menu label and one Home line change; no OS notification is raised anywhere.
- It cannot nag: once per streak (`loop.ts:133`); a new raise needs a productive cycle in between and then again 24 cycles AND 10 minutes. Retracted on every `stop()` path (`loop.ts:307`) and guarded against a late raise (`engine.ts:237`).
- One wart: it can appear for a moment right after a locked lunch — M1.
- `empty`: every consumer is exhaustive by type — `CYCLE_CLASS` (`loop.ts:37-42`), `LOG_COUNT_KEYS` (`log.ts:29`), `nothingReadWhy` puts it in the remainder group `other` (`engine.ts:75-78`). Nothing else switches on `CycleOutcome`.
- Per-run `stats()`: exactly one production consumer (`engine.ts:320`), which reads it AFTER `stop()` — safe because the reset is in `start()` (`loop.ts:279`). But three other stop paths never write it → I2.

### 6. Protocol 2 agreement

| Speaker | number | `expect` | `stats` keys | `lines` | id bound |
|---|---|---|---|---|---|
| client (`constants.ts:15`, `readerClient.ts:302-328`) | 2 | 3 named fields | stripped by zod | cannot send | `isSafeInteger`, ≥ 0 (`protocol.ts:67,70`) |
| helper (`protocol.rs:29, 113-124, 237-258, 217-225, 134-141`) | 2 | all-or-nothing | `bandPx captureMs recogniseMs cacheHit width height` | `text topPx bottomPx leftPx rightPx` | ≤ 2^53−1 |
| `fakeReaderHelper.ts:59` | `READER_PROTOCOL` | `lastRead()` typed | — | — | — |
| `fakeHelperProcess.mjs:12,18-19,35` | 2 | app+title, `bundleId === undefined` | `captureMs`, `cacheHit` | — | — |
| `handshake_check.py:95,120` | 2 | (never sends `read`) | — | — | — |
| `readerEval` (`main.ts:144`, `helper.ts:53-54`, `run.ts:110-139`) | `READER_PROTOCOL` | the approved window | same six keys (`width/height` renamed `widthPx/heightPx` only in results) | same five keys | via `parseLine` |

No functional drift. Three documentation drifts → M3.

### 7. Deferred minors

Must be fixed before this plan is called done: **none** of the deferred ones. (What must be done is I1, and I recommend I2.)

Cheap enough to do with I2 rather than carry: T5-M5 (`readerLink.ts:116`: `child.stdout` has no `error` listener — an `error` event there is an uncaught exception in Electron main; stdin has one at `:90`), T5-M1 (make `drain` idempotent).

C-2b-2, first session:
- T4 deferred: `screen_is_locked` runs inside `gate.borrow_mut()` (`focus.rs:71`, `focus_gate.rs:121`). If a CoreGraphics call ever re-enters the run loop and the notification block fires, that is a `BorrowMutError` panic → `guard` → `E_PANIC`, exit 70 (`runtime.rs:47-51`) → counted `READER_HELPER_EXIT`; five in ten minutes switches capture off. Watch that code's count in the first real run, together with the compile-verified-only lines.
- T2-F4 (`app.ts` untested: tray label, D8 unsubscribe), "nobody has seen either surface rendered", D16's open choice.
- M1 below, because only a real lunch shows how many barren cycles surround a lock.
- M7 (flaky `engine.test.ts` timeout).
- T8: NUL survives `norm`; Minor 7 → packaging. T5 full-buffer drop: unreachable, leave.

### 8. Claims the code does not bear out

1. **"1430 passed in 84 files … 224 passed"** (Global Constraints last bullet, Task 0 Step 4, Verification record) — true of the payload as installed, no longer of the code: 1539 tests / 86 files and 231 native after fix round 1. Task 10 Step 6 repeats "the six results of the Global Constraints' last bullet" and will not match as written. → I1.
2. **"then `files/` and both manifests are regenerated from `app/` so the payload still equals the code"** (Tasks 1–8, item 4) — not done yet: `install.py --verify` → 59 of 93; files created by the fix round (e.g. `src/readerEval/bytes.test.ts`) are in no manifest. → I1.
3. **D13 "the bound is documented on both sides"** — only `protocol.rs:126-141` documents it; nothing under `src/main/reader/` mentions 2^53 or `MAX_SAFE_INTEGER` (the check at `protocol.ts:67,70` is code without the sentence). → M3.
4. **Self-review "Coverage of the carried list"** omits the record's own line 411: "For C-2b: `dev:bundle` should refuse to run while the app is running." `dev-bundle.mjs` has no such guard (grep: no `pgrep`, no running check). Task 9 Step 1 covers it by hand. → M2.
5. Ledger line 90 (feeds Task 10): "`notKept` now = exclusions-after + scrubFailed only" is not what the code does — `ingest`'s own `gate` reasons (`captureOff`, `locked`, `excludedApp`, …, `core/index.ts:153-154`) also end as `notKept` (`loop.ts:216`). Do not copy that sentence into the spec.
6. D6 in the plan lists the barren outcomes without `empty` and says `CAPTURE_OFF` carries `stats()` without saying "per run" — both were changed by accepted fix-round rulings (ledger line 78); the plan needs a dated addendum, nothing more.

## Findings

### Critical
None.

### Important

**I1 — The payload no longer equals the code, and the plan's pinned totals are stale.**
`python3 -B …/install.py <repo> --verify` → `INSTALLED 59 of 93`, 34 `NOT INSTALLED`; fix-round-created files are in neither manifest. Plan lines 27, 84, 94, 173, 180.
Fix (documents stage, before "done"; does not block Task 9, which builds from `app/`): regenerate `files/`, `MANIFEST.sha256` (and add the new files with `ABSENT` in `PRE-MANIFEST`), re-run `--verify` → all; add a dated note to the plan giving the post-fix totals (1539/86, 231) so Task 10 Step 6 has the right numbers to compare with.

**I2 — The per-run tallies are lost on the commonest way a run ends.**
`CAPTURE_OFF {…loop.stats()}` is written only at `engine.ts:320`. `quit()` (`engine.ts:750`), `startFreshFor` (`:536`) and `deleteAllData` (`:716`) call `loop.stop()` and write nothing; the next `start()` wipes the tallies (`loop.ts:279`). The fix round made `stats()` per-run precisely because "C-2b-2 reads these lines per run" (ledger line 78) — but every dev session ends with tray → Quit (Task 9 Step 1 itself), so a session that is never switched off by hand leaves no tally at all, and "a run that read nothing for hours leaves no trace" (the comment at `engine.ts:315-319`) stays true for it.
Probe: by reading; or in `engine.nothingRead.test.ts` style: capture on, a few cycles, `await engine.quit()`, grep the fake fs log for `CAPTURE_OFF` → absent.
Fix: one helper `stopLoop()` that does `if (loop.running()) { loop.stop(); log CAPTURE_OFF with stats }`, used at all four sites; in `quit()` AWAIT the log write (it is already async and awaits `savePool`). Numbers and closed keys only, so no privacy cost. If not now, it is the first item of C-2b-2's first session, before any measurement is read off `app.log`.

### Minor

**M1 — The notice can flash right after a locked lunch; the test comment says it cannot.**
`userAway` is neutral for the COUNT but the CLOCK keeps running (`loop.ts:128-135`). A locked screen yields `noWindow` (barren) for the first five minutes (5 s polls for 60 s, then 30 s polls): ~19-20 cycles. After the away stretch, a handful of barren cycles on return satisfies both conditions at once, with `since` = before the lock. My probe (productive 5 min → lock → 30 min away → return with nothing qualifying in front): 19 barren before away, notice raised within the first 30 s after return, `since` before the lock. With an instant unlock it needs ~4 more barren cycles from elsewhere (30 s in an excluded app before locking is enough). Self-clearing on the first productive read, so still "gentle" — but it writes one `READER_NOTHING_TO_READ` per such lunch, which C-2b-2 must not read as a defect, and `loop.test.ts:532` ("Walking away for lunch must never raise this") over-claims.
Fix: on a `userAway` cycle move the clock with it (e.g. remember when away began and add the away span to `lastProductiveAt` on return), or end the streak silently on the first `userAway`. One test: the probe above, inverted.

**M2 — `dev:bundle` still replaces a bundle under a running app.** Record line 411 asked C-2b for a refusal; `scripts/dev-bundle.mjs` has none. Task 9 Step 1's `pgrep` is the only guard, on the exact step where the mistake was made before (result then: `PERMISSION_LOST`). Fix: when no `--out` is given, `pgrep -f "Clave Agent Dev.app/Contents/MacOS"` and exit non-zero with a fixed message. Worth doing before Task 9.

**M3 — Protocol documentation drift (no functional effect).** (a) D13's TS-side sentence is missing (`src/main/reader/protocol.ts` near `:67-70`). (b) `protocol.rs:8-10` says protocol 2 added `windowGone`; spec §3's C-2a note says it was added under protocol 1. (c) `protocol.rs:133` "counts its ids up from one" vs `readerClient.ts:70` `nextId = 0` (and D13 "from 0").

**M4 — `scheduler.rs` comments vs code.** S-a: `:280-283` promises a clear "at every early return below that means the same thing", and the fix round applied that to `CaptureError::Other` (`:349-352`), yet `Black` (`:358-360`) and a recogniser error (`:390-392`) return without clearing. Not a leak (the surviving entry is the same, approved window's own earlier text; the 60 s idle rule still applies) — either clear there too or narrow the sentence. S-b: the doc on `is_approved` (`:208-213`) describes "both halves" but the function compares three fields; the window-id half lives in `still_in_front` (`:220-222`). Move the paragraph.

**M5 — `app/reader-eval/out/` inside the repo.** Results are clean, but `out/chrome-profile/` is written by Chrome and will hold user-name paths and machine state; there is no ignore file of any kind in the repo (no git yet), and both the plan's and the ledger's "copy `app/` without node_modules, dist, target" recipes will start carrying `out/` (profile included) into scratch folders and payloads once it exists. Fix: put the Chrome profile under `os.tmpdir()` (or delete it in teardown) and keep only the JSON in `out/`; add `reader-eval/out` and `.dev-launch.json` to the copy recipes' exclusions and to HANDOFF's leftovers (Task 10 Step 5 already plans the latter).

**M6 — Small dead weight.** `cycleClass` (`loop.ts:49`) has no production caller; `focus_gate::should_observe` is public only for the duplicate pre-check at `focus.rs:136`.

**M7 — `engine.test.ts` "prompts once at the review time" is load-sensitive, independent of this plan.** 24 fake hours of 5 s polls against a 5 s wall-clock timeout; failed 1 of 1 in the whole suite and 4 of 4 alone under load average 169, and identically on the pre-plan code. It will turn Task 10 Step 6 red for the wrong reason on a busy machine. Fix: a per-test timeout (third argument) — not a change of behaviour.

## Verdict

**Ready to document and hand to the owner for Task 9? — Yes, with fixes.**
No privacy defect found across the seams; the approved-window contract holds end to end, nothing new retains a title or text, and nothing new on disk can carry one. Before "done": I1 (regenerate the payload, correct the totals). Recommended before Task 9 because each is a few lines: I2 (tallies on quit), M2 (bundle guard). Everything else is C-2b-2's opening list or Task 10 wording.
