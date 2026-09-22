# toolbar --not-secure: fix round 1, developer report (2026-09-21)

Answers `not-secure-review.md` (APPROVED WITH CHANGES): Important 1, Important 2, Minors m1-m9.

Finished private copy (nothing under the repo's app/ was edited; the only repo file written is this
report):

    /private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/968041bc-02a0-4da7-9b7a-22bc3d9d97fd/scratchpad/fx1/app

`fx1/eval`, `fx1/docs` and `app/node_modules` are symlinks to the repo's. `fx1/pristine` is the
copy as taken (equal to the repo). No git, no cd, no pnpm, nothing launched: only vitest and tsc,
called directly with node v24.19.0. Tests were written FIRST: before any production edit 8 of the
then 56 new tests failed; the other 48 assert behaviour that was already correct and unpinned (the
review's survivors) and are proven by mutation below.

## 1. What changed

Production code: TWO files.

scripts/reader-eval.mjs (terminal side)
- `typedNotSecure(options)` (new, exported, pure). Decided from the options THIS process parsed,
  never from the file. Fail-closed: only `false` or no answer is an ordinary run.
- `exitCodeFor(results, options)`: after the two "no results" answers (exit 1), returns 2 whenever
  `typedNotSecure(options)`, whatever the file says.
- `formatSummary(results, options)`: never prints ACCEPTED when typed; prints the EXPLORATORY RUN
  line when typed OR the file is marked; prints the fixed line
  `READER_EVAL_FAILED MARKER_MISSING` when typed and the file's `notSecure !== true`.
- `runEval` hands `options` to both (the only call of each; source-pinned, and the pin forbids an
  option-less call beside it).
- `isNotSecure(results)` is fail-closed: the ONE shape of an ordinary file is
  `notSecure === false` beside `summary.exploratory === null`. Absent marker, non-boolean marker
  ("true", 1, null, 0, "false"), any value under `exploratory` (false, 0, "x", {}, unknown
  reason), an inconsistent pair, any mode, no summary at all: all treated as marked, so SHORTFALL
  and exit 2. Applies to a file with no `schema` field as well (this terminal reads those).
- `CASE_NAME_WIDTH = 49` (exported) replaces the literal 48 in the per-case line; the test
  compares it with the longest name in TOOLBAR_CASES.

src/readerEval/results.ts (bundle side)
- `accepted` is written as a strict boolean:
  `summary.accepted === true && notSecure !== true && summary.exploratory == null`.
  A non-boolean `accepted` can no longer be copied into the file (m6). The writer lock is unchanged
  in meaning.

NOT changed: main.ts, run.ts, config.ts, stage.ts, summary.ts, observe.ts (sha-identical to the
repo). Every other finding was a TEST gap; the code was already right and is now pinned.

Independence of the three "never accepted" locks (Important 1), after this round:
1. bundle `summarise` - from main.ts's `notSecure` (source-pinned, see N1b below);
2. bundle `serialiseResults` - from the results object's two markers;
3. terminal - TWO independent reasons, either enough: (a) what the terminal typed itself
   (`typedNotSecure`), which needs nothing the bundle wrote and cannot be reached by ANY wiring
   error in main.ts; (b) the file's markers, now read fail-closed.
Run-time effect of the reviewer's N1b today: the file says notSecure:false/exploratory:null/
accepted:true; the terminal, which typed `--not-secure`, prints EXPLORATORY RUN,
`READER_EVAL_FAILED MARKER_MISSING`, READER_EVAL SHORTFALL and exits 2. Pinned behaviourally by
"the terminal's own lock ... never prints ACCEPTED or exits 0, whatever the file says", whose
fixture is exactly the file N1b produces.

How N1b itself is made to FAIL a test (main.ts cannot be executed by a test): a pin on a LINE is
satisfied by a shadowed variable, so the NAME is counted instead. New test "the entry point's
wiring cannot be shadowed": the string `notSecure` occurs in main.ts exactly 4 times (bound once
in the destructuring of `configured.settings`, used three times: run, results, verdict), each of
the four sites pinned with count 1, `notSecure =` and `notSecure:` count 0, `configured.settings`
and `const configured` count 1. Any shadow of the name must spell it a fifth time (N1, N1b, X24
killed); a rename around it changes a pinned site (X22, X23 killed); a shadow of `configured`
needs a second `const configured` / `configured.settings`. Residual, stated plainly: a mutant that
both removes one pinned use AND rewrites the pins' text could still pass - no source pin can stop
an edit of the pin itself - and that is exactly why lock 3(a) exists and is behavioural.

