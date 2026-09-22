# toolbar --not-secure: fix round 1, independent re-check (2026-09-21)

VERDICT: ALL ADDRESSED

OK TO RUN WITH THE OWNER: yes (limited run) / yes (unlimited run)

No Critical, no Important finding. Important 1 and Important 2 are closed; every Minor asked for
is pinned. Four new MINOR test gaps (section 5); none of them can, alone, produce ACCEPTED / exit 0
for a --not-secure run or print a strip nobody asked for. `app/dist/reader-eval.cjs` (19:23) is
newer than results.ts (19:17) and carries this round's writer line (checked read-only); if the
installed dev bundle is built separately, rebuild it before the run.

How I worked: private copy `<scratch>/rc1/app` (rsync with the required excludes; node_modules,
eval, docs symlinked), `<scratch>/rc1/pristine` as the restore snapshot. vitest and tsc called
directly with node v24.19.0. No git, no cd, no pnpm, nothing launched, no superpowers skill.
Mutations by exact one-occurrence replace via `rc1/mutate.mjs` (each site must occur exactly
once), file restored from the snapshot and sha256-verified by the runner (it throws otherwise).
At the end `diff -rq pristine app` is empty and the copy's six relevant files are sha-equal to the
repo. The probes (a vitest file plus the pre-round terminal and writer as siblings) were placed in
the copy only for the probe run and moved out to `rc1/probes/` before any mutation or gate.
Nothing in the repo was modified except this file.

## 1. The diff; ordinary runs

Identity: the five installed files have exactly the sha256 values in the developer's report;
`find -newer` under app/src and app/scripts shows only those five.

Full diff vs `pre-not-secure-fix1/`:
- reader-eval.mjs: `CASE_NAME_WIDTH`, `typedNotSecure`, `MARKER_MISSING_LINE`, the rewritten
  `isNotSecure`, the second parameter of `formatSummary` / `exitCodeFor`, the two call sites in
  `runEval`. Nothing else. (`MARKER_MISSING_LINE` is a const declared below the function that uses
  it; it is only read at call time, so there is no TDZ problem - the suite executes that path.)
- results.ts: the one `accepted` expression and its comment.
- reader-eval.test.ts: the two fixtures gained `notSecure: false` / `exploratory: null`. No
  assertion touched.
- The two not-secure suites: additions only; the only removed lines are an import list and the two
  cast signatures (now with the optional second parameter).
Nothing beyond the stated fixes.

Probe "ordinary runs" (pre-round terminal and writer imported beside the new ones): for all 5
modes x limited / not, results built by the real `summarise` with notSecure false:
- `serialiseResults` post vs pre: byte-identical, 10/10.
- written file: `notSecure === false`, `summary.exploratory === null`, `isNotSecure` false, 10/10.
- `formatSummary(file, parseEvalArgs([mode]))`, `formatSummary(file)` vs pre `formatSummary(file)`:
  identical text, 10/10 each. `exitCodeFor` likewise identical.
- honest accepted runs stay accepted: toolbar unlimited -> accepted true, exit 0,
  READER_EVAL ACCEPTED; coldstart -> the same.
So no verdict, exit code or printed line changes for any results file the current bundle writes.

The new ordinary-run difference (a file lacking either marker is SHORTFALL): NOT reachable for a
file the bundle writes. main.ts has exactly ONE results writer, `writeAtomic(outFile,
serialiseResults(results))`; `serialiseResults` builds both fields itself on every call -
`notSecure: results.notSecure === true` and `exploratory: ... == null ? null : {reason}` - so both
are always present and never `undefined` (JSON.stringify cannot drop them). coldstart and observe
go through the same writer (probe rows above). Every other exit of main.ts (bad settings, display
refusal, page server refusal, PROTOCOL, NO_GRANT, the catch-all) writes `serialiseError`, which the
terminal answers before it looks at markers (`typeof results.error === "string"` -> exit 1, as
before). The observe progress / URL / reveal files are schema 1 and never go to `exitCodeFor`.
Pre-existing and unchanged: a schema-5 file from a stale bundle -> exit 2.

`accepted` as a strict boolean cannot turn an honest true into false: `summarise` computes
`accepted` as an && chain whose every operand is a comparison or a boolean `passed`
(`full`, `reason === null`, `readyMs !== null && ...`, `groups.every(...)`), so an honest pass is
the literal `true`, and `true === true && <unmarked>` is `true` (probe: toolbar and coldstart
above; dev test "writes true/false for the booleans").

