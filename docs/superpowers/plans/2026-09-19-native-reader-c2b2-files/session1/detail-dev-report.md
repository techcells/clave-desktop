# `failed` gains a closed-set DETAIL code, end to end

Diagnostic change only. Nothing about what a read MEANS moved: `ReadAnswer`'s variants, `FailReason`,
`CycleOutcome` and `CYCLE_CLASS` are all unchanged, and `failed`/`timeout` still count exactly what
they counted. What is new is a fixed word beside each failure saying which stage produced it, and a
per-run tally under fixed count keys, so `CAPTURE_OFF` says *where* reading broke.

One pre-existing bug fixed while there: the cycle that trips `READER_FAILURE_LIMIT` is now tallied
**before** the problem is raised (it raises, stops the loop and writes the tallies), so the log no
longer says `failed: 4` beside a `READER_PROBLEM` caused by five.

---

## 1. The closed sets, verbatim

Rust enum (`native/reader/src/scheduler.rs`) ↔ wire string ↔ TS union (`src/main/ports/reader.ts`) ↔
log count key (`src/main/log.ts`, via `FAILED_DETAIL_KEY` in `src/main/capture/loop.ts`):

| `FailDetail` (Rust) | wire `detail` | `FailureDetail` (TS) | log count key |
|---|---|---|---|
| `NoExpect` | `"noExpect"` | `"noExpect"` | `failedNoExpect` |
| `NoGrant` | `"noGrant"` | `"noGrant"` | `failedNoGrant` |
| `CaptureRefused` | `"captureRefused"` | `"captureRefused"` | `failedCaptureRefused` |
| `CaptureTimeout` | `"captureTimeout"` | `"captureTimeout"` | `failedCaptureTimeout` |
| `CaptureError` | `"captureError"` | `"captureError"` | `failedCaptureError` |
| `CaptureNoImage` | `"captureNoImage"` | `"captureNoImage"` | `failedCaptureNoImage` |
| `RecogniseError` | `"recogniseError"` | `"recogniseError"` | `failedRecognise` |
| — (client-side only) | never on the wire | `"helperDown"` | `failedHelperDown` |

Loop-only keys, with no wire form at all (there is no answer to carry one — the call rejected or
never settled, so only main knows which call it was):

    failedUnknown   failedFrontWindow   failedReadCall   timeoutFrontWindow   timeoutRead

`LOG_COUNT_KEYS` gained exactly these thirteen:

    "failedNoExpect", "failedNoGrant", "failedCaptureRefused", "failedCaptureTimeout", "failedCaptureError",
    "failedCaptureNoImage", "failedRecognise", "failedHelperDown", "failedUnknown",
    "failedFrontWindow", "failedReadCall", "timeoutFrontWindow", "timeoutRead"

`CaptureError` (`native/reader/src/platform.rs`) gained two variants, `Timeout` and `NoImage`;
`Refused`, `Gone` and `Other` keep their meanings.

### How the sets are held closed
1. Rust: `failed!` macro — every `failed` return in `handle_read` goes through it, so a path that
   forgets its detail does not compile.
2. Wire → TS: `parseReadResult` keeps `detail` only when the reason is `failed`, the value is a
   string, and the string is in `DETAIL_SET`. Anything else is **dropped** (not collapsed to a
   placeholder). Parsed as `z.unknown()` rather than `z.enum` deliberately: an enum would fail the
   whole parse, and a `black` answer with a strange detail would then reach the loop as `failed`.
3. TS → key: `FAILED_DETAIL_KEY ... satisfies Record<FailureDetail, string>` — a detail with no key
   does not compile. Keys are written-out literals, never assembled at run time.
4. key → log: `AssertFailureStagesAreCountKeys` in `engine.ts` (`FailureTallyKey extends LogCountKey`)
   — a key missing from `LOG_COUNT_KEYS` is a type error. `log.event` re-checks at run time anyway.

---

## 2. Files changed

