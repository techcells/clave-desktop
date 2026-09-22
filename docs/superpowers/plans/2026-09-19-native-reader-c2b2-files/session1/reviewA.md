# Review A — `failed` gains a closed-set DETAIL code, end to end

Independent review. Topic: everything in `$S/s1/repair.diff` **except** `src/readerEval/**` and
`scripts/reader-eval.*` (17 files: 5 Rust, 12 TypeScript).

Review copy: `$S/s1/rvA/app`, verified byte-identical to `$R/app` at the start (`diff -rq`, no output)
and again at the end (only my own added probe file differs — see "Artifacts"). `$R` was never written to.

Baseline re-measured on the review copy, not taken from the report:

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0, clean |
| `vitest src/main src/standins src/shell src/shared` | 38 files, **578 passed, 1 skipped** (report says 579 pass; the extra one is skipped) |
| `build-native.mjs --test` | **245 passed, 0 failed**, exit 0 (report: 245) |
| my own 9 probes | all pass |

---

## 1. PRIVACY — can anything but a closed-set member reach the log, an event, IPC or the renderer?

**No.** Probed directly in `$S/s1/rvA/app/src/main/ports/reviewA.test.ts` (9 tests, all pass):

| Fed to `parseReadResult` | Result |
|---|---|
| `detail` = a 76-char sentence with a name, an email and a password | dropped → `{ok:false, reason:"failed"}` |
| `detail` = `{noGrant:1}`, `{toString:"noGrant"}`, `["noGrant"]`, `{valueOf:1}`, `{0:"n"}` | dropped |
| `detail` = `"__proto__"`, `"constructor"`, `"toString"`, `"hasOwnProperty"` | dropped (a `Set`, not an object index — no prototype hole) |
| known `detail` = `"noGrant"` on `locked` / `black` / `timeout` / `windowGone` | dropped, reason survives alone |
| known `detail` + extra keys (`stats` with a string `note`, `window`, `text`, `extra`) | `Object.keys` is exactly `["detail","ok","reason"]`; the sentence is absent from `JSON.stringify` |
| `stats` holding strings on a **failed** answer | **stripped entirely** — `{ok:false, reason:"failed"}` |
| `stats` holding strings on an **ok** answer | stripped, as before |
| junk `detail` beside `black` (object, number, null, array, bool, unknown word) | still parses as `black`, never collapses to `failed` |

The last row is the one the `z.unknown()` choice exists for, and it holds: `readShape`'s failure arm
(`ports/reader.ts:94`) parses `detail` loosely, `parseReadResult` (`:127`) admits it only when
*reason is `failed` **and** value is a string **and** `DETAIL_SET.has(...)`*, and the return is a
**rebuilt literal** (`:129-130`) — zod's strip plus an explicit object, so nothing that travelled
beside it survives. `stats` is not in the schema at all and cannot reach main; `reader:eval` reads
the raw line, which is unchanged in that respect.

`detail` never leaves the loop as a string. Every non-test use in `src/main`, `src/shell`,
`src/shared` is: `readerClient.ts:430,448` (writes `"helperDown"`), `loop.ts:307` (maps it to a key),
`ports/reader.ts:94,127,128`. Nothing puts it in an event, IPC payload or renderer prop.

**Log keys:** all 13 new keys are written-out literals in `LOG_COUNT_KEYS` (`log.ts:44-46`), and
`log.event` re-checks `COUNT_KEY_SET.has(key) && typeof value === "number" && Number.isFinite(value)`
(`log.ts:72`). My probe asserts every `FAILED_DETAIL_KEY` value and all five loop-only keys are
members. Even the pathological case is closed: if a non-member ever reached `tally()`, `log.event`
drops the key. `engine.ts:270` writes `{blockers, ...loop.stats()}` and `stats()` returns a copy
(`loop.ts:438`).

Mutation M1 (below) confirms the closed set is load-bearing rather than decorative: without it, the
leak test writes `Priya Raman — recovery codes at acme.io` into `app.log` as a count key.

---

## 2. Is every Rust `Failed` forced to name a detail? Is each detail the TRUE cause?

