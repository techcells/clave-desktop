# Independent review B — `reader:eval` staging repairs (H1 Chrome size, H2 Terminal markers)

Date 2026-09-20. Reviewer B, independent of the developer. Topic: `app/src/readerEval/**` and
`app/scripts/reader-eval.*` only. Nothing was launched: no bundle, no `reader-eval.mjs` program half,
no `dist/reader-eval.cjs`, no screen, no dev data folder. Every probe ran vitest/tsc directly against
my own copy `…/s1/rvB/app` (node_modules symlinked; `pnpm` never invoked there).

Baseline reproduced: **677 passed in 17 files**, `tsc --noEmit -p rvB/app/tsconfig.json` clean,
`bytes.test.ts` 42 passed. After every mutation the file was restored and `cmp`'d byte-for-byte
against `$R/app` — all restores identical; `diff -rq` of the whole folder afterwards shows only my
two probe files (`src/readerEval/reviewB.probe.test.ts`, `src/readerEval/reviewB.render.test.ts`,
22 + 4 probes, all passing).

---

## 1. THE GUARD — is the READY token strictly a narrowing?

**Yes, structurally.** `guard.ts:71-81` applies the four unchanged tests first (window present;
`isStagedTitle(expectation.stagedTitle)`; `window.app` compared with `!==`; `window.title.includes(stagedTitle)`)
and only then adds one more conjunct at `guard.ts:79`. A conjunct can only remove approvals. My
probe `B1 never widens` (`reviewB.probe.test.ts`) asserts the property directly over a corpus of
titles x two apps: every window approved with `requireReady` is also approved without it. Never the
reverse.

Each attack you asked for, as a probe (all pass):

| Attempt | Result | Why |
|---|---|---|
| READY title with **another run's nonce** | refused | the nonce is inside `stagedTitle`; `guard.ts:75` fails first |
| READY title of **another case** | refused | the case name is inside `stagedTitle`; same line |
| a bare `READY 140x40`, or `" READY "` | refused | `guard.ts:73/75` |
| the staged title **twice** (`X X`) | refused without a READY; approved as `X X READY …` | both are titles only this run's staging can mint; the second form is still this case + this nonce + READY |
| **Chrome or Safari** carrying the terminal case's READY title | refused | `guard.ts:74`, `app` compared exactly |
| a Terminal window **without** READY when the case requires it | refused | `guard.ts:79` |
| `READY 999999x1`, `READY x`, `READY -5x-5`, `READY 0x0`, `READY` bare | **approved** | deliberate: the guard tests a substring, never a number |

**Nothing is ever parsed out of a title.** There is no `parseInt`/`Number()` anywhere on a title.
`run.ts:318` composes the string the shell *would* print if it got the staged size
(`readyTitleFor(...) + readySizeToken(cols, rows)`) and `run.ts:395` answers `sizeAsStaged` with one
`title.includes(...)` — a boolean. The cols/rows that reach results are the ones from `cases.ts`
(`staged: {columns, rows}`), i.e. the harness's own table, never the screen's. So the absurd titles
above yield `sizeAsStaged: false, scale: null, staged: {columns:140, rows:40}` — probe
`B3 absurd numbers are not as staged and never parsed`.

**The title is still never written to results.** Probe `B3 no title … reaches the results file`
drives a whole terminal case whose window title carries `SENTINEL-TITLE-Inbox-4111111111111111`,
serialises, and asserts the file contains neither the sentinel nor `READY`, that the repetition's key
set is exactly the fifteen expected names, and that every leaf value is a number, a boolean or null
except `outcome`.

**`expect` is still the front window and nothing else.** Probe `B3 every read carries expect …`:
every `read` line the harness wrote has keys exactly `{id, op, budgetMs, expect}` and `expect`
deep-equals the `FrontWindow` the guard approved, `bundleId` and full title included. (The immediate
cache probe re-uses the same approval — pre-existing and documented at `run.ts:409-416`; the helper
re-checks `expect` itself, so it cannot land elsewhere.)

## 2. E2 compliance — scorer, thresholds, guard rule, acceptance

