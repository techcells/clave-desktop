# Re-review `rust` — fix round 1, review topics 1 and 4 (`native/reader/src/**`)

Scoped re-reviewer. All work in
`/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/exec/rr-rust/app`.
Nothing under `/Users/sardorastanov/techcells/asset-to-evidence` was modified (verified: `diff -rq`
over `native/reader/src` is empty at the end, and after every single mutation). No bundle launched,
no `read`/`frontWindow` sent to a built helper, `handshake_check.py` not run, no window title and no
recognised text below. No git, no pnpm, no installs, no subagents.

Line numbers refer to `/Users/sardorastanov/techcells/asset-to-evidence/app/native/reader/src/...`.

## Gates in my copy

| Gate | Result |
|---|---|
| `build-native.mjs --test`, fresh build of the restored tree | **231 passed**, 0 failed |
| `build-native.mjs` (release) | `BUILD_NATIVE_OK`, **0 warning lines** |
| `build-native.mjs --test` build output | **0 warning lines** |
| 15 consecutive native runs under 10 spinning CPU hogs (load avg ~18) | **15 green, 0 red** |
| all `.rs` under `native/reader/src` vs the real repo | byte-identical; no stray control byte < 0x20 other than `\n`; `text.rs` still has its 55 `\u{…}` backslash escapes on disk |

---

## Verdicts

| Finding | Ruling given to the fixer | Verdict | Evidence |
|---|---|---|---|
| **T1 M1** | pin case-SENSITIVE `expect` comparison | **ADDRESSED** | `scheduler.rs:886-906` `an_expectation_that_differs_only_in_case_is_a_different_window` (three rows: app, title, bundle id upper-cased; each `windowGone`, `capture_calls == 0`, `recognise_calls == 0`). Revert: `is_approved` (`scheduler.rs:214-216`) made case-folding on all three fields → **BITES**, 230/1, exactly that test. (Under the pre-fix tree the same probe left 224 green.) |
| **T1 M2** | non-string `title` in `expect` → `None` | **ADDRESSED** | `protocol.rs:361-375`: rows `"app":null`, and `title` as `null`, `7`, `true`, `{}`, `["Staged chat"]`. The assertion is `expect: None`, not merely "still a read". Revert: `expected()` (`protocol.rs:116`) coerces `Value::Number` → **BITES**, 230/1, `a_read_without_a_usable_expectation_is_still_a_read_owed_an_answer`. |
| **T1 M3** | comment must say the capture is by window id, and that the re-check catches a title / front-window change | **ADDRESSED** | `scheduler.rs:362-371`. It now says step 3 captured one window ID so the image is of that window and no other; names the rename ("a browser tab switched, a document saved under another name") as the case 4b is load-bearing for; names the no-longer-front case as conservative rather than necessary. Accurate against the code: `scheduler.rs:323` is `platform.capture(window.window_id)`. |
| **T4 F1** | eval `lines` must be the SAME cleaned lines `text` is made of; `join("\n")` of `lines[].text` equals `text`, for a gutter frame and a whole-number-gutter frame | **ADDRESSED** | `text.rs:93-95` `assemble = join(cleaned(…))`; `scheduler.rs:417` `let kept = geometry.is_some().then(\|\| text::cleaned(&ordered));`; `scheduler.rs:449` measures `kept`. Test `scheduler.rs:1419-1452` `the_boxes_joined_are_the_answers_text_even_over_a_gutter` does **both** required frames and asserts `boxed.join("\n") == text` in each (second case: no boxes at all, empty text). Revert: boxes built from raw `ordered` again → **BITES**, 230/1, that test. |
| **T4 F2** | no fake test; the comment must name `cache.clear()` on the mismatch branch as the guard, and a test must fail when that clear is removed | **ADDRESSED** | Comment `scheduler.rs:430-440` says exactly that, names the test, and says the store's position is *not* what holds the invariant. Revert: `cache.clear()` deleted from the 8b mismatch branch (order untouched) → **BITES**, 230/1, `a_switch_after_recognition_leaves_nothing_in_the_cache_at_all` (`scheduler.rs:982-1001`). The old `a_switch_during_recognition_…` correctly stays green — with the check above the store nothing is written on that path, so only a test that *primes* the cache can see the clear, which is what the new one does. |
| **T4 F2, second half** | is "store above the re-check still does not bite" honestly stated and harmless? | **CONFIRMED honest; no retention sequence exists** | See §"The store/re-check order" below. Mutation applied: **231 passed, 0 failed** — exactly as the fixer recorded. |
| **T4 F3** | whole title hashed | **ADDRESSED** | `focus_gate.rs:314-324` `the_whole_title_is_hashed_and_not_a_prefix_of_it`. Revert: `title.chars().take(8)` hashed (`focus_gate.rs:65`) → **BITES**, 230/1, that test. |
| **T4 F4** | the timed-out-read test has no wall clock; run the native suite 15× in a row | **ADDRESSED** | `scheduler.rs:1092-1105` and `1139-1163` contain no `Instant::now()` and no `Duration` at all; the overrun is an event the fake's own step flips. **15/15 green** under 10 CPU hogs. I also checked the tests are not vacuous: disabling both switch-flips in the fake (`scheduler.rs:613`, `642`) → **BITES**, 229/2, exactly `a_budget_spent_during_the_capture_times_out_before_recognition` and `a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised`. |
| **T4 F5** (minor) | lock gating not bypassable by a parameter | **ADDRESSED** | `poll` no longer takes `locked` (`focus_gate.rs:120`); the gate owns `locked: Box<dyn Fn() -> bool>`, fixed at construction, and the single production construction is `FocusGate::new(windows::screen_is_locked)` (`macos/focus.rs:47`). Both call sites (`macos/focus.rs:105`, `:142`) now hand over only the tick. Revert: gate ignores its source (`should_observe(false)`) → **BITES**, 229/2, `a_locked_screen_is_not_even_looked_at_whichever_source_ticked` and `the_first_observation_after_an_unlock_is_judged_against_what_was_announced`. |
| **T4 F6** (minor) | `to_px` rounding pinned | **ADDRESSED** | `scheduler.rs:1455-1471` `a_box_edge_is_the_nearest_pixel_and_not_the_one_below_it`. Reverts: `.floor()` → **BITES** 230/1; `.ceil()` → **BITES** 230/1. Both exactly that test, so the rounding is pinned in both directions. |
| **T4 F7** (minor) | comment | **ADDRESSED** | `scheduler.rs:15` now "these five strings"; `FailReason` (`scheduler.rs:17-33`) has five variants. |
| **T4 F8** (minor) | `protocol.rs` module doc | **ADDRESSED** | `protocol.rs:14-21` — the `lines` request flag and the `lines` / `stats.bandPx` answer keys, why the number stayed at 2, and what an older helper does. Consistent with `Request::Read`'s own doc. |
| **T4 F9** (minor) | `CaptureError::Other` clears the cache | **ADDRESSED** | `scheduler.rs:345-352` clears, with two lines saying it is the same rule as its four siblings and what it costs. Test `scheduler.rs:1024-1031` `a_capture_that_failed_for_any_other_reason_forgets_the_last_window`. Revert: branch stops clearing → **BITES**, 230/1, that test. |

