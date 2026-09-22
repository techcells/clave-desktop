# Task 8 — `reader:eval`, the staged-window evaluation harness (development report)

Plan C-2b-1, task 8. Built and unit-tested in the scratch working copy
(`$S/ws/app`). **It has never been run against a screen**, by design: that happens later, with the
owner present. Everything below was proved against fakes, a loopback HTTP server, and one real
`node scripts/build.mjs` in the copy.

Real repo (`/Users/sardorastanov/techcells/asset-to-evidence`) untouched — verified: no
`app/src/readerEval`, no `app/reader-eval`, no `app/dist/reader-eval.cjs` there, and `app/dist/`
still carries its 15:28 timestamps.

---

## 1. Files

### New: `app/reader-eval/truth/` (5 files)

| File | Job |
|---|---|
| `chat.txt`, `ticket.txt`, `code.txt`, `pt.txt`, `terminal.txt` | The phase-0 staged texts, the rulers every accuracy number is measured against |

**How they were made, because it matters.** Never retyped. Both were extracted mechanically from
the fenced blocks of `docs/superpowers/plans/2026-09-18-native-reader-phase0-spikes.md` (Task 1,
Step 2) by two independent scripts in two languages with two different algorithms — a line walk in
Node (`$S/task8-tools/extract-truth.mjs`) and one regex over the whole file in Python
(`$S/task8-tools/extract_truth_b.py`) — and the SHA-256 of both extractions compared. They agree
on all five:

```
266057a13b5e448a771f85a2e619d2169a45082be75e41330f845c6d98482209  chat.txt
cf6a381ea569ca7af69f75a478c9926eab7a74a01a75f1e027365e336b23ca3c  ticket.txt
cb626eaa30deb699773777c83552d17e5ce65d224908466fee7e05bf6e9d0dff  code.txt
01c7da18062f136f5d46b1839f29bcc1597cd06443b3e782f687efc2ee5f7316  pt.txt
31300e14e1120d043784f46e65ad2a9423cc6c66192f6217182eb42f1038e6be  terminal.txt
```

`truth.test.ts` pins those hashes, asserts the specific characters **by code point** (U+2713 `✓`,
U+276F `❯`, U+00D7 `×` in `terminal.txt`; U+00E7, U+00E3, U+00F5, U+00E9, U+00ED in `pt.txt`) and
asserts every file is NFC. No literal non-ASCII character is typed anywhere in the harness source or
its tests — the accented set in `score.ts` and every accented fixture are built with
`String.fromCodePoint`, precisely because the tooling in this pipeline has been measured decoding a
backslash-u escape into the character it names.

Note: the only accented letters actually present in `pt.txt` are `ã ç à á í ê ó õ é`. `â ô ú` and
every uppercase accent are in the scorer's set but not in the truth, so they are exercised by unit
tests only.

### New: `app/src/readerEval/` (13 modules + 1 test double + 14 test files)

