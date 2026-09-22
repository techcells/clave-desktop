# Review C — repair loop 2 of the `reader:eval` staged-window harness

Date 2026-09-21. Independent review (id C) of the developer's "Repair loop 2"
(`harness-repair-report.md` lines 349–491) against the diff `loop2.diff`, scoped to
`src/readerEval/**` and `scripts/reader-eval.*`. Baseline for every "unchanged" claim is
`$S/s1/rrB/app`; the reviewed tree is a private copy (`$S/s1/rvC/app`) verified byte-identical to
`$R/app` before and after every mutation. The harness was never run; no `.command` script was
executed — both were rendered to strings inside a temporary test and checked with `bash -n` only.
The temporary test and the rendered text have been deleted; the tree is clean.

**Baseline**: 754 tests in 17 files green, `tsc --noEmit` clean, `bytes.test.ts` 41/41 green,
`rvC` byte-identical to `$R/app` at the end of the review.

Files changed this loop, topic-scoped (`diff -rq` against `rrB`): `config.ts`, `results.ts`,
`run.ts`, `stage.ts`, `stagedTitle.ts`, `scripts/reader-eval.mjs`, plus six test files.
`thresholds.ts`, `score.ts`, `summary.ts`, `cases.ts`, `guard.ts`, `main.ts`, `pages.ts`,
`helper.ts`, `server.ts` are **byte-identical** to `rrB`.

---

## 1. `readySizeIn` and the two numbers in the results file

**Answer: nothing but `null` or an integer in [1, 1000] can reach the file, and the guard is
untouched by it.**

The parser is `stagedTitle.ts:138–151`, bounded by `boundedCount` (`stagedTitle.ts:160–168`). Four
independent gates: the substring is found by `readyMark(stagedTitle)` — this case's name and this
run's nonce (`:140–142`); it ends at the first `READY_SIZE_END` (`:144–145`); exactly one `x`
(`:146–147`); and each half must be 1–4 characters of ASCII 48–57 with the value inside
[`READY_SIZE_MIN`, `READY_SIZE_MAX`] (`stagedTitle.ts:161–167`). Both or neither (`:150`).

I attacked it with a table of 34 hostile tails plus a 4 000-title fuzz over an alphabet of digits,
`x`, `.`, signs, `e`/`E`, tab, Arabic-Indic U+0667/U+0662 and fullwidth U+FF10-FF17 (built from code
points, never typed), asserting on every result that each field is `null` or an integer in [1, 1000]
and that the two are null together. Everything below answered `{null, null}`:

| probe | why it fails |
|---|---|
| `99999x40.`, `99999999999999999999x40.` | `raw.length > 4` (`stagedTitle.ts:161`) |
| `-72x40.`, `+72x40.`, `72x-40.` | sign is not 48–57 (`:164`) |
| `72.5x40.`, `7.2x40.` | the sentinel cuts at the dot → one part, not two (`:144–147`) |
| `1e3x40.`, `1E3x40.`, `0x20x40.` | non-digit, and three `x` parts |
| ` 72x40.`, `72 x40.`, `72x40 .` | space is not a digit |
| `Infinityx40.`, `NaNx40.` | not digits |
| `1001x40.`, `72x1001.`, `0x40.`, `72x0.`, `0000x0000.` | outside [1, 1000] (`:167`) |
| `72x40x50.`, `72xx40.`, `x40.`, `72x.`, `.` | `parts.length !== 2` or an empty half |
| `72x40` (no sentinel) | `end < 0` (`:145`) |
| `٧٢x40.`, `７２x40.`, `72x４０.` | code points 1632+/65296+ are not 48–57 |

Accepted and correct: `1x1.`, `1000x1000.`; `1001x1000.` refused. Trailing text after the sentinel
is ignored (`72x40. — bash — 999x999.` → 72 × 40), which is exactly the Terminal-profile-suffix case
the sentinel was added for.

**Foreign and duplicate tokens.** A READY token of another case (`CLAVE-EVAL terminal …`) or another
nonce does not contain this case's `readyMark`, so it is invisible to the parser — proved in both
orders (foreign before the real one, and after it): the real one is still the value read. Two of our
own tokens: the first wins (`indexOf`, `:141`). A READY token in a **foreign app's** window never
reaches the parser at all, because `readySizeIn` is called only on `guarded.approval.window.title`
(`run.ts:478`) and `approve` compares the app exactly (`guard.ts:74`).

