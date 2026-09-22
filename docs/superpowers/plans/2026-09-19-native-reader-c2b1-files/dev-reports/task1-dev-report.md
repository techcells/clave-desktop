# C-2b-1 Task 1 — `read` carries the approved window; protocol 2

Developed in the scratch copy `$S/ws/app`. No git, no installs, no `pnpm`. The helper was never asked
to read a real window: the only things run against the built binary were the unit tests and
`handshake_check.py` (warm-up, `permission`, `shutdown`, EOF). No window title and no recognised text
appears anywhere below.

## Files changed (paths relative to `app/`)

### The wire and the helper (Rust)

| File | What changed |
|---|---|
| `native/reader/src/protocol.rs` | `PROTOCOL_VERSION` 1 → 2 and the module doc says what 2 added and why the number moved. New `pub struct Expected {app, bundle_id, title}`. `Request::Read` gains `expect: Option<Expected>`; new `expected()` parses it all-or-nothing (not an object, non-string `app`/`title`, non-string `bundleId` when present → `None`, and the read is still a request owed an answer). `read_line` takes `&ReadStats` and renders `"stats"` on `ok` and on `black` only, omitting the object when nothing was measured; new `stats_value()` writes the five fields by hand. |
| `native/reader/src/scheduler.rs` | New `pub struct ReadStats` (Debug/Default/Clone/Copy, five `Option`s). New `is_approved()` (all three fields, `bundle_id` as `Option`) and `still_in_front()` (same window id **and** approved). `handle_read` gains `expect: Option<&Expected>` and `stats: &mut ReadStats`: `None` → `cache.clear()`, `Failed`, nothing captured; `Some` → compare before the capture, again after the capture and black check (before the cache lookup and before recognition), and a third time after recognition before storing or answering. Every mismatch clears the cache and answers `WindowGone`. `capture_ms`/`width`/`height` filled after a successful capture, `cache_hit` at the lookup, `recognise_ms` after recognition. Cancellation/budget checkpoints unchanged. |
| `native/reader/src/worker.rs` | `Job` carries `expect: Option<Expected>`; `submit(id, budget_ms, expect)`; `turn` builds a `ReadStats::default()`, passes `job.expect.as_ref()` and emits `read_line(id, &answer, &stats)`. New `#[cfg(test)] Jobs::queued()` so the input thread's tests can see a queued job. |
| `native/reader/src/input.rs` | `Request::Read { id, budget_ms, expect } => jobs.submit(id, budget_ms, expect)`. |
| `native/reader/tools/handshake_check.py` | Expects `{"event": "ready", "protocol": 2}` in both places. |

`stub.rs`, `main.rs`, `platform.rs` needed no change: the `Platform` trait is untouched.

### The port and main (TypeScript)

| File | What changed |
|---|---|
| `src/main/ports/reader.ts` | `read(opts: {budgetMs: number; expect: FrontWindow})`; interface doc states the rule (capture only a window whose app, bundle id and title equal `expect`; anything else is `windowGone` with nothing captured) and why. |
| `src/main/capture/loop.ts` | Passes `expect: front`. Both existing after-checks kept verbatim, with a comment saying they are deliberate defence in depth. |
| `src/main/reader/constants.ts` | `READER_PROTOCOL = 2` with the comment on what 2 added and why the number had to move. |
| `src/main/reader/protocol.ts` | `ToHelper` read variant is `{id, op:"read", budgetMs, expect: FrontWindow}`; imports `FrontWindow`. |
| `src/main/reader/readerClient.ts` | New `onTheWire()` copies the three known fields one by one (never a spread). `ask` now takes a discriminated `Question` (`{op}` or `{op:"read", budgetMs, expect}`) instead of positional `op`/`budgetMs`; `read(opts)` takes and forwards `expect`. |
| `src/standins/devReader.ts` | `read(opts)` answers `windowGone` for no window (was `failed`) and for a window whose app/title/bundleId is not `expect`. |
| `src/main/testing/fakeReader.ts` | Records every `expect` in `expects`; answers `windowGone` for no window (was `failed`) and for a window that is not `expect`. The window is sampled at the start of the read, so `duringRead` still models "the user switched while the picture was taken". |
| `src/main/testing/fakeReaderHelper.ts` | `ready()` defaults to `READER_PROTOCOL` instead of a literal `1`; new `lastRead()` returns the most recent read message so tests can see its `expect`. |
| `src/shell/testing/fakeHelperProcess.mjs` | Announces protocol 2; refuses a read whose `expect` is not its one window (answers `windowGone`), and puts a small `stats` object on the good answer. |