| File | Job |
|---|---|
| `thresholds.ts` | Every number the run is judged against, each with the spec section it is quoted from, and the statement that an agent never lowers one |
| `score.ts` | `score.py` ported: NFC + whitespace-collapse `norm`, `lev`, `between`, `accuracy`, `accents`, plus `confusions` (single-character substitution pairs, max 5) |
| `pages.ts` | `make_pages.py` ported, with `.marker` opacity 1; `acceptStagedTitle`; the in-page script that takes theme, size and a `CLAVE-EVAL ` title from the query string |
| `server.ts` | The four staged pages on 127.0.0.1 on an ephemeral port, and nothing else |
| `cases.ts` | The case table: 18 accuracy cases, 40 toolbar cases, 10 observe cases, the fixed window box, the hosts and variants |
| `stage.ts` | Every staging command as data — the Chrome `open` line, the `pkill` pattern, the Chrome profile preference, the page URL, the Terminal `.command` script |
| `stagedTitle.ts` | `CLAVE-EVAL <case name> <run nonce>`, and what counts as one of ours |
| `guard.ts` | The privacy heart: `approve` (exact app + staged title substring) mints an `Approval` branded with a symbol this module does not export; `awaitStagedWindow` polls or gives up |
| `helper.ts` | Protocol 2 spoken directly to the helper; `readApproved` is the only read and takes an `Approval`; keeps `stats` and `lines`, which the product's parser strips |
| `run.ts` | The orchestration over injected deps: stage → guard → read → score → cache probe → tear down; toolbar facts; observe mode |
| `results.ts` | What may be written to disk, by type and by a hand-written serialiser that never spreads an input |
| `summary.ts` | Minimum, median, per-group verdicts (minimum, never median), toolbar counts, `accepted` |
| `main.ts` | The Electron entry (`dist/reader-eval.cjs`): no window, serve, spawn the helper next to the executable, refuse on protocol/grant, run the mode, write atomically, quit |
| `testing/fakes.ts` | Fake `HelperLink` that records every line sent, a manual scheduler, a scripted responder |

Test files: `truth`, `thresholds`, `score`, `pages`, `server`, `cases`, `stage`, `stagedTitle`,
`guard`, `helper`, `run`, `results`, `summary`, `imports`.

### New: `app/scripts/reader-eval.mjs`

The terminal half: parses the command line, checks the bundle and the entry exist, creates
`app/reader-eval/out/`, opens the bundle with `open -n -W … --env …`, prints the observe URLs when
the bundle has chosen its port, reads the results JSON, prints the table and the verdicts, exits
0/2/1.

### New: `app/scripts/reader-eval.test.ts` — **a deviation from the brief's file list**

The brief listed `app/scripts/reader-eval.mjs` but no test beside it. The script holds real logic
(argument parsing, the `open` argument list, the summary rendering, the exit code) and leaving it
untested would have been worse than the deviation. It is placed in `scripts/` rather than
`src/readerEval/` because `app/tsconfig.json`'s `include` is `src/**/*.ts`: a `.test.ts` in `src/`
importing a `.mjs` would fail `tsc`, while `scripts/**/*.test.ts` is already in vitest's include and
outside tsc's — the exact arrangement `scripts/dev-launcher.test.ts` (task 3) established. It
collides with no other agent's files.

### Modified (two small edits)

- `app/scripts/build.mjs`: one more esbuild entry point — `src/readerEval/main.ts` →
  `dist/reader-eval.cjs`, cjs, `external: ["electron"]`, mirroring `main.cjs`.
- `app/package.json`: `"reader:eval": "node scripts/build.mjs && node scripts/reader-eval.mjs"`.

`app/vitest.config.ts` and `app/tsconfig.json` needed **no** change: vitest already includes
`src/**/*.test.ts` and `scripts/**/*.test.ts`, and tsconfig already includes `src/**/*.ts`.

---

## 2. CLI usage text

```
usage: pnpm --dir app reader:eval -- <mode> [options]

  modes
    accuracy   the staged pages and the two terminals, scored (default)
    toolbar    40 Chrome stagings: address host and the private badge
    observe    watch for windows the OWNER stages by hand (Safari, private windows)
    all        all three, in that order

  options
    --repetitions <n>   reads per accuracy case (default 5)
    --seconds <n>       how long observe mode watches (default 120)
    --variant <name>    none | bookmarks-bar (default none)

  Nothing is read but a window this harness staged and identified by a one-run title.
```

Exit codes: **0** every acceptance check passed; **2** a shortfall; **1** a harness error, which
includes being called wrong, a missing bundle, a missing `dist/reader-eval.cjs`, `open` exiting
non-zero, no results file, an unreadable results file, and the bundle's own `PROTOCOL` / `NO_GRANT` /
`HARNESS` refusals.

