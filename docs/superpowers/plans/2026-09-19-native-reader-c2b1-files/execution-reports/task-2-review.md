# Task 2 review — Nothing-read notice, main-process half (independent reviewer, N = 2)

Scratch copy: `/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/exec/rev-2/app`
Nothing under `/Users/sardorastanov/techcells/asset-to-evidence` was modified. At the end of the review the scratch copy is byte-identical to `app/` (`diff -rq` on `src/` and `scripts/` empty) and the thirteen topic-2 files still match `MANIFEST.sha256` (0 drift).

Baseline in the copy: the topic's five test targets → **60 passed**; whole suite → **1429 passed | 1 skipped in 84 files** (the plan's 1430); `tsc --noEmit` clean for `tsconfig.json` and `tsconfig.renderer.json`.

---

## 1. Answers to the task's questions

### Q1 — Is `CYCLE_CLASS` exhaustive by type?

**Yes, in both directions, and the count-key assert fires with it.**
`src/main/capture/loop.ts:36-41` — `} as const satisfies Record<CycleOutcome, CycleClass>`.

- Adding `| "fakeOutcome"` to `CycleOutcome` (`loop.ts:11-13`) → `loop.ts(41) TS2741: Property 'fakeOutcome' is missing … required in type 'Record<CycleOutcome, CycleClass>'`, plus `loop.ts(44) TS2536`, `loop.ts(48) TS7053`, `loop.ts(121) TS7053`, **and** `engine.ts(64) TS2344: Type 'false' does not satisfy the constraint 'true'` (`AssertCycleOutcomesAreCountKeys`).
- Adding a row `ghost: "barren"` with no such outcome → `loop.ts(40) TS2353: Object literal may only specify known properties, and 'ghost' does not exist in type 'Record<CycleOutcome, CycleClass>'`.
- A new outcome **with** a class row but **without** a `LOG_COUNT_KEYS` entry → `engine.ts(64) TS2344` alone. The claim in `log.ts:22-24` ("a new outcome cannot arrive as a dropped count") holds.

### Q2 — Can the notice be raised while capture is off, or stay up after `stop()`?

**No on both counts.**

*Raised:* `noteOutcome` (`loop.ts:120-134`) is called from exactly one place, `trigger()`'s do/while (`loop.ts:224`). Every barren `return` inside `cycle()` is preceded by a generation check — `loop.ts:177` (before `noWindow`/`denied`), `loop.ts:185` (before `result.reason`, i.e. `locked`/`black`/`windowGone`), `loop.ts:196` (before both `windowChanged` returns and `ingest`) — and `"stopped"` is `neutral` (`loop.ts:40`), so a cycle still in flight when `stop()` lands can never extend a streak. The `catch` (`loop.ts:206-212`) returns only `stopped`/`timeout`/`failed`, all neutral. Everything between a generation check and its `return` is synchronous, so there is no gap.

*Stays up:* `stop()` sets `active = false` (`loop.ts:277`) and `generation += 1` (278) **before** calling `endStreak()` (`loop.ts:293`); `endStreak` (`loop.ts:108-113`) clears `noticeUp` and calls `onReadingAgain`, which nulls the engine's field (`engine.ts:237`). All four stop paths go through `loop.stop()`: `evaluate` (`engine.ts:313`), `startFreshFor` (`engine.ts:529`), `deleteAllData` (`engine.ts:709`), `quit` (`engine.ts:743`). `status()` reads the field directly (`engine.ts:281`) and `capture` is `"on"` exactly while `loop.running()` (`engine.ts:277`).

Five engine probes of my own (pause for an hour, the permission being taken away → `NO_PERMISSION` blocker, `quit()` under a raised notice, `system("locked")`/`"unlocked"` across a raised notice, plus a per-emit invariant watcher asserting `nothingRead !== null ⟹ capture === "on"` on **every** status pushed) recorded **zero** violations. Two loop probes of my own held `frontWindow()` open across the threshold cycle, called `stop()` under it and then released it: the notice was neither raised late (P1) nor re-raised after retraction (P2).

Ordering detail worth recording as a positive: `noticeUp = true` is set **before** `deps.onNothingRead` (`loop.ts:130-133`) and `noticeUp = false` **before** `deps.onReadingAgain` (`loop.ts:111-112`), so a callback that synchronously reaches back into the loop cannot double-raise or double-retract.