### Tests changed or added

`native/reader/src/protocol.rs`, `native/reader/src/scheduler.rs`, `native/reader/src/worker.rs`,
`native/reader/src/input.rs` (inline test modules); `src/main/capture/loop.test.ts`,
`src/main/ports/ports.test.ts`, `src/main/reader/protocol.test.ts`,
`src/main/reader/readerClient.test.ts`, `src/main/reader/readerClient.supervision.test.ts`,
`src/main/reader/readerClient.leak.test.ts`, `src/shell/readerLink.test.ts`,
`src/standins/standins.test.ts`.

## Totals

| | Before | After |
|---|---|---|
| TypeScript | 913 passed + 1 skipped, 65 files | **937 passed, 66 files** |
| Native | 166 | **193** |

Both typechecks (`tsconfig.json`, `tsconfig.renderer.json`) clean. `cargo test` and the release build
report **zero warnings**. `handshake_check.py` against the freshly built binary: **ALL CHECKS PASSED**
(ready at 0.087–0.090 s warm; permission answered `denied`, which is right for an unsigned binary
outside the bundle — no capture was attempted).

The previously skipped `src/shell/realReader.binary.test.ts` now runs: it finds the binary at
`app/native/reader/target/release/clave-reader` via `new URL(...)`, which the in-copy build produces,
so building in the copy is all it needed. It sends `permission` and `dispose` only.

**Note on the final numbers.** A later full-suite run in the same copy reported 979 tests in 67 files.
The extra file and tests are another agent's (`src/core/text/` and `native/reader/fixtures/` appeared
between my runs — the homoglyph work). The 937/66 above is the count with my changes alone; the
native 193 is unaffected, since no Rust file of that task had changed at the time of the last run.

## The mutations, and the tests that caught them

Each one: `cp` the file aside, mutate, run the tests, watch them fail, restore, `cmp` (every restore
confirmed byte-identical).

| # | Mutation | Tests that failed |
|---|---|---|
| a | `scheduler.rs`: pre-capture comparison replaced with `if false` | `scheduler::tests::a_different_app_in_front_is_refused_without_a_capture`, `…::the_same_app_with_a_different_title_is_refused_without_a_capture`, `…::a_bundle_id_that_does_not_match_is_refused_both_ways_round` (3 failed / 190 passed) |
| b | post-capture re-check replaced with `if false` | `…::a_switch_between_the_capture_and_recognition_throws_the_image_away`, `…::the_same_app_and_title_under_a_different_window_id_is_not_the_window_we_captured`, `…::a_switch_during_recognition_throws_the_text_away_and_remembers_nothing`, `…::a_matching_read_asks_the_window_server_three_times_and_answers_normally` (4 / 189) |
| c | post-recognition re-check replaced with `if false` | `…::a_switch_during_recognition_throws_the_text_away_and_remembers_nothing`, `…::a_matching_read_asks_the_window_server_three_times_and_answers_normally` (2 / 191) |
| d | missing `expect` means "anything goes" (the front window becomes its own expectation, as protocol 1 did) | `…::a_read_that_says_nothing_about_what_it_approved_is_a_failed_read`, `…::a_read_with_no_expectation_forgets_the_last_window` (2 / 191) |
| e | `is_approved` compares the app only | `…::the_same_app_with_a_different_title_is_refused_without_a_capture`, `…::a_bundle_id_that_does_not_match_is_refused_both_ways_round`, `…::a_window_the_app_never_approved_forgets_the_last_window` (3 / 190) |
| f | `loop.ts` omits `expect` from the read | loop.test.ts: `tells the reader which window the core approved, and it is the one the core just checked`, `carries the bundle id in the approved window when the front window has one`, `approves the window of each cycle, not the first one for ever`, `asks the core first, reads, and hands the text over with the core-checked window`, `throws the text away when the window changed while it was being read`, `times out a front-window call that never settles…`, `keeps polling and reading when idleSeconds throws…`, `is not running, and reports a reader problem, when the reader refuses to subscribe`, `forgets earlier reader failures when the loop is started again` (9 / 17) |
| g | `readerClient.ts` omits `expect` from the wire | `puts exactly the three known fields of the approved window on the wire`, `asks the helper once it is ready, and hands back what the port's own parsers accept`, `events are bare codes, errors carry no text, and nothing is written to the console or stderr` (the leak test), `carries every call through the client, accents and symbols intact, and leaves when asked` (readerLink) (4 / 73) |
| h | `READER_PROTOCOL` back to 1 | `never uses a helper that speaks another protocol, and does not restart it in a loop`; and the four tests that talk to a real child process, which now mismatch: `starts the helper at the given path and reads through it`, `carries every call through the client…`, `is not blocked by a helper that floods its stderr`, `kills a helper that ignores both shutdown and its input being closed`, plus `says ready, answers a permission question with a known value, and leaves by itself when asked` (the real binary) (6 / 931) |
| i | `read_line` emits `stats` on every failure | `protocol::tests::no_other_failure_carries_measurements` (1 / 192) |