Environment passed through `open --env`: `CLAVE_DEV_ENTRY=reader-eval`, `CLAVE_EVAL_MODE`,
`CLAVE_EVAL_OUT`, `CLAVE_EVAL_NONCE`, `CLAVE_EVAL_REPETITIONS`, `CLAVE_EVAL_SECONDS`,
`CLAVE_EVAL_VARIANT`.

---

## 3. The results JSON

Written atomically to `app/reader-eval/out/<mode>-<nonce>.json`. Either a refusal:

```json
{ "error": "PROTOCOL" | "NO_GRANT" | "HARNESS", "code": "<the same fixed code>" }
```

or the run:

```json
{
  "schema": 1,
  "mode": "accuracy" | "toolbar" | "observe" | "all",
  "nonce": "a1b2c3d4e5f6",
  "repetitions": 5,
  "chromeVariant": "none",
  "accuracy": [{
    "case": "chat-light-14",
    "group": "chat",
    "minAccuracy": 0.9983, "medianAccuracy": 1, "minAccents": 1,
    "incomplete": false,
    "confusions": [{"from": "`", "to": "'", "count": 3}],
    "repetitions": [{
      "outcome": "ok",
      "accuracy": 1, "markers": true, "accents": 1,
      "stats": {"captureMs": 89, "recogniseMs": 162, "cacheHit": false, "widthPx": 1268, "heightPx": 708},
      "repeat": {"cacheHit": true, "recogniseMs": 3}
    }]
  }],
  "toolbar": [{
    "case": "incognito-mybank.example.localhost-chat-light-14",
    "mode": "incognito", "expectPrivate": true, "outcome": "ok",
    "host": true, "hostBottomPx": 71,
    "private": true, "privateBottomPx": 70,
    "bandPx": 82,
    "toolbarTextLength": 52, "toolbarTextPresent": true, "lineCount": 18,
    "stats": { }
  }],
  "observe": [{ "…the same fields…", "app": "Safari" }],
  "summary": {
    "groups": [{
      "group": "chat", "threshold": 0.97,
      "min": 0.9983, "median": 1,
      "accentsMin": null, "accentsThreshold": null,
      "incompleteCases": [], "passed": true
    }],
    "toolbar": {
      "captures": 40,
      "hostHits": 20, "hostHitsMin": 19,
      "privateHits": 20, "privateHitsMin": 20,
      "falsePrivate": 0, "falsePrivateMax": 0,
      "incompleteCases": [], "passed": true
    },
    "accepted": true
  }
}
```

`outcome` is one of the closed list `ok | notStaged | noMarkers | windowGone | black | locked |
timeout | failed | down`.

**Nothing else can be in this file.** `serialiseResults` writes every field by hand, exactly as the
helper's own `stats_value` in `protocol.rs` does, so nothing spreads in. The only strings are case
names, group names, outcome codes, the mode, the variant, the run nonce this harness generated, and
the single characters of a confusion pair. There is no window title of any kind — not even the
harness's own staged one, which the brief permitted; the nonce carries the same information and
nothing else.

`observe-urls.json` is written beside it in observe mode, holding the port, the nonce and the ten
URLs the harness invented.

---

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Harness tests | `vitest run --root $S/ws/app src/readerEval scripts/reader-eval` | **15 files, 380 tests, all pass** |
| Whole suite in the copy | `vitest run --root $S/ws/app` | **84 files, 1412 tests, all pass** (includes the other agents' concurrent work; the copy's baseline was 913, and 1392 before my last two files) |
| Typecheck | `tsc --noEmit -p $S/ws/app/tsconfig.json` | clean |
| Typecheck (renderer) | `tsc --noEmit -p $S/ws/app/tsconfig.renderer.json` | clean |
| Build | `node $S/ws/app/scripts/build.mjs` | ran in the copy, wrote `$S/ws/app/dist`, touched nothing in the real repo |
| The new bundle | `ls dist/reader-eval.cjs` | present, 44 481 bytes |
| Syntax | `node --check dist/reader-eval.cjs` | OK |
| CLI, bad arguments | `node scripts/reader-eval.mjs nonsense` | printed the usage text, exit 1, opened nothing |

No `pnpm` was run against the copy. Nothing was opened, launched, killed or read. The only network
socket used in any test is a loopback HTTP server that `server.test.ts` starts and closes.

---

## 5. Mutations — every test shown to bite

Method: `cp` the file aside, apply the mutation, run the harness tests, watch them fail, restore,
`cmp` against the backup. All eleven backups compared **byte-identical** after restore, and the full
suite is green again.

| # | Mutation | Failing tests | Count |
|---|---|---|---|
| a | `guard.ts`: accept any title containing `CLAVE-EVAL`, whatever the nonce | `refuses another run's nonce`; `refuses another case of the same run`; `refuses the bare prefix`; `writes no read line when the right app carries another run's nonce`; `writes no read line when the right app carries another case of this run` | 5 |
| b | `guard.ts`: drop the app check | the five `refuses <app> …, whatever the title says` rows; `keeps polling while something else is in front, then gives up`; `writes no read line when the staged title is in the front window of the wrong app`; `refuses a staged title in the wrong app` | 8 |
| c | `helper.ts`: send `read` without `expect` | `is byte for byte the product's own encoding when it does not ask for lines`; `adds lines only when asked`; `always carries the approved window as expect`; `reads exactly the window the window server reported, field for field`; `never sends a read without expect` | 5 |
| d | `run.ts` returns `toolbarText` as a fact **and** `results.ts` spreads the toolbar case instead of writing its fields | `carries not one string the helper sent` | 1 |
| e | `results.ts`: drop `notStaged` from `INCOMPLETE_OUTCOMES` | `is incomplete when one repetition ended notStaged, however good the others were`; `is every outcome but ok`; `writes no read line at all when another app is in front` | 3 |
| f | `thresholds.ts`: chat 0.97 → 0.96 | `accuracy thresholds are exactly spec section 6's P4 row`; `chat and ticket are 0.97, not 0.96`; `passes when every case's worst read clears the threshold`; `fails on the threshold itself minus a hair` | 4 |
| g | `summary.ts`: group verdict on the median instead of the minimum | `is the MINIMUM over its cases, not the median` | 1 |
| h | `pages.ts`: `.marker` opacity back to `.6` | `shows the markers at full opacity` | 1 |
| i | `stage.ts`: teardown pattern → `"Google Chrome"` | `matches only a command line carrying this run's own profile flag`; `carries the whole flag, not just the path`; `escapes regex metacharacters in the path, so a dot is a dot`; `stages, reads, probes the cache, and tears down — once per repetition` | 4 |
| j | `pages.ts`: a served page adopts any title asked of it | `refuses to call itself anything but one of ours` + the four `acceptStagedTitle` refusal rows | 5 |
| k | `server.ts`: answer any path | `/chat is not` (the path allow-list) | 1 |

