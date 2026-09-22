# Plan C-2b-2, Task 1 — three small additions to `reader:eval` (development report)

Developed in the scratch working copy `$S/c2b2-ws/app` (`node_modules` a symlink; no `pnpm` was run
against it). **Nothing was launched, staged, opened or read.** No bundle was started, `reader-eval.mjs`'s
program half was never run except with a deliberately bad mode (which exits on the parse, before the
bundle check), `dist/reader-eval.cjs` was only `node --check`ed, and nothing under
`~/Library/Application Support/Clave Agent Dev/` was touched.

The real repo is byte-identical to the state I started from: `diff -r -q` of
`/Users/sardorastanov/techcells/asset-to-evidence/app/src/readerEval` against my pristine backup is
empty, and both `app/scripts/reader-eval.mjs` and `app/scripts/reader-eval.test.ts` `cmp` clean.

---

## 1. Files changed

**Fifteen** files — thirteen under `src/readerEval/**` (seven modules and six test files, as the
table below lists) plus the two scripts. All inside the permitted set (`src/readerEval/**`, `scripts/reader-eval.mjs`,
`scripts/reader-eval.test.ts`). No file was added and none was removed.

| File | Change |
|---|---|
| `src/readerEval/cases.ts` | `WindowBox` spelled out instead of `typeof BROWSER_WINDOW`; `WindowPosition`, `DEFAULT_POSITION`, `positioned()`; `OBSERVE_BROWSERS` and observe cases now Safari **and** Chrome (20 cases) |
| `src/readerEval/config.ts` | `coldstart` in `EVAL_MODES`; `stagesWindows(mode)`; `wholePoint()` and `parsePosition()`; `EvalSettings.position`; `BAD_POSITION` refusal |
| `src/readerEval/helper.ts` | `permissionOf()` (through the product's own `parseHelperPermission`, closed to four words); `startAndWaitReady()` with an injected clock, timed from before the spawn |
| `src/readerEval/results.ts` | `EvalPermission`, `ColdstartVerdict`, `coldstart` in `EvalSummary`, `coldstart` in `EvalMode`; `helper: {readyMs}` and `permission` on `EvalResults`; all three written by hand in `serialiseResults` |
| `src/readerEval/run.ts` | `RunDeps.position` (with the doc comment saying what it does NOT do for Terminal) applied to both Chrome stagings; `runMode(mode, deps)` — the one place that decides what a mode runs |
| `src/readerEval/summary.ts` | `HelperFacts`, fail-closed `NOTHING_MEASURED` default, `summariseColdstart()`; `coldstart` reaches `accepted` |
| `src/readerEval/main.ts` | Staging (scratch folder, truth, page server) built only when `stagesWindows(mode)`; `startAndWaitReady`; `NO_GRANT` skipped for `coldstart`; one `runMode` call in place of three inline mode tests; `helper`/`permission` written; `app` on each observe URL |
| `scripts/reader-eval.mjs` | `coldstart` in `MODES`; new USAGE; `parsePositionArg()` and `--position`; `evalEnv` sets `CLAVE_EVAL_POSITION` only when asked; `formatObserveUrls()` (pure, names the browser); `helper ready in N ms` and the coldstart verdict line in `formatSummary` |
| `src/readerEval/{cases,config,helper,results,run,summary}.test.ts`, `scripts/reader-eval.test.ts` | The new tests (below) |

Byte-identical and deliberately untouched: `stage.ts` and `score.ts` (the two files that hold spelled
escapes), `guard.ts`, `pages.ts`, `server.ts`, `stagedTitle.ts`, `thresholds.ts`, `testing/fakes.ts`,
`bytes.test.ts`, `imports.test.ts`.

---

## 2. The new USAGE text, verbatim

```
usage: pnpm --dir app reader:eval -- <mode> [options]

  modes
    accuracy   the staged pages and the two terminals, scored (default)
    toolbar    40 Chrome stagings: address host and the private badge
    observe    windows the OWNER stages by hand (Safari and Chrome, normal and
               private/incognito); a window staged private that shows no private
               marker fails the run, and so does a normal one flagged private
    all        all three, in that order
    coldstart  the helper only: how long it takes to be ready and what it says
               about the Screen Recording permission. No window is opened and
               nothing is read. Not part of "all"; ask for it by name.

  options
    --repetitions <n>   reads per accuracy case (default 5)
    --seconds <n>       how long observe mode watches (default 120)
    --variant <name>    none | bookmarks-bar (default none)
    --position <x>,<y>  top-left corner of every staged Chrome window, in points
                        (default 40,60). Use it to stage the run on another
                        display. It does not move a Terminal window.

  Nothing is read but a window this harness staged and identified by a one-run title.
```

Environment now passed through `open --env`: the seven of before, plus `CLAVE_EVAL_POSITION` **only
when `--position` was given**. An absent variable is what tells the bundle to use `DEFAULT_POSITION`,
so the default corner lives in one file (`cases.ts`) and is never copied into the script; the one
place it appears twice — the sentence in USAGE — is pinned by a test against `DEFAULT_POSITION`.

---

## 3. The results JSON

Every mode's results gain two top-level fields:

```json
  "helper": {"readyMs": 812},
  "permission": "granted",
```

and `summary` gains `"coldstart": null` (or a verdict). A whole `coldstart` file:

```json
{
  "schema": 1,
  "mode": "coldstart",
  "nonce": "a1b2c3d4e5f6",
  "repetitions": 5,
  "chromeVariant": "none",
  "helper": {"readyMs": 43912},
  "permission": "granted",
  "accuracy": [],
  "toolbar": [],
  "observe": [],
  "summary": {
    "groups": [],
    "missingGroups": [],
    "toolbar": null,
    "observe": null,
    "coldstart": {"readyMs": 43912, "permission": "granted", "passed": true},
    "accepted": true
  }
}
```

`permission` is one of `granted | denied | refused | unknown` — the helper's own three words plus the
harness's fourth for "it answered something else, or did not answer". It is the only field whose
value originates in a helper answer's own string, and it passes through the product's
`parseHelperPermission` with an `unknown` fallback, so nothing the helper said can reach the file
under that name. `readyMs` is a number and nothing else. Both are written out by hand in
`serialiseResults`, like every other field, and the sentinel test now drives a `coldstart` run whose
helper answers `permission` with a sentinel string.

Printed by the terminal side, plainly, in every mode:

```
helper ready in 43912 ms
...
PASS  coldstart ready 43912 ms  permission granted
```

and on a shortfall:

```
SHORT  coldstart ready 900 ms  permission denied
      the grant does not reach a helper spawned by the evaluation entry
```

`observe-urls.json` rows gain `"app"`, and the printed list now names the browser and the window kind
per URL (`Safari  PRIVATE window`, `Chrome  INCOGNITO window`) — ten Safari URLs and ten Chrome ones,
five normal and five private in each, all carrying this run's nonce.

---

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Harness tests | `vitest run --root $S/c2b2-ws/app src/readerEval scripts/reader-eval.test.ts` | **17 files, 588 tests, all pass** (baseline in this copy: 17 files, 492 tests) |
| Whole suite in the copy | `vitest run --root $S/c2b2-ws/app` | **86 passed + 1 skipped files, 1658 passed + 1 skipped tests** |
| Typecheck | `tsc --noEmit -p $S/c2b2-ws/app/tsconfig.json` | exit 0, no output |
| Typecheck (renderer) | `tsc --noEmit -p .../tsconfig.renderer.json` | exit 0, no output |
| Build | `node $S/c2b2-ws/app/scripts/build.mjs` | exit 0; `dist/reader-eval.cjs` 53 470 bytes (was 44 481 at C-2b-1) |
| Syntax | `node --check $S/c2b2-ws/app/dist/reader-eval.cjs` | exit 0 |
| CLI, bad arguments | `node scripts/reader-eval.mjs nonsense` | printed the usage text, exit 1, opened nothing |
| Bytes | 33 files of `src/readerEval/**` + the two scripts scanned for control bytes | **NONE** outside tab and newline; all valid UTF-8; `bytes.test.ts` green |

The one skipped test is `src/shell/realReader.binary.test.ts` ("the real clave-reader binary under the
real client"), which needs a built helper binary that a scratch copy does not have. The plan's stated
baseline is **1563 passed / 87 files** in the real repo where that test runs; this copy's baseline is
therefore 1562 passed + 1 skipped, and 1562 + 96 new tests = 1658, which is what ran.

---

## 5. Mutations — every new test shown to bite

Method: `cp` the file aside, apply one literal replacement, run the harness tests, record the failing
test names, restore, `cmp` against the copy. All sixteen exited non-zero; all sixteen restores are
byte-identical. Driver: `$S/exec2/mutate.py`; full failing lists in `$S/exec2/mutations.json`.

The plan's six required mutations are **a, b1/b2, c, d1/d2, e, f**.

| # | File | Mutation | Failing tests | n |
|---|---|---|---|---|
| **a** | `run.ts` | `coldstart` runs the observe loop, so it asks the window server | `writes no read and no frontWindow line at all` | 1 |
| **b1** | `config.ts` | a coordinate is read with `Number()`, so a float is accepted | `reads one coordinate as digits and nothing else`; `refuses a fractional coordinate`; `refuses a negative coordinate`; `refuses a signed coordinate`; `refuses spaces around a number`; `refuses exponent notation`; `refuses hexadecimal`; `refuses a coordinate past the safe integer range` | 8 |
| **b2** | `reader-eval.mjs` | the same, in the CLI's own parser | `refuses a fractional coordinate`; `refuses a negative coordinate`; `refuses a signed coordinate`; `refuses spaces around a number`; `refuses exponent notation`; `refuses hexadecimal`; `refuses a coordinate past the safe integer range` | 7 |
| b3 | `config.ts` | the digit check lets a dot through | `reads one coordinate as digits and nothing else` | 1 |
| **c** | `run.ts` | `observe` drops the nonce from the staged title it demands for a Chrome case | `reads nothing when the right app carries another run's nonce` | 1 |
| **d1** | `helper.ts` | `readyMs` measured from this process's own start (`spawnedAt = 0`) | `is measured from the spawn, not from the process start and not from ready`; `still reports the interval when the helper never became ready` | 2 |
| **d2** | `helper.ts` | `readyMs` measured from the moment `ready` arrived | the same two | 2 |
| **e** | `summary.ts` | a coldstart run is accepted whatever the permission answer | `accepts a coldstart run only for both of its figures`; `refuses a helper that answered denied`; `refuses a helper that answered refused`; `refuses a helper that answered unknown`; `carries no string the helper sent in a coldstart run either` | 5 |
| **f** | `run.ts` | `observe` does not ask for line boxes for a Chrome case | `reads the window it was shown exactly once, with the line boxes` | 1 |
| g | `results.ts` | the helper start time is not written to the file | `records the helper start time in a {accuracy,toolbar,observe,all,coldstart} run` (5); `does carry the numbers and the codes it exists for`; `carries no string the helper sent in a coldstart run either` | 7 |
| h | `helper.ts` | the permission answer reaches the file as the helper's own string | `calls a word the helper does not have unknown`; `calls a window title unknown`; `calls a number unknown`; `carries no string the helper sent in a coldstart run either` | 4 |
| i | `summary.ts` | `coldstart` folded into `all` | `keeps coldstart out of every other mode, all included`; `needs every verdict the run's mode asked for` | 2 |
| j | `run.ts` | the accuracy staging ignores the position it was given | `carries --position into the accuracy staging, size untouched` | 1 |
| k | `reader-eval.mjs` | the CLI sends a position variable even when none was asked for | `sends no position variable at all when none was asked for`; `opens a new instance, waits for it, and passes every switch through --env` | 2 |
| l | `cases.ts` | the observe cases go back to Safari only | `are five normal and five private stagings in each of the two browsers`; `cover the five page variants in each browser and each window kind`; `carry the browser and the expectation in the name…` — and `run.test.ts` fails to collect at all (its Chrome fixtures throw) | 3 + a collection failure |
| m | `config.ts` | an empty `CLAVE_EVAL_POSITION` falls back on the default instead of being refused | `refuses nothing at all` | 1 |

Proved separately, by hand (backup, mutate, fail, restore, `cmp` identical): changing USAGE's
`(default 40,60)` to `41,60` fails `tells the owner the same default corner the bundle would use`.

Mutations also re-run from C-2b-1 to confirm their anchors still hold after this change: none were
re-run — no anchor of the sixteen C-2b-1 mutations sits in a line this task edited except
`summary.ts`'s group-verdict line (mutation g of C-2b-1), which is untouched, and the whole suite is
green.

---

## 6. Tests added (96)

- **`helper.test.ts`** — `readyMs` measured from the spawn with an injected clock and three moments
  deliberately far apart (1 000 spawn, +5 spawn cost, +295 warm-up → 300, so "from process start"
  gives 1 300 and "from ready" gives 0); zero for a helper ready at once; still reported when `ready`
  never came; the helper handed back is the one started. `permissionOf` for the helper's three words,
  for a fourth word, a window title, a number, nothing, and for a call that never answered.
- **`run.test.ts`** — `coldstart` sends nothing at all to a fake helper (`link.sent` empty, no `read`,
  no `frontWindow`), stages nothing (no command run, no script written) and returns three empty
  lists, while `accuracy`/`toolbar`/`observe` all do send; the default corner and `--position`
  reaching both Chrome stagings with the size untouched; `--position` not reaching a Terminal
  staging; Chrome `observe` — a Safari window carrying a Chrome case's title reads nothing, another
  run's nonce reads nothing, another Chrome case of this run reads nothing, the right window is read
  exactly once with `expect` equal to the front window and `lines: true`, and a normal Chrome window
  is not flagged private.
- **`config.test.ts`** — `stagesWindows` for every mode; the `--position` accept table (`120,80`,
  `0,0`, `3000,140`) and the twelve-row refusal table, each asserted through both `parsePosition` and
  `readEvalSettings`; the default is `DEFAULT_POSITION` and is `40,60`; `wholePoint` on its own.
  (`it.each(EVAL_MODES)` already covers `coldstart` being taken, and the `BAD_MODE` rows are unchanged.)
- **`summary.test.ts`** — the coldstart verdict: granted plus a number passes, zero passes,
  `denied`/`refused`/`unknown` fail, `NaN`/`±Infinity` fail and record `readyMs: null`, `null` when the
  run was not a coldstart; `accepted` for a coldstart run; coldstart is `null` in every other mode
  including `all`; a coldstart summary built with no helper figures is a shortfall. The pre-existing
  `it.each(EVAL_MODES)("refuses a %s run that measured nothing")` now covers `coldstart` too.
- **`results.test.ts`** — the sentinel run extended with a `permission` sentinel; a whole `coldstart`
  run driven through the sentinels; `helper.readyMs` present and a number in every mode's file; a
  smuggled field inside the `helper` object does not reach the file.
- **`cases.test.ts`** — twenty observe cases, ten per browser, five private each; five page variants
  per browser and window kind; browser and expectation in every name; names unique; `positioned`
  keeps the size and takes the corner, and is a no-op at the default.
- **`reader-eval.test.ts`** — `coldstart` as a mode; the four options together; USAGE names every mode
  and every option and states coldstart's two facts; `--position` accept/refuse tables against
  `parsePositionArg` and `parseEvalArgs`; the variable is absent unless asked for and present when
  asked; USAGE's default corner equals `DEFAULT_POSITION`; the coldstart print, the denied print, the
  "not measured" print, `helper ready in N ms` in a staged run, nothing about coldstart otherwise;
  `formatObserveUrls` naming the browser and window kind for all four combinations.

---

## 7. Decisions taken, with the cost if wrong

1. **`runMode(mode, deps)` in `run.ts`, replacing three `mode === …` tests inside `main.ts`.** The
   plan's test — "`coldstart` writes NO `read`/`frontWindow` line, assert on the lines the fake
   received" — has nothing to bind to while that decision lives in the untestable entry point. *Cost
   if wrong:* one more exported function in `run.ts`; `main.ts` is three lines shorter and the mode
   table is now in one place rather than two.
2. **`permission` is recorded in EVERY mode, not only `coldstart`.** The plan asks for it in
   `coldstart`'s file; making it uniform costs one closed-union field and means the results shape does
   not change between modes. In every other mode it can only be `granted`, because the run refuses
   with `NO_GRANT` otherwise. *Cost if wrong:* one redundant field in four modes' files.
3. **`permission` is mapped through the product's `parseHelperPermission` with an `unknown`
   fallback**, rather than written down as the helper sent it. It is the only value in the file whose
   origin is a helper answer's own string. *Cost if wrong:* a helper that one day invents a fourth
   legitimate word is recorded as `unknown` until somebody adds it to the union — visible in a diff,
   which is the direction this harness errs in everywhere else.
4. **`--position` is REFUSED on anything malformed, not defaulted** (like `--variant`, unlike
   `--repetitions`/`--seconds`, which fall back). A position decides which display a run measured;
   a silent fallback would file a 2x-display run under the external display's numbers, which is the
   one thing the option exists to tell apart. An absent variable is still the default. *Cost if
   wrong:* a typo costs the owner a re-run rather than producing a run with the wrong provenance.
5. **The position rule is written twice, once in TypeScript and once in the `.mjs`**, as the mode and
   variant rules already are. The bundle must refuse a bad position whatever started it (anything that
   can set an environment variable can), and the owner must be told before windows start appearing.
   *Cost if wrong:* two parsers to keep in step; both have the same twelve-row refusal table as a test,
   and the b1/b2 mutations show each table bites on its own side.
6. **Neither parser uses a regular expression.** `Number()` accepts ` 3 `, `3.0`, `-0`, `1e3`, `0x20`
   and `Infinity`, and every character class in this harness that was written as a literal has come
   back from the tooling as a raw control byte. Both count digits by code point instead. *Cost:* six
   lines instead of one, twice.
7. **`WindowBox` is now an interface instead of `typeof BROWSER_WINDOW`.** The old alias made every
   field a literal type, so no second box could exist and `positioned()` could not return one.
   `BROWSER_WINDOW` still satisfies it and `cases.test.ts` still pins its four numbers. *Cost if
   wrong:* a case table could now carry a box with numbers nobody recorded; every case still uses
   `BROWSER_WINDOW`, and the existing test asserts each browser case's `window` **is** that object.
8. **The observe case name says `private` for Chrome too**, although Chrome's window is called
   Incognito. The word in the name is the expectation being judged, and one word keeps the name, the
   staged title and `expectPrivate` in step across both browsers. The terminal side says "INCOGNITO
   window" when telling the owner what to open. *Cost if wrong:* the owner reads `chrome-private-…`
   in the results and has to know it means the incognito window — which the printed URL list says.
9. **The position is NOT written into the results file.** The plan lists exactly what results gain
   (`helper: {readyMs}`), and the results allow-list is the thing two reviews attacked hardest; I did
   not widen it beyond the ask. *Cost if wrong — and this one is real:* a results file does not say
   which display it came from, so Task 8's Retina record must tie the file (named by its nonce) to the
   command that made it. One field, `"position": {"xPt": …, "yPt": …}`, would close it; it is numbers
   only and would need one line in `serialiseResults` and one in the sentinel test. I left the call to
   the reviewer.
10. **The page server and the scratch folder are created only when `stagesWindows(mode)`**, in
    `main.ts`, keeping the existing order (server before helper) because the terminal side gives up
    watching for `observe-urls.json` after twenty seconds and a cold helper takes up to ninety to say
    `ready`. *Cost if wrong:* `main.ts` now has a `staging` that may be `null`; the truth files are not
    read at all in `coldstart`, which is the intent.
11. **`summarise`'s fifth parameter has a fail-closed default** (`{readyMs: NaN, permission:
    "unknown"}`) so the four staged-window modes need not pass figures they have no use for. A
    `coldstart` summary built without them is a SHORTFALL, never a pass. *Cost if wrong:* a caller
    could forget to pass them for a real coldstart run and get a false shortfall rather than a false
    pass — the direction this file errs in everywhere.

---

## 8. What I could not do

- **Nothing in `main.ts` is unit-tested**, as before: it needs Electron and a screen. What is new is
  that the two claims it carries — "coldstart stages nothing" and "which parts a mode runs" — are now
  values elsewhere (`stagesWindows`, `runMode`) that tests hold, so what is left in `main.ts` is the
  wiring a reviewer reads rather than a decision only it knows.
- **`readyMs` has never been measured against a real helper.** The test pins which two moments are
  subtracted; the number itself is Task 2 Step 5 and Task 7 Step 3 of the plan.
- **`coldstart`'s permission answer has never come from a real helper spawned by the evaluation
  entry.** That is the unknown the mode exists to settle (plan Task 2 Step 5: a `NO_GRANT` there
  blocks Tasks 3-5). The mode now reports it instead of refusing, which is what lets the run write a
  results file saying so.
- **Chrome's `observe` path has never seen a real Chrome window**, and neither had Safari's. The guard,
  the `lines: true` and the private rule are the same code in both, exercised against fakes.
- **Whether Chrome honours `--window-position` at all** is still open (C-2b-1's dev report, item 1).
  `--position` changes the number in a flag that was already being sent; if Chrome ignores the flag,
  it ignores it for the default too, and the first run will show it as windows in the wrong place.

---

## 9. Byte checks

- All 33 files of `src/readerEval/**` plus `scripts/reader-eval.{mjs,test.ts}`: **no byte below 0x20
  other than tab and newline, no 0x7f**, all valid UTF-8. `bytes.test.ts` green, including its two
  pinned spellings (`score.ts`'s `\\u001C-\\u001F` and `stage.ts`'s `\\u0000-\\u001F`, both files
  `cmp`-identical to the pristine copy — neither was edited).
- Non-ASCII in the thirteen changed files: U+2014 (em dash) and U+2026 (ellipsis) only, both already
  the style of these files; `score.test.ts`'s accented fixtures are pre-existing and untouched.
- Every changed file diffed against the pristine backup; exactly thirteen files differ, and the
  twenty untouched ones `cmp` clean.
- The mutation driver writes no backslash of its own to any source file; its sixteen restores all
  `cmp` byte-identical.

---

# Addendum (2026-09-19) — the staged position is recorded in the results file

The coordinator ruled on decision 9: record it. Done. Decision 9 above is superseded; its stated
cost ("a results file does not say which display it came from") no longer applies.

## The field

`EvalResults` gains one top-level envelope field, beside `helper` and `permission`:

```json
  "position": {"x": 40, "y": 60},
```

- **The values the run ACTUALLY used** for its Chrome stagings, the default included — not only a
  position somebody typed. `main.ts` takes it from `readEvalSettings`, which is the same value
  `runMode` hands to both Chrome staging commands, so the file records what was staged rather than
  what was asked for.
- **`null` for `coldstart`**, which opens no window and so has no corner to report. Writing `40,60`
  there would be recording a place nothing was ever put.
- Two integers of this harness's own choosing. Nothing about the machine, nothing read, no display
  name, no screen size.

## Files touched (two more; still inside the permitted set)

| File | Change |
|---|---|
| `src/readerEval/results.ts` | `position: {x: number; y: number} \| null` on `EvalResults`; written by hand in `serialiseResults`, field by field, `null` passed through as `null` |
| `src/readerEval/main.ts` | `position: staging === null ? null : {x: position.xPt, y: position.yPt}` |
| `src/readerEval/results.test.ts` | the three tests below, plus `position` added to every existing results literal |

**Fifteen** files differ from the pristine copy — thirteen under `src/readerEval/**` plus the two
scripts. The addendum added no new file: `results.ts`, `main.ts` and `results.test.ts` were already
among them. (The earlier "fourteen" here, and "thirteen" in section 1, were both arithmetic slips
counting the same fifteen files; `diff -r -q` against the pristine copy shows fifteen. Corrected in
fix round 1, review Minor 6.)

## Tests (2 new, 590 in the harness folder)

- **`records the default corner when the option was not given, and the given one when it was`** — the
  value is taken from `readEvalSettings` with and without `CLAVE_EVAL_POSITION`, so the test ties
  what the bundle was told to what the file says it did: `{}` gives `{x: 40, y: 60}` and equals
  `DEFAULT_POSITION`; `3000,140` gives `{x: 3000, y: 140}`.
- **`records no position at all for a coldstart run`** — `null`, and the key is still present.
- Extended: **`records the helper start time in a %s run`** now also asserts `position` per mode
  (`null` for `coldstart`, `{x: 40, y: 60}` for the other four); **`does carry the numbers and the
  codes it exists for`** asserts the envelope; **`ignores a field that was never meant to be
  written`** now smuggles a `display: "SMUGGLED-DISPLAY-NAME"` INTO the position object and asserts
  it does not reach the file — the hand-written serialiser drops it.
- **The sentinel run is unchanged in its verdict**: the whole `all` run and the whole `coldstart` run
  are still serialised with every helper string a sentinel, and neither `SENTINEL` nor any of the six
  sentinels appears anywhere in the output. The position carries no string by type and none by
  construction.

## Mutation (all seventeen still bite, all restores byte-identical)

| # | File | Mutation | Failing tests | n |
|---|---|---|---|---|
| **n** | `results.ts` | the staged position is not written to the results file (the `position:` line deleted from `serialiseResults`) | `records the default corner when the option was not given, and the given one when it was`; `records no position at all for a coldstart run`; `does carry the numbers and the codes it exists for`; `records the helper start time in a {accuracy,toolbar,observe,all,coldstart} run` | 8 |

Known gap, stated plainly: `main.ts`'s own `staging === null ? null : …` is in the entry point and so
is not unit-tested, as nothing in `main.ts` is. What the tests hold is the serialiser's behaviour for
both shapes and the value `readEvalSettings` produces; what a reviewer reads is the one line between
them.

## Re-verification

| Check | Result |
|---|---|
| Harness tests | **17 files, 590 tests, all pass** (was 588) |
| Whole suite in the copy | **86 passed + 1 skipped files, 1660 passed + 1 skipped tests** |
| Typecheck, both configs | exit 0, no output |
| Build | exit 0; `dist/reader-eval.cjs` 53 909 bytes; `node --check` exit 0 |
| Bytes | 33 files scanned: no control byte outside tab and newline, all valid UTF-8; `bytes.test.ts` green |
| Real repo | `diff -r -q` against the pristine backup still empty; both scripts still `cmp` clean |

---

# Fix round 1 (2026-09-19) — the review's two Important and six Minor findings

Worked in the REAL repo this time (`/Users/sardorastanov/techcells/asset-to-evidence/app`), the code
having been installed. Nothing was launched, staged or read: no bundle was started,
`scripts/reader-eval.mjs`'s program half was never run, `dist/reader-eval.cjs` was only rebuilt by
`pnpm smoke` (which runs the app's own stand-in smoke path, not the harness), and nothing under
`~/Library/Application Support/Clave Agent Dev/` was touched.

Twelve files changed, all inside the permitted set: `src/readerEval/{config,helper,main,results,summary}.ts`,
`src/readerEval/{config,helper,results,run,summary}.test.ts`, `scripts/reader-eval.mjs`,
`scripts/reader-eval.test.ts`. **`run.ts` and `cases.ts` were not touched** — the reviewer was right
that both Important findings are closed by tests alone.

| Check | Result |
|---|---|
| Harness folder | **17 files, 608 tests** (was 590) |
| Whole suite | **87 files, 1679 tests**, all pass, none skipped |
| `pnpm typecheck` | exit 0, no output (both configs) |
| `pnpm smoke` | **SMOKE OK** |
| Byte scan, 33 files | no byte < 0x20 outside tab/newline, no 0x7f, valid UTF-8; non-ASCII U+2014/U+2026 only (plus `score.test.ts`'s pre-existing accented fixtures, untouched) |
| Revert proofs | **17 new, all bite, all restores byte-identical**; the 17 from the first round **re-run against the installed code, all still bite** |

Drivers: `$S/exec2/fix1-mutate.py` (this round, results in `fix1-mutations.json`) and
`$S/exec2/round0-rerun.py` (the first round's, re-anchored for the `helper.ts` split).

---

## Important 1 — the results allow-list was unpinned for the `toolbar` and `observe` ROW bodies

**Changed:** tests only. `src/readerEval/results.test.ts:244-305`, a new case *"ignores a field
smuggled into a toolbar or an observe ROW"*. It hands `serialiseResults` one toolbar row and one
observe row already carrying what a future upstream field would carry — `text`, `toolbarText`, a
`lines` array with its own text, and a foreign `title` — cast `as never` exactly as the accuracy row
is, and asserts none of the eight strings reaches the file. It then asserts the exact key set of each
written row, so a field ADDED to the allow-list is as visible as one smuggled past it, and that both
rows really were serialised (or the test would prove nothing).

Why the sentinel run did not already cover it, restated in the test's own comment: `toolbarFacts`
reduces every string to a boolean or a pixel figure before a row exists, so driving the observe path
end to end proves things about `toolbarFacts`, not about the serialiser.

**Revert proof** — the reviewer's own two probes, which used to fail zero tests:

| # | Reverted to | Failing test | n |
|---|---|---|---|
| R1 | `observe: results.observe.map((entry) => ({...entry}))` | `ignores a field smuggled into a toolbar or an observe ROW` | 1 |
| R2 | `toolbar: results.toolbar.map((entry) => ({...entry}))` | the same | 1 |

## Important 2 — the app string handed to the product's private rule in `observe` was unpinned

**Changed:** tests only. `src/readerEval/run.test.ts:434-475`, two cases around one strip,
`"127.0.0.1:51234/acme/private-api  Private"`:

- *"does not call a normal CHROME window private for the word `private` inside an address"* — the
  `chrome-normal-ticket-dark-14` case must come back `private: false`, and `summariseObserve` must
  then report `falsePrivate: 0` and `passed: true`. Chrome's badge is "Incognito"; the bare word is
  Safari's, and the core refuses it for Chrome precisely because an ordinary address can contain it
  as a path segment.
- *"does call a SAFARI window private for that same bare word, which is Safari's badge"* — the same
  strip in `safari-private-chat-light-14` comes back `private: true` with `privateBottomPx` recorded
  and `privateMissed: 0`.

One strip, two browsers, opposite answers: hard-coding either app name breaks one of the two.
`run.test.ts` now imports `summarise` so the consequence — a run failed for a reason that is not
real — is asserted, not just the boolean.

**Revert proof:**

| # | Reverted to | Failing test | n |
|---|---|---|---|
| R8 | `toolbarFacts(…, {app: "Safari"})` in `runObserve` (the reviewer's probe) | `does not call a normal CHROME window private for the word private inside an address` | 1 |
| R8b | `toolbarFacts(…, {app: "Google Chrome"})` | `does call a SAFARI window private for that same bare word, which is Safari's badge` | 1 |

## Minor (c) — `lines: true` pinned for Safari's observe read as well as Chrome's

**Changed:** tests only. `src/readerEval/run.test.ts:322-332` — the existing Safari observe test now
asserts `reads[0].lines === true` and that `bandPx` was recorded, with the reason in the comment:
carried item 29 is measured through `privateBottomPx` against `bandPx`, and neither exists without
the line boxes.

| # | Reverted to | Failing test | n |
|---|---|---|---|
| R4 | `lines: theCase.app === CHROME` (Safari loses its boxes — the reviewer's probe) | `reads a window the OWNER staged, once, and files it under the case in its title` | 1 |
| R4b | `lines: theCase.app !== CHROME` (Chrome loses its boxes) | `reads the window it was shown exactly once, with the line boxes` | 1 |

## Minor (d) — both `--position` parsers refuse a coordinate past any screen

**Changed:** behaviour. `src/readerEval/config.ts:58-71` adds `POSITION_MAX_PT = 20_000` with the
reason written out — no screen is 20 000 points across, and the bound is not about this machine but
about a stray digit: `--position 400,600000` parses perfectly as two whole numbers, stages every
window off every display, and spends a ten-minute session producing `notStaged` for all eighteen
cases. It fails closed, which is why it is a Minor, but the whole reason a malformed position is
refused rather than defaulted is that this is the option whose typo the owner cannot see until the
session is over. `config.ts:104` applies it; `scripts/reader-eval.mjs:29-38,95` is the same bound on
the CLI side, and the USAGE line now states it so the owner gets a reason rather than a bare refusal.

Three rows added to each of the two existing refusal tables (`20001,60`, `40,20001`, `400,600000`)
plus a case per side pinning the bound itself (20 000 taken, 20 001 refused).

**A real bug this surfaced.** Quoting `POSITION_MAX_PT` inside `USAGE` put a top-level `const`
reference above its declaration: importing the module threw `ReferenceError: Cannot access
'POSITION_MAX_PT' before initialization`, so `scripts/reader-eval.test.ts` failed to collect at all
and the CLI would have died on any invocation. Found by revert proof **P2** in its first run (0 named
failures but a non-zero exit), fixed by moving the constant above `USAGE`
(`scripts/reader-eval.mjs:29-38`), with the reason in its doc comment. The import in the test file is
the standing guard: a TDZ error there fails the whole file loudly.

| # | Reverted to | Failing tests | n |
|---|---|---|---|
| P1 | `config.ts` drops the bound | `refuses an x past any screen`; `refuses a y past any screen`; `refuses a stray extra digit`; `takes a coordinate up to the bound…` | 4 |
| P2 | the CLI drops the bound | the same four, CLI side | 4 |
| P3 | the bound off by one (20 001) | the three `refuses …` rows | 3 |

## Minor (b) — a monotonic clock, and `summarise` refuses a duration that ran backwards

**Changed:** behaviour, both halves.

- `src/readerEval/main.ts:104-116` — one clock for the whole entry point,
  `const now = (): number => Math.round(performance.now())` (`node:perf_hooks`), used for the helper
  timing and for the guard's own timeouts. `Date.now()` no longer appears in `main.ts`. A wall clock
  can step; a cold helper start is 43-90 s, long enough for a step to land inside one, and a stepped
  clock would also shorten or lengthen the guard's polls mid-wait. Rounded at the reading rather than
  at the subtraction, so every duration reported is a whole number of milliseconds and no path has to
  remember to round.
- `src/readerEval/summary.ts:206` — `Number.isFinite(helper.readyMs) && helper.readyMs >= 0`. A
  negative duration is the same "not a measurement" as `NaN` wearing a plausible face: `-500` would
  print as a start time and pass a finiteness check. The rule holds whatever clock the caller used.

Tests: the refusal table in `summary.test.ts` gains `a negative duration`, plus
*"refuses a run whose helper start time ran backwards, however small"* (`-1` fails, `0` passes); and
`helper.test.ts`'s new entry-point describe asserts `main.ts` imports `node:perf_hooks`, calls
`performance.now()` and contains no `Date.now()`.

| # | Reverted to | Failing tests | n |
|---|---|---|---|
| N1 | `summarise` asks only `Number.isFinite` | `refuses a readyMs of a negative duration…`; `refuses a run whose helper start time ran backwards…` | 2 |
| N2 | the entry point back on the wall clock | `times the helper on a monotonic clock, not on the wall clock` | 1 |

## Minor (a) — a refusal now carries the elapsed helper time

**Changed:** behaviour. `src/readerEval/results.ts:199-208` widens `EvalError` by one OPTIONAL number
(`readyMs`), and `results.ts:378-389` writes it by hand and only when it is a usable figure — a
`NaN` or an `Infinity` would otherwise be written by `JSON.stringify` as `null`, which reads like a
figure that was taken and came back empty, and a negative one is no measurement at all. The refusals
raised before a helper exists (`BAD_MODE`, `BAD_VARIANT`, `BAD_POSITION`, the catch-all) have no such
number and still write exactly `{error, code}`. `main.ts:190-201` passes it to the `PROTOCOL` and
`NO_GRANT` refusals.

Applied in **every** mode, not only `coldstart`: the number is measured in every mode, it is a number,
and a `PROTOCOL` failure in an accuracy run is worth timing too. *Cost if wrong:* one extra key in a
refusal file the CLI does not print.

Tests: `results.test.ts:248-268` *"writes the elapsed helper time beside a refusal, and only when it
is a real number"* (120 000 and 0 written; `NaN`, `Infinity`, `-1` dropped; a `BAD_MODE` refusal
unchanged; a smuggled `why` string does not ride along), and the entry-point describe asserts
`main.ts` hands `readyMs` to both refusals and to neither of the pre-spawn ones.

| # | Reverted to | Failing test | n |
|---|---|---|---|
| E1 | the serialiser drops the number again | `writes the elapsed helper time beside a refusal…` | 1 |
| E2 | the serialiser admits any `number`, `NaN` included | the same | 1 |
| E3 | the entry point stops passing it to `PROTOCOL` | `hands the elapsed helper time to the refusals raised after the spawn` | 1 |

## Minor (e) — the wait for `ready` is back inside the try/finally that shuts the helper down

**Changed:** structure. `startAndWaitReady` is split into two (`src/readerEval/helper.ts:103-134`):

- `spawnHelper({start, now})` — **synchronous**. Reads the clock, then spawns, and returns
  `{helper, spawnedAt}` before anything is awaited.
- `waitReadyFrom(started, now)` — awaits `ready` and subtracts.

`main.ts:186-191` now spawns outside the `try` and waits inside it, so from the moment a helper
process exists it is one the `finally`'s `helper.shutdown()` will reach. The measurement is unchanged
and still timed from before the spawn.

Tests: `helper.test.ts` — *"lets the caller shut down a helper that never became ready"* drives the
real `createEvalHelper` over a fake link, fires the ready deadline, asserts `{ok: false, why:
"timeout"}` with `readyMs === 120_000`, that the helper was asked nothing at all, and that
`shutdown` then reached the link (`{"op":"shutdown"}`, input closed, **not** killed). And, because
`main.ts` can never be imported or run by a test, a small source-shape describe pins the ordering
that regressed silently: `spawnHelper(` before the `try` that precedes `helper.shutdown()`, and
`await waitReadyFrom(` between that `try` and its `} finally {`.

| # | Reverted to | Failing test | n |
|---|---|---|---|
| L1 | the wait moved back outside the try | `waits for ready inside the try whose finally shuts the helper down` | 1 |
| L2 | the clock read after the spawn | `is measured from the spawn, not from the process start and not from ready` | 1 |
| L3 | `readyMs` from this process's own start | the same, plus `still reports the interval when the helper never became ready` | 2 |

## Minor (f) — the arithmetic slip

Corrected in both places: section 1 and the addendum now say **fifteen** files (thirteen under
`src/readerEval/**` — seven modules and six test files — plus the two scripts), which is what
`diff -r -q` against the pristine copy showed all along. The file lists themselves were complete.

---

## Concerns after this round

1. **`main.ts` is still not executable by any test**, and three of its properties are now held by
   source-shape assertions (the try/finally ordering, the monotonic clock, the `readyMs` on the two
   refusals). Those are string matches: renaming a local or reflowing a line breaks them, and they
   prove the SHAPE, not the behaviour. I judge them worth it — each pins a property that a silent
   refactor has already removed once or could — but a reviewer may prefer them deleted and the
   properties left to review. They are five `expect`s in one describe in `helper.test.ts`.
2. **`--position`'s bound is a judgement, not a measurement.** 20 000 points is comfortably past any
   display anyone will attach to this machine, but it is a number I chose. If the owner ever has a
   wall of displays whose combined origin exceeds it, the option refuses a legitimate position; the
   cure is one constant, on both sides, with the tables beside it.
3. **`readyMs` is now rounded to whole milliseconds.** Fine for a figure measured in seconds; worth
   knowing before anybody reads sub-millisecond meaning into a results file.
