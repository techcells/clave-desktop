# Re-review 8 — `reader:eval` harness, fix round 1

Scope: verify the fixes for the findings in `scratchpad/exec/task-8-review.md`, against the rulings in
my dispatch. Work done only in `scratchpad/exec/rr-8/app`, which was verified byte-identical to
`/Users/sardorastanov/techcells/asset-to-evidence/app` for all topic-8 files **before and after**
(`diff -rq` on `src/`, `scripts/`, `reader-eval/` → no differences at the end).

**The harness was never run.** No `reader:eval`, no `scripts/reader-eval.mjs` as a program, no
`dist/reader-eval.cjs`, no bundle launched, no `read`/`frontWindow` to a built helper, nothing
printed that came off a screen. No git, no pnpm, no subagents.

Baseline in the copy: `src/readerEval` + `scripts/reader-eval.test.ts` → **17 files, 489 tests, all
pass** (matches the fixer's claim). `tsc --noEmit` clean for both configs.

---

## Verdicts

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| Important 1 | raw control bytes in `score.ts` / `stage.ts` | **ADDRESSED** | see §1 |
| Important 2 | unrecognised/absent `CLAVE_EVAL_MODE`; `accepted: true` having measured nothing | **ADDRESSED** | see §2 |
| Minor 1 | `.trim()` vs Python `.strip()` on U+FEFF | **ADDRESSED** | §3 |
| Minor 2 | `between()` not case-insensitive the way `re.I` is | **ADDRESSED** | §3 |
| Minor 3 | `PAGE_SCRIPT` disagreed with `acceptStagedTitle` | **ADDRESSED** | §3 |
| Minor 4 | empty `CLAVE_EVAL_NONCE` taken, not replaced | **ADDRESSED** | §3 |
| Minor 5 | `ALL_GROUPS` dead code | **ADDRESSED** | §2 (wired as `missingGroups`) |
| Minor 6 | sentinel test did not cover the `observe` path | **ADDRESSED** | §4 |
| Minor 7 | `dist/reader-eval.cjs` built unconditionally | out of scope (deferred by the ruling); fixer carried it to the packaging task, correctly — the file is `app/scripts/build.mjs`, outside the topic's set |

**No new Critical or Important breakage in the changed lines.**

---

## 1. Ruling A — no raw control bytes, verified on disk, behaviour unchanged

**On disk, verified by me, not by the fixer's script.** My own byte scan
(`scratchpad/rr8/bytescan.py`, run against BOTH the real repo and my copy): 38 files scanned
(`src/readerEval/**`, `scripts/reader-eval.*`, `reader-eval/truth/**`), **0 offending bytes** — every
byte ≥ 0x20 except `\n`, **no file contains a tab at all**, no 0x7F.

```
$ file app/src/readerEval/score.ts app/src/readerEval/stage.ts
  …/score.ts: Java source, Unicode text, UTF-8 text      # was `data`
  …/stage.ts: Java source, Unicode text, UTF-8 text      # was `data`
$ grep -n "export function accuracy" app/src/readerEval/score.ts     → 110:…   (was rc 1, silent)
$ grep -rn "export const OPEN"        app/src/readerEval             → stage.ts:26  (folder sweep reaches it)
```

**The four spots** (`score.ts:48` `WHITESPACE_RUN`, `score.ts:148` `CONFUSION_KEY_SEPARATOR` used at
`:202` and `:215`, `stage.ts:134` `TITLE_UNSAFE` used at `:165`) are all built from escapes inside a
string or from `String.fromCharCode`. The pre-fix literals were confirmed present in
`rev-8/app/src/readerEval/score.ts:43,165,178` and `stage.ts:153`.

**My own differential, old-vs-new.** I copied the untouched pre-fix `score.ts` / `stage.ts` /
`thresholds.ts` out of `rev-8` into the copy and imported both implementations into one test
(`rr8diff.probe.test.ts`, 118 tests, deleted afterwards). Corpus: 33 inputs built from
`String.fromCharCode` covering U+001C–U+001F individually and together, NUL (leading, medial,
trailing), NBSP, U+0085, U+2028, U+2029, U+FEFF (leading, medial, trailing, both ends), VT,
apostrophes, tabs/newlines, empty, all-separator, marker strings including a Kelvin-sign marker, plus
a `mixed` case holding most of them at once.

- `norm`: **identical on 29 of 33**; the four that differ are exactly the U+FEFF-at-an-end ones, and
  the difference is exactly Minor 1 (`after.trim() === before` for each).
- `between`: **identical on 32 of 33**; the one that differs is exactly the Kelvin marker (Minor 2).
- `confusions`: compared over the **full cross product** of the corpus members whose `norm` the
  rulings did not change (29 × 29, both argument orders) — **identical throughout**. Plus a
  dedicated NUL test (a NUL survives `norm`, so it is the one character that could forge a tally
  key): identical before and after.
- `stage.ts`'s quoting check: `terminalScript` run old-vs-new over 15 titles (apostrophe, NUL, FS,
  GS, RS, US, VT, DEL, U+0085, NBSP, U+2028, U+FEFF, space, empty, a real staged title), comparing
  the returned script **or** the thrown message — **identical for all 15**.
