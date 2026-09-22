# C-2b-1 Task 2 — surface long runs of cycles in which nothing is read (main-process half)

Scratch copy: `/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/ws/app`.
Review items covered: 9, 10, 31, 32, 33, 38 of `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`.

## Files changed / added

| File | What |
|---|---|
| `src/main/capture/loop.ts` | `"unchanged"` added to `CycleOutcome`; exported `CYCLE_CLASS` / `CycleClass` / `BarrenOutcome` / `BarrenCounts` / `cycleClass()`; barren-streak tracking; two new required deps `onNothingRead` / `onReadingAgain`; `start()` resets streak + clock; `stop()` retracts the notice |
| `src/main/capture/loop.test.ts` | `setup()` takes an `ingest` override and wires the two new deps; **+12 tests** in a new `describe` |
| `src/main/constants.ts` | `BARREN_CYCLE_LIMIT = 24`, `BARREN_AFTER_MS = 10 * 60_000`, with the reasoning |
| `src/main/log.ts` | code `READER_NOTHING_TO_READ`; `LOG_COUNT_KEYS` extended with one key per `CycleOutcome` name (still a closed set, still checked at runtime) |
| `src/main/log.test.ts` | **+1 test**: every outcome name is accepted as a count key, a title beside them is still dropped |
| `src/main/engine.ts` | `NothingReadWhy` / `NothingRead` types, `EngineStatus.nothingRead`, exported `nothingReadWhy()`, loop wiring, `READER_NOTHING_TO_READ` log line, `CAPTURE_OFF` now carries `loop.stats()`, compile-time assert that every `CycleOutcome` is a `LogCountKey` |
| `src/main/engine.nothingRead.test.ts` | **new file, +6 tests** |
| `src/shared/ipc.ts` | re-exports `NothingRead` / `NothingReadWhy`; new runtime const `NOTHING_READ_WHY`; two new compile-time assertions |
| `src/shared/ipc.test.ts` | **+2 tests** |
| `src/shell/trayState.ts` | `trayKey` takes `nothingRead` and flips on it |
| `src/shell/trayState.test.ts` | fixture + **+1 test** |
| `src/shell/app.ts` | first tray menu item uses `COPY.tray.onNothing`; `recentApp` focus subscription keeps its unsubscribe and pushes it onto `teardown`, comment extended (item 38) |
| `src/renderer/copy.ts` | `tray.onNothing` string only |
| `src/renderer/dev/mockBridge.ts`, `src/renderer/model/views.test.ts`, `src/renderer/model/controls.test.ts` | `nothingRead: null` in the `EngineStatus` fixtures (typecheck ripple only) |

## Test counts (after)

| Target | Tests | New |
|---|---|---|
| `src/main/capture` | 38 | +12 |
| `src/main/log.test.ts` | 7 | +1 |
| `src/main/engine.nothingRead.test.ts` | 6 | +6 (new file) |
| `src/shared` | 4 | +2 |
| `src/shell/trayState.test.ts` | 5 | +1 |
| `src/shell` (whole folder) | 43 | +1 |
| `src/renderer` (whole folder) | 112 | 0 |
| **Whole suite** | **1021 in 69 files** | **+22** |

Whole suite is green (1021 passed) — no other agent's half-made work was failing at the time of the run.

## Typecheck

- `tsc --noEmit -p tsconfig.json` — **clean, no output**.
- `tsc --noEmit -p tsconfig.renderer.json` — **clean, no output**.

## Mutation table — every new test shown to bite

Each mutation applied to a `cp`-aside copy, suite run, file restored and `filecmp`-verified byte-identical.
Targets run: `src/main/capture src/main/log.test.ts src/main/engine.nothingRead.test.ts src/shared src/shell/trayState.test.ts` (for (f): the three engine test files).

