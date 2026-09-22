# Task 4 review — helper minors and the eval-only `lines` option

Reviewer: independent, N = 4. Work done in
`/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/exec/rev-4/app`.
Nothing under `/Users/sardorastanov/techcells/asset-to-evidence` was modified. No `read` and no
`frontWindow` was sent to a built helper, no bundle was launched, no window title and no recognised
text is printed below.

Baseline in the copy before any mutation: `build-native.mjs --test` → **224 passed, 0 failed**.
After every mutation was restored: **224 passed**, `build-native.mjs` → `BUILD_NATIVE_OK`, zero
warnings, and all thirteen files I touched or read `cmp`-identical to the real repo
(`text.rs scheduler.rs worker.rs protocol.rs focus_gate.rs toolbar.rs input.rs macos/focus.rs
macos/recognise.rs cache.rs platform.rs runtime.rs macos/windows.rs`).

---

## 1. The questions

### Q1. With the store above the final checkpoint, is there any way text of a window that failed the post-recognition re-check is stored?

**No.** `scheduler.rs:373–376` is the re-check and it `return`s; `scheduler.rs:380` is the store.
Nothing between them. Every other exit that could reach the store (`locked` 240, `preflight` 252,
no `expect` 260, no front window 266, not approved 273, `Refused` 292, `Gone` 302, black 312,
post-capture mismatch 321, recogniser error 339) returns earlier.