The mutation script is `$S/task8-tools/mutate.mjs` (`apply` / `restore` per name).

---

## 6. What was NOT verified, and could not be, without a screen

This is the honest list. Every item is a thing the owner-present run will find out, and several of
them will simply make the first run produce `notStaged` everywhere until they are adjusted.

**Staging**

1. **Chrome honouring `--window-size` and `--window-position`.** Phase 0 never passed these, and it
   recorded an *unexplained* width variance in its own run (630 px for 35 of 40 captures, 1268 px
   for 5). Whether `open -na "Google Chrome" --args …` forwards them to a second instance, and
   whether Chrome applies them to the `--new-window` it opens rather than only to a first window, is
   untested. If they are ignored, the fixed-size requirement of spec 10.1 item 15 is not met and the
   run's sizes must be read out of `stats.width/height` instead.
2. **Whether `--window-size` applies to an `--incognito` window** at all.
3. **Whether the staged page's `document.title` reaches the Chrome window title** in an incognito
   window the same way it does in a normal one.
4. **Terminal honouring `ESC[8;rows;cols t`.** Terminal.app's profile has a "window size" setting and
   an xterm-resize behaviour that a user can change; if the sequence is ignored, `terminal` and
   `terminal-narrow` stage at the same size and the narrow case measures nothing new.