**The approval is independent of the numbers.** `guard.ts` is byte-identical to `rrB`; the only
title demand for a terminal is `readyMark` (`guard.ts:79`), which stops at the separator and knows
nothing about the size. I verified directly that a window whose tail is `80x24.`, `9999x9999.`,
`garbage` or empty is still **approved**, read and scored — a wrongly sized terminal is incomplete,
not unread, which is what the ruling asked for (`run.ts:494–499`, `stagedTitle.ts:84–86`). And every
probe of the earlier reviews is still refused: wrong app, wrong nonce, other case, `READYING`
(the separator, `stagedTitle.ts:52`), READY absent when required, `READY` with no separator, a null
window, and a foreign window carrying a READY token of its own.

**The write path.** `serialiseResults` writes field by field with no spread
(`results.ts:450–473`); `readyColumns`/`readyRows` are `number | null` by type (`results.ts:133–134`)
and are set from the parser or from `{columns: null, rows: null}` for a browser case
(`run.ts:477–479`). The existing sentinel run drives a terminal case whose title tail is a sentinel
and asserts the file holds neither `READY` nor `CLAVE-EVAL` nor any sentinel fragment
(`results.test.ts:142–162`) — a genuine end-to-end statement about this new path. My own end-to-end
probes through `runAccuracyCase` confirmed: hostile titles produce `{null, null}` with
`sizeAsStaged: false`, and no serialised repetition contains the nonce or the title grammar.

## 2. The `stty size` poll in the generated script

`stage.ts:421–437`. Both `.command` scripts (140 × 40 and 72 × 40) were rendered from the real
`terminalScript` in a temporary test and are **`bash -n` clean**; the rendered bytes contain only
LF, BEL (7) and ESC (27) — the two control characters built by `String.fromCharCode`
(`stage.ts:267–268`). A byte-scan of all 33 topic source files found **no control byte but TAB/LF**.

- **Bounded**: `while [ "$CLAVE_TRY" -lt 15 ]` with an unconditional `CLAVE_TRY=$((CLAVE_TRY + 1))`
  in the body (`stage.ts:425, 431`) — 15 × 0.2 s = 3 s worst case; no `while true`, no `until`, no
  recursion. Giving up prints anyway (`stage.ts:456`), so a stuck terminal costs 3 s, never a hang.
- **Nothing from the screen is executed.** The tty's answer is used in exactly three places: word
  splitting into positionals (`set -- $CLAVE_SIZE`), two `[ … = … ]` string comparisons, and a
  `printf` with the two variables **quoted** (`stage.ts:427–430, 456`). There is no `eval`, no
  command substitution of a variable, no `$(…)` built from screen data.
- **`/dev/tty` missing**: the redirect fails, the substitution yields the empty string, `set --`
  clears the positionals and both variables end empty; after 15 tries the `tput` fallback runs
  (`stage.ts:434–437`), and if that is empty too the title reads `READY x.`, which the parser turns
  into two `null`s. Fail-open into "unknown", never into a wrong number. One wart, see **Minor 1**.
- **The re-exec cannot loop**: the flag is compared exactly, `[ "$CLAVE_EVAL_CLEAN" != "1" ]`
  (`stage.ts:390`), and `env -i` sets it to `1`, so the second shell falls through; `--` now ends
  option parsing before `"$0"` (`stage.ts:392`). Both pinned (`stage.test.ts:381–386`).
- **Ordering**: the whole poll sits *before* `clear` and `ESC [ 3 J` (`stage.ts:443–444`), so
  anything the poll writes to the window is dropped from both the screen and the scrollback before
  `STARTMARKER`. Pinned by `stage.test.ts` ("finishes asking before it prints the page"). This is
  what makes Minor 1 cosmetic rather than a corruption of the capture.
- The diagnosis in the report is sound: `tput` inside `$(…)` has stdout on a pipe, `TIOCGWINSZ`
  fails and ncurses falls back to terminfo's 80 × 24; `stty` takes its ioctl from **stdin**, which
  is `/dev/tty` explicitly. `stty size` prints `rows cols` and the script assigns `CLAVE_ROWS=$1`,
  `CLAVE_COLS=$2` — the right way round, and the same way round as the `printf` and as
  `readySizeIn`'s `columns` × `rows`.