## 2. Tests added (58; all in the two existing not-secure suites)

scripts/reader-eval.notSecure.test.ts (+35 incl. it.each rows; 34 -> 69)
- revealing is never implied by the variant, on the terminal side (3): whole parse result of
  `toolbar --not-secure` (reveal false), whole key set of `evalEnv`, end-to-end through
  `readEvalSettings`. [T8, T9, C7]
- the terminal's own lock: it typed --not-secure (5). [Important 1, N1b run-time effect]
- the file's markers are read fail-closed (6 + 7 exploratory rows + 6 mode rows). [Important 1
  probes, T1, T2; non-boolean `accepted` never ACCEPTED - ordinary-run difference 3]
- the variable present in the bundle's environment although nobody typed the flag (1 + 4 + 1).
  [ordinary-run difference 4: fails safe on both sides]
- the per-case lines of a not-secure summary (2). [T13, m7]

src/readerEval/notSecure.test.ts (+23 incl. it.each rows; 68 -> 91)
- the rule on an incognito launch (3): whole-argv equality for incognito + notSecure, ordinary
  incognito argv, once per launch through `runToolbarCase`. [S3]
- the literal true, on the line that feeds both the URL and the launch (6 rows): `runToolbarCase`
  with notSecure "yes", "1", 1, "true", {}, [] stages the ordinary URL and argv, and does not
  reveal. [R1]
- revealing is never implied by the variant, on the bundle side (6 rows + 3). [C2, C7, N5 run-time]
- a non-boolean accepted (3). [m6, Q3]
- the entry point's wiring cannot be shadowed (2). [N1b, N1, N5]

Existing tests edited (mechanical): scripts/reader-eval.test.ts - the two shared fixtures
(`accepted`, `coldstart`) gained `notSecure: false` and `exploratory: null`, which every real
schema-6 file carries; without them the fail-closed reader rightly calls them unmarked. No
assertion was changed or weakened. The cast of `formatSummary`/`exitCodeFor` in the not-secure
suite gained the optional second parameter.

## 3. Ordinary-run differences the first report omitted (review m9)

Both confirmed and now pinned:
3. The last line needs `summary.accepted === true`. Before the --not-secure change any truthy
   value printed READER_EVAL ACCEPTED (the exit code was already 2). Now "yes", 1, "true", {}, []
   print SHORTFALL and exit 2 (test "never lets a non-boolean accepted through either"), and the
   bundle never writes a non-boolean `accepted` at all (m6).
4. `CLAVE_EVAL_NOT_SECURE=1` in the BUNDLE's environment without the flag (only possible through
   launchd; `open` does not pass the shell's environment) turns an ordinary `toolbar` run into the
   marked variant. Confirmed fail-safe and pinned end to end: settings say notSecure true and
   reveal FALSE; a run whose forty captures all pass is summarised accepted:false; the file says
   notSecure:true; the terminal, which typed nothing, prints EXPLORATORY RUN + SHORTFALL, exits 2
   and does not watch. Every other mode is refused NOT_SECURE_NOT_APPLICABLE; any other value
   refuses every mode with BAD_NOT_SECURE.
New in THIS round for ordinary runs:
5. A results file that lacks either marker (or carries a non-boolean one) is now SHORTFALL/exit 2
   on the terminal. Every file the current bundle writes carries both, so a real ordinary run is
   unaffected; a hand-made or pre-schema-6-shaped file is refused. A stale bundle writes schema 5
   and was already refused.
6. `serialiseResults` writes `accepted` as a strict boolean (a non-boolean used to be copied).
7. The per-case name column of a --not-secure summary is 49 wide (was 48). Ordinary runs do not
   print it.

## 4. Counts

- Baseline (copy as taken, equal to the repo): 2932 tests (2931 passed, 1 skipped), 90 files.
- Final whole suite: 2990 tests (2989 passed, 1 skipped), 90 files (89 passed, 1 skipped).
- Harness only (src/readerEval + scripts): 1451 passed, 22 files (was 1393).
- tsc --noEmit -p tsconfig.json: exit 0. tsc --noEmit -p tsconfig.renderer.json: exit 0.

## 5. Mutations and survivors