### Rust (`app/native/reader/src/`)
| File | What |
|---|---|
| `platform.rs` | `CaptureError` gains `Timeout`, `NoImage`; doc rewritten to say which two distinctions change behaviour and which three only change what is *said*. |
| `scheduler.rs` | New `FailDetail` enum + `as_str`. `handle_read` gains a 9th out-parameter `detail: &mut Option<FailDetail>` and a `failed!` macro; the `Other` capture arm is split into three arms. 8 new tests, 2 new test helpers (`read_detail`, `read_detail_expecting`). |
| `protocol.rs` | `read_line` gains a 5th parameter `detail: Option<FailDetail>`; writes `detail` and a narrowed `stats` inside the `Failed` arm only. New `failed_stats_value` (captureMs/width/height only). Module docs record the additive protocol-2 keys. 6 new tests; `no_other_failure_carries_measurements` narrowed to exclude `Failed`. |
| `worker.rs` | Threads `&mut detail` into `handle_read` and `detail` into `read_line`. |
| `macos/capture.rs` | 3 behaviour lines + 1 doc block + test updates (below). |

### TypeScript (`app/src/`)
| File | What |
|---|---|
| `main/ports/reader.ts` | `FailureDetail`, `FAILURE_DETAILS`, `DETAIL_SET`; `ReadResult` failure arm gains optional `detail`; zod `detail: z.unknown().optional()`; `parseReadResult` filters. |
| `main/reader/readerClient.ts` | Its own two `failed` answers (no usable helper; `"down"`) now carry `detail: "helperDown"`. |
| `main/capture/loop.ts` | `FAILED_DETAIL_KEY`, `FailedDetailKey`, `FailureTallyKey`, `CycleStats`; `cycle` returns `CycleReport {outcome, key}`; `calling` tracks which reader call is in flight; `trigger` tallies **then** calls `noteFailure` (the ordering fix). |
| `main/log.ts` | 13 new `LOG_COUNT_KEYS`, docs on why they are literals. |
| `main/engine.ts` | Imports `FailureTallyKey`; new `AssertFailureStagesAreCountKeys`. |
| Tests | `main/ports/ports.test.ts`, `main/capture/loop.test.ts`, `main/log.test.ts`, `main/engine.nothingRead.test.ts`, `main/leak.test.ts` (new tests); `main/reader/readerClient.test.ts`, `readerClient.supervision.test.ts` (assertions updated for `helperDown`). |

Untouched, as required: `src/readerEval/**`, `scripts/reader-eval.*`. Stand-ins (`standins/devReader.ts`,
`testing/fakeReader.ts`) needed no change — they answer `windowGone`, never `failed`, and `detail` is optional.

---

## 3. Changed lines in `macos/*.rs` (compile-verified only, never run against a real window)

All in `native/reader/src/macos/capture.rs`. Every `unsafe` block kept its SAFETY line; **no `unsafe`
block was added, removed or moved**.

| Line | Before → After |
|---|---|
| 66–68 | `frame_of(&image).ok_or(CaptureError::Other)?` → `ok_or(CaptureError::NoImage)?`, plus a 2-line comment saying why (no error was reported; the picture is unusable). |
| 113–119 | Doc block on `wait_for` rewritten: the two `recv_timeout` errors are one fact (the handler never answered) and are a different fact from an error the framework reported. |
| 126 | `unwrap_or(Err(CaptureError::Other))` → `unwrap_or(Err(CaptureError::Timeout))`. |
| 160–166 | Doc paragraph added to `classify`: a completion with neither image nor error is `NoImage`, not `Other`. |
| 172 | `else { return CaptureError::Other }` → `else { return CaptureError::NoImage }` (null error). Inside the existing `unsafe { error.as_ref() }` let-else; its SAFETY comment is unchanged above it. |
| 178 | unchanged — a reported, non-refusal error stays `CaptureError::Other`. |
| 227–228 | Test `a_failure_reported_by_the_handler_is_passed_through_unchanged` sweeps all five variants now. |
| 237, 241 | Test renamed `..._becomes_a_plain_failure` → `..._becomes_a_timeout`; asserts `Timeout`. |
| 247–251 | Test renamed `..._becomes_the_same_plain_failure` → `..._becomes_the_same_timeout`; doc added; asserts `Timeout`. |
| 259 | `a_late_answer_after_the_wait_gave_up_is_harmless` asserts `Timeout`. |

