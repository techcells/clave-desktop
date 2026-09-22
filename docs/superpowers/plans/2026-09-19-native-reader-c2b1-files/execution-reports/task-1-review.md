# Task 1 review — Approved window, protocol 2, `stats`

Independent reviewer, N = 1. Worked only in
`/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/exec/rev-1/app`.
Nothing under `/Users/sardorastanov/techcells/asset-to-evidence` was modified. No `read` or
`frontWindow` was ever sent to a built helper; the only thing run against the binary was
`handshake_check.py` (warm-up, `permission`, `shutdown`, stdin EOF). No window title and no
recognised text appears below.

Line numbers refer to `/Users/sardorastanov/techcells/asset-to-evidence/app/...`.

## Baselines established in my copy

| Check | Result |
|---|---|
| `build-native.mjs --test` | **224 passed**, 0 failed |
| `build-native.mjs` (release) | `BUILD_NATIVE_OK`, **zero warnings** |
| `handshake_check.py` on that binary | **ALL CHECKS PASSED**, `{"event":"ready","protocol":2}` in both places |
| vitest, whole suite | **1430 passed in 84 files** |
| `tsc --noEmit` `tsconfig.json` / `tsconfig.renderer.json` | both clean |
| `pgrep -fl clave-reader` afterwards | nothing |

The copy is byte-identical to `app/` after every mutation (`diff -rq` over the whole tree is empty;
`cmp` on each of the 14 topic files passes).

---

## Questions

### 1. Any path in `scheduler::handle_read` from entry to `platform.capture` that does not pass the comparison with `expect`?

**No.** `platform.capture` has exactly one call site, `native/reader/src/scheduler.rs:284`. Every path
to it crosses, in order:

- `scheduler.rs:260-263` — `let Some(expect) = expect else { cache.clear(); … Failed }` (D1),
- `scheduler.rs:266-269` — no front window → `cache.clear()`, `WindowGone`,
- `scheduler.rs:273-276` — `if !is_approved(&window, expect) { cache.clear(); … WindowGone }`.

`is_approved` (`scheduler.rs:175-177`) compares all three fields, `bundle_id` as an `Option`. The
three preceding early returns (locked `240`, no preflight `252`) also capture nothing. Asserted by
`a_different_app_in_front_is_refused_without_a_capture`,
`the_same_app_with_a_different_title_is_refused_without_a_capture`,
`a_bundle_id_that_does_not_match_is_refused_both_ways_round` and
`a_read_that_says_nothing_about_what_it_approved_is_a_failed_read`, all of which assert
`capture_calls == 0`.

### 2. Any path to `platform.recognise`, to `cache.store` or to an `Ok` answer that does not pass its re-check?

- **`platform.recognise`** — one call site, `scheduler.rs:339`. The statement immediately before it
  (past one `checkpoint!`) is `if !still_in_front(platform, &window, expect)` at `321`. No other path
  reaches it. ✓
- **`cache.store`** — one call site, `scheduler.rs:380`, immediately after the third comparison at
  `373`. ✓ Topic 4 moved the store above the final `checkpoint!` (`411`); it is still **below** the
  comparison at `373`, which is the ordering that matters, and the comment at `371-372` says so.
- **`Ok` answers** — two: `332` (cache hit) and `412` (fresh recognition).
  - `412` is guarded by the comparison at `373`. ✓
  - `332` is guarded by the comparison at `321`. There is **no third comparison on the cache-hit
    path**, and that is exactly what D2 specifies: "before the capture, after the capture and black
    check (*before the cache lookup* and recognition), and after recognition". A hit performs no
    recognition, so there is no third moment to check. Between `321` and `332` only
    `captured.frame.pixel_hash()` and a one-entry lookup run. The text returned is additionally an
    entry that an earlier read stored only after **its** own post-recognition comparison, under the
    same window id (`cache.clear_unless` at `278`) and the same pixel hash. So no window main never
    approved can be answered out of the cache. Compliant; worth one sentence in the Task 10 spec note
    for 5.2 so nobody later reads "three comparisons" as "three on every path".

`still_in_front` (`scheduler.rs:181-183`) requires the same `window_id` **and** `is_approved`.

### 3. Does every mismatch clear the cache?

**Yes**, all three, plus the two neighbouring refusals:

| Where | Line | Clears |
|---|---|---|
| `expect` missing | `261` | ✓ |
| no front window | `267` | ✓ |
| pre-capture mismatch | `274` | ✓ |
| post-capture mismatch | `323` (after `drop(captured)`) | ✓ |
| post-recognition mismatch | `374` | ✓ |

Pinned by `a_window_the_app_never_approved_forgets_the_last_window`,
`a_read_with_no_expectation_forgets_the_last_window`,
`a_switch_during_recognition_throws_the_text_away_and_remembers_nothing` (which proves the text was
not kept by watching the next read recognise again).

