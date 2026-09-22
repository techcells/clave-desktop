# Fix round 1 — topic 2 (nothing-read notice, main half)

Files owned: `src/main/capture/loop.ts` + `loop.test.ts`, `src/main/constants.ts`, `src/main/log.ts` +
`log.test.ts`, `src/main/engine.ts`, `src/main/engine.nothingRead.test.ts`, `src/shared/ipc.ts` +
`ipc.test.ts`. Nothing outside that set was touched (`constants.ts` and `ipc.ts` needed no change; `ipc.ts`
was only mutated and restored as part of a proof). No new files. No git.

Baseline before any edit, on the dispatch's targets
(`src/main/capture src/main/engine.nothingRead.test.ts src/main/log.test.ts src/shared`): **55 passed**.
After: **66 passed**. With the other three `src/main/engine*.test.ts` added: **125 passed**, `pnpm typecheck`
clean (both `tsconfig.json` and `tsconfig.renderer.json`).

Byte check after every edit (python, bytes): the eight files contain no control byte other than `\n`/`\t`
and no non-ASCII character except the em dash that the surrounding prose already uses. No Cyrillic/Greek.

---

## F1 — every barren outcome now driven through a real streak

**Changed:** `src/main/capture/loop.test.ts:385-432` — a new exhaustive driver table plus one `it.each`
test in the `describe("capture loop: a long run in which nothing is read")` block:

- `streakOf: Record<BarrenOutcome, () => ReturnType<typeof setup>>` (loop.test.ts:392-415). Because it is a
  `Record` over `BarrenOutcome`, a barren outcome added later has no driver until someone writes one — a
  third exhaustive table beside `CYCLE_CLASS` and `AssertCycleOutcomesAreCountKeys` (proven under F3c).
  Drivers: `noWindow` (no front window), `denied` (core refuses), `notKept` (`excludedTitle`), `empty`
  (`reason: "empty"`), `windowGone`/`black`/`locked` (the reader itself answers so every cycle — `nextRead`
  is spent by one cycle and cannot carry a ten-minute streak), `windowChanged` (a `duringRead` that ticks
  the title, so main's own after-check catches every cycle).
- `it.each(...)("raises the notice on a streak of nothing but %s cycles", …)` (loop.test.ts:423-432): 120
  polls silent, the 121st cycle raises exactly once, with `{[outcome]: 121}` as the whole tally, and
  `onReadingAgain` never called.
- Also `src/main/capture/loop.test.ts:369-385`: the `CYCLE_CLASS` key list and the barren list now carry
  `empty` (F3).

**Revert proof — the reviewer's mutation, and the same for every other barren outcome.** Mutation applied to
the real `loop.ts`: `if (outcome === "<O>") { endStreak(); return; }` inserted immediately above
`const key = outcome as BarrenOutcome;` in `noteOutcome`. Target `src/main/capture`, file restored from a
`.bak` and re-run clean (46 passed) after each:

| mutation | before this fix | now |
|---|---|---|
| end the streak on `windowChanged` | 0 failures (the reviewer's F1) | **1** — *raises the notice on a streak of nothing but windowChanged cycles* |
| end the streak on `windowGone` | 0 failures | **1** — *… windowGone cycles* |
| end the streak on `black` | 0 failures | **1** — *… black cycles* |
| end the streak on `locked` | 0 failures | **1** — *… locked cycles* |
| end the streak on `noWindow` | — | 5 (the new one + 4 existing) |
| end the streak on `denied` | — | 4 |
| end the streak on `notKept` | — | 2 |
| end the streak on `empty` | — | 1 |

All eight barren outcomes now bite behaviourally, not only through the classification table.

---

## F2 — `stats()` counts the run, not the object's lifetime

**Changed:**
- `src/main/capture/loop.ts:55-60` — the `CaptureLoop.stats()` doc comment now says "since the last
  `start()`", with the reason: the one caller writes them out when the run ends (`CAPTURE_OFF`), and a
  reader of that line takes it as "what that run did".
- `src/main/capture/loop.ts:96` — `const stats` → `let stats`.
- `src/main/capture/loop.ts:277-279` — `stats = {};` in `start()`, beside `failures = []`, with a comment.
- `src/main/engine.ts:313-317` — the CAPTURE_OFF comment no longer says "lifetime tallies"; it states that
  the loop counts per run and that consecutive lines therefore never double-count.

**Tests:**
- `src/main/engine.nothingRead.test.ts:200-219` (new) *counts each run on its own: a second CAPTURE_OFF line
  carries only the second run* — 3 barren cycles, off, on, 2 more, off → the two lines are
  `{blockers: 0, noWindow: 3}` then `{blockers: 0, noWindow: 2}`. This is the ruling's "3 then 2, not 3 then 5".
- `src/main/engine.nothingRead.test.ts:176` — the existing test renamed from "carries the loop's **lifetime**
  totals" to "carries **that run's** totals"; its own assertions were already per-run and are unchanged.
- `src/main/capture/loop.test.ts:618-624` — *starts a fresh run with an empty streak and a fresh clock* now
  asserts `loop.stats()` equals `{noWindow: 61}` (was `23 + 61`), which is the loop-level pin.
- `src/main/capture/loop.test.ts:300-312` — *never charges a cycle that stop() abandoned to the reader*
  had to change: it asserted the lifetime sum `stopped === 5`. It now asserts `{stopped: 1}` **inside** the
  loop, once per run, five runs in a row — same coverage (five abandoned cycles, none charged), per run.

**Revert proof:** deleting `stats = {};` from `start()` → **3 failures**:
*counts each run on its own…* (the second line reads 5, not 2), *never charges a cycle that stop()
abandoned…* (`{stopped: 2}`), *starts a fresh run…* (`{noWindow: 84}`). Restored, 55 passed.

---

## F3 — `empty` is its own outcome, and never `notAllowed`

A read that worked and found almost no words (`MIN_READ_CHARS = 40`: a video player, an image, a near-blank
terminal, a design tool) used to collapse into `notKept`, which the engine groups as `notAllowed` — whose
sentence sends the user to Settings to look for an exclusion that does not exist.

**Changed:**
- `src/main/capture/loop.ts:13` — `CycleOutcome` gains `"empty"`.
- `src/main/capture/loop.ts:22-23` — the `barren` paragraph mentions "a screen with almost no words on it".
- `src/main/capture/loop.ts:40` — `empty: "barren"` in `CYCLE_CLASS`.
- `src/main/capture/loop.ts:206-213` — `cycle()` returns `"empty"` for `outcome.reason === "empty"`, with a
  comment saying why it must not be reported as `notAllowed` and why it nonetheless stays barren.
- `src/main/log.ts:29` — `"empty"` added to `LOG_COUNT_KEYS`.
- `src/main/engine.ts` — **no change needed**: `nothingReadWhy` computes `other` as the remainder
  (`engine.ts:76-80`), so `empty` lands in `other` by construction and can never be summed into
  `notAllowed`, which is exactly the existing design comment. Pinned by test rather than rewritten.

**Tests:** `loop.test.ts:369-385` (both `CYCLE_CLASS` lists), `loop.test.ts` driver table + `it.each` (F1),
`log.test.ts:44-55` (`empty: 14` through the closed-set check), `engine.nothingRead.test.ts:155-173` (new,
end to end through the REAL pipeline: a QuickTime window whose text is `"00:14 / 41:07"` for ten minutes →
`why: "other"` and `counts {empty: 121}`), `engine.nothingRead.test.ts:244-246`
(`nothingReadWhy({empty: 24})` and `{empty: 20, denied: 4}` → `"other"`).

**Revert proofs (three, each restored afterwards):**
- (a) `cycle()` collapses `empty` back into `notKept` → **2 failures**: *calls a run of near-blank screens
  what it is, and never an exclusion*; *raises the notice on a streak of nothing but empty cycles*.
- (b) `"empty"` removed from `LOG_COUNT_KEYS` → `src/main/engine.ts(64) error TS2344: Type 'false' does not
  satisfy the constraint 'true'` (`AssertCycleOutcomesAreCountKeys`) + `log.test.ts(46) TS2353`, and 2 test
  failures. The count-key table forces it at type level.
- (c) the `empty: "barren"` row removed from `CYCLE_CLASS` → `loop.ts(42) TS2741` (missing from
  `Record<CycleOutcome, CycleClass>`) plus `TS2536`/`TS7053` at `loop.ts:45,49,127`, **and**
  `loop.test.ts(400) TS2353` (the new driver `Record<BarrenOutcome, …>`) and
  `engine.nothingRead.test.ts(228) TS2353`. The class table forces it at type level too.

---

## F4 — deferred, nothing done

`src/shell/app.ts` has no test file and is outside this file set. Untouched, as ruled.

---

## F5 — the five assertions that could not fail

- `src/main/capture/loop.test.ts` — `expect(outcome).toBeDefined();` deleted. The `let outcome` it guarded is
  never reassigned in that test, so it became `const outcome: IngestOutcome = …` (the other test of the pair
  does reassign and keeps `let`).
- `src/shared/ipc.test.ts:33` — `for (const why of NOTHING_READ_WHY) expect(typeof why).toBe("string");`
  replaced by `expect(NOTHING_READ_WHY.every((why) => /^[a-zA-Z]+$/.test(why))).toBe(true);` — every reason a
  bare identifier, no spaces, punctuation or digits, so a reason added later cannot be a phrase off a screen.
- `src/shared/ipc.test.ts:53-54` — the two `allowed.has("Priya Raman — recovery codes")` /
  `allowed.has("1Password")` assertions deleted (they asserted a property of a three-element literal set, not
  of the code); what they were reaching for is now the pattern assertion above.
- `src/main/engine.nothingRead.test.ts:78` — the `Object.values(...).every(typeof === "number")` restatement
  of the per-value check two lines above deleted.

**Revert proof that the replacement is live:** adding `"1Password vault"` to `NOTHING_READ_WHY` in `ipc.ts`
fails that test; isolated (the `toEqual` and `Set`-size assertions temporarily removed so only the pattern
remains) it fails at `src/shared/ipc.test.ts:33:70`, `expected false to be true`. Both files restored.

**One more assertion made able to fail, unprompted:** in the new F6 test, the "nothing was logged either"
check now runs after `await vi.advanceTimersByTimeAsync(0)` — the log write is `background(...)`, so without
the flush that assertion would have passed whatever the engine did.

---

## F6 — the engine ignores a nothing-read report with the loop stopped

**Changed:** `src/main/engine.ts:232-238` — `if (!loop.running()) return;` as the first line of
`onNothingRead`, with a comment saying why this one is worth a defensive line (the notice would be raised
after `stop()` had retracted it and nothing would ever clear it).

**Test:** `src/main/engine.nothingRead.test.ts:135-148` + `:122-147` — the test needed the engine's dep object,
and the loop is created inside `createEngine`. `vi.mock("./capture/loop", …)` **wraps** the module rather than
replacing it: `createCaptureLoop` records the deps and returns the real loop, so every other test in the file
still drives the real thing (all 9 pass). Test *ignores a nothing-read report that arrives while the loop is
not running*: raise the notice for real, `setCapture(false)`, then call `built.deps!.onNothingRead(...)`
directly → status stays `{capture: "off", nothingRead: null}` and no line is written.

**Revert proof:** deleting the guard → **1 failure**, that test
(`expected { Object (capture, resumeAt, …) } to match object { capture: 'off', nothingRead: null }`).
Restored, 9 passed.

---

## Decisions I made

1. **F3, where `empty` is grouped:** I did NOT add an exhaustive `Record<BarrenOutcome, NothingReadWhy>` to
   `engine.ts`. `nothingReadWhy` already computes `other` as the remainder and says so in a comment, which is
   what makes a new barren outcome land in `other` instead of a group it does not belong to — the ruling's
   "never notAllowed" holds by construction, and is pinned by two unit cases and one end-to-end test. The
   type-level forcing the ruling asks for is carried by `CYCLE_CLASS` and `AssertCycleOutcomesAreCountKeys`
   (proofs F3b and F3c), now joined by the test's own driver table.
2. **F2 collateral:** `loop.test.ts`'s *never charges a cycle that stop() abandoned to the reader* asserted
   the lifetime sum `stopped === 5` and had to be rewritten per run (same five runs, same coverage). Recorded
   because it is a test I changed for a reason other than the finding it sits under.
3. **`vi.mock` is new to this repo** (grep: no other use). It is confined to `engine.nothingRead.test.ts`,
   wraps rather than replaces, and every other test in that file still runs against the real loop.
4. **`src/main/constants.ts` and `src/shared/ipc.ts` needed no edit.** `BARREN_CYCLE_LIMIT` /
   `BARREN_AFTER_MS` are unchanged; `NOTHING_READ_WHY` still has exactly its three members.

## Concerns for the owner

- **F3 is a D6-shaped product change, executed on the ruling.** `notKept` is now exclusions-and-`scrubFailed`
  only; `empty` is separate and lands in `other`, whose sentence lives in `src/renderer/copy.ts` (not my
  file, not changed, not needed — the three reasons are untouched). If the spec (5.3 / D6) lists the loop's
  outcomes or says what `notKept` covers, it now needs the fourteenth outcome written in; I did not touch
  `docs/`.
- **F2 changes `stats()`'s published contract.** The reviewer flagged that D3's measurement story may lean on
  lifetime totals. The only caller is the `CAPTURE_OFF` line, so nothing in the app reads a lifetime total any
  more — but if a measurement doc says "the last CAPTURE_OFF line carries the session", that is now false.
- `src/shell/app.ts` (F4) is still untested; the tray label stays a manual check for C-2b-2.

---

## Addendum — a typecheck error outside my file set (not mine, not fixed)

`pnpm typecheck` was clean at 19:14 and again at 19:16, after my last source edit. On the final run at
19:18 it failed with **ten** errors, all in one file another fixer owns:

```
src/readerEval/summary.test.ts(123,56): error TS2554: Expected 1 arguments, but got 2.
… same at (129,82) (131,80) (136,88) (141,84) (147,108) (154,91) (160,33) (161,47) (166,33)
```

Nothing in `src/main/**`, `src/shared/**` or `src/core/**` errors. Reported rather than touched, per the
rules: that file is not in my set, and the signature it is calling is presumably mid-change in another
fixer's working tree.
