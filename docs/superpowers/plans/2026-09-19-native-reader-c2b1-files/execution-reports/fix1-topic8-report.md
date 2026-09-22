# Fix round 1 — topic 8 (`reader:eval` harness)

Files owned: `app/src/readerEval/**`, `app/scripts/reader-eval.mjs`, `app/scripts/reader-eval.test.ts`.
Tests run, only ever: `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` (+ `typecheck`).
The harness was NEVER run: no `reader:eval`, no `scripts/reader-eval.mjs` as a program, no
`dist/reader-eval.cjs`, no bundle launched, no `read`/`frontWindow` sent to a built helper, nothing
printed that came off a screen. No git. No subagents.

Baseline before any change: **15 files, 398 tests, all pass**; `typecheck` clean.
After: **17 files, 489 tests, all pass**; `typecheck` clean.

---

## Important 1 — raw control bytes in `score.ts` and `stage.ts`

**Changed.** All four spots rebuilt so the SOURCE is pure printable text. Every edit was made by a
python script that writes the backslash with `chr(92)`; nothing was typed through a file-writing tool
on a line holding an escape.

| what | before (on disk) | after |
|---|---|---|
| `score.ts` whitespace class | `/[\p{White_Space}<U+001C>-<U+001F>]+/gu` with literal bytes | `score.ts:48` `const WHITESPACE_RUN = new RegExp("[\\p{White_Space}\\u001C-\\u001F]+", "gu");` |
| `score.ts` confusion key separator (x2) | literal U+0000 in the template literal and in `split()` | `score.ts:148` `const CONFUSION_KEY_SEPARATOR = String.fromCharCode(0);`, used at `:202` and `:215` |
| `stage.ts` staged-title guard | `/['<U+0000>-<U+001F>]/` with literal bytes | `stage.ts:134` `const TITLE_UNSAFE = new RegExp("['\\u0000-\\u001F]");`, used at `:165` |

Each carries a doc comment saying WHY it is spelled rather than typed, pointing at `bytes.test.ts`.

**Proof on disk** (all four commands re-run after the last edit of the round):

```
files scanned: 38   offending bytes: 0     # src/readerEval/**, scripts/reader-eval.*, reader-eval/truth/**
                                           # allowed: \n everywhere, \t in source (no file uses one), nothing else, no 0x7f
$ file app/src/readerEval/score.ts app/src/readerEval/stage.ts
  …/score.ts: Java source, Unicode text, UTF-8 text
  …/stage.ts: Java source, Unicode text, UTF-8 text         # was `data` for both
$ grep -c "export" app/src/readerEval/score.ts app/src/readerEval/stage.ts
  …/stage.ts:15   …/score.ts:9                              # was silent, rc 1
$ grep -rln "export" app/src/readerEval | grep -E "score.ts|stage.ts"
  …/score.ts   …/stage.ts                                   # the folder sweep reaches both again
```

**Permanent guard**: new `app/src/readerEval/bytes.test.ts` (style of `imports.test.ts`). It walks
every file under `src/readerEval`, every `scripts/reader-eval.*` and every `reader-eval/truth/*`, and
scans BYTES: source may hold only 0x09/0x0A below 0x20 and no 0x7F; truth may hold only 0x0A. Plus one
test pinning that `score.ts` and `stage.ts` still SPELL their classes (`\u001C-\u001F`, `\u0000-\u001F`
— the needle is built from `String.fromCharCode(92)` so the test file itself holds no backslash).
38 tests in that file.

**Revert proof (planting)**: on backup-restored copies I planted `0x1f` into `score.ts` (inside a
comment) and into `reader-eval/truth/chat.txt`:

```
× …/score.ts holds no control byte but tab and newline   → ['0x1f at byte 3101'] vs []
× …/truth/chat.txt holds no control byte but newline     → ['0x1f at byte 5'] vs []
Tests  2 failed | 36 passed (38)
```