**Forced, in practice — but by convention inside one function, not by the type system.**
`ReadAnswer::Fail(FailReason::Failed)` is constructed in non-test code at exactly **one** place,
`scheduler.rs:335`, which is the body of the `failed!` macro. Grep over all 19 crate files: every
other occurrence is a test assertion or a `match`/doc reference. So no path bypasses it today.
It is not structurally impossible, though: `ReadAnswer` and `FailReason` are both `pub`, and the
macro is local to `handle_read`, so a new module could build `Fail(Failed)` with no detail and no
compiler complaint. Acceptable — the surface is one crate and one function — but the report's
phrasing "does not compile" is true only *within* `handle_read`.

**Walk of `handle_read` (`scheduler.rs:319-575`) and `macos/capture.rs`:**

| OS situation | capture.rs | CaptureError | scheduler arm | detail |
|---|---|---|---|---|
| Completion handler never fired, or block dropped unrun (`recv_timeout` `Timeout`/`Disconnected`) | `:126` `wait_for` | `Timeout` | `:433` | `captureTimeout` ✓ |
| Framework reported an error that is not −3801 | `:178` `classify` | `Other` | `:441` | `captureError` ✓ |
| Completion carried a null image **and** a null error | `:172` `classify` | `NoImage` | `:437` | `captureNoImage` ✓ for the screenshot path, **wrong step for the content path** — see I1 |
| `frame_of` refuses the image's geometry / provider / buffer size | `:68` | `NoImage` | `:437` | `captureNoImage` ✓ |
| `SCStreamErrorDomain` −3801 (`UserDeclined`) | `:175-176` | `Refused` | `:412` | `captureRefused` ✓ |
| Window id not in the shareable content | `:42` `find_window` | `Gone` | `:418` | — answers **`windowGone`**, not `failed` ✓ |

- **−3801 → `Refused` is unchanged**, and the arm still does `refused.store(true, Ordering::SeqCst)`
  before clearing and failing (`scheduler.rs:410-414`). Pinned by
  `a_refused_capture_sets_the_flag_and_fails`.
- **"window not in shareable content" still answers `windowGone`**, not `failed`: `capture.rs:42`
  and the `Err(CaptureError::Gone)` arm are byte-identical to pre-repair.

**Cache clearing after the `Other` split.** I extracted the code-only lines of `handle_read` from
`$S/s1/pre-repair` and the current tree and diffed them: the *only* differences are the new
parameter, the macro, the six `return …Failed` → `failed!(…)` rewrites, and the two new match arms.
Every pre-existing early return keeps its `cache.clear()`, both new arms have one, and the two
deliberate non-clearing returns (black at step 4, recogniser error at step 6) are untouched —
matching spec 5.2 "Which returns clear the cache". **Behaviour is correct; the regression guard is
not — see I2.**

---

## 3. The approved-window contract, and the nine parameters

**Untouched.** The code-only diff of `handle_read` shows none of these lines moved:

1. `is_approved(&window, expect)` before the capture (`:390`) → `cache.clear()` + `windowGone`.
2. `still_in_front(...)` at 4b, after capture + black check, before cache lookup and recognition
   (`:460`) → `drop(captured)` + `cache.clear()` + `windowGone`.
3. `still_in_front(...)` at 8b, after recognition, before store and answer (`:535`) →
   `cache.clear()` + `windowGone`.

Order relative to capture / recognition / store is unchanged, and the mismatch→clear+windowGone
behaviour is unchanged on all three.

**Call sites.** All 15 `handle_read(...)` calls enumerated by script (1 production, 14 test). Every
one passes `refused` in position 3 and `cancel` in position 5 — the only genuinely same-typed pair
(`&AtomicBool`, pre-existing). The new `detail: &mut Option<FailDetail>` cannot be swapped with
`stats: &mut ReadStats` or `geometry: Option<&mut ReadGeometry>` without a type error. The one
production call, `worker.rs:157-167`, is correct and threads `detail` into
`protocol::read_line(job.id, &answer, &stats, geometry.as_ref(), detail)` at `worker.rs:169` — the
only `read_line` call in the crate.

---

## 4. The ordering fix

- **Exactly N tallied at the moment the problem is raised.** `trigger` (`loop.ts:353-359`) does
  `tally(outcome); if (key) tally(key); if (isFault(outcome)) noteFailure(); noteOutcome(outcome);`.
  `noteFailure` (`:243-246`) is the only caller of `deps.onReaderProblem()`, so the current cycle is
  always in `stats` before the callback runs. Confirmed by re-running M2 (restores the old order):
  three tests fail, including `atProblem.failed` = 4 ≠ 5.