### Q3 — At most once per streak under re-entrant triggers (`dirty` loop)?

**Yes.** `loop.ts:127` `if (noticeUp) return;` inside the one function that grows a streak. `trigger()` (`loop.ts:215-227`) collapses concurrent triggers into `dirty` and re-enters the same `noteOutcome`, so the guard is the only thing standing — mutation (d) removing it fails 2 tests. My probe P3 drove a second streak entirely through 400 focus notifications (`FOCUS_SETTLE_MS` apart, so cycles land back-to-back inside one `trigger()`): exactly 2 notices for 2 streaks.

### Q4 — Are all log values numbers under keys from the closed `LogCountKey` set?

**Yes.** `log.ts:54-58` keeps a pair only when `COUNT_KEY_SET.has(key) && typeof value === "number" && Number.isFinite(value)`; the set is `LOG_COUNT_KEYS` (`log.ts:26-30`), still closed, now 16 entries. The values that reach it are `BarrenCounts` (`loop.ts:46`), whose keys are `BarrenOutcome` literals, and `loop.stats()` (`loop.ts:296`), whose keys are `CycleOutcome` literals; no window title, app name or recognised text is ever a key by construction (the keys are the literal strings returned by `cycle()`).
Proven, not assumed: smuggling `{...counts, "1Password": 1, "Priya Raman": 2}` into the engine's `log.event("READER_NOTHING_TO_READ", …)` call leaves the written line unchanged (`counts` still `{denied: N}`), and dropping the `COUNT_KEY_SET.has(key)` clause from `log.ts:55` fails 3 tests in `log.test.ts`. `{blockers: …, ...loop.stats()}` (`engine.ts:313`) cannot collide: no `CycleOutcome` is named `blockers`.

### Q5 — Is `blockers()` byte-identical to the backup?

**Yes, exactly.** `engine.ts:240-262` extracted from both files: identical bytes, `sha256 4f6819a43967…`, length 1243 in each. No diff hunk touches it. `nothingRead` is not a blocker and is not in `Blocker`.

### Q6 — Does a throwing `onNothingRead` leave the loop running?

**Yes.** Both callbacks go through `safely()` (`loop.ts:100-103`, used at `loop.ts:112` and `loop.ts:133`). Test *"keeps reading when either callback throws"* asserts `loop.running()` and that four further cycles are still kept. Recorded consequence, correct by design but worth stating: `noticeUp` is already `true` when the throw happens, so a streak whose callback threw is never reported to the engine and the user sees nothing until it ends — the caller's fault, not the loop's.

### Q7 (my brief) — Is the loop's existing privacy logic unchanged apart from `expect`?

**Yes.** Against `c2b1-backup`, `cycle()` has exactly three changes: `reader.read({budgetMs, expect: front})` split over two lines (`loop.ts:181-184`), the comment above the after-checks expanded, and the `unchanged` branch (`loop.ts:202-205`). `pipeline.mayCapture(front)` still gates before any `read` (`loop.ts:179`), and **both** after-checks are byte-identical to the backup:
`loop.ts:197` `if (!after || after.app !== front.app || after.title !== front.title) return "windowChanged";`
`loop.ts:198` `if (result.window.app !== front.app || result.window.title !== front.title) return "windowChanged";`

---

## 2. Mutation table — every mutation of the developer's report re-run

Each applied to the scratch copy, suite run, file restored from `app/` and `filecmp`-verified byte-identical.
Targets: `src/main/capture src/main/log.test.ts src/main/engine.nothingRead.test.ts src/shared src/shell/trayState.test.ts` (+ the two engine test files for (f)).

| # | Mutation | Result | Failing tests |
|---|---|---|---|
| a | `unchanged` classified as `barren` | **BITES** | 3 — *has an answer for every outcome…*; *counts a screen that has not moved…*; *an unchanged cycle ends a streak…* |
| b | `userAway` classified as `barren` | **BITES** | 2 — *has an answer for every outcome…*; *a user who is away neither extends the streak nor ends it* |
| c | time condition dropped | **BITES** | 7 — as the report lists, exactly |
| d | once-per-streak guard dropped | **BITES** | 2 — as the report lists |
| e | `onReadingAgain()` never called | **BITES** | 6 — as the report lists |
| f | `nothingRead` pushed into `blockers()` | **BITES** | 1 — engine *says so in the status…*. Compile half re-checked separately (below) |
| g | `stop()` clears the streak but does not retract | **BITES** | 2 — as the report lists |
| h | `trayKey` ignores `nothingRead` | **BITES** | 1 — *rebuilds the menu when nothing-to-read flips…* |

