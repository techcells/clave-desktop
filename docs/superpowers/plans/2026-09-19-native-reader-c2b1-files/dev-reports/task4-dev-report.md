# C-2b-1 Task 4 — helper minors, and an eval-only line-geometry option

Scratch copy: `$S/ws/app/native/reader`. Nothing outside `app/native/reader/src/**` was touched.
`tools/handshake_check.py` needed no change (its `protocol: 2` expectations were already updated by
the earlier protocol-2 task; the diff it shows against the base snapshot is that task's, not mine).
`fixtures/homoglyphs.json` and the homoglyph tests in `text.rs` were not touched.

## Verification

| | |
|---|---|
| `build-native.mjs --test` | **224 passed, 0 failed**, zero warnings (checked after a forced full rebuild) |
| Baseline before this task | 194 |
| `build-native.mjs` (release) | `BUILD_NATIVE_OK`, zero warnings |
| `handshake_check.py` | **ALL CHECKS PASSED** (four scenarios; `permission` answers `denied`, as an unsigned scratch binary outside a bundle must) |

No `read` and no `frontWindow` was ever sent to a built helper; nothing captured or recognised a real
window; no title and no recognised text was printed anywhere.

### Per-module test counts

| module | before | after | added |
|---|---|---|---|
| cache | 8 | 8 | — |
| focus_gate | 9 | 14 | +5 |
| frame | 13 | 13 | — |
| input | 15 | 16 | +1 |
| macos | 5 | 5 | — |
| protocol | 36 | 45 | +10 new, −1 removed |
| scheduler | 45 | 54 | +9 |
| text | 38 | 41 | +3 |
| toolbar | 11 | 13 | +2 |
| worker | 14 | 15 | +1 |
| **total** | **194** | **224** | **+30** |

The one removed test is `protocol::the_largest_u64_id_parses`, which asserted the behaviour item 18
asks us to change. It is replaced by `the_largest_id_both_sides_can_hold_parses` and
`an_id_beyond_what_javascript_can_hold_is_ignored`.

## Files changed

| file | what |
|---|---|
| `src/text.rs` | `Line` gains `right`; `GUTTER_MIN_LINES` comment rewritten (item 16); `assemble` doc says why the homoglyph pass runs twice (item 21); 3 tests pinning the numbered-list behaviour |
| `src/toolbar.rs` | `band_px()` split out of `toolbar_text` (used by the geometry option); 2 tests |
| `src/scheduler.rs` | `handle_read` doc reworded (item 19); store moved above the final checkpoint (item 20); the double homoglyph call documented (item 21); `LineBox` / `ReadGeometry` / `to_px` and the new out-parameter (item 8); 9 tests |
| `src/protocol.rs` | `MAX_SAFE_INTEGER` bound on `non_negative_integer` (item 18); `read`'s `lines` flag; `read_line` emits `lines` and `stats.bandPx`; 10 tests |
| `src/worker.rs` | `Job.lines`, `submit(..., lines)`, geometry allocated per job and passed on to `read_line`; 1 test |
| `src/input.rs` | the parsed `lines` flag reaches `Jobs::submit`; 1 test |
| `src/focus_gate.rs` | `Focus { pid, window_id, title_hash }` + `Focus::of` + `title_hash` (item 40); `owed` is a hash; `should_observe` and `FocusGate::poll` hold the locked-screen decision (item 35); `observe` is now private; 5 tests |
| `src/macos/focus.rs` | builds `Focus` by hashing, routes both focus sources through `FocusGate::poll`, asks `focus_gate::should_observe` about the lock |
| `src/macos/recognise.rs` | fills `Line.right` from the Vision box |

## The items

**16 — the gutter comment.** Established by test first, then the comment was written to match. What
actually happens: `1 Install` / `2 Configure` / `3 Run` at the left edge **loses its numerals** (three
left-edge numbers stepping by one, whitespace right after each digit — the exact shape of a gutter);
`1. Install…` and `1) Install…` **keep every character**, because `gutter_prefix_len` requires
whitespace immediately after the digits and a full stop or bracket is not whitespace. The rule is
unchanged; the comment now states the cost and why the trade is one-sided (a stripped list still
reads in order; a gutter left in the text becomes line numbers glued to source the model then reads).

**19 — `handle_read`'s doc.** Now: silence is best effort. Cancellation is noticed only at the
checkpoints, the last of which is before the return, so a cancel landing after it still produces a
line — which is harmless because the app forgets an id the moment it cancels it. The checkpoints stop
expensive work, they do not make a line impossible.

**20 — the store moved.** Order is now recognise → assemble → post-recognition approved-window
re-check (mismatch: nothing stored, `windowGone`) → store → **final checkpoint** → answer. A spent
budget still answers `timeout` and a cancel still answers nothing; what changed is that the text the
read paid for survives. The two checkpoints that used to sit between recognition and the store are
gone: firing either of them was exactly the waste this item is about.

**21 — the double `normalise_homoglyphs`.** Both calls kept. `scheduler.rs` now says its call is the
load-bearing one (the toolbar strip is cut from those lines, so a badge's homoglyph must be repaired
before the cut) and `text::assemble`'s doc says its own call is what makes the function correct for
any caller and for its own tests, and that idempotence is what makes running both free.

**40 — the focus gate holds no title.** `Focus` is `{ pid: i32, window_id: u32, title_hash: u64 }`,
16 bytes, `Copy`, no allocation. `Focus::of(pid, window_id, &title)` hashes and the `String` is
dropped at the call site in `macos/focus.rs`, which is the only place a title ever entered the gate.
`owed` is now the held-back title's hash. Hasher: `std::collections::hash_map::DefaultHasher::new()`,
which is seeded with **fixed** keys (unlike the `RandomState` a `HashMap` uses), so equal titles hash
equally within the process — the only place the value is ever compared. **Collision cost:** one
title-change `focus` event not emitted; the app's own 5 s poll asks for the front window again and
sees the new title there. Privacy never rested on these events (the app re-reads and re-judges the
front window around every read), so the cost is a few seconds of latency, once.

Checked for other retained copies of the title in `macos/`: `windows.rs` keeps only
`static FRONTMOST_PID: AtomicI32`; the title `String` it builds is moved into the returned
`WindowInfo` and nothing else holds one. `macos/focus.rs` now keeps none.

**35 — the poll while locked.** The 1 s poll already skipped its observation while locked, but the
decision lived in macOS-only code and the notification source did not ask it at all. The decision is
now `focus_gate::should_observe(locked)` plus `FocusGate::poll(now, locked, look)`: while locked the
`look` closure is not even called (no window-list call), nothing is emitted, and nothing is cleared —
so the first observation after the unlock is compared against the last **announced** state.
`macos/focus.rs` asks `should_observe` before touching the workspace, and **both** sources now route
through `poll`, so a `NSWorkspaceDidActivateApplication` notification arriving while the screen is
locked (the login window becoming frontmost) is no longer observed. `observe` is private now, so the
lock rule cannot be gone around.

**18 — ids.** `non_negative_integer` (ids, `target`, `budgetMs`) refuses anything above
`9_007_199_254_740_991`. An id or `target` above it makes the line unusable and it is ignored like any
other unusable id; an out-of-range `budgetMs` becomes 0, as a malformed one already did. The bound and
the reason (the app parses with `JSON.parse`; an id it cannot hold is a question it can never match to
its promise) are documented on `MAX_SAFE_INTEGER` in `protocol.rs`.

**8 — the `lines` option.** `read` accepts an optional boolean `lines`; only a literal `true` counts.
When true **and** the answer is `ok` **and** this read recognised something of its own, the answer
carries `"lines":[{"text","topPx","bottomPx","leftPx","rightPx"}, …]` for the ordered,
homoglyph-repaired lines, and `"bandPx"` inside `stats`. Carried as a second out-parameter
(`Option<&mut ReadGeometry>`) exactly like `ReadStats`; `ReadAnswer` is unchanged. `Line` gained a
`right` field because a right edge cannot be reconstructed later — the recogniser already has it.
Pixel boxes are the normalised coordinates times the captured frame, rounded and clamped into the
frame. The purpose (item 30: a bookmarks bar pushing a private badge below the band, so a private
window is kept) is written on `ReadGeometry`, along with the fact that nothing new crosses the pipe:
every string is a line of the `text` the same answer already carries.

## Decisions I made, and what each costs if it is wrong

1. **A cache hit reports no `lines` and no `bandPx`, and `cacheHit: true`.** The cache holds the
   assembled text and the strip, never boxes, so a hit has no fresh geometry; reporting an older
   frame's boxes beside this frame's answer would be a measurement of the wrong frame. Documented on
   `ReadGeometry::lines`. Cost if wrong: an eval run over an unchanging staged window gets boxes on
   the first cycle only. The cure is in the harness's hands — make the pixels differ, or read once.
2. **`lines` is emitted only for `ok`.** `black` carries `stats` but stopped before the recogniser, so
   there is nothing whose position could be reported; every other failure carries neither. Cost if
   wrong: none that I can see — there is no geometry to report for a read that never recognised.
3. **`bandPx` lives inside `stats` rather than beside `lines`.** The brief specifies it; it is a
   number, so `stats`'s numbers-and-one-boolean rule is intact (`nothing_inside_stats_is_ever_a_string`
   still passes). It is set only when geometry was asked for and produced, so ordinary answers are
   byte-for-byte what they were.