56 mutants, each applied alone by exact one-occurrence replace (two-site mutants: each site
exactly once) by `fx1/mutate.mjs`, harness suite run, file restored from the fixed snapshot and
sha256-verified (the runner throws otherwise). Raw results: `fx1/mut-results.json`.
- Review survivors, exact find/put from the reviewer's `rv/mutate.mjs` and `rv/n1b.mjs`:
  S3, C2, C7, R1, N1, N1b, N5, T8, T9, T13 - all KILLED.
- T1, T2: the reviewer's anchor line no longer exists (isNotSecure was rewritten), so each is run
  twice: adapted to the new body (T1, T2) and as the WHOLE ORIGINAL body carrying the reviewer's
  loosening (T1o, T2o) - all KILLED. Q3 applied to the rewritten line - KILLED (one new test;
  the review had asked for no action).
- Reverts of this round's fix: I1a-I1f, m6, m7, m7b, E1, E2 - all KILLED.
- Loosenings of every condition this round added: X01-X30 - all KILLED.
First pass had one survivor of my own, found before the table run: X07 (fail-closed only for a
file that carries a schema) - fixed with the no-schema test. Q3 survived its first run and was
then pinned.
FINAL: 56 killed, 0 survived, 0 not applied. Genuine survivors: none.

Not re-run: the first round's 85 mutants (their runner is bound to the ns/ copy). The seven whose
anchors this round rewrote are covered by equivalents here: M27 = X13, M28 = X10, L46 = X29,
L47 = X30, M15 = X26+X27 together, L26 = X27, L27 = X26.

## 6. Deviations and notes

1. `isNotSecure` is fail-closed for EVERY file this terminal reads, not only for `schema === 6`
   as the brief worded it: a file with no `schema` field is also read by this terminal
   (`knownSchema`), and leaving that door open would have been survivor X07. Stricter only.
2. `typedNotSecure` is fail-closed on anything but `false`/absent rather than `=== true` as the
   review sketched. `parseEvalArgs` only produces the two booleans, so there is no run-time
   difference; it removes a truthy-loosening survivor.
3. The per-case "host found" lines are still printed only when the FILE is marked, not when only
   the terminal typed the flag: in the wiring-error case the owner gets MARKER_MISSING and the
   verdict, which is what he must act on. Nothing else was widened.
4. main.ts was NOT edited; N1b is killed by a stronger pin plus the behavioural terminal lock,
   as described in section 1.
5. No process slips: no cd, no git, no pnpm, nothing launched, repo app/ untouched
   (`diff -rq` repo vs copy: exactly the 5 files below).
6. Merge ONLY the 5 files listed below, then rebuild the bundle (`results.ts` changed).

## 7. Files (relative to app/, sha256 of the copy), identity, mutation table