**All eight bite, with the exact counts and test names the report claims.**

One report-accuracy nit on (f): adding a `"NOTHING_READ"` member to `Blocker` breaks **three** exhaustive records, not two — `src/renderer/copy.ts(24)`, `src/shell/trayState.ts(19)` and `src/renderer/model/controls.ts(27)`, all `TS2741`. Not a defect; the report undercounts its own safety net.

---

## 3. Independent probes (the developers never saw these)

| Probe | Result |
|---|---|
| (i) classify `locked` as `neutral` | **BITES** — 1 test (*has an answer for every outcome…*). Note: the classification table is the **only** guard; no test drives a behavioural streak of `locked`. |
| (ii) reset the streak on `windowChanged` | **SPLIT.** Table route (`windowChanged: "productive"` in `CYCLE_CLASS`) **bites** (1 test). Behavioural route — `if (outcome === "windowChanged") { endStreak(); return; }` inserted in `noteOutcome` before `loop.ts:124` — **DOES NOT BITE**: all 60 tests pass. See F1. |
| (iii) log the counts under a key outside `LogCountKey` | **REFUSED, as designed.** Engine-side smuggle (`{...counts, "1Password":1, "Priya Raman":2}`) changes nothing in `app.log`. Removing the closed-set check in `log.ts:55` fails **3** tests in `log.test.ts`: *cannot be made to carry a sentence…*; *takes every capture-loop outcome as a count key, and still refuses anything else*; *drops a count key that is not one of `LOG_COUNT_KEYS`, and keeps a valid one*. |
| (iv) raise at 24 cycles **OR** 10 minutes instead of AND | **BITES HARD** — 10 tests (8 in `loop.test.ts`, 2 in `engine.nothingRead.test.ts`). |
| (v) confirm `since` is a time and never anything read from a window | **CONFIRMED by reading and by test.** `since` is `lastProductiveAt` (`loop.ts:132`), only ever assigned `now()` (`loop.ts:123`, `loop.ts:271`). It crosses as `{since, why}` (`engine.ts:233`) and nothing else; `NothingRead` is `{since: number; why: NothingReadWhy}` (`engine.ts:38`), pinned by `AssertNothingReadShape` (`ipc.ts:91`). My probes assert `typeof since === "number"`, `Object.keys(nothingRead).sort() === ["since","why"]`, and that `JSON.stringify(status())` contains none of `Priya`/`Raman`/`1Password`/`recovery` after ten minutes of a `1Password` window titled `"Priya Raman — recovery codes"`. |

### My own probes (written in the scratch copy only; both files deleted afterwards)

`src/main/capture/loop.reviewer2.test.ts` — 5 tests, all pass:
1. `stop()` landing on the cycle that would cross **both** conditions (`frontWindow()` held open, stop, release) → `onNothingRead` never called, `onReadingAgain` never called, `running() === false`.
2. the same with the notice already up → retracted exactly once by `stop()`, and 200 further polls of the released cycle raise nothing.
3. a second streak driven entirely by 400 focus notifications (re-entrant `dirty` cycles inside one `trigger()`) → exactly 2 notices for 2 streaks.
4. `start()` called while the previous run's cycle is still open → the fresh run's streak and clock both start at the restart (119 polls silent, the 120th raises), `onReadingAgain` never called.
5. `since` is a timestamp equal to `start()`'s `now()`; `counts` keys are `["denied"]`, values numbers, and the JSON matches none of the screen's words.

`src/main/engine.reviewer2.test.ts` — 5 tests, all pass: pause-for-an-hour, permission taken away, `quit()`, screen lock/unlock, and the status-privacy check, each with a listener asserting the `nothingRead !== null ⟹ capture === "on"` invariant on every emitted status. **Zero violations in any of them.**

---

## 4. Findings

