# Re-review C — verification of "Fix round 2" against Review C

Date 2026-09-21. Scoped re-review: verifies Important 1 and Minors 1-6 from `reviewC.md` were
actually fixed by `loop2fix.diff`, and that the fix diff broke nothing. Not a fresh review; the
harness was never run, no `.command` script was executed (`bash -n` on rendered text only, where
touched at all).

**Baseline of the private copy (`rrC/app`, code AFTER the fix):** 766 tests in 17 files green,
`tsc --noEmit` clean, `rrC/app/src/readerEval` and `rrC/app/scripts` byte-identical to `$R/app`.

**Method used for every finding below:** read the fix in `loop2fix.diff`, revert it by hand in
`rrC` (exact-string edit), run the named test file(s), confirm the predicted test FAILS, restore
the exact original text, `cmp` against `$R/app` to confirm byte-identical restoration. All ten
reverts below bit exactly as predicted; all ten restores are `cmp`-identical.

---

## I1 — re-staged accuracy row reported the FIRST attempt's `chromeWaitMs`

**Verdict: FIXED.**

Fix: `run.ts`'s `fixed.chromeWaitMs` is now `get chromeWaitMs(): number | null { return
staging.chromeWaitMs; }`, closing over the (reassignable) `staging` variable, instead of a value
captured once before the possible re-stage.

Revert: changed the getter back to `chromeWaitMs: staging.chromeWaitMs,` (a value captured at
first staging). Ran `src/readerEval/run.test.ts`:

```
FAIL  run.test.ts > what a re-staged row says about the wait > reports the second staging's wait on an accuracy row
AssertionError: expected +0 to be 200
```

Exactly the predicted failure — the reverted code reports the discarded first attempt's wait (0 ms)
instead of the second attempt's (200 ms). The sibling toolbar-row test in the same `describe`
still passed on the reverted code, consistent with I1's own finding that the toolbar path already
rebuilt this field correctly before the fix. Restored; `cmp` identical.

**Special-attention check (getter dropped by spread/JSON.stringify):** does not apply here — the
getter is an own, enumerable accessor on a plain object literal (`fixed`), not on a prototype and
not non-enumerable. Verified both generically (`node -e`, spreading a getter-bearing object literal
produces a plain enumerable data property that `JSON.stringify` serialises normally) and concretely
against the real code: added a temporary test to `run.test.ts` that drives a genuine re-stage
through `runAccuracyCase`, asserts `Object.getOwnPropertyDescriptor(rep, "chromeWaitMs")` is a
plain `{value: 200, writable: true, enumerable: true, configurable: true}` data property (i.e. the
getter has already resolved by the time `oneRepetition`'s `{...fixed, ...}` spread runs), then feeds
the row through the real `serialiseResults` → `JSON.stringify` → `JSON.parse` round trip and confirms
`written.accuracy[0].repetitions[0].chromeWaitMs === 200`. Passed. Temporary test removed afterward;
`run.test.ts` restored `cmp`-identical to `$R/app`.

`displayScale` (the getter the report says was considered and rejected) is still a plain value in
`fixed`, matching the report's reasoning — `cells` is a property of the case and `displayScale` of
the run, so neither can differ between two attempts at one staging.

---

## M1 — missing `/dev/tty` would have bash (not `stty`) print 15 error lines

**Verdict: FIXED.**

Fix: `stage.ts`'s generated script line changed from `CLAVE_SIZE=$(stty size < /dev/tty
2>/dev/null)` to `CLAVE_SIZE=$(stty size 2>/dev/null < /dev/tty)`, silencing stderr before the
redirect that can fail.

Revert: put the old ordering back. Ran `src/readerEval/stage.test.ts`:

```
FAIL  stage.test.ts > ... > asks `stty size` on /dev/tty, not `tput` down a pipe
expected script to contain "CLAVE_SIZE=$(stty size 2>/dev/null < /dev/tty)"
```

Predicted failure, including the new ordering assertion (`script.indexOf("2>/dev/null") <
script.indexOf("< /dev/tty")`). Restored; `cmp` identical.

---

## M2 — the generous 30 s first-staging wait was per PART, not per run

**Verdict: FIXED.**

Fix: `runMode` now mints one shared `progress` counter (`const shared = {...deps,
...withProgress(deps)}`) and hands the same `shared` deps to `runAccuracy`, `runToolbar` and
`runObserve`, instead of passing the caller's bare `deps` to each (each of which would mint its own
counter via its own internal `withProgress`).

Revert: changed the three `await runAccuracy(shared)` / `runToolbar(shared)` / `runObserve(shared)`
calls back to using `deps` directly (leaving `shared` computed but unused). Ran
`src/readerEval/run.test.ts`:

```
FAIL  run.test.ts > who gets the generous first-staging wait > spends the generosity once in an `all` run, not once per part
expected [ { first: 0, last: 30000 }, …(1) ] to have a length of 1 but got 2
```

Predicted failure — two stagings (one per part) got the generous 30 s wait instead of one. Restored;
`cmp` identical.

---

## M3 — a caller with no counter made every Chrome staging generous

**Verdict: FIXED.**

Fix: `guardTimeoutFor`'s default changed from `(deps.progress?.chromeStagings ?? 0) <= 1` to
`(deps.progress?.chromeStagings ?? 2) <= 1`, so an absent counter means "not the first" instead of
"the first."

Revert: put `?? 0` back. Ran `src/readerEval/run.test.ts`:

```
FAIL  run.test.ts > who gets the generous first-staging wait > is nobody, when the caller brought no counter at all
expected 30000 to be undefined
```

Predicted failure. Restored; `cmp` identical.

---

## M4 — leading zeros silently normalised (`0072` → `72`)

**Verdict: FIXED.**

Fix: `boundedCount` in `stagedTitle.ts` gained `if (raw.length > 1 && raw.charCodeAt(0) === 48)
return null;` before the digit-range loop.

Revert: removed that line. Ran `src/readerEval/stagedTitle.test.ts`:

```
FAIL x4  reading the size back out of a ready title > reads nothing from a padded 072x40. / 0072x40. / 72x040. / 0001x0001.
expected { columns: 1, rows: 1 } to deeply equal { columns: null, rows: null }   (etc.)
```

All four padded-number cases failed as predicted. Restored; `cmp` identical.

---

## M5 — three fields added, `schema` stayed 1

**Verdict: FIXED, and checked on the terminal side too.**

Fix: `EvalResults.schema` narrowed from `1` to `2` in `results.ts` (doc comment updated to record
the history), `main.ts`'s literal bumped to `2`, and every test fixture across `helper.test.ts`,
`results.test.ts`, `run.test.ts`, `scripts/reader-eval.test.ts` updated, plus a new source-scan test
(`helper.test.ts`: "stamps the current schema version on what it writes") and a new behavioural test
(`results.test.ts`: "the schema version" describe block).

Reverts, two independently:
- `main.ts`'s `schema: 2,` → `schema: 1,` (leaving the type at `2`): `tsc --noEmit` now fails with
  `error TS2322: Type '1' is not assignable to type '2'.` — a compile error, exactly as the report
  claims ("caught only by tsc"). `src/readerEval/helper.test.ts` also fails independently on the
  same reverted line: `expect(source).toContain("schema: 2,")` fails because the source file now
  reads `schema: 1,`. Both reverts predicted and bit.
- `results.ts`'s `schema: 2;` type → `schema: 1;` (leaving `main.ts`'s literal at `2`): `tsc
  --noEmit` now produces 11 errors — every `schema: 2` test fixture across the four test files
  becomes a type mismatch against the narrowed-to-1 type. Predicted.

Both reverted independently, both restored, both `cmp`-identical afterward; combined final state
(both files as shipped) re-verified `tsc`-clean.

**Terminal-side check (the review's special-attention item):** `scripts/reader-eval.mjs` (the
`.mjs` program half, never run — only its exported pure functions read) contains no reference to
`schema` anywhere (`grep -n schema` returns nothing). Its two `JSON.parse(readFileSync(...))` call
sites (`announceObserveUrls`, `main`) never inspect `results.schema`, and `formatSummary` /
`exitCodeFor` — the two pure, unit-tested functions that consume a parsed results object — read
only `results.error`, `results.code`, `results.helper.readyMs`, `results.accuracy`,
`results.toolbar`, `results.observe`, and `results.summary.*`; none of the fields the schema bump
covers (`displayScale`, `readyColumns`, `readyRows`, `stageAttempts`). So the script neither refuses
nor mis-prints an unrecognised schema — it is simply indifferent to the field, and reads a
hypothetical old schema-1 file exactly as sensibly (or as obliviously) as a schema-2 one, because it
never asked. This is unchanged by the diff (no change to `reader-eval.mjs` itself, only to its test
file's fixture literals `schema: 1` → `schema: 2`) and is not a new gap: the field exists purely for
the TypeScript reader side, which is where the ruling's concern (an old file read as a new one)
actually applies, and that side now rejects the wrong literal at compile time.

---

## M6 — `readySizeIn`'s tests lived in `stage.test.ts`, not `stagedTitle.test.ts`

**Verdict: FIXED, functionally — with one small untidy leftover (see New breakage).**

Fix: the entire `describe("reading the size back out of a ready title", ...)` block (16 tests, plus
the new M4 padded-number cases) moved from `stage.test.ts` to `stagedTitle.test.ts`, with a pointer
comment left in `stagedTitle.test.ts` ("Moved here from `stage.test.ts`"). Confirmed by direct
inspection: `stagedTitle.test.ts` now has 16 references to `readySizeIn` across its own describe
block (findable beside `stagedTitle.ts`, the function the privacy ruling singled out);
`stage.test.ts` no longer has that describe block. Test count preserved (766 total, same as the
report's number). Not independently reverted (a pure file-organisation change; nothing to make
"fail" by reverting other than un-moving the tests, which the diff itself demonstrates cleanly via
the two file diffs).

---

# New breakage introduced by this fix round

**One cosmetic issue, no functional regressions found.**

- **Unused imports left behind in `stage.test.ts` by the M6 move (very minor, no test/build
  impact).** `stage.test.ts` still imports `READY_SIZE_MAX` and `readySizeIn` from `./stagedTitle`
  (line 18) but no longer uses either — both symbols now occur only in that one import line
  (`grep -c` confirms 1 occurrence each, the import itself). This is dead weight from moving the
  `describe` block to `stagedTitle.test.ts` without pruning the import list it left behind.
  Harmless: `tsconfig.json` has no `noUnusedLocals`/`noUnusedParameters`, so `tsc --noEmit` stays
  clean (verified — 0 errors), and vitest does not care about unused imports either (766/766 still
  green). Not a correctness, privacy, or test-coverage issue — purely a tidiness nit a linter would
  catch. Not blocking; worth a one-line cleanup (`import {READY_SIZE_END, READY_TOKEN, readyMark,
  readySizeToken, readyTitleFor} from "./stagedTitle";`) whenever `stage.test.ts` is next touched.

No other new issues found. All six changed test files (`helper.test.ts`, `results.test.ts`,
`run.test.ts`, `stage.test.ts`, `stagedTitle.test.ts`, `scripts/reader-eval.test.ts`) were scanned
for weakened assertions relative to `rvC` (pre-fix); every change either strengthens an assertion
(new tests, new order check, new schema-version pin) or is a pure fixture-literal update
(`schema: 1` → `schema: 2`) with no semantic loosening.

**Unchanged, confirmed byte-identical to `rvC` (pre-fix) or otherwise verified untouched by this
diff:** `guard.ts` (approval rule), the title-parsing surface of `stagedTitle.ts` other than
`boundedCount`'s new leading-zero check (`stagedTitleFor`, `isStagedTitle`, `readyMark`,
`READY_TOKEN`, `readySizeToken`, sentinel handling), `thresholds.ts`, `score.ts`, `summary.ts`,
`cases.ts`, `main.ts` (other than the one `schema` literal), `helper.ts`, `server.ts`, `pages.ts`.

---

# Summary

| Finding | Verdict |
|---|---|
| I1 (Important) | FIXED — proven by revert; getter survives spread + real JSON serialisation |
| M1 | FIXED — proven by revert |
| M2 | FIXED — proven by revert |
| M3 | FIXED — proven by revert |
| M4 | FIXED — proven by revert (all 4 padded-number cases) |
| M5 | FIXED — proven by revert (two independent type-level reverts, both caught by `tsc`); terminal side (`reader-eval.mjs`) checked and confirmed schema-indifferent, not a regression |
| M6 | FIXED — tests moved and findable; one unused-import leftover, cosmetic only |

Final state: `rrC/app` restored byte-identical to `$R/app` for `src/readerEval/**` and
`scripts/reader-eval.*`. 766/766 tests green, `tsc --noEmit` clean. No git operations, no installs,
no pnpm against `rrC`, harness never run, `.command` never executed.

**ALL ADDRESSED.**
