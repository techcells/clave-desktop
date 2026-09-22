# `reader:eval` staging repairs H1 (Chrome size) and H2 (Terminal markers)

Date 2026-09-20. Scope: STAGING and DIAGNOSTICS only. The guard's rule, the thresholds, the scorer
and what results may hold beyond new numbers and booleans are unchanged (plan decision E2). Nothing
was launched, no bundle was run, no screen was read, no dev data folder was opened.

Input measurement: `app/reader-eval/out/accuracy-f61fef7586de.json` (numbers only) — 16/16 Chrome
cases `ok`, accuracy 0.956–1.0, every capture 1416 x 1768 px against a staged 1268 x 708 pt; both
Terminal cases `noMarkers` with `recogniseMs` 160 and 107 and captures 1406 x 1754 px and
1426 x 880 px; `helper.readyMs` 168; whole 18-case run 44 s.

---

## 1. Why Chrome ignored `--window-size` — evidence, then inference

### Evidence (from the results file, and from Chromium's own source)

1. **All sixteen Chrome captures are byte-identical in size** (1416 x 1768 px = 708 x 884 pt at 2x).
   A run that honoured the flags would give the staged size; a run that ignored them would give one
   size repeated — which is what happened.
2. **Eighteen stagings in 44 s, ~2.5 s each, of which 2.0 s is the harness's own settle.** That
   leaves roughly half a second per staging for `open`, the window appearing with the page loaded and
   titled, the guard poll, two reads (~200–400 ms of `captureMs` + `recogniseMs` alone) and the
   teardown. A Chrome *process* cannot start, create a profile and load a page in that budget; a
   *running* Chrome opening one more window can. So at least stagings 2…16 were served by a Chrome
   process that was already alive — the one `pkill` had just signalled and which had not yet exited.
3. **Chromium reads the window-size flag from the wrong process in exactly that situation.**
   `chrome/browser/ui/browser_window_state.cc` takes `--window-size` from
   `base::CommandLine::ForCurrentProcess()` — the command line of the process that is *running*, not
   the one that was just typed. When a second launch finds the profile's singleton held, it forwards
   its command line over the singleton socket and exits; the surviving process opens the window and
   sizes it from its OWN (first) command line. Confirmed by reading the source, and the singleton
   behaviour is the documented one ("most command-line arguments are ignored if there is already a
   running instance for that user-data-dir").
4. **Even a saved placement would have lost to this.** `chrome/browser/ui/window_sizer/window_sizer.cc`
   consults, in order: the **last active window's** bounds, then the saved `browser.window_placement`
   pref, then a computed default. With a window already open in that process, every later window
   inherits the first one's size whatever the profile says. (The pref's keys are `left`, `top`,
   `right`, `bottom`, `maximized` and the `work_area_`-prefixed four.)
5. **The captured height matches Chromium's default-bounds formula.** `GetDefaultWindowBounds` is
   `work_area.height() - 2 * kWindowTilePixels` with `kWindowTilePixels = 10`; 884 pt implies a work
   area 904 pt tall, which is a plausible built-in-panel work area. That is consistent with "the
   first window took DEFAULT bounds", i.e. the flags were not seen by the process that sized it.

### Inference, stated as inference

- The captured **width** of 708 pt does **not** match the default-width rule
  (`min(work_area.width - 20, 1050)`), so I cannot claim to have explained the first window from the
  defaults alone. Either the display's work area is much narrower than I can know from here, or the
  first staging was itself served by an earlier process, or Chrome 153 sizes differently from the
  source I read.
- **The results file cannot distinguish these**, because default bounds are deterministic: "sixteen
  fresh processes that all ignored the flags" and "one process that served all sixteen windows"
  produce the same table. That is precisely why the repairs below add `chromeWaitMs` and `stageMs`:
  after the next run the distinction is arithmetic, not argument.
- Whatever the cause, the repair set covers all three known mechanisms at once (a surviving process,
  a last-active window to inherit from, and the absence of a saved placement), and the new
  `sizeAsStaged` boolean makes any remaining failure loud instead of invisible.