---

## 4. Test totals

| Suite | Before | After | Δ |
|---|---|---|---|
| `test:native` (Rust) | 231 | **245 pass, 0 fail** | +14 |
| `src/main src/standins src/shell src/shared` | 527 | **579 pass, 0 fail** | +52 |
| `typecheck` | — | **clean, exit 0** | — |
| `build:native` | — | **zero warnings**, `BUILD_NATIVE_OK` | — |
| handshake_check.py | — | **ALL CHECKS PASSED** | — |
| Full suite (final) | — | 1727 pass, **1 fail** | see below |

The single full-suite failure is `src/readerEval/results.test.ts > ignores a field smuggled into a
toolbar or an observe ROW` — the other agent's folder, mid-edit (a results row schema gained four
fields: `staged`, `scale`, `sizeAsStaged`, `startFound`, …). Not mine: `src/readerEval/**` imports
only `main/reader/protocol.ts`, `main/reader/constants.ts`, `shell/readerLink.ts` and `core/*`, none
of which this change touches, and it references none of `parseReadResult`, `FailureDetail`,
`LOG_COUNT_KEYS`, `CycleOutcome` or `ports/reader`.

---

## 5. Mutation table

Each: `cp` aside → mutate the fix → run → watch FAIL → restore → `cmp` (all restores verified byte-identical).

| # | Mutation | Failing test(s) |
|---|---|---|
| M1 | `ports/reader.ts`: drop `DETAIL_SET.has(...)` — pass any helper `detail` string through | `ports.test.ts > drops the detail "captureExploded" \| "Priya Raman — recovery codes" \| "" \| "noexpect" \| "NOGRANT" \| "helperDown "` (6) **and** `leak.test.ts > a detail outside the closed set can never reach the log, an event, or anything a UI can ask for` — 7 failed |
| M2 | `loop.ts`: tally **after** `noteFailure()` (the original ordering bug) | `loop.test.ts > tallies the cycle that trips the limit before raising the problem, so all five are counted`; `engine.nothingRead.test.ts > carries the failure stages out on CAPTURE_OFF, as numbers under the closed count keys` — 2 failed |
| M3 | `scheduler.rs`: map `CaptureError::Timeout` → `FailDetail::CaptureError` | `scheduler::tests::each_capture_error_says_which_step_failed`; `scheduler::tests::a_failure_before_the_capture_measured_nothing` |
| M4 | `readerClient.ts`: drop `detail: "helperDown"` from both returns | 8 failed across `readerClient.test.ts` (5) and `readerClient.supervision.test.ts` (2), incl. `while the helper warms up…`, `an unreadable line fails whatever was being asked`, `fails calls in flight, answers every later call as down…` |
| M5 | `protocol.rs`: write `detail` on a `black` answer too (`Failed \| Black`) | `protocol::tests::a_detail_is_never_written_on_an_answer_that_is_not_failed` |
| M6 | `log.ts`: remove `"failedRecognise"` from `LOG_COUNT_KEYS` | **TYPE ERROR** `src/main/engine.ts(73,54): TS2344: Type 'false' does not satisfy the constraint 'true'` **and** `log.test.ts > takes every failure-stage key as a count key, and still refuses anything else` |
| M7 | `loop.ts`: never set `calling = "read"` | `loop.test.ts > says which reader call rejected: the front-window call or the read`; `> says which reader call hung: the front-window call or the read` |
| M8 | `loop.ts`: `recogniseError` mapped to `"failedCaptureError"` | `loop.test.ts > names each failure stage with its own fixed count key`; `> counts the stage in addition to the outcome, never instead of it` |
| M9 | `macos/capture.rs`: `wait_for` back to `CaptureError::Other` | `macos::capture::tests::a_handler_that_never_answers_becomes_a_timeout`; `..._becomes_the_same_timeout`; `a_late_answer_after_the_wait_gave_up_is_harmless` |