## 3. The automatic re-stage

`run.ts:453–465` (accuracy) and `run.ts:646–654` (toolbar). Verified by driving both paths with a
fake window server that withholds the staged window until after the first guard gives up:

- **Exactly one**, and only for Chrome: the re-stage is a single `if`, not a loop, so `attempts`
  can only become 2 (`run.ts:460–465`). Two failures produce one `notStaged` repetition, **zero**
  reads and exactly two `open`s.
- **Only on `notStaged`** (`run.ts:460`), and **never for a terminal**: `&& staging.chrome`; a
  terminal that fails is one attempt and one `open`. The reason given (this harness never kills
  Terminal, so the failed attempt's window would still carry the staged title and could be
  approved) is correct and is the right call.
- **Order**: teardown → wait-gone → placement → open. Observed as `run /usr/bin/open,
  run /usr/bin/pkill, pgrep false, preferences, run /usr/bin/open` — `prepareChrome`
  (`run.ts:287–295`) does `awaitChromeGone` before `writePreferences`, which is fix round 1's
  invariant, preserved for the second attempt too.
- **Never a second read of the same staging**: a successful re-stage yields exactly two reads —
  the scored one and the cache probe (`run.ts:467, 480`) — and the re-stage produces a *new*
  `Staging` from `stageAccuracy` (`run.ts:462`).
- **`stageAttempts` ∈ {1, 2}** everywhere I could drive it, including a 3-repetition run with an
  alternating window server. Observe rows carry `null` (`run.ts:728`).
- **A run cannot loop**: repetitions are a bounded `for`, attempts are a single `if`, the guard is
  bounded by its timeout and `awaitChromeGone` by `CHROME_EXIT_TRIES`.
- **The 30 s first-staging timeout** is `guardTimeoutFor` (`run.ts:412–415`): a caller's explicit
  timeout always wins; a terminal never gets it; with a counter it applies to the staging that
  incremented the counter to 1 and to no other. See **Minor 2** and **Minor 3** for the two edges.

## 4. `displayScale` / `scale` nulls, and `sizeAsStaged` for Chrome

- Terminal repetitions: `displayScale` null (`run.ts:433`) and `scale` null (`run.ts:438–439, 496`);
  `sizeAsStaged` is the cells comparison (`run.ts:497–498`). Confirmed end to end.
- Observe rows: `displayScale`, `scale`, `sizeAsStaged`, `chromeWaitMs`, `stageMs`, `stageAttempts`
  all null (`run.ts:726–732`), now pinned by a test that actually stages an observe case through the
  guard (`run.test.ts`, "says nothing about the display of a window the owner staged").
- Chrome: `capturedSize` is **byte-identical** to `rrB` (compared function body to function body) —
  `SIZE_TOLERANCE_PX` 4, the real `displayScale` deciding when known, the inferred scale kept as the
  cross-check (`stage.ts:201–245`). Toolbar rows still carry the staged display's scale, which is
  right: the harness placed those windows.

## 5. `--position` and negative coordinates

Both parsers were changed identically: `config.ts:106–117` and `scripts/reader-eval.mjs:88–104`, with
`POSITION_MIN_PT = -20_000` in both (`config.ts:94`, `reader-eval.mjs:47`) — I asserted the two
constants are equal by importing both. I then ran **35 shapes** through both parsers and compared
the answers as strings: `40,60`, `-40,60`, `40,-60`, `-40,-60`, `0,0`, `-0,0`, `-20000,-20000`,
`-20001,0`, `0,-20001`, `20000,20000`, `20001,0`, `""`, `-`, `-,-`, `+40,60`, `40,+60`, `3.2,4`,
`4,3.2`, `1e3,4`, `0x20,4`, ` 40,60`, `40 ,60`, `40, 60`, `1,2,3`, `40`, `40,`, `,60`, `--40,60`,
`40,--60`, fullwidth and Arabic-Indic digits, `Infinity,60`, `NaN,60`. **Every answer matched.**
Floats, `+40`, a lone `-`, a doubled `-` and three numbers all still refuse.