```
CHANGED
scripts/reader-eval.mjs
    1bebee215f1358228937ac1613eac7fb4e704b353ada8d58be8075a2c8344048
scripts/reader-eval.test.ts
    356a26f84d8af33c875c5c5c293628720618f28213d7026bb6d9f398177b5457
scripts/reader-eval.notSecure.test.ts
    403edcb8662d85ca674636f99580153001f918640fdec947c05e60fb0fa552a2
src/readerEval/results.ts
    93b65c77754448e5499bb9a1fcd83fb2f33ad7e7bbaa16bf5cd59d9c86642073
src/readerEval/notSecure.test.ts
    22ffbf57e79baf40b6deb6e1dcdc95c8c6eb1a807b9af4aa053f22755e1b5efd
Byte check of all five: 0 control bytes other than LF, no CR, no bidi / zero-width characters.

PROTECTED, repo vs copy (sha256) - all IDENTICAL
src/readerEval/guard.ts        dd6f5254c93edea216be21ea78b9aa0e8770bdf3d0ff70794fb700b3d70b8bd6
src/readerEval/thresholds.ts   bf4c0a4f6bad945e8b05628099cceaaa81aaa7df4d73fefe4d16764602171058
src/readerEval/score.ts        cc78291f50c883a82307b9cfb994f047460fbe17ac9cd509224daa50c4f9eb61
src/readerEval/server.ts       37b1494f623b09115d8ebf61a622271637c2f11d49b32e81ebd82dbb20f39f09
src/readerEval/helper.ts       d96f5a93fe85df54c11f69c03f78260355614dd76696ccd45cab63e530fb48c7
src/readerEval/cases.ts        9dbeccfa39b4936be1dd35d23ece3108ff6b32095073303bba3ad69f443463d8
also unchanged: pages.ts, stagedTitle.ts, main.ts, run.ts, config.ts, stage.ts, summary.ts, observe.ts

MUTATIONS
S3  stage.ts  review S3: rule duplicated on incognito launches
    KILLED by 2 test(s)
      - src/readerEval/notSecure.test.ts :: the rule on an incognito launch is there exactly once, and the whole argv is this and nothing else
      - src/readerEval/notSecure.test.ts :: the rule on an incognito launch rides once on every launch of a whole incognito case, through the run
C2  config.ts  review C2: mayReveal toolbar notSecure !== false
    KILLED by 6 test(s)
      - src/readerEval/notSecure.test.ts :: revealing is never implied by the variant, on the bundle side may not reveal in toolbar for notSecure = "1"
      - src/readerEval/notSecure.test.ts :: revealing is never implied by the variant, on the bundle side may not reveal in toolbar for notSecure = 1
      - src/readerEval/notSecure.test.ts :: revealing is never implied by the variant, on the bundle side may not reveal in toolbar for notSecure = "true"
      - ... and 3 more
C7  config.ts  review C7: settings.reveal = reveal || notSecure
    KILLED by 3 test(s)
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side is read by the bundle as a run that does not reveal, end to end
      - scripts/reader-eval.notSecure.test.ts :: the variable present in the bundle's environment although nobody typed the flag makes an ordinary toolbar run the marked variant: no reveal, never accepted, on both sides
      - src/readerEval/notSecure.test.ts :: revealing is never implied by the variant, on the bundle side reads toolbar --not-secure without the reveal variable as a run that does not reveal
R1  run.ts  review R1: Boolean(deps.notSecure)
    KILLED by 6 test(s)
      - src/readerEval/notSecure.test.ts :: the literal true, on the line that feeds both the URL and the launch stages the ordinary URL and argv for notSecure = "yes"
      - src/readerEval/notSecure.test.ts :: the literal true, on the line that feeds both the URL and the launch stages the ordinary URL and argv for notSecure = "1"
      - src/readerEval/notSecure.test.ts :: the literal true, on the line that feeds both the URL and the launch stages the ordinary URL and argv for notSecure = 1
      - ... and 3 more
N1  main.ts  review N1: one-site shadow block (a no-op at run time)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
N1b  main.ts  review N1b: TWO-SITE shadow, results+verdict see false
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
N5  main.ts  review N5: run told reveal || notSecure
    KILLED by 2 test(s)
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed hands the run the validated reveal setting and nothing derived from the variant
T1  reader-eval.mjs  review T1 (adapted to the new body): isNotSecure counts only an OBJECT under exploratory
    KILLED by 7 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses exploratory = false
      - ... and 4 more
T1o  reader-eval.mjs  review T1 on the ORIGINAL body: whole old isNotSecure restored, objects only
    KILLED by 7 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses exploratory = false
      - ... and 4 more
T2  reader-eval.mjs  review T2 (adapted): the markers count only in toolbar mode
    KILLED by 6 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses notSecure: true in mode "all"
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses notSecure: true in mode "accuracy"
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses notSecure: true in mode "observe"
      - ... and 3 more
T2o  reader-eval.mjs  review T2 on the ORIGINAL body: old isNotSecure restored, top marker only in toolbar mode
    KILLED by 9 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses notSecure: true in mode "all"
      - ... and 6 more
T8  reader-eval.mjs  review T8: --not-secure implies --reveal-toolbar
    KILLED by 3 test(s)
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side does not ask to reveal unless --reveal-toolbar was typed
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side tells the bundle exactly these variables for toolbar --not-secure, and no reveal variable
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side is read by the bundle as a run that does not reveal, end to end
T9  reader-eval.mjs  review T9: evalEnv also sets the reveal variable
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side tells the bundle exactly these variables for toolbar --not-secure, and no reveal variable
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side is read by the bundle as a run that does not reveal, end to end
T13  reader-eval.mjs  review T13: host found counts any truthy host
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the per-case lines of a not-secure summary counts a host as found only for the literal true
I1a  reader-eval.mjs  revert: isNotSecure is the pre-fix body (absent / string / number markers read as ordinary)
    KILLED by 3 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a file with no summary at all, and is false for what is not a file
I1b  reader-eval.mjs  revert: exitCodeFor ignores what the terminal typed
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure never prints ACCEPTED or exits 0, whatever the file says
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure fails closed on what was typed: anything but false or nothing counts as typed
I1c  reader-eval.mjs  revert: the ACCEPTED line ignores what the terminal typed
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure never prints ACCEPTED or exits 0, whatever the file says
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure fails closed on what was typed: anything but false or nothing counts as typed
I1d  reader-eval.mjs  revert: runEval prints the summary without its own options
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure is what the program half asks, with the options it parsed itself
I1e  reader-eval.mjs  revert: runEval takes the exit code without its own options
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure is what the program half asks, with the options it parsed itself
I1f  reader-eval.mjs  revert: MARKER_MISSING is never printed
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure says MARKER_MISSING when the file does not carry the marker the run must have written
m6  results.ts  revert: a non-true accepted is copied through
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: a non-boolean accepted is never copied into the results file: a strict boolean is written
m7  reader-eval.mjs  revert: the case-name column is 48 wide
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the per-case lines of a not-secure summary pads the case name to the longest name in the table, so every column lines up
m7b  reader-eval.mjs  revert: the line pads to the literal 48 again
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the per-case lines of a not-secure summary pads the case name to the longest name in the table, so every column lines up
E1  config.ts  env variable without the flag: toolbar is NOT made the variant (read but ignored)
    KILLED by 16 test(s)
      - scripts/reader-eval.notSecure.test.ts :: what the bundle is told is accepted by the bundle's own reading of it, end to end
      - scripts/reader-eval.notSecure.test.ts :: revealing is never implied by the variant, on the terminal side is read by the bundle as a run that does not reveal, end to end
      - scripts/reader-eval.notSecure.test.ts :: the variable present in the bundle's environment although nobody typed the flag makes an ordinary toolbar run the marked variant: no reveal, never accepted, on both sides
      - ... and 13 more
E2  config.ts  env variable without the flag: other modes are not refused
    KILLED by 8 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the variable present in the bundle's environment although nobody typed the flag refuses a accuracy run outright
      - scripts/reader-eval.notSecure.test.ts :: the variable present in the bundle's environment although nobody typed the flag refuses a observe run outright
      - scripts/reader-eval.notSecure.test.ts :: the variable present in the bundle's environment although nobody typed the flag refuses a all run outright
      - ... and 5 more
X01  reader-eval.mjs  loosen typedNotSecure: only the literal true counts
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure fails closed on what was typed: anything but false or nothing counts as typed
X02  reader-eval.mjs  loosen typedNotSecure: any truthy value
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure fails closed on what was typed: anything but false or nothing counts as typed
X03  reader-eval.mjs  loosen typedNotSecure: never typed
    KILLED by 3 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure never prints ACCEPTED or exits 0, whatever the file says
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure says MARKER_MISSING when the file does not carry the marker the run must have written
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure fails closed on what was typed: anything but false or nothing counts as typed
X04  reader-eval.mjs  loosen isNotSecure: top marker anything but true is ordinary
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
X05  reader-eval.mjs  loosen isNotSecure: an absent summary code is ordinary (== null)
    KILLED by 3 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a file with no summary at all, and is false for what is not a file
X06  reader-eval.mjs  loosen isNotSecure: either half clean is enough (|| for &&)
    KILLED by 18 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the printed summary of a not-secure run never prints ACCEPTED or exits 0 for a marked file, whatever the file claims
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - ... and 15 more
X07  reader-eval.mjs  loosen isNotSecure: fail-closed only for a file that carries a schema
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
X08  reader-eval.mjs  loosen isNotSecure: a falsy top marker is ordinary
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
X09  reader-eval.mjs  loosen isNotSecure: a falsy summary code is ordinary
    KILLED by 6 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses exploratory = false
      - ... and 3 more
X10  reader-eval.mjs  loosen the ACCEPTED line: the file's markers are not asked
    KILLED by 17 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the printed summary of a not-secure run never prints ACCEPTED or exits 0 for a marked file, whatever the file claims
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - ... and 14 more
X11  reader-eval.mjs  loosen the ACCEPTED line: a truthy accepted is enough
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed never lets a non-boolean accepted through either
X12  reader-eval.mjs  loosen exitCodeFor: the typed lock sits before the no-results answers (1 becomes 2)
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure leaves a run that produced no results a harness failure, exit 1
X13  reader-eval.mjs  loosen exitCodeFor: the file's markers are not asked
    KILLED by 17 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the printed summary of a not-secure run never prints ACCEPTED or exits 0 for a marked file, whatever the file claims
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - ... and 14 more
X14  reader-eval.mjs  loosen MARKER_MISSING: silent whenever the file is marked in ANY way (not only by the literal true)
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure says MARKER_MISSING when the file does not carry the marker the run must have written
X15  reader-eval.mjs  loosen MARKER_MISSING: printed for ordinary runs too
    KILLED by 2 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure says MARKER_MISSING when the file does not carry the marker the run must have written
      - scripts/reader-eval.test.ts :: the printed summary says nothing about missing groups when none are
X16  reader-eval.mjs  loosen the EXPLORATORY RUN line: not printed for what the terminal typed
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure never prints ACCEPTED or exits 0, whatever the file says
X17  reader-eval.mjs  loosen MARKER_MISSING: a truthy marker is good enough
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure says MARKER_MISSING when the file does not carry the marker the run must have written
X18  results.ts  loosen the writer: a truthy accepted is written true
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: a non-boolean accepted is never copied into the results file: a strict boolean is written
X19  reader-eval.mjs  loosen the column: one wider than the longest name
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the per-case lines of a not-secure summary pads the case name to the longest name in the table, so every column lines up
X20  reader-eval.mjs  loosen runEval: a second, option-less exit code beside the pinned one
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure is what the program half asks, with the options it parsed itself
X21  reader-eval.mjs  loosen runEval: the options handed over are a copy with the flag off
    KILLED by 1 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the terminal's own lock: it typed --not-secure is what the program half asks, with the options it parsed itself
X22  main.ts  loosen main.ts: the verdict is told false through a renamed binding
    KILLED by 3 test(s)
      - src/readerEval/helper.test.ts :: the entry point's diagnostics wiring hands the expectation to the summary, which is what an observe run is judged against
      - src/readerEval/notSecure.test.ts :: the entry point's wiring of the variant hands it to the run, records it, and judges the run by it
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
X23  main.ts  loosen main.ts: the results marker is a literal false
    KILLED by 2 test(s)
      - src/readerEval/notSecure.test.ts :: the entry point's wiring of the variant hands it to the run, records it, and judges the run by it
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
X24  main.ts  loosen main.ts: settings shadowed instead of the name (configured re-read)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
X25  main.ts  loosen main.ts: the writer is handed over whenever the variant is on (review N3)
    KILLED by 3 test(s)
      - src/readerEval/helper.test.ts :: the entry point's diagnostics wiring hands the reveal writer to the run only when the validated setting says so
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed spells notSecure exactly four times: bound once, used three times
      - src/readerEval/notSecure.test.ts :: the entry point's wiring cannot be shadowed hands the run the validated reveal setting and nothing derived from the variant
X26  results.ts  loosen the rewritten writer lock: the top marker is not asked (dev L27 on the new line)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: what the results file says about the variant never writes accepted: true beside either marker, whatever it was handed
X27  results.ts  loosen the rewritten writer lock: the summary code is not asked (dev L26 on the new line)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: what the results file says about the variant never writes accepted: true beside either marker, whatever it was handed
X28  results.ts  loosen the rewritten writer lock: either marker clean is enough (review Q2 on the new line)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: what the results file says about the variant never writes accepted: true beside either marker, whatever it was handed
Q3  results.ts  review Q3 on the new line: === null (fail-closed, harmless; review said no action)
    KILLED by 1 test(s)
      - src/readerEval/notSecure.test.ts :: a non-boolean accepted reads an absent summary code as no code, not as a marker
X29  reader-eval.mjs  loosen isNotSecure: only the top-level marker is asked (dev L46 on the new body)
    KILLED by 12 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the printed summary of a not-secure run never prints ACCEPTED or exits 0 for a marked file, whatever the file claims
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - ... and 9 more
X30  reader-eval.mjs  loosen isNotSecure: only the summary code is asked (dev L47 on the new body)
    KILLED by 10 test(s)
      - scripts/reader-eval.notSecure.test.ts :: the printed summary of a not-secure run never prints ACCEPTED or exits 0 for a marked file, whatever the file claims
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed refuses a schema-6 accepted file whose markers are absent, a string or a number
      - scripts/reader-eval.notSecure.test.ts :: the file's markers are read fail-closed does so for a file that carries no schema as well, which this terminal also reads
      - ... and 7 more
TOTAL 56 killed 56 survived 0
```