M8 was run twice: the first run caught it only via `counts the stage in addition to the outcome`,
because the `it.each` sweep asks `FAILED_DETAIL_KEY` what each stage is called and would pass against
any table. A dedicated test pinning the table verbatim was added, and M8 re-run then failed both.

---

## 6. Decisions, and what they cost if wrong

**D1 — the detail is an out-parameter, not a payload on `Fail`.** Chosen because it is much the
smaller change and the more honest one: ~45 `assert_eq!(answer, Some(ReadAnswer::Fail(...)))`
assertions in `scheduler.rs` compare an answer, and an answer is what a read MEANS. A payload would
rewrite all of them and make two reads that mean the same thing unequal because one knew more about
why. It follows the pattern `ReadStats` and `ReadGeometry` already set, and its doc says so.
*Cost if wrong:* `handle_read` now takes nine arguments, which is a lot; a caller could pass
`&mut None` and silently discard the detail (only `worker.rs` calls it, and it does not). If this
ever grows a fourth out-parameter, the three should become one `ReadReport` struct.

**D2 — `CaptureError::Other` kept, two variants added beside it.** `macos/capture.rs` can honestly
tell three cases apart at three separate places: the completion wait produced nothing (`Timeout`),
the completion carried neither image nor error, or the image is unusable (`NoImage`), and the
framework reported some other error (`Other`). Splitting rather than replacing keeps `stub.rs` and
every existing `Shot::Err(CaptureError::Other)` test meaning what they meant.
*Cost if wrong:* `recv_timeout`'s `Disconnected` (block dropped without running) is folded into
`Timeout` rather than given a variant. Defensible — both mean "the handler never answered" — but if
a real machine ever shows those as different faults, `Disconnected` needs its own detail.

**D3 — `failedFrontWindow` covers BOTH `frontWindow()` calls**, the one before the read and the
re-check after it, because the key names the *call* that broke and that is the actionable fact. The
brief's phrasing ("before the read") describes the first.
*Cost if wrong:* a window-server hang during the after-check is indistinguishable in the tally from
one during the first call. Cheap to split later (`calling` already tracks position).

**D4 — a helper-reported `timeout` gets no stage key.** That is the helper's own verdict on itself
and it cannot attribute further; `timeoutFrontWindow`/`timeoutRead` are the loop's own two timeouts,
which it *can* place. *Cost if wrong:* a `timeout` with neither key is slightly opaque — but it is
already distinguishable, since only the loop's own timeouts carry a key.

**D5 — a throw from outside a reader call is `failedUnknown`, not blamed on the last call.**
`pipeline.ingest`/`mayCapture` throwing still counts as `failed` (unchanged behaviour), but is not
charged to `frontWindow` or `read`. *Cost if wrong:* a pipeline fault reads as "could not tell",
which is honest but does not point at the pipeline. A `failedPipeline` key would fix it if it ever
shows up in a real log.

**D6 — `failed` answers carry `stats` narrowed to `captureMs`, `width`, `height`.** Not the whole
`ReadStats`: `recogniseMs` and `cacheHit` on a read that never finished recognising would describe
work that did not happen. Built by a second hand-written function rather than by filtering
`stats_value`, so a field added to `ReadStats` later cannot appear on a failure by merely existing.
The port strips `stats` entirely, so only `reader:eval` ever sees it.
*Cost if wrong:* one more hand-maintained field list; a new capture measurement has to be added in
two places to show on failures.

**D7 — protocol number stays at 2.** Both `detail` and the failure `stats` are strictly additive keys
on an answer that already exists. An older main ignores unknown keys and still sees `failed`; an
older helper sends no detail and a newer main tallies `failedUnknown`. Neither side is worse off,
which is the test the `lines` addition already passed. Recorded in `protocol.rs`'s module docs.
*Cost if wrong:* if a future main ever *decides* something on `detail` (rather than only counting
it), this reasoning stops holding and the number must move.