Two observations worth keeping from this:

- Mutation (a) did **not** break `a_window_the_app_never_approved_forgets_the_last_window`. That is
  the post-capture re-check doing its job: with the first comparison gone, the second one still
  refuses the window and still clears the cache. The three layers really are independent.
- Mutation (h) shows that the protocol number is now load-bearing in both directions: with it at 1,
  every test that speaks to a real child process fails, because both fakes and the real binary
  announce 2.

## Decisions I had to make, with the cost if wrong

1. **Where the `expect: None` check sits.** After the lock and preflight checks, immediately before
   the front window is resolved. So a read with no `expect` on a **locked** screen answers `locked`,
   not `failed`. Cost if wrong: one answer code differs in a state that cannot arise from this app's
   own main (which always sends `expect`); nothing is captured either way.
2. **`bundleId: null` on the wire is malformed, not "absent".** `expected()` drops the whole
   expectation for it, per the brief's "non-string `bundleId` when present". Our client never sends
   `null` (it omits the key), so this only affects a main that does something we do not do. Cost if
   wrong: such a read answers `failed` instead of being served.
3. **`ask()` takes a discriminated question object** (`{op}` / `{op:"read", budgetMs, expect}`)
   instead of the old positional `op, deadlineMs, budgetMs?`. The old shape could not be typed once
   `read` carried a required field that the other ops do not have — `{id, op}` in the else branch no
   longer satisfied `ToHelper`. Cost: a slightly larger diff in `readerClient.ts`; no behaviour
   change, and the four call sites read better.
4. **The fake reader samples its window at the start of the read**, before `holdReads`/`duringRead`.
   Any other choice would make `duringRead` mean "the helper noticed the switch", which the real
   helper's pre-capture check cannot do — it resolves the front window once, before it captures.
   Cost if wrong: loop.test's `windowChanged` test would be testing the wrong seam.
5. **`still_in_front` also requires the same `window_id`.** The brief asked for it; the consequence
   worth naming is that two windows of the same app with the same (or empty) title are correctly
   treated as different windows. Cost: none found; it can only refuse more, never less.
6. **`Jobs::queued()` is a new `#[cfg(test)]` method** on `Jobs`, because `take_within` is private to
   the `worker` module and `input.rs`'s test needed to see the queued job. Cost: one test-only
   method in the production type.
7. **`stats` is an out-parameter, not part of `ReadAnswer`.** As the brief required, so the existing
   `assert_eq!` comparisons of answers keep working. Cost: `handle_read` has seven parameters now.

## What I did not do

- I did not touch `docs/superpowers/specs/2026-09-18-native-reader-design.md`. Section 3 still says
  `{event:"ready", protocol:1}` and its C-2a note still argues the number should not move; section
  5.3's table still says a window that vanished between steps answers `failed`. The spec is in the
  read-only repo and updating it was not in this task's brief — but it is now wrong in three places
  and somebody should carry that into the plan.
- I did not add the eval-only `lines:true` read option (ledger D11): not in this brief.
- I did not exercise `read` against the real helper, by design (privacy rule). The real binary was
  only handshaken.