### F1 — Minor: probe (ii) does not bite in its behavioural form; four of the seven barren outcomes have no end-to-end test

**Where:** `src/main/capture/loop.ts:120-134` (`noteOutcome`), `src/main/capture/loop.test.ts:366-383` (the `CYCLE_CLASS` table test).
**Reproducing probe:** insert `if (outcome === "windowChanged") { endStreak(); return; }` immediately above `loop.ts:124` (`const key = outcome as BarrenOutcome;`) and run `src/main/capture src/main/log.test.ts src/main/engine.nothingRead.test.ts src/shared src/shell/trayState.test.ts` → **60 passed**, nothing fails.
**Why it matters:** the classification table is pinned by a table test and the *behaviour* is pinned only for `noWindow`, `denied` and `notKept`. `windowGone`, `black`, `windowChanged` and `locked` are never driven through a streak by any test, so a special case added inside `noteOutcome` (or a future early return) silently removes them from the feature. Per the plan's own rule ("a probe that does not bite is a FINDING"), recorded as one.
**Suggested fix:** one table-driven test in the new `describe` that, for each of the seven `BarrenOutcome`s, drives 120 cycles producing it (`reader.nextRead = {ok: false, reason}` covers `windowGone`/`black`/`locked`; `duringRead` covers `windowChanged`) and asserts `onNothingRead` fires once with that outcome as the only count key.

### F2 — Minor: `CAPTURE_OFF` carries the loop's **lifetime** counts, so consecutive lines double-count

**Where:** `src/main/engine.ts:313` (`{blockers: …, ...loop.stats()}`), `src/main/capture/loop.ts:91` (`stats` is created once and never reset — `start()` at `loop.ts:265-271` resets `failures` and the streak but not `stats`).
**Reproducing probe:** capture on, 3 `noWindow` cycles, off, on, 2 more, off → the two `CAPTURE_OFF` lines read `{blockers: 0, noWindow: 3}` then `{blockers: 0, noWindow: 5}`, not `3` then `2`.
**Why it matters:** `CaptureLoop.stats()` is documented as "since the loop was created" (`loop.ts:55`) and the engine's new comment says "lifetime tallies", so this is intended — but anyone reading `app.log` will read a `CAPTURE_OFF` line as "what that run did", and C-2b-2 takes carried items 11/13/27 off these lines. Nothing pins the behaviour either way.
**Suggested fix:** no code change needed; add the word *cumulative* to the spec note of Task 10 step 1 (section 5.4 or 8) and one test asserting the second line is the sum. If per-run numbers are wanted instead, reset `stats` in `start()` — but that changes the `stats()` contract and D3's measurement story, so it is an owner call.

### F3 — Minor: `notKept` → `notAllowed` mis-messages the `empty` skip reason

**Where:** `src/main/capture/loop.ts:205` (every non-`unchanged` skip reason collapses into `notKept`), `src/main/engine.ts:74` (`notAllowed = sum("denied", "notKept")`), `src/renderer/copy.ts:47`.
**Why it matters:** `SkipReason` (`src/core/types.ts:10-12`) includes `empty` — recognised text shorter than `MIN_READ_CHARS = 40` (`src/core/buffer.ts:24`), which is what a video player, an image, a near-blank terminal or a design tool produces. A streak of those is reported as `notAllowed`, whose sentence is *"The windows in front are ones this app does not read."* — which sends the user to Settings for something that is not an exclusion. `scrubFailed` lands there too.
**Reproducing probe:** an `ingest` override returning `{kept: false, reason: "empty"}` for 120 cycles → `onNothingRead({notKept: 121})` → `nothingReadWhy` → `"notAllowed"`.
**Suggested fix:** cheapest is a dated spec note under 5.3 recording that `notKept` is a mixed bucket dominated by exclusions. If the copy is to be exact, `empty` needs its own `CycleOutcome` (and a `LOG_COUNT_KEYS` entry) mapped to `other` — a D6 change and therefore an owner decision, not a fix-round item.

### F4 — Minor (recorded, not a regression): nothing in `src/shell/app.ts` is covered by a test