---

## 7. Byte checks

Every touched file decoded as valid UTF-8 and was inspected character by character.

- **Two escapes were silently decoded by the write tool** and have been restored byte-exactly via
  Python: `"Priya Raman — recovery codes"` in `ports.test.ts:51` and
  `const leaky = "Priya Raman — recovery codes at acme.io"` in `leak.test.ts:123`. Both are
  now the literal 6-byte `—` sequence on disk, matching the existing fixture style at
  `leak.test.ts:18`. Verified: `ports.test.ts` holds 1 literal `—`, `leak.test.ts` holds 2.
- **No Cyrillic or Greek was introduced.** The one Cyrillic character in the tree,
  `scheduler.rs:1535` (`"Аcceptance criteria"` with U+0410), is **pre-existing** — it is the
  homoglyph-repair test fixture and must stay.
- All other non-ASCII in the 17 touched files is EM DASH (house style in comments), plus a
  pre-existing HORIZONTAL ELLIPSIS, two MINUS SIGNs and two RIGHTWARDS ARROWs.

---

# Fix round 1 (review A)

All five findings closed. Review A's probe file adopted into `ports.test.ts` and `log.test.ts`.

## I1 — `captureNoImage` named a step that never ran, on the content path

`classify` was shared by both ScreenCaptureKit completion handlers, so an empty shareable-content
query reached the app as `captureNoImage` — naming a screenshot that had never been requested.

The content query now has its own variant and detail, carried through all four closed sets:

| Rust `CaptureError` | `FailDetail` | wire | TS `FailureDetail` | log key |
|---|---|---|---|---|
| `NoContent` (new) | `CaptureNoContent` | `"captureNoContent"` | `"captureNoContent"` | `failedCaptureNoContent` |

`NoImage` now means the screenshot step and only that. Both exhaustiveness checks carry it: the loop's
`satisfies Record<FailureDetail, string>` and `engine.ts`'s `FailureTallyKey extends LogCountKey`.

**The first attempt at this was not pinned, and the revert proof is what caught it.** Rewiring
`content_answer` back to `classify` left 246/246 green, because the decision lived inside an
`RcBlock` closure that only ScreenCaptureKit can run — which is exactly how the original defect
survived 245 green tests. Fixed by extracting the two closure bodies into ordinary functions,
`content_answer` and `image_answer`, which a test calls with the nulls the framework itself passes.
The revert now fails. No `unsafe` was added: both `unsafe` blocks moved into the extracted functions
with their SAFETY comments attached (counts unchanged — 12 `unsafe`, 11 `SAFETY:`).

## I2 — the cache-clear guarantee was pinned on one arm in three

`a_capture_that_failed_for_any_other_reason_forgets_the_last_window` →
**`every_way_a_capture_can_fail_forgets_the_last_window`**, sweeping all six variants with
`Shot::Err(error)` built per iteration. Deleting `cache.clear()` from any single arm now fails it
(proved six times, below). The name now claims what it checks.

## m1 — `helperDown` was accepted from the wire

Split into two sets and two parsers:

- `FAILURE_DETAILS` / `parseReadResult` — the full set, used by the **capture loop**.
- `WIRE_DETAILS` / `parseHelperReadResult` — everything except `helperDown`, used by the **client**.

**One parser with the narrow set does not work**, which is the interesting part: the loop re-parses
whatever the `Reader` port hands it (its defence against a lying implementation), so narrowing there
too would delete the client's own `helperDown` on the way past and make `failedHelperDown` a count
that can never be reached. The loop test caught this immediately when I first tried it.

## m2 — the `calling = null` after the first `frontWindow` was unguarded

`never blames a reader call for a throw that came from somewhere else` is now an `it.each` over both
positions: `mayCapture` (right after the first reset) and `ingest` (right after the second). Deleting
either reset now fails.

