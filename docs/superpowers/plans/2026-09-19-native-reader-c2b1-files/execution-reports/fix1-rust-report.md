# Fix round 1 — Rust helper crate (review topics 1 and 4)

Fixer: Rust crate only. Files touched, all under
`/Users/sardorastanov/techcells/asset-to-evidence/app/native/reader/src/`:
`scheduler.rs`, `text.rs`, `protocol.rs`, `focus_gate.rs`, `cache.rs`, `macos/focus.rs`.
Nothing outside that set. No git. No bundle launched, no `read`/`frontWindow` sent to a built
helper, no window title and no recognised text printed. The only thing run against the binary is
`tools/handshake_check.py`.

Gates, final state:

| gate | result |
|---|---|
| `pnpm --dir app test:native` | **231 passed**, 0 failed |
| `pnpm --dir app build:native` | `BUILD_NATIVE_OK`, **zero warnings** |
| `handshake_check.py` on that binary | **ALL CHECKS PASSED** |

Per-module test counts (231): cache 8 · focus_gate 15 · frame 13 · input 16 · macos::capture 5 ·
protocol 45 · scheduler 59 · text 42 · toolbar 13 · worker 15.
Baseline before this round was 224. Seven tests added, one rewritten (the locked-screen test).

Every mutation below was applied with an exact-string replacement by
`scratchpad/exec/fix1-mutate.py`, the suite run, and the file restored and compared byte for byte
(the script prints `restored byte-identical: True` for each). After the last mutation all six files
were re-checked for stray control bytes and decoded escapes: no byte < 0x20 other than `\n`, and the
`\u{…}` forms in `text.rs` (92 of them) and `scheduler.rs` (3) are still backslash escapes on disk.

---

## Topic 1

### M1 — the `expect` comparison is now pinned as case-SENSITIVE — ADDRESSED

- Test added: `scheduler::tests::an_expectation_that_differs_only_in_case_is_a_different_window`
  (`scheduler.rs:889`). Three rows — app, title and bundle id upper-cased — each must answer
  `windowGone` with `capture_calls == 0` and `recognise_calls == 0`.
- No production change: the code was already correct.
- Revert proof — mutation "`is_approved` compares all three fields case-folded" (`scheduler.rs:175`):
  **BITES**, 229 passed / 1 failed, exactly
  `an_expectation_that_differs_only_in_case_is_a_different_window`. Before this round the same
  mutation left the suite green.

### M2 — a non-string `title` (and a null `app`) parse to `None` — ADDRESSED

- Rows added to `a_read_without_a_usable_expectation_is_still_a_read_owed_an_answer`
  (`protocol.rs:363-372`): `"app":null`, and `"title"` as `null` (already there), `7`, `true`, `{}`
  and `["Staged chat"]`. Comment above them says why the table is there.
- Revert proof — mutation "`expected()` stringifies a numeric title" (`protocol.rs:108`):
  **BITES**, 229 / 1, `protocol::tests::a_read_without_a_usable_expectation_is_still_a_read_owed_an_answer`.
  The reviewer's probe (iv) left all 224 green before.

### M3 — the step-4b comment corrected — ADDRESSED

`scheduler.rs:362-370`. It now says: step 3 captured one window id, so the image is of that window;
what a 230 ms capture leaves time to change is what the window CARRIES — a title that changed since
main judged it (a tab switched, a document renamed) — and that is the case 4b is load-bearing for.
It also names the second case (the approved window no longer in front) as conservative rather than
necessary. Comment only, no test.

---

## Topic 4

### F1 — the eval's boxes are now the lines the answer's `text` is made of — ADDRESSED

- `text.rs`: `assemble` split into `cleaned` (`text.rs:108`, the same lines after homoglyph repair
  AND the gutter rules, each keeping its box) and `join` (`text.rs:129`). `assemble` is now
  `join(&cleaned(lines))` — same behaviour, same tests, all of `text.rs`'s existing assertions
  untouched.
- `scheduler.rs:411-417`: `body` still comes from `text::assemble(&ordered)` so an ordinary read
  does exactly one cleaning pass; `let kept = geometry.is_some().then(|| text::cleaned(&ordered));`
  computes the cleaned lines only for a read that asked for boxes, and `scheduler.rs:450` measures
  `kept` instead of `ordered`.
- Docs corrected to the now-true claim: `ReadGeometry` (`scheduler.rs:86-93`) and
  `protocol::line_box_value` (`protocol.rs:214-216`).
- Tests added:
  - `scheduler::tests::the_boxes_joined_are_the_answers_text_even_over_a_gutter`
    (`scheduler.rs:1422`) — a three-line editor gutter (boxes come back stripped, joined they are
    `text`) and a whole-number gutter column (no boxes at all, joined they are the empty `text`).
    Uses `join`, not `split`, so the empty case is meaningful.
  - `text::tests::a_cleaned_line_keeps_the_box_it_was_recognised_in` (`text.rs:675`) — the box of a
    stripped line is the box it was recognised in, a dropped line takes its box with it, and
    `join(&cleaned(x)) == assemble(x)`.
