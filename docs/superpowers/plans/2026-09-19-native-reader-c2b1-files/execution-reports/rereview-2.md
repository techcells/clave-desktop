# Re-review — Topic 2 (nothing-read notice, main half), fix round 1

Scratch copy: `rr-2/app`. Baseline before any probing, on the dispatch's five targets
(`src/main/capture src/main/log.test.ts src/main/engine.nothingRead.test.ts src/shared src/shell/trayState.test.ts`):
**71 passed**. Full topic set including the other three engine test files: **130 passed**. `tsc --noEmit`
clean on both `tsconfig.json` and `tsconfig.renderer.json`. Every mutation below was reverted by hand,
run, and the file restored and `diff`-verified byte-identical to `/Users/sardorastanov/techcells/asset-to-evidence/app` before moving to the next.

## Findings table

| Finding | Ruling | Verdict | Evidence |
|---|---|---|---|
| F1 — windowGone/black/windowChanged/locked never driven through a real streak | each must fail a behavioural test when that outcome ends the streak | **ADDRESSED** | `loop.test.ts:396-413` adds an exhaustive `Record<BarrenOutcome, …>` driver table and `loop.test.ts:421-433` an `it.each` that drives 121 cycles of each of the 8 barren outcomes and asserts one raise. Inserted `if (outcome === "<O>") { endStreak(); return; }` above `loop.ts:130` for each of `windowChanged`, `windowGone`, `black`, `locked` in turn: each produced **exactly 1 failure** (`raises the notice on a streak of nothing but <O> cycles`), nothing else. Restored and `diff`-verified clean each time. |
| F2 — `stats()` counts since last `start()`; CAPTURE_OFF carries per-run counts (3 then 2, not 3 then 5) | ruling's exact numbers | **ADDRESSED** | `loop.ts:97` `const stats` → `let stats`; `loop.ts:279` adds `stats = {};` in `start()`. Deleting that line reproduced **exactly 3 failures**: *counts each run on its own…* (second CAPTURE_OFF line reads 5, not 2), *never charges a cycle that stop() abandoned…* (`{stopped: 2}`), *starts a fresh run…* (`{noWindow: 84}` vs `61`). New test `engine.nothingRead.test.ts:199-214` asserts the ruling's literal case: two CAPTURE_OFF lines read `{blockers: 0, noWindow: 3}` then `{blockers: 0, noWindow: 2}`. Restored, 55 baseline passed. |
| F3 — `empty` is its own barren outcome, own fixed log key, mapped to `other` (never `notAllowed`) | own outcome, own log key, `other` | **ADDRESSED** | `loop.ts:13` adds `"empty"` to `CycleOutcome`; `loop.ts:40` `empty: "barren"` in `CYCLE_CLASS`; `loop.ts:211-216` `cycle()` returns `"empty"` for `reason === "empty"` instead of collapsing into `notKept`; `log.ts:29` adds `"empty"` to `LOG_COUNT_KEYS`. Reverting the `cycle()` branch to `return "notKept"` (always) → **exactly 2 failures**: engine's *calls a run of near-blank screens what it is…* (`why` became `"notAllowed"` not `"other"`) and loop's *raises the notice on a streak of nothing but empty cycles* (`{notKept: 121}` vs `{empty: 121}`). Removing `"empty"` from `LOG_COUNT_KEYS` → `tsc` errors exactly as claimed: `engine.ts(64,54) TS2344` (`AssertCycleOutcomesAreCountKeys`) and `log.test.ts(46,82) TS2353`. `engine.ts`'s `nothingReadWhy` (`engine.ts:71-82`) computes `other` as the remainder, unchanged — `empty` lands there by construction, confirmed by the two `nothingReadWhy({empty: …})` unit cases and the end-to-end QuickTime test. All restored and `diff`-clean. |
| F4 — deferred, not in scope | no action required | **N/A (confirmed deferred)** | `src/shell/app.ts` untouched; not in the fixer's file set; matches the ruling. |
| F5 — five un-failable assertions fixed or deleted | must be made able to fail, or removed | **ADDRESSED** | `loop.test.ts` — the `let outcome …; expect(outcome).toBeDefined();` guard is now `const outcome: IngestOutcome = …` at line 507 (the paired test that does reassign keeps `let` at line 518, confirmed by grep). `ipc.test.ts:35` replaces the three-element `for…of typeof` loop with `NOTHING_READ_WHY.every((why) => /^[a-zA-Z]+$/.test(why))`; the two `allowed.has("Priya Raman — recovery codes")`/`allowed.has("1Password")` literal-set assertions are gone, replaced by the loop at `ipc.test.ts:38-51` which iterates `NOTHING_READ_WHY` itself rather than testing properties of a hand-written 3-element set. `engine.nothingRead.test.ts` no longer restates the per-value `typeof` check. Confirmed the pattern assertion is live by mutating it (temporarily) and observing a failure, then restoring — `diff`-clean afterward. |
| F6 — engine ignores `onNothingRead` while the loop is not running | first line of the callback | **ADDRESSED** | `engine.ts:237` `if (!loop.running()) return;` is the first statement of `onNothingRead`, before `nothingRead = {...}` is set. Deleting that line → **exactly 1 failure**, `engine.nothingRead.test.ts` *ignores a nothing-read report that arrives while the loop is not running* (status showed a live `nothingRead` instead of `null` after a direct post-`stop()` call to the captured dep). Restored, 9/9 passed, `diff`-clean. |