## m3 — nine positional parameters → seven

**Done, contained.** The three out-parameters are now one `ReadReport<'a> { stats, detail, geometry }`
with `::new()` and `::measuring(&mut geometry)` constructors. 15 call sites updated (1 production,
14 test). `handle_read` goes 9 → 7 parameters; the pre-existing `refused`/`cancel` same-type pair
remains, so m3's actual transposition risk is unchanged — the win is that the three out-values travel
under names, and a fourth needs no call-site change.

**The mechanical rewrite orphaned three test locals, and `cargo`'s own warnings caught it** —
including one test (`two_reads_of_the_same_window_report_the_cache_hit`) that would have gone on
asserting against a discarded `ReadStats`. Since a local that is read but no longer written shows up
as "variable does not need to be mutable", **zero warnings is the proof that no assertion is silently
reading a stale value.**

## Totals after fix round 1

| Check | Before round 1 | After |
|---|---|---|
| `test:native` | 245 | **247 pass, 0 fail** |
| `build:native` | zero warnings | **zero warnings** |
| handshake | PASSED | **ALL CHECKS PASSED** |
| `typecheck` | clean | **clean, exit 0** |
| `src/main src/standins src/shell src/shared` | 579 | **611 pass, 0 fail** |
| full suite | 1727 pass / 1 fail (other agent) | **1850 pass, 0 fail** |

The other agent's `src/readerEval` failure resolved itself; the full suite is now green end to end.

## Revert proofs (all restores `cmp`-verified byte-identical)

| # | Mutation | Failing test(s) |
|---|---|---|
| R1 | `capture.rs`: `content_answer` wired back to `classify` | `an_empty_content_completion_and_an_empty_screenshot_are_different_failures` |
| R2a | drop `cache.clear()` from the `Timeout` arm | `every_way_a_capture_can_fail_forgets_the_last_window` |
| R2b | …from `NoContent` | same |
| R2c | …from `NoImage` | same |
| R2d | …from `Other` | same |
| R2e | …from `Refused` | same **+** `a_refused_capture_forgets_the_last_window` |
| R2f | …from `Gone` | same **+** `a_window_that_vanished_before_the_capture_forgets_the_last_window` |
| R3 | `WIRE_DETAIL_SET` built from `FAILURE_DETAILS` (helperDown back on the wire) | `refuses helperDown from the wire…`; `passes a helper's stage through, but never lets it claim the one word only we can say` |
| R4 | drop `calling = null` after the FIRST `frontWindow` | `never blames a reader call for a throw from mayCapture, right after the first front-window call` |

Original nine re-run after the refactor — **all still bite**: M1 (14 tests), M2 (3), M3, M4 (8),
M5, M6 (type error + test), M7 (2), M8 (2), M9 (3).

## Byte checks

All 17 files valid UTF-8. No control bytes beyond `\n`/`\t`, no zero-width, no bidi, no BOM, no NBSP.
Inventory: 315 EM DASH, 2 MINUS SIGN, 2 RIGHTWARDS ARROW, 1 HORIZONTAL ELLIPSIS, and the single
pre-existing CYRILLIC А at `scheduler.rs` (the homoglyph-repair fixture — must stay). The two
`—` escapes are still literal on disk (`ports.test.ts` 1, `leak.test.ts` 2).

---

# Fix round 2 (re-review A: O1, O2)

## O1 — three stale doc counts, made exactly true (comment-only)

| File | Was | Now |
|---|---|---|
| `platform.rs:39-49` | "The other **three** are all 'a failure we do not interpret'"; "Why that is worth **three** variants"; "at **three** different places" | names the four by variant (`Timeout`, `NoContent`, `NoImage`, `Other`), "worth **four** variants", "at **four** different places" — and adds the fourth distinction the list was missing, *which* completion it was |
| `scheduler.rs:462` | "The **three** arms answer identically" above four arms | "The **four** arms…", naming all four machines, and states that a fifth variant fails to compile here rather than inheriting a detail |
| `capture.rs` (`wait_for`) | described the empty completion only as `NoImage` | "`NoContent` when it was the shareable-content query and `NoImage` when it was the screenshot, because those are two different steps"; plus why `Timeout` is deliberately *not* split that way |