Sources read: [Chromium `browser_window_state.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/browser_window_state.cc),
[Chromium `window_sizer.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/window_sizer/window_sizer.cc),
[CEF issue 3609 on process-singleton behaviour](https://github.com/chromiumembedded/cef/issues/3609),
[Chromium Startup (textslashplain)](https://textslashplain.com/2022/06/15/chromium-startup/).

---

## 2. The repairs

### H1 — Chrome staging

| # | Repair | Where |
|---|---|---|
| 1 | Wait for the previous staged Chrome to be **gone** before the next launch — `pgrep -f '[-]-user-data-dir=<this run's profile>'`, polled 40 x 250 ms, bounded (a Chrome that will not go is recorded, never hung on) | `app/src/readerEval/stage.ts:126` (`chromeAliveCommand`), `app/src/readerEval/run.ts:240` (`awaitChromeGone`), `run.ts:260` (`prepareChrome`) |
| 2 | Write `browser.window_placement` into the eval profile's `Default/Preferences` before **every** Chrome launch — `left/top/right/bottom`, `maximized:false`, and the four `work_area_*` from the display — merged with the bookmarks-bar variant rather than replacing it | `stage.ts:153` (`chromePreferences`), `run.ts:261` |
| 3 | Keep passing `--window-size` / `--window-position` (unchanged) | `stage.ts:60` |
| 4 | Default staged size **1268 x 708 → 1160 x 640 pt** at the same corner (40,60): fits a 1280 x 800 pt work area with 80 pt spare at the right and 100 pt at the bottom, so a menu bar or a Dock cannot clip it. Phase 0's 1268 x 708 came from an external 2560 x 1440 display and was never a requirement | `cases.ts:54` |
| 5 | Refuse the run with the fixed code `DISPLAY_TOO_SMALL` — before the helper is spawned or a page is served — when the staged box does not fit `screen.getPrimaryDisplay().workArea` | `cases.ts:101` (`fitsWorkArea`), `cases.ts:111/129` (`DISPLAY_TOO_SMALL`, `displayRefusal`), `main.ts:204-219` |
| 6 | New stager capability `matches(command)` — exit code only, `stdio: "ignore"`, so no process name, argument or pid is ever read into this process | `run.ts` (`Stager.matches`), `main.ts:97-109` (`commandMatches`) |

### H2 — Terminal staging

| # | Repair | Where |
|---|---|---|
| 7 | **Ready token in the harness's own title grammar.** The staged shell sets `CLAVE-EVAL <case> <nonce>` first and, only after `ENDMARKER` is printed, re-titles to `CLAVE-EVAL <case> <nonce> READY <cols>x<rows>`. The guard waits for that token for terminal cases | `stagedTitle.ts:41/44/64` (`READY_TOKEN`, `readyTitleFor`, `readySizeToken`), `guard.ts:58/79` (`Expectation.requireReady`), `run.ts:316/361` |
| 8 | Resize printed **late and twice** (0.4 s, then again 0.4 s later): Terminal drops an `ESC[8;rows;colst` that arrives while the window is still being created. No `.terminal` settings file (needs a profile import) and no AppleScript (needs an Automation grant) | `stage.ts:276` (`TERMINAL_RESIZE_DELAY_SECONDS`), `stage.ts` (`terminalScript`) |
| 9 | `clear` **and** `ESC[3J` (scrollback), in that order, before the markers; markers stay on lines of their own | `stage.ts` (`terminalScript`) |
| 10 | `sizeAsStaged` for a terminal comes from the shell's own `tput cols`/`tput lines`, carried in the title this harness minted. The guard does **not** demand the exact size — a wrongly sized terminal is still read and still scored, and is `incomplete` | `run.ts:316` (`readySizeTitle`), `run.ts:395` |

**The guard's rule is narrowed, never loosened.** `approve` applies its four existing tests first
(front window present, the expectation is one of our staged titles, app compared exactly, staged
title a substring); `requireReady` then demands ONE MORE substring, `<staged title> READY`. Another
case's ready title and another run's ready title both fail the unchanged staged-title test, because
the case name and the nonce are inside it. `guard.test.ts` holds both directions plus "is a
narrowing and never a widening". (Round 0 attributed that refusal to the anchored form; it is the
unchanged staged-title test that makes it true. Fix round 1 adds the test the anchor itself needs.)

**Wrapping, documented rather than "fixed"** (`stage.ts`, `terminalScript` doc comment):
`terminal.txt` is 12 lines whose longest is 66 characters, so a 72-column window does **not** wrap
it — the narrow case differs by the window, not by the wrapping. If a smaller window does wrap a
line, the scorer's `norm` collapses whitespace runs (newlines included) before comparing, so a
wrapped line scores identically. 12 + 2 marker lines into a window asked for 40 rows cannot scroll.

---

## 3. New results fields (numbers and booleans only)

Per accuracy **repetition** (`results.ts`, `AccuracyRepetition`; written by hand in
`serialiseResults`, each with `?? null` so a field is never dropped by `JSON.stringify`):

| Field | Meaning |
|---|---|
| `staged: {widthPt, heightPt, columns, rows}` | what was asked for — points for a browser, cells for a terminal, the other pair `null` |
| `scale` | integer display scale the capture fits the staged size at, **inferred** (the helper reports no scale: `stats_value` in `native/reader/src/protocol.rs` writes `bandPx`, `captureMs`, `recogniseMs`, `cacheHit`, `width`, `height` and nothing else) |
| `sizeAsStaged` | captured px == staged pt x an integer scale within `SIZE_TOLERANCE_PX` = 4 (browser), or the shell's reported cells == the staged cells (terminal); `null` when there is nothing to compare |
| `startFound`, `endFound` | which half of `noMarkers` happened |
| `lineCount`, `textLength` | how many lines and how many characters came back — never what they said |
| `chromeWaitMs` | ms spent waiting for the previous staged Chrome to exit (`null` for a terminal) |
| `stageMs` | ms from issuing the open command to the guard approving the window |

Same five staging fields (`staged`, `scale`, `sizeAsStaged`, `chromeWaitMs`, `stageMs`) on
`ToolbarCaseResult`; an `observe` row carries them as `null`/`NO_STAGED_SIZE`, because the owner
staged that window and this harness sized nothing.

**Acceptance:** `sizeAsStaged === false` makes its case `incomplete` (`summary.ts:67`,
`isIncomplete`) and puts a toolbar capture into `incompleteCases` (`summariseToolbar`) — the numbers
are still reported in full, they simply cannot count. `null` never fails.

The privacy protection is **typed producers + a hand-written key allow-list + the sentinel run** — there is no runtime scrubber, and `serialiseResults` copies each allowed value verbatim. It still holds: `results.test.ts`'s sentinel run passes unchanged, and two
key-set tests now pin the exact field names of a repetition and of a toolbar/observe row, with an
assertion that no value but `outcome` is a string.

## 4. New terminal-side summary lines (verbatim formats)

```
      chat-light-14             NOT AS STAGED: captured 1416x1768 px, staged 1268x708 pt  (5 of 5 reads)
      terminal-narrow           NOT AS STAGED: captured 1426x880 px, staged 72x40 cells  (1 of 1 reads)
      terminal                  NO MARKERS: start false end false  lines 0 chars 0  (1 of 1 reads)
READER_EVAL_FAILED HARNESS DISPLAY_TOO_SMALL
      the staged window does not fit this display's work area; nothing was opened
```

One line per case, not per repetition, with the count of affected reads. Toolbar rows get the same
`NOT AS STAGED` line. Built by the pure `stagingLines`/`stagedPhrase` in
`app/scripts/reader-eval.mjs:200/225`, tested in `scripts/reader-eval.test.ts`; the `.mjs`
entry-point gate (`process.argv[1].endsWith("reader-eval.mjs")`) is untouched, so importing it in a
test still opens nothing.

## 5. Tests

677 passing in 17 files (was 608), `pnpm --dir app typecheck` clean. New coverage:

- `guard.test.ts` — the ready token: approved only with it when the case asks; another case's ready
  title; another nonce's ready title; a bare token; the size token does not break the match; a
  narrowing and never a widening; unchanged for a case that does not ask.
- `stage.test.ts` — `chromeAliveCommand` is `pgrep` with exactly the teardown pattern and matches
  only this run's profile; the placement dictionary's values, `maximized:false`, the work-area half
  omitted when unknown, and the bookmarks bar carried together with it; `capturedSize` at 1x, 2x, at
  the tolerance and one pixel past it, mixed scales refused, nulls, and the first run's own
  1416x1768-against-1268x708 as `false`; the terminal script's two delayed resizes, the early title,
  the scrollback clear, READY after ENDMARKER with `tput`, and that what the shell prints is what
  `readyTitleFor` + `readySizeToken` compose.
- `cases.test.ts` — the default window fits a 1280x800 pt work area with margin; `DISPLAY_TOO_SMALL`
  for a small display, for a position that pushes the window off, and for a corner above the work
  area; exact fill accepted; every browser case checked, not only the first.
- `run.test.ts` — the wait-for-exit ordering as DATA (`preferences, pgrep true, pgrep true,
  pgrep false, run open`), one ask in the ordinary case, the bounded give-up, the placement written
  before the open, the work area threaded through, no `pgrep` at all for a terminal; `sizeAsStaged`
  at 1x and 2x, a wrong-size window still scored but its case incomplete, a toolbar row's size,
  nulls for a staging that never read, `stageMs`; a terminal never read before READY, read after it,
  refused for another case's or another nonce's READY, and the shell's own word taken for its size;
  `startFound`/`endFound`/`lineCount`/`textLength` for a good read, a lost `ENDMARKER`, an empty
  window and a multi-line read.
- `summary.test.ts` — a not-as-staged case is incomplete although every read was `ok`, fails its
  group, fails the run's `accepted`, `null` does not fail, and a toolbar capture of unknown size is
  incomplete.
- `results.test.ts` — the repetition's key set pinned by name; nothing but `outcome` is a string.
- `scripts/reader-eval.test.ts` — both new summary lines, the cells/points phrasing, the per-case
  count, nothing printed for a clean run, and the `DISPLAY_TOO_SMALL` hint.

`src/readerEval/bytes.test.ts` is green; an independent scan of all 33 files of
`src/readerEval/**` plus `scripts/reader-eval.*` found no control byte, `file(1)` reports every one
as text (none as `data`), and the escapes that must stay escapes on disk were byte-checked
(`score.ts`'s `\\u001C-\\u001F`, `stage.ts`'s `\\u0000-\\u001F`, the `\n` literals in the tests and
the `.mjs`). Every control character in generated output is built with `String.fromCharCode`. A
rendered copy of the new `.command` script (with the real truth file) parses under `bash -n`; it was
never executed.

## 6. Mutation table — every new rule shown to bite

Method: back up the file, mutate in place, run the targeted test files, restore from the backup,
`cmp` byte-for-byte. All ten restored identical.

| # | Mutation | File | Result |
|---|---|---|---|
| M1 | accept a size mismatch as as-staged | `stage.ts` `capturedSize` | 5 failed / 109 |
| M2 | approve a terminal window without the ready suffix | `guard.ts` | 3 failed / 98 |
| M3 | ~~approve a ready suffix with another nonce (match the token instead of the staged title)~~ **WRONG — see Fix round 1.** As I ran it, this mutation failed ZERO tests: the staged-title test in front of it already refuses another nonce, so the ANCHOR itself was untested. Replaced by R1 | `guard.ts` | ~~2 failed / 98~~ 0 failed |
| M4 | drop `startFound` from the results file | `results.ts` | 1 failed / 16 |
| M5 | skip the wait-for-exit between Chrome stagings | `run.ts` `awaitChromeGone` | 4 failed / 69 |
| M6 | stage anyway on a display too small | `cases.ts` `displayRefusal` | 3 failed / 22 |
| M7 | count a not-as-staged case as complete | `summary.ts` `isIncomplete` | 5 failed / 142 |
| M8 | write no window placement into the eval profile | `run.ts` `prepareChrome` | 3 failed / 109 |
| M9 | print no `NOT AS STAGED` line | `reader-eval.mjs` `stagingLines` | 4 failed / 74 |
| M10 | resize the terminal once, at once | `stage.ts` `terminalScript` | 1 failed / 40 |

## 7. What only a screen can decide

1. **Whether Chrome now honours the staged size.** The three levers cover the three known
   mechanisms; if the next run still reports `sizeAsStaged: false` with `chromeWaitMs` small and
   `stageMs` large (a real process start), then the flags and the saved placement are both being
   ignored for another reason and the next candidate is a data-URI/`window.resizeTo` staging or
   giving each staging its own profile directory.
2. **Whether the `pgrep` wait ever fires.** `chromeWaitMs` per repetition answers it; a run of zeros
   means `pkill` was already done and mechanism (2) was never the cause.
3. **Whether the built-in panel's work area can hold 1160 x 640 pt at (40,60).** If not, the run now
   refuses with `DISPLAY_TOO_SMALL` instead of measuring an unknown window — the owner then picks a
   smaller table size or another display with `--position`.
4. **Which of the four `noMarkers` causes was the real one.** After the repair the expected answer is
   "none of them" — but if it recurs, `startFound`/`endFound`/`lineCount`/`textLength` separate an
   empty window (all false, 0, 0) from a scrolled one (`start` true, `end` false) from a misread
   marker (both false with a large `textLength`).
5. **Whether Terminal honours the delayed, repeated resize.** The shell's own `tput` numbers in the
   ready title answer it in `sizeAsStaged` — and that also settles dev-report unknown 4 (whether the
   narrow case measures anything the wide one does not).
6. **Whether Terminal's profile composes or overrides the window title** (dev-report unknown 5). If
   it does, terminal cases now record `notStaged` rather than reading an empty window — a cleaner
   failure, but still a failure that needs the owner.
7. **`tput` inside a `.command`** — if `TERM` is not set as expected, the size token is empty, which
   reads as `sizeAsStaged: false` (read, scored, incomplete) rather than as a lost measurement.
8. Everything in dev-report section 6 that this task did not touch: `bandPx` on a real read,
   `cacheHit` on a real second read, a Safari private window's title, `*.localhost` resolution.

## 8. Notes for the reviewer

- `score.ts` gained one function, `markerHits` (`score.ts:127`) — pure diagnostics. It is not
  consulted by `between`, `accuracy`, `accents` or `confusions`, and no verdict depends on it; the
  scorer's arithmetic is untouched.
- `thresholds.ts` was not touched. The two new staging constants (`CHROME_EXIT_TRIES`,
  `CHROME_EXIT_POLL_MS`) live in `run.ts` and the size tolerance in `stage.ts`, deliberately away
  from the file of pass marks.
- `serialiseResults` now writes every new field with `?? null`, because `JSON.stringify` drops
  `undefined` and a results file whose columns come and go cannot be compared between runs.
- Only `app/src/readerEval/**`, `app/scripts/reader-eval.mjs` and `app/scripts/reader-eval.test.ts`
  were modified. `pnpm --dir app typecheck` reports no errors anywhere, including the other agent's
  `src/main/**` and the Rust-facing modules, as of this run.
---

# Fix round 1 — after independent review B

All four Importants and all eight Minors addressed. 698 tests passing in 17 files (was 677);
`pnpm --dir app typecheck` clean. Twelve new revert proofs, every one biting, every restore
`cmp`-identical. Nothing was launched; no screen, no bundle, no dev data folder.

## Importants

**I1 — the placement was written before the old Chrome had gone.** The dying Chrome persists
`browser.window_placement` on shutdown, so our correct placement was overwritten by the wrong one
microseconds later. The order is now **wait → write → open** (`run.ts`, `prepareChrome`), and the
sequence is pinned as data in two tests (`run.test.ts`, "waits for the old Chrome, THEN writes the
placement, THEN opens": `["pgrep true","pgrep true","pgrep false","preferences"]` before the open,
plus the rule stated as two assertions — the placement is the LAST thing before the launch, and it
comes after the last "still alive" answer). Revert proof **R2**: the old order fails 5 tests.

**I2 — the display is now the one NEAREST the staging position.** `main.ts` uses
`screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt})`; that display's `workArea`
decides the refusal AND the `work_area_*` written into the profile, and its `scaleFactor` goes to the
run. A corner that hangs the window off that display is refused with the new fixed code
**`POSITION_OFF_DISPLAY`** (`cases.ts`), distinct from `DISPLAY_TOO_SMALL`, which now means only
"larger than the work area, at any corner". Without this the Retina run — the one use `--position`
exists for (spec 10.1 item 8) — was refused before opening anything, with a code that blamed the
display's size. Tests: a second display's corner accepted with that display's work area and refused
with the primary's; both codes pinned; both hints printed by the summary. Revert proofs **R3**, **R4**.

**I3 — a settling wait before the two `tput` reads.** Terminal resizes the window and the tty
asynchronously; reading immediately could report the PRE-resize size, put it in the READY title and
mark a perfectly staged window incomplete. One more `sleep 0.4` immediately before `CLAVE_COLS=…`
(`stage.ts`, `terminalScript`), pinned by a test that locates the last resize, the settle and the
read and asserts the order plus the count of waits (three). Revert proof **R5**.

**I4 — the READY anchor is now tested, and the report row is corrected.** The missing title is
`"OTHER READY 1x1. <staged title>"`: it carries this case's staged title AND a READY belonging to
something else. It must be refused with `requireReady` and approved without — which is what makes it
a test of the anchor rather than of the staged-title test above it (`guard.test.ts`). The reviewer
is right that **row M3 of the round-0 table was wrong**: that mutation failed zero tests, not two.
The corrected row is **R1** below, which fails 2.

## Minors

| # | Fix |
|---|---|
| 1 | The size token gained a closing sentinel: `readySizeToken` is now `` ` <cols>x<rows>.` `` (`READY_SIZE_END`), so ` 140x40` is no longer satisfied by ` 140x400`. Proof **R6**; an end-to-end test stages a terminal reporting 72x400 and gets `sizeAsStaged: false`, case incomplete |
| 2 | `READY` is a word, not a prefix: the guard demands `readyMark(stagedTitle)` = `<staged title> READY ` (separator included), so `<staged title> READYING` is refused. Proof **R7** |
| 3 | The display's real `scaleFactor` is threaded through (`RunDeps.displayScale`) and recorded per row as `displayScale`; it DECIDES `sizeAsStaged` when known, and the inferred `scale` stays as the cross-check. This removes the one false accept (a capture at an exact integer multiple of the staged points on a 1x display) and measures a 1.5x display honestly instead of failing it closed. Proofs **R8**, **R9** |
| 4 | The sentinel run now drives a TERMINAL case — a READY title carrying a sentinel — which is the only new path computing a field from a window title; and the "nothing is a string" assertion recurses to every depth (with a test that the walker itself bites). Proof **R10**: a title leaked into the terminal path's `scale` is now caught by `results.test.ts`, which it was not before |
| 5 | The heredoc guard tests `("\n" + truth)`, so a truth whose FIRST line is the delimiter is refused. Proof **R11** |
| 6 | Report wordings corrected: there is no runtime scrubber — the protection is **typed producers + a hand-written key allow-list + the sentinel run**; and the M3 row is replaced by R1 |
| 7 | The reviewer's alternative hypothesis is recorded in the code (`stage.ts`, `chromeAliveCommand` doc) and here: 708 pt is exactly the staged HEIGHT of `1268 x 708`, so "the sizing process saw `--window-size` and used only one of its two numbers" fits the data as well as "the flags never reached it". No code chooses between them; `chromeWaitMs`, `stageMs` and `sizeAsStaged` settle it in the next run |
| 8 | The `.command` re-executes itself once in a chosen environment: `exec /usr/bin/env -i CLAVE_EVAL_CLEAN=1 TERM=xterm-256color PATH=/usr/bin:/bin /bin/bash --noprofile --norc "$0"`, guarded by `CLAVE_EVAL_CLEAN`. **Why this and not `unset`:** `SHELLOPTS` and `BASHOPTS` are readonly in bash, so unsetting them fails — and under an inherited `errexit` that failure is itself the abort. `env -i` removes `BASH_ENV`/`ENV`/`SHELLOPTS` wholesale; `--noprofile --norc` stops rc files; `TERM` is pinned so `tput` answers from a terminfo entry the harness chose; `PATH` is pinned so `clear`/`tput`/`cat`/`sleep` are the system's. It also makes the shell deterministic even if LaunchServices hands the file to the owner's zsh instead of honouring the shebang. Proof **R12** |

## Revert proofs, round 1

Same method: mutate in place, run the targeted test files, restore, `cmp`. All twelve restored
byte-identical.

| # | Mutation | File | Result |
|---|---|---|---|
| R1 | the READY anchor dropped (`includes(" READY")` alone) — the corrected M3 | `guard.ts` | 2 failed / 31 |
| R2 | the old order: placement written before the wait | `run.ts` | 5 failed / 76 |
| R3 | a position off the display reported as `DISPLAY_TOO_SMALL` again | `cases.ts` | 2 failed / 98 |
| R4 | a window larger than the display reported as a position problem | `cases.ts` | 2 failed / 23 |
| R5 | no settling sleep before the `tput` reads | `stage.ts` | 1 failed / 50 |
| R6 | the size token loses its closing sentinel | `stagedTitle.ts` | 3 failed / 126 |
| R7 | `READY` becomes a prefix again (separator dropped) | `stagedTitle.ts` | 1 failed / 31 |
| R8 | the display's real scale ignored | `stage.ts` | 3 failed / 126 |
| R9 | `displayScale` dropped from the results file | `results.ts` | 1 failed / 16 |
| R10 | a window title leaked into the TERMINAL path's `sizeAsStaged` | `run.ts` | 1 failed / 16 |
| R11 | the heredoc guard blind to the first line again | `stage.ts` | 1 failed / 50 |
| R12 | the script no longer re-execs in a clean environment | `stage.ts` | 1 failed / 50 |

## Results fields, updated

One field added since round 0: **`displayScale`** (per repetition and per toolbar/observe row) — the
`scaleFactor` Electron reports for the display nearest the staging position. `scale` keeps its
meaning (the inferred integer factor) and is now the cross-check. Both key-set tests were updated to
pin the new name, so a field arriving or disappearing without a diff still fails.

## Byte checks, round 1

33 files of `src/readerEval/**` plus `scripts/reader-eval.*`: no control byte other than TAB/LF,
`file(1)` reports every one as text, and the escapes that must stay escapes are intact on disk
(`score.ts` `\\u001C-\\u001F`, `stage.ts` `['\\u0000-\\u001F]` and the heredoc guard's `\n`).
`scripts/reader-eval.mjs` now builds its own newline with `String.fromCharCode(10)` rather than
holding an escape in the two hint strings. The real `.command` was rendered from
`terminalScript` (through a temporary test, since removed — the tree is clean) and parses under
`bash -n`; the ready line reads
`printf '%s%sx%s%s' '<ESC>]0;CLAVE-EVAL terminal-narrow <nonce> READY ' "$CLAVE_COLS" "$CLAVE_ROWS" '.<BEL>'`.
It was never executed.

## Still only a screen can decide (unchanged, plus two)

- Whether SCK's `contentRect` matches Chrome's outer bounds: if it ever carried an inset larger than
  the 4 px tolerance, EVERY case would report `sizeAsStaged: false`. That is fail-closed and
  diagnosable — `stats.widthPx/heightPx`, `staged` and now `displayScale` are all in the file — but
  the owner should read those numbers before concluding "Chrome still ignores the flags".
- Whether 0.4 s is enough settling for `TIOCSWINSZ` to reach the shell. Too short shows up as
  `sizeAsStaged: false` on a window that looks right; the constant is one number in `stage.ts`.
---

# Repair loop 2 — after three staged runs on the real screen (2026-09-21)

**H1 is closed, and it was not the flags.** The cause was the owner's tiling window manager
(yabai 7.1.25) re-tiling every new window; with his runtime rules excluding eval and Terminal
windows, all 16 Chrome cases came back `ok` and `sizeAsStaged: true` at exactly 1160 x 640 px
(scale 1, main display external 2560 x 1440), second-read `cacheHit` 18/18, and both terminal cases
found their markers (READY works; accuracy 0.9941 both). The three repairs of round 0 were therefore
not what fixed the size — but they are what makes the next run legible, and the placement/wait/flags
set stays as defence in depth. **Neither of the two hypotheses in the round-0 report was right**; the
window manager was a third nobody had weighed, and it is recorded here so the next reader does not
re-argue Chromium's source.

Totals: harness folder **754 tests in 17 files** (was 698), whole repo **1906 in 87 files**,
`typecheck` clean. Twenty revert proofs this loop, every one biting, every restore `cmp`-identical —
including two that did NOT bite at first and exposed real coverage gaps (below).

## P1 — both terminal cases said "not as staged" with captures that looked right

Measured: `terminal` (140 x 40 cells) captured 1560 x 967 px on the 1x display; `terminal-narrow`
(72 x 40) captured 1624 x 1800 px, i.e. it opened on the 2x display. Both plausible for the staged
cells — so the READY token's numbers, not the window, were wrong, and the file could not say.

**(a) The numbers are now recorded**: `readyColumns` and `readyRows` per repetition, read back out
of the title by `readySizeIn` (`stagedTitle.ts`). This is the one place in the harness where a number
is parsed out of a window title, and the doc comment says why the exception exists and what bounds
it: the substring is located by `readyMark(stagedTitle)` (this case, this nonce), it ends at the
closing sentinel, only digits are accepted with one `x` between them, each number must be a whole
number in [1, 1000], and it is both numbers or neither. `sizeAsStaged` for a terminal is now that
comparison rather than a substring test. Proofs **L1–L4**.

**(b) The script asks the tty instead of guessing, and polls.** After the two resizes it loops up to
15 x 0.2 s (`TERMINAL_SIZE_TRIES`, `TERMINAL_SIZE_POLL_SECONDS`) until the size equals the staged
cells, and only then prints the page and the READY title — with whatever the last answer was.
Proofs **L5, L6**.

**Why `tput` could have answered 80 x 24, and what replaced it.** `CLAVE_COLS=$(tput cols)` runs
inside a command substitution, so `tput`'s stdout is a PIPE, not the tty: ncurses asks `TIOCGWINSZ`
on that fd, the ioctl fails, and it falls back to the terminfo entry's static 80 x 24 — and the
`env -i` re-exec added in fix round 1 had (rightly) removed the `COLUMNS`/`LINES` that would
otherwise have covered for it. That is the most plausible reading of these two false negatives. The
script now reads `stty size < /dev/tty`, which takes its ioctl from **stdin**, explicitly the tty, so
the substitution's pipe cannot reach it; `tput` remains only as a last resort when `/dev/tty` is
absent, with its caveat recorded in the comment — a reported 80 x 24 is the signature of exactly this
failure, and the results now carry the numbers to show it.

## P2 — the first Chrome case of a run was `notStaged` in two of three runs

`chromeWaitMs` ≈ 20 ms, no `stageMs`, nothing read: the window never came to the front.

- **One automatic re-stage.** A `notStaged` Chrome staging is torn down, waited out, re-prepared
  (placement written after the wait, as fix round 1 requires) and opened again, once. A re-staged
  repetition is an ordinary repetition of a fresh window, never a second read of the same staging —
  a test asserts exactly two reads in total (the scored one and the cache probe). Terminal cases are
  NOT re-staged: this harness never kills Terminal, so a second window would carry the same staged
  title and the guard could approve the failed attempt's window. Proofs **L7, L8, L10**.
- **`stageAttempts`** per repetition and per toolbar row: 1, or 2 when a re-stage happened.
- **A more generous wait for the first Chrome window of a run.** The guard's ordinary timeout is
  `GUARD_TIMEOUT_MS` = **15 s** and is unchanged; the first Chrome staging of a run now gets
  `FIRST_STAGE_GUARD_TIMEOUT_MS` = **30 s** (`run.ts`), decided by a run-scoped counter
  (`RunDeps.progress`) that `runAccuracy`/`runToolbar` create once for the whole run. Proofs **L9**,
  **L9b**.

## P3 — a staged window may not be on the display `displayScale` came from

The run of 2026-09-21 put `terminal` on the 1x display and `terminal-narrow` on the 2x one, and the
harness places neither. So: Chrome rows keep `displayScale` from the display nearest `--position`;
**terminal rows carry `displayScale: null`**, and their `scale` is null too — a capture cannot be
turned into cells without a font nobody here knows, so there is no inference to make. Observe rows
(the owner's own windows) carry `null` as well. Proofs **L11, L12**.

## The four deferred items

| # | Done |
|---|---|
| N1 | `main.ts`'s display wiring pinned off its source, in the style already used for the helper lifecycle: the display comes from `getDisplayNearestPoint({x: position.xPt, y: position.yPt})`, `getPrimaryDisplay` appears nowhere, `workArea`/`scaleFactor` are taken from that display, the refusal happens before `createPageServer` and `spawnHelper` and is written as a fixed code, and `displayScale` reaches `runMode` |
| N2 | **Negative coordinates accepted** in both parsers, bounded −20000..20000 (`POSITION_MIN_PT` in `config.ts` and in `reader-eval.mjs`), because a display left of or above the primary one has negative coordinates — which is the owner's arrangement and the one `--position` exists for. A lone `-`, `+40`, `3.2` and everything else in the old refusal table still refuse. The usage text says so |
| N3 | `HINTS` is asked with `Object.prototype.hasOwnProperty.call`, so a code of `constructor`, `toString` or `__proto__` prints no hint |
| N4 | `-- ` before `"$0"` in the re-exec, and the clean flag is compared `!= "1"` rather than tested for emptiness |

## Revert proofs, repair loop 2

Same method: mutate in place, run the targeted test files, restore, `cmp`. All restores identical.

| # | Mutation | File | Result |
|---|---|---|---|
| L1 | `readyColumns` dropped from the results file | `results.ts` | 1 failed / 16 |
| L2 | the ready size parsed with no upper bound | `stagedTitle.ts` | 4 failed / 74 |
| L3 | the size token read past its closing sentinel | `stagedTitle.ts` | 4 failed / 74 |
| L4 | a half-read token reported as a size | `stagedTitle.ts` | 9 failed / 74 |
| L5 | the shell asks `tput` down a pipe again instead of the tty | `stage.ts` | 2 failed / 74 |
| L6 | the shell stops polling for the staged size | `stage.ts` | 1 failed / 74 |
| L7 | no re-stage for a Chrome window that never came to the front | `run.ts` | 3 failed / 90 |
| L8 | `stageAttempts` always 1 | `run.ts` | 2 failed / 90 |
| L9 | the first staging gets the ordinary timeout | `run.ts` | **first run: 0 failed** → gap closed → 2 failed / 92 |
| L9b | the generosity given to every staging instead of the first | `run.ts` | 1 failed / 92 |
| L10 | a terminal case re-staged too | `run.ts` | 1 failed / 90 |
| L11 | a terminal row claims the Chrome display's scale | `run.ts` | 1 failed / 90 |
| L12 | an observe row claims the staging display's scale | `run.ts` | **first run: 0 failed** → gap closed → 1 failed / 92 |
| N1 | `main.ts` asks the primary display again | `main.ts` | 2 failed / 35 |
| N2 | negative coordinates refused again (bundle side) | `config.ts` | 6 failed / 52 |
| N2b | negative coordinates refused again (CLI side) | `reader-eval.mjs` | 4 failed / 82 |
| N3 | the hint table asked without an own-property check | `reader-eval.mjs` | 1 failed / 82 |
| N4 | the clean-shell flag tested for emptiness, and no `--` | `stage.ts` | 1 failed / 74 |

**The two gaps the proofs found, and how they were closed.** L9 did not bite because the test read an
ABSOLUTE clock across both staging attempts — with a 15 s timeout twice, the largest reading still
passed a "greater than 15 s" assertion. It now measures the FIRST attempt only (asks are recorded
while exactly one `open` has been issued), and `guardTimeoutFor` is exported and tested directly:
first Chrome staging → 30 s, later ones → the guard's own default, a terminal → never, and a caller's
explicit timeout always wins. L12 did not bite because no test drove an observe ROW at all — the one
that claimed to ran `runObserve` for zero seconds and asserted an empty list. It now stages an
observe case through the guard and asserts the row's `displayScale`, `stageAttempts` and
`chromeWaitMs` are all null.

## Results fields, updated

Three added this loop: `readyColumns`, `readyRows` (per repetition; terminal only) and
`stageAttempts` (per repetition and per toolbar row). Both key-set tests pin the new names, and the
sentinel run — which since fix round 1 drives a terminal case — now asserts that the two numbers were
really taken from a title whose tail is a sentinel, so "no sentinel reached the file" is a statement
about this path too.

## Byte checks, repair loop 2

33 files of `src/readerEval/**` plus `scripts/reader-eval.*`: no control byte but TAB/LF, `file(1)`
reports every one as text, the escapes that must stay escapes are intact on disk (`score.ts`
`\\u001C-\\u001F`, `stage.ts` `['\\u0000-\\u001F]` and the heredoc guard's `\n`), and every control
character in generated output is still built with `String.fromCharCode`. Both `.command` scripts
(140 x 40 and 72 x 40) were rendered from the real `terminalScript` through a temporary test, since
removed — the tree is clean — and both parse under `bash -n`. Neither was executed.

## What still only a screen can decide

1. Whether `stty size < /dev/tty` answers the staged cells at all — i.e. whether Terminal honours the
   xterm resize sequence. If it does not, `readyColumns`/`readyRows` will now say what it did give
   (and 80 x 24 exactly would instead mean the `tput` fallback ran), and the terminal group is
   incomplete rather than silently wrong.
2. Whether 3 s of polling is enough for `SIGWINCH` to reach the shell on a busy machine.
3. Whether the single re-stage is enough for the first Chrome window, and whether 30 s is the right
   generosity — `stageAttempts` and `stageMs` answer both in the next run's file.
4. Whether the window manager's new rules hold for every staged window, including the two Terminal
   ones (the 2026-09-21 run staged them on two different displays, which is the owner's environment
   and not something this harness can control).
---

# Fix round 2 — after review C

APPROVED WITH ONE IMPORTANT; the Important and all six Minors are fixed. Harness folder **766 tests
in 17 files** (was 754), whole repo **1918 in 87**, `typecheck` clean. Ten revert proofs, all
biting after three of them exposed untested points (below), every restore `cmp`-identical.

**I1 — a re-staged accuracy row reported the FIRST attempt's `chromeWaitMs`.** `fixed` captured the
wait before the re-stage and was never rebuilt when `staging` was replaced, so a row could carry the
second attempt's `stageMs`/`stageAttempts` beside the first attempt's wait — the same field meaning
two different things in two row types of one file, and `chromeWaitMs` is precisely the number P2 was
diagnosed from. `chromeWaitMs` is now a getter reading the CURRENT staging (`run.ts`), so it is
resolved at each spread. The reviewer's world is now a test on both paths: the old Chrome is gone for
the first staging (one `pgrep`, 0 ms) and alive for two polls of the second (200 ms) — an accuracy
row and a toolbar row both come back `stageAttempts: 2`, `outcome: "ok"`, `chromeWaitMs: 200`, plus a
third test that a single-attempt row still reports its own wait. Proof **C1**.

| # | Minor | Fix |
|---|---|---|
| M1 | a missing `/dev/tty` would have bash — not `stty` — print 15 error lines into the staged window, because redirections apply left to right | `$(stty size 2>/dev/null < /dev/tty)`, with a test pinning that `2>/dev/null` comes first (proof **C2**) |
| M2 | the generous 30 s wait was per PART, not per run: `runMode` let each part mint its own counter | `runMode` mints ONE counter and hands it to all three parts; the test drives a whole `all` run through a fake window server and asserts that exactly one staging in the run polled past the ordinary timeout (proof **C3**) |
| M3 | a caller with no counter made EVERY Chrome staging generous | a missing counter now means "not the first" (`?? 2`), so `runAccuracy`/`runToolbar` are the only source of generosity (proof **C4**) |
| M4 | `0072` was silently normalised to `72` | a leading zero on a multi-character count is refused — the shell never prints one, so a padded number is not ours (proof **C5**) |
| M5 | three fields were added and `schema` stayed 1 | bumped to **2**, the type demands it, `main.ts`'s literal is pinned off its source and every fixture updated (proof **C6**) |
| M6 | `readySizeIn`'s tests lived in `stage.test.ts` | moved to `stagedTitle.test.ts`, beside the function the privacy ruling singled out; the script-side tests stay with the script |

**Three proofs did not bite at first, and each was a real gap**, closed by strengthening rather than
by arguing: **C1b** (the `displayScale` getter) could not bite because neither `cells` nor
`displayScale` can differ between two attempts at one staging — so it is a plain value again, and
the only getter left is the one a test can tell from a constant; **C3** had no behavioural test of
`runMode`'s sharing, and now has the whole-run timeout measurement above; **C6** was caught only by
`tsc` (the type is `2`), and now also fails a source-shape assertion in a test run.

**Byte checks:** 33 files, no control byte but TAB/LF, `file(1)` reports every one as text, the
escapes that must stay escapes are intact, and the rendered `.command` (72 x 40, real truth file)
parses under `bash -n` with `CLAVE_SIZE=$(stty size 2>/dev/null < /dev/tty)` at line 15. The
temporary rendering test was removed; the tree is clean. Nothing was executed.

**Not changed, deliberately:** the reviewer's nit about `set -- $CLAVE_SIZE` being glob-expanded as
well as word-split. `stty size` can only print digits and a space, and anything else is refused by
the bounded parser, so a `set -f` would add a line to the generated script for a case that cannot
arise; it is recorded here rather than coded. The `wholePoint("-0")` observation is likewise noted
only: both parsers agree and both render it as `0`.
**Shake-down #5 follow-up (2026-09-21).** Everything staged as asked except `terminal-narrow`, whose
shell reported **72 x 37** for a staged 72 x 40: Terminal opened that window on the owner's built-in
2560 x 1600 Retina panel, whose work area cannot hold 40 rows of his Terminal font, while `terminal`
(140 x 40, external display) reported exactly 140 x 40 — the `stty` poll and `readyColumns`/
`readyRows` of repair loop 2 made that one look rather than one more run.

Fix, staging only: **both terminal cases are now 30 rows** (140 x 30 and 72 x 30, `cases.ts`
`TERMINAL_WIDE`/`TERMINAL_NARROW`), a height both of the owner's displays can hold — this harness
neither sizes nor places a Terminal window, so it cannot choose which display it opens on. The
narrow case's point is the COLUMN count (spec 10.1 item 15's "a narrow terminal"), never the rows;
`terminal.txt` is 12 lines plus two markers into a freshly cleared screen, so 30 shows all of it
without scrolling, and the comment records the measurement.

Nothing else assumed 40: a grep found the number only in `cases.ts`, one stale line of prose in
`stage.ts` (now 30) and test fixtures that supply their own sizes. A new test pins both pairs and
that the two differ only in columns; reverting the rows to 40 fails it (proof **D1**, restore
`cmp`-identical). Harness folder **767 tests in 17 files**, whole repo **1919**, `typecheck` clean.
---

# Toolbar notStaged — first real toolbar run (nonce 38f0f465d288, 2026-09-21)

All 40 rows `notStaged`, `stageAttempts: 2`, `chromeWaitMs` ≈ 312, no `stageMs`, 24 minutes; normal
and incognito alike, while the SAME session's accuracy mode was perfect (90/90, as staged,
ACCEPTED). So Chrome staging, the placement, the guard, the nonce and the title grammar all work —
in the accuracy path.

## What I read, and what it exonerates

I diffed the two paths end to end. They differ in exactly three things: the URL's **host**
(`127.0.0.1` vs one of four `*.localhost` names), `--incognito` (half the cases; the normal half
failed too, so it is not the cause), and the case NAME (long, dotted:
`incognito-mybank.example.localhost-ticket-dark-14`, a 73-character staged title against 37).

Exonerated **by test**, not by reading:

- **The title round trip, for all 40 cases.** A new parametrised test builds each toolbar case's URL
  with the real `pageUrl`, parses it, and asserts the `stagedTitle` parameter decodes to exactly
  `stagedTitleFor(case, nonce)`, that the server's own gate (`acceptStagedTitle`) returns it
  unchanged, and that the real `approve` accepts a window carrying it. Dots and length change
  nothing.
- **The page server, asked the way a toolbar case asks.** A real HTTP request on a loopback port
  carrying `Host: mybank.example.localhost:<port>` is answered **200** with that case's whole title
  in the `<title>`. The server ignores the Host header (`new URL(request.url, "http://127.0.0.1")`),
  so the four hosts were never a routing problem.

## The defect I did find — evidence vs inference

**Evidence (provable without a browser):** `createPageServer` bound **`127.0.0.1` only**, while every
toolbar URL is a `*.localhost` hostname. Chromium resolves those itself and `ResolveLocalHostname`
answers **::1 first**, 127.0.0.1 second; the accuracy path never touches IPv6 because it asks for the
literal IPv4 address. A test now demonstrates the asymmetry directly: the same request that is
answered on `127.0.0.1` was refused on `[::1]` at the same port.

**Inference (and its counter-evidence):** whether that asymmetry is what produced the 40 rows is NOT
proved. The controller's probe showed Chrome fetching `app.clave.localhost:8765` from an IPv4
loopback python server (200), which means Chrome does fall back to IPv4 for these names — so the
browser probably survived the refused ::1 attempt. I am recording this as a *candidate*, fixed
because it is a real hole and cheap to close, not as the cause.

**Fix (test-first):** the page server now binds **both loopback families on one port** — 127.0.0.1
and ::1, each named explicitly (never `0.0.0.0`, never `::`, so the staged pages stay off the
network). The IPv6 socket is best-effort: a machine without an IPv6 loopback leaves `ipv6: false`
and a run that behaves exactly as before. Proof **E1**.

## The diagnostics that will decide it in one run

`notStaged` was one word for four situations. Four fields now take it apart, on accuracy rows and
toolbar rows alike (booleans and numbers only):

| field | source | what it separates |
|---|---|---|
| `frontAppSeen` | the guard's own observation at any poll | no window of ours in front at all vs somebody else's window |
| `stagedTitleSeen` | the front title carried this harness's prefix (any case, any run) | our browser on a page that is not ours (a connection error carries the HOST as its title) vs our page under another case's title |
| `pageRequests` | the page server's counter for THIS case's staged title | **whether the browser ever asked for the page** |
| `pageStatus` | the last status that request was answered with | a 404 vs a 200 that still did not become a title |

Read together they decide the next run without argument: `pageRequests: 0` puts the failure BEFORE
the page — the URL, the host or the launch — and `pageRequests: 1, pageStatus: 200` with
`frontAppSeen: true, stagedTitleSeen: false` puts it after it, in the title or the window server.
The guard's rule is untouched: `approve` is byte-for-byte what it was, the two booleans are
observations on the way out of a refusal, and no title is kept — `stagedTitleSeen` is one `includes`
against a constant this harness owns. Proofs **E3–E7**.

The server's counters are keyed by the title `acceptStagedTitle` returns, so a request carrying
anything else is counted under the fixed fallback name and never under itself: nothing from outside
is stored. Proof **E2**.

## Totals and proofs

Harness folder **822 tests in 17 files** (was 767), whole repo **1974 in 87**, `typecheck` clean, no
control byte in any of the 33 topic files. Eight revert proofs, all biting after one (**E6**) exposed
a gap — it covered only the toolbar path's use of the counters, and now covers the accuracy path's
too — every restore `cmp`-identical. Nothing was run: no bundle, no harness, no generated script.

**If the next run still shows 40 `notStaged`**, the four fields say which half to look in, and the
remaining suspect on the title side is the one thing no test here can reach: whether the window
server truncates a 73-character title (dev report section 6, unknown 10). That would show as
`frontAppSeen: true`, `stagedTitleSeen: true`, `pageRequests: 1`, `pageStatus: 200` — our page, our
prefix, and still no match — and the repair would be to shorten the toolbar case names.
## `--limit <n>` — a short run that can never be accepted

Added so the next toolbar run decides the cause in two minutes instead of twenty-four. `1..1000`,
validated in BOTH parsers with the same hand-rolled digit rule as `--position` (no regex):
`countArg` in `scripts/reader-eval.mjs` and `parseLimit` in `config.ts`, with the environment
variable `CLAVE_EVAL_LIMIT` **refused** when it is set and unreadable (`BAD_LIMIT`) rather than
defaulted — it decides what was measured, exactly like the variant and the position.

**The order.** Accuracy cases are taken in table order. Toolbar cases are taken **interleaved** —
normal, incognito, normal, incognito — by zipping the twenty of each mode by index, so `--limit 4`
is two normal windows and two incognito ones. The table itself is twenty normal followed by twenty
incognito, which would have given four normal windows and measured nothing about the private badge.
The interleaved order is used for EVERY toolbar run, limited or not, so a limited run is a strict
prefix of the run the owner would otherwise have made.

**It can never be an acceptance run.** `summarise` takes a `limited: {reason: "LIMITED", cases, of}`
and its presence alone makes `accepted` false — every verdict inside is still computed and still
reported, because the numbers are the point, but three passing groups of four cases are not the
acceptance the spec asks for. Exit code 2 follows from `exitCodeFor`, unchanged. The terminal side
prints, above the verdict:

```
LIMITED RUN: 4 of 40 cases — not an acceptance run
```

`schema` is **3** (the summary gained `limited`).

Six revert proofs, all biting after one (**F6**) exposed a gap — nothing asserted that the serialiser
writes the `limited` block, which it now does: F1 a limited run with perfect rows accepted again
(2 failures), F2 toolbar cases taken from the top instead of interleaved, F3 the limit ignored by
the accuracy part, F4 a bad limit defaulted instead of refused (9 failures), F5 no `LIMITED RUN`
line, F6 the block dropped from the file. Every restore `cmp`-identical.

Harness folder **864 tests in 17 files**, whole repo **2016 in 87**, `typecheck` clean, no control
byte in any of the 33 topic files. Nothing was run.
---

# Loop 3 fix round — the toolbar cause, found by the diagnostics

**The two-minute run decided it** (`toolbar --limit 4`, nonce 3ef68102fca6): four rows `notStaged`
with `frontAppSeen: true`, `stagedTitleSeen: true`, `pageRequests: 2`, `pageStatus: 200`,
`stageAttempts: 2`. The page was fetched on both attempts and answered 200, Chrome was in front, a
title carrying our prefix was on it — and `approve` still refused, which can only mean the reported
window title did not CONTAIN the whole staged title. Accuracy titles are ~37 characters and match;
a toolbar title was `CLAVE-EVAL incognito-mybank.example.localhost-ticket-dark-14 <nonce>`, 73. So
my IPv6 candidate was NOT the cause (review D's host hypothesis was not either — the page was
fetched), and the shortening is Chrome's or the window server's: review D checked that the native
reader copies `kCGWindowName` whole with no cap.

**A — the title carries a short id.** `CLAVE-EVAL <id> <nonce>`, id = one letter for the table plus
two digits for the position in it (`a07`, `t13`, `o02`), built in `cases.ts` from the three tables
and used by every staging and by the observe URLs. Results keep the full case NAME; the table is the
mapping, so an observe case's browser and its private/normal expectation are still recovered from
the id and never from free text. A name in no table throws (`EVAL_UNKNOWN_CASE`) rather than falling
back to its long self. Ids cannot prefix-collide: they are fixed width (pinned), and the staged
title puts a space and the nonce after them (pinned as well). Every staged title is now 27
characters against a cap of `STAGED_TITLE_MAX` = 40, pinned for all 78 cases of the three tables.
Proofs **G1**, **G2**.

**B — the evidence number.** `refusedTitleLength`: the length of the longest title OUR app carried,
with OUR prefix on it, that `approve` still refused; `null` when that never happened, bounded to
`REFUSED_TITLE_LENGTH_MAX` = 10 000. A length at or near 27 next time says the title was not
shortened and the cause is elsewhere; a length well below it says something cut it. Proofs **G3**,
**G4**.

## Review D

| # | Fix | Proof |
|---|---|---|
| I1 | The page server takes a MATCHED PAIR of loopback sockets or none: on a `::1` failure both are closed and the pair is retried on a fresh port, bounded (`PAGE_SERVER_TRIES` = 5), and a run that cannot have both is refused with the fixed code `PAGE_SERVER`. The IPv4 result is checked too (Minor 2) — a failed bind used to leave `port = 0` and stage every window at `http://host:0/`. The fact is recorded as `pageServerIpv6` in the file | G6, G7 |
| I2 | The counter map is PRE-SEEDED with this run's own staged titles (and the fixed fallback) and takes no other key, so it is exactly as big as the case table. `isStagedTitle` is a prefix test with no nonce and no length cap, which is what made the old map unbounded | G8 |
| I3 | E2 is replaced by a proof that bites for the claimed reason: four foreign titles — including our own grammar with another run's nonce, and a 4 000-character one — are sent to the real server and none of them is retrievable through `served()`; the one that fails the page's own gate is counted under the fallback, the three that pass `isStagedTitle` are counted nowhere | G8 |
| I4 | The wiring is pinned: the page counters are asserted on a SUCCESSFUL accuracy repetition and a successful toolbar row, and `main.ts`'s source is asserted to hand `pageStats`, to seed the titles, to record `pageServerIpv6` and to title windows with the short id | G9, G10 |
| M1 | `stagedTitleSeen` (and the new length) are gated on the app as well, so a text editor showing this report cannot set them | G5 |
| M4 | `--limit` in `observe` or `coldstart` is refused with the fixed code `LIMIT_NOT_APPLICABLE`, in both parsers, instead of printing `LIMITED RUN: 0 of 0` | G11 |
| M5 | A zero-padded `--limit 04` is refused in both parsers, as `boundedCount` already refused one | G12 |
| M6 | `serialiseResults` writes the literal `"LIMITED"`; a smuggled reason cannot reach the file | G13 |
| M3, M7 | The counters' one weakness (a local process that knows the nonce can add to a count) is stated beside the interpretation table; the `limited` JSDoc is aligned | — |

## Totals and proofs

Harness folder **908 tests in 17 files** (was 864), whole repo **2060 in 87**, `typecheck` clean, no
control byte in any of the 33 topic files. Thirteen revert proofs, all biting after two (**G7**,
**G13**) exposed real gaps — nothing asserted that the serialiser writes `pageServerIpv6`, and
nothing distinguished a written `"LIMITED"` from a copied one; both now do. Every restore
`cmp`-identical. Nothing was run: no harness, no bundle, no generated script.

**What the next run will say.** If the short titles were the cause, the toolbar rows come back `ok`
with `sizeAsStaged: true`. If they were not, the rows come back `notStaged` again with
`refusedTitleLength` — and a value of 27 would mean the whole staged title WAS on the window and the
guard's substring test still failed, which would leave the window server reporting a different title
from the document's, the last suspect standing.
---

# Loop 3 fix round 2 — after re-review D

Both Importants and all five Minors closed. Harness folder **924 tests in 17 files** (was 908),
whole repo **2076 in 87**, `typecheck` clean, no control byte in any of the 33 topic files. Twelve
revert proofs, all biting after one (**H9**) exposed a hole the mutation could not reach, every
restore `cmp`-identical. Nothing was run.

**Important 1 — the `PAGE_SERVER` refusal reaches the file as its own code.** `createPageServer` was
called from an IIFE outside the `try`, so its throw fell to the catch-all and the file said
`{"error":"HARNESS","code":"HARNESS"}` — the owner could not tell a loopback-pair refusal from any
other throw, in the one failure that means another local process may be receiving the staged URLs.
It is now caught at the call, writes `code: PAGE_SERVER` from the imported constant (which the diff
had imported and never used), and the terminal prints what it means. Pinned by a source-shape test
beside the other four and by a `HINTS` test. Proofs **H1**, **H2**.

**Important 2 — `refusedTitleLength` is walked end to end.** The number this loop says will decide
the next run could be hard-nulled in four places with 908/908 green. Now: a `notStaged` accuracy
repetition and a `notStaged` toolbar row are driven through a front window that is ours and carries
our prefix with a title cut to 20 characters, and each asserts the number on the row; and the
serialiser is round-tripped on both row shapes, including 0 as a value rather than an absent field.
All four of the reviewer's reverts fail: **H3**, **H4**, **H5**, **H6**.

**And the key-set pins now cover TOP-LEVEL fields**, which is how `pageServerIpv6` could be dropped
from the serialiser unnoticed: the file's own field list and the summary's are pinned by name.
Proof **H7**.

| Minor | Fix | Proof |
|---|---|---|
| 1 | `createPageServer` takes an injectable `listen`, so the IPv4-bind branch — unreachable on this machine — is tested: a first bind that fails is retried, a bind that always fails is refused with the fixed code, and the retry count is exactly `PAGE_SERVER_TRIES` | H8 |
| 2 | `server.ts`'s two stale paragraphs rewritten: the IPv6 socket is no longer "best-effort", and `ipv6` is documented as always true on a server the function returns | — |
| 3 | `stagedTitles` is REQUIRED, and an empty list is refused at run time as well — every counter reading zero is exactly the "the browser never asked for the page" conclusion the counters exist to reach | H9 |
| 4 | `STAGED_TITLE_MAX` is enforced where a title is minted (`EVAL_TITLE_TOO_LONG`) and pinned to the literal 40, so raising it no longer passes | H10, H11 |
| 5 | The `limited` JSDoc is aligned for real (`/**` was at six spaces; it is at four, with its continuation at five) — checked on the bytes this time, not by eye | — |