The value reaches both placements consistently: `--window-position=-2500,-40` in the command args
(`stage.ts:77`) and `left/top/right/bottom` = `-2500 / -40 / -1340 / 600` in the preferences
(`stage.ts:172–175`), from the same `positioned(…)` box.

**Worked by hand — a display at x < 0.** A 2560 × 1440 panel left of the primary, work area
`{x: -2560, y: 25, w: 2560, h: 1415}`, staged window 1160 × 640:

| corner | expected | `displayRefusal` |
|---|---|---|
| `-2500,60` | inside (right edge −1340 ≤ 0, bottom 700 ≤ 1440) | `null` |
| `-2561,60` | one point off the LEFT edge | `POSITION_OFF_DISPLAY` |
| `-1160,60` | right edge exactly 0 | `null` |
| `-1159,60` | one point off the RIGHT edge | `POSITION_OFF_DISPLAY` |
| `-2500,24` | one point above the work area (menu bar) | `POSITION_OFF_DISPLAY` |
| `-1160,800` | the far corner exactly | `null` |
| `-1160,801` | one point below | `POSITION_OFF_DISPLAY` |
| 800 × 600 work area, any corner | window larger than the display | `DISPLAY_TOO_SMALL` |

`fitsWorkArea`/`displayRefusal` (`cases.ts:101–156`) are byte-identical to `rrB` and sign-agnostic —
they compare origins and far edges, never magnitudes — so the negative arrangement needed no change
there, and the `DISPLAY_TOO_SMALL`-before-`POSITION_OFF_DISPLAY` order is preserved.

## 6. E2 — thresholds, scorer, acceptance

`thresholds.ts`, `score.ts`, `summary.ts` are **byte-identical** to `$S/s1/rrB` (`cmp`). The only
change touching them is in `summary.test.ts`, and it is the new field names appearing in the test's
row fixtures — no threshold, no scoring rule, no acceptance rule moved. `cases.ts` and `guard.ts`
are identical too.

## 7. The revert proofs, re-run