## 2. Important 1 - CLOSED

Attack table (probe; base = the file the real writer produces for a perfect unlimited ordinary
toolbar run, accepted true, i.e. exactly what N1b would write). 20 file shapes x 4 callers.

Terminal TYPED `--not-secure` (with and without `--reveal-toolbar`): exit 2 and no
READER_EVAL ACCEPTED for ALL 20 shapes: clean ordinary file, marked, half-marked either way,
notSecure "true" / "false" / 0 / null / absent, exploratory absent / 0, both absent, schema
absent (clean and unmarked), schema 5 (clean and unmarked), schema 7, schema "6", markers hidden
under `__proto__` keys. MARKER_MISSING is printed exactly when `notSecure !== true`.

Terminal did NOT type it (parsed `toolbar`, and no options at all):

    file                                   exit  ACCEPTED printed
    marked / half-marked (either way)       2     no
    notSecure "true" "false" 0 null absent  2     no
    exploratory absent / 0; both absent     2     no
    schema absent, no markers               2     no
    __proto__ markers                       2     no
    schema 5 / 7 / "6", clean markers       2     yes (text only, beside OLD RESULTS FILE; pre-existing)
    schema absent, clean markers            0     yes (correct: untyped + a clean file IS an ordinary run)
    clean schema-6 file                     0     yes (correct: the ordinary run)

I found no way to get ACCEPTED / exit 0 for a not-secure run. The only combination left is
"terminal did not type the flag AND the file is clean", which needs the variable injected into
the bundle's environment through launchd AND a main.ts wiring fault at the same time; the first
alone is pinned fail-safe (dev tests, mutants E1 / E2).

`typedNotSecure` shapes: undefined, null, {}, {notSecure:false}, [], "x", 1 -> false;
{notSecure:true | "1" | 0 | null} and an INHERITED notSecure -> true. Fail-closed as claimed.

N1 and N1b re-applied to main.ts with the first reviewer's exact text: both KILLED (by "spells
notSecure exactly four times"); tsc stays green for both, as before, so the pin is what kills.

The "name occurs exactly 4 times" pin: brittle, effective against every accidental shadow,
NOT effective against a shadow that avoids spelling the name. Four such mutants, all SURVIVE the
harness suite (three also pass tsc):

    SH1  before the write: results["notS"+"ecure"] = false; results.summary = summarise(..., null)
         -> file is exactly N1b's (false / null / accepted true).           tsc 0
    SH2  computed key `["notS"+"ecure"]: false` inside the results literal.  tsc 0
    SH3  `exploratoryOf` aliased away on import, a local one returns null.   tsc 0
    SH4  the settings object switched off through string keys before the destructuring. tsc 1

Run-time outcome of each, shown by the attack table:
- SH1: terminal typed -> EXPLORATORY RUN, READER_EVAL_FAILED MARKER_MISSING, SHORTFALL, exit 2
  (row "ordinary accepted (N1b output)", typed).
- SH2: file says notSecure false beside exploratory set -> the writer already wrote accepted
  false; the terminal: half-marked AND typed -> exit 2, MARKER_MISSING.
- SH3: marker true, verdict ordinary -> writer lock writes accepted false; terminal exit 2.
- SH4: the run is then not the variant at all (an honest ordinary run); typed -> exit 2 anyway.
These need deliberate obfuscation, which no source pin can stop (the developer says so); what
matters is that lock 3(a) is behavioural and independent of main.ts, and it holds. Accepted.

## 3. Important 2 - CLOSED

Re-applied with the first reviewer's exact text: T8 KILLED (3 tests), T9 KILLED (2), C7 KILLED
(3), N5 KILLED (2). Additional G1 (`watchPlanFor` watches a `toolbar --not-secure` run although
`--reveal-toolbar` was not typed): KILLED (2).
Remaining ways for a strip to print without `--reveal-toolbar`: none found. On the terminal a
strip is printed only by `watchObserve` under a plan with `reveal: true`; for toolbar that plan
needs `options.reveal === true`, which only the typed flag sets (T8, G1 killed; T16 / T3 killed in
the first review, file regions unchanged). On the bundle side config.ts, run.ts, main.ts and
observe.ts are byte-identical to the reviewed versions (R5, N3, N4, O4, O5 killed there), and C7 /
N5 are now pinned.

