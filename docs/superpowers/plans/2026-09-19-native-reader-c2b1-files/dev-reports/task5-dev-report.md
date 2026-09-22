# C-2b-1 Task 5 — the four design inputs deferred from the C-1 reader-client review

Scratch copy: `$S/ws/app`. No file outside the allowed set was touched. No git, no installs.

## Files changed

| File | What changed |
|---|---|
| `src/main/reader/protocol.ts` | (A1) The `HelperLink` doc now states the contract: the client registers `onLine`/`onExit` synchronously, in the same turn as `spawn()` returns, exactly once; a link must deliver every line from the helper's first byte to whichever callback is registered, and why (`ready` is the line at risk, and losing it costs the 90 s start deadline plus a kill). |
| `src/shell/readerLink.ts` | (B) `readline` replaced by `createLineSplitter`, a pure splitter with the cap applied while reading; `StringDecoder` across chunk boundaries; `\r\n`; over-long line → one fixed marker `HELPER_OVERLONG_LINE`. (A2) `createChildHelperLink` buffers lines that arrive before `onLine` is registered (`PRE_REGISTRATION_LINES_MAX` = 64, oldest dropped) and flushes them in order at registration. |
| `src/main/reader/readerClient.ts` | (C) `replaceCurrent` → `drain` + `leaveIfDrained`: a helper taken out of service keeps the calls already in flight, under their own deadlines, and is retired when its pending map empties (immediately if empty). `draining` set; `gone` and `dispose` own it. (D) new `mismatched` flag: a protocol mismatch is permanent for the life of the client; `onFocusChange` no longer revives after one. |
| `src/main/reader/readerClient.test.ts` | 4 new tests for the drain, 1 existing test rewritten (denied refresh, calls in flight), 1 assertion updated (cure path asks instead of killing), the denied-refresh baseline comment corrected. |
| `src/main/reader/readerClient.supervision.test.ts` | 1 new test: a mismatch is permanent across subscriptions. |
| `src/shell/readerLink.test.ts` | 8 splitter unit tests (no process), 2 pre-registration tests (fake child), 1 end-to-end test over a real pipe. |
| `src/shell/testing/fakeHelperProcess.mjs` | New `overlong` mode: answers its first call with one 2.1 MB line. |

Not changed: `src/main/reader/constants.ts` (nothing in it needed correcting — see "carried item 39"), `src/main/testing/fakeReaderHelper.ts` (the new client tests needed nothing it did not already have).

## Tests and typecheck

| File | Before | After |
|---|---|---|
| `src/main/reader/protocol.test.ts` | 18 | 18 |
| `src/main/reader/readerClient.test.ts` | 39 | 43 |
| `src/main/reader/readerClient.supervision.test.ts` | 15 | 16 |
| `src/main/reader/readerClient.leak.test.ts` | 1 | 1 |
| `src/shell/readerLink.test.ts` | 4 | 15 |
| `src/main/imports.test.ts` | 63 | 63 |
| **total of these six** | **140** | **156** |

`node .../vitest.mjs run --root $S/ws/app src/main/reader src/shell/readerLink.test.ts src/main/imports.test.ts` → 6 files, 156 passed, 0 failed.
`src/shell/realReader.test.ts` (not mine, but the only other consumer of `createChildHelperLink`) also still passes: 162 with it.
`node .../tsc --noEmit -p $S/ws/app/tsconfig.json` → exit 0, no output. (Whole project; no error anywhere, so none in my files.)

## Mutation table — each fix reverted, the failure watched, the file restored and byte-compared

Every row: `cp` aside, exact-string mutation, run, restore, `filecmp` byte-identical (asserted by the driver, `$S/mutate.py` + `mutations-new.json` / `mutations-c1.json`).