Twelve proofs re-run independently (my own mutations, not the developer's script): mutate in `rvC`
by exact string, run the whole harness folder, restore, `cmp` against `$R/app`. **All twelve bite;
every restore is byte-identical.** Counts differ from the report's because I ran the whole folder
(754) rather than the targeted file, and because my mutation for a given line is not always the
developer's.

| # | mutation | file | failures |
|---|---|---|---|
| L1 | `readyColumns` dropped from the serialiser | `results.ts` | 1 |
| L2 | the upper bound removed from the size parse | `stagedTitle.ts` | 2 |
| L3 | the size token read past its closing sentinel | `stagedTitle.ts` | 7 |
| L4 | a half-read token reported as a size | `stagedTitle.ts` | 9 |
| L5 | the shell asks `tput` down a pipe again | `stage.ts` | 2 |
| L6 | the poll loop removed (one ask, no waiting) | `stage.ts` | 2 |
| L7 | the accuracy re-stage removed | `run.ts` | 3 |
| L8 | `stageAttempts` always 1 (3 sites) | `run.ts` | 3 |
| L9 | the first staging gets the ordinary timeout | `run.ts` | 2 |
| L9b | the generosity given to every Chrome staging | `run.ts` | 1 |
| L10 | a terminal case re-staged too | `run.ts` | 1 |
| L11 | a terminal row claims the Chrome display's scale | `run.ts` | 1 |
| L12 | an observe row claims the staging display's scale | `run.ts` | 1 |

The two that "initially did not bite" (L9, L12) now bite, and for the right reason: `guardTimeoutFor`
is exported and asserted directly rather than through an absolute clock (`run.test.ts` imports
`FIRST_STAGE_GUARD_TIMEOUT_MS` and `guardTimeoutFor`), and an observe case is now actually staged
through the guard before its row is asserted. **No proof failed to bite.** I also checked the six
changed test files for weakened assertions: the only removals are the negative-coordinate rows of
the refusal tables (now legal), the `tput cols` needle in the script-order list (replaced by a
stricter one that pins `stty size` **before** `clear`), the one-`pkill` count (now pinned at two with
the outcome and the attempt count), and an observe assertion that asserted an empty list (replaced by
one that drives a real row). Every change is a strengthening.

---

# Findings

## Critical

None.

## Important

**I1 — after a re-stage, an accuracy repetition reports the FIRST attempt's `chromeWaitMs` beside
the SECOND attempt's `stageMs`.** `run.ts:430–434` captures `chromeWaitMs: staging.chromeWaitMs`
into `fixed` *before* the re-stage, and `fixed` is never rebuilt when `staging` is replaced at
`run.ts:462`. The toolbar path does the opposite and updates it (`run.ts:651`, `let chromeWait`), so
the same field means different things in two row types of the same file.

*Probe (passes against the current tree, proving the defect):* a chat case whose first staging never
comes to the front; `pgrep` says the old Chrome is **gone** for the first `prepareChrome` (wait 0 ms)
and **alive** for two polls of the second (wait 200 ms). The repetition comes back
`stageAttempts: 2`, `outcome: "ok"` — the read came from the second staging — and
`chromeWaitMs: 0`. The identical world through `runToolbarCase` gives `chromeWaitMs: 200`.

Why it matters here and not in general: `chromeWaitMs` is exactly the number the developer reasoned
from in P2 of this report ("`chromeWaitMs` ≈ 20 ms, no `stageMs`, nothing read"). The next run's
file will now carry re-staged rows whose wait belongs to a staging that was thrown away, and the
first diagnosis anyone makes from it — "the second attempt did not wait for the old Chrome either" —
will be unfalsifiable from the file.

*Suggested fix:* make the field follow the staging that produced the read, as the toolbar path does.
One line: turn `fixed` into a `let`, and inside the re-stage block
`fixed.chromeWaitMs = staging.chromeWaitMs;` after the reassignment (or build `fixed` lazily from
the current `staging` at the two places it is spread). Pin it with the probe above — the assertion
`chromeWaitMs` equals the second attempt's wait fails on today's code.

## Minor

**M1 — a missing `/dev/tty` writes a bash error into the staged window 15 times.** In
`CLAVE_SIZE=$(stty size < /dev/tty 2>/dev/null)` (`stage.ts:426`) the redirections are applied left
to right, so if `< /dev/tty` fails it is **bash**, not `stty`, that reports it, and `2>/dev/null` has
not taken effect yet. Verified in an isolated shell (not the generated script): `bash: /dev/tty: No
such file or directory` reaches stderr, once per iteration. Harmless today only because the poll
runs before `clear` + `ESC [ 3 J` (`stage.ts:443–444`), so nothing reaches the capture — but it is
one reordering away from being visible in a scored window, and it prints 15 lines into the owner's
screen. *Fix:* `$(stty size 2>/dev/null < /dev/tty)` — verified silent in the same isolated shell.
*Nit in the same line:* `set -- $CLAVE_SIZE` (`stage.ts:427`) is unquoted on purpose, so it is also
**glob**-expanded; `stty size` can only print digits, and anything else is caught by the bounded
parser, but a `set -f` before the loop would make the split total.

**M2 — the generous first-staging timeout is per PART, not per run.** `runMode`
(`run.ts:764–770`) hands the same counter-less `deps` to `runAccuracy` and to `runToolbar`, and each
calls `withProgress` (`run.ts:566–568, 573, 678`), which mints a counter of its own. Proved: two
`withProgress(deps)` calls on the same object return two different counters, both at zero. So a
`mode=all` run gives **two** stagings the 30 s wait, not one — while the report and the doc comment
both say "the first Chrome window of a run". The behaviour is defensible (the toolbar part's first
window also follows a teardown) but it is not what is written down. *Fix:* either create the counter
once in `runMode` and pass it down, or change the two comments and the report to say "the first
Chrome window of each part".

**M3 — a caller with no counter makes EVERY Chrome staging generous.** `guardTimeoutFor`'s
`(deps.progress?.chromeStagings ?? 0) <= 1` (`run.ts:414`) is true for every staging when
`progress` is absent. It is documented (`run.ts:131–137`) and today only unit tests take that path,
but it means a future production entry point that calls `runAccuracyCase`/`runToolbarCase` directly
silently doubles the worst-case wait of every case with nothing failing. *Fix:* treat a missing
counter as "not the first" (`(deps.progress?.chromeStagings ?? 2) <= 1`) and let the two run
functions, which already wrap, be the only source of generosity — or assert the counter's presence.

**M4 — leading zeros are silently normalised.** `boundedCount` accepts `0072` and reports `72`
(`stagedTitle.ts:161–167`); the doc says only "a whole number in [1, 1000]", which hides that the
recorded number can differ character-for-character from what the shell printed. Unreachable from
`stty`, and inside the ruling's bounds either way. *Fix:* one line of doc, or refuse a leading zero
on a multi-character count, plus a test — there is none for this shape today.

**M5 — three fields were added to the results file and `schema` stayed 1.** `results.ts:320–322`
says "Bumped whenever the shape below changes, so an old file is never read as a new one", and this
loop added `readyColumns`, `readyRows` and `stageAttempts` (`results.ts:123–142`). The change is
purely additive so an old file read as a new one yields `undefined`, not a wrong value, and no
released version has produced a file — but the rule as written has now been broken twice (loop 1
added `displayScale` the same way). *Fix:* bump to 2 and pin it, or narrow the doc to say the
version tracks only incompatible changes.

**M6 — `readySizeIn`'s tests live in `stage.test.ts`, not `stagedTitle.test.ts`.** All 15
references are in `stage.test.ts`; `stagedTitle.test.ts` (unchanged this loop) is where a reader
looks for them. Nothing is untested — it is a findability cost on the one function the privacy
ruling singled out. *Fix:* move the two new `describe` blocks, or leave a pointer comment in
`stagedTitle.test.ts`.

---

## Observations for the run record (not findings)

- The fail-open chain for a terminal whose size cannot be measured is now honest end to end: no
  `/dev/tty` **and** no `tput` prints `READY x.` → parser gives two `null`s → `sizeAsStaged: false`
  → the group is incomplete, and the window is still read and scored. `80` and `24` together remain
  the signature of the `tput`-down-a-pipe failure, and the file now says so out loud.
- `stageAttempts: 2` with `outcome: "ok"` is the row that proves the re-stage earned its place; if
  the next run shows it on the first Chrome case only, the 30 s generosity is doing the work and the
  re-stage is the belt. Both numbers are in the file, which was the point of this loop.
- The report's N1 ("`main.ts`'s display wiring pinned off its source") is accurate even though
  `main.ts` is byte-identical to `rrB`: the fix was the *pin*, four new source-scan assertions in
  `helper.test.ts`, and reverting `main.ts` to `getPrimaryDisplay` now fails two tests.
- `wholePoint("-0")` now returns `-0`, where the digits-only rule refused it. Both parsers agree and
  both render it as `0` (`String(-0)` and `JSON.stringify(-0)`), so it reaches Chrome as `0`; the
  doc comment quietly dropped `-0` from its list of things `Number()` wrongly accepts. Harmless,
  noted so nobody re-derives it.
- Three seconds of polling plus two 0.4 s resize waits plus the 0.4 s settle is ~3.8 s worst case per
  terminal staging, against a 40 s hold and a 15 s guard — comfortable.

---

**Spec compliance ✅** — the widening is exactly what the ruling allowed and no more: two integers
in [1, 1000] or nothing, taken from this case's and this run's own READY grammar, with the guard's
approval untouched and every earlier refusal intact; nothing else from a window title reaches the
results file (sentinel run); no window the harness did not stage can be read; the generated script
executes nothing derived from the screen and cannot loop.

**Quality: Approved** — with I1 fixed. The loop is well-evidenced work: the parser is tighter than it
needed to be, the re-stage is structurally incapable of a second read or a third attempt, and the two
proofs that did not bite were closed by strengthening the tests rather than the claim. I1 is a
one-line correctness bug in a diagnostic number, not a privacy or control-flow defect, and the six
Minors are documentation, findability and defence-in-depth.

**Verdict: APPROVED WITH ONE IMPORTANT.** Fix I1 (`chromeWaitMs` after a re-stage) before the next
staged run, since that run's whole purpose is reading these numbers; M1 is worth the same commit
(one token). The rest can wait. 754/754 green, `tsc` clean, `bytes.test.ts` green, twelve revert
proofs re-run and all biting, tree restored byte-identical.
