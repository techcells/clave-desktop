# Task 8 review — `reader:eval` (staged-window evaluation harness)

Reviewer: independent, N = 8. Plan `docs/superpowers/plans/2026-09-19-native-reader-c2b1-code.md`,
"#### Task 8". Work done in `scratchpad/exec/rev-8/app` only; that copy was verified byte-identical
to `/Users/sardorastanov/techcells/asset-to-evidence/app` for all 37 topic-8 files before and after.

**The harness was never run.** No `reader:eval`, no `scripts/reader-eval.mjs`, no
`dist/reader-eval.cjs`, no bundle launched, no `read` or `frontWindow` sent to a built helper, no
window title or recognised text printed. Everything below is from reading, from the topic's fakes,
and from a differential run of the phase-0 `score.py` against `score.ts` on synthetic strings.

Baseline in the copy: `src/readerEval` + `scripts/reader-eval` → **15 files, 398 tests, all pass**.
Whole suite → **84 files, 1429 passed / 1 skipped**. `tsc --noEmit` clean for both configs.

---

## 1. Answers to the task's questions

**Is there ANY way to obtain an `Approval` outside `guard.ts`?**
No. `guard.ts:33` mints the brand `const APPROVED = Symbol(...)` and does not export it, and
`Approval` (`guard.ts:35-39`) is keyed on it, so no other module can write the key. `approve`
(`guard.ts:58-64`) is the only constructor and `awaitStagedWindow` (`guard.ts:80-90`) the only other
producer. `grep -a "as Approval|as unknown as Approval|APPROVED"` over `src/readerEval/` outside
`guard.ts` → **no hits**: there is no cast anywhere.

**Any call that writes a `read` line without one?**
No. `grep -arn 'op: *"read"'` over `src/readerEval/` (non-test) returns exactly one line:
`helper.ts:54` inside `encodeRead`, which is called only from `readApproved` (`helper.ts:140-143`),
whose first parameter is `Approval` (`helper.ts:45`). All four call sites take a guard-minted
approval: `run.ts:239` and `run.ts:383` from `awaitStagedWindow`, `run.ts:435` from `approve`, and
`run.ts:270` (`cacheProbe`) reusing the approval of the read immediately before it.

**Does every `read` carry `expect` equal to the approved window?**
Yes, and it carries nothing more. `readApproved` sends `approval.window` verbatim; that object is
built by `frontWindowOf` (`run.ts:276-286`), which copies `app`, `title` and, only when it is a
string, `bandleId`-…`bundleId` — three fields, by hand, never a spread. My probe v fed the fake
helper a `frontWindow` answer carrying `secret` and `ownerPid` alongside the three: the read line's
`expect` came back with exactly `["app","bundleId","title"]` and neither extra key appeared anywhere
on the wire. Dev mutation (c) (drop `expect`) fails 5 tests.

**Is the nonce random per run and required in the title?**
Random: `scripts/reader-eval.mjs:224` `randomBytes(6).toString("hex")` per invocation;
`main.ts:46` falls back to the same if the variable is absent. Required: `stagedTitleFor`
(`stagedTitle.ts:17-19`) always appends it and `approve` demands the whole staged title as a
substring, so a bare prefix, a truncated nonce or another run's nonce are all refused — pinned by my
probe i and by dev mutation (a) (5 failing tests). **Caveat, Minor 4 below:** `main.ts:46` uses `??`,
so an *empty* `CLAVE_EVAL_NONCE` is taken rather than replaced.

