# OBSERVE mode fixes (O1, O3, O4, O5, O6) — dev report

2026-09-21. Harness only: `app/src/readerEval/**`, `app/scripts/reader-eval.mjs`,
`app/scripts/reader-eval.test.ts`. Nothing was run against a screen, no bundle was launched, no git.
Pre-fix snapshot for diffing: `session2/pre-observe-fix/`.

## 1. Files changed

New:

| File | What it holds |
| --- | --- |
| `app/src/readerEval/observe.ts` | The closed `--expect` set list (derived from the case table), the set-membership rule, `expectationOf`, the `--host` grammar, the two nonce-carrying file names, the `observe-urls` file builder, `readAsExpected`, `OBSERVE_READ_ATTEMPTS_MAX` |
| `app/src/readerEval/observe.test.ts` | 48 tests for the above |

Changed:

| File | Change |
| --- | --- |
| `src/readerEval/score.ts` | `hostDistance` (+ `HOST_DISTANCE_MAX`, `HOST_STRIP_SCAN_MAX`). Its whitespace class is a copy of `hostInToolbar`'s, deliberately — see below |
| `src/readerEval/run.ts` | `runObserve` rewritten (retry, early end, progress callback, `--host`); `toolbarFacts` records `hostDistance`; `ObserveDeps` gained `expect`, `observeHost`, `writeProgress` |
| `src/readerEval/summary.ts` | `summariseObserve(cases, ran, expect)` — expectation-driven verdict, fixed reason codes; `summarise(…, observeExpect)` |
| `src/readerEval/results.ts` | `hostDistance` on every toolbar/observe row, `readAttempts` on an observe row, four new fields on `ObserveVerdict`, the progress-file types and `serialiseObserveProgress`; **schema 3 → 4** |
| `src/readerEval/config.ts` | `observesWindows(mode)`; `expect` and `host` settings; refusals `BAD_EXPECT`, `EXPECT_NOT_APPLICABLE`, `BAD_HOST`, `HOST_NOT_APPLICABLE` |
| `src/readerEval/main.ts` | Nonce-named URL file through the tested builder; the atomic progress writer; `expect`/`observeHost`/`writeProgress` into `runMode`; the expectation into `summarise`; `schema: 4` |
| `scripts/reader-eval.mjs` | `--expect`, `--host`, usage text, env vars, nonce-named files + stale clearing, `watchObserve` (URLs then a running commentary), `observeLabel`, `formatProgressLine`, `progressKey`, observe summary lines |
| test files | `score.test.ts`, `config.test.ts`, `summary.test.ts`, `run.test.ts`, `results.test.ts`, `helper.test.ts`, `scripts/reader-eval.test.ts` |

## 2. New CLI usage, verbatim

```
    observe    windows the OWNER stages by hand (Safari and Chrome, normal and
               private/incognito); a window staged private that shows no private
               marker fails the run, and so does a normal one flagged private.
               Say --expect, or the run is EXPLORATORY and can never be accepted

    --seconds <n>       how long observe mode watches at the OUTSIDE (default
                        120). It ends as soon as every expected case has been
                        read, so --expect is what makes a run short.
    --expect <sets>     which observe cases this run is judged on, comma
                        separated: safari | safari-normal | safari-private
                        chrome | chrome-normal | chrome-private
                        The run passes only if EVERY case of those sets was read
                        and agreed with its own name; one missing or failed case
                        makes it INCOMPLETE. WITHOUT it an observe run is
                        EXPLORATORY: every row is printed and it can never be
                        accepted, whatever it read. Only for observe and all.
    --host <name>       the host the observe URLs use, and the one the address
                        strip is searched for (default 127.0.0.1; lowercase
                        letters, digits, dots and hyphens, at most 63, and
                        either 127.0.0.1, localhost, or a name ending in
                        .localhost). A word host is the realistic case: a bare
                        IP is the hardest thing on the strip to read. Only for
                        observe and all.
```

The run the owner is most likely to want next:

```
pnpm --dir app reader:eval -- observe --expect safari-private --host app.clave.localhost --seconds 600
```

Five Safari private windows, a word host, ten minutes at the outside — and it ends the moment the
five are read. Exit 0 only if all five were read and all five showed the private marker.

## 3. File shapes

`app/reader-eval/out/observe-urls-<nonce>.json` (schema 2):

```json
{
  "schema": 2, "port": 51234, "nonce": "<run nonce>", "host": "app.clave.localhost",
  "expect": ["safari-private"],
  "urls": [{"case": "safari-private-chat-light-14", "app": "Safari",
            "expectPrivate": true, "expected": true,
            "url": "http://app.clave.localhost:51234/chat.html?theme=light&size=14&stagedTitle=CLAVE-EVAL+o15+<nonce>"}]
}
```

Every case of the table is listed; `expected` is what the terminal filters on, and it is the BUNDLE
that decides membership (one rule, `inExpectSet`). `expect: null` is an exploratory run and the
terminal then prints all twenty under the word EXPLORATORY.

`app/reader-eval/out/observe-progress-<nonce>.json` (schema 1), rewritten atomically after **every
read attempt**:

```json
{
  "schema": 1, "nonce": "<run nonce>", "expect": ["safari-private"], "expected": 5, "done": 1,
  "rows": [{"case": "safari-private-chat-light-14", "outcome": "ok",
            "host": true, "private": true, "asExpected": true, "readAttempts": 2}]
}
```

Six fields per row, all of them a case name this harness invented, a fixed outcome code, a boolean or
a small count. Written by hand in `serialiseObserveProgress`, like the results file.

Results file additions (schema 4): `hostDistance` on every toolbar and observe row, `readAttempts`
on an observe row, and on the observe verdict `expect` (set names or `null`), `expected` (count),
`missingCases` (names), `reason` (`EXPLORATORY` | `INCOMPLETE` | `NOT_AS_EXPECTED` | `null`).

Terminal, while the run goes:

```
  read safari-private-chat-light-14      NOT READ: windowGone (attempt 1)
  read safari-private-chat-light-14      host true private true as-expected true
```

and in the summary:

```
  safari-private-code-light-11     outcome windowGone host null dist null private null band null badge null  NOT READ: windowGone
SHORT  observe   expect safari-private  expected 5  staged 4  read 3  private-missed 0  false-private 0
      INCOMPLETE: expected but never read: safari-private-code-light-11
```

## 4. The five findings, as rules

- **O1** — `--expect <set>` on both parsers, validated like its neighbours (refused when set and
  unreadable, on both sides). With it, the verdict passes only if every case of the set was read `ok`
  AND agreed with its own name. Without it the verdict is `EXPLORATORY`, exit 2, whatever it read —
  and `summarise`'s parameter defaults to "no expectation", so a caller that forgets it gets the
  strict answer. The terminal prints only the expected URLs.