`CaptureError::Other` (`306`), `black` (`313`) and a recogniser error (`340`) do **not** clear. That
is not a mismatch: `clear_unless(278)` has already reduced the cache to this same approved window's
own text, and spec 5.2's C-2a note lists exactly the five clearing early-returns, which the code
matches. Correct as written.

### 4. Does the client copy exactly `app`, `title`, `bundleId` onto the wire and nothing else?

**Yes.** `src/main/reader/readerClient.ts:284-288` `onTheWire()` builds a fresh object field by field
(two branches, so an absent `bundleId` stays absent rather than becoming `null`), and it is the only
thing that reaches the wire — `readerClient.ts:309`. There is no spread anywhere on that path.
Pinned by `readerClient.test.ts:101-107` ("puts exactly the three known fields…", which checks
`Object.keys`) and by my own probe (below). `encode` is a bare `JSON.stringify`
(`src/main/reader/protocol.ts:48-50`).

### 5. Does the loop still run both after-checks unchanged?

**Yes.** `diff` against `c2b1-backup`: `loop.ts:197-198` are byte-identical to the backup's `104-105`.
The only changes in that region are the read call gaining `expect: front` (`183`) and three lines of
comment above the checks saying they are deliberate defence in depth. No check was removed, reordered
or weakened. (As before, main's own after-checks compare `app` and `title` but not `bundleId` — that
is unchanged, and the helper now compares `bundleId` itself.)

### 6. Can `stats` ever hold a string?

**No, on both sides.**

- Rust: `ReadStats` (`scheduler.rs:58-65`) is five `Option<u64>`/`Option<bool>` — a string cannot be
  put in it by type. `stats_value` (`protocol.rs:228-249`) writes every key by hand, plus `band_px`,
  a `u64`. Pinned by `protocol::tests::nothing_inside_stats_is_ever_a_string` (`protocol.rs:650`),
  which re-parses the emitted line and asserts every value `is_number() || is_boolean()`.
- TypeScript: `readShape` (`src/main/ports/reader.ts:54-57`) has no `stats` key, so zod strips the
  whole object. I probed this directly with a rogue answer carrying `stats.note = "<a string>"` and a
  `lines` array: both are dropped before the caller sees anything (probe P-6 below).

### 7. Does any production caller of `Reader.read` omit `expect`?

**No**, proven two ways.