**Can results ever contain `text`, `toolbarText`, a line's text or a foreign title — by type AND by
the sentinel test?**
By type: no. Every field of `AccuracyCaseResult`, `ToolbarCaseResult`, `ObserveCaseResult`,
`GroupVerdict`, `ToolbarVerdict` and `ObserveVerdict` (`results.ts:57-166`) is `number|null`,
`boolean|null`, a closed-union outcome code, or a name this harness invented (`case`, `group`,
`mode`, `app` — all from `cases.ts`). The only string derived from a capture is a `Confusion`'s
`from`/`to`, one code point each, computed only for a case already below its threshold — which is
exactly what D10 permits.
By construction: `serialiseResults` (`results.ts:223-292`) writes all 40-odd fields by hand and
never spreads an input; dev mutation (d) (make `toolbarFacts` return `toolbarText` *and* spread the
case in `results.ts`) fails the sentinel test.
By the sentinel test: `results.test.ts:78-100` drives a real accuracy case and a real toolbar case
through a helper whose page body, toolbar strip, line box, window title and app name are all
sentinels, and asserts none of them, nor `SENTINEL`, nor `4111111111111111`, nor `Inbox`, is in the
file. **Gap, Minor 6:** the sentinel run passes `observe: []`, so the `observe` serialisation path
(`results.ts:254`) is not covered. I wrote that probe (iv) and it passes today.

**Does teardown match only the eval's own `--user-data-dir`?**
Yes. `chromeTeardownPattern` (`stage.ts:73-75`) is `[-]-user-data-dir=` plus the profile path with
every ERE metacharacter escaped (`escapeEre`, `stage.ts:61-63`); the profile path is
`join(outDir, "chrome-profile")` where `outDir = dirname(CLAVE_EVAL_OUT)` (`main.ts:44`, `:151`), so
it is always inside `app/reader-eval/out/`. It is the whole flag, not the bare path, and the leading
`[-]` keeps `pkill`'s own argv from matching. Dev mutation (i) (pattern → `"Google Chrome"`) fails 4
tests, including `escapes regex metacharacters in the path, so a dot is a dot`. `pkill` is only ever
invoked with this pattern (`chromeTeardownCommand`, `stage.ts:77-79`; call sites `run.ts:188`,
`run.ts:395`).

**Does `main.ts` refuse to continue without protocol 2 and without `granted`, and never call
`requestPermission`?**
Yes, in that order and before anything is staged: `main.ts:134-138` (`ready.body.protocol !==
READER_PROTOCOL`, and `constants.ts:15` is `= 2`) and `main.ts:139-143`
(`permission.body.permission !== "granted"`); each writes `{"error":…,"code":…}` and returns.
`requestPermission` appears nowhere in `src/readerEval` except the comment at `main.ts:18`.

**Are the thresholds exactly the spec's (section 6, P4 and P5)?**
Yes, verbatim.

| spec §6 | spec text | `thresholds.ts` |
|---|---|---|
| P4 | 97% chat | `chat: 0.97` (:23) |
| P4 | 97% tickets | `ticket: 0.97` (:24) |
| P4 | 95% terminal | `terminal: 0.95` (:25) |
| P4 | 95% Portuguese **with accents kept** | `pt: 0.95` (:26) + `PT_ACCENTS_MIN = 1` (:38) |
| P4 | 90% code | `code: 0.9` (:27) |
| P5 | host in ≥ 19 of 20 | `hostHitsMin: 19`, `TOOLBAR_CAPTURES_PER_MODE: 20` (:43, :54) |
| P5 | "Incognito"/"Private" in 20 of 20 | `privateHitsMin: 20` (:45) |

`falsePrivateMax: 0` (:50) is not from §6 — it is from the phase-0 findings' P5 "Counts", and the
file says so. Dev mutation (f) (chat 0.97 → 0.96) fails 4 tests including
`accuracy thresholds are exactly spec section 6's P4 row`.

**Does a repetition that ended `notStaged`, `noMarkers`, `windowGone`, `black`, `timeout`, `failed`,
`locked` or `down` make its case incomplete and never a pass?**
Yes — all eight are in `INCOMPLETE_OUTCOMES` (`results.ts:43-44`, pinned as the exact sorted list by
`results.test.ts:140-145`); `isIncomplete` (`summary.ts:48-50`) uses it, `scored`
(`summary.ts:52-53`) admits only `outcome === "ok"` with a non-null accuracy, and
`summariseGroups.passed` (`summary.ts:98`) requires `incompleteCases.length === 0` *and*
`min !== null`. Dev mutation (e) (drop `notStaged`) fails 3 tests. `summariseToolbar` (`:116-132`)
does the same and additionally demands the full 20 captures per mode.

