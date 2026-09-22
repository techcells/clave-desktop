# RE-review — fix round 1, plan C-2b-2, Task 1 (`reader:eval` harness)

Scope: verify that the 2 Important + 6 Minor findings from `task-1-review.md` were really fixed by
`fix1.diff`, and scan the diff's changed lines for new Critical/Important breakage. Not a fresh
review — other observations are listed but do not affect the verdict.

Working copy: `$S/exec2/rr1/app` (mutated and restored in place; the real repo `$R/app` was never
touched). Before any mutation, `rr1/app/src/readerEval` and both scripts were confirmed byte-identical
to `$R/app` (`diff -rq`, empty). Tests: `node $R/app/node_modules/vitest/vitest.mjs run --root
$S/exec2/rr1/app <paths>`. Typecheck: `node $R/app/node_modules/typescript/bin/tsc --noEmit -p
$S/exec2/rr1/app/tsconfig{,.renderer}.json`. No `pnpm`, no git, nothing launched, `scripts/reader-eval.mjs`'s
program half never run, `dist/reader-eval.cjs` never touched, nothing under `~/Library/Application
Support/Clave Agent Dev/` opened.

Baseline confirmed before mutating: 17 files / 608 tests passed (matches dev report), both `tsc`
invocations exit 0 with no output.

Method for every finding below: read the fix, hand-revert it in `rr1/app` with an exact-string Python
edit (never a Write/Edit tool, to avoid the known backslash-escape corruption), run the named test
file, confirm it **fails** the way the review/fix report says it should, restore from a pre-mutation
backup copy, and `cmp` against `$R/app` to prove the real repo was never touched and my copy is back
to the fixed state.

---

## Findings

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| Important 1 | results allow-list unpinned for toolbar/observe **row bodies** | **ADDRESSED** | see below |
| Important 2 | app string handed to the private rule in `observe` unpinned | **ADDRESSED** | see below |
| Minor 1 (a) | never-ready helper discards `readyMs` | **ADDRESSED** | see below |
| Minor 2 (b) | wall clock; negative `readyMs` accepted | **ADDRESSED** | see below |
| Minor 3 (c) | `lines: true` unpinned for Safari's observe read | **ADDRESSED** | see below |
| Minor 4 (d) | `--position` accepts an absurd coordinate | **ADDRESSED** | see below |
| Minor 5 (e) | `waitReady` outside the shutdown `try/finally` | **ADDRESSED** | see below |
| Minor 6 (f) | arithmetic slip in the dev report | **ADDRESSED** | see below |

### Important 1 — `app/src/readerEval/results.ts:339-340`

Reverted `toolbar: results.toolbar.map(toolbarCase)` / `observe: results.observe.map((entry) =>
({...toolbarCase(entry), app: entry.app}))` back to the reviewer's spread mutation
(`results.toolbar.map((entry) => ({...entry}))`, same for `observe`).

`results.test.ts` → **1 failed | 14 passed** — `ignores a field smuggled into a toolbar or an observe
ROW` fails exactly as the dev report's revert-proof table (R1/R2, n=1) claims. Restored; `cmp` against
`$R/app/src/readerEval/results.ts` identical.

### Important 2 — `app/src/readerEval/run.ts:463`

Reverted `app: theCase.app` to `app: "Safari"` inside `runObserve`'s `toolbarFacts` call.

`run.test.ts` → **1 failed | 47 passed** — `does not call a normal CHROME window private for the word
"private" inside an address` fails (`private: true` instead of `false`), matching revert-proof R8
(n=1). Re-mutated to `app: "Google Chrome"` (the mirror, R8b): **1 failed | 47 passed** — `does call a
SAFARI window private for that same bare word...` fails instead. Both directions bite, as the report
claims. Restored; `cmp` identical.

### Minor 1 (a) — `app/src/readerEval/results.ts:388-397`, `main.ts:205,212`

Three reverts, matching the report's E1/E2/E3:
- **E1** (serialiser drops the number): `serialiseError` back to `JSON.stringify({error, code})`.
  `results.test.ts` → **1 failed | 14 passed** (`writes the elapsed helper time beside a refusal...`).
- **E2** (serialiser admits any `number`, `NaN` included): `measured = typeof error.readyMs ===
  "number"`. Same test → **1 failed | 14 passed**, now for the `NaN`/`Infinity`/`-1` rows (readyMs:
  null leaks through as a written key instead of being dropped).
- **E3** (entry point stops passing `readyMs` to `PROTOCOL`): `main.ts:205` reverted to
  `serialiseError({error: "PROTOCOL", code: "PROTOCOL"})`. `helper.test.ts` → **1 failed | 30 passed**
  (`hands the elapsed helper time to the refusals raised after the spawn`).

All three restored; `cmp` identical against `$R/app`.

### Minor 2 (b) — `app/src/readerEval/main.ts:120`, `summary.ts:210`