- **`isFault` covers exactly the pre-repair `noteFailure` set.** Pre-repair called it in two places:
  the `!result.ok && (failed|timeout)` branch and the catch after the `stopped` guard. Post-repair it
  is called for `outcome === "failed" || outcome === "timeout"`, and those are the only two outcomes
  reachable from those two places. A `stopped` cycle still never calls it.
- **`stats()` still per run:** `stats = {}` in `start()` (`:406`), `stats: () => ({...stats})`
  (`:438`), both unchanged. Test `clears the stage tallies when a fresh run starts`.
- **`onReaderProblem` still raised once:** `noteFailure` empties `failures` when it raises; test
  asserts `toHaveBeenCalledTimes(1)`.
- **No double tally.** `cycle` returns exactly one `CycleReport`; `tally(outcome)` runs once and
  `tally(key)` at most once, and the key space (`FailureTallyKey`) is disjoint from the outcome space
  (`"failed"` and `"timeout"` themselves are never `key` values). A cycle that both fails and is
  stopped returns `plain("stopped")` and is tallied once, as before.
- **Privacy logic byte-identical.** Normalised diff of the `cycle` body (comments stripped, `calling
  = …` lines removed, `plain(x)` unwrapped) against pre-repair shows **only** the signature, the
  `calling` declaration, the `!result.ok` rewrite and the catch rewrite. `mayCapture` still runs
  before the read, both after-checks are in place and in order, `expect: front` is unchanged.

---

## 5. Attribution of a rejection / timeout, per call

`calling` is set immediately before each awaited reader call and cleared immediately after
(`loop.ts:289/291`, `:300/303`, `:317/319`).

| Where it breaks | rejection | timeout |
|---|---|---|
| FIRST `frontWindow()` | `failedFrontWindow` ✓ | `timeoutFrontWindow` ✓ |
| `read()` | `failedReadCall` ✓ | `timeoutRead` ✓ |
| SECOND (after-read) `frontWindow()` | `failedFrontWindow` — by **D3**, deliberately shared | `timeoutFrontWindow` — same |
| `mayCapture` / `ingest` / anything else | `failedUnknown` ✓ (D5) | n/a |

All four are pinned by tests, and M7 (never set `calling = "read"`) fails both naming tests. D3 is a
stated decision, not a defect; `calling` already distinguishes the position, so splitting later is
cheap. One gap in the guard for the "somewhere else" case — see m2.

---

## 6. `macos/capture.rs` — the compile-verified-only lines

Read against the ScreenCaptureKit calls:

- **`:66-68`** — `screenshot()` returned `Ok`, so the framework reported no error; `frame_of` then
  refuses because width/height/bpp is 0, bpp is not a multiple of 8, the data provider or its data is
  null, or the buffer is shorter than the claimed geometry (`:187-205`). "An image we cannot read
  pixels from" is exactly right, and `NoImage` rather than `Other` is the honest word.
- **`:113-121`** — the rewritten `wait_for` doc. Correct: `recv_timeout` returns `Timeout` (nothing
  arrived) or `Disconnected` (block dropped unrun), and both mean "the completion handler never
  answered". Folding `Disconnected` into `Timeout` is D2's stated cost.
- **`:126`** — `unwrap_or(Err(CaptureError::Timeout))`. Correct, and it is the one mapping both
  `shareable_content()` (`:111`) and `screenshot()` (`:154`) share; `captureTimeout`'s doc ("a
  ScreenCaptureKit completion handler never answered") covers both honestly.
- **`:160-168`** — the `classify` doc addition. Accurate for the screenshot path. Incomplete for the
  content path (I1).