## 4. Minors

    S3   incognito whole-argv            re-applied: KILLED (2)
    R1   Boolean(deps.notSecure)         re-applied: KILLED (6)
    C2   mayReveal notSecure !== false   re-applied: KILLED (6)
    T1   objects only (adapted)          KILLED (7)
    T2   toolbar mode only (adapted)     KILLED (6)
    T13  truthy host counted             re-applied: KILLED (1)
    m6   non-true accepted copied        revert: KILLED (1); strict boolean, see section 1
    m7   name column 48                  revert: KILLED (1); width compared with the table
    m8 / Q3 pinned although not asked; m9: differences 3 and 4 now listed and pinned, plus the
    three new ones of this round (section 3 of the dev report) - the list is complete as far as I
    can find; one cosmetic addition in finding M4 below.

## 5. Fresh mutations and survivors

35 mutants in all: 15 re-applied review mutants (all killed, above), 4 name-free shadows
(section 2), 16 fresh mutants of this round's new code: 11 killed, 5 survived.

Killed: F1 (typed: null counts as ordinary), F2 (typed only in toolbar mode), F3 (typed exit
lock also needs a marked file), F4 (ACCEPTED line: typed counts only beside a true marker),
F5 (MARKER_MISSING only for a literal false), F6 (no summary = ordinary), F7 (EXPLORATORY line
needs both), F10 (writer copies a non-boolean through for ordinary files), F12 (the fixed line's
text), F13 (MARKER_MISSING after the verdict line), F16 (runEval hands exitCodeFor a copy with
the flag off unless revealing).

Survivors:

    id   file             mutation                                               class
    F8   reader-eval.mjs  per-case host lines only for notSecure === true        test gap, harmless (M4)
    F9   results.ts       writer lock `notSecure === false`                      stricter, equivalent under the types
    F11  reader-eval.mjs  runEval: `options = {...options, notSecure:false}`     TEST GAP (M1)
                          on the line before the pinned formatSummary call
    F14  reader-eval.mjs  exitCodeFor: typed lock skipped for a schema-less file TEST GAP (M2)
    F15  reader-eval.mjs  formatSummary: typed counts only if file mode=toolbar  TEST GAP (M3)
    SH1-SH4 main.ts       name-free shadows                                      source-pin limit; safe at run time (section 2)

### Minor findings (none blocks a run)

M1 (F11). The pin on runEval fixes the two call LINES, not that `options` is still what was
    parsed: reassigning the parameter just above them survives. Alone it is harmless (the bundle
    still marks the file, lock 3(b) answers exit 2); it matters only together with a second,
    independent fault in main.ts. Test: in the same source pin assert the program half contains
    no `options =` and no `notSecure: false` outside `parseEvalArgs`' initial literal (count 1).
M2 (F14). "Typed -> exit 2 whatever the file says" is not asserted for a schema-less file with
    clean markers and accepted true; under F14 that file exits 0 (the text still says SHORTFALL).
    The bundle always writes a schema, so unreachable today. Test: add
    `exitCodeFor({...cleanAccepted, schema: undefined}, typed) === 2` to "never prints ACCEPTED or
    exits 0, whatever the file says".
M3 (F15). The same test uses only `mode: "toolbar"` files, so tying the typed lock of
    `formatSummary` to the file's mode survives (exit code unaffected: 2). Test: one row with
    `mode: "all"` and `mode` absent, typed -> no ACCEPTED.
M4 (F8). Because `isNotSecure` is now fail-closed, a toolbar file with unreadable markers also
    prints the per-case "host found" lines. Only numbers, booleans, fixed codes and case names
    through `revealCaseName`; harmless and arguably useful, but it is an unlisted behavioural
    difference and is unpinned either way. No action needed; mention it in the dev report's list.

## 6. Gates (on the copy, sha-equal to the installed repo)

- Whole suite: 2990 tests (2989 passed, 1 skipped), 90 files, exit 0.
- Harness only (src/readerEval + scripts): 1451 passed, 22 files.
- tsc --noEmit -p tsconfig.json: exit 0. tsc --noEmit -p tsconfig.renderer.json: exit 0.
All equal to the developer's figures.