**Where:** `src/shell/app.ts:163` (the tray label switch) and `app.ts:227-228` (`const unwatchFocus = …; teardown.push(unwatchFocus);`, item 38 / D8).
There is no `src/shell/app.test.ts`, so no mutation of either line fails anything; `trayState.test.ts` covers only `trayKey`, i.e. *that* the menu rebuilds, never *which label it picks*. Both lines are correct by reading: the label is guarded by `status.capture === "on"` (consistent with the Q2 invariant), and `runTeardown()` (`app.ts:83-88`) pops and calls every entry and is reached on all three quit paths (`app.ts:283, 305, 312`). Pre-existing structural gap (Electron-bound module), stated so C-2b-2's manual checklist covers the tray label by eye.

### F5 — Minor: five assertions in the new tests cannot fail

- `src/main/capture/loop.test.ts:465` — `expect(outcome).toBeDefined();` on a `let` that is always assigned.
- `src/shared/ipc.test.ts:31` — `for (const why of NOTHING_READ_WHY) expect(typeof why).toBe("string");` over a three-element `as const` array of string literals.
- `src/shared/ipc.test.ts:52-53` — `expect(allowed.has("Priya Raman — recovery codes")).toBe(false)` / `expect(allowed.has("1Password")).toBe(false)` against that same three-element set.
- `src/main/engine.nothingRead.test.ts:78` — restates line 76's per-value `typeof` check.

None is wrong; they read as documentation but count as coverage. **Suggested fix:** delete them, or turn the `ipc.test.ts` pair into what it is trying to say (`expect(NOTHING_READ_WHY.every((w) => /^[a-zA-Z]+$/.test(w))).toBe(true)`).

### F6 — Minor (defensive): the engine's `onNothingRead` does not check `loop.running()`

**Where:** `src/main/engine.ts:232-236`.
Unreachable today (Q2), but it is the one place where a future slip is unrecoverable: a barren outcome arriving after `stop()` would set `nothingRead` *after* `endStreak()` had already retracted it, and nothing would ever clear it — the tray and the Home line would then claim "reading is on, nothing to read" with capture off, which is exactly what D6 forbids.
**Suggested fix:** `onNothingRead: (counts, since) => { if (!loop.running()) return; … }` (`loop` is in scope by the time the callback can fire), plus one test that calls the dep directly after `stop()`.

---

## 5. Things checked and found clean (no finding)

- `NOTHING_READ_WHY` (`ipc.ts:22`) is a dependency-free value on the renderer side; `renderer/bundle.guard.test.ts` still passes, so nothing from `main/` entered the renderer bundle. Adding a fourth member breaks `AssertNothingReadWhyIsClosed` (`ipc.ts:89`) in **both** configs plus `renderer/model/views.test.ts` — the closed list really is closed.
- `nothingRead` reaches no upload path: the only non-test readers are `shell/trayState.ts`, `shell/app.ts`, `renderer/model/views.ts` and `renderer/dev/mockBridge.ts` (grep over `src/**`). Nothing in `main/upload` or `main/account` touches it.
- `READER_NOTHING_TO_READ` is in `LOG_CODES` (`log.ts:13`) and matches Task 9's `grep -o '"code":"[A-Z_]*"'`.
- `nothingReadWhy` on an empty `counts` returns `"notAllowed"`; unreachable, since `streakLength >= BARREN_CYCLE_LIMIT` guarantees at least one count.
- `BARREN_CYCLE_LIMIT = 24` / `BARREN_AFTER_MS = 10 * 60_000` (`constants.ts:28-29`) are D6's constants exactly, and the comment's arithmetic (24 cycles = 2 min at the 5 s poll, 12 min at the 30 s poll) is right.
- The developer's "one thing in the brief that is not as described" (no outgoing `EngineStatus` schema) is accurate: `shared/ipc.ts` is type-only plus channel constants, and `main/ipcRouter.ts` validates only inbound renderer calls. D15 covers it.

---

## Verdict

**APPROVED WITH MINORS** — no Critical and no Important finding. All eight of the developer's mutations bite exactly as reported; four of the five independent probes bite; the fifth (probe ii) exposes a test-coverage gap, not a behavioural defect. The re-entrancy of the `dirty`/`generation`/`stop()` machinery is sound under direct probing, the engine never shows the notice while capture is off on any of the four off-paths, the log's key set is closed and proven closed, and the loop's existing privacy logic is byte-identical to the backup apart from `expect`.

Spec compliance: ✅
Quality: Approved