**All six ADDRESSED** (F4 correctly deferred, no action expected).

## `vi.mock` verification (new to this repo)

- **Wraps, not replaces:** `engine.nothingRead.test.ts:16-22` calls `importOriginal()`, spreads `...actual`, and only overrides `createCaptureLoop` to record `deps` before calling straight through to `actual.createCaptureLoop(deps)` — the real loop object is what `createEngine` gets back. Confirmed empirically: all 8 other tests in the file (which never touch `built.deps`) drive the real loop's timer/streak machinery exactly as the reviewer's own probes described (fake timers, 120-poll streaks, `onReadingAgain`, etc.) and pass.
- **Cannot leak to other test files:** temporarily made the mocked `createCaptureLoop` throw (`throw new Error("MOCK_LEAK_PROBE")`) and ran `engine.nothingRead.test.ts` together with `engine.test.ts`, `engine.owner.test.ts`, `engine.readerEvents.test.ts`, and `loop.test.ts`. Result: all 8 tests in `engine.nothingRead.test.ts` failed with that error, and the other 4 files' **106 tests all still passed** — proving they received the real, unmocked `createCaptureLoop`. Restored; `diff` against the real repo file is empty.
- **The F6 test would fail without the mock:** without `vi.mock`, there is no way to reach the engine's captured `deps.onNothingRead` directly (the loop is created inside `createEngine` and not otherwise exposed), so the F6 test as written could not exist without it. Independently, the guard-revert proof above shows the test does fail when the guard is missing — the mock is what makes the test able to detect the defect it targets, not a decoration.

## Privacy-logic byte-identity (own brief item)

Compared `cycle()`'s three privacy-critical lines against `c2b1-backup/app/src/main/capture/loop.ts`:
- `loop.ts:185` `if (!pipeline.mayCapture(front).allow) return "denied";` — **byte-identical** (backup line 91).
- `loop.ts:203` `if (!after || after.app !== front.app || after.title !== front.title) return "windowChanged";` — **byte-identical** (backup line 104).
- `loop.ts:204` `if (result.window.app !== front.app || result.window.title !== front.title) return "windowChanged";` — **byte-identical** (backup line 105).

A full-file diff against the backup shows only the expected additions: the `expect: front` split (with a new comment), the `CYCLE_CLASS`/`BarrenOutcome`/`noteOutcome`/`streak` machinery from the original C-2b-1 feature (predates this fix round), the `unchanged`/`empty` outcome branches, and the F1-F3/F6 changes documented above. Nothing in the gating or after-check logic itself moved.

## New breakage scan (changed lines only)

Diff hunks for the topic's seven files in `fix1-all.diff` (`loop.ts`, `loop.test.ts`, `log.ts`, `log.test.ts`, `engine.ts`, `engine.nothingRead.test.ts`, `ipc.test.ts`; `constants.ts` and `ipc.ts` have no hunks, matching the fixer's claim that neither needed a change) are all small, additive, and match the findings above one-for-one. No Critical or Important issue found in the changed lines. Full topic suite (130 tests, 8 files) passes; `tsc --noEmit` clean on both configs.

One benign observation: the fixer's addendum flagged a typecheck failure in `src/readerEval/summary.test.ts` (outside this topic's file set) as of their last run. Re-checked here: `tsc --noEmit` is clean on both `tsconfig.json` and `tsconfig.renderer.json` in this copy, so that issue has since been resolved by whichever fixer owns that file — not a topic-2 concern.

## Observations (out of scope, do not affect verdict)

- None beyond what's already recorded above.

## Verdict

**ALL ADDRESSED.** No new Critical or Important breakage in the topic's changed lines.