- `between()` over the **five truth files** wrapped in the markers the staged page and the staged
  terminal really emit, in four case renderings each (upper, mixed-in-line, all-lower,
  capitalised) plus a greedy double-`ENDMARKER` variant: **old == new for all 25**, `found: true`
  throughout, and the extracted body normalises to the truth. `u` changed nothing there.

**Against `score.py` itself** (the reviewer's extracted phase-0 scorer, `--selftest` → `SELFTEST OK`):
my corpus emitted from the NEW implementation and compared for `norm` (code-point-wise), `between`
(body + found) and `accuracy` (to 1e-12) → **`cases: 33 differing: 0`**. The new scorer now matches
the Python exactly on every one of these, which the old one did not.

**The guard bites.** `bytes.test.ts` (new, 38 tests) fails on every plant I made, each applied by
python to a backup-restored file and then restored (`cmp` clean, truth files byte-identical):

| plant | failing test |
|---|---|
| `0x1f` into a comment in `score.ts` | `…/score.ts holds no control byte but tab and newline` — `['0x1f at byte 7']` |
| `0x00` into a comment in `stage.ts` | `…/stage.ts holds no control byte but tab and newline` |
| `0x7f` into a comment in `score.ts` | same, for `score.ts` |
| `0x1f` into `reader-eval/truth/chat.txt` | `…/chat.txt holds no control byte but newline` |
| `0x09` into `reader-eval/truth/code.txt` | `…/code.txt holds no control byte but newline` |
| `\\u001C-\\u001F` → `\\u001C-\\u001E` | `score.ts and stage.ts spell their control characters instead of holding them` |

**Reverting the fix** (literal bytes put back exactly as they were pre-fix, by python):

| revert | failing tests |
|---|---|
| `WHITESPACE_RUN` back to the literal regex | 2 — the byte scan **and** the "spell" test |
| separator back to a literal `"\0"` | 1 — the byte scan |
| `TITLE_UNSAFE` back to the literal regex | 2 — the byte scan and the "spell" test |

Note what did **not** fail in those three reverts: `score.test.ts` and `stage.test.ts` pass with the
literals back. That is the point — the behaviour tests could never have caught this, and now
something does.

## 2. Ruling B — the mode, and "nothing measured" can never be accepted

**Refusal.** `readEvalSettings` (`app/src/readerEval/config.ts:52-74`) checks the mode against
`EVAL_MODES` (a value, so the cast cannot be rewritten) and the variant against `CHROME_VARIANTS`;
unrecognised **or absent** mode → `{ok: false, code: "BAD_MODE"}`. `main.ts:130-136` acts on it
**before** `readTruth`, `createPageServer` and `startHelper`, and before the protocol and grant
checks, writing `serialiseError({error: "HARNESS", code})`. I ran the CLI's pure halves directly:

```
{"error":"HARNESS","code":"BAD_MODE"}    -> "READER_EVAL_FAILED HARNESS BAD_MODE\n"    exit 1
{"error":"HARNESS","code":"BAD_VARIANT"} -> "READER_EVAL_FAILED HARNESS BAD_VARIANT\n" exit 1
{"error":"NO_GRANT","code":"NO_GRANT"}   -> "READER_EVAL_FAILED NO_GRANT\n"            exit 1   (unchanged)
{"error":"HARNESS","code":"HARNESS"}     -> "READER_EVAL_FAILED HARNESS\n"             exit 1   (unchanged)
```

My own probe (`rr8accept.probe.test.ts`, 74 tests, deleted afterwards) additionally refuses
`""`, `" "`, `"accuracy "`, `"Accuracy"`, `"ACCURACY"`, `"acc"`, `"all,toolbar"`, `"0"`, `"null"`,
`"undefined"`, `"__proto__"`, `"toString"` and an absent variable — all `BAD_MODE`; accepts exactly
the four modes; refuses `""`, `"Bookmarks-Bar"`, `"bookmarks bar"`, `"chrome"`, `"0"`,
`"constructor"` as variants; an absent variant defaults to `none`; an empty nonce is replaced.
(`__proto__`/`toString` matter because `EVAL_MODES.find` is used rather than an object lookup — it is
an array scan, so neither is reachable as a mode.)

**I tried to construct a counter-example through `summarise` and could not.** A systematic cross
product of all four modes with eleven input shapes (nothing at all; accuracy cases that all ended
`notStaged`; one group only; four of five groups; zero toolbar captures; one capture; 20 normal
captures and no incognito; zero observe rows; and each of "full accuracy / full toolbar / full
observe" alone) — 44 combinations — asserting `accepted === true ⇒ something was measured`, and the
stronger form `accepted ⇒ the mode's OWN obligation was met` (accuracy: `missingGroups` empty, five
group verdicts, every `min !== null`; toolbar: 40 captures; observe: `read > 0`). **All pass, and the
search is not vacuous** — the four fully-measured runs are still accepted.

Reading confirms why there is no hole: `accuracy`/`all` require `missingGroups.length === 0`, so all
five of `ALL_GROUPS` (derived from `Object.keys(ACCURACY_THRESHOLDS)`) need a verdict, and
`GroupVerdict.passed` requires `min !== null`, which requires at least one `outcome: "ok"` repetition
with a non-null accuracy. `toolbar`/`all` require `summariseToolbar(…, true).passed`, which requires
20 captures in each mode. `observe`/`all` require `usable.length > 0`.

**Revert proofs** (each applied by python to a backup-restored file, tests run, restored, `cmp` clean):

| revert | failing tests |
|---|---|
| `config.ts`: mode back to `(env.CLAVE_EVAL_MODE ?? "accuracy") as EvalMode` | 5 named `config.test.ts` tests (`refuses a mode it does not have`, `…differing only in case`, `…an empty mode`, `…with the CLI's own spacing`, `…that is not set at all`) + 13 of my own |
| `summary.ts`: drop `missingGroups.length === 0 &&` | `refuses a accuracy run that measured nothing`, `names the accuracy groups the run should have covered and did not` + 4 of mine |
| `summary.ts`: `summariseToolbar` back to `if (cases.length === 0) return null` | `is null when the run had no toolbar mode at all`, `fails a toolbar run in which nothing was captured`, `refuses a toolbar run that measured nothing`, `gives a toolbar run with no capture a failing verdict rather than none at all` + 5 of mine |

**Callers all agree.** `summarise` has exactly one production caller (`main.ts:178`, passing `mode`
first) and two in `results.test.ts`; `summariseToolbar` is called only from `summary.ts:204`;
`summariseObserve` only from `summary.ts:205`. `EvalSummary.missingGroups` (`results.ts:176`) is
serialised at `results.ts:273` under that exact name and read by `scripts/reader-eval.mjs:137` as
`results.summary?.missingGroups ?? []` — I rendered a summary with four missing groups and got
`SHORT  groups    MISSING: ticket terminal pt code  (no verdict: nothing in them was measured)` plus
`READER_EVAL SHORTFALL`. No `observeRan` argument survives anywhere; `counted` moved wholesale into
`config.ts` with no leftover. No launcher outside the topic sets `CLAVE_EVAL_*` (grep over `app/src`
and `app/scripts`), and `parseEvalArgs` still defaults and validates the mode, so the CLI path is
unaffected by the new refusal.

## 3. Minors 1–5

- **Minor 1** — `norm` (`score.ts:64-66`) ends with `^ ` / ` $` removal, not `trim`. Matches
  `score.py` on all 33 of my corpus cases (§1). Revert to `.trim()` → `keeps a zero-width no-break
  space at either end, because score.py's strip does` fails, plus 5 of my probes. The comment at
  `score.ts:54-63` now states the real reason; the stale claim at the old `:38-41` is corrected.
- **Minor 2** — `MARKED` (`score.ts:93`) is `"iu"`. Revert to `"i"` → `finds the markers through a
  Unicode case fold, exactly as re.I does` fails, plus my `between(marked-kelvin)`. The two checks
  the ruling asked for: `between()` still finds the markers case-insensitively (all-lower,
  capitalised and alternating-case markers all found), and **`u` did not change which bodies are
  extracted for the five truth files' marker lines** — old == new for all 25 truth × rendering
  combinations, bodies normalising to the truth.
- **Minor 3** — `pages.ts:44,48` interpolates `STAGED_TITLE_PREFIX` via `JSON.stringify` and applies
  `t.startsWith(p)&&t.length>p.length`. Revert (drop the length clause) → `falls back to the fixed
  name for the bare prefix with nothing after it, through the script as well as the server` fails.
  The new test actually **runs** the served `<script>` with `new Function` against a fake document
  and location, so it tests the string the server serves rather than a copy of the rule.
- **Minor 4** — `config.ts:68` uses `||`. Revert to `??` → `is generated when the variable is empty`
  fails, plus my probe.
- **Minor 5** — `ALL_GROUPS` (`summary.ts:220`) is now consumed at `summary.ts:201-203`; pinned by
  `expects a verdict for every group the thresholds name`. No longer dead.

## 4. Minor 6 — the sentinel test and the `observe` path

`results.test.ts:90-93` now drives a real `runObserve` over one Safari private `ObserveCase` through
the sentinel helper, and asserts `observe[0].outcome === "ok"` and `observe[0].app === SAFARI` so it
cannot pass vacuously. I applied the leak mutation myself — `toolbarFacts` (`run.ts:332`) also
returns `toolbarText`, **and** `results.ts:261` spreads the observe entry instead of rebuilding it:

```
leak + the observe row in the sentinel run (as fixed) :  1 failed | 4 passed   ← carries not one string the helper sent
same leak + observe: [] as it was BEFORE the fix      :  5 passed              ← the leak was invisible
after restore                                        :  5 passed
```

That is the gap, closed, proved in both directions. `cmp` clean on `run.ts`, `results.ts`,
`results.test.ts` afterwards.

**The privacy guarantees still hold by type**, now that the sentinel run drives `runObserve`:
`ObserveCaseResult extends ToolbarCaseResult` and adds only `app: string`, which comes from the case
table (`SAFARI`), never from a read; every other field is `number|null`, `boolean|null`, a closed
outcome union or `ReadStats`. The spread at `results.ts:261` spreads the **output** of `toolbarCase`,
which writes all thirteen fields by hand. The new `missingGroups` field is `AccuracyGroup[]` — a
closed union of five names this harness invented.

## 5. New-breakage scan of the changed lines

Changed: `main.ts`, `pages.ts`, `results.ts`, `score.ts`, `stage.ts`, `summary.ts`,
`scripts/reader-eval.mjs`, five test files; added `config.ts`, `config.test.ts`, `bytes.test.ts`.
`run.ts` is unchanged (the Minor-6 mutation was reverted cleanly).

Nothing graded Critical or Important. Checked specifically:

- No assertion was weakened. The one deleted assertion, `summarise([], []).accepted === true`
  (old `summary.test.ts`, "says nothing about observe when the run had no observe mode"), **was the
  bug**; it is replaced by `refuses a %s run that measured nothing` over all four modes.
- `pages.test.ts` replaced `toContain("t.startsWith('CLAVE-EVAL ')")` with a check that the prefix is
  interpolated and the typed literal is gone — strictly stronger.
- `formatSummary`'s new `code` clause does not change `NO_GRANT` or bare `HARNESS` output (verified
  above), and `exitCodeFor` is untouched.
- `main.ts` no longer holds module-level `mode`/`nonce`/`variant`/`repetitions`/`seconds`; the nonce
  generator is passed as a closure so `randomBytes` is still called once per run and only when the
  settings are good. `writeObserveUrls(port, nonce)` is the only caller and passes both.
- `schema` stays `1` while the results file gains `missingGroups`. Additive, every existing field
  keeps its meaning; the fixer flagged it rather than deciding. I agree it is not breakage, but the
  plan's owner may want a bump — noted, not graded.
- `tsc --noEmit` clean for `tsconfig.json` and `tsconfig.renderer.json`.
- Whole suite in the copy: **84 files passed, 1 skipped, 1537 passed** — see Observations for the
  single failure, which is not in this topic and fails identically in the pre-fix snapshot.

## Observations (out of scope, no effect on the verdict)

1. **`src/main/engine.test.ts > prompts once at the review time` fails on a 5 s timeout** in my copy.
   It fails identically in the untouched pre-fix snapshot `scratchpad/exec/rev-8/app`, so the fix
   round did not cause it; it is a timer-heavy test and several re-review agents were running suites
   concurrently. Belongs to another topic — flagging it so the coordinator can confirm it passes on a
   quiet machine.
2. **A NUL survives `norm`.** `CONFUSION_KEY_SEPARATOR`'s comment (`score.ts:141-143`) says "no
   character `norm` can produce is one", but NUL is neither `\p{White_Space}` nor U+001C–U+001F, so a
   recognised NUL passes through `norm` and a pair `(NUL, x)` would produce a key that splits into
   three parts, giving `to: ""`. Behaviourally **identical before and after the rebuild** (the old
   code used the same NUL), so it is not a regression and not this round's business; the consequence
   is a cosmetically wrong row in a confusion table for a case that already failed. Worth either
   widening the comment or using a separator `norm` provably cannot emit.
3. **The plan's frozen code block is now stale.**
   `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/files/app/src/readerEval/main.ts:45`
   still shows `const mode = (process.env.CLAVE_EVAL_MODE ?? "accuracy") as EvalMode;`. Consistent
   with the standing note that the code differs from the plan's blocks and they must never be
   re-extracted — recorded only so nobody restores the cast from there.
4. **Minor 7 remains open** by ruling: `scripts/build.mjs` still emits `dist/reader-eval.cjs` into
   every build. Carry to the packaging task.

---

## Verdict

**ALL ADDRESSED.** No NOT-ADDRESSED findings, no new Critical or Important breakage.