5. **Terminal honouring `ESC]0;title BEL`.** This is the one that would break the run outright: the
   Terminal profile's "Title" settings can compose or override the window title. If the staged title
   does not appear in the window title *as a substring*, every terminal repetition records
   `notStaged` and reads nothing. The guard is right to refuse; the staging would need another way in.
6. **Terminal window accumulation.** There is no teardown for Terminal on purpose (killing Terminal
   would take the owner's own windows, and this session's, with it). The staged shell exits after
   `TERMINAL_HOLD_SECONDS = 40`; whether the window then closes depends on the owner's profile
   setting. A leftover window of the **same case** carries the **same** staged title, so repetition N
   could in principle read repetition N−1's window. Its pixels are identical, so the measurement is
   the same — and it would be visible in the results as `cacheHit: true` on the *first* read of a
   repetition, which never happens otherwise. Worth watching in the first run.
7. **`pkill -f '[-]-user-data-dir=<path>'` matching in practice.** The bracket trick is tested as a
   JavaScript regex against sample command lines; BSD `pkill`'s own ERE handling on this macOS is
   not. If it matches nothing, staged Chrome windows accumulate (it will never match the owner's
   Chrome — that half is what the pattern is for).
8. **Whether Chrome's second instance actually starts** when a previous one with the same
   `--user-data-dir` is still shutting down after a `pkill`. The 2 s settle plus the 15 s guard poll
   is a guess.

**The window server's answers**

9. **The exact `app` string the helper reports** for these windows — the guard compares it *exactly*
   against `"Google Chrome"`, `"Terminal"`, `"Safari"`. C-2a read real Chrome and Safari windows, but
   the literal owner-name strings were not confirmed by me. A mismatch means every repetition is
   `notStaged`.
10. **The exact `title` a Chrome window reports** — specifically whether macOS appends a suffix such
    as `" - Google Chrome"`. The guard uses `includes`, so a suffix or a prefix is harmless. What
    would break it is **truncation**: if the window server shortens long titles, the ~35-character
    staged title could be cut. Untested.
11. **Whether a Safari private window's title carries the staged title** at all (observe mode depends
    on it; Safari announces nothing about private windows in the title itself, which is exactly why
    carried item 29 exists).

**The helper's answers**

12. **`lines: true` on the real path.** The wire shape is pinned against `native/reader/src/protocol.rs`
    (re-read at the end of this task: request field `lines: bool`; answer `lines: [{text, topPx,
    bottomPx, leftPx, rightPx}]`; `stats.bandPx`), but no real read has ever carried boxes.
13. **Real `bandPx` values**, and therefore the whole of carried item 30 (a badge below the band).
    The harness makes it *visible* — `privateBottomPx > bandPx` with `private: false`, printed as
    `BELOW BAND` — but has never seen one.
14. **Chrome ever producing a real `toolbarText`** (carried item 36: it never has).
15. **`cacheHit` on a real second read** (carried item 27). Note a shape fact that only matters on a
    real run: a cache **hit** carries no `lines` and no `bandPx` (`ReadGeometry` in `scheduler.rs`),
    so a cached toolbar capture yields `host`/`private` from the strip and nulls for every pixel
    figure. Each toolbar case stages a unique URL, so a hit is not expected there.
16. **Real accuracy numbers on the Rust-greyscale path** — carried item 2 of the first-run record.
    This task builds the instrument; it measures nothing.

**The bundle**