**Does production code import nothing from `src/readerEval`?**
Yes, and the test bites. `imports.test.ts:38-48` walks every non-test `.ts`/`.tsx` under `src/`
outside the folder and refuses any specifier matching `/readerEval/`. My probe: I prepended
`import {CHROME} from "../readerEval/cases";` to `src/main/engine.ts` in my copy →
`src/main/engine.ts imports nothing from readerEval` **FAILED**; restored, byte-identical. The
reverse direction is also held (`imports.test.ts:70-93`): allow-list of five product modules, no test
double, no `console.`, and `electron` only in `main.ts`.

---

## 2. Mutation table — every one of the developer's 16 re-run

Method: exact-string mutation in my copy, `vitest run src/readerEval scripts/reader-eval`, restore,
byte-compare against the real repo. Driver: `scratchpad/exec/rev-8/mutate.py`.

| # | Mutation | Failing tests | Dev claimed | Verdict |
|---|---|---|---|---|
| a | `guard.ts`: accept any title containing `CLAVE-EVAL` | 5 (`refuses another run's nonce`, `refuses another case of the same run`, `refuses the bare prefix`, + 2 `writes no read line …`) | 5 | **BITES** |
| b | `guard.ts`: drop the app check | 8 (five `refuses <app> …`, `keeps polling …`, + 2) | 8 | **BITES** |
| c | `helper.ts`: `read` without `expect` | 5 (incl. `never sends a read without expect`) | 5 | **BITES** |
| d | `run.ts` returns `toolbarText` + `results.ts` spreads | 1 (`carries not one string the helper sent`) | 1 | **BITES** |
| e | drop `notStaged` from `INCOMPLETE_OUTCOMES` | 3 | 3 | **BITES** |
| f | `thresholds.ts`: chat 0.97 → 0.96 | 4 | 4 | **BITES** |
| g | group verdict on the median | 1 (`is the MINIMUM over its cases, not the median`) | 1 | **BITES** |
| h | `.marker` opacity → `.6` | 1 | 1 | **BITES** |
| i | teardown pattern → `"Google Chrome"` | 4 | 4 | **BITES** |
| j | a page adopts any title asked of it | 5 | 5 | **BITES** |
| k | `server.ts` answers any path | 7 | 1 claimed | **BITES** (more than claimed) |
| l | `privateMissed` uses `=== false` | 1 | 1 | **BITES** |
| m | `privateMissed` never counted | 3 | 3 | **BITES** |
| n | `falsePrivate` never counted | 2 | 2 | **BITES** |
| o | an observe run that read nothing passes | 2 | 2 | **BITES** |
| p | the observe verdict does not reach `accepted` | 3 | 3 | **BITES** |

**No mutation failed to bite.** All 16 restores compared byte-identical to the real repo. Every
failing-test *name* the dev report lists was reproduced; (k) fails 7 rather than the 1 claimed,
because the developer counted only the one row they named.

---

## 3. Independent probes (the developers never saw these)

Written as `src/readerEval/reviewer8.probe.test.ts` + `reviewer8.diff.test.ts` in my copy only; both
deleted afterwards and the copy re-verified byte-identical.

**(i) A front window whose title contains the staged title of a DIFFERENT case of the same run.**
PASSES. Driving `runAccuracyCase("chat-light-14")` with a fake whose `frontWindow` reports
`Google Chrome` / `CLAVE-EVAL ticket-dark-11 <this run's nonce> - Google Chrome`: **no `read` line
was written at all**, outcome `notStaged`, case `incomplete: true`.
I extended it into a sweep: empty title; `CLAVE-EVAL`; `CLAVE-EVAL ` (bare prefix); no nonce;
truncated nonce; another run's nonce; another case; the same title lower-cased; the same title with
NBSP for each space; one character short — **all ten refused**. And the prefix-collision pair
(`terminal` vs `terminal-narrow`) is refused in both directions, because the nonce sits at the end.
The one that must be accepted — `<staged title> - Google Chrome` — is.