- **O3** — both observe files carry the nonce in their NAME. The terminal mints the nonce, so it
  knows the file to wait for; a previous run's file is not skipped by a check, it is never opened.
  This run's own two files are deleted before the bundle starts.
- **O4** — `would be KEPT` only for `outcome ok && expectPrivate && private !== true`; a failed read
  prints `NOT READ: <outcome>`. One rule (`observeLabel` on the terminal, `readAsExpected` in the
  bundle) used by the summary, the progress line and the verdict alike. `privateMissed` already
  counted only `ok` rows — re-checked, and now pinned by a test that mutating it breaks.
  A failed read also no longer CLOSES a case: it is retried while the window is still in front, up to
  three attempts, and `readAttempts` records how many.
- **O5** — `hostDistance`: the smallest Levenshtein distance between the squashed, lower-cased host
  and any window of the squashed strip within ±2 of its length, bounded 0..64, `null` for no strip.
  Computed in memory from `toolbarText`; nothing recognised is stored.
- **O6** — the run ends as soon as every expected case has been read ok (or at `--seconds`), and the
  terminal prints one line per newly finished case by polling the progress file every second.

## 5. Test totals

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1092 tests, all pass** (was 16 files / 1009 before) |
| `pnpm --dir app test` (whole suite) | **88 files, 2244 tests, all pass** |
| `pnpm --dir app typecheck` | clean |
| `src/readerEval/bytes.test.ts` | 42 tests, green; a separate byte scan of all 34 touched files found no control byte |

## 6. Mutation table

Each fix was reverted on a backup copy, the harness suite run, the failure observed, and the file
restored by writing the original bytes back and `cmp`-ing (all 18 restored clean).