| # | Mutation | Tests that failed |
|---|---|---|
| A | `readerLink.ts`: drop the pre-registration buffer (deliver only when a sink exists) | "delivers them, in order, the moment `onLine` is registered"; "holds a bounded number of them: a helper talking into the void cannot grow main" |
| B1 | splitter: keep accumulating past the cap (remove the per-chunk check) | "never buffers a line past the cap, and reports it exactly once" |
| B2 | splitter: do not set `discarding`, so a marker is delivered for every chunk | "never buffers a line past the cap, and reports it exactly once"; "loses the call a helper answers with a line past the cap, and nothing else" (real pipe) |
| B3 | splitter: `chunk.toString("utf8")` instead of `StringDecoder` | "keeps a character whose bytes are split across two chunks" |
| C1 | `permission()` cure path: restore `helper.retired = true; gone(helper, true); start();` | "lets a read that is already in flight finish, and only then asks the old helper to go"; "a helper on its way out that never answers is killed by its own call's deadline"; "restarts the helper once by itself when captures are refused…" |
| C2 | `drain`: leave the helper in service (remove the out-of-service swap) | "lets a read that is already in flight finish…"; "sends the helper on its way out nothing more: later calls go to the fresh one"; "a helper on its way out that never answers is killed…"; "dispose in the middle of the drain owns both helpers"; "lets the calls in flight finish on the helper being replaced, and never sends it another" |
| D | `onFocusChange`: drop `!mismatched`, so a subscription revives after a mismatch | "a mismatch is permanent: switching capture off and on again does not start the same binary again" |

### The C-1 probes still bite (plan Tasks 2 and 3 mutation tables, all nine)

| Probe | Tests that failed |
|---|---|
| T2.1 `frontWindow` answers `null` when down | 5, incl. "while waiting to restart there is no helper at all…" |
| T2.2 delete `if (cureTried) return "needsRestart";` | "restarts the helper once by itself…" |
| T2.3 focus from any helper | "ignores focus events from a helper that is not ready"; "focus events from a replacement that has not taken over are ignored" |
| T2.4 no try/catch around a focus subscriber | "tells every subscriber, survives one that throws…" |
| T3.1 promote under a call in flight | "after enough reads, warms a replacement up…"; "focus events from a replacement…" |
| T3.2 keep a superseded read's id | "a read that was superseded and never answered does not hold the swap up" |
| T3.3 give-up off by one | 4, incl. "gives up after five unplanned exits in ten minutes…" |
| T3.4 mismatch counted as a crash (delete `helper.retired = true;`) | "never uses a helper that speaks another protocol…"; the new permanence test |
| T3.5 a four-second start deadline | 5, incl. "allows a cold start of a minute and a half…" |

## Decisions, and what they cost if they are wrong

1. **The over-long marker is one fixed non-JSON string** (`!over-long line discarded`), not a truncated prefix and not a synthetic JSON error. `parseLine` refuses it exactly as it refused the line itself, so the client's behaviour is unchanged from today: everything in flight on that helper settles as "down", the helper lives (D6). A test asserts `parseLine(HELPER_OVERLONG_LINE) === null`, so the guarantee cannot rot silently. *If wrong*: nothing in the client can tell an over-long line from any other unreadable line — that distinction would need a new event code, which is C-2's wiring decision, not this one's.
2. **The pre-registration buffer drops the OLDEST line** when it overflows (as briefed). The line that matters most is `ready`, which is the first line, so an overflow loses exactly the line the buffer exists for. This is acceptable only because 64 lines can only accumulate if the client broke its half of the contract entirely (it registers in the same turn), and in that case the helper is unusable anyway. *If wrong*: drop the newest instead — a one-line change (`if (early.length < MAX) early.push(line)`), and the bound test would need its expectation flipped.
3. **`HELPER_WEDGED` is still emitted for a helper that is on its way out.** The code says the binary hung inside a native call. That is a fact about the binary, true whoever was waiting for it, and it is the only signal of a helper that hangs on every read — suppressing it would let that helper be replaced in silence for ever. The wedge's other effects are unchanged: the call settles as `timeout`, the process is killed, and the exit still counts for nothing because the helper was already out of service. *If wrong* (C-2 maps events to log codes, and a code that fires during a normal cure could look alarming in a log): suppressing it is a one-line guard on `draining.has(helper)`, and the test "a helper on its way out that never answers is killed by its own call's deadline" states the current choice explicitly and would be the one to flip.
4. **A mismatch is remembered separately from `gaveUp`, not by making `gaveUp` sticky.** The ordinary give-up must stay revivable (D5), and the existing test "a new focus subscription after giving up is the user's try-again" is the counter-check — it is the test that fails if anyone makes `gaveUp` permanent. *If wrong*: a user who replaces the helper binary under a running app (dev builds do exactly this) must restart the app rather than switching capture off and on. That is the intended trade; C-2 already restarts the app for a new binary.
5. **`drain` also handles a helper that is the warming `replacement`**, though neither caller can pass one today (both take `current` from `usable()`). Two lines, no test — defensive against a third caller.