17. **`CLAVE_DEV_ENTRY=reader-eval` end to end.** `resolveLaunch` is unit-tested (task 3) and
    `dist/reader-eval.cjs` now exists, but the bundle has never been launched with that switch and
    the path `open --env` → dev-launcher → `require(dist/reader-eval.cjs)` has never run.
18. **Whether an Electron app that creates no window stays alive.** `window-all-closed` should never
    fire with no window ever created, so `app.quit()` at the end should be the only exit — untested.
19. **Whether `open -n -W` returns only when the bundle quits**, which the terminal side's whole
    sequencing assumes.
20. **The grant actually reaching the helper spawned by `dist/reader-eval.cjs`.** It uses the same
    `join(dirname(process.execPath), "clave-reader")` path and the same `createChildHelperLink` as
    `src/shell/app.ts`, but from a different entry point.
21. **`*.localhost` resolution to an ephemeral port.** Phase 0 confirmed Chrome sends `*.localhost`
    to the loopback address, on a fixed port 8765. The port should not matter; it is untested.
22. **Timings.** The 2 s settle, the 15 s guard timeout, the 5 s read budget and the 40 s terminal
    hold are all reasoned guesses. A full `accuracy` run is 18 cases × 5 repetitions × (stage +
    settle + guard + 2 reads + teardown) — on the order of 15–25 minutes; `toolbar` is 40 stagings,
    perhaps 6–8 minutes. Neither has been timed.

---

## 7. Decisions taken on the owner's behalf, with the cost if wrong

1. **`noMarkers` is a sixth outcome that makes a case incomplete.** The brief named five
   (`notStaged`, `windowGone`, `black`, `timeout`, `failed`); this adds a read that came back without
   the staged page's own `STARTMARKER`/`ENDMARKER`. Phase 0 treated exactly that as a staging failure
   and re-staged rather than scoring it, and scoring a body that has no bookends measures an unknown
   window. *Cost if wrong:* a run where the recogniser drops one marker line reports the case
   incomplete instead of scoring a partial body — the owner sees a shortfall that a looser rule would
   have scored as a pass. (`locked` and `down` were added on the same reasoning.)
2. **The median of an even count is the lower of the two middle values,** not their mean, so every
   reported median is a number some read actually scored. *Cost:* a slightly pessimistic median for
   even counts. The default is five, which is odd.
3. **No teardown for Terminal.** *Cost:* staged Terminal windows are left for the owner to close.
   The alternative is killing Terminal, which takes every window the owner has open, including the
   one the evaluation was started from. See item 6 above for the residual risk.
4. **The cache probe reuses the approval** instead of asking the window server again. *Cost:* none
   for privacy — the `read` still carries `expect`, so a helper that finds anything else in front
   answers `windowGone` having captured nothing. If the window did change, `repeat` is simply `null`.
5. **`confusions` is computed from the WORST repetition of a case that fell short,** because that is
   the read the group's verdict was decided on. *Cost:* a different repetition's confusions might be
   more representative of the case as a whole.
6. **`observe` mode has no acceptance bar,** so an observe-only run always exits 0. No document sets
   a threshold for it, and it exists to *watch* the stagings a command line cannot make. Each row is
   printed with `as expected` or `NOT AS EXPECTED` against the expectation encoded in its case name.
   *Cost if wrong:* an observe run in which a Safari private window was not detected — carried item
   29, "the single most consequential unmeasured behaviour in the sub-project" — exits 0, and the
   owner has to read the row rather than the exit code. If the owner would rather it failed, that is
   one line in `summary.ts`.
7. **The harness speaks protocol 2 to the helper directly** rather than through `ReaderClient`,
   because the port's parser strips `stats` and knows nothing of `lines`, which are most of what is
   measured. It borrows `HelperLink`/`parseLine` and `createChildHelperLink` so the transport is the
   product's. `read` is encoded here rather than with `encode()` because of the evaluation-only
   `lines` switch, which `ToHelper` must never grow — and `helper.test.ts` asserts the no-`lines`
   encoding is byte-identical to `encode()`'s, so the two cannot drift. *Cost:* one encoder to keep
   in step, held in step by that test.