| # | Mutation | Failing tests (first named) |
| --- | --- | --- |
| M1 | `summary.ts`: exploratory verdict becomes a pass | 5 — *the observe verdict never passes a run that was asked for nothing, however perfectly it read*; *accepted refuses an observe run that named nothing, even when every window read as staged* |
| M2 | `summary.ts`: a missing expected case stops failing | 7 — *the observe verdict fails when one expected case was never read at all, and names it*; *…fails when an expected case was read and the read failed* |
| M3 | `run.ts`: a failed read marks the case seen | 3 — *a read that failed does not close the case tries again at the next poll while the window is still in front, and the good read wins* |
| M4 | `run.ts`: retries unbounded | 1 — *…gives up after a bounded number of attempts and reports the failure with its count* |
| M5 | `run.ts`: the run never ends early | 2 — *when an observe run ends ends as soon as every EXPECTED case has been read, however long it was given* |
| M6 | `run.ts`: `--host` ignored | 1 — *observe mode searches the strip for the host the run was given, not always the loopback address* |
| M7 | `run.ts`: no `hostDistance` on a row | 2 — *observe mode records how far the strip was from the host, not only whether it was there* |
| M8 | `score.ts`: `hostDistance` answers 0 for an absent host | 5 — *how far the strip was from the host is 1 for one substitution, where the boolean is simply false* |
| M9 | `run.ts`: the progress row is spread instead of rebuilt | 1 — *what the run reports while it is still watching reports six fields and no others, and not one string the helper sent* |
| M10 | `results.ts`: the progress file spreads its rows | 1 — *what reaches the results file writes a progress row as six named fields, and drops anything smuggled beside them* |
| M11 | `config.ts`: an unreadable `--expect` is ignored | 3 — *what an observe run expects refuses a set it does not have rather than expecting nothing* |
| M12 | `observe.ts`: a bad `--host` is taken as given | 3 — *the host the observe URLs use refuses a name off the loopback reservation…* |
| M13 | `reader-eval.mjs`: `observeUrlsName` returns the fixed name | 3 — *this run's own files ignores a stale file left by another run, and reads this run's*. **CORRECTED after review:** this mutation only proved the HELPER was load-bearing, not the call site. Reverting the call site itself (`watchObserve`'s `observeUrlsName(nonce)` back to the fixed name) left the suite green — see Fix round 1, I1 |
| M14 | `reader-eval.mjs`: this run's files are not cleared | 1 — *…clears this run's own two files before the bundle starts, and leaves other runs' alone* |
| M15 | `reader-eval.mjs`: `would be KEPT` printed for a failed read | 5 — *the printed summary says NOT READ, never KEPT, for a windowGone row* (and timeout, black, failed, notStaged) |
| M16 | `reader-eval.mjs`: every URL printed, expected or not | 1 — *the observe URLs prints ONLY the expected URLs, and says which sets they are* |
| M17 | `reader-eval.mjs`: a progress line per poll, not per change | 1 — *the progress lines prints a case again when its outcome or its attempt count changed, and not otherwise* |
| M18 | `reader-eval.mjs`: a failed progress line loses its attempt count | 1 — *the progress lines says NOT READ and the outcome code for a read that failed* |

The brief's seven required mutations map to M1, M2, M3, M13, M15, M8 and M9/M10 — with M13 as
corrected above and properly closed by N1/N2 in Fix round 1.

## 7. Decisions, and what each costs if it is wrong

1. **A failed read of an UNEXPECTED case does not fail the run.** It is listed in `incompleteCases`
   and printed, but only `missingCases` (the expected set) decides. *If wrong:* a run could be
   accepted while a window the owner happened to open failed to read — visible in the printed rows,
   and the acceptance would still be true of the five cases it claimed. The opposite choice would let
   a stray window the owner opened by accident block a set that was fully measured.
2. **`privateMissed` and `falsePrivate` fail the run wherever they occur**, expected set or not.
   A normal window flagged private is a real regression on a real read. *If wrong:* a run is failed
   by a measurement outside its expectation — cheap, and the row says which.
3. **`OBSERVE_READ_ATTEMPTS_MAX = 3`, and it lives in `observe.ts`, not `thresholds.ts`.** It is a
   mechanism, not a pass mark, and `thresholds.ts` was left untouched. *If wrong:* a window that
   needs a fourth read is reported `windowGone` with `readAttempts: 3`, which is visible and
   re-runnable; three attempts six seconds apart on a window left in front is already generous.
4. **`hostDistance` uses a COPY of `hostInToolbar`'s whitespace class** rather than importing one
   rule (`run.ts` imports `score.ts`, so the dependency cannot run the other way, and `score.ts`'s
   own `norm` folds four ASCII separators that `\p{White_Space}` does not). *If wrong:* the two would
   drift; a test pins them to the same answer on the same pair, in both directions.
5. **The strip is scanned to 1024 characters** (ten times the longest measured strip, 96). *If
   wrong:* a host past character 1024 of a strip reports a large distance instead of 0 — the boolean
   `host` is unaffected, since it is a plain substring test over the whole strip.
6. **`--expect` and `--host` are refused outside `observe`/`all`.** *If wrong:* the owner has to
   repeat a command with the option removed. The alternative — silently ignoring an option he typed —
   is the class of bug `--limit` was already fixed for.
7. **Schema bumped 3 → 4.** The observe verdict change is not additive: a version-3 file has no
   `expect`, and read as a 4 it would look like an expected run that named nothing.
8. **The progress file is polled at 1 s** while the bundle rewrites it after every read (poll 2 s).
   *If wrong:* a line appears up to a second late. A final sweep runs after the bundle exits, so the
   last case cannot be lost to the race.
9. **URLs are built by `pageUrl`**, so the staged title is query-encoded with `+` for spaces rather
   than `%20` as the old inline builder did. This is the encoding every staged Chrome window has
   been opened with, and the page server decodes it with `searchParams.get`. *If wrong:* Safari would
   send a title the server does not recognise and the page would carry the fallback title, showing up
   as every case `notStaged` with `pageRequests` above zero — loud, not silent.

## 8. What only a screen can decide

- **Does Safari resolve `*.localhost` to the loopback address?** Chrome does. Nothing here assumes
  it — that is why `--host` exists and why the default is unchanged. First run with
  `--host app.clave.localhost`: if Safari does not resolve it, every case comes back `notStaged`
  with `pageRequests: 0` and the answer is unambiguous in one minute.
- **Is the Safari host finding an absence or a misread?** `hostDistance` will say: 0-2 on most rows
  means the strip carries the address and recognition is dropping a character; `null` or large means
  Safari is not drawing it in the band at all. The bare-IP numbers (3 of 8) and the word-host numbers
  should be compared on the same day, same display, same window size.
- **Does the retry actually recover a `windowGone`?** The one unexplained row of run #2. If
  `readAttempts: 2` with `outcome: ok` appears, the refusal was momentary; three failures in a row
  means something about that window is different and the harness has bounded the cost of finding out.
- **Does the early end really save the owner the twenty minutes?** It should end within a poll of the
  last expected read. Worth timing once against the printed commentary.
- **Whether five private windows in one run is the right ask.** `--expect safari-private` is five
  menu items and five pastes; if that is still too long, `--expect` takes a comma list and a shorter
  set can be added to the table without touching anything else.

---

# Fix round 1 — closing the review's three Importants and its minors

2026-09-21, after `session2/observe-fix-review.md`. Same rules: harness only, nothing run against a
screen, no bundle launched, no git.

## I1 — the terminal call site of the nonce-named files

The reviewer is right and my M13 claim was wrong: M13 mutated `observeUrlsName`, which only proved
the HELPER was load-bearing. Reverting the CALL SITE (`watchObserve`, `reader-eval.mjs`) to the fixed
name left 1092 green. The M13 row above is corrected.

`watchObserve` is now exported and injectable — `watchObserve(outDir, nonce, running, io)` with
`io.read(name)`, `io.print(text)` and `io.wait(ms)` — and every name it opens comes from the new pure
`observeFilesFor(nonce)`. The tests drive the whole loop with no filesystem, no clock and no
terminal, against a fake `read` that answers a STALE file eagerly for any other name:

- *opens this run's two files and NOTHING else* — the set of names asked for is exactly
  `observe-urls-<nonce>.json` and `observe-progress-<nonce>.json`, and every one contains the nonce.
- *prints this run's URLs and never a stale file's* — the stale URL is not in the output.
- *prints one line per case as it finishes, and does not repeat it*.
- *holds the fixed file name nowhere in its source* — the symmetrical tripwire to `main.ts`'s. The
  string that was the bug is gone from this half entirely, comments included (the two doc comments
  that quoted it were reworded).

**The reviewer's exact revert now fails:** N1 (`observeFilesFor` returns the fixed name) fails 4
tests, N2 (the watch overrides the name at the call site) fails 3.

## I2 — schema 4's values in the serialised file

Three tests in `results.test.ts`:

- *carries schema 4's new values onto disk, not only their keys* — serialises a populated observe row
  (`hostDistance: 2`, `readAttempts: 2`), a populated toolbar row (`hostDistance: 7`) and a full
  observe verdict, and asserts every value by `toEqual`, plus the verdict block's **key set** so a
  smuggled field there is caught the way a row's is.
- *carries an exploratory verdict onto disk as null and EXPLORATORY*.
- *writes an absent host distance as null, and not as an absent field*.

**All five of the reviewer's surviving probes now fail:** N3 `hostDistance` (1), N4 `readAttempts`
(2), N5 `expected` (1), N6 `missingCases` (1), N7 `reason` (2) — and N8 for the new
`notCheckedCases` (1).

## I3 — the nonce, validated bundle-side

`parseNonce` in `config.ts`, beside `parseLimit` and counted by hand: exactly `NONCE_LENGTH` (12)
lowercase hex characters — the length both halves mint (`randomBytes(NONCE_BYTES).toString("hex")`,
and `main.ts` now uses that constant). Anything else is `{ok: false, code: "BAD_NONCE"}`, refused
before the display is asked, before the page server is built and before any name is composed — so
nothing is written outside `outDir`, because no observe file name is ever built. It holds whatever
ends up as the nonce, generated or given: a generator answering something else is refused too.

Tests: the grammar; a refusal table including `../../x`, `abc/def45678`, `abc.123def45`, uppercase
hex, a non-hex letter, one short, one long, empty, a space; *refuses a traversal nonce before the run
can name a file with it*, which also asserts that every ACCEPTED nonce gives a file name containing
neither `/` nor `..`; and the generated-nonce path. N9 (take it verbatim again) fails 11; N10 (widen
the grammar) fails 4.

The fixture change this forced: `config.test.ts` used `CLAVE_EVAL_NONCE: "abc123"` and a generator
returning `"generated-nonce"`; both are now real 12-hex nonces, and `results.test.ts`'s one
`readEvalSettings` call with it likewise.

## Minors

1. **The wall-clock pin is gone.** *scans the first HOST_STRIP_SCAN_MAX characters of the strip and
   no more* asserts it by behaviour: the host at character 500 → 0, the last host entirely inside the
   bound → 0, one character past it → greater than 0, at character 2000 → greater than 2. N15
   (unbounded scan) fails 2 tests deterministically. No timing assertion remains anywhere.
2. **Worst-case cost**: left as it is, and the reviewer's own numbers are the reason — 2 ms on the
   real measured strip, 18 ms on an absurd one. Narrowing the scan when `hostInToolbar` is already
   true would make the common case cheaper and the interesting case (a host that is NOT found, which
   is the only case the number exists for) exactly as expensive, so it buys nothing where it matters.
3. **An exhausted case no longer holds the run open.** `settled(name)` is `done.has(name) ||
   attempts >= OBSERVE_READ_ATTEMPTS_MAX`. **I chose "ends as soon as every expected case is either
   read ok or exhausted", not "runs to the deadline"** — because an exhausted case is skipped for the
   remainder of the run whatever happens to that window, so no further watching could change the
   answer: the owner would be sitting out `--seconds` for a result already decided. The verdict is
   unaffected — the case is in `missingCases`, so the run is `INCOMPLETE` either way; this only stops
   the waiting. Tests: *ends when every expected case is either read or out of attempts, and says the
   run is incomplete* (3 looks at the front window, not the thousands 6000 seconds would allow) and
   *keeps waiting for the other expected cases when one is out of attempts*. N14 fails 1. The
   `--seconds` help now says "or has failed its reads three times".
4. **The scan boundary no longer splits an astral character.** `scannedStrip` is exported and tested
   directly, because the property **cannot** be observed through `hostDistance`: a lone surrogate
   scores exactly as any other one-character mismatch and every host here is ASCII, so no pair of
   strips has different distances because of it — my first attempt at an end-to-end test passed
   either way (N16 survived), which is exactly the failure mode this whole mutation discipline is
   for. N16 now fails 1.
5. **A normal case read with no toolbar strip is NOT as expected.** `noToolbarStrip` in `observe.ts`;
   `readAsExpected` answers false for it; the verdict gains `notCheckedCases` and an expected one
   makes the run `INCOMPLETE`; the terminal prints `NOT CHECKED: no toolbar strip`. A PRIVATE case
   with no strip is deliberately NOT moved — it stays a `privateMissed`, which is the stronger
   statement of the same fact (no badge delivered, so the product would have kept it). An unchecked
   case outside the expected set does not fail the set that was asked for. N11, N12, N13 each fail 1.
6. **The two `--host` tables agree row for row**, and a new test asserts
   `parseHostArg(raw) === parseObserveHost(raw)` over all fifteen values either table has.
7. **The terminal no longer prints a file's strings unchecked.** `fixedCode` (letters, digits,
   hyphens, ≤ 64) for a case name and an outcome code, `bool` and a bounded `count` for the rest;
   anything else prints `?`. Defence in depth on this run's own file. N17 fails 1.