- **`:172`** — `else { return CaptureError::NoImage }`. Inside the pre-existing `unsafe { error.as_ref() }`
  let-else; its SAFETY comment at `:170-171` is unchanged and still correct (we only read the NSError
  inside the call, under the handler's autorelease pool).

**`unsafe` accounting:** 12 `unsafe` tokens and 11 `SAFETY:` comments in the file — **identical
counts pre and post**. None added, removed or moved. (The 11/12 is pre-existing: the SAFETY at
`:51-52` covers both `SCStreamConfiguration::new()` and the setter block beneath it.)

**Concerns for the first real run:**
1. `classify` is shared by the content query and the screenshot, so a `captureNoImage` in the log may
   mean either "the screenshot came back empty" **or** "the shareable-content query came back empty"
   — and only the first is what the word says (I1). Same shape, milder, for `captureTimeout` and
   `captureError`, whose wording does cover both.
2. Timing leaves `failedCaptureTimeout` reachable, which is the point: `HANDLER_TIMEOUT` is 3 s
   (`capture.rs:33`), the client gives up at `budgetMs + CLIENT_READ_GRACE_MS` = 1500 + 4000 = 5.5 s,
   main at `READ_BUDGET_MS + READER_CALL_TIMEOUT_MS` = 6.5 s. But **both** framework calls can hang
   in one read (3 s + 3 s = 6 s > 5.5 s), and that read comes back as `timeout` / `timeoutRead`, not
   as `captureTimeout`. If a real log shows `timeoutRead` where a capture hang is suspected, this is
   why — worth knowing before concluding the detail feature "did not fire".
3. `CaptureError::Refused` from the **content query** (−3801 on `getShareableContent`) also reports
   `captureRefused` and sets the process-wide refused flag. Correct and unchanged, but on a machine
   whose grant was revoked the spec's note says the preflight goes false first, so `captureRefused`
   appearing at all would itself be information.
4. `frame_of`'s buffer/geometry refusal has never run against a real window; a 10-bit or odd-stride
   frame from an HDR display would land on `captureNoImage` rather than producing garbage — that is
   the safe direction, but it would read as a ScreenCaptureKit fault rather than a format one.

---

## 7. Mutation table — all nine re-run, plus six of my own

Method: exact-string edit (no write-tool escape decoding), run, observe, restore from backup, `cmp`
against `$R/app`. Every restore verified byte-identical; the whole tree re-verified with `diff -rq`
at the end.

| # | Mutation | Bites? | What failed |
|---|---|---|---|
| M1 | `ports/reader.ts`: drop `DETAIL_SET.has(...)` | ✅ | 6 × `ports.test.ts` "drops the detail …", `loop.test.ts` "tallies a failure with a detail the port refused", `leak.test.ts` "a detail outside the closed set can never reach…" (+ 2 of my probes). 4 files failed — report said 7 tests, I count 8 + mine |
| M2 | `loop.ts`: tally **after** `noteFailure()` | ✅ | `loop.test.ts` "tallies the cycle that trips the limit…", `engine.nothingRead.test.ts` "carries the failure stages out on CAPTURE_OFF", **and** `leak.test.ts` (report listed 2, actual 3) |
| M3 | `scheduler.rs`: `CaptureError::Timeout` → `FailDetail::CaptureError` | ✅ | `each_capture_error_says_which_step_failed`, `a_failure_before_the_capture_measured_nothing` (243 pass / 2 fail) |
| M4 | `readerClient.ts`: drop `detail: "helperDown"` from both returns | ✅ | 8 tests across `readerClient.test.ts` (6) and `readerClient.supervision.test.ts` (2) — exactly as claimed |
| M5 | `protocol.rs`: `matches!(reason, Failed \| Black)` | ✅ | `a_detail_is_never_written_on_an_answer_that_is_not_failed` (244 / 1) |
| M6 | `log.ts`: remove `"failedRecognise"` | ✅ | **`engine.ts(73,54): TS2344: Type 'false' does not satisfy the constraint 'true'`** — the exact error claimed — plus `log.test.ts` "takes every failure-stage key as a count key" (+ my probe) |
| M7 | `loop.ts`: never set `calling = "read"` | ✅ | `loop.test.ts` "says which reader call rejected…", "says which reader call hung…" |
| M8 | `loop.ts`: `recogniseError` → `"failedCaptureError"` | ✅ | `loop.test.ts` "names each failure stage with its own fixed count key", "counts the stage in addition to the outcome" — the re-run the report describes does hold |
| M9 | `macos/capture.rs`: `wait_for` back to `Other` | ✅ | `a_handler_that_never_answers_becomes_a_timeout`, `…becomes_the_same_timeout`, `a_late_answer_after_the_wait_gave_up_is_harmless` (242 / 3) |

**Not one of the developer's nine failed to bite**, and two bite harder than claimed (M1, M2 also
take `leak.test.ts`).

My own additions:

| # | Mutation | Bites? | Note |
|---|---|---|---|
| X3 | `loop.ts`: drop `calling = null` after the **second** `frontWindow` | ✅ | "never blames a reader call for a throw that came from somewhere else" |
| X4 | `loop.ts`: drop `calling = null` after the **first** `frontWindow` | ❌ **30/30 green** | see m2 |
| X5 | `ports/reader.ts`: allow `detail` on any reason | ✅ | 4 × "drops a detail on a %s answer" (+ my probe) |
| X6 | `scheduler.rs`: drop `cache.clear()` from the new `Err(Timeout)` arm | ❌ **245/245 green** | see I2 |
| X7 | `scheduler.rs`: drop `cache.clear()` from the `Err(Other)` arm | ✅ | `a_capture_that_failed_for_any_other_reason_forgets_the_last_window` — proves the guard exists for one arm only |
| X-tsc | M6 typecheck | ✅ | exact line/column match |

### Byte scan

All 17 changed files in my topic decoded as valid UTF-8. Scanned every code point:

- **No control bytes** other than `\n` and `\t`. No `DEL`, no zero-width (U+200B–U+200F), no bidi
  overrides (U+202A–U+202E), no BOM, no NBSP.
- **One Cyrillic character**: `scheduler.rs:1535`, `"Аcceptance criteria"` (U+0410). Confirmed
  **pre-existing** — present at `scheduler.rs:1286` in `$S/s1/pre-repair`. It is the homoglyph-repair
  fixture and must stay. **No Greek anywhere.**
- Full non-ASCII inventory across the 17 files: 287 × EM DASH, 1 × HORIZONTAL ELLIPSIS, 2 × MINUS
  SIGN, 2 × RIGHTWARDS ARROW, 1 × CYRILLIC А. Matches the report's section 7 exactly.
- The two escape restorations the report claims are on disk as the 6 ASCII characters `—`:
  `ports.test.ts:51` holds 1, `leak.test.ts` holds 2 (`:18` pre-existing, `:123` new) — matching the
  house fixture style.

---

## Findings

### Critical
None.

### Important