- Revert proof — mutation "boxes built from the raw `ordered` lines again": **BITES**, 230 / 1,
  `the_boxes_joined_are_the_answers_text_even_over_a_gutter`.

### F2 — no fake test; the comment now names the real guard — ADDRESSED

- `scheduler.rs:431-440`: the comment no longer claims the store's position is what holds the
  invariant. It states that `cache.clear()` on the mismatch branch is the guard, that moving the
  store above the check leaves every test green while removing the clear does not, and names the
  test. The **order is unchanged** — the check stays above the store, because "nothing is remembered
  until the window has been confirmed" is the honest reading order and it costs nothing.
- `cache.rs:55-64`: `#[cfg(test)] fn is_empty()`, so a test can assert the invariant about the cache
  rather than about one key in it.
- Test added: `scheduler::tests::a_switch_after_recognition_leaves_nothing_in_the_cache_at_all`
  (`scheduler.rs:983`). It primes the cache with THIS window's own earlier text (window id 11, so
  `clear_unless` keeps it), lets the read recognise, and switches the window on the third
  `front_window` call; only the mismatch branch's `clear()` can empty the cache afterwards.
- Revert proofs, both run:
  - "mismatch branch stops clearing, order untouched": **BITES**, 230 / 1,
    `a_switch_after_recognition_leaves_nothing_in_the_cache_at_all` — which is the ruling's
    requirement (the new test fails when the clear is removed, wherever the store sits).
  - "store moved ABOVE the re-check, clear kept" (the dev report's mutation 3b): **still does not
    bite**, 231 passed. Recorded deliberately: that is the reviewer's finding, it is now what the
    comment says, and the test is independent of it.

### F3 — the whole title is hashed — ADDRESSED

- Test added: `focus_gate::tests::the_whole_title_is_hashed_and_not_a_prefix_of_it`
  (`focus_gate.rs:315`), the reviewer's test verbatim in substance (hash inequality plus a gate
  observation ten seconds later, outside the interval).
- Revert proof — mutation "hash only the first 8 characters" (`focus_gate.rs:65`): **BITES**,
  230 / 1, `the_whole_title_is_hashed_and_not_a_prefix_of_it`.

### F4 — the two budget tests no longer read a clock — ADDRESSED

Decision I made, stated plainly: the ruling asked for "`Budget::until` + a fake platform that lets
the test control when recognition ends, no wall-clock sleeps or 5 ms budgets". A shared deadline
plus a busy-wait would still have contained one bet — that the read reaches the recogniser before
the deadline — so I injected the deadline as an EVENT instead of an instant, which removes the bet
entirely and costs no wall-clock time at all. `Budget::until` is unchanged and still used by
`a_budget_that_is_already_spent_times_out_before_anything_happens` and
`cancellation_outranks_a_spent_budget`.

- `scheduler.rs:118-186`: `Budget` gains a `#[cfg(test)]` field `overrun: Option<&'static AtomicBool>`
  and `Budget::until_the_platform_says_so(switch)`; `spent()` returns true once the switch is set.
  Production construction goes through `Budget::ending`, so `of_ms` is unchanged in behaviour and
  the field does not exist outside `cfg(test)`.
- The fake's `spin_in_capture` / `spin_in_recognise` (busy-wait until an instant) are replaced by
  `overrun_in_capture` / `overrun_in_recognise`, flipped while `capture` runs and as `recognise`
  hands its lines back. No spin loops remain in the crate.
- `a_budget_spent_during_the_capture_times_out_before_recognition` and
  `a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised` now
  contain no `Instant::now()` and no duration at all: the step itself says the read overran.
- Proofs:
  - mutation "final `checkpoint!()` back above `cache.store`" (the dev's 3a, the thing these tests
    exist to pin): **BITES**, 229 / 2, exactly
    `a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised` and
    `a_read_cancelled_during_recognition_still_says_nothing_although_its_text_is_kept`. The tests
    still test what they tested.
  - mutation "the fake stops flipping the recognition switch": **BITES**, 230 / 1 — the overrun is
    what the test asserts, not an accident of the run.
  - 12 consecutive full native runs under 16 spinning CPU hogs: **12 green, 0 red**. The reviewer's
    deterministic probe (`let deadline = Instant::now();`) is no longer expressible: there is no
    deadline in either test.

### F5 (minor) — the lock gate cannot be bypassed by a parameter — ADDRESSED

- `focus_gate.rs:91-129`: `FocusGate` now OWNS its lock source (`locked: Box<dyn Fn() -> bool>`,
  fixed by `FocusGate::new(locked)`), and `poll` no longer takes a `locked` argument — it asks the
  source itself, on every tick, whoever caused the tick. The bypass the reviewer demonstrated
  (passing `false` from one source) is not expressible any more; there is no argument to get wrong.
  `#[derive(Debug, Default)]` dropped, since neither is derivable with a boxed closure and neither
  was used.