**(ii) A string smuggled into `stats` by a fake helper.** PASSES, twice over. `statsOf`
(`run.ts:122-134`) coerces every non-number to `null` and `cacheHit` to `null` unless boolean;
driving a whole toolbar case whose `stats` carried `"SMUGGLED-CAPTURE-MS"`, `"SMUGGLED-HIT"`,
`"SMUGGLED-WIDTH"`, `"SMUGGLED-BAND"` and an extra `"SMUGGLED-EXTRA"` key, the serialised results
contain no occurrence of `SMUGGLED`.

**(iii) Median of an even count.** PASSES and matches decision 7.2: `medianOf([1,2,3,4]) === 2`,
`medianOf([0.9,0.8]) === 0.8`, `medianOf([0.5,0.5,0.9,1]) === 0.5`, `medianOf([]) === null` — always
the lower middle, always a value some read produced.

**(iv, mine) The observe path against sentinels.** PASSES — but nothing in the repo pins it. See
Minor 6.

**(v, mine) Extra keys on the front-window answer.** PASSES — see the `expect` answer above.

**(vi, mine) A run that measured nothing.** **FINDING.** `summarise([], [], [], false)` returns
`{groups: [], toolbar: null, observe: null, accepted: true}` and `exitCodeFor` gives 0. See
Important 2.

**(vii, mine) An observe row whose read failed.** PASSES: `outcome: "windowGone"` → `read: 0`,
`passed: false`, `accepted: false`. D17 holds.

**(viii, mine) Differential test of `score.ts` against the phase-0 `score.py`.** I extracted
`score.py` from `2026-09-18-native-reader-phase0-spikes.md` Task 1 Step 3 (its own `--selftest`
prints `SELFTEST OK`), ran both implementations over 25 inputs built from the three real truth files
— identical text, accents stripped, marker-wrapped, NBSP, U+0085, U+001C, U+001F, U+FEFF leading /
trailing / medial, U+200B, U+3000, U+180E, vertical tab, NFD, an astral character, a confusion
rewrite, empty OCR, empty truth, soft hyphen, a Kelvin-sign marker, lower-case markers, two
`ENDMARKER`s — and compared `norm` length and head/tail code points, `lev`, `accuracy`, `accents`,
`between().found`, body length and body accuracy.

**22 of 25 identical. 3 differ** — see Minor 1 and Minor 2. Notably the literal U+001C–U+001F range
in `WHITESPACE_RUN` *is* doing its job: `fs-001c` and `us-001f` agree exactly with Python, which
plain `\p{White_Space}` would not have.