**I1 — `captureNoImage` names a step that did not run, on the shareable-content path.**
`native/reader/src/macos/capture.rs:172` (`classify`) — `native/reader/src/macos/capture.rs:95`
(`shareable_content`'s handler) — `native/reader/src/platform.rs:60-63` (the `NoImage` doc).
`classify` is called from **two** handlers. When `getShareableContentExcludingDesktopWindows…`
completes with a null `SCShareableContent` **and** a null `NSError`, the app is told
`detail: "captureNoImage"` — but no screenshot was ever requested; the window *list* came back empty.
The whole point of this change is that the word names the true cause, and here it names the wrong
stage. Pre-repair both paths said `Other`, which was vague but not misleading.
*Probe:* code read; not reachable from a test without a window server, which is why it survived.
*Suggested fix:* give the content query its own mapping — e.g. have `shareable_content`'s handler
call `classify(error)` and translate a `NoImage` result into a new `CaptureError::NoContent`
(→ `FailDetail::CaptureNoContent` → `failedCaptureNoContent`), or, if a fourth variant is not wanted,
at minimum amend the `NoImage` doc at `platform.rs:60-63` and the `classify` doc at `capture.rs:165-168`
to say that it also covers "the shareable-content query answered with neither content nor an error",
so whoever reads a real log is not sent to the wrong step.

**I2 — the `Other` split left the cache-clear guarantee guarded on one arm in three.**
`native/reader/src/scheduler.rs:433-443` — test at `native/reader/src/scheduler.rs:1144`.
Spec 5.2 (C-2b-1, "Which returns clear the cache") requires every not-reading return to clear;
`cache` holds recognised text, and "nothing older than an hour exists anywhere" rests on it. All
three arms clear today, but only the `Other` arm is pinned.
*Probe:* X6 — deleting `cache.clear()` from the `Err(CaptureError::Timeout)` arm leaves **245/245
green**. X7 — the same deletion on `Err(CaptureError::Other)` fails
`a_capture_that_failed_for_any_other_reason_forgets_the_last_window`. So the split silently reduced
coverage of a privacy-load-bearing rule from one arm to one third of the arms, and the test's name
("for any other reason") now over-claims what it checks.
*Suggested fix:* turn that test into a sweep —
`for error in [CaptureError::Timeout, CaptureError::NoImage, CaptureError::Other] { … }` — with the
`Shot::Err(error)` built per iteration, exactly as `each_capture_error_says_which_step_failed`
already does at `scheduler.rs:1225-1237`.

### Minor

**m1 — `helperDown` is accepted from the wire, though both the code doc and the report say it never
travels there.** `src/main/ports/reader.ts:88-91` (`FAILURE_DETAILS` includes it),
`src/main/ports/reader.ts:73-77` ("`helperDown` is this side's own"), report §1 ("never on the wire"),
and `src/main/ports/ports.test.ts:45` explicitly asserts the port *keeps* it. A misbehaving or stale
helper can therefore label its own failures `failedHelperDown` and send an operator looking at the
supervisor instead of the capture. No privacy impact — it is a closed-set member — purely diagnostic.
*Probe:* `parseReadResult({ok:false, reason:"failed", detail:"helperDown"})` keeps it.
*Suggested fix:* either check the wire set (the seven Rust words) separately from the union used
internally, or delete the "never on the wire" claim from the doc and the report and say instead that
a helper *may* claim it.

**m2 — the `calling` reset after the first `frontWindow` is unguarded, so D5 is only half-pinned.**
`src/main/capture/loop.ts:291`. *Probe:* X4 — deleting that line leaves **30/30 test files green**.
With it gone, a throw from `pipeline.mayCapture(front)` (`loop.ts:294`) — a real possibility, it runs
the core's exclusion rules — would be charged to `failedFrontWindow` instead of `failedUnknown`,
contradicting D5 and pointing at the window server for a core fault. Behaviour is right today; only
the guard is missing. The existing test covers the `ingest` position (after the *second* reset), not
this one.
*Suggested fix:* add a case to "never blames a reader call for a throw that came from somewhere else"
that throws from `mayCapture` (the `setup({allow})` hook already exists) and expects
`{failed: 1, failedUnknown: 1}`.

**m3 — nine positional parameters, two of them the same type.**
`native/reader/src/scheduler.rs:319-328`. `refused: &AtomicBool` (3rd) and `cancel: &AtomicBool` (5th)
are interchangeable to the compiler; that is pre-existing, and I verified all **15** call sites pass
them in the right order. The new `detail` is uniquely typed and cannot be transposed. D1 already
names `ReadReport` as the remedy at a fourth out-parameter; I would bring that forward to the next
change that touches this signature rather than wait.

**m4 — a caller can silently discard the detail by passing `&mut None`.** Fourteen test call sites do
exactly that, which is fine, and the one production site (`native/reader/src/worker.rs:157-169`)
does not. Noted because D1 names it as the cost and it is real: nothing type-checks that the value is
read.

---

## Verdict

The change does what it says. `failed` now carries a fixed word from a genuinely closed set, the set
is closed at four independent layers (Rust macro, wire→TS filter, `satisfies Record<…>` table,
`FailureTallyKey extends LogCountKey` + runtime check), and the privacy boundary holds against every
hostile shape I could feed it — including the one that matters, a window title sent as a `detail`,
which the leak test proves would otherwise land in `app.log` as a key. The ordering bug is genuinely
fixed and genuinely tested. The approved-window contract, the cache-clearing rules and the loop's
privacy logic are byte-identical to pre-repair apart from bookkeeping; I verified that mechanically
rather than by eye. All nine developer mutations bite, two of them harder than reported, and the
report's numbers and byte claims all check out on my own copy.

The two Important findings are not defects in what ships — they are a word that will point at the
wrong step in one real-world case (I1), and a privacy-relevant guard that the refactor thinned from
one arm to one third without anyone noticing (I2). Both are small, and both should be closed before
the first real run, because both only show up when something is already going wrong on a real
machine — which is the exact situation this change exists to make legible.

**Spec compliance ✅** — §3 (additive protocol-2 keys, number correctly left at 2: nothing decides on
`detail`), §5.2 (three comparisons, their order, the store, "which returns clear the cache" — all
behaviourally intact), §5.3 (the failure table unchanged; `windowGone` still not a failure; −3801 →
`Refused` → `failed` with the process-wide flag intact; the D1 no-`expect` row now says `noExpect`).

**Quality: Approved** — with I1 and I2 to be fixed before the first real run. No Critical findings;
nothing blocks.

---

## Artifacts

- Probe file I added to the review copy (the only difference from `$R/app`):
  `$S/s1/rvA/app/src/main/ports/reviewA.test.ts` — 9 tests, all passing, worth adopting as-is.
- Mutation backups: `$S/s1/mutbak/` (my helper script at `$S/s1/mutate.py` was later overwritten by
  the parallel reviewer working on `src/readerEval`; the backups are untouched).
- `$R` was never modified. `pnpm` was never run. No helper was built into a bundle, no read or
  `frontWindow` was ever sent to a built helper, and nothing under
  `~/Library/Application Support/Clave Agent Dev/` was opened.