**All twelve ADDRESSED. No NOT ADDRESSED. No new Critical or Important breakage in the changed
lines of my topic.**

---

## The store / re-check order (F2's second half)

Mutation "store above the re-check, clear kept" leaves **231 passed** — the fixer's statement is
true as written. I tried to construct a retention sequence and could not. Under the mutated order
the failing path is exactly `cache.store(...)` → `still_in_front(...)` → `cache.clear()` → `return`,
and:

- the cache is single-entry (`cache.rs:51-53` `clear` sets `entry = None`), so the clear removes the
  entry the store just wrote, whatever window id or pixel hash it went in under;
- `handle_read` holds `&mut ReadCache` — an exclusive borrow — so in safe Rust no other reference to
  the cache can exist while those two statements run; there is no second reader to observe the
  transient entry, and the helper's reads are serialised on one worker thread anyway;
- there is no `checkpoint!()`, no `emit`, no I/O and no yield between the store and the re-check, so
  there is no early return that could skip the clear, and nothing is written anywhere but memory;
- the only branch that skips the clear is the one where `still_in_front` returned **true**, i.e. the
  window *is* the approved one;
- a panic inside `still_in_front` does not retain anything either: `runtime::guard` turns it into
  `die`, and an unwind drops the worker's cache with it.

Empirical confirmation: `a_switch_after_recognition_leaves_nothing_in_the_cache_at_all` — which
asserts `cache.is_empty()`, not the absence of one key — **passes under the mutation**. So the
reordering genuinely retains nothing today.