## Carried item 39 (the "61 helpers in five minutes" baseline)

No comment in `src/main/reader/constants.ts` or `readerClient.ts` states that figure. `CLIENT_DENIED_REFRESH_MAX_MS` already reasons from the engine's real rate ("the engine asks `permission()` every 10 s"), so it needed no fix. The one comment that cited the five-minute baseline was in `readerClient.test.ts` above "doubles the wait after each replacement that is still denied" — "7 replacements instead of 60 (300 s / 5 s)", i.e. 61 helpers. It now says that 60 is a rate only the unit test reaches (it polls once a second, so a fixed 5 s interval falls due every 5 s), that the app's asker is the engine's tick `PIPELINE_TICK_MS` at 10 s, and that the same fixed interval would cost about 30 replacements — 31 helpers — in five minutes. `PIPELINE_TICK_MS` is named in prose only; it lives in `src/main/constants.ts`, which another agent holds, and importing it into a reader test would be a needless coupling.

## Not done / worth knowing

- The splitter exposes `pending()` (characters held) purely so a test can assert the memory bound without a process. It is production API used by a test, not a test-only import, so `imports.test.ts` is unaffected — but it is there for the tests.
- `end()` drops an unterminated line, as briefed. A helper that writes its last answer and dies without a newline therefore loses that answer; it settles through the exit path as "down", which is what happens today too.
- The real-pipe test writes 2.1 MB through the fixture's stdout. It costs ~70 ms and leaves no process behind (`dispose()` at the end), but it is the slowest test in the file.
- Nothing was run against the real built helper; the `overlong` fixture is a Node script, and no `read`/`frontWindow` ever reached a real binary.

## Addendum (coordinator's call): the pre-registration buffer keeps the FIRST 64 lines

Decision 2 above is reversed, as instructed. `createChildHelperLink` now does
`if (early.length < PRE_REGISTRATION_LINES_MAX) early.push(line);` — the newest are dropped, the
first 64 survive. The reasoning in the code comment: what a late registration loses is the beginning
of the conversation, and the beginning is `ready`, which is the whole reason to keep anything;
filling 64 lines already means the client broke its half of the contract, so the lines that go are
answers to calls that were never made. The `HelperLink` contract in `protocol.ts` is unchanged — it
says a link must deliver every line, and the buffer is a link's insurance against a client that does
not hold up its end, not a licence to lose lines.

The bound test now writes `{"event":"ready","protocol":2}` first and 100 numbered lines after it, and
asserts the `ready` line arrives first, `{"id":0}` second, and `{"id":62}` last — 64 lines, the tail
gone.

| # | Mutation | Tests that failed |
|---|---|---|
| A' | restore drop-oldest (`early.push(line); if (early.length > MAX) early.shift();`) | "holds a bounded number of them, keeping the first: a helper talking into the void cannot grow main" |
| A | drop the buffer altogether (re-checked after the flip) | that same test **and** "delivers them, in order, the moment `onLine` is registered" |

Both were applied to a backup copy, run, restored and byte-compared (assertion in the driver).
The driver is now Task 5's own, at `$S/task5-tools/mutate.py`, with its specs in
`$S/task5-tools/mutations-buffer.json` — the earlier shared `$S/mutate.py` was overwritten by another
agent after my first mutation run (my results were already recorded and my files restored and
byte-compared at that point; the earlier specs survive as `$S/mutations-new.json` and
`$S/mutations-c1.json`, and can be replayed with the new driver, which takes the same format).

After the flip: the same six files, 156 tests passed, `tsc --noEmit` exit 0. No other file changed.