4. **`Line.right` added rather than a whole `CGRect`.** Only the right edge was missing; `x` stays the
   left edge. Cost if wrong: naming — `x`/`right` is less symmetric than `left`/`right`. Renaming `x`
   would touch the gutter rules and every fixture, which is churn this task did not need.
5. **Both focus sources now honour the lock**, not just the poll. The notification source was
   previously ungated (in practice `front_window_of` already answered `None` while locked, so this is
   belt and braces). Cost if wrong: a focus event that would have been emitted at the moment of a lock
   is not; the app's own poll covers it.
6. **`DefaultHasher` rather than the crate's pixel hash.** The pixel hash is built for byte buffers and
   returns a pair; `DefaultHasher` is one `u64` for a `&str` and is already in std. The standard
   library may change the algorithm between releases, which costs nothing because the value is never
   persisted, sent or compared across runs — documented on `title_hash`.

## Mutation table — every new test shown to fail when its fix is reverted

Each mutation was applied to a `cp`-aside copy, the suite run, then the file restored and compared.
No `.bak` files remain; the suite is back to 224 passing.

| # | mutation | tests that turned red |
|---|---|---|
| 3a | put the final `checkpoint!()` back **above** `cache.store` | `scheduler::a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised`, `scheduler::a_read_cancelled_during_recognition_still_says_nothing_although_its_text_is_kept` |
| 3b | `cache.store` **before** the post-recognition approved-window re-check | `scheduler::a_switch_during_recognition_throws_the_text_away_and_remembers_nothing` |
| 5 | compare only pid and window id, ignoring the title hash | `focus_gate::a_different_title_is_a_change_and_the_same_title_is_not`, `…a_held_back_title_change_is_announced_at_the_first_poll_after_the_interval`, `…a_title_change_inside_the_interval_is_held_back_and_remembered`, `…a_title_that_returns_to_the_announced_one_owes_nothing`, `…a_window_change_restarts_the_interval_for_titles` |
| 6 | observe while locked (drop the `should_observe` guard in `poll`) | `focus_gate::a_locked_screen_is_not_even_looked_at`, `focus_gate::the_first_observation_after_an_unlock_is_judged_against_what_was_announced` |
| 7 | accept any `u64` again (`<= u64::MAX`) | `protocol::an_id_beyond_what_javascript_can_hold_is_ignored`, `protocol::a_budget_beyond_what_javascript_can_hold_becomes_zero` |
| 8a | a read that did not ask is measured anyway (`lines` defaults to `true`) | `input::only_a_read_that_asked_for_geometry_queues_a_job_that_measures`, `protocol::asking_for_geometry_is_a_boolean_and_nothing_else_will_do`, and 6 more parser tests |
| 8b | let a failure carry what a successful read measured (`let measured = geometry;`) | `protocol::no_failure_ever_carries_boxes_or_a_band` |
| bonus | measure a box's horizontal edges against the frame's **height** | `scheduler::the_boxes_are_the_normalised_lines_multiplied_by_the_captured_frame` |