- `macos/focus.rs`: the gate is built once with the real source
  (`FocusGate::new(windows::screen_is_locked)`, `focus.rs:43-47`); `report_focus` lost its `locked`
  parameter (`focus.rs:71`) and both call sites — the activation notification (`focus.rs:105`) and
  the poll timer (`focus.rs:142`) — now just hand over the tick. The timer keeps its own
  `should_observe(windows::screen_is_locked())` early return (`focus.rs:136`) so a locked screen
  still costs no preflight and no workspace refresh; the comment says explicitly that this is an
  optimisation and the gate's own ask is the rule.
- **Compile-verified only** (no test can reach them without a screen; they are the lines to watch in
  C-2b-2's first run): `macos/focus.rs:47` (the wiring of `screen_is_locked` into the gate),
  `focus.rs:105` and `focus.rs:142` (the two `report_focus` calls), and `focus.rs:136` (the timer's
  early return). What was convention is now one line of wiring instead of two call sites that had to
  agree.
- Test rewritten: `focus_gate::tests::a_locked_screen_is_not_even_looked_at_whichever_source_ticked`
  (`focus_gate.rs:329`) — a gate whose lock state the test owns; two ticks standing for the two
  sources see nothing and do not even call `look`; the unlock is noticed on the next tick without any
  other event. `the_first_observation_after_an_unlock_is_judged_against_what_was_announced` was moved
  onto the same switchable gate.
- Revert proof — mutation "the gate ignores its lock source (`should_observe(false)`)": **BITES**,
  229 / 2, `a_locked_screen_is_not_even_looked_at_whichever_source_ticked` and
  `the_first_observation_after_an_unlock_is_judged_against_what_was_announced`.

### F6 (minor) — `to_px` rounding pinned — ADDRESSED

- Test added: `scheduler::tests::a_box_edge_is_the_nearest_pixel_and_not_the_one_below_it`
  (`scheduler.rs:1456`). One line whose four edges are 2.4 px, 6.56 px, 100.4 px and 116.6 px: two
  must round down and two up.
- Revert proofs — `.floor()` in place of `.round()`: **BITES**, 230 / 1; `.ceil()`: **BITES**,
  230 / 1. Both exactly `a_box_edge_is_the_nearest_pixel_and_not_the_one_below_it`.

### F7 (minor) — "four reasons" → five — ADDRESSED

`scheduler.rs:15`. Comment only; `FailReason` has five variants and
`protocol::tests::the_five_failure_reasons` already says so.

### F8 (minor) — `protocol.rs` module doc — ADDRESSED

`protocol.rs:15-22`: a paragraph on what was added since 2 without moving the number — the `lines`
request flag and the `lines` / `stats.bandPx` answer keys — why the number stayed (nothing two sides
must agree on; the app's own client has no `lines` member and cannot ask; an answer to a read that
did not ask is byte for byte what it was), and what an older helper does with it.

### F9 (minor) — `CaptureError::Other` clears the cache — ADDRESSED

- `scheduler.rs:349-356`: the branch now clears, with two lines saying why it is the same rule as its
  four siblings and what it costs (at most one re-recognition of a window whose capture is failing).
- Test added: `scheduler::tests::a_capture_that_failed_for_any_other_reason_forgets_the_last_window`
  (`scheduler.rs:1024`).
- Revert proof — mutation "the `Other` branch stops clearing": **BITES**, 230 / 1, that test.

---

## Decisions and residue

- **The store/check order was left as it is** (check above store). F2's ruling asked for "the
  simplest honest order": the current one needs no change, reads correctly, and the comment now
  attributes the guarantee to the `clear()` that actually provides it.
- **`assemble` kept as production's entry point.** Making the scheduler call `cleaned`+`join`
  directly left `assemble` dead (a build warning, and the gate is zero warnings) and would have
  cleaned every ordinary read's lines twice. The scheduler now pays for `cleaned` only when the eval
  asked for boxes; `assemble` IS `join(cleaned(…))`, so the correspondence is by construction and the
  new test pins it end to end.
- **`Budget` carries a `#[cfg(test)]` field.** That is an intrusion into a production type, made
  deliberately: it is the only way to say WHERE a read overran without a clock, it cannot exist in a
  release build, and the alternative was leaving a wall-clock bet in the suite the plan's gate is a
  literal test count of.
- **One byte leaked per budget test** (`Box::leak` for the `&'static AtomicBool`), documented at
  `scheduler.rs:1087`; a `Budget` is `Copy` and travels by value, so the switch cannot be borrowed
  from the test's stack.
- Nothing outside the crate needed touching; no file outside my set was modified.
