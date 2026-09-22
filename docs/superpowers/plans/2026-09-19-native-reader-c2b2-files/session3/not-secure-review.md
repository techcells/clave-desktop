# toolbar --not-secure: independent review (2026-09-21)

VERDICT: APPROVED WITH CHANGES

OK TO RUN WITH THE OWNER: yes -- for the documented first run
`toolbar --not-secure --limit 4 --reveal-toolbar` (and any other `--limit` run). Fix Important 1
before anybody makes an UNLIMITED `toolbar --not-secure` run. Rebuild the bundle first: a stale
`dist/reader-eval.cjs` refuses `--reveal-toolbar` in toolbar (exit 1) or writes a schema-5 file
(loud "OLD RESULTS FILE", exit 2) -- both safe, both useless.

No Critical finding. What may be READ is unchanged; the resolver rule cannot be injected; no
privacy property of the reveal path is weaker in the new combination. The two Important findings
are (1) the three "never accepted" locks all hang from ONE boolean in main.ts while the terminal,
which typed the flag itself, never uses what it knows, and (2) "a --not-secure run does not reveal
unless --reveal-toolbar was typed" is pinned by no test at any of four layers.

How I worked: private copy `<scratch>/rv/app` (rsync with the required excludes; node_modules,
eval, docs symlinked), vitest and tsc called directly with node v24.19.0, no pnpm, no git, nothing
launched, the app-support folder never opened. Every mutation: exact one-occurrence replace by
script, restore from a pristine snapshot, sha256 verified; at the end `diff -rq` of the copy
against both the snapshot and the repo was empty. Nothing in the repo was modified except this
file. Process slip, for the record: one read-only shell loop of mine used `$(cd <dir> && ls)`
inside a command substitution, against the "never cd" rule; it changed nothing (it only produced
nvm noise) and the check was redone with `diff -rq`.

## 1. What may be read; ordinary runs

Identity (reproduced):
- All 13 installed files match the sha256 list in the developer's report exactly.
- Nothing else under app/ is newer than the pre-change folder (find -newer: only the 13 files).
- guard.ts, thresholds.ts, score.ts, server.ts, helper.ts, cases.ts, pages.ts, stagedTitle.ts:
  absent from pre-not-secure/, mtimes all before the developer's copy time, and byte-identical
  (sha256) to THREE earlier independent scratch snapshots (fix4, rr3, recheck4). This is stronger
  than the developer's own repo-vs-copy comparison, which could not show the repo was unchanged.
- The guard is the same file, called the same way: the toolbar reveal sits after a read the guard
  approved (`outcome: "ok"` branch only); killed mutants R3/O2 show the page body and lines below
  the band still cannot reach the writer.

Probes (vitest, on the copy):
- `chromeStageCommand` pre (from pre-not-secure/) vs post, over all 40 toolbar cases x
  normal/incognito x notSecure absent/false: JSON of the whole command identical, 160/160. Every
  non-function export of stage.ts identical; the only new exports are the two constants.
- `summarise("toolbar", 40 perfect rows)` pre vs post: identical apart from the added
  `exploratory: null`.
- Observe reveal rows: every OBSERVE case name printed by pre and post `formatRevealRow` is
  identical (0 differ over the whole OBSERVE_CASES table) -- no observe case name contains a dot,
  while all 40 toolbar names do.

EVERY behavioural difference for an ordinary (non --not-secure) run:
1. Results schema 5 -> 6, `notSecure: false`, `summary.exploratory: null` (developer named it).
2. REVEAL row labels keep dots (developer named it). SAFE: the label goes through
   `revealCaseName` = fixedCode grammar plus ".", max 64. Probe: ESC, newline, space, "_", "/",
   ":", U+202E, U+FF0E, 65 chars, non-strings all print "?"; all 78 case names in the tables pass.
   On the bundle side the label is `theCase.name` from the table, never recognised text (mutant
   R2, staged title as label, is killed). A forged file could at most print a dotted token such
   as "evil.example.com" -- inert on a terminal. For observe runs the change is invisible.
3. NOT named by the developer: the last line now needs `summary.accepted === true`; before, any
   truthy value printed "READER_EVAL ACCEPTED" (exit code was already 2 for those). Probe:
   accepted "yes" / 1 -> pre ACCEPTED, post SHORTFALL. Stricter; safe.
