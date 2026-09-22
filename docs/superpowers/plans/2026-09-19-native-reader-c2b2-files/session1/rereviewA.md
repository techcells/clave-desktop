# Re-review A — fix round 1 for "failure detail codes"

Scoped re-review. Topic = everything in `$S/s1/fix1.diff` **except** `src/readerEval/**` and
`scripts/reader-eval.*` — 13 files (5 Rust, 8 TypeScript).

Private copy: `$S/s1/rrA/app`, verified byte-identical to `$R/app` before and after
(`diff -rq -x node_modules -x target -x dist -x dist-preview -x out`, no output; every one of the 13
files `cmp`-clean at the end). `$R` was never written to. `pnpm` was never run. No bundle was
launched, no `start:reader` / `reader:eval` / `dev:bundle`, nothing under
`~/Library/Application Support/Clave Agent Dev/` was opened.

## Baseline re-measured on my own copy (not taken from the report)

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0, clean |
| `vitest src/main src/standins src/shell src/shared` | **611 tests, 39 files, all pass** (the report's 611) |
| `build-native.mjs --test`, from a **removed** `target/` | **247 passed, 0 failed**, exit 0 |
| `build-native.mjs` release, from a removed `target/` | exit 0, **zero occurrences of the string "warning"** |

Note on the "1 skipped" in the earlier review: `src/shell/realReader.binary.test.ts` is
`describe.skipIf(!existsSync(BINARY))`. Once the release binary exists it runs — and it did run here,
inside the 611. I read it before letting it run: it spawns the helper, asks **`permission` only**,
asserts the vocabulary of the answer, and disposes. It issues no `read`, captures nothing and prints
nothing. No real window was read at any point in this re-review.

---

# Findings

## I1 — `captureNoContent` through all four closed sets — **FIXED**

**Behaviour.** `classify` is now reached from exactly two places: `image_answer` (the screenshot
completion) and `classify_content`, which translates only `NoImage → NoContent` and passes everything
else through. Verified by grep over the whole crate: `CaptureError::NoImage` is produced at exactly
two non-test sites, `capture.rs:166` (inside `classify`, i.e. the screenshot completion) and
`capture.rs:68` (`frame_of(&image).ok_or(...)`, after the screenshot returned `Ok`). Both are the
screenshot step. `NoContent` is produced at exactly one site, `capture.rs:218`, reachable only from
`content_answer`. The ruling holds: **`captureNoImage` = the screenshot step only.**

**All four closed sets carry it**, and each link is revert-proofed:

| # | Revert | Result |
|---|---|---|
| R1 | `content_answer` wired back to `classify` | ✅ `an_empty_content_completion_and_an_empty_screenshot_are_different_failures` (246/1) |
| R1b | `classify_content` stops remapping (`NoImage => NoImage`) | ✅ **both** capture tests (245/2) |
| R1c | `FailDetail::CaptureNoContent => "captureNoImage"` (wire word) | ✅ `protocol::tests::every_failure_detail_has_its_own_fixed_word` (246/1) |
| R1e | `"failedCaptureNoContent"` removed from `LOG_COUNT_KEYS` | ✅ **`engine.ts(73,54): TS2344: Type 'false' does not satisfy the constraint 'true'`** + 2 tests in `log.test.ts` |
| R1f | `"captureNoContent"` removed from the **runtime** `FAILURE_DETAILS` array only (type left intact) | ✅ `tsc` stays 0 **but** 2 tests fail: `loop.test.ts > tallies a failure the reader blamed on captureNoContent under its own key` and `readerClient.test.ts > passes a helper's stage through…` |

R1f is the one worth stating explicitly: `FAILURE_DETAILS` is only *annotated* `readonly
FailureDetail[]`, so a word present in the union but missing from the array compiles. It is caught
anyway, because `loop.test.ts`'s `detailCases: Record<FailureDetail, undefined>` drives the whole
**type** through the port at run time. The chain is closed at every link.

**No test can reach a *non-null* NSError** — see "Compile-verified only" below.

## I2 — the cache-clear sweep — **FIXED**

`every_way_a_capture_can_fail_forgets_the_last_window` builds `Shot::Err(error)` per iteration over
all six variants and carries the expected `FailReason` with each case. I deleted `cache.clear()` from
each arm in turn, rebuilding and running the full native suite each time:

| Arm deleted | Failing tests |
|---|---|
| `Refused` | sweep **+** `a_refused_capture_forgets_the_last_window` (245/2) |
| `Gone` | sweep **+** `a_window_that_vanished_before_the_capture_forgets_the_last_window` (245/2) |
| `Timeout` | sweep (246/1) |
| `NoContent` | sweep (246/1) |
| `NoImage` | sweep (246/1) |
| `Other` | sweep (246/1) |

**Deleting the clear from any single arm fails it.** Exactly the ruling, and exactly the fixer's
R2a–R2f. The `match` on `platform.capture(...)` has **no wildcard arm** (read at
`scheduler.rs:434-481`), so a seventh `CaptureError` variant could not inherit another arm's detail
or its clear — it would not compile.

## m1 — `helperDown` is client-only — **FIXED, and the two-parser design is sound**

Judgment asked for: *can a helper smuggle `helperDown`, or anything else, through the client into the
loop's tallies?* **No.**

- The **only** production path from wire bytes to a `ReadResult` is `readerClient.ts:454`, and it
  uses `parseHelperReadResult` (`WIRE_DETAIL_SET`, which excludes `helperDown`). Grepped every
  `parseReadResult` / `parseHelperReadResult` call site in `src/` and `scripts/`: the other two
  non-test uses are `loop.ts:295` (the loop's re-parse) and tests.
- The three string sentinels (`"deadline"`, `"superseded"`, `"down"`) are handled before line 454, so
  `answer` there is always the helper's own JSON. The two `helperDown` literals
  (`readerClient.ts:431`, `:448`) are built by the client, never derived from wire data.
- The only other `Reader` implementation in the tree, `standins/devReader.ts`, never produces a
  `detail` at all.
- The loop's re-parse is **wider**, not narrower, so it cannot widen anything: the client already
  rebuilt a literal from a closed-set member. A value can only survive `parseReadResult` by being in
  the union, and the only way into the union from outside the process is through the wire set.

Both directions revert-proofed:

| # | Revert | Result |
|---|---|---|
| R3 | `WIRE_DETAIL_SET` built from `FAILURE_DETAILS` | ✅ `ports.test.ts > refuses helperDown from the wire…`, `readerClient.test.ts > passes a helper's stage through…` |
| R3b | the **loop's** parser narrowed to `WIRE_DETAIL_SET` too (the "one parser" the fixer says does not work) | ✅ 3 tests, incl. `loop.test.ts > tallies a failure the reader blamed on helperDown under its own key` — `failedHelperDown` becomes unreachable, exactly as the fixer reports |

The fixer's claim that one parser cannot work is correct and is now pinned from both sides.

## m2 — the `calling = null` attribution guard — **FIXED**

`never blames a reader call for a throw from %s` is an `it.each` over `mayCapture` (after the first
`frontWindow`) and `ingest` (after the second). Deleting either reset fails its own case:

| Revert | Result |
|---|---|
| drop `calling = null` after the **first** `frontWindow` | ✅ `…for a throw from mayCapture, right after the first front-window call` (610/1) |
| drop `calling = null` after the **second** `frontWindow` | ✅ `…for a throw from ingest, right after the second` (610/1) |

The `allow` hook is a real `setup` option wired to `mayCapture` (`loop.test.ts:9,15`); the
`hooks as Parameters<typeof setup>[0]` cast cannot hide a misspelled key, because a hook that never
fired would leave `stats()` as `{kept: 1}` and the assertion would fail.

## m3 — nine positional parameters → one `ReadReport` — **DONE; no assertion reads a stale value**

- `handle_read` is **7** parameters (platform, cache, refused, budget, cancel, expect, report).
- **15 call sites** enumerated by grep: 14 test + 1 production (`worker.rs:160`). Every one passes
  `refused` 3rd and `cancel` 5th (the pre-existing same-typed pair, unchanged risk); `report` is
  uniquely typed and cannot be transposed. Production site and the two multi-line test sites read
  correctly.
- **The zero-warnings argument checked, and then checked independently.** The release build does not
  compile `#[cfg(test)]`, so release warnings prove nothing about test locals. I therefore rebuilt
  `--test` from a **removed** `target/`: **0 occurrences of "warning"**, 247 pass. Then I proved the
  assertions are live rather than trusting the warning argument at all:

  | Mutation | Result |
  |---|---|
  | `handle_read` stops writing `report.stats.cache_hit` (both sites) | ✅ `a_read_reports_the_frame_it_captured_and_whether_it_had_to_recognise`, `a_cache_hit_has_no_fresh_geometry_to_report` |
  | `ReadReport::measuring` silently drops the geometry | ✅ **7** geometry tests |

  So the values those tests assert on genuinely travel through the new struct. No stale locals.

- Borrow-wise the rewrite is correct: `report.geometry.as_deref_mut()` at the store step replaces a
  move of the old `Option<&mut …>`, and the one test that had to change
  (`a_cache_hit_has_no_fresh_geometry_to_report`) now reads through `report.geometry`, which is the
  only legal read while the report holds the borrow. `read_measuring` passes
  `&mut ReadReport::measuring(&mut geometry)` as a temporary and reads `geometry` after the statement
  — sound, and M-b proves it is not vacuous.

---

# New breakage from the fix diff

**None found.**

All nine of review A's original mutations re-run against the fixed tree; **all nine still bite**, two
of them harder than before:

| # | Mutation | Bites | Failing |
|---|---|---|---|
| M1 | drop the set-membership check in `parseResult` | ✅ | **15 tests** (was 8): `leak.test.ts`, `loop.test.ts`, 12 × `ports.test.ts`, `readerClient.test.ts` |
| M2 | tally **after** `noteFailure()` | ✅ | 3: `engine.nothingRead`, `leak.test.ts`, `loop.test.ts` |
| M3 | `Err(Timeout)` arm says `CaptureError` | ✅ | `each_capture_error_says_which_step_failed`, `a_failure_before_the_capture_measured_nothing` (245/2) |
| M4 | client stops saying `helperDown` | ✅ | 8 tests across both client files |
| M5 | `matches!(reason, Failed \| Black)` in `read_line` | ✅ | `a_detail_is_never_written_on_an_answer_that_is_not_failed` (246/1) |
| M6 | remove a key from `LOG_COUNT_KEYS` (run as R1e) | ✅ | `engine.ts(73,54) TS2344` — the exact line/column — + 2 tests |
| M7 | never set `calling = "read"` | ✅ | 2 naming tests |
| M8 | `recogniseError` shares `failedCaptureError` | ✅ | 2 tests |
| M9 | `wait_for` back to `Other` | ✅ | 3 `macos::capture` tests (244/3) |

Byte scan of the 13 topic files: all valid UTF-8, **no** control bytes beyond `\n`/`\t`, no DEL, no
zero-width, no bidi, no BOM, no NBSP. Non-ASCII inventory: 271 EM DASH, 2 MINUS SIGN, 1 HORIZONTAL
ELLIPSIS, and **one** CYRILLIC CAPITAL LETTER A — `scheduler.rs:1574`, the homoglyph-repair fixture,
confirmed present at `scheduler.rs:1535` in `$S/s1/pre-fix1` and therefore pre-existing. No Greek.

---

# `macos/capture.rs`: is the behaviour identical apart from the NoContent split?

**Yes.** I stripped comments and blank lines from both `$S/s1/pre-fix1` and the current file, cut at
`#[cfg(test)]`, and diffed the code lines. The *entire* difference is:

- the two closure bodies replaced by `content_answer(content, error)` / `image_answer(image, error)`;
- those two functions added verbatim from the old bodies, with `classify` → `classify_content` on the
  content path only;
- `classify_content` added.

Nothing else moved. Specifically:

- **−3801 → `Refused`:** `classify`'s body is byte-identical (`error.code() ==
  SCStreamErrorCode::UserDeclined.0 && error.domain().isEqualToString(SCStreamErrorDomain)`), and
  `classify_content` translates only the `NoImage` arm, so the refusal cannot drift between the two
  call sites. `scheduler.rs`'s `Refused` arm still does `refused.store(true, SeqCst)` before clearing.
- **"window not in shareable content" → `Gone`:** `find_window` and `.ok_or(CaptureError::Gone)` are
  unchanged, and `Gone` still answers `windowGone`, not `failed`.
- **The 3 s waits:** `HANDLER_TIMEOUT = Duration::from_secs(3)` unchanged; `wait_for` unchanged
  (`recv_timeout(...).map(|sent| sent.0).unwrap_or(Err(CaptureError::Timeout))`), still shared by
  both framework calls.
- **`unsafe` accounting:** 12 `unsafe` tokens and 11 `SAFETY:` comments — **identical counts pre and
  post**. The two `unsafe` blocks that moved (`Retained::retain(content)`, `CFRetained::retain(image)`)
  carried their SAFETY comments with them, unchanged in wording.
- **Retain/release:** each retain still happens exactly once, on the handler's own thread, inside the
  handler's autorelease pool, with the resulting value moved straight into the channel. Drop timing is
  the same: a send to a dead receiver still returns the value in the `SendError` and releases it there.
- **Threading:** no new `Send`/`Sync`. `Sendable` is unchanged and is still the only thing crossing
  the channel. `content_answer` / `image_answer` are plain free functions taking raw pointers; the
  blocks still own what they capture (`sender` moved in), and nothing is now shared that was not
  before.

## What remains compile-verified only for the first real run

1. **Every case with a non-null `NSError`.** Constructing a real `NSError` needs the framework, so
   `classify`'s −3801 → `Refused` and its `else → Other` are still read-only. Only the null-error
   cases are executed (by the two new tests). This is the fixer's own stated limit and it is honest.
2. **That ScreenCaptureKit actually calls the blocks**, and that the blocks pass the framework's
   arguments through unmodified. R1 proves block body → extracted function, because the test calls
   the same functions the blocks call; that the framework invokes the block at all, with the argument
   order declared, is one line each and untested.
3. **`frame_of`'s geometry / provider / buffer refusal → `NoImage`** — never run against a real frame
   (an HDR or odd-stride frame would land here).
4. **`wait_for` against a genuinely hung handler** — the 3 s `HANDLER_TIMEOUT` has only ever been
   exercised with a synthetic channel.
5. **`worker.rs:170`** — see O2: the one production line that carries `report` onto the wire is
   covered by no assertion at all.
6. **A real `captureNoContent`.** Nobody has yet seen
   `getShareableContentExcludingDesktopWindows…` complete with two nulls; the variant exists on the
   strength of the completion-handler contract, not on an observation. Its appearance in a real log
   would itself be news.

---

# Other observations (not part of the five findings)

**O1 — three doc counts went stale when the fourth variant arrived.** *Minor.*
`native/reader/src/platform.rs:37-49` still says "The other **three** are all 'a failure we do not
interpret'", "Why that is worth **three** variants", "at **three** different places" — there are now
four (`Timeout`, `NoContent`, `NoImage`, `Other`). `native/reader/src/scheduler.rs:459-465`: "The
**three** arms answer identically and differ only in what they SAY" — four arms follow it.
`native/reader/src/macos/capture.rs:108-115` (`wait_for`'s doc) still describes the empty completion
as `NoImage` without mentioning that on the content path it is now `NoContent`. Worth closing because
these three comments are precisely what someone reading a real `failedCapture*` count will use to
decide which step to look at — the thing I1 exists to get right.

**O2 — the one production line that puts the report on the wire is pinned by nothing.** *Minor,
pre-existing, but m3 rewrote exactly this line.* `native/reader/src/worker.rs:170`. I mutated it three
ways — pass `None` for geometry, pass `&ReadStats::default()`, pass `None` for detail — and each time
the native suite stayed **247/247 green**. `emit` writes to stdout and no test reads it; the same hole
exists verbatim in `$S/s1/pre-fix1` (`worker.rs:169`), so this is **not** a regression. It is,
however, the single riskiest line of the m3 refactor and the only one with no runtime evidence behind
it. *Suggested fix:* one worker test that captures `emit`'s line for a `failed` read and asserts the
`detail` and `stats` reached it — it would also be the first end-to-end pin of `detail` inside the
helper.

**O3 — the two `CaptureError` sweeps are hand-enumerated.** *Nit.*
`every_way_a_capture_can_fail_forgets_the_last_window` (`scheduler.rs:1183-1196`) and
`each_capture_error_says_which_step_failed` (`:1262-1270`) list the variants literally. A seventh
variant would fail to compile in `handle_read` (no wildcard — good), but would be silently absent
from both sweeps. Nothing to do today; worth a line in whichever comment claims "EVERY way".

**O4 — the third `calling = null` (after `read`, `loop.ts:296`) is unguarded and unobservable.**
*Nit.* Nothing between it and the next `calling = "frontWindow"` can throw, and the two `!result.ok`
returns are plain returns. Recorded so nobody adds a test that cannot fail.

**O5 — `ports.test.ts:171` has no blank line before the next `it(`.** *Nit, cosmetic.*

**O6 — m4's cost is unchanged, in a new shape.** *Info.* `ReadReport` is `pub` with `pub` fields and
`Default`, so a caller can still discard every out-value by passing `&mut ReadReport::new()` — which
is exactly what 8 of the 14 test call sites do, correctly. Nothing type-checks that the values are
read. D1 already names this.

---

# Verdict

**All five findings are addressed, and addressed at the level the rulings asked for.**

I1 gives the shareable-content query its own variant, detail, wire word and log key, `captureNoImage`
is now the screenshot step and nothing else, and every link of the chain fails when reverted —
including the one the type system alone would have missed. I2's sweep bites on all six arms
individually, which is the exact property the ruling names. The two-parser split for m1 is sound:
the only production door from the wire is the narrow parser, the loop's wider re-parse cannot widen
anything because it is downstream of a rebuilt literal, and the "one parser" alternative is
demonstrably broken by a test. m2 covers both reset positions. m3 landed without a single stale
assertion — I did not take the zero-warnings argument on trust (the release build does not even
compile the test module), and proved the point directly by mutation instead.

Nothing in the fix diff broke anything: all nine of the original mutations still bite, two of them
harder, and the baseline is green on typecheck, 611 TS tests, 247 native tests and a warning-free
release build from a cleaned `target/`.

The six items above are observations, not defects in what ships. **O1** (three stale "three"s) and
**O2** (the unpinned production emit) are the two I would close before the first real run, both for
the same reason I1 existed: they are the parts a person will be relying on precisely when something
has already gone wrong on a real machine.

**Quality: Approved.**