Note on 8b: `lines` is inserted only inside `read_line`'s `Ok` arm, so "emit `lines` on `black`" is
not reachable by reverting one expression — the gate that *is* revertible is `measured`, and reverting
it puts `bandPx` on a `black` answer. `no_failure_ever_carries_boxes_or_a_band` asserts the absence of
both keys for all five reasons, so it is the test that bites either way.

Item 16's tests have no fix to revert — the code was deliberately left alone and only the comment
changed — so they are pinning tests, not regression tests. They were written before the comment and
they decided what it says. Items 19 and 21 are comment-only for the same reason.

## macOS lines that are compile-verified only

Never executed here; no screen, no window, no capture. **No `unsafe` block was added or changed** —
the `unsafe` count in both files is identical to the base snapshot, and every existing SAFETY line is
untouched.

`src/macos/focus.rs`
- line 21 — the `focus_gate::{self, …}` import
- lines 66–73 — `report_focus`: the `FocusGate::poll` call, the closure that looks up the front window
  and builds `Focus::of(frontmost_pid(), window_id, &title)`, and the `if news { emit(…) }`
- line 101 — the notification source's call, passing `windows::screen_is_locked()`
- lines 130–131 — the poll timer reading the lock once and asking `focus_gate::should_observe`
- line 137 — the poll timer's call, passing the same `locked`

`src/macos/recognise.rs`
- line 108 — `right: box_.origin.x + box_.size.width`

Everything these lines decide is tested without a screen in `focus_gate.rs` (the lock rule, the
change rule, the hash) and in `scheduler.rs`/`toolbar.rs` (what a `right` edge becomes in pixels).
What is not verified is that the real Vision box's `size.width` is what I assume and that
`screen_is_locked()` answers truthfully inside the notification block — both are the kind of thing
only the next real run can show.

## Not done / notes for the reviewer

- **No TypeScript change.** `read`'s `lines` is additive and the app never sends it; the answer for
  every read the app does send is byte-for-byte what it was. If the eval harness is to be driven from
  TypeScript, the client will need to be able to send `lines` and to carry `lines` / `stats.bandPx`
  back — that is a separate task and it is not in this brief.
- **No `READER_PROTOCOL` bump.** The vocabulary grew again (`lines` in, `lines` and `bandPx` out), all
  of it optional and ignorable by an older app. This is review item 25's situation exactly, and it
  still stands: the number must be revisited if the helper is ever shipped separately from the bundle.
- **Item 30 is not closed by this**, only made measurable. Nothing here changes the band, and no real
  browser toolbar was measured.
- The mutation harness used for the table is at `$S/work/mutate.py`.