- **N2** (wall clock): `const now = (): number => Math.round(performance.now());` reverted to `const
  now = (): number => Date.now();`. `helper.test.ts` → **1 failed | 30 passed** (`times the helper on
  a monotonic clock, not on the wall clock` — the source no longer contains `Date.now()` check fails
  because it does again).
- **N1** (negative accepted): `summary.ts:210` reverted from `Number.isFinite(helper.readyMs) &&
  helper.readyMs >= 0` to `Number.isFinite(helper.readyMs)` alone. `summary.test.ts` → **2 failed | 66
  passed** (`refuses a readyMs of a negative duration`, `refuses a run whose helper start time ran
  backwards, however small`).

Both restored; `cmp` identical.

### Minor 3 (c) — `app/src/readerEval/run.ts:454`

Source line was already `lines: true` unconditionally (this finding was closed by tests, not source).
Mutated to `lines: theCase.app === CHROME` (Safari loses its line boxes — the reviewer's R4 probe).
`run.test.ts` → **1 failed | 47 passed** (`reads a window the OWNER staged, once, and files it under
the case in its title` — the new `expect(readLines(link)[0]?.lines).toBe(true)` assertion in the
Safari observe test fails). Restored; `cmp` identical. (The Chrome-losing-boxes mirror was already
pinned pre-existing by the developer's own mutation `f`, per the original review.)

### Minor 4 (d) — `app/src/readerEval/config.ts:70-81,99`, `app/scripts/reader-eval.mjs:38,89`

- **P1** (config.ts drops the bound): `wholePoint`'s `Number.isSafeInteger(value) && value <=
  POSITION_MAX_PT` reverted to `Number.isSafeInteger(value)`. `config.test.ts` → **4 failed | 43
  passed** (`refuses an x past any screen`, `refuses a y past any screen`, `refuses a stray extra
  digit`, `takes a coordinate up to the bound...`), matching the report's n=4.
- **P2** (CLI side drops the bound): `parsePositionArg`'s `!Number.isSafeInteger(number) || number >
  POSITION_MAX_PT` reverted to `!Number.isSafeInteger(number)`. `reader-eval.test.ts` → **4 failed |
  63 passed**, the CLI-side mirror of the same four rows.

Both restored; `cmp` identical against `$R/app`.

### Minor 5 (e) — `app/src/readerEval/helper.ts:104-114`, `main.ts:198-201`

Confirmed structurally first: `spawnHelper(` occurs before the `try {` at `main.ts:200`, `await
waitReadyFrom(` occurs between that `try` and its `} finally {` at `main.ts:248`, and
`helper.shutdown()` at `main.ts:249` is inside that `finally` — the only `try`/`finally` pair in the
file besides `removeScratch`'s own single-line `try` (checked there is no nested `try` between lines
200 and 248 that could confuse the test's `lastIndexOf` search).

**L1** (wait moved back outside the try): edited `main.ts` to call `await waitReadyFrom(started, now)`
before the `try {` (leaving `ready`/`readyMs` as outer-scope bindings). `helper.test.ts` → **1 failed |
30 passed** (`waits for "ready" inside the try whose finally shuts the helper down`, on the
`opened < at("await waitReadyFrom(")` assertion). Restored; `cmp` identical.

Also ran the **behavioural** test standalone (not just the source-shape one): `lets the caller shut
down a helper that never became ready` — drives the real `spawnHelper`/`waitReadyFrom`/
`createEvalHelper` over a fake link and a manual timer schedule, asserts `{ok: false, why: "timeout"}`
at `readyMs === 120_000`, that the helper was asked nothing (`link.sent === []`) before the deadline,
and that a subsequent `started.helper.shutdown()` in the test's own `finally` produces
`{"op":"shutdown"}`, closes the input, and never kills the process. This passed on its own
(`1 passed | 30 skipped`) — it is a real behavioural proof that the split (`spawnHelper` synchronous,
`waitReadyFrom` async) actually lets a caller hold the helper before awaiting anything, not just a
string match.

### Minor 6 (f) — `$S/exec2/task-1-dev-report.md`

Section 1 (line 17) and the addendum (line 357) both now read "**Fifteen**" files, with the addendum
explicitly noting the correction and attributing it to "fix round 1, review Minor 6" (line 359-361).
`diff -rq` between the "differs" set (13 under `src/readerEval/**` + `scripts/reader-eval.{mjs,test.ts}`)
matches 15. Text-only fix, confirmed consistent in both places.

---

## New breakage scan (changed lines only)

**TDZ fix in `scripts/reader-eval.mjs`.** `POSITION_MAX_PT` (line 38) is now declared above `USAGE`
(line 40), which interpolates it at line 58 — module top-level evaluation now proceeds
`MODES → VARIANTS → POSITION_MAX_PT → USAGE → …` with no forward reference. Confirmed by: (1) the test
suite already imports the module (`scripts/reader-eval.test.ts` does `import * as cli from
"./reader-eval.mjs"`) and 67 tests in that file collect and run cleanly with no import-time exception;
(2) read the whole file top to bottom — every other top-level `const`/function reference (`pad`,
`num`, `here`, `appDir`) is only read from *inside* function bodies that execute later, at call time,
never during the linear top-level pass, so none of them can TDZ. No other use-before-declaration
exists in the file.

**The new optional `readyMs` on `EvalError`.** `results.ts`'s `serialiseError` gate — `typeof
error.readyMs === "number" && Number.isFinite(error.readyMs) && error.readyMs >= 0` — correctly admits
only a finite, non-negative number and drops everything else (`NaN`, `±Infinity`, negative values, and
non-number types all fall through to the two-key form). Verified directly (E1/E2 reverts above) and by
the existing `writes the elapsed helper time beside a refusal...` test, which also asserts a smuggled
`why` string does not ride along. No path writes `readyMs: null`; the key is omitted entirely when not
measured, matching the finding's ruling ("numbers only").

**No other new Critical/Important issue found** in the diff's changed lines. Specifically checked and
clear: the clock is used consistently as an elapsed-interval measure everywhere it is threaded
(`run.ts`'s `deps.now()` calls only ever compute a deadline relative to itself; no other file in
`src/readerEval` still calls `Date.now()` — grepped, only two hits, both inside the new pinning test's
comment/string, not code); the `POSITION_MAX_PT` bound is applied identically on both sides (≤20000
accepted, >20000 refused, `tsc --noEmit` clean on both configs); `run.ts` itself is byte-identical
between the pre-fix1 and post-fix1 copies (`diff` empty) — Important 2 and Minor 3(c) really were
tests-only, as claimed.

### The three SOURCE-STRING assertions in `helper.test.ts`'s "the entry point's helper lifecycle"

1. **`waits for "ready" inside the try whose finally shuts the helper down`** — ordering assertion via
   `lastIndexOf`. Verified true against the actual file (no nested `try` between the relevant `try` and
   `finally` to confuse the search), and verified non-vacuous above (L1 reversion fails it). **Keep.**
   It is the only test that can observe this property at all, since `main.ts` cannot be imported or run
   by any test in this harness (it runs inside a granted Electron bundle with no window).
2. **`times the helper on a monotonic clock, not on the wall clock`** — checks for `node:perf_hooks`,
   `performance.now()`, and the absence of `Date.now()`. Verified true and non-vacuous (N2 reversion
   fails it). Brittle in the narrow sense that a rewrite using `new Date().getTime()` instead of the
   literal string `Date.now()` would slip past the negative check, but that is a strained rewrite of a
   one-line clock definition, and the assertion still correctly requires the presence of the monotonic
   API. **Keep.**
3. **`hands the elapsed helper time to the refusals raised after the spawn`** — three exact-string
   containment checks. Verified all three currently match `main.ts` byte-for-byte (`grep -n` against
   the live file), and verified non-vacuous (E3 reversion fails it). This is the only test that pins
   Minor 1(a)'s actual requirement ("writes ... the elapsed readyMs") end-to-end, since `results.test.ts`
   only proves the serialiser admits the field, not that the entry point supplies it. **Keep.**

All three are brittle to pure reformatting (a reordered object key, an added trailing comma, a renamed
local) exactly as the dev report's own "Concerns" section #1 already says. None of them assert
something false today, and none is vacuous — each was shown above to fail under the specific reversion
it exists to catch. Given `main.ts` is structurally untestable any other way, I judge the trade
correctly made: keep all three.

---

## Observations (no action, do not affect verdict)

- The behavioural test for Minor (e) (`lets the caller shut down a helper that never became ready`) is
  the strongest test added this round — it is not a source-string check at all, and it directly proves
  the mechanism (not just the ordering) that Minor 5 was about.
- `config.ts`'s and `scripts/reader-eval.mjs`'s copies of `POSITION_MAX_PT` are two separate constants
  (`20_000` and `20000`) kept in sync by convention and a shared test value, not by a single source of
  truth — same pattern as the pre-existing `parsePosition`/`parsePositionArg` duplication the original
  review already accepted. Not a regression, just noting the bound inherits the same duplication.
- Byte scan of the 12 changed files: no control byte outside tab/newline, no `0x7f`, valid UTF-8,
  non-ASCII limited to U+2014 (em dash) and U+2026 (ellipsis) — consistent with both reports' claims.
- `tsc --noEmit` clean on both `tsconfig.json` and `tsconfig.renderer.json` after every restore.

---

## Verdict

**ALL ADDRESSED** — both Important findings and all six Minor findings are genuinely fixed: every
named revert reproduces the failure the review/fix report claims, every restore is byte-identical to
the real repo, and the full 608-test suite plus both typechecks pass clean on the fixed code. The one
pre-existing defect this round surfaced and fixed itself (the `POSITION_MAX_PT`/`USAGE` TDZ
`ReferenceError`) is confirmed genuinely fixed with no remaining top-level use-before-declaration in
`scripts/reader-eval.mjs`. No new Critical or Important breakage found in the diff's changed lines. The
three new source-string assertions in `helper.test.ts` are non-vacuous, currently true, and — given
`main.ts` cannot be tested any other way — worth keeping as written.