- grep over `app/src`, `app/scripts`, `app/reader-eval` for `reader.read`/`.read({`/`op: "read"`:
  the only production call of the port is `src/main/capture/loop.ts:183`. `src/readerEval/helper.ts:54`
  builds its own read line and always includes `expect` (topic 8's territory).
- Removing `expect: front` from `loop.ts:183` makes `tsc --noEmit` fail:
  `loop.ts(183,32): error TS2741: Property 'expect' is missing in type '{ budgetMs: number; }'`.

### 8. Do `devReader` and `fakeReader` answer `windowGone` for both a mismatch and "no window"?

**Yes.**

- `src/standins/devReader.ts:41` — nothing to replay → `windowGone` (was `failed`);
  `devReader.ts:43-45` — app, title, or an unexpected `bundleId` → `windowGone`.
- `src/main/testing/fakeReader.ts:26` `sameWindow` (all three fields) and `fakeReader.ts:53`
  `if (!window || !sameWindow(window, opts.expect)) return {ok:false, reason:"windowGone"}`.

Pinned by `standins.test.ts:45-61` and `loop.test.ts:599-618`. The fake samples the window at the
**start** of the read (`fakeReader.ts:45`), which correctly models the real helper resolving the front
window once before the capture, so `duringRead` still means "the user switched while the picture was
taken" — the seam main's own after-check is for.

---

## Mutation table (the developer's nine, all re-run)

Every one: back up, mutate, run the named tests, watch them fail, restore, `cmp` against `app/`.
All nine restored byte-identical.

| # | Mutation | Result |
|---|---|---|
| a | `scheduler.rs:273` pre-capture comparison → `if false` | **BITES** — 221/224. Exactly the 3 reported: `a_bundle_id_that_does_not_match_is_refused_both_ways_round`, `a_different_app_in_front_is_refused_without_a_capture`, `the_same_app_with_a_different_title_is_refused_without_a_capture`. Confirms the dev's observation that `a_window_the_app_never_approved_forgets_the_last_window` survives — the post-capture layer catches it independently. |
| b | `scheduler.rs:321` post-capture re-check → `if false` | **BITES** — 220/224, the 4 reported. |
| c | `scheduler.rs:373` post-recognition re-check → `if false` | **BITES** — 222/224, the 2 reported. |
| d | missing `expect` means "anything goes" (`is_approved`/`still_in_front` take `Option`, the `260-263` guard removed) | **BITES** — 222/224: `a_read_that_says_nothing_about_what_it_approved_is_a_failed_read`, `a_read_with_no_expectation_forgets_the_last_window`. |
| e | `is_approved` compares the app only | **BITES** — 221/224, the 3 reported. |
| f | `loop.ts:183` omits `expect` | **BITES** — 13 of 38 in `loop.test.ts` (the dev's 9 plus 4 that topic 2 added after the report was written). |
| g | `readerClient.ts:309` omits `expect` from the wire | **BITES** — 4 failures across `readerClient.test.ts`, the leak test and `readerLink.test.ts`, exactly as reported. |
| h | `READER_PROTOCOL` back to 1 | **BITES** — 7 failures over the whole suite (the mismatch test, the permanence test, and every test that speaks to a real child process, which now announces 2). |
| i | `read_line` emits `stats` on every failure | **BITES** — `protocol::tests::no_other_failure_carries_measurements`, 223/224. |

**No mutation failed to bite.** Mutation (h) also confirms the protocol number is load-bearing in
both directions.

---

## Independent probes (the ones the developers never saw)

| Probe | Result |
|---|---|
| (i) compare titles case-insensitively in `scheduler.rs` (`window.title.to_lowercase() == expect.title.to_lowercase()`) | **DOES NOT BITE — 224 passed.** Finding M1. |
| (ii) post-capture re-check ignores `window_id` (inlined `platform.front_window().is_some_and(\|now\| is_approved(&now, expect))` at `321`, leaving `373` intact) | **BITES** — `the_same_app_and_title_under_a_different_window_id_is_not_the_window_we_captured`, 223/224. |
| (iii) `readerClient.ts` spreads `opts.expect` instead of copying three fields; my own test hands it an object with two extra keys | **BITES** — my probe test and `puts exactly the three known fields…` both fail; both pass on the unmutated code. |
| (iv) `protocol.rs` accepts an `expect` with a numeric `title` (`Value::Number(n) => n.to_string()`) | **DOES NOT BITE — 224 passed.** The real code is correct (`as_str()?` at `protocol.rs:108` drops it), but nothing pins it. Finding M2. |
| (v) `fakeHelperProcess.mjs` answers `ok` however `expect` mismatched | **BITES** — `readerLink.test.ts`'s "carries every call through the client…" fails. And at the loop level (my own tests, below) main still discards a rogue `ok`. |

### Probe tests I wrote (in my copy only, then moved out of `app/`; kept at
`…/exec/rev-1/probe-client.test.ts.keep`, `probe-loop.test.ts.keep`, `probe-port.test.ts.keep`)

- **P-3 (`probe-client.test.ts.keep`)** — hands `client.read` an approved-window object carrying
  `secretNote` and `windowId`; asserts `Object.keys(sent.expect)` is exactly
  `["app","bundleId","title"]` and that nothing the helper received contains the smuggled marker.
  Passes on the real code, fails under probe (iii)'s spread.
- **P-5 (`probe-loop.test.ts.keep`)**, three cases against a reader that ignores `expect`:
  - **A** it names the unapproved window in the answer → loop returns `windowChanged`, ingests
    nothing (`result.window` check, `loop.ts:198`);
  - **B** it lies and echoes the approved window back while the screen has moved on → loop still
    returns `windowChanged` (the `after` check, `loop.ts:197`);
  - **C** *recorded, not a defect*: the helper lies AND the front window is back by the time of the
    `after` call → main keeps the text. This is precisely the case main cannot see, and it is the
    residual hole that only the helper's own three comparisons close. It is the best available
    statement of what protocol 2 buys.
  All three pass.
- **P-6 (`probe-port.test.ts.keep`)** — `parseReadResult` on an `ok` answer whose `stats` holds a
  string and which also carries `lines`: both are dropped, the result is exactly
  `{ok, window, text}`. Passes.

---

## Findings

### Minor

**M1 — nothing pins the case-SENSITIVITY of the title (and app/bundle id) comparison.**
`native/reader/src/scheduler.rs:175-177`. Probe (i): replacing `window.title == expect.title` with a
case-folded comparison leaves all 224 native tests green, because every title pair in the tests
differs by more than case ("Some Title" vs "Another Document", etc.). Reproducing probe: apply the
substitution above, run `node <copy>/app/scripts/build-native.mjs --test` → `224 passed`.
*Severity assessment:* no privacy consequence today — the core's exclusion rules are themselves
case-insensitive (`src/core/exclusions/rules.ts:31-32`, `index.ts:46`, `privateWindows.ts:19`), so a
case-folding helper could only capture a window the core would have judged identically. It is a
coverage gap in the one function that is the whole privacy contract.
*Suggested fix:* one case added to the existing table, e.g. in
`a_bundle_id_that_does_not_match_is_refused_both_ways_round`'s neighbourhood — an `Expected` whose
`title` is `as_approved(&fake).title.to_uppercase()` must answer `WindowGone` with
`capture_calls == 0`.

**M2 — the malformed-`expect` table is asymmetric: a non-string `title` is not covered.**
`native/reader/src/protocol.rs:105-116`, test table at `protocol.rs:347-357`. The table covers
`"app":7` and `"title":null` but no numeric/boolean `title`, no `"app":null`, and no non-string
`bundleId` other than `7`/`null`. Probe (iv): making `expected()` stringify a numeric `title` leaves
all 224 tests green, although D1 and the function's own doc say the expectation is dropped
all-or-nothing. Reproducing probe: replace `protocol.rs:108` with
`let title = match object.get("title")? { Value::Number(n) => n.to_string(), other => other.as_str()?.to_owned() };`
→ `224 passed`.
*Suggested fix:* add `{"app":"Google Chrome","title":7}` and `{"app":null,"title":"…"}` to the array
at `protocol.rs:347`. Two lines, no behaviour change.

**M3 — the step-4b comment contradicts step 3.**
`native/reader/src/scheduler.rs:316-319` says "A capture takes long enough … for the user to switch,
and the image in hand **may now be of a window nobody checked**." Step 3 captures by window id
(`scheduler.rs:284`) and its own comment at `280-281` says so explicitly, so switching does not change
which window the image is of. What check 4b actually catches is (a) the same window id whose **title**
changed since main judged it — which `is_approved` refuses — and (b) the approved window no longer
being front, where dropping the image is conservative rather than necessary. (A window-id reuse inside
230 ms would make the sentence literally true, but that is not what it claims.)
*Suggested fix:* reword to name the title change as the case that makes 4b load-bearing. This matters
because Task 10 Step 1 is about to copy 5.2's reasoning into the spec.

### Observations, not findings

- **The cache-hit `Ok` answer passes two comparisons, not three** (see Q2). Compliant with D2 as
  written, and safe for the reasons given, but the Task 10 note for spec 5.2 should say "three
  comparisons on a read that recognises; a cache hit's last word is the one before the lookup",
  or a later reader of the spec will read the code as a gap.
- **Spec is now wrong in three places** — section 3's `{event:"ready", protocol:1}`, the 2026-09-19
  C-2a note's "the protocol number is **unchanged**", and 5.3's table row "The window vanished
  between steps → `failed`". All three are already scheduled in Task 10 Step 1 (the section 3 note
  explicitly supersedes the C-2a note, and 5.3's row is covered by the C-2a note at the end of 5.2).
  Confirmed planned, nothing to do here.
- **No title or recognised text can leave the helper other than through `read`/`frontWindow`
  answers.** `grep` for `println!`/`eprintln!`/`dbg!`/`{:?}` over `native/reader/src` finds matches
  only inside `#[cfg(test)]` modules; `runtime::die` writes a fixed code and the panic hook is
  silenced (`runtime.rs:22-24`). `readerClient.ts` logs nothing and its events are bare codes, pinned
  by `readerClient.leak.test.ts`, which now also asserts the approved **title** never appears in any
  event, error, stack, console line or stream.
- **No `Expected` is retained after a read.** `Jobs::take_within` moves `queued` out
  (`worker.rs:83-86`) and `turn` calls `jobs.finished()` (`worker.rs:167`), which clears `running`
  (`worker.rs:102-105`), so no approved title outlives the read that carried it.
- **`handshake_check.py` never causes a capture.** Its only `read`-shaped line is `{"op":"read"}`
  with no `id` (`handshake_check.py:106`), which `parse_request` drops; the test asserting "exactly
  one answer: the noise was ignored" is what proves it. Safe to keep running under the privacy rule.
- **Not verified, and cannot be here:** none of the three comparisons has met a real window title,
  and no `stats` has been produced from a real capture. That is C-2b-2, as the plan states.

---

## Verdict

**APPROVED WITH MINORS.** The privacy core of this topic is sound: there is exactly one `capture`,
one `recognise` and one `store` call site in `handle_read`, each is guarded, every mismatch empties
the cache, the client puts three named fields on the wire and nothing else, main's two after-checks
survive untouched as defence in depth, and `stats` cannot carry a string on either side. All nine of
the developer's mutations bite exactly as reported; three of the five independent probes bite; the two
that do not are test-coverage gaps (M1, M2) in correct code, not defects, and M3 is a comment.

Spec compliance: ✅
Quality: Approved