| # | Mutation | Failing tests |
|---|---|---|
| a | `unchanged` classified as `barren` | 3 — loop: *has an answer for every outcome…*; *counts a screen that has not moved as a read that worked…*; *an unchanged cycle ends a streak…* |
| b | `userAway` classified as `barren` | 2 — loop: *has an answer for every outcome…*; *a user who is away neither extends the streak nor ends it* |
| c | time condition (`now() - lastProductiveAt >= BARREN_AFTER_MS`) dropped | 7 — loop: *says nothing about 31 barren cycles inside two and a half minutes*; *raises it exactly once…*; *takes it back on the first cycle that reads something…*; *an unchanged cycle ends a streak…*; *starts a fresh run with an empty streak and a fresh clock*; engine: *says so in the status, emits it, logs it once…*; *writes the streak's tally under fixed count keys…* |
| d | once-per-streak guard (`if (noticeUp) return`) dropped | 2 — loop: *raises it exactly once…*; engine: *says so in the status, emits it, logs it once…* |
| e | `onReadingAgain()` never called | 6 — loop: *takes it back on the first cycle…*; *an unchanged cycle ends a streak…*; *takes the notice back when the loop stops…*; *keeps reading when either callback throws*; engine: *clears it, and says so, as soon as a window is read again*; *clears it whenever the loop stops…* |
| f | `nothingRead` pushed into `blockers()` as a blocker | 1 — engine: *says so in the status, emits it, logs it once, and does not switch anything off*. **Also a compile error** in two files (`src/shell/trayState.ts` `BLOCKER_TRAY`, `src/renderer/copy.ts` `Record<Blocker, BlockerCopy>` — both exhaustive records), verified separately with `tsc`. `engine.test.ts` / `engine.owner.test.ts` do **not** fail: no existing engine test runs ten minutes of barren cycles, so the blocker never appears there. |
| g | `stop()` clears the streak but does not retract the notice | 2 — loop: *takes the notice back when the loop stops…*; engine: *clears it whenever the loop stops, so capture off never sits under the notice* |
| h | `trayKey` ignores `nothingRead` | 1 — tray state: *rebuilds the menu when nothing-to-read flips, and not for what it says* |

## Decisions, and what they cost if wrong

1. **`onNothingRead` / `onReadingAgain` are REQUIRED deps, not optional.** Only three construction sites exist (two in `loop.test.ts`, one in `engine.ts`), all fixed. Optional deps would let a future caller build a loop where the whole feature is silently off — exactly the class of bug this task exists to fix. *Cost if wrong:* a future test that wants a bare loop has to pass two `vi.fn()`s.
2. **`onNothingRead(counts, since)` — a second argument the brief did not name.** Point 5 requires `since` = the last productive time, and only the loop knows it (the engine cannot derive it: the time the notice was last cleared is off by a whole streak). Passing it is the only way to make `since` correct. *Cost if wrong:* nothing functional; the renderer sees an accurate "since" instead of one that could be ten-plus minutes late.
3. **`stop()` retracts the notice (calls `onReadingAgain` when one is up).** The sentence is about a *running* loop; left standing with capture off it contradicts the tray beside it. The loop raised it, so the loop takes it back — one owner, and none of the four callers of `loop.stop()` (`evaluate`, `startFreshFor`, `deleteAllData`, `quit`) has to remember. `endStreak()` runs after `active = false`, so anything the callback asks about the loop gets the truth. *Cost if wrong:* a stop during a raised streak emits one extra status; `evaluate()` emits again immediately after, so the renderer sees one redundant push.
4. **Ties in `nothingReadWhy` go to `notAllowed`, then `noWindow`, then `other`.** "The apps in front are ones you excluded" is actionable in Settings; "there was nothing in front" less so; "other" least. `other` is computed as the *remainder*, so a barren outcome added later lands there by itself rather than in a group it does not belong to. *Cost if wrong:* the renderer shows the less useful of two equally-sized reasons.
5. **`trayKey` carries `nothingRead` as a flag, not its contents.** The label is one fixed sentence whichever `why` it holds, and `since` does not move within a streak. *Cost if wrong:* the menu would not rebuild if the copy later became reason-dependent — the renderer task must extend `trayKey` if it makes the tray label vary by `why`.
6. **The tray TITLE glyph stays `●`.** Nothing is broken; `trayState()` is untouched and still returns `"on"`. An `!` would send the user looking for something to fix.
7. **`LOG_COUNT_KEYS` extended with every `CycleOutcome` name, not just the barren ones**, because `CAPTURE_OFF` carries the lifetime `stats()` (its first production caller). The set stays *closed* and is still checked at runtime in `log.event`; a compile-time assert in `engine.ts` (`AssertCycleOutcomesAreCountKeys`) means a new outcome without a key stops typecheck rather than being silently dropped. Privacy is proven by test, not assumed: the engine test drives a streak with app `"1Password"` and title `"Priya Raman — recovery codes"` and asserts none of those strings reaches `app.log`, and that every logged count value is a `number`.