4. NOT named: if `CLAVE_EVAL_NOT_SECURE` is present in the BUNDLE's environment without the flag
   (only possible via launchd, `open` does not pass the shell's environment), an ordinary
   `toolbar` run becomes the variant (marked, never accepted, no reveal) and every other mode is
   refused `NOT_SECURE_NOT_APPLICABLE`; a bad value refuses every mode. Fail-safe.
5. `--host` applicability is checked one statement later (same outcomes; probe: every
   combination gives the same refusal as before or the new code).
6. USAGE text; `reveal`/`writeReveal` moved from ObserveDeps to RunDeps (type-only);
   `runToolbarCase` allocates an empty Map per call (never touched).
Verdict logic, staging order, argv, server binds: identical.

## 2. The resolver rule

Probes, all as expected:
- argv: only `notSecure === true` adds it; 1, "1", "true", [true], {}, new Boolean(true),
  false, undefined add nothing. Exactly one element, the constant
  `--host-resolver-rules=MAP clave-eval.test 127.0.0.1`.
- env bridge: "true", "1 ", " 1", "01", "1\n", "1,1", "on", "TRUE", "1"+NUL, fullwidth 1,
  ["1"], boolean true -> BAD_NOT_SECURE. Modes accuracy/observe/all/coldstart ->
  NOT_SECURE_NOT_APPLICABLE. Beside CLAVE_EVAL_HOST: BAD_HOST for clave-eval.test and "",
  NOT_SECURE_NOT_APPLICABLE for valid loopback hosts.
- `parseObserveHost("clave-eval.test")` and upper case -> null; `observe --host clave-eval.test`
  refused on both sides. (`clave-eval.test.localhost` is accepted, correctly: it is a localhost
  name and gets no rule.)
- CLI: `--not-secure evil.example`, `--not-secure=evil.example`, an injected `--position` string,
  `--not-secure` with no mode -> all refused. `evalEnv` with crafted notSecure values ("true", 1,
  "1", [true], {}, "clave-eval.test") sets nothing; the env never contains a host or the rule;
  `openArgs` contains neither "resolver" nor "clave-eval".
- Prototype keys: `evalEnv`/`watchPlanFor` DO read an inherited `notSecure`/`reveal`, and
  `readEvalSettings` reads an inherited env key. Not reachable: `parseEvalArgs` builds an
  own-property literal and `process.env` has no such prototype. No action.
- Network: the rule is applied before DNS, the name is a fixed non-personal constant in `.test`.

## 3. Never accepted

Bundle side (probe): `summarise` with the marker over 5 modes x limited/not, perfect rows:
accepted 0 of 10. `serialiseResults`: accepted:true beside either marker is written false.
Terminal side (probe, `formatSummary` + `exitCodeFor`):

    file                                            exit  ACCEPTED printed
    NS true, accepted true                           2     no
    NS false, exploratory set, accepted true         2     no
    NS true, exploratory null                        2     no
    exploratory unknown reason / false / 0           2     no
    NS true + limited                                2     no
    schema 5, NS true                                2     no
    no schema, NS true                               2     no
    notSecure = "true" (string), accepted true       0     YES   <- Important 1
    notSecure = 1, accepted true                     0     YES   <- Important 1
    both markers absent, schema 6, accepted true     0     YES   <- Important 1
    schema 5, no markers, accepted true              2     yes (text only; "OLD RESULTS FILE" printed; pre-existing)

## Findings

### Important 1 -- the three locks have one root; the terminal ignores what it typed

`summarise`, `serialiseResults` and `exitCodeFor`/`formatSummary` all decide from markers that
come from the single destructured `notSecure` in main.ts, which no test can execute. `runEval`
holds `options.notSecure === true` in its own process and never uses it for the verdict.

Reproducing probes:
- Terminal table above: a schema-6 file with no markers (or a non-boolean marker) and
  accepted:true prints READER_EVAL ACCEPTED and exits 0.
- Two-site mutant of main.ts (`{ const notSecure = false;` before `const results: EvalResults = {`
  and `}` after the `writeAtomic(outFile, serialiseResults(results));` line): every source pin
  still matches, harness suite 1393/1393 green, `tsc --noEmit` exit 0. At run time the pages are
  staged under clave-eval.test with the rule, the file says `notSecure:false, exploratory:null`,
  and a full run whose counts pass is printed ACCEPTED, exit 0.
Why it does not block the first run: `--limit 4` fails acceptance through `limited`, a different
variable. An unlimited run has only the one root.

Suggested change (terminal only, independent of the bundle):
- `runEval`: if `options.notSecure === true`, never print ACCEPTED and return 2 whatever the file
  says; if the file's `notSecure !== true`, also print a fixed line such as
  `READER_EVAL_FAILED MARKER_MISSING`.
- `isNotSecure`: for a schema-6 file treat anything but `notSecure === false` AND
  `exploratory === null` as marked (fail closed).
Pinning tests: `exitCodeFor(file, {notSecure:true})` is 2 and the summary has no ACCEPTED for an
unmarked accepted file; the three YES rows of the table above become exit 2.

### Important 2 -- "no reveal unless asked" in a --not-secure run is pinned nowhere

The code is correct today (probe: `toolbar --not-secure` parses to reveal:false, env has no
CLAVE_EVAL_REVEAL_TOOLBAR, settings.reveal false). But four independent loosenings survive:
- T8 CLI: `--not-secure` also sets `options.reveal = true`. Run-time effect: strips are printed
  on the terminal although nobody typed `--reveal-toolbar` (the REVEALING banner would show).
- T9 CLI: `evalEnv` also sets CLAVE_EVAL_REVEAL_TOOLBAR. Effect: bundle builds gate and writer;
  the terminal does not watch, so there is no heartbeat and the gate writes nothing (that part
  IS pinned: O4, O5 killed).
- C7 config: `settings.reveal = reveal || notSecure`. Same effect as T9.
- N5 main.ts: `reveal: reveal || notSecure` handed to the run. No effect alone (writer absent).
The content class is the owner-approved one, so this is a test gap, not a leak -- but it is
exactly the "guard stated in a comment, pinned by no test" pattern.
Pinning tests: `parseEvalArgs(["toolbar","--not-secure"]).reveal === false`; the exact key set
of `evalEnv` for that command line; `readEvalSettings({MODE:"toolbar", NOT_SECURE:"1"})
.settings.reveal === false`; a source pin on `        reveal,` + newline +
`        writeReveal: reveal ?` in main.ts.

### Minor

m1. S3 survives: the rule can ride twice on an INCOGNITO launch; "exactly once, whole argv" is
    asserted only for a normal window. Test: whole-array equality for incognito + notSecure.
m2. R1 survives: `const notSecure = Boolean(deps.notSecure)` in `runToolbarCase`. The literal-true
    rule is pinned in `chromeStageCommand` and `toolbarHostOf` but not on the line that feeds
    both. Test: `runToolbarCase` with `notSecure: "yes"` stages the ordinary URL and argv.
m3. C2 survives: `mayReveal("toolbar", null, <non-boolean>)`. Equivalent under the types. Test:
    add `"1" as never` and `undefined as never` rows to the truth table.
m4. T1, T2 survive: `isNotSecure` loosened to objects only, or to toolbar mode only. Test: files
    with `exploratory: false`, `0`, `"x"`, and `notSecure:true` with mode "all" -> exit 2.
    (Folded into the Important 1 change.)
m5. T13 survives: "host found" counts any truthy `host`. Test: a row with `host: "yes"` is not
    counted.
m6. `serialiseResults` still copies a non-true `accepted` through. Probe: `accepted =
    "SENTINEL-WINDOW-TITLE"` appears in the file (notSecure, exploratory, exploratory.reason,
    extra keys under exploratory, limited.reason do NOT leak). Pre-existing, but this change
    rewrote the line: write `accepted: results.summary.accepted === true && <lock>` and add
    `accepted` to the sentinel test.
m7. Cosmetic: the per-case line pads the name to 48, the longest toolbar name is 49.
m8. Q3 survives (`=== null` in the writer lock): fail-closed, behaviourally harmless; no action.
m9. The developer's "what changed for ordinary runs" list omits differences 3 and 4 of section 1.

## 4. The reveal path in the new combination

Refusals reproduced on BOTH sides (CLI parse and bundle settings): reveal refused for plain
toolbar, `toolbar --limit 4`, `toolbar --repetitions`, accuracy, all, coldstart, and for
accuracy/all/coldstart/observe beside `--not-secure`; allowed only for observe without --expect
and toolbar with --not-secure (with or without --limit).
Loosened one at a time (K = killed, S = survived):
- three-condition gate in runToolbarCase: dev L17-L20 K; mine R5 (|| for &&) K; R4 (observe's
  own lock after the move to RunDeps) K by the ORIGINAL run.test.ts.
- never in results: R7 (strip copied into the row) K. Page body as strip: R3 K. Band cut: O2 K.
  Character filter: O3 K (25 tests). File 0600: O1 K. Heartbeat asked: O4 K; missing heartbeat
  counts as fresh: O5 K. gate.end(): N2 K. Writer/gate only when asked: N3, N4 K. 0700 folder:
  N6 (bundle), T6 (terminal) K. Signal handlers T4, orphan sweep T5, withRevealCleanup T7, final
  sweep T18: K. Unquoted strip T15 K; print not gated on the flag T16 K; forced print T3 K.
- Survivors on this path: only the "reveal implied by the variant" family (Important 2).
The watch: `watchPlanFor` is null for every ordinary toolbar run and unchanged
(`{reveal, urls:true}`) for observe/all (probe table; T14 K; dev L45 K). `urls !== false` keeps
the URL wait for every caller that does not say false. `runEval` has the one call, source-pinned.
Ctrl-C in the new combination: the terminal clears all three names plus the heartbeat; the
bundle, still running under `open -W`, finds no heartbeat at its next reveal and stops -- same
shape as observe, already reviewed.

## 5. Results privacy

Schema 6 adds a boolean rebuilt with `=== true` and a literal `{reason:"NOT_SECURE"}`. The host
name and the rule are not written (Q4, which writes the name, is killed by the walk-every-string
test). Smuggling probe: see m6 -- the only string that gets through is via `accepted`.

## 6. Tests quality

The 102 new tests are meaningful: whole-argv equality, real temp folder with real modes, the
full mayReveal truth table, end-to-end CLI -> env -> settings. Weak spots are the ones listed.
My mutations: 54 single-site + 1 two-site = 55; 42 killed, 13 survived.

    id    file             mutation                                              class
    S3    stage.ts         rule duplicated on incognito launches                 test gap, harmless (m1)
    C2    config.ts        mayReveal toolbar: notSecure !== false                equivalent under types (m3)
    C7    config.ts        settings.reveal = reveal || notSecure                 TEST GAP (Important 2)
    R1    run.ts           Boolean(deps.notSecure)                               test gap, unreachable today (m2)
    Q3    results.ts       writer lock uses === null                             fail-closed, harmless (m8)
    N1    main.ts          one-site shadow block                                 NO-OP (my mutant was equivalent)
    N1b   main.ts          two-site shadow: results+verdict see false            REAL (Important 1); tsc also green
    N5    main.ts          run told reveal || notSecure                          test gap, no effect alone (Important 2)
    T1    reader-eval.mjs  isNotSecure: objects only                             test gap (m4)
    T2    reader-eval.mjs  isNotSecure: marker only in toolbar mode              test gap (m4)
    T8    reader-eval.mjs  --not-secure implies --reveal-toolbar                 TEST GAP, visible effect (Important 2)
    T9    reader-eval.mjs  evalEnv also sets the reveal variable                 test gap, gated by heartbeat (Important 2)
    T13   reader-eval.mjs  host found counts truthy                              test gap (m5)

main.ts wiring is source-pinned only. What a wrong wiring does at run time:
- variant not handed to `runMode`: an ordinary limited toolbar run on *.localhost; the third
  reveal lock refuses, so the owner sees NO REVEAL lines and no "Not secure" -- obvious at once;
  the file would wrongly say notSecure:true (never accepted). Safe.
- marker/verdict not told (N1b): invisible on a `--limit` run (LIMITED -> SHORTFALL anyway),
  ACCEPTED on an unlimited one -> Important 1.
- What is READ never depends on this wiring: the guard is untouched.
So the first real run (`--limit 4 --reveal-toolbar`) reveals a wiring error safely.

I agree with the developer's open risks 1-8; the infobar (risk 2) would show Chrome's own text in
the revealed band, which is not a privacy matter.

## 7. Gates (on the copy, equal to the installed repo)

- Whole suite: 2932 tests (2931 passed, 1 skipped), 90 files, exit 0.
- Harness only (src/readerEval + scripts): 1393 passed, 22 files.
- tsc --noEmit -p tsconfig.json: exit 0. tsc --noEmit -p tsconfig.renderer.json: exit 0.
