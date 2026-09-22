# Re-review — Fix round 1 (I1, I2, I3, eight Minors)

2026-09-21. Scoped re-review, not a fresh one: verifies `observe-fix-review.md`'s three Importants
and eight Minors against `observe-fix-dev-report.md`'s "Fix round 1" (proofs N1–N19) and
`fix1.diff`. Nothing was run against a screen, no bundle was launched, no script from
`scripts/reader-eval.mjs`'s program half was executed, no `dist/reader-eval.cjs`, no git.

Method: read the review, the dev report's Fix round 1, and `fix1.diff` end to end; diffed
`rv/app` (pre-fix-round-1) against `rr/app` (fix round 1 applied) to confirm `fix1.diff`'s file
list was exhaustive; confirmed `rr/app/src` and `rr/app/scripts` are byte-identical to the live
`app/src` and `app/scripts` (so `rr` is exactly what is under review); re-ran the developer's
mutations that map to I1, I2, I3 and five of the eight Minors by hand on `rr/app` (never on
`app/`), observed the failure, restored the original bytes and `cmp`-ed clean against `app/` after
every probe; ran the full harness suite and `tsc` before the first probe and after the last.

**Baseline, confirmed before and after every probe:** 18 files / **1128 tests pass**
(`vitest run --root rr/app src/readerEval scripts/reader-eval.test.ts`), `tsc --noEmit` clean,
`src/readerEval/bytes.test.ts` green (42 tests). Matches the dev report's totals exactly.

---

## I1 — the terminal call site of the nonce-named files

Fixed. The call site (`watchObserve` in `scripts/reader-eval.mjs`) no longer composes a file name
itself; it takes `files = observeFilesFor(nonce)` and calls `read(files.urls)` /
`read(files.progress)`, and `observeFilesFor` is exported and covered directly by
`reader-eval.test.ts`'s `describe("what the terminal watches while the run goes", …)`.

*Probe (the reviewer's exact revert, reapplied to the new call site):* changed

```js
const file = read(files.urls);
```

back to

```js
const file = read("observe-urls.json");
```

**Result: 3 tests failed** — *opens this run's two files and NOTHING else*, *prints this run's
URLs and never a stale file's*, *holds the fixed file name nowhere in its source*. Restored;
`cmp` clean against `app/scripts/reader-eval.mjs`.

The fixed string `"observe-urls.json"` no longer appears anywhere in `reader-eval.mjs` (own
tripwire test, confirmed passing in the untouched baseline), symmetrical with `main.ts`'s
`helper.test.ts:376-380` tripwire the original review pointed at.

## I2 — schema 4's values in the serialised results file

Fixed. `results.test.ts` now asserts values, not just key sets, for the five fields the review
named plus `notCheckedCases`. Reran each of the review's five surviving probes against
`src/readerEval/results.ts`, one at a time:

| Field (in `serialiseResults`) | Mutation | Result |
| --- | --- | --- |
| `hostDistance` (toolbar/observe row) | `value.hostDistance ?? null` → `null` | **1 test failed** |
| `readAttempts` (observe row) | `entry.readAttempts ?? null` → `null` | **2 tests failed** |
| `expected` (observe verdict) | `results.summary.observe.expected` → `0` | **1 test failed** |
| `missingCases` (observe verdict) | `[...…missingCases]` → `[]` | **1 test failed** |
| `reason` (observe verdict) | `results.summary.observe.reason` → `null` | **2 tests failed** |

All five restored, each `cmp`-ed clean against `app/src/readerEval/results.ts` before the next
probe. Matches the dev report's N3–N7 counts exactly.

## I3 — the nonce, validated bundle-side

Fixed. `config.ts` now exports `parseNonce` (exactly `NONCE_LENGTH` = 12 lowercase hex characters,
counted by hand) and `readEvalSettings` calls it — `const nonce = parseNonce(env.CLAVE_EVAL_NONCE
|| newNonce()); if (nonce === null) return {ok: false, code: "BAD_NONCE"};` — before returning
`settings`. Traced the call graph in `main.ts`: `configured = readEvalSettings(...)` happens at
module load, and every place that composes a file name or a staged title from `nonce`
(`writeObserveUrls`, `observeProgressWriter`, `stagedTitleFor` via `allStagedIds().map(...)`) is
inside `main()`, gated behind `if (!configured.ok) { … return; }`. So a bad nonce is refused before
any observe file name or staged title exists, and the only file written on refusal
(`outFile`, from `CLAVE_EVAL_OUT_FILE`) does not have the nonce in its name.

*Probes:*
- Reapplied the review's implicit ask — take the nonce verbatim again (drop `parseNonce`
  entirely). **11 tests failed**, matching the dev report's N9. Restored, `cmp` clean.