One correction to the developer's account, though: what actually enforces the invariant is the
`cache.clear()` inside the mismatch branch, **not** the position of `cache.store`. Moving the store
above the re-check leaves all 224 tests green (see mutation 3b below); deleting the `cache.clear()`
from that branch is what turns the test red. The comment at `scheduler.rs:371–372` ("This check is
ABOVE the store and must stay there: storing first would leave an unapproved window's text in the
cache") is therefore stronger than the code needs and than any test checks.

### Q2. Does a cancelled job still answer nothing?

**Yes.** The last `checkpoint!()` (`scheduler.rs:411`) returns `None` for a cancel, and
`worker::turn` emits only `if let Some(answer)` (`worker.rs:164–166`). Proven by mutation 3a, which
turns `a_read_cancelled_during_recognition_still_says_nothing_although_its_text_is_kept` red. The
doc at `scheduler.rs:191–196` is honest that silence is best effort — a cancel landing after line
411 still produces a line, and the app drops it by id.

Note the consequence of item 20 that is not spelled out anywhere: a *cancelled* read now also
leaves its text in the cache (the store at 380 runs before the cancel is noticed at 411). That is
deliberate and tested, but it means "cancelled" no longer implies "nothing was kept", only "nothing
was said". `worker.rs:129` (60 s idle clear) and `clear_unless` remain the retention bound.

### Q3. Does any `String` holding a title outlive `Focus::of` in `macos/focus.rs`?

**No.** Grepped the whole crate:

- statics: only `macos/windows.rs:45 static FRONTMOST_PID: AtomicI32` (a number) and the two
  AppKit `&'static NSString` externs at `macos/focus.rs:155–156` (framework constants).
- `macos/focus.rs:67–70`: the `WindowInfo` is a local of the `look` closure; `Focus::of` hashes the
  title (`focus_gate.rs:51–53`) and the closure's `String`s drop at its end. `Focus` is
  `{i32,u32,u64}` and `focus_gate.rs:275` pins `size_of::<Focus>() == 16`, which a `String` field
  could not survive.
- captured closures: the two `RcBlock`s capture `gate: Rc<RefCell<FocusGate>>` and
  `platform: MacPlatform` (`macos/mod.rs:104` — a unit struct). Neither holds a string.
- last-seen struct: `FocusGate { announced: Option<Focus>, owed: Option<u64>, last_emit }` —
  `owed` is a `u64` hash (`focus_gate.rs:90`).

The only places in the helper that still hold a window title at all are transient and required:
`protocol::Expected` inside `worker::Jobs.slots.{queued,running}` for the duration of one read
(`worker.rs:64, 84`, dropped by `finished()` at `worker.rs:102–105`, called unconditionally at
`worker.rs:167`), and the `WindowInfo` inside a `ReadAnswer::Ok` until the line is written. Neither
survives a poll. `macos/windows.rs:160–166` builds the title and moves it straight into the returned
`WindowInfo`, keeping nothing.

### Q4. Do both focus sources reach the gate only through `poll`?

**Yes, in the code.** `observe` is private (`focus_gate.rs:120`) and the only non-test caller is
`poll` itself (`focus_gate.rs:113`). Both `macos/focus.rs:101` (notification) and
`macos/focus.rs:137` (timer) go through `report_focus` → `poll`.

**But the lock rule at those two call sites is not enforced by construction and is not tested at
all** — `poll` takes `locked` as a parameter from its caller, and passing `false` from the
notification source leaves the whole suite green (independent probe (ii); Finding 5).

### Q5. Can `lines` or `bandPx` appear on anything but an un-cached `ok` answer that asked for it?

**No**, on every path I could find:

- `lines: true` reaches a job only from a literal JSON `true` (`protocol.rs:93`,
  `asking_for_geometry_is_a_boolean_and_nothing_else_will_do`); `input.rs:85` passes it to
  `Jobs::submit`; `worker.rs:153` allocates `ReadGeometry` only `job.lines.then(...)`, so an
  ordinary read hands `None` to the scheduler and the geometry code never runs.
- the geometry block (`scheduler.rs:381–396`) sits after the cache-miss branch, so a hit
  (`scheduler.rs:330–333`) returns with `ReadGeometry::default()` — `lines: None, band_px: None`.
- `protocol.rs:174–177` sets `measured = None` for every `Fail`, so no failure — `black` included —
  can carry either key; `lines` is inserted only inside the `Ok` arm (`protocol.rs:188–190`) and
  `bandPx` only from `measured` (`protocol.rs:200`).
- the app **cannot ask**: `src/main/reader/protocol.ts:9` types the outgoing `read` as
  `{id, op, budgetMs, expect}` with no `lines` member, and `readerClient.ts:401` sends exactly that
  object literal. D11's "the app's client cannot send it" holds by type.

The timeout path is the one worth naming: geometry **is** filled at `scheduler.rs:381` before the
budget is noticed at 411, but the answer is then `Fail(Timeout)` and `protocol.rs:174–177` drops it.
Pinned by `no_failure_ever_carries_boxes_or_a_band`.

### Q6. The compile-verified-only lines, against spec 5.5 and plan C-2a's D7

**D7 (no `NSWorkspace` call off the main thread) is upheld.** The only AppKit calls are
`macos/windows.rs:62–77 refresh_frontmost_pid` (documented main-thread-only, called from the
notification block and the timer, both on the run loop's thread) and the observer installation at
`macos/focus.rs:79–82`. The line this task added to the notification block,
`windows::screen_is_locked()` (`macos/focus.rs:101`), is `CGSessionCopyCurrentDictionary` —
CoreGraphics, safe on any thread (`macos/windows.rs:105–121`). The closure's
`front_window_of` → `windows::front_window()` uses `CGWindowListCopyWindowInfo` and
`NSRunningApplication` (documented thread-safe). Nothing new crosses the AppKit boundary.

**Spec 5.5** says "The check pauses while the screen is locked", of the 1 s poll. Extending the
pause to the notification source is a superset of the spec and matches D12; spec section 5.5 needs
the dated note the plan's Task 10 already schedules.

**Concerns to carry into C-2b-2's first run** (line by line, `macos/focus.rs`):

- **21** — import only; no risk.
- **66–73 `report_focus`** — new hazard, not present before: `gate.borrow_mut()` is now held
  **across** the window-server call, because `look()` runs inside `poll`. On one run loop the timer
  block and the notification block cannot interleave, so this is sound today; but if anything inside
  `front_window()` ever pumps the run loop, the second entry is a `BorrowMutError`, and
  `runtime::guard` turns any panic into `die("E_PANIC", 70)` — the helper exits, loudly, mid-read.
  Worth watching for `E_PANIC` in the first real run.
- **101** — whether `CGSSessionScreenIsLocked` is already set at the instant the login window's
  activation notification is delivered. If it is not, the login window becomes the gate's
  `announced` state and the first tick after the unlock emits one spurious `focus` for the user's
  own window. Harmless (one extra read of an approved window), but it is the behaviour the item-35
  change is meant to remove, so it is the thing to look for.
- **130–131, 137** — the lock is read once per tick and reused for both the early return and
  `report_focus`; a lock that happens between the two is caught by the next tick. Same shape as
  before, no new risk.
- **`macos/recognise.rs:108`** `right: box_.origin.x + box_.size.width` — consistent with the
  existing `x: box_.origin.x` and with the fact that only y is flipped. The open question is
  Vision's `boundingBox` for skewed or rotated text: it is documented as the axis-aligned bounds, so
  `right` should stay ≤ 1.0, and `to_px` clamps anything that is not. `Line.right` is now filled on
  **every** read, not only eval reads, but no reading rule consults it (`order` uses `top`/`x`,
  `toolbar_text` uses `bottom`), so the app's answers are unchanged — which the byte-exact protocol
  tests confirm.

---

## 2. Mutation table — the developer's eight

Each applied in the scratch copy with an exact-string edit, suite run, file restored from a pristine
snapshot and `cmp`-compared with the real repo.

| # | mutation | result |
|---|---|---|
| 3a | final `checkpoint!()` back **above** `cache.store` | **BITES** — exactly the 2 named tests (`a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised`, `a_read_cancelled_during_recognition_still_says_nothing_although_its_text_is_kept`); 222 passed, 2 failed |
| 3b | `cache.store` **before** the post-recognition re-check | **DID NOT BITE** — 224 passed, 0 failed. See Finding 2 |
| 3b′ (mine) | same, plus dropping `cache.clear()` from the mismatch branch | BITES — `a_switch_during_recognition_throws_the_text_away_and_remembers_nothing`; this identifies the real guard |
| 5 | compare only pid and window id, ignoring the title hash | **BITES** — exactly the 5 named `focus_gate` tests; 219 passed, 5 failed |
| 6 | drop the `should_observe` guard in `poll` | **BITES** — `a_locked_screen_is_not_even_looked_at`, `the_first_observation_after_an_unlock_is_judged_against_what_was_announced`; 222 passed, 2 failed |
| 7 | accept any `u64` again | **BITES** — `an_id_beyond_what_javascript_can_hold_is_ignored`, `a_budget_beyond_what_javascript_can_hold_becomes_zero`; 222 passed, 2 failed |
| 8a | `lines` defaults to `true` | **BITES** — 8 tests: the 2 named plus `the_four_question_ops_parse`, `an_approved_window_without_a_bundle_id_…`, `an_empty_title_is_a_real_expectation`, `a_read_without_a_usable_expectation_…`, `an_unusable_budget_becomes_zero`, `a_budget_beyond_what_javascript_can_hold_…` (matches "and 6 more parser tests") |
| 8b | `let measured = geometry;` | **BITES** — `no_failure_ever_carries_boxes_or_a_band`; 223 passed, 1 failed |
| bonus | horizontal edges measured against the frame's **height** | **BITES** — `the_boxes_are_the_normalised_lines_multiplied_by_the_captured_frame`; 223 passed, 1 failed |

Seven of eight bite as claimed. One does not.

---

## 3. Independent probes (the three the developers never saw)

| probe | result |
|---|---|
| (i) hash only the first 8 characters of the title | **DID NOT BITE** — 224 passed. Finding 3 |
| (ii) let the notification source observe while locked (pass `false` for `locked` at `macos/focus.rs:101`) | **DID NOT BITE** — 224 passed. Finding 5 |
| (iii) round pixel boxes down (`.floor()`) instead of `.round()` | **DID NOT BITE** — 224 passed. **Which test pins the rounding? None.** Finding 6 |

For (iii), one run under this mutation produced an unrelated red —
`scheduler::a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised` —
which `to_px` cannot reach (it is only called from the geometry block, and that test passes `None`).
That is Finding 4, a flaky test; twenty-two later runs (twelve of them under 24 spinning CPU hogs)
were green, so the window is narrow but real, and I reproduced the mechanism deterministically.

### Further probes of my own

- **Boxes vs the answer's `text` (Finding 1).** A three-line editor gutter staged through
  `read_measuring`: `text` came back as three stripped lines while `geometry.lines` carried the
  numerals; with whole-number gutter lines, `text` was empty (one element) while `geometry.lines`
  held three boxes.
- **The whole-title test (fix for Finding 3).** `the_whole_title_is_hashed_and_not_a_prefix_of_it`
  — fails under probe (i), passes on the real code (225 passed).
- **The wall-clock demonstration (Finding 4).** A copy of the budget test with the deadline already
  in the past answers `timeout` with `recognise_calls == 0`, i.e. the real test's later two
  assertions are timing assumptions, not consequences of the code.
- **Retention sweep.** `grep` over the crate for `static`, `thread_local`, and every struct field of
  type `String`/`Option<String>`: see Q3. Nothing retains a title across a poll.
- **Reachability of `lines` from the app.** The outgoing `ToHelper` type has no `lines` member, so
  the option is unreachable from production TypeScript (Q5).

---

## 4. Findings

### Important

**F1 — the eval's `lines` boxes are not the lines of the answer's `text`, and the count can differ.**
`scheduler.rs:381–393` builds the boxes from `ordered`, which has had homoglyph repair but **not**
`text::assemble`'s gutter rules (`text.rs:93–106`: `Gutter::Whole` drops a line entirely,
`Gutter::Prefix` trims its head). So:

- `scheduler.rs:86–88` ("**Nothing new crosses the pipe.** Every string here is one of the lines of
  the same text the answer already carries under `text`, after the same homoglyph repair, in the
  same order") and `protocol.rs:206–207` ("it is a line of the `text` the same answer already
  carries — never anything the app has not already been told") are **false** whenever the gutter
  rule fires;
- worse for the instrument itself, `text.split("\n")` and `lines` can have different lengths, so any
  index correspondence C-2b-2 relies on silently mis-aligns.

`every_box_carries_a_line_of_the_text_the_answer_already_carries` (`scheduler.rs:1269–1283`) does
assert the correspondence, but only for input that is not a gutter candidate.

*Reproducing probe* (verified, red on today's code):

```rust
#[test]
fn boxes_are_the_lines_of_the_answers_text() {
    let fake = FakePlatform::new().lines(vec![
        line("1 fn main() {", 0.02, 100.0, 116.0),
        line("2 let x = 1;",  0.02, 120.0, 136.0),
        line("3 }",           0.02, 140.0, 156.0),
    ]);
    let (answer, geometry) = read_measuring(&fake);
    let (_, text, _) = ok_of(answer);
    let boxed: Vec<String> =
        geometry.lines.expect("geometry was asked for").iter().map(|b| b.text.clone()).collect();
    assert_eq!(text.split('\n').collect::<Vec<_>>(), boxed);
}
// left  = ["fn main() {", "let x = 1;", "}"]
// right = ["1 fn main() {", "2 let x = 1;", "3 }"]
// with the three lines replaced by "1" / "2" / "3":
// left  = [""]            right = ["1", "2", "3"]
```

*Suggested fix*: make the boxes come out of the same pass `assemble` uses — compute the gutter marks
once, drop the `Gutter::Whole` lines from the boxes and trim the `Gutter::Prefix` heads — so the
claim is true and `lines[i]` is `text.split("\n")[i]`. If instead the raw recogniser lines are
wanted, say so in both doc comments and add the probe above inverted (asserting they differ, and
why), so nobody builds an index correspondence on it. Either way the fix needs the test.

**F2 — the developer's mutation 3b does not bite; the ordering it claims to pin is untested.**
`scheduler.rs:373–380`. Applying exactly the mutation the dev report names ("`cache.store` before
the post-recognition approved-window re-check") leaves 224 passing, because `cache.clear()` in the
mismatch branch undoes the store. The row in `task4-dev-report.md` is therefore wrong, and the
"must stay there" comment at `scheduler.rs:371–372` is unverified.

*Reproducing probe*: move the `cache.store(...)` line above the `if !still_in_front(...)` block —
suite stays green. Remove the branch's `cache.clear()` as well and
`a_switch_during_recognition_throws_the_text_away_and_remembers_nothing` turns red.

*Suggested fix*: either correct the dev report's row and the comment to name `cache.clear()` as the
guard, or add a test that actually pins the order — e.g. a fake whose third `front_window` call
asserts the cache is still empty at that moment.

**F3 — nothing pins that the WHOLE title is hashed.** `focus_gate.rs:63–67`. Hashing only the first
8 characters leaves all 224 tests green: no test pair shares a prefix. Titles that differ late are
exactly the common case — "Untitled Document 1" / "Untitled Document 2", a path whose last segment
changed, a tab whose counter moved — and a weakened digest would silently stop announcing those
changes for as long as the window stayed in front.

*Reproducing probe*: replace `title.hash(&mut hasher)` with
`title.chars().take(8).collect::<String>().hash(&mut hasher)` → 224 passed.

*Suggested fix* (written and verified in my copy: red under the mutation, green on the code, 225
passed):

```rust
#[test]
fn the_whole_title_is_hashed_and_not_a_prefix_of_it() {
    assert_ne!(title_hash("Untitled Document 1"), title_hash("Untitled Document 2"));
    let (mut gate, t0) = (FocusGate::new(), Instant::now());
    assert!(gate.observe(t0, &focus(10, 1, "Untitled Document 1")));
    assert!(gate.observe(at(t0, 10), &focus(10, 1, "Untitled Document 2")), "a late difference is still news");
}
```

**F4 — a new test in this payload is wall-clock flaky.**
`scheduler.rs:1007–1027 a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised`
takes `deadline = Instant::now() + 5 ms` and asserts `recognise_calls == 1`. If more than 5 ms pass
between that `Instant::now()` and the checkpoint at `scheduler.rs:337`, the read times out before
recognising and the assertion fails. I observed this exact failure once during this review (one run
in twenty-three, while eight reviewers were building concurrently). The plan's completion gate is a
literal "224 passed", so an occasional red here costs a re-run and a scare.

*Reproducing probe* (deterministic): the same test with `let deadline = Instant::now();` —
`left: 0, right: 1` on `recognise_calls`.

*Suggested fix*: give the read room to reach the recogniser and let the recogniser be what overruns,
e.g. `let start = Instant::now(); let deadline = start + Duration::from_millis(200);` with
`spin_in_recognise = Some(deadline)` and `Budget::until(deadline)`. Note the pre-existing sibling
`a_budget_spent_during_the_capture_times_out_before_recognition` (`scheduler.rs:961–973`) has the
same 5 ms shape and deserves the same treatment.

### Minor

**F5 — the "both focus sources are gated on the lock" wiring has no test, and the gate can be
bypassed by passing a parameter.** `focus_gate.rs:106` takes `locked` from the caller;
`macos/focus.rs:101` and `:137` supply it. Changing line 101 to `report_focus(&gate, &platform,
false)` leaves 224 passing. The practical risk is nil — `input::front_window_of`
(`input.rs:35–40`) already answers `None` while locked, so the closure would see no window anyway,
which is what the dev report's decision 5 calls belt and braces — but D12 is stated as a rule and the
rule is enforced only by convention.

*Suggested fix*: drop the parameter. Both callers pass exactly `windows::screen_is_locked()`, so
`report_focus` can read it itself and `poll` can take the lock decision from a supplier it owns; the
poll timer's own early return can call `focus_gate::should_observe(windows::screen_is_locked())`
separately (one extra CoreGraphics call per second). The bypass then is not expressible.

**F6 — nothing pins `to_px`'s rounding.** `scheduler.rs:114–116`. `.floor()` in place of `.round()`
leaves 224 passing, because the only geometry test uses exact multiples (0.25 × 8 = 2, 0.5 × 8 = 4,
300/700 × 700 = 300). The doc at 108–113 is careful about NaN and clamping but nothing checks the
rounding it names.

*Suggested fix*: add a case to `the_boxes_are_the_normalised_lines_multiplied_by_the_captured_frame`
with a fraction that must round up on the 8 px frame — e.g. `x = 0.32` → `leftPx 3` under `round`,
`2` under `floor` — and one that must round down.

**F7 — comment contradicts code: "four" reasons, five variants.** `scheduler.rs:15` says "These four
strings are the protocol's `reason` values" above a `FailReason` with five variants;
`protocol.rs:574` names its test `the_five_failure_reasons`. Pre-existing, but it sits at the top of
a file this topic rewrote.

**F8 — `protocol.rs`'s module doc does not mention what this payload added to the vocabulary.**
`protocol.rs:8–13` lists `expect`, `windowGone` and `stats` as "what 2 added over 1" but not the
`lines` request flag or the `lines`/`stats.bandPx` answer keys, which the same payload adds and
which `Request::Read`'s own doc (`protocol.rs:58–63`) does describe. Given the dev report's explicit
"No `READER_PROTOCOL` bump" note, the module doc is the place a future reader will look.

**F9 — one failure branch does not clear the cache, unlike its four siblings.**
`scheduler.rs:306` `Err(CaptureError::Other) => return Some(ReadAnswer::Fail(FailReason::Failed))`
has no `cache.clear()`, while `Refused` (294), `Gone` (303), no-window (267), not-approved (274) and
both re-checks (322, 374) all do. Harmless today — `cache.clear_unless(window.window_id)` at line
278 has just run and the window was approved, so the only entry that can be there is this window's
own — but it is the one exception to the sentence at `scheduler.rs:257–259` ("like every other
refusal here, keeps no text from an earlier read"). Pre-existing (identical in the backup).

*Suggested fix*: add `cache.clear();` for uniformity, or add half a sentence saying why this branch
is different.

### Not findings, recorded

- `Expected` (app, title, bundle id) is retained in `worker::Jobs.slots.{queued,running}` for the
  duration of one read and dropped by `finished()` after every turn. That is the only window title
  the helper holds at all now, and O6 requires it.
- `stats` key order is alphabetical because `serde_json::Map` is a `BTreeMap` here; the byte-exact
  answer tests depend on that and would break under the `preserve_order` feature. No caller enables
  it.
- `nothing_inside_stats_is_ever_a_string` (`protocol.rs:650`) still holds with `bandPx` present,
  and `a_read_that_did_not_ask_for_geometry_carries_none` pins that an ordinary answer is byte-for-
  byte what it was.
- Item 16's three pinning tests (`text.rs`) do exactly what the dev report says: `1 Install` loses
  its numerals, `1. Install` and `1) Install` keep every character. I confirmed the comment at
  `text.rs:30–46` matches them sentence by sentence.

---

## 5. Verdict

The substance of the topic is right: the order recognise → assemble → approved-window re-check →
store → final checkpoint → answer is exactly what is in `scheduler.rs` and no path reaches the store
past a failed re-check; the helper retains no window title anywhere that survives a poll; the
`MAX_SAFE_INTEGER` bound is real and documented on both sides; `lines`/`bandPx` cannot appear unless
asked, `ok` and un-cached, and the app's own client cannot ask; and the `macos/focus.rs` changes do
not break C-2a's D7. Seven of the eight claimed mutations bite exactly as claimed.

What holds the verdict back is F1 — the documented "nothing new crosses the pipe" claim is not true
for a window with an editor gutter, and the same defect mis-aligns the instrument the owner will run
against a real screen in C-2b-2 — together with three claims that no test defends (F2, F3, F6), one
of which the dev report asserts as proven, and a new flaky test (F4) against a plan whose gate is a
literal test count.

**CHANGES REQUIRED**

Spec compliance: ✅
Quality: Not approved