Worth recording as the boundary, not as a defect: the order stops being free the moment anything
that can return early is inserted between the store and the re-check (a `checkpoint!()` there would,
under store-above, leave an unconfirmed window's text in the cache on a cancel). That is exactly why
keeping the check above the store is the right default, and the fixer kept it. The comment at
`scheduler.rs:430-440` does not claim more than this.

---

## The two judgement calls

### 1. A `#[cfg(test)]` field in `Budget` — **sound, accept**

- Production is untouched by construction: `of_ms` → `ending`, and the field does not exist outside
  `cfg(test)`, so `Budget` in a release build is still `{ deadline: Option<Instant> }` and `spent()`
  is still one `is_some_and`. Release build is clean and warning-free.
- The production branch of `spent()` is still exercised in test builds, by
  `Budget::until(Instant::now())` at `scheduler.rs:1076` and `:1136` (already-spent budgets, which
  are deterministic), so the `cfg(test)` branch does not shadow the real one out of coverage.
- The switch is `&'static AtomicBool` from a fresh `Box::leak` per test (`scheduler.rs:1087-1089`),
  so tests cannot contaminate each other; the leak is documented and bounded (one `bool` per test in
  a process about to exit).
- It buys a real thing: both budget tests are live (disabling the fake's flips turns both red) and
  15/15 green under load, where the old shape lost the bet once in twenty-three runs.
- The only cost is that the test-build and release-build shapes of one production type differ. In a
  single-crate binary with in-crate unit tests there is no ABI surface for that to matter on.

### 2. Cleaning the lines a second time for eval-only reads — **sound, and production's `assemble` path is unchanged**

- Code-level: the new `text::cleaned` (`text.rs:108-127`) computes `texts` and `marks` from the same
  two calls in the same order, iterates the same zip, treats `Gutter::Whole` as a skip and
  `Gutter::Prefix` as the same slice, and `join` (`text.rs:135-137`) is the same `"\n"` join.
  `assemble` is `join(cleaned(lines))`.
- Evidence 1: I put the **pre-fix `assemble` body back verbatim** (from `rev-1/app/.../text.rs`) with
  the new `cleaned`/`join` still in place — **231 passed**, including
  `a_cleaned_line_keeps_the_box_it_was_recognised_in` (which asserts `join(&cleaned(x)) ==
  assemble(x)`) and `the_boxes_joined_are_the_answers_text_even_over_a_gutter`. So the new decomposition
  agrees with the old implementation over the whole existing corpus.
- Evidence 2: a temporary differential probe in my copy ran **4000 pseudo-random line sets** (gutter
  runs, whole-number columns, `3.`/`4)` lists, dates, sums, a Cyrillic homoglyph, empty lines, seven
  different left edges) and asserted both `assemble(x) == old_assemble(x)` and
  `join(cleaned(x)) == old_assemble(x)`. **All 4000 agree.** Negative control: breaking the
  `Gutter::Prefix` trim inside `cleaned` turns the probe red, so it is live. The probe and the
  restored-old-body were both removed; `text.rs` is byte-identical to the real repo.
- Cost: an ordinary read pays nothing extra for the boxes — `kept` is built only when
  `geometry.is_some()` (`scheduler.rs:417`), and the app's own client has no `lines` member. The one
  unconditional change is that `cleaned` now allocates a `Vec<Line>` where the old `assemble`
  allocated a `Vec<String>`: 32 bytes per recognised line more, transient, same output bytes.
- Keeping `assemble` as production's entry point was the right call: calling `cleaned` + `join`
  directly would have left `assemble` dead (a warning, against a zero-warning gate) or made every
  ordinary read clean twice.

---

## Observations (out of scope, no effect on the verdict)

1. **`screen_is_locked` is now called inside `gate.borrow_mut()`.** `report_focus`
   (`macos/focus.rs:71-73`) takes the `RefCell` borrow and `poll` asks `(self.locked)()` inside it,
   where the old code read the lock before the borrow. The reentrancy hazard the task-4 review
   already flagged (the borrow is held across `front_window()`) is unchanged in kind; this widens it
   by one CoreGraphics call. Still sound on one run loop, still the thing to watch for as `E_PANIC`
   in C-2b-2's first run.
2. **The poll timer asks the lock twice per tick** — once for its own early return
   (`macos/focus.rs:136`) and once inside the gate. Deliberate and documented as an optimisation
   versus the rule; one `CGSessionCopyCurrentDictionary` per second.
3. **F9 is a small production behaviour change**, correctly: a `CaptureError::Other` now costs one
   re-recognition of that window on the next read. Documented at `scheduler.rs:345-348`.
4. **A cancelled read still leaves its text in the cache** (pre-existing, from item 20; the store is
   above the last `checkpoint!()`). Unchanged by this round and still bounded by `clear_unless` and
   the 60 s idle clear; just not re-stated anywhere the fix round touched.
5. **Harness note for the exec pipeline, not a finding about the code.** My first attempt at the
   15-run check restored files with `shutil.copy2`, which preserves mtime — cargo then considered the
   crate fresh and re-ran the binary built from the *last mutation*, producing 15 identical false
   reds. Rebuilding with a `touch` gives 15/15 green. The fixer's own `fix1-mutate.py` restores with
   `write_bytes`, which updates mtime, so **their results are not affected**; anyone copying my
   method should touch after restoring.

---

## Verdict

**ALL ADDRESSED.** Twelve findings (M1–M3, F1–F9), every one verified by reverting the fix by hand
and watching the named test fail, or — for M3, F7, F8 — by reading the comment against the code it
describes. Both judgement calls are sound, and production's `assemble` path is behaviourally
identical to the pre-fix implementation on the whole existing corpus plus 4000 randomised inputs.
Zero warnings on a release build, 231 tests, 15/15 green under load.