8. **`Approval` is branded with a symbol `guard.ts` does not export,** so no code path outside the
   guard can construct one and `helper.readApproved` takes nothing else. *Cost:* a cast could defeat
   it; a cast is visible in review, and `imports.test.ts` plus the `run.test.ts` negative assertions
   cover the rest.
9. **Host and badge line boxes are searched over ALL lines, not only the band.** `toolbar.py` used
   `topPx < 260`; restricting the search here would hide the very thing carried item 30 is about — a
   badge that fell *below* the band. *Cost:* in principle a page whose body contained the host or the
   word "incognito" could supply a line box. The staged pages contain neither, and the `host` and
   `private` booleans themselves still come from `toolbarText`, which the helper already cut to the
   band.
10. **`--variant bookmarks-bar` is the only variant offered.** The bookmarks bar is the one item of
    carried item 30's list (bookmarks bar, extensions row, side panel, tab groups, theme) that a
    fresh profile can be told to show with a single preference. The others need an installed
    extension or theme, which this harness will not do. *Cost:* four of the five furniture cases stay
    unmeasured, and the preference mechanism is written but unproven (`Default/Preferences` in the
    harness's own profile directory, written before launch).
11. **Bad usage exits 1, not 64.** The brief named three exit codes; `eval-gate` uses `EX_USAGE` 64
    for the same situation. *Cost:* a caller that distinguishes "called wrong" from "the run broke"
    cannot. One line if the owner prefers 64.
12. **`server.ts` was split out of `main.ts`** (an extra module inside the allowed folder) so the
    page server could be tested against a real loopback server rather than left to the owner-present
    run. A 404 or a page served under the wrong title would otherwise show up only as an hour of
    `notStaged`.
13. **The results file records the run nonce and no window title at all,** which is stricter than the
    brief (it permitted the harness's own staged title). The nonce carries the same information.

---

## 8. Nothing in the brief was found to be impossible or wrong

Two points where the brief and the code differ, both stated above and both deliberate: the extra
test file in `app/scripts/`, and the extra `server.ts` module. Everything else was built as
specified, including the guard's exact shape, the `expect`-only read, the results allow-list, the
two terminal sizes, the 40 toolbar stagings, the `bookmarks-bar` mechanism and the `observe` mode
URLs.

One thing to flag for whoever writes the C-2b-2 measurement plan: this harness will very likely need
one or two adjustments on its first contact with a screen, and the most probable ones are items 5
(Terminal's title) and 1 (Chrome's window size). Both fail loudly — `notStaged` everywhere, or sizes
in `stats` that do not match the case table — rather than quietly producing wrong numbers.

---

# Addendum (2026-09-19) — `observe` mode now has an acceptance bar

The coordinator flipped decision 6 of section 7. `observe` mode no longer merely records what the
owner staged: a row that disagrees with its own case name **fails the run**, in both directions, and
an observe run that measured nothing is **incomplete**, not a pass. Thresholds in `thresholds.ts`
were not touched — this is a new verdict over facts already being recorded, not a change to any
number the spec sets.

## The rule

A new `ObserveVerdict` (`results.ts`) is computed by `summariseObserve(cases, ran)` (`summary.ts`)
and joins `groups` and `toolbar` in `EvalSummary`, so it reaches `accepted` and therefore the exit
code (2 on a shortfall, as for any other verdict).

| Field | Meaning | Fails when |
|---|---|---|
| `privateMissed` | a window the owner staged **private** whose read did not show the private marker — in the product, a private window **KEPT** | `> 0` |
| `falsePrivate` | a window the owner staged **normal** that was flagged private | `> 0` |
| `read` | rows that produced a usable read | `=== 0` |
| `incompleteCases` | rows whose read did not come back at all (`notStaged`, `black`, …) | non-empty |

Two judgements inside that, both deliberate and both tested:

1. **`private: null` counts as missed** for a staged private window. `null` means the helper sent no
   toolbar strip at all, and a badge that was never delivered never skipped anything. The test is
   `private !== true`, not `private === false`; reading `null` as "inconclusive" would let the worst
   outcome pass as an absence of evidence.
2. **`private: null` is not a false positive** for a staged normal window — nothing was flagged.
3. A row whose **read failed** is counted only as incomplete; its facts are not judged, because there
   are none.

`ran` is what distinguishes an observe run that recorded nothing (fails) from a run that had no
observe mode at all (`observe: null`, judged on nothing). `main.ts` passes it from the mode.

## Text and shape changes

- `summary.observe` added to the results JSON:
  `{"staged": 10, "read": 10, "privateMissed": 0, "falsePrivate": 0, "incompleteCases": [], "passed": true}`
  or `null`. Written by hand in `serialiseResults` like every other field.
- The CLI's observe block no longer says "no acceptance bar; for the owner to read". It now prints
  per row `NOT AS EXPECTED: private window would be KEPT` /
  `NOT AS EXPECTED: normal window flagged private` / `as expected`, then a
  `PASS|SHORT  observe   staged N  read N  private-missed N  false-private N` line, plus
  `INCOMPLETE: nothing was staged and read, so nothing was measured` when `read === 0`.
- The usage text's `observe` line now states the rule.
- The doc comments in `run.ts` (`runObserve`) and `summary.ts` were corrected; the stale sentence
  "observe mode produces no verdict on purpose" is gone.

## Verification after the change

| Check | Result |
|---|---|
| Harness tests | **15 files, 398 tests** (was 380) |
| Whole suite in the copy | **84 files, 1430 tests**, all pass |
| Typecheck (both configs) | clean |
| Build + `node --check dist/reader-eval.cjs` | OK |

## Mutations for the new rule — all five bite

Same method: `cp` aside, mutate, watch fail, restore, `cmp` byte-identical.

| # | Mutation | Failing tests | Count |
|---|---|---|---|
| l | `privateMissed` uses `private === false` instead of `!== true` (a missing strip reads as inconclusive) | `fails when a staged private window produced no toolbar strip at all` | 1 |
| m | `privateMissed` never counted | `fails when one staged private window showed no private marker`; `fails when a staged private window produced no toolbar strip at all`; `refuses an observe run with a private window that would have been kept` | 3 |
| n | `falsePrivate` never counted | `fails when one staged NORMAL window was flagged private`; `refuses an observe run with a normal window flagged private` | 2 |
| o | an observe run that read nothing passes (`read > 0` dropped) | `fails a run in which nothing at all was staged and read`; `refuses an observe run that measured nothing` | 2 |
| p | the observe verdict does not reach `accepted` | `refuses an observe run with a private window that would have been kept`; `refuses an observe run with a normal window flagged private`; `refuses an observe run that measured nothing` | 3 |

Mutation **g** (group verdict on the median instead of the minimum) was re-run after the edit to
confirm its anchor in `summary.ts` still holds: it still bites, 1 failing test, restore identical.

## What this changes about section 6

Item 11 of "what could not be verified without a screen" — whether a Safari private window's title
carries the staged title at all — now has teeth. If the owner stages the five private windows and the
harness never sees them, the run exits **2** with `INCOMPLETE: nothing was staged and read` rather
than 0. That is the intended direction: an observe run that quietly measured nothing was the failure
mode this ruling removes.

Section 7's decision 6 is superseded by this addendum. Its stated cost — "the owner has to read the
row rather than the exit code" — no longer applies. The new cost, stated plainly: an observe run now
fails on a Safari layout the harness cannot stage (several tabs, a favourites bar) as loudly as it
fails on a real privacy defect, and telling those two apart is the owner's job at the time, from the
per-row lines.