Also closed **O3** in passing, since it is the same class of untrue claim: the "EVERY way" sweep now
says in its own doc that the list is hand-enumerated, that a seventh `CaptureError` would not compile
in `handle_read` (no wildcard) but *would* be silently absent here, and names the second sweep that
needs the same addition.

No code changed: `test:native` 247 → 247 before the O2 work, byte-checked below.

## O2 — the one production line that puts the report on the wire

`worker.rs` line 170 was covered by nothing: `emit` writes to stdout, so passing `None` for geometry,
a fresh `ReadStats`, or no detail left all 247 tests green while emptying the answers the app receives.

Two extractions, chosen so that **no existing statement is reordered** (in particular `emit` still
happens before `jobs.finished()`, exactly as before):

- `answer_line(id, answer, report) -> String` — the mapping from report to protocol line.
- `turn_saying(..., say: &mut dyn FnMut(&str)) -> bool` — the body of `turn`, with its one side
  effect handed in. `turn` is now a one-line wrapper passing `emit`; `run` is untouched; the two
  existing `turn(...)` tests are untouched.

Four new worker tests drive a real `handle_read` against the fake platform and read the line that
came out. The fake gained two switches (`recognise_fails`, `granted`) so a read can fail at a *named*
step:

| Test | Pins |
|---|---|
| `a_read_that_worked_puts_its_measurements_on_the_wire` | `stats` reaches the wire (width, height, cacheHit, captureMs, recogniseMs); no `lines`, no `detail` |
| `a_read_that_asked_for_geometry_puts_its_boxes_on_the_wire` | `geometry` reaches the wire — one box, its text, its measured pixel bounds |
| `a_failed_read_puts_the_step_that_failed_on_the_wire` | `detail: "recogniseError"` **and** the narrowed three-number `stats`, with `recogniseMs`/`cacheHit` absent |
| `a_read_with_no_grant_puts_that_step_on_the_wire_and_measures_nothing` | `detail: "noGrant"` and no `stats` at all |

This is also the first end-to-end pin of `detail` inside the helper, as the reviewer noted it would be.

### Revert proofs (restored by writing bytes, so cargo sees a fresh mtime; `cmp`-verified)

| Mutation on `answer_line` | Result |
|---|---|
| stats → `&ReadReport::new().stats` | `a_read_that_worked_puts_its_measurements_on_the_wire`, `a_failed_read_puts_the_step_that_failed_on_the_wire` (249/2) |
| geometry → `None` | `a_read_that_asked_for_geometry_puts_its_boxes_on_the_wire` (250/1) |
| detail → `None` | `a_failed_read_puts_the_step_that_failed_on_the_wire`, `a_read_with_no_grant_puts_that_step_on_the_wire_and_measures_nothing` (249/2) |

## Totals after fix round 2

| Check | Result |
|---|---|
| `test:native`, from a **removed** `target/` | **251 pass, 0 fail**, zero warnings |
| `build:native`, from a removed `target/` | **zero occurrences of "warning"**, `BUILD_NATIVE_OK` |
| handshake | **ALL CHECKS PASSED** |
| `typecheck` | clean, exit 0 |
| `src/main src/standins src/shell src/shared` | **611 pass, 0 fail** |
| full suite | **1850 pass, 0 fail** |

## Byte checks (this round's 4 files)

Valid UTF-8; no control bytes beyond `\n`/`\t`; no zero-width, bidi, BOM or NBSP. Non-ASCII: 124 EM
DASH, 1 HORIZONTAL ELLIPSIS, and the single pre-existing CYRILLIC А in `scheduler.rs` (homoglyph
fixture — unchanged). `macos/capture.rs` `unsafe` accounting still **12 / 11**, identical to pre-repair:
this round added no `unsafe` and moved none.