then `cp` back and `cmp` → both byte-identical, 38/38 pass.

**Differential against the phase-0 `score.py`** (reviewer's 25 inputs, rebuilt independently as
`scratchpad/exec/fix1-topic8/diff/driver.ts` bundled with the repo's own esbuild, compared by
`compare2.py`; floats compared to 1e-12 rather than `round(…,10)` so no rounding artefact can hide a
difference):

- immediately after Important 1, before any Minor: **`cases: 25 differing: 3`** — exactly
  `bom-lead`, `bom-trail`, `kelvin-marker`, i.e. the reviewer's own 22/25. The rewrite changed no
  behaviour.
- after Minors 1 and 2 (both deliberate): **`cases: 25 differing: 0`**.

## Important 2 — an unrecognised/missing `CLAVE_EVAL_MODE`, and `accepted: true` for a run that measured nothing

**Changed, in three places.**

1. **New `app/src/readerEval/config.ts`** — `readEvalSettings(env, newNonce)`, pure and unit-tested,
   holding every setting `main.ts` used to cast at module level. It validates the mode the way the two
   neighbouring numeric variables were already validated (`counted` moved here too):
   - mode: must be one of `EVAL_MODES` (a value, so the cast cannot be written again). Unrecognised
     **or absent** → `{ok: false, code: "BAD_MODE"}`.
   - variant: unrecognised → `{ok: false, code: "BAD_VARIANT"}` (it is written into the results file
     verbatim as `chromeVariant`, which is the reviewer's second half of this finding); **absent** →
     `"none"`, the fresh default profile phase 0's numbers were measured on. The difference between
     "absent mode is refused" and "absent variant defaults" is documented in the file comment.
   - nonce: `||`, not `??` — Minor 4, below.
2. **`main.ts:130-137`** (settings read at `:55`) refuses before anything is staged — before the page server, before the
   helper, before the protocol and grant checks — writing
   `{"error":"HARNESS","code":"BAD_MODE"|"BAD_VARIANT"}` through the existing `serialiseError` path
   and returning. `exitCodeFor` (`reader-eval.mjs:178`) already gives **1** for any `error` string;
   pinned by a new test. `formatSummary` now prints the code beside the catch-all error
   (`READER_EVAL_FAILED HARNESS BAD_MODE`) — `HARNESS` alone does not tell the owner the CALL was
   wrong. The existing `NO_GRANT` line is unchanged (code == error → printed once).
3. **`summarise` now takes the mode** (`summary.ts:191-219`) instead of an `observeRan` flag, and
   `EvalSummary` gains `missingGroups` (`results.ts:176`, serialised at `results.ts:273`):
   - an accuracy run (`accuracy`/`all`) owes a verdict for every one of **`ALL_GROUPS`** — now used,
     which closes **Minor 5**; the ones it did not produce are listed by name and make `accepted`
     false.
   - `summariseToolbar(cases, ran)` mirrors `summariseObserve(cases, ran)`: `null` only when the run
     had no toolbar mode; a toolbar run with zero captures is now a FAILING verdict
     (`captures: 0, passed: false`), not the absence of one.
   - so in every one of the four modes, a run that measured nothing is a shortfall. The old
     `summarise([], [], [], false).accepted === true` is gone.
   `formatSummary` prints `SHORT  groups    MISSING: …` for `missingGroups`.

**Revert proofs** (each mutation applied to a backup-restored file, tests run, restored, `cmp` clean):

| mutation | failing tests |
|---|---|
| `config.ts`: `const mode = (env.CLAVE_EVAL_MODE ?? "accuracy") as EvalMode` (the original cast) | 5 — `refuses a mode it does not have`, `…differing only in case`, `…an empty mode`, `…with the CLI's own spacing`, `…that is not set at all` |
| `summary.ts`: drop `missingGroups.length === 0 &&` from `accepted` | 2 — `refuses a accuracy run that measured nothing`, `names the accuracy groups the run should have covered and did not` |
| `summary.ts`: `summariseToolbar` returns `null` for an empty run again | 3 — `fails a toolbar run in which nothing was captured`, `refuses a toolbar run that measured nothing`, `gives a toolbar run with no capture a failing verdict rather than none at all` |

New tests: `config.test.ts` (24), `summary.test.ts` accepted block rewritten (53 in the file),
`reader-eval.test.ts` +4 (`BAD_MODE`/`BAD_VARIANT` printing and exit 1, missing-group line, and that
nothing is printed when none are missing).

## Minor 1 — `.trim()` vs Python `.strip()` on U+FEFF

**Changed to match `score.py` exactly.** `norm` (`score.ts:54-69`) ends with
`.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "")` (`score.ts:51-52`, two `^ ` / ` $`
regexes). After the collapse every whitespace run is already one U+0020, so this removes precisely
what `str.strip()` would have. The comment at `score.ts:38-46` no longer claims the opposite; it now
says why `trim` is not used, and the U+FEFF sentence points forward to `norm`.
Tests: `keeps a zero-width no-break space at either end, because score.py's strip does` (lead, trail
and medial) and `still trims the whitespace the original did trim, at both ends and however much of
it` (U+0085, U+001E, NBSP, U+3000, all-spaces).
**Revert proof**: put `.trim()` back → `× keeps a zero-width no-break space at either end…`
(1 failed | 21 passed); restored, `cmp` clean.
Differential: `bom-lead` and `bom-trail` now agree with `score.py` (0.9980732177 / 0.9961464355).

## Minor 2 — `between()` and the Kelvin-sign fold

**Matched Python** (the `u` flag), not documented-as-kept. Reason: this function's only purpose is
comparability with the phase-0 numbers — the file comment says so — and `score.py` scored that read.
Keeping the strict direction would leave a case where a rerun measures something the findings did not,
which is the same class of problem as Minor 1 (and pointing in the opposite direction is no defence:
"stricter" here means a silently `noMarkers`/incomplete case, i.e. a measurement lost, not a risk
avoided). `score.ts:93` `const MARKED = new RegExp("STARTMARKER([\\s\\S]*)ENDMARKER", "iu");`, with
a comment saying exactly this; the flag set now matches `WHITESPACE_RUN`.
Test: `finds the markers through a Unicode case fold, exactly as re.I does` (U+212A, plus the
all-lower-case pair).
**Revert proof**: `"iu"` → `"i"` → `× finds the markers through a Unicode case fold…` (1 failed |
21 passed); restored, `cmp` clean. Differential: `kelvin-marker` now agrees → 25/25.

## Minor 3 — `PAGE_SCRIPT` disagreed with `acceptStagedTitle`

**Changed.** `pages.ts:37-50`: the script now interpolates the prefix from `STAGED_TITLE_PREFIX`
(`const p=${JSON.stringify(STAGED_TITLE_PREFIX)};`) and applies the same two-part rule
`t.startsWith(p)&&t.length>p.length`, so it cannot drift from `isStagedTitle` in either the literal or
the rule. Comment rewritten to say what actually happened rather than that it could not.
Test: a new `titleAsStaged(raw)` helper in `pages.test.ts` that renders the real page through
`acceptStagedTitle` and then RUNS the served `<script>` (`new Function`) against a fake `document` and
`location` built from the same query — the bare prefix, an embedded prefix, a real window's name, an
empty string and `null` all end at `Clave reader evaluation`; a real staged title is adopted.
**Revert proof**: drop `&&t.length>p.length` → `× falls back to the fixed name for the bare prefix
with nothing after it, through the script as well as the server` (1 failed | 21 passed). Under the OLD
script this test also failed, which is how it was watched fail before the fix. Restored, `cmp` clean.

## Minor 4 — an empty `CLAVE_EVAL_NONCE` was taken

**Changed.** `config.ts:68`: `env.CLAVE_EVAL_NONCE || newNonce()` (`||`, with a comment on why an
empty nonce is no nonce — `isStagedTitle` accepts `CLAVE-EVAL <case> `, so two concurrent runs could
accept each other's windows). `main.ts` passes `() => randomBytes(6).toString("hex")`, so the
generator stays where the entropy belongs and the rule is testable.
Tests: nonce taken when given / generated when empty / generated when unset.
**Revert proof**: `||` → `??` → `× is generated when the variable is empty` (1 failed | 23 passed);
restored, `cmp` clean.

## Minor 5 — `ALL_GROUPS` was dead code

**Changed.** Wired into `summarise` as `missingGroups` (see Important 2). Its doc comment now
describes what it does. Pinned by `expects a verdict for every group the thresholds name`
(`["chat","ticket","terminal","pt","code"]`) and by the mutation table above.

## Minor 6 — the sentinel test did not cover the `observe` serialisation path

**Changed.** `results.test.ts` now drives a real `runObserve` over one `ObserveCase` (Safari, private,
`depsAnsweringWithSentinels(name, SAFARI)`) and puts the resulting row into the serialised results, so
the one line in the serialiser that spreads anything (`results.ts:261`) is exercised by the privacy
test. The run is asserted to have happened (`observe[0].outcome === "ok"`, `observe[0].app === "Safari"`)
so the test cannot pass vacuously.
**Revert proof**, in two parts, which is what makes it a proof of THIS gap:
- mutation (the reviewer's (d), aimed at observe): `toolbarFacts` also returns `toolbarText` **and**
  `results.ts` spreads the observe entry → `× carries not one string the helper sent` (1 failed |
  4 passed).
- the same mutation with the sentinel run put back to `observe: []` as it was before this fix →
  **5 passed**. The leak was invisible; it is not now.
Both restored, `cmp` clean on `run.ts`, `results.ts`, `results.test.ts`.

## Minor 7 — `dist/reader-eval.cjs` built unconditionally

**Not fixed, deliberately.** Two reasons, and neither is "it is hard": (a) it lives in
`app/scripts/build.mjs`, which is not in my file set, and the rules say to report a need to touch a
file outside the set rather than do it; (b) the reviewer classifies it as a flag for the packaging
step, not a defect now — the entry is inert without `CLAVE_DEV_ENTRY=reader-eval`, which only the dev
launcher honours (D9), and `imports.test.ts` proves nothing in the app reaches it. **Carry it to the
packaging task**: a packaged app must not ship an entry that opens Chrome, writes an executable
`.command` and runs `pkill`.

---

## Other things worth recording

- `summarise`'s signature changed (`summarise(mode, accuracy, toolbar, observe)`) and
  `summariseToolbar` gained `ran`. Both are internal to `src/readerEval`; `imports.test.ts` proves no
  product module can reach them, and nothing under `scripts/` imports them.
- `EvalSummary` gained `missingGroups`, which the results file now carries. `schema` was left at `1`:
  the field is additive and every existing field keeps its meaning, so an old reader is not misled —
  flagged here in case the plan's owner wants a bump anyway.
- `main.ts` lost its module-level `mode`/`nonce`/`variant`/`repetitions`/`seconds` and its private
  `counted`; `writeObserveUrls` now takes the nonce as an argument. `main.ts` is still the one file
  with no unit test (it imports `electron` and runs on import) — which is why the validation was moved
  out of it rather than tested in place.
- `pages.test.ts` uses `new Function` to run the served script. It is the served string, not a copy.
- Temporary artefacts, all outside the repo:
  `scratchpad/exec/fix1-topic8/` (backups used for the revert proofs) and
  `scratchpad/exec/fix1-topic8/diff/` (`driver.ts`, `driver.mjs`, `ts.json`, `compare2.py`).
  `compare2.py` imports the reviewer's extracted `score.py` from `scratchpad/exec/rev-8/diff/`.