- Widened the grammar (`raw.length !== NONCE_LENGTH` → `raw.length < NONCE_LENGTH`, i.e. "at
  least" instead of exact, which is literally the shape the code's own comment warns against).
  **1 test failed deterministically** (`refuses one character long`). Restored, `cmp` clean.
  (The dev report's N10 counts 4; a different widening reaches more of the refusal table, but the
  point — that the exact-length grammar is load-bearing, not vestigial — is confirmed either way.)

Also confirmed: the terminal mints `randomBytes(6).toString("hex")` (`reader-eval.mjs:829`,
`NONCE_BYTES = 6` in `config.ts`) — 12 lowercase hex characters, exactly `parseNonce`'s grammar, so
neither half can generate a nonce the other refuses. `config.test.ts`'s
`describe("the mode", …)` `it.each(EVAL_MODES)("takes %s", …)` — unchanged by this diff, part of
the green baseline — drives `accuracy`, `toolbar`, `observe`, `all` and `coldstart` through
`readEvalSettings` with the fixture's real 12-hex nonce and asserts each is accepted, so
accuracy/toolbar/coldstart are confirmed unaffected by the new validation. The traversal case
(`"../../../tmp/x"`) is refused with `BAD_NONCE` by a dedicated test
(`refuses a traversal nonce before the run can name a file with it`), which also asserts every
*accepted* nonce's file names contain neither `/` nor `..`.

---

## Minors (the five the brief lists)

**1 — deterministic pin of the 1024-character scan bound.** Fixed. No `Date.now()` anywhere in
`score.test.ts` any more. The bound is now asserted structurally in
`"scans the first HOST_STRIP_SCAN_MAX characters of the strip and no more"`: a host at the edge of
the bound scores 0, one past it does not.

*Probe:* changed `hostDistance`'s `const strip = scannedStrip(squashed(toolbarText));` back to
`squashed(toolbarText)` with no bound. **1 test failed deterministically**
(`expected 0 to be greater than 0`) — not a timing flake, an exact-value assertion. Restored,
`cmp` clean against `app/src/readerEval/score.ts`.

**3 — the run ends when every expected case is read ok or exhausted (3 attempts), and is then
INCOMPLETE.** Fixed. `run.ts`'s `settled(name)` is `done.has(name) || (attempts.get(name) ?? 0) >=
OBSERVE_READ_ATTEMPTS_MAX`, and the loop condition is `while (deps.now() < until &&
!wanted.every(settled))`. An exhausted case never enters `done`, so it is still named in
`missingCases` and the verdict is still `INCOMPLETE` — only the waiting stops.

*Probe:* reverted `settled` to `(name) => done.has(name)` (dropping the exhaustion half).
**1 test failed** — *ends when every expected case is either read or out of attempts, and says
the run is incomplete* (asked 3000 times instead of stopping at `OBSERVE_READ_ATTEMPTS_MAX = 3`).
Restored, `cmp` clean.

**5 — a normal case with no strip is `NOT CHECKED` and makes an expected run incomplete; a
private case with no strip stays `privateMissed` (privacy-conservative). Confirmed as designed.**
`observe.ts`'s `noToolbarStrip(row)` is `row.outcome === "ok" && row.private === null`.
`readAsExpected` returns `false` for *any* case (private or normal) with no strip — but
`summary.ts`'s `notCheckedCases` filters `!entry.expectPrivate && noToolbarStrip(entry)`, i.e. only
the NORMAL side. A private case with no strip is excluded from `notCheckedCases` and instead
counted by `privateMissed` (`entry.expectPrivate && entry.private !== true`, and `null !== true`),
which fails the run as `NOT_AS_EXPECTED` rather than merely `INCOMPLETE` — confirmed to be the
stronger, privacy-conservative statement, exactly as claimed.

*Probe:* removed the `noToolbarStrip` guard from `readAsExpected`. **1 test failed** — *is false
for a normal case that came back with no toolbar strip at all*. Restored, `cmp` clean.

*Probe:* removed `expectedNotChecked.length > 0` from the `reason` calculation in
`summariseObserve`. **1 test failed** — the test asserting `notCheckedCases` names the case AND
`reason` is `"INCOMPLETE"`; with the clause dropped `reason` came back `null` (a pass). Restored,
`cmp` clean against `app/src/readerEval/summary.ts`.

**7 — printed values pass through `fixedCode`/`bool`/`count` guards.** Fixed.
`formatProgressLine` and `progressKey` in `reader-eval.mjs` route `row.case`/`row.outcome` through
`fixedCode` (letters/digits/hyphens, ≤ 64) and `row.host`/`row.private`/`row.asExpected` through
`bool`, `row.readAttempts` through `count` (a safe integer, 0–999). Anything else prints `?`.

*Probe:* reverted `formatProgressLine`'s case-name interpolation from `pad(fixedCode(row.case),
32)` back to `pad(row.case, 32)` (unguarded). **1 test failed** — *keeps a smuggled string out of
a progress line and out of its key* (a `case` field containing `"rm -rf /tmp SMUGGLED"` leaked
through). Restored, `cmp` clean.

**8 — an unknown results schema produces a warning and exit 2, never a silent pass.** Fixed.
`RESULTS_SCHEMA = 4`, `knownSchema(results)` (a schema-less file is read as current, anything else
must match exactly), `formatSummary` prints `OLD RESULTS FILE: schema …` for an unknown one, and
`exitCodeFor` returns `2` when `!knownSchema(results)`.

*Probe:* removed the `if (!knownSchema(results)) return 2;` line from `exitCodeFor`. **1 test
failed** — *says so, and never reports exit 0 for it* (`exitCodeFor(old)` came back `0` instead of
`2` for a schema-3 file with `summary.accepted: true`). Restored, `cmp` clean.

*(Minors 2, 4 and 6 from the original review — worst-case cost left as a documented decision, the
astral-surrogate scan boundary, and the duplicated `--host` grammar table — are not in this
re-review's required checklist. Spot-checked in passing: `score.test.ts` has no `Date.now()`
anywhere, `scannedStrip` is exported and directly tested for the surrogate case, and
`reader-eval.test.ts` has `"agrees with the bundle's own rule on every value either table has"`
cross-checking `parseHostArg` against `parseObserveHost` over 14 values including the three the
original review found missing. Not independently reverted.)*

---

## Confirmed unchanged by this diff

- `diff -rq rv/app/src/readerEval rr/app/src/readerEval` (excluding `.test.ts` files): only
  `config.ts`, `main.ts`, `observe.ts`, `results.ts`, `run.ts`, `score.ts`, `summary.ts` differ.
  `guard.ts` and `thresholds.ts` do not appear at all — byte-identical, so `approve` and every
  threshold are untouched.
- `score.ts`'s hunk in `fix1.diff` is confined to the new `scannedStrip` function and swapping
  `hostDistance`'s one slice call for it; `lev`, `norm`, `accuracy`, `confusions`, `markerHits` are
  outside the hunk, untouched.
- `summary.ts`'s hunk is confined entirely to `summariseObserve`'s body (the `noToolbarStrip`
  import, `notCheckedCases`, and the `expectedNotChecked` clause in `reason`); `summariseGroups`
  and `summariseToolbar` — the accuracy and toolbar acceptance rules — and the `accepted`
  expression are outside the hunk, untouched.

## Totals, reconfirmed

| Command | Result |
| --- | --- |
| `vitest run --root rr/app src/readerEval scripts/reader-eval.test.ts` | 18 files, 1128 tests, all pass (before and after every probe above) |
| `tsc --noEmit -p rr/app/tsconfig.json` | clean |
| `src/readerEval/bytes.test.ts` | 42 tests, green |
| `rr/app/src`, `rr/app/scripts` vs live `app/src`, `app/scripts` | byte-identical, before and after this re-review |

`app/` itself (`R`) was never opened for writing at any point; every probe above was made on and
restored on `rr/app`, and each restoration was `cmp`-ed clean against the live `app/` tree.

---

## Verdict

**ALL ADDRESSED — OK TO RUN**