8. **A results file of another schema is no longer summarised as a pass.** `RESULTS_SCHEMA = 4`,
   `knownSchema`, a printed `OLD RESULTS FILE` line and exit 2. A file with no `schema` at all is
   still read as before. N18 fails 1.

## Totals after fix round 1

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1128 tests, all pass** (1092 before this round) |
| `pnpm --dir app test` (whole suite) | **88 files, 2280 tests, all pass** |
| `pnpm --dir app typecheck` | clean |
| byte scan of all 34 touched files + `bytes.test.ts` | no control byte |

## Round-2 mutation table

Each reverted on a backup copy, suite run, failure observed, file restored by writing the original
bytes back and `cmp`-ed (all clean).

| # | Mutation | Result |
| --- | --- | --- |
| N1 | call site reads the old fixed name (**the reviewer's I1 probe**) | BIT (4) |
| N2 | the watch overrides the name with the fixed one | BIT (3) |
| N3 | `hostDistance` nulled in the serialiser (**I2 probe**) | BIT (1) |
| N4 | `readAttempts` nulled (**I2 probe**) | BIT (2) |
| N5 | `expected` nulled (**I2 probe**) | BIT (1) |
| N6 | `missingCases` emptied (**I2 probe**) | BIT (1) |
| N7 | `reason` nulled (**I2 probe**) | BIT (2) |
| N8 | `notCheckedCases` emptied | BIT (1) |
| N9 | the nonce taken verbatim again (**I3**) | BIT (11) |
| N10 | the nonce grammar widened | BIT (4) |
| N11 | a normal case with no strip passes again (Minor 5) | BIT (1) |
| N12 | an unchecked expected case does not fail the run | BIT (1) |
| N13 | the terminal calls it "as expected" | BIT (1) |
| N14 | an exhausted case holds the run open (Minor 3) | BIT (1) |
| N15 | the strip scan unbounded (Minor 1) | BIT (2) |
| N16 | the scan boundary splits an astral character (Minor 4) | BIT (1) — after the test was rewritten; see Minor 4 |
| N17 | the terminal prints a file's strings unchecked (Minor 7) | BIT (1) |
| N18 | an unknown schema summarised as a pass (Minor 8) | BIT (1) |
| N19 | `scannedStrip`'s early return removed | **SURVIVED — equivalent mutant.** For any well-formed strip the slice path returns the identical string; it differs only for a short strip that itself ends in a lone surrogate, which is malformed input the helper never receives. Recorded rather than chased. |

## What this round changed about the run the owner is about to do

Nothing about the command or what an acceptance means. Two things he will SEE that are new: a
`NOT CHECKED: no toolbar strip` line if a normal Safari window comes back with no address strip (and
that run is then `INCOMPLETE` rather than a pass), and a run that ends about six seconds after a
window has failed its third read instead of running to `--seconds`.

---

# Reveal flag — `--reveal-toolbar`

2026-09-21, owner-approved. Harness only; nothing run against a screen, no bundle launched, no git.

## Why

On a real screen (Safari 27) the host `127.0.0.1` is plainly in the address field, yet on three page
kinds — `chat-light-14`, `chat-dark-11`, `pt-dark-11` — the recognised strip holds nothing resembling
it: `hostDistance` 8-9, deterministically, on the same pages every time. Those three are the pages
where Safari draws a TRANSLATE glyph beside the host. A distance of 8 says "not on this strip"; it
cannot say whether Vision spliced the glyph's characters into the address, returned a different
toolbar line, or returned nothing for that region — and those need different repairs. The only way
to choose is to look at what came back.

## The fence

This is a privacy widening, so it is narrow on every side:

| Fence | Where | Refusal |
| --- | --- | --- |
| `observe` mode only — not `all` | `config.ts`, `reader-eval.mjs` | `REVEAL_NOT_APPLICABLE` / `problem: "--reveal-toolbar"` |
| only with NO `--expect`, so the run is `EXPLORATORY` and can never be accepted | both parsers | the same |
| the variable takes exactly `1`; `0`, `false`, `""` are refused, never read as "off" | `config.ts` | `BAD_REVEAL` |
| set on the command line only when asked; never passed through from a stale shell variable | `evalEnv` | — |

`config.test.ts` also pins the other half of the second row: a revealing run's settings carry
`expect: null`, so `summarise` gives `reason: "EXPLORATORY"` and `accepted: false`.

## What is revealed, and what is not

Per observe case read **`ok`** only — a failed read showed nothing, so there is nothing to reveal:

- the assembled toolbar strip (`toolbarText`), which is the exact string `host` and `hostDistance`
  were computed from;
- each toolbar LINE **inside the band** (`bottomPx <= bandPx`) with its `topPx`/`bottomPx`/
  `leftPx`/`rightPx`. A read with no band reveals **no** lines at all: "which of these are toolbar
  lines" has no answer then, and the safe answer is none.

Never the page body (`text`), never a line below the band, never a window title. Capped at
`REVEAL_LINES_MAX = 8` lines and `REVEAL_LINE_MAX = 120` code points each (the cut counts code
points, so half an astral character never reaches a terminal), control characters replaced with `?`,
and the ORIGINAL length reported beside each string as a number so a truncation is visible.

Because nothing is ever read but a window the guard approved — exact app plus a title carrying this
case's short staged title and this run's nonce, re-checked by the helper before capture — a revealed
strip is always the strip of a window this harness staged. **What it can still contain:** the
toolbar band of the owner's own window, so if he stages the page in a window with OTHER TABS their
titles are in that band and will be printed. The usage text and the run's own first lines tell him
to use a single-tab window.

## Where it goes

A file of its own, `observe-reveal-<nonce>.json`, written atomically by the bundle after every
successful read and **never** part of the results file or the progress file — the callback
(`ObserveDeps.writeReveal`) is separate from `writeProgress`, and the reveal row is never stored on
an `ObserveCaseResult`. Its serialiser lives in `observe.ts`, not `results.ts`, on purpose: that
file's whole claim is that nothing it writes was ever on a screen.

Its life is as short as the mechanism allows:

- deleted **before** the bundle starts (`clearRunFiles` takes all three of this run's files);
- printed and deleted **at once** by every poll of the terminal's sweep — the bundle rewrites the
  whole table each time, so deleting mid-run costs nothing and a `revealed` set keeps a case from
  being printed twice;
- deleted **on the way out on every path**. `process.exit` does not run a `finally`, so the program
  half was restructured: `runEval` returns an exit code (it no longer calls `process.exit`), and the
  single `process.exit` sits outside `withRevealCleanup(outDir, nonce, …)`, whose `finally` removes
  the file after a clean finish, a refusal or a throw. A source assertion pins both halves.

Printed as, one line per strip and per line box:

```
  REVEAL safari-normal-chat-light-14: band 41px  strip[19] "127.0.0.1/chat.html"
  REVEAL safari-normal-chat-light-14: line 16-37px x10-200px [19] "127.0.0.1/chat.html"
  REVEAL safari-normal-chat-light-14: 2 more line(s) in the band, not shown
```

Every line is marked `REVEAL <case name>:` so it can never be mistaken for a measurement and a
session transcript can be swept for the word.

## Usage

```
pnpm --dir app reader:eval -- observe --reveal-toolbar --seconds 300
```

`--expect` alongside it is refused. The run prints, before anything opens:

```
REVEALING the toolbar strip of every staged window on this terminal.
Use a SINGLE-TAB window: other tabs' titles are drawn in the same band.
```

## Tests and totals

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1173 tests, all pass** (1128 before this task) |
| `pnpm --dir app test` (whole suite) | **88 files, 2325 tests, all pass** |
| `pnpm --dir app typecheck` | clean |
| byte scan of all 34 touched files + `bytes.test.ts` | no control byte |

The sentinel test is extended: the same run, with the flag ON, asserts the toolbar sentinel appears
in the reveal channel and **nowhere** in the results file or in any progress file the run would have
written, and that the page-body sentinel appears in none of the three.

## Mutation table

All 16 bit; every file restored by writing the original bytes back and `cmp`-ed clean.

| # | Mutation | Result |
| --- | --- | --- |
| R1 | reveal allowed beside an expectation (bundle) — **brief's required mutation** | BIT (1) |
| R2 | reveal allowed in any mode (bundle) | BIT (5) |
| R3 | reveal allowed beside an expectation (terminal) | BIT (1) |
| R4 | any value turns the reveal on | BIT (7) |
| R5 | the page body leaks into the reveal file — **required** | BIT (2) |
| R6 | lines below the band are revealed | BIT (3) |
| R7 | the 8-line cap gone | BIT (1) |
| R8 | the 120-character cap gone | BIT (2) |
| R9 | control characters printed | BIT (1) |
| R10 | the reveal serialiser spreads its rows | BIT (1) |
| R11 | reveal content kept on the results row — **required ("reaching the results file")** | BIT (1) |
| R12 | the file not deleted after printing — **required** | BIT (1) |
| R13 | the file survives the way out | BIT (1) |
| R14 | the file not cleared at start | BIT (1) |
| R15 | nothing revealed at all | BIT (2) |
| R16 | the terminal prints a file's text unguarded | BIT (1) |

R11 is worth a note: the mutation puts the strip on the `ObserveCaseResult`, and the *serialiser*
still keeps it out of the file — because `serialiseResults` rebuilds every field by name. What
catches it is the run-level test that a row carries no text at all. Both layers hold independently,
which is the arrangement that was wanted.

## Concerns

1. **This is the first text this harness has ever shown.** Everything about it is fenced, capped and
   short-lived, but the fence is code: it is worth the owner reading the printed `REVEAL` lines on
   the day and saying whether they hold anything he did not expect. If they do, the answer is a
   single-tab window — the band is his browser's, not ours.
2. **The strip may still be the wrong thing to look at.** If the three failing pages show a strip
   that simply lacks the address, the question moves to the band (`bandPx`) or to the capture, and
   the line boxes printed beside the strip are what will say which.
3. **The program half was restructured** (single exit, wrapped in the cleanup). It is the one part of
   this harness no unit test can execute; the two claims it rests on are pinned by source assertions
   and by direct tests of `withRevealCleanup`, but the first real run is also the first execution of
   that path.

---

# Reveal flag — fix round 1

2026-09-21, after `session2/reveal-flag-review.md`. Both Importants and all seven Minors closed.
Harness only; nothing run against a screen, no bundle launched, no git.

## Important 1 — a killed terminal must not leave recognised text on disk

Three mechanisms, one per hole the reviewer found.

**(a) Signals.** `installRevealSignalHandlers(outDir, nonce, io)` registers `SIGINT`, `SIGTERM` and
`SIGHUP`; each clears this run's reveal file, its `.partial` and its heartbeat, then exits 130. `on`,
`exit` and `clear` are injected, so the handler itself is a thing a test runs — it is registered
before the bundle is launched, which a source-order assertion pins.

**(b) Orphan sweep.** `sweepRevealOrphans(outDir)` runs at start and deletes **every**
`observe-reveal-*`, every `.partial` of one and every `observe-alive-*` in the out folder — not just
this run's nonce. That is the case no in-process fix can reach (SIGKILL, power loss). The test puts
four orphans from three foreign nonces beside three files that must survive (`observe-urls-*`,
`observe-progress-*`, a results file) and checks both directions.

**(c) Liveness, with no new channel.** The terminal rewrites `observe-alive-<nonce>` every poll
(1 s, mode 0600). The bundle asks how old it is before every write: fresh is
`≤ REVEAL_HEARTBEAT_MAX_AGE_MS` (5 s, five beats); anything else — including **no file at all** —
means the terminal is gone, and the bundle then deletes the reveal file and **stops revealing for
the rest of the run** and does not resume if a heartbeat comes back. A negative age (a stepped wall
clock stamping a file in the future) counts as fresh.

Every decision lives in `createRevealGate` in `observe.ts`, which is pure and unit-tested; `main.ts`
supplies three lines of `fs`. Tested both with counters and **against a real folder**: after a stale
heartbeat `readdirSync(dir)` is empty, the `.partial` goes too, and with a beating terminal exactly
one file is left.

**End of run.** This is the one place the instruction ("the bundle deletes the reveal file when its
run ends") and review Minor 5 ("the final case's strip cannot be dropped") pull opposite ways: the
last strip is written moments before the bundle exits and the terminal's final sweep reads it after,
so an unconditional delete would drop exactly the case the session is for. Both are satisfied by
asking the same question again — `gate.end()` deletes when the heartbeat is **stale** (nobody will
ever print that file) and leaves it when it is **fresh** (the terminal will claim it within one
poll). Nothing is orphaned either way: a terminal dying inside that one-poll window is caught by its
own signal handlers, and failing those by the next run's orphan sweep. **This is the one place I
chose a conditional over the letter of the instruction**, and it is flagged here for that reason.

## Important 2 — the on/off gate, pinned on both sides

- **Source pins** in `helper.test.ts`'s existing entry-point block: the gate is built only when the
  validated setting says so, the writer is handed over only then, `reveal` travels with it, and
  `revealGate?.end()` runs before `helper.shutdown()`. The reviewer's own probe (**S12**, write on
  every observing run) now fails.
- **A second, behavioural lock:** `runObserve` refuses to call a reveal writer unless `deps.reveal`
  is `true` as well — so the line in the Electron entry that no test can execute is no longer the
  only thing standing between "the owner did not ask" and "a file of recognised text exists". Tested
  with the setting absent, explicitly off, and on (S11).
- **The terminal's print is gated too**, on `options.reveal`, while the **removal stays
  unconditional**: an ordinary run sweeps a stray strip away without printing it (S13), and the
  default with no options at all is the closed one.

## Minors

1. **The unsafe class is now C0, DEL, C1 (U+0080–U+009F, U+009B among them), bidi (U+061C,
   U+200E/F, U+202A–U+202E, U+2066–U+2069), zero-width (U+200B–U+200D, U+2060, U+FEFF) and the
   line/paragraph separators (U+2028/9)** — a table of ranges built from NUMBERS at run time on both
   sides, never literal characters. The terminal keeps its own copy (it cannot import the bundle's)
   and a test holds the two to the same answer on 34 boundary code points. The reviewer's probe
   string comes back with all three of its survivors replaced.
2. **Lengths are counted in code points** (`revealLength`), the unit the cut counts: 120 astral
   characters are not truncated and now report `[120]`, not `[240]`.
3. **The `.partial` sibling is cleaned** by `clearRevealFile`, by the gate's `remove`, and by the
   orphan sweep.
4. **Mode 0600** on the reveal file and its `.partial`, and `mode: 0o700` on the out folder's
   `mkdirSync`. **CORRECTED after re-review:** as written in that round the 0700 was on the
   TERMINAL's `mkdirSync` only, and the on-disk 0600 assertion was made against the test's own
   writer rather than the production one — dropping the mode from the real call site left every
   test green. Both are closed properly in "Reveal flag — minors round" below.
5. **The last-write race is gone.** `sweepReveal` now CLAIMS by `renameSync` into
   `observe-reveal-<nonce>.json.claimed`, prints from the claimed copy and unlinks that — the same
   atomic-handoff trick the writer uses, turned around, so a bundle write landing mid-sweep can never
   be deleted unread. The final sweep still runs after the bundle exits and before the cleanup.
6. **A top-level `catch`** around `main()` writes `READER_EVAL_FAILED HARNESS` and exits 1, so an
   uncaught throw no longer prints a stack full of absolute paths.
7. Both documentation slips fixed: the dangling `revealFileOf` reference now says `clearRevealFile`,
   and `REVEAL_ON` has moved out of `config.ts`'s import block.

**One standing rule was refined rather than broken.** `helper.test.ts` forbade `Date.now()` anywhere
in `main.ts`. A file's mtime is a wall-clock stamp and has no monotonic equivalent, so the liveness
check cannot use `performance.now()`. The test now pins the count of wall-clock readings at exactly
**one** and names it (`return Date.now() - statSync(alivePath).mtimeMs;`), so any second one still
fails; the rule's substance — no duration this harness reports or times out on comes off the wall
clock — is asserted separately. Nothing the heartbeat decides is a measurement.

## Totals

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1231 tests, all pass** (1173 before this round) |
| `pnpm --dir app test` (whole suite) | **88 files, 2383 tests, all pass** |
| `pnpm --dir app typecheck` | clean |
| byte scan of all 34 touched files + `bytes.test.ts` | no control byte |

## Mutation table (round 4)

All 18 bit; every file restored by writing the original bytes back and `cmp`-ed clean.

| # | Mutation | Result |
| --- | --- | --- |
| S1 | the bundle reveals whatever the heartbeat says | BIT (3, incl. the on-disk test) |
| S2 | the bundle keeps its file when the terminal is gone | BIT (1) |
| S3 | a missing heartbeat counts as alive | BIT (4) |
| S4 | a stale heartbeat counts as alive | BIT (3) |
| S5 | the terminal stops beating | BIT (1) |
| S6 | no signal handlers | BIT (1) |
| S7 | the program half does not install them | BIT (1) |
| S8 | no orphan sweep at start | BIT (1) |
| S9 | the orphan sweep takes everything in the folder | BIT (2) |
| S10 | the `.partial` sibling is left behind | BIT (1) |
| S11 | the run reveals without being told to | BIT (1) |
| S12 | **the reviewer's M9** — the entry point writes on every observing run | BIT (1) |
| S13 | the terminal prints a strip it was not asked for | BIT (2) |
| S14 | C1 and bidi pass the bundle's filter | BIT (5) |
| S15 | bidi passes the terminal's filter | BIT (2) |
| S16 | the length counts UTF-16 units again | BIT (1) |
| S17 | the claim-by-rename is gone | BIT (3) |
| S18 | the reveal file is world-readable | BIT (1) |

## Concerns

1. **The `end()` conditional** is the one deliberate deviation from the letter of the instruction,
   for the reason above. If the coordinator wants an unconditional delete at the bundle's exit, the
   cost is the last case's strip on every run and Minor 5 reopens; say so and it is a one-line change.
2. **The heartbeat is a 1 s write into the out folder for the length of a revealing run.** It is a
   zero-byte file at 0600 and it is swept at start, on the way out and by signals — but it is new I/O
   on a path that previously wrote only on a read, and only revealing runs pay it.
3. **The program half remains the one part no unit test executes.** It now carries the signal
   handlers, the orphan sweep and the top-level catch; each is proved by testing the exported
   function plus a source-order assertion, which is the strongest thing available without running it.

---

# Reveal flag — minors round

2026-09-21, after `session2/reveal-flag-rereview.md`. The flag has now been used once with the owner:
the strips settled the Safari host question, and a real SIGINT to the node process cleared the
heartbeat and the reveal file within three seconds. Four residual minors folded in. Harness only;
nothing run against a screen, no bundle launched, no git. Per the coordinator, only
`src/readerEval scripts/reader-eval.test.ts` and `typecheck` were run — another agent is editing
`src/core/exclusions/**`, which this round does not touch.

## A — `.claimed` joins every cleanup list

`observe-reveal-<nonce>.json.claimed` is where the terminal MOVES the file before printing from it,
and a throw between that rename and the unlink (an EPIPE on the print when the window is closed) left
it behind. It is now a named member of the family, not a name that only the orphan sweep's prefix
happened to catch:

- `revealFileNames(nonce)` — the file, its `.partial`, its `.claimed` — exists on **both** sides,
  with a test that the two lists are identical.
- `clearRevealFile` (and therefore the signal handlers and `withRevealCleanup`'s `finally`) clears
  all three plus the heartbeat: a temp-dir test leaves `readdirSync(dir)` empty.
- The **bundle's gate** removes all three as well. That is safe because the gate's `remove` only ever
  runs when the heartbeat is five seconds stale, so the terminal cannot be mid-print of it.
- The orphan sweep is pinned on `.claimed` from three different nonces.

T1, T2, T3 each bite.

## B — the 0600 pinned at the real write site

The re-review was right: the old test asserted the mode on a file the TEST wrote with a mode the test
passed, and `main.ts` was held only by `expect(source).toContain("REVEAL_FILE_MODE = 0o600")` — the
declaration, not the use. Dropping the argument at the call site left 1231 green.

The reveal file is now written by **`writeRevealFile(path, contents, io)` in `observe.ts`**: production
code that chooses the mode itself and takes only the two `fs` calls from its caller. `main.ts` passes
`writeFileSync`/`renameSync` and no mode at all, so there is no mode left at that call site to drop —
and `helper.test.ts` asserts `REVEAL_FILE_MODE` appears **nowhere** in `main.ts`. The test hands the
function the real `node:fs` into a temp folder and reads the mode off the file it produced
(`statSync(path).mode & 0o777`), plus the write order (`.partial` then rename) through a fake io.

The folder: `mode: 0o700` is now on **both** `mkdirSync` calls, each pinned where the production code
creates it. It is stated plainly in the code and here that this applies when the folder is CREATED —
an existing folder keeps its mode, which is why the controller chmod-ed the one on this machine. The
earlier report's "asserted on disk, on both sides" was an overstatement and has been corrected in
place, above.

T4 (mode), T5 (call site), T6 (atomicity), T7 and T8 (each folder) all bite.

## C — the top-level catch and the zero-byte heartbeat

Both were right and untested; both are now exported pieces a test runs.

- `reportHarnessFailure({write, exit})` writes `READER_EVAL_FAILED HARNESS` and exits 1. Tested for
  the fixed code, for containing no `/` at all, and for the exit code; a source pin holds the
  program half's `catch` to calling it. A second test composes the real thing: a throwing body inside
  `withRevealCleanup` leaves `readdirSync(dir)` empty and then prints the fixed code and exits 1.
- `writeHeartbeat(path, io)` writes `HEARTBEAT_CONTENTS`, which is the empty string, at 0600. Tested
  against a real folder for `statSync(path).size === 0` and the mode, and through a fake io for the
  exact arguments — so a heartbeat that carried the nonce, or anything else, fails.

T9-T13 all bite.

## D — the heartbeat starts before the URL wait

`beat(files.alive)` now runs **before** the URL-wait loop and again **inside** it. The comment says
why: the bundle asks how old the heartbeat is before its first reveal write, a missing heartbeat is
read as "the terminal is dead" (delete, and stop revealing for the whole run, silently), and the URL
wait can run 20 s. It was safe only because the bundle writes the URLs file before it spawns the
helper — a dependency between two files in two processes that nothing stated and nothing tested. A
behavioural test drives `watchObserve` with a URL file that never arrives and asserts the first thing
it does is beat; a source-order pin holds the first `beat` above the wait loop.

T14 and T15 bite.

## The observation from the real run

No code change: a signal sent to the `pnpm`/`sh` wrapper never reaches the node process, which is
expected. One line in the usage text now says so — "To stop a run early, press Ctrl-C in the terminal
that RUNS it: a signal sent to a pnpm or sh wrapper never reaches this process." T16 bites.

## Totals

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1249 tests, all pass** (1231 before this round) |
| `pnpm --dir app typecheck` | clean |
| byte scan of all 34 touched files + `bytes.test.ts` | no control byte |

The whole suite was deliberately not run this round, per the coordinator: another agent is editing
`src/core/exclusions/**`. Nothing here touches that folder, and `typecheck` covers the whole project.

## Mutation table (round 5)

All 16 bit; every file restored by writing the original bytes back and `cmp`-ed clean.

| # | Mutation | Result |
| --- | --- | --- |
| T1 | the bundle's name list drops `.claimed` | BIT (2) |
| T2 | the terminal's name list drops `.claimed` | BIT (2) |
| T3 | the gate leaves `.claimed` behind | BIT (1) |
| T4 | the reveal file is written world-readable | BIT (2) |
| T5 | the entry point writes it itself, without the mode | BIT (1) |
| T6 | the write is not atomic | BIT (1) |
| T7 | the bundle's out folder is world-readable | BIT (1) |
| T8 | the terminal's out folder is world-readable | BIT (1) |
| T9 | no top-level catch | BIT (1) |
| T10 | the failure line carries a path | BIT (2) |
| T11 | the failure exits 0 | BIT (2) |
| T12 | the heartbeat carries the nonce | BIT (2) |
| T13 | the heartbeat is world-readable | BIT (2) |
| T14 | the heartbeat starts only after the URL wait | BIT (2) |
| T15 | the heartbeat does not beat inside the URL wait | BIT (1) |
| T16 | the usage text stops saying where to press Ctrl-C | BIT (1) |


---

# addressLine

2026-09-21. Owner decision O8: the core does not keep a Chrome or Safari read unless some LINE of its
toolbar strip is an address line (`showsAddress` in `src/core/exclusions/sites.ts`). Whether real
strips satisfy that — in particular whether Chrome's toolbar icons are recognised on the SAME line as
the address, which would drop the read — can only be measured on a screen. This adds the measurement.

Harness only; `src/core` was read and never touched. Nothing run against a screen, no bundle
launched, no git. Per the coordinator, only `src/readerEval scripts/reader-eval.test.ts` and
`typecheck` were run.

## What was added

**One boolean per row.** `addressLine` on every toolbar row and every observe row: the CORE's
`showsAddress(toolbarText)`, imported and called — never re-implemented. `null` when the read
delivered no strip, because the rule was not asked rather than answered no. It sits beside `private`,
which has been the product's own `hasPrivateToolbarMarker` since the beginning and for the same
reason: a copy could pass here while the real one drops the read on somebody's screen, and measuring
a copy would be measuring the wrong rule.

**One count per toolbar run.** `addressLines` on the toolbar verdict, reported as
`addressLine n/40  (information only: the core keeps a read only when some toolbar LINE is an
address)`. It is INFORMATION: there is no `addressLinesMin` beside it, it is absent from `passed`,
and two tests hold it there in both directions — a run whose every strip fails the rule still passes
on the thresholds, and a run that fails a threshold is not rescued by every strip passing it. The
thresholds are the spike's own pass marks and were not touched.

**Printed** beside `host`: on every observe row of the summary (`host true dist 0 address false`) and
on every progress line (`host true address false private false as-expected true`). A file that
carries no count prints no line about it.

`--reveal-toolbar` is unchanged: the reveal channel carries the strip itself, and a boolean about it
adds nothing there.

## Files changed

| File | Change |
| --- | --- |
| `src/readerEval/run.ts` | imports `showsAddress`; `toolbarFacts` records `addressLine`; `EMPTY_FACTS` and the progress row carry it |
| `src/readerEval/results.ts` | `addressLine` on `ToolbarCaseResult` and `ObserveProgressRow`, `addressLines` on `ToolbarVerdict`, all three serialised by hand; **schema 4 → 5** |
| `src/readerEval/summary.ts` | `summariseToolbar` counts it, and `passed` does not mention it |
| `src/readerEval/main.ts` | stamps schema 5 |
| `scripts/reader-eval.mjs` | prints the boolean and the count; `RESULTS_SCHEMA` 4 → 5 |
| `src/readerEval/imports.test.ts` | `../core/exclusions/sites` added to the allow-list, with the reason |

The imports guard did need the new entry: it already allowed `../core/exclusions/privateWindows`,
and `sites` is the second rule of the same kind. Removing it from the allow-list fails the guard
(U13), so the import is declared rather than tolerated.

## Tests

- **The core's answer, not ours.** Six strips asserted equal to `showsAddress(...)` including
  `Node.js`, `Node.js docs`, `README.md`, `localhost:3000`, `[::1]` and `wiki/` — the pair
  `Node.js` / `Node.js docs` is the one the core's own doc comment calls its residual hole, and it is
  exactly where a plausible re-implementation diverges.
- **Multi-line.** A strip of three lines, one of them an address, matches the core (the rule is per
  line).
- **`null` twice over:** a read with no strip, and a read that failed.
- **Round trip by value:** `[true, false, null]` across three toolbar rows, `addressLines: 1` in the
  verdict, and the verdict's key-set pinned so a threshold cannot appear beside it.
- **Progress:** the key-set (now seven fields) and the VALUE, tied to `showsAddress` of the strip the
  fake sent.
- **Printing:** the observe row, the progress line, the count with its "information only" words, and
  a passing run with `addressLine 0/40` still reporting `PASS toolbar` / `READER_EVAL ACCEPTED`.

## Totals

| Command | Result |
| --- | --- |
| `pnpm --dir app test src/readerEval scripts/reader-eval.test.ts` | **18 files, 1265 tests, all pass** (1249 before) |
| `pnpm --dir app typecheck` | clean |
| byte scan of all 34 touched files + `bytes.test.ts` | no control byte |

## Mutation table (round 6)

All 13 bit; every file restored by writing the original bytes back and `cmp`-ed clean. The three the
brief required are U1, U2 and U3.

| # | Mutation | Result |
| --- | --- | --- |
| U1 | **required** — the field hard-nulled on the way to disk | BIT (2) |
| U2 | **required** — a re-implemented predicate (`toolbarText.includes(".")`), differing from the core on `Node.js docs` | BIT (1) |
| U3 | **required** — the count added to `passed` | BIT (1) |
| U4 | a failed read reports the rule as `false` | BIT (1) |
| U5 | a strip that was never sent reports `false` | BIT (1) |
| U6 | the count counts a rule that was never asked | BIT (2) |
| U7 | the progress row drops it | BIT (1) |
| U8 | the run stops reporting it while watching | BIT (2) — after the progress test gained a VALUE assertion; the key-set alone did not catch it |
| U9 | the schema is not bumped | BIT (1) |
| U10 | the terminal stops printing it on an observe row | BIT (1) |
| U11 | the terminal stops printing the count | BIT (2) |
| U12 | the terminal stops printing it on a progress line | BIT (1) |
| U13 | the core's rule is dropped from the imports allow-list | BIT (1) |

U8 is worth the note: the first pass asserted only that `addressLine` was among the progress row's
keys, and nulling it survived. A key-set test proves a field exists; only a value test proves it
carries anything.

## What only a screen can decide

The question the field exists for, restated so the run has something to answer: **does a real Chrome
toolbar strip contain a line the core accepts as an address?** If Chrome's icons are recognised on
the same line as the omnibox, that line is no longer one token with a few glyphs around it and
`addressLine` comes back `false` — and in the product that read is dropped, every read, all day. A
`toolbar` run now reports `addressLine n/40` for exactly that, and an `observe` run reports it per
staged window for Safari as well. A low count is a finding about the core to take to the owner; it is
deliberately not a failing harness run.

## Note on the environment

The login shell's `nvm` setup is currently broken on this machine — every command through it exits 3
with `Version 'node' does not exist` / `nvm install default`. I did not cause it and did not touch
it (it is outside the files this task may edit); all commands in this round were run through
`env -i bash` with an explicit `PATH` to `~/.nvm/versions/node/v24.19.0/bin` and `~/Library/pnpm/bin`,
which works. Worth someone fixing before the next hands-on session, since `pnpm --dir app reader:eval`
would hit the same wall.