## One thing in the brief that is not as described

**There is no schema validating `EngineStatus` across IPC.** Point 6 says to "carry `nothingRead` through whatever schema validates `EngineStatus` for the renderer (`shared/ipc.ts`)", and the test list asks for "IPC schema accepts/rejects the field shape". No such schema exists: `main/ipcRouter.ts` validates only what the **renderer sends** (zod `ARGS`), and `engine.status()` goes out unvalidated because main is the trusted sender. `shared/ipc.ts` is deliberately type-only plus channel constants — a zod import there would pull runtime code into the renderer bundle, which is the one thing its header comment says it exists to prevent, and `renderer/bundle.guard.test.ts` guards that boundary.

I did **not** invent a validator with no caller. Instead the field is pinned three ways:

- `NOTHING_READ_WHY` — a runtime, dependency-free closed list of the three reasons, declared in `shared/ipc.ts` (the renderer side of the line) and kept equal to the engine's union by `AssertNothingReadWhyIsClosed` in **both** directions at compile time;
- `AssertNothingReadShape` — `EngineStatus["nothingRead"]` is exactly `NothingRead | null`;
- two runtime tests in `shared/ipc.test.ts`: the reason list is exactly the three codes with no fourth, and a status carrying the field survives `JSON.parse(JSON.stringify(...))` (what Electron does to it on the way to the renderer) with `since` still a number, `why` still in the closed set, and exactly the keys `since` / `why`.

If a real runtime schema for outgoing status is wanted, it belongs in `main/ipcRouter.ts` (which already has zod) and is a separate decision: it changes what happens when main's own payload fails its own check, which is out of this task's scope.

## What the renderer task needs to know

**The exact type** (`src/main/engine.ts`, re-exported from `src/shared/ipc.ts`):

```ts
export type NothingReadWhy = "notAllowed" | "noWindow" | "other";
export interface NothingRead { since: number; why: NothingReadWhy }
// on EngineStatus:
nothingRead: NothingRead | null;
```

- `since` is an epoch-ms timestamp: when the loop last read something, or when capture was switched on if it never has. It does **not** move while a streak is up, so `Date.now() - since` is "how long this has been going on".
- `null` whenever reading is producing something **and** whenever the loop is not running. The renderer never has to cross-check it against `capture`.
- Import the closed reason list as a value from `../../shared/ipc`:
  `import {NOTHING_READ_WHY} from "../../shared/ipc";` — use it to build an exhaustive `Record<NothingReadWhy, …>` so a fourth reason is a compile error.
- Not a blocker. `status.blockers` is unchanged, `capture` stays `"on"`, and `trayState()` still returns `"on"`. The renderer must **not** render it through the blocker screen/fix-button path.

**Where COPY strings go** (`src/renderer/copy.ts`):

- The tray sentence already exists as `COPY.tray.onNothing = "Reading is on. Nothing to read right now."` — inside the existing `tray:` block, whose comment explains that the tray menu lives in the shell but its words are reviewed with all the others. Do not duplicate it.
- The in-window copy is **not written**. Add it as its own block (suggested `COPY.nothingRead`) with one sentence per `NothingReadWhy`, keyed as a `Record<NothingReadWhy, string>` so `NOTHING_READ_WHY` and the copy stay in lockstep. The blocker-style pairing in `COPY.blockers` (`{sentence, action}`) is the nearest existing shape, but note this is not a blocker — there may be no action for `"other"`.
- `src/renderer/dev/mockBridge.ts` currently only carries `nothingRead: null` (typecheck ripple). The renderer task will want a scenario that sets it; that is renderer work and was deliberately left alone.

**Tray behaviour already wired**: `shell/app.ts` picks `COPY.tray.onNothing` for the first menu item when `capture === "on"` and `nothingRead` is set; the checkbox stays checked, because reading *is* on. `trayKey` flips on the field so the menu rebuilds — extend `trayKey` if the label ever varies by `why`.