**(ix, mine) Truth-file provenance, third independent extraction.** I re-extracted all five truth
files from the phase-0 plan with my own regex (a third algorithm, independent of the dev's two) and
hashed them: all five SHA-256 match both the dev report's table and the files on disk, and all five
are NFC.

---

## 4. Findings

### Important 1 — `score.ts` and `stage.ts` contain raw control bytes (including U+0000); plain `grep` cannot see either file

`app/src/readerEval/score.ts` line 43, 165, 178 and `app/src/readerEval/stage.ts` line 153 hold
*literal* control characters where the source reads as if it held escapes:

| file:line | what is on disk | what it means |
|---|---|---|
| `score.ts:43` | `/[\p{White_Space}<U+001C>-<U+001F>]+/gu` | correct: Python's `\s` minus U+FEFF |
| `score.ts:165`, `:178` | the confusion tally key separator is a literal `U+0000` | correct, and better than a space |
| `stage.ts:153` | `/['<U+0000>-<U+001F>]/` | correct: refuses a quote or a control character in a staged title |

All four are **behaviourally right** — my differential test proves the whitespace class folds
exactly as Python's does. The problem is what they do to the tooling this plan's verification rests
on:

```
$ file app/src/readerEval/score.ts app/src/readerEval/stage.ts
…/score.ts: data
…/stage.ts: data
$ grep -n "export function accuracy" app/src/readerEval/score.ts ; echo $?
1                       # no output: BSD grep treats the file as binary
$ grep -rn "export const OPEN" app/src/readerEval ; echo $?
1                       # the whole folder sweep silently skips both files
$ grep -an "export const OPEN" app/src/readerEval/stage.ts
26:export const OPEN = "/usr/bin/open";
```

Every plain `grep` over the tree — including the plan's own "The payload was grepped for personal
and scratch paths: none" (Verification record), Task 1's "confirm by grep", and any future privacy
sweep for `text` / `toolbarText` / a path — is **blind to the one file that builds the shell command
run on the owner's machine and the one file that scores the screen**. The Global Constraints'
"Characters" rule exists because this session's file-writing tools decode backslash-u escapes into
literal characters; this is that having happened, and it survived review only because it happened to
be semantics-preserving. A later formatter, editor round-trip or copy that drops one of those bytes
changes the regex silently and invisibly in a diff.

*Reproducing probe:* the three commands above (rc 1 with no output vs `grep -a` finding the line).
*Suggested fix:* build all four from escapes rather than literals, then re-run the differential
harness (`scratchpad/exec/rev-8/diff/compare.py`) to prove the numbers did not move:
`const WHITESPACE_RUN = new RegExp("[\\p{White_Space}\\u001C-\\u001F]+", "gu");`,
`const SEP = String.fromCharCode(0);` used for both the join and the `split`, and
`if (new RegExp("['\\u0000-\\u001F]").test(title))`. Then `file(1)` reports text again and the
folder greps work.

### Important 2 — an unrecognised `CLAVE_EVAL_MODE` runs nothing and reports `accepted: true`

`main.ts:45` `const mode = (process.env.CLAVE_EVAL_MODE ?? "accuracy") as EvalMode;` and
`main.ts:47` `const variant = (…) as ChromeVariant;` are **casts, not checks** — while the two
numeric variables three lines below *are* validated, under a comment that says exactly why ("An
environment variable is a string from outside", `main.ts:48-54`).

With any mode outside the four, all three `mode === …` tests at `main.ts:156-159` are false, so
`accuracy`, `toolbar` and `observe` are `[]` and `observeRan` is false. `summarise([], [], [], false)`
(`summary.ts:173-191`) then returns `groups: []`, `toolbar: null`, `observe: null` — and
`accepted: [].every(…) && true && true` = **`true`**. `exitCodeFor` (`reader-eval.mjs:168-172`)
gives **0**. A run that staged nothing, read nothing and measured nothing reports ACCEPTED.

That is precisely the failure mode the observe addendum was written to remove one level down ("an
observe run that quietly measured nothing was the failure mode this ruling removes", dev report
§addendum), left open at the top. `summary.ts:194` already exports `ALL_GROUPS` with the comment
"The groups a full accuracy run must produce a verdict for, so a missing one is visible" — and it is
**dead code**: `grep -rn ALL_GROUPS src scripts` finds only its own definition.

The unvalidated `variant` is also written verbatim into the results file's `chromeVariant`
(`results.ts:229`), so an arbitrary environment string reaches the record.

Not reachable through `pnpm --dir app reader:eval` — `parseEvalArgs` validates both
(`reader-eval.mjs:72`, `:79`). It is reachable by anyone launching the bundle with `open --env`,
which is how the harness is launched, and by any future caller.

*Reproducing probe (passes today, which is the finding):*
```ts
expect(summarise([], [], [], false).accepted).toBe(true);
```
*Suggested fix:* in `main.ts`, refuse an unknown mode or variant with the existing
`{"error":"HARNESS","code":"HARNESS"}` path; and make `summarise` refuse to report `accepted: true`
when it produced no verdict at all — put `ALL_GROUPS` to the use its comment already claims.

### Minor 1 — `norm()` diverges from `score.py` on U+FEFF at a string end, in the direction that raises accuracy, and the comment claims the opposite

`score.ts:47` ends with `.trim()`. JavaScript's `trim` strips U+FEFF; Python's `str.strip()` does
not. The comment at `score.ts:38-41` promises the opposite: "U+FEFF is deliberately left out, so a
zero-width no-break space counts as a character the recogniser invented, exactly as it did in the
numbers this harness is compared against."

Measured on `chat.txt` (519 normalised characters):

| input | `score.py` accuracy | `score.ts` accuracy |
|---|---|---|
| U+FEFF prepended to the body | 0.9980732177 | **1** |
| U+FEFF appended to the body | 0.9961464355 | **1** |

A medial U+FEFF agrees (both count it). So the divergence is ends-only and at most 2 edits out of
~520 — but it is in the one function whose whole purpose is comparability with the phase-0 numbers,
and it is more lenient than the original, which is the wrong direction for a threshold.

*Reproducing probe:* `expect(norm("﻿hello world")).toBe("﻿hello world")` — fails today
(`'hello world'` received). Full comparison: `scratchpad/exec/rev-8/diff/compare.py`.
*Suggested fix:* after the collapse every run is already a single U+0020, so replace `.trim()` with
`.replace(/^ /, "").replace(/ $/, "")`, and add the two probe rows above as tests.

### Minor 2 — `between()` is not case-insensitive the way `re.I` is

`score.ts:78` uses `/STARTMARKER([\s\S]*)ENDMARKER/i` — no `u` flag, so JavaScript's non-Unicode
canonicalisation excludes the non-ASCII→ASCII foldings that Python's `re.I` performs. Differential
case `kelvin-marker` (`STARTMAR` + U+212A + `ER body ENDMARKER`): `score.py` → `found: true`,
body accuracy 1.0; `score.ts` → `found: false`, body accuracy 0. U+212A is not in the helper's
homoglyph table either. Vanishingly unlikely from Vision, and it errs **strict** (the repetition
becomes `noMarkers`, the case incomplete, never a false pass) — recorded rather than urgent.
*Suggested fix:* add the `u` flag (`/…/iu`), which also brings the flag set in line with
`WHITESPACE_RUN`.

### Minor 3 — the staged-title rule is duplicated in `PAGE_SCRIPT` and disagrees with `acceptStagedTitle`, while the comment says it cannot

`pages.ts:42` — `if(t&&t.startsWith('CLAVE-EVAL '))document.title=t;` — checks only the prefix.
`acceptStagedTitle` (`pages.ts:68-70`) delegates to `isStagedTitle`, which *also* requires
`value.length > STAGED_TITLE_PREFIX.length` (`stagedTitle.ts:26`). For `?stagedTitle=CLAVE-EVAL%20`
the server renders the fallback name and the in-page script then overwrites it with the bare prefix.
The comment at `pages.ts:63-67` says the rule is "kept in one place so the two can never disagree" —
it is in two places and they do disagree. Also the literal `'CLAVE-EVAL '` is typed out rather than
built from `STAGED_TITLE_PREFIX`, so the two can drift further.

No privacy consequence: the guard requires the full `CLAVE-EVAL <case> <nonce>`, so a bare-prefix
title never authorises a read (my probe i covers it). Dev mutation (j) bites only
`acceptStagedTitle`; nothing pins the in-page script's rule.
*Suggested fix:* build `PAGE_SCRIPT` from `STAGED_TITLE_PREFIX` with the length check, and add a
test that the served page refuses the bare prefix *through the script*, not only through
`acceptStagedTitle`.

### Minor 4 — an empty `CLAVE_EVAL_NONCE` is taken, not replaced

`main.ts:46` uses `??`, which does not fall back on `""`. `CLAVE_EVAL_NONCE=""` yields staged titles
of the form `CLAVE-EVAL <case> ` (trailing space, no nonce) — which `isStagedTitle` accepts, so the
harness runs with no run-identity at all and two concurrent runs could read each other's windows.
Not reachable from the CLI (`reader-eval.mjs:224` always generates six random bytes).
*Suggested fix:* `process.env.CLAVE_EVAL_NONCE || randomBytes(6).toString("hex")`, or a length check.

### Minor 5 — `ALL_GROUPS` is dead code with a doc comment claiming a job it does not do

`summary.ts:194`. Nothing imports it; nothing makes a missing group visible. Either wire it into the
`accepted` rule (see Important 2) or delete it and its comment.

### Minor 6 — the sentinel test does not cover the `observe` serialisation path

`results.test.ts:83` passes `observe: []`, so `results.ts:254`
(`results.observe.map((entry) => ({...toolbarCase(entry), app: entry.app}))`) — the one line in the
serialiser that *does* use a spread — is never exercised by the privacy test. It is safe today
(`toolbarCase` writes by hand and `app` comes from the case table, which my probe iv confirms end to
end), but the assertion that protects it does not exist in the repo.
*Suggested fix:* add one observe row to the existing sentinel run.

### Minor 7 — `dist/reader-eval.cjs` is built unconditionally

`scripts/build.mjs` (the new sixth esbuild entry) emits the harness into every `dist/`, so a packaged
app would carry a program that opens Chrome, writes an executable `.command` and runs `pkill`. It is
inert without `CLAVE_DEV_ENTRY=reader-eval`, which only the dev launcher honours (D9), and
`imports.test.ts` guarantees nothing in the app reaches it. Flag for the packaging step, not a defect
now. (The destructuring `const [, , , , rendererResult]` still picks the renderer correctly, because
the new entry was appended at index 5 — checked.)

---

## 5. Other things I looked for and did **not** find

- **No path reads an unstaged window.** I tried: another case's staged title of the same run; a
  prefix-colliding case name; another run's nonce; the bare prefix; case-folded and NBSP variants;
  reusing the approval for the cache probe (`run.ts:270` — safe, because the second `read` still
  carries `expect`, so a changed screen answers `windowGone` having captured nothing); `runObserve`'s
  per-case loop (`run.ts:431-447` — `seen` prevents a second read and each match is filed under the
  case whose title it matched). No sequence produced a `read` line for a window this run did not
  stage.
- **Nothing screen-derived reaches a command line.** `reader-eval.mjs:230` spawns `/usr/bin/open`
  with a hard-coded `join(homedir(), "Applications", "Clave Agent Dev.app")` — no argument, no
  environment variable and no results field can change it. The seven `--env` values are: a fixed
  string, a validated mode, an out path built from the mode and the random nonce, the nonce, two
  validated integers and a validated variant. `spawn` without a shell, so no quoting hazard. Inside
  the bundle, `runCommand` (`main.ts:63-72`) runs only `EvalCommand`s built by `stage.ts`, whose
  arguments are the case table, the profile path, the loopback URL and the harness's own staged
  title; the Terminal `.command` gets the truth file through a quoted heredoc and a title that is
  rejected outright if it contains a quote or a control character.
- **Nothing is printed that came off a screen.** `imports.test.ts:84-86` forbids `console.` in every
  harness module; `main.ts` has none; `reader-eval.mjs` prints only allow-listed results fields, the
  observe URLs it invented, and fixed codes.
- **The truth files are the phase-0 texts**, verified by a third independent extraction (probe ix).
- **`escapeEre`** escapes `. [ ] { } ( ) * + ? ^ $ | \` — the full ERE set that can appear in a path;
  `-` needs no escape outside a bracket expression and `/` is not a metacharacter.
- **`counted()`** (`main.ts:49-52`) handles `""` (→ `Number("")` is 0, rejected by `>= 1`),
  `undefined`, fractions and non-numbers. Correct.
- **`statsOf` / `linesOf` / `bandPxOf`** (`run.ts:104-141`) all shape another process's JSON by hand
  and coerce every unexpected type to `null`/`[]`.
- **`pageOf`** (`server.ts:29-33`) is an exact `^/<name>.html$` allow-list; dev mutation (k) fails 7
  tests including `/../../etc/passwd is not`.

---

## 6. For the C-2b-2 first-run record

Nothing here has met a screen, which the dev report states plainly and correctly in its §6 (22
items). I have nothing to add to that list except: if Important 1 is fixed, re-run
`scratchpad/exec/rev-8/diff/compare.py` afterwards — it is the only thing that proves the four
control-character classes still behave like `score.py` once they are written as escapes.

---

## Verdict

**CHANGES REQUIRED** — two Important findings, both with small, local fixes; the privacy core itself
is sound and I could not break it.

Spec compliance: ✅
Quality: Not approved