- `thresholds.ts` — **byte-identical** to `pre-repair` (`cmp`). No pass mark moved. The two new
  staging constants live in `run.ts:140-141` and the tolerance in `stage.ts:193`.
- `score.ts` — one **addition** only (`markerHits`, `score.ts:109-127`). `norm`, `between`,
  `accuracy`, `accents`, `confusions` are untouched by the diff; `markerHits` is two regex `.test`
  calls returning two booleans, is called once (`run.ts:378`) and feeds only `startFound`/`endFound`.
  It cannot leak text: it returns no captured groups.
- `guard.ts` — one added optional field and one added conjunct (see §1).
- `summary.ts` — two changes, both strictly *stricter*: `isIncomplete` gains
  `|| entry.sizeAsStaged === false` (`summary.ts:67-71`) and `summariseToolbar`'s `incompleteCases`
  gains the same disjunct (`summary.ts:141-145`). `passed` already demanded
  `incompleteCases.length === 0` (`summary.ts:120`), so the only possible effect is to turn a pass
  into a fail. `null` never fails (`=== false`). `observe` rows are summarised elsewhere and carry
  `sizeAsStaged: null` (`run.ts:609`), so they are untouched.

**Can the tolerance or the inferred scale turn a wrong size into "as staged"?** Only in one way.
`capturedSize` (`stage.ts:213-227`) accepts a capture when `|px − pt·s| ≤ 4` for `s ∈ {1,2,3}`, both
axes at the same `s`. Probed by hand:

| Case | Result |
|---|---|
| 1416x1768 px vs staged 1268x708 pt (the measured first run) | `{scale: null, sizeAsStaged: false}` ✓ |
| 2320x1280 px vs staged 1160x640 pt | `{scale: 2, sizeAsStaged: true}` ✓ |
| 2324x1284 (exactly +4) | true; 2325x1280 (+5) | false ✓ |
| mixed scale 2320x640 | false ✓ |
| +5 / +28 / +56 px of height (a title bar's worth) | false ✓ |
| 1740x960 (a 1.5x display) | false — a non-integer scale is never accepted; it fails closed |

The one false accept is a window that really is an **integer multiple** of the staged points
(e.g. 1160x640 pt asked for, 2320x1280 pt delivered on a 1x display → read as "as staged at 2x").
That is not reachable by "a scale chosen to fit" — the scale set is `[1,2,3]` and both axes must
agree — but it is reachable if the display's real scale is not what the capture implies. See Minor 3:
the scale need not be inferred at all, since `main.ts` already asks the display for its `workArea`
and could ask the same `Display` for `scaleFactor`.

**Does a WxH-pt window really capture as W·scale x H·scale?** On the evidence, yes, with a pixel or
two of rounding that the 4 px tolerance absorbs. `native/reader/src/macos/capture.rs:44-62` builds an
`SCContentFilter` with `initWithDesktopIndependentWindow`, takes `filter.contentRect()` and
`pointPixelScale()`, sets the configuration to `rect.size * scale` (truncating) and
`setIgnoreShadowsSingleWindow(true)` — so the shadow, which is desktop pixels, is out, and the
measured rect is the window's own frame. Chrome's `--window-size` sets the browser window's **outer**
bounds, and on macOS Chrome draws its tab strip inside that frame (there is no separate system title
bar to add), so outer bounds = what is captured. Residual risk: if SCK's `contentRect` ever carried
an inset the tolerance cannot absorb, **every** case would report `sizeAsStaged: false` and the whole
run would be incomplete. That direction is fail-closed and diagnosable — `stats.widthPx/heightPx` and
`staged` are both in the file — but it is an assumption the next run tests for the first time, and
the owner should be told to read those two numbers before concluding "Chrome still ignores the flags".

One staging consequence of repair #4 that I checked rather than assumed: the narrower 1160 pt window
cannot clip the staged pages. `.code`/`.terminal` use `white-space:pre` (`pages.ts:29`) so long lines
overflow rather than wrap, but the longest truth line is 87 characters (`code.txt`; chat 67, ticket
74, pt 72, terminal 66) — about 731 px at 14 px Menlo inside 1160 − 48 px of margin. No clipping at
either the old or the new width, and terminal's 66 < 72 columns, so the report's wrapping paragraph
holds.

## 3. Results privacy

Every new field is a number or a boolean **by type** (`results.ts:69-135`) and by producer:
`staged` from `cases.ts`; `scale`/`sizeAsStaged` from `capturedSize` or one `String.includes`;
`startFound`/`endFound` from `markerHits`; `lineCount` from `lineCountOf` (`run.ts:338`);
`textLength` from `text.length`; `chromeWaitMs`/`stageMs` from `deps.now()` differences. There is no
*runtime scrubber* in the sense the report's wording suggests (Minor 6): `serialiseResults` is a
hand-written **key allow-list** that copies each value verbatim (`scale: value.scale ?? null`). The
protection is the allow-list plus typed producers, and it held under every probe.

Non-vacuity, probed by injecting a leak and re-running (each restored + `cmp`'d):

| Leak injected | Caught by |
|---|---|
| recognised TEXT into `textLength` (`run.ts:399`) | `results.test.ts` (2 failures) + `run.test.ts` |
| recognised TEXT into the repetition's `staged.columns` | `results.test.ts` (1) + `run.test.ts` |
| window TITLE into a toolbar row's `scale` | `results.test.ts` (1) |
| window TITLE into `chromeWaitMs` | `results.test.ts` (1) + `run.test.ts` |
| window TITLE into the **terminal** path's `scale` (`run.ts:395`) | **not** `results.test.ts` (0) — only `run.test.ts` |

So the sentinel run is non-vacuous for the new rows on the browser, toolbar and observe paths. The
one hole is that it never drives a TERMINAL case — the only new path that touches a window title
(Minor 4). Dropping `startFound` from the serialiser (the developer's M4) fails
`results.test.ts` (key set pinned at `results.test.ts:366-369`), so a quietly removed field is caught
too. `markerHits` (`score.ts:127`) returns `{start, end}` from `RegExp.test` — no capture groups,
nothing to leak, consulted by nothing that scores.

`scripts/reader-eval.mjs:200-244` prints only numbers, booleans and the fixed case name in the two
new lines; no recognised text, no title.

## 4. Staging as data

- **Chrome Preferences.** `chromePreferences` (`stage.ts:153-183`) returns a plain object; `main.ts:115-119`
  writes `JSON.stringify(...)` into `join(scratch.profileDir, "Default", "Preferences")` where
  `scratch = evalScratchPaths(tmpdir(), randomBytes(6))` (`main.ts:69`) — a per-run temp directory,
  removed at the end (`main.ts:72`). The owner's own Chrome profile is never named or opened. The
  bookmarks-bar variant is merged (`...bar`), not replaced, and `maximized` is pinned `false`.
  Valid JSON by construction. **But the write happens at the wrong moment — Important 1.**
- **The pgrep wait.** `chromeAliveCommand` (`stage.ts:126-128`) reuses `chromeTeardownPattern`
  verbatim; both that function and `chromeTeardownCommand` are byte-identical to pre-repair (`diff`
  of the two function bodies). Pattern: `[-]-user-data-dir=<this run's profile, ERE-escaped>` —
  it cannot match the owner's Chrome. Bounded at 40 x 250 ms (`run.ts:140-141`, `run.ts:245-248`),
  the first ask before any sleeping; `commandMatches` (`main.ts:94-108`) uses `stdio: "ignore"` and
  resolves on the exit code only, with `error → false` so an un-askable wait cannot hang. A terminal
  staging never calls it (`run.ts:272` is inside the `kind === "browser"` branch).
- **The `.command` script.** I rendered it from the real truth file inside a test (never executed)
  and byte-inspected it (`cat -v`): shebang `#!/bin/bash`; title first without READY; two resizes at
  0.4 s and 0.8 s; `clear` then `ESC [ 3 J`; `echo STARTMARKER` and `echo ENDMARKER` each on their
  own line; the truth inside a **quoted** heredoc (so `$ pnpm`, backticks and `|` are inert);
  `tput cols`/`tput lines`; then the READY title; `sleep 40`; `exit 0`. `bash -n` parses it. All
  control characters come from `String.fromCharCode` (`stage.ts:246-254`); a python scan of all 33
  source files found **no** control byte other than TAB/LF, `file(1)` reports every one as text, and
  the two escapes that must stay escapes are intact on disk (`score.ts:48` `\\u001C-\\u001F`,
  `stage.ts:291` `['\\u0000-\\u001F]`).
  - Nothing derived from the screen can reach it: the file is written before the window exists, the
    title is refused if it holds a quote or a control character (`stage.ts:332`), and the only command
    substitutions in the whole script are the two `tput` calls.
  - **Which shell?** The `.command` is opened by LaunchServices, so the owner's login shell (zsh)
    starts the window and runs the file, but the file itself executes under its own `#!/bin/bash`.
    zsh plugins, a `clear` alias or a zsh `set -e` therefore cannot reach the script; whatever the
    owner's rc prints into the window is wiped by `clear` + `ESC [ 3 J` before STARTMARKER. What CAN
    reach it: `BASH_ENV` (non-interactive bash sources it) and an exported `SHELLOPTS` (bash applies
    it at startup) — with `errexit`, `CLAVE_COLS=$(tput …)` failing would abort before READY, so the
    case records `notStaged`: fail-closed. `PATH` decides which `clear`/`tput`/`cat` runs; also the
    owner's own environment. None of this can make the harness read an unstaged window.
  - **Important 3** below is the one real defect I found in the script.

## 5. `DISPLAY_TOO_SMALL`

Decided at `main.ts:202-220` from `screen.getPrimaryDisplay().workArea`, for a mode that stages
(`stagesWindows`), **before** `createPageServer` (`main.ts:234`) and before `spawnHelper`
(`main.ts:243`) — so nothing is opened and no helper exists when it fires. It is written as
`{error: "HARNESS", code: "DISPLAY_TOO_SMALL"}` (a fixed code and nothing else) and printed with a
fixed hint (`reader-eval.mjs:257-260`).

A `--position` that pushes the window off the work area is **refused, not staged off-screen**:
`fitsWorkArea` (`cases.ts:101-108`) checks all four edges including the corners, and my mutation of
its right/bottom half fails 4 tests. That is the right answer for a typo — and the wrong one for the
option's stated purpose: see **Important 2**.

## 6. Mutation table — every row re-run

Method: exact-string mutation in `rvB`, the **whole** harness suite each time
(`src/readerEval` + `scripts/reader-eval.test.ts`, 677 harness tests plus my probes), restore,
`cmp` against `$R/app`. All twenty restores byte-identical.

| # | Mutation (as I reproduced it) | File | Failures | Bites? |
|---|---|---|---|---|
| M1 | `capturedSize` answers `sizeAsStaged: true` when no scale fits | `stage.ts:226` | 10 (stage, run, probe) | yes |
| M2 | drop the `requireReady` conjunct | `guard.ts:79` | 5 (guard, run, probe) | yes |
| M3 | anchor dropped: `includes(READY_TOKEN)` instead of `includes(stagedTitle + READY_TOKEN)` | `guard.ts:79` | **0** | **NO** |
| M3′ | the harsher reading: the staged-title test itself replaced by the token | `guard.ts:75` | 39 | yes |
| M4 | drop `startFound` from the serialiser | `results.ts:421` | 2 (results, probe) | yes |
| M5 | skip the wait-for-exit loop entirely | `run.ts:245` | 4 (run) | yes |
| M6 | `displayRefusal` never refuses | `cases.ts:135` | 3 (cases) | yes |
| M7 | not-as-staged no longer makes a case incomplete | `summary.ts:70` | 5 (run, summary) | yes |
| M8 | no window placement written (variant only) | `run.ts:261` | 3 (run) | yes |
| M9 | `stagingLines` returns nothing | `reader-eval.mjs:226` | 5 (scripts) | yes |
| M10 | one resize, printed at once | `stage.ts:343-346` | 1 (stage) | yes |

Mine, beyond the table:

| # | Mutation | File | Failures | Bites? |
|---|---|---|---|---|
| S1 | the leading space of `READY_TOKEN` dropped from the anchor | `guard.ts:79` | 13 | yes |
| S2 | preferences written **after** the wait (order swapped) | `run.ts:260-266` | 3 (run) | yes — the order is pinned, see Important 1 |
| S3 | READY title printed **before** `ENDMARKER` | `stage.ts:357-366` | 2 (stage) | yes |
| S4 | scrollback clear dropped | `stage.ts:353` | 1 (stage) | yes |
| S5 | a terminal's `sizeAsStaged` hard-coded true | `run.ts:395` | 4 | yes |
| S6 | toolbar not-as-staged no longer incomplete | `summary.ts:144` | 2 | yes |
| S7 | `stageMs` always 0 | `run.ts:371` | 1 | yes |
| S8 | `textLength` always 0 | `run.ts:399` | 2 | yes |
| S9 | `fitsWorkArea` ignores the right/bottom edges | `cases.ts:105-106` | 4 | yes |
| S10 | `chromeAliveCommand` matches any Chrome | `stage.ts:126-128` | 2 | yes |
| L1–L5 | five privacy leaks into the new fields | `run.ts` | see §3 | four of five caught by `results.test.ts` |

**M3 does not bite.** With the staged-title test still in front of it, `includes(" READY")` and
`includes(stagedTitle + " READY")` are indistinguishable to every test in the suite: no test builds a
title that carries this case's staged title *and* a READY belonging somewhere else (e.g.
`"OTHER READY — CLAVE-EVAL terminal <nonce>"`). The anchoring is defence in depth, not the safety
property (which `guard.ts:75` holds), so this is a coverage and reporting defect, not a hole.

---

## Findings

### Critical
**None.** I could not get a `read` written for a window this run did not stage, could not get a
string into the results file, and could not find a scoring path, threshold or acceptance rule that
moved in the loosening direction.

### Important 1 — the window placement is written *before* the old Chrome exits, so the old Chrome can overwrite it

`app/src/readerEval/run.ts:260-266` (`prepareChrome`), pinned by `run.test.ts`'s ordering-as-data test.

```
await deps.stager.writePreferences(chromePreferences(...));   // first
return await awaitChromeGone(deps);                           // then wait
```

The comment argues the placement "has to be on disk before the process that reads it starts". True —
but the process that is still *quitting* also **writes** that file: Chrome persists
`browser.window_placement` when a window closes and flushes its `PrefService` on shutdown, and the
teardown `pkill` that starts that shutdown runs microseconds before this write (`run.ts:405`, the
`finally`). So the sequence on every staging after the first is: we write the correct placement → the
dying Chrome writes *its* placement (the wrong size, the one we are trying to fix) → we launch and
Chrome reads the wrong one. Repair #2 is defeated exactly in the situation repair #1 exists for.

*Probe:* mutation **S2** (swap the two statements) fails 3 tests in `run.test.ts` — i.e. the current,
vulnerable order is what the suite pins.
*Suggested fix:* wait first, then write, then open — `const waited = await awaitChromeGone(deps);`
before `writePreferences`, returning `waited`; update the ordering test's expected data to
`pgrep…, preferences, open` and keep one test asserting the preferences are still written before the
`open`.

### Important 2 — `DISPLAY_TOO_SMALL` is decided on the PRIMARY display, which refuses the very use `--position` exists for

`app/src/readerEval/main.ts:202-220` with `app/src/readerEval/cases.ts:129-136`.

`workArea` is taken from `screen.getPrimaryDisplay()` and `displayRefusal` then demands that the box
at the requested position fit *that* display. But `--position` exists to stage on **another** display
(`cases.ts:74-79`: "the only way to measure recognition on a 2x display is to stage the window ON
that display"; plan Task 1's interface, spec 10.1 item 8). In macOS's global coordinate space a
second display lies outside the primary's work area by definition, so `--position 1600,100` — the
Retina check — is now refused before anything opens, with a code that says the display is too small.
The `work_area_*` written into the profile has the same bug: it describes the primary display while
the window is asked to open on another.

*Probe:* `B4 the second-display position` — `fitsWorkArea({1160x640 at (1600,100)}, {x:0,y:38,w:1512,h:906})`
is `false` and `displayRefusal` returns `DISPLAY_TOO_SMALL`, while the default corner returns `null`; `cases.test.ts` pins exactly this as desired behaviour
for "a position that pushes the window off".
*Suggested fix:* pick the display the run is actually targeting —
`screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt})` — and use *its* `workArea` both
for the refusal and for `work_area_*`. Keep the refusal for a position that lands on no display.

### Important 3 — `tput` is read with no settling time after the resize, so a correctly resized terminal can report the wrong size

`app/src/readerEval/stage.ts:344-366`.

The second `ESC [ 8 ; rows ; cols t` is followed immediately by `clear`, the markers, the heredoc and
`ENDMARKER`, and only then by `CLAVE_COLS=$(tput cols)`. Terminal applies a resize asynchronously
(window resize → `TIOCSWINSZ`/`SIGWINCH`); the intervening work is a few milliseconds of printing.
If the tty's winsize has not been updated yet, `tput` reports the **pre-resize** size, the READY
title carries it, `sizeAsStaged` is `false`, and — by the new rule — the terminal group is
`incomplete` and the run cannot be accepted, although the window on screen is exactly right. The same
delay the repair added for the resize itself (`TERMINAL_RESIZE_DELAY_SECONDS`, and the reasoning at
`stage.ts:259-276`) is the one thing missing here.

*Probe:* by construction — there is no sleep between `stage.ts:346` and `stage.ts:364`; `stage.test.ts`
asserts the order of the lines but nothing about the interval.
*Suggested fix:* one more `sleep ${TERMINAL_RESIZE_DELAY_SECONDS}` immediately before the two `tput`
lines (it costs 0.4 s per terminal case, twice per run), with a test pinning it.

### Important 4 — the developer's mutation M3 does not reproduce; the READY anchor is untested

`app/src/readerEval/guard.ts:79`, report §6 row M3 ("2 failed / 98").

Replacing `includes(\`${stagedTitle}${READY_TOKEN}\`)` with `includes(READY_TOKEN)` fails **zero**
tests of the whole suite. The suite therefore does not hold the property the report's prose claims for that row
("a window carrying another case's ready title, or another run's, has already failed the test above
it" is true, but it is `guard.ts:75` that makes it true, not the anchored form). The harsher reading
of the same sentence (M3′) fails 39, and S1 (the leading space) fails 13 — so two thirds of the
token's design *is* covered.

*Suggested fix:* one test with a title that carries this case's staged title and a READY that belongs
to something else — e.g. `"OTHER READY 1x1 — " + stagedTitleFor(case, nonce)` must be refused with
`requireReady` and approved without it — and correct the row in the report.

### Minor 1 — the terminal size test is unanchored on the right: `140x40` matches `140x400`

`app/src/readerEval/run.ts:395` with `stagedTitle.ts:64`. `title.includes("… READY 140x40")` is
satisfied by a title ending `… READY 140x400`. Probe
`B3 PROBE: a row count that merely STARTS with the staged one passes` — `sizeAsStaged: true` for
`140x400`, correctly `false` for `1400x40` (the left side is anchored by the staged title). Physically
implausible for rows, but it is the kind of thing that stops being implausible when a Terminal profile
appends its own text to the title (the report's own unknown 5).
*Suggested fix:* have the shell print a closing sentinel (e.g. `… READY 140x40.`) and include it in
`readySizeToken`, or compare `title.endsWith(...)` on the segment.

### Minor 2 — `requireReady` is satisfied by any word continuing `READY`

`app/src/readerEval/guard.ts:79`. A title `…<nonce> READYING` passes (probed, documented in
`B1 a terminal window WITHOUT ready`). Harmless today — only our own shell writes the token — and the
same closing sentinel as Minor 1 fixes it.

### Minor 3 — the display scale is inferred although the bundle can simply ask for it

`app/src/readerEval/stage.ts:195-227`. `main.ts:210-215` already reads `screen.getPrimaryDisplay()`;
the same `Display` carries `scaleFactor`. Threading it through (as `workArea` already is) would turn
`capturedSize` from "find a scale that fits" into "check the one true scale", which removes the one
false accept in §2 (a window at an exact integer multiple of the staged points) and makes a 1.5x
display report honestly instead of failing every case closed.

### Minor 4 — the sentinel run never drives a TERMINAL case, the only new path that touches a title

`app/src/readerEval/results.test.ts:59-101` stages `chat-light-14`, a toolbar case and an observe
case. Leak probe **L2** (window title into the terminal path's `scale`, `run.ts:395`) is invisible to
`results.test.ts` — caught only by `run.test.ts`'s value assertions. My
`reviewB.probe.test.ts` covers it and the code is clean; the *test* is what is missing. Related: the
"nothing but `outcome` is a string" assertion (`results.test.ts:375-379`) is shallow `typeof` on the
top-level value, so a string inside `staged`/`stats` is not caught there (the sentinel containment
check does catch it — probe L5).
*Suggested fix:* add the terminal case to the sentinel deps (a READY title carrying a sentinel), and
recurse in the string assertion.

### Minor 5 — the heredoc guard misses a truth whose FIRST line is the delimiter (pre-existing)

`app/src/readerEval/stage.ts:333`. `truth.includes("\n" + DELIM + "\n")` cannot see a delimiter at
offset 0, and the truth is inserted at a line start, so a truth beginning `CLAVE_EVAL_TRUTH\n…` ends
the heredoc immediately and everything after it becomes shell commands (probe
`reviewB.render.test.ts: a truth whose FIRST line is the heredoc delimiter escapes the heredoc` —
the rendered script contains `echo PWNED`). The truth files are repo-controlled and the current ones
are fine, so this is defence in depth, unchanged by this repair.
*Suggested fix:* `if (("\n" + truth).includes("\n" + DELIM + "\n"))`.

### Minor 6 — two wordings in the report overstate what exists

(a) §3 "by TYPE and by the runtime scrubber" — there is no runtime scrubber for these fields;
`serialiseResults` is a key allow-list that copies values verbatim (`results.ts:417-430`). The claim
that holds is "typed producers + an allow-list + a sentinel run", which is what I verified.
(b) §6 row M3, see Important 4.

### Minor 7 — an alternative hypothesis for the first run that the report does not weigh

The report cannot explain the captured **width** (708 pt at 2x) from Chromium's default-width rule
and says so honestly. Worth recording before the next run: 708 is *exactly* the staged **height**
(`1268 x 708`), so "the sizing process saw `--window-size` but used only one of its two numbers" fits
the data as well as "the flags never reached it" — and the two are distinguished by the same
`chromeWaitMs`/`stageMs`/`sizeAsStaged` the repair adds. No code change; one line in the next run's
record so the owner reads the numbers with both hypotheses in hand.

### Minor 8 — environment reach of the staged `.command`

`app/src/readerEval/stage.ts:336`. The shebang is `#!/bin/bash`, so the owner's zsh, its plugins and
any `clear` alias cannot touch the script (and whatever the login shell printed is wiped before
STARTMARKER). What can: `BASH_ENV`, an exported `SHELLOPTS` (a `errexit` there aborts before READY —
fail-closed, the case records `notStaged`) and `PATH` (which `clear`/`tput`/`cat` run). All are the
owner's own environment and none can widen what is read; worth one line in the run record if a
terminal case behaves oddly.

---

**Spec compliance ✅** — E2 is kept: the guard's rule is narrowed and never widened, `thresholds.ts`
is byte-identical, the scorer's arithmetic is untouched (one pure diagnostic function added), and the
only acceptance change makes acceptance stricter. Results still hold numbers, booleans, case names
and fixed codes only; the Global Constraints' "reads only a window it staged in this run" survives
every probe I could build against it. Nothing was run that reads a screen.

**Quality: Approved with changes** — the four Important findings are all repairs to repairs, not
rewrites: two are one-line reorderings (Important 1, 3), one is a display lookup (Important 2), one is
a missing test plus a corrected report row (Important 4). Important 1 and 3 matter *before* the next
screen run, because each can waste the owner's session: 1 can silently defeat the placement repair, 3
can mark a perfectly staged terminal incomplete.

**Verdict: APPROVE WITH CHANGES — fix Important 1 and 3 before the next staged run; Important 2 and 4
before the run that uses `--position` or that quotes the mutation table. No Critical findings; no
privacy or guard regression found.**
