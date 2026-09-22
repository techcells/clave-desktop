# Re-review B — fix round 1 of the `reader:eval` staging repairs

Date 2026-09-20. Scoped RE-review (id B): I verify that the four Importants and eight Minors of
`reviewB.md` are fixed and that the fix diff broke nothing. Not a fresh review. Topic:
`app/src/readerEval/**` and `app/scripts/reader-eval.*` only.

Nothing was launched: no bundle, no `reader-eval.mjs` program half (its entry gate is
`process.argv[1].endsWith("reader-eval.mjs")`, read before any test ran), no `dist/reader-eval.cjs`,
no screen, no dev data folder, no Terminal or browser window. The generated `.command` was rendered
to a string inside a test and parsed with `bash -n`; it was never executed.

Baseline in my private copy `…/s1/rrB/app`: **698 passed in 17 files**, `tsc --noEmit` clean —
exactly what the fixer's report claims. Method per finding: read the fix, revert it by hand in my
copy, run `src/readerEval` + `scripts/reader-eval.test.ts`, watch it fail, restore, `cmp`. Thirteen
reverts, all restores byte-identical; `diff -rq` of the whole copy against `$R/app` afterwards is
empty (my 21 probes were deleted at the end).

---

## Findings: verdict and evidence

| # | Verdict | Evidence |
|---|---|---|
| **I1** placement written before the old Chrome was gone | **FIXED** | `run.ts` `prepareChrome` is now `const waited = await awaitChromeGone(deps);` → `writePreferences` → return. Revert to the old order: **5 failed** (`run.test.ts`, incl. the two ordering-as-data tests `["pgrep true","pgrep true","pgrep false","preferences"]` before the open). The placement is the last thing before the launch, so nothing writes the file between us and Chrome |
| **I2** refusal decided on the PRIMARY display | **FIXED in behaviour, with a test gap** (see N1) | `main.ts:216` `screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt})`; that display's `workArea` feeds both the refusal and `work_area_*`, and its `scaleFactor` goes to the run. New fixed code `POSITION_OFF_DISPLAY` distinct from `DISPLAY_TOO_SMALL`, asked in the right order (too-big first: no corner helps). Reverts: code swapped → **2 failed**; too-big reported as a position problem → **2 failed** |
| **I3** no settling time before `tput` | **FIXED** | `stage.ts` `terminalScript` prints a third `sleep 0.4` immediately before `CLAVE_COLS=$(tput cols …)`. Revert: **1 failed**. My own probe pins it structurally: the read line's predecessor is the settle, the settle is after the *last* resize, and there are exactly three settling waits |
| **I4** the READY anchor was untested | **FIXED** | `guard.ts:79` now demands `readyMark(stagedTitle)` = `<staged title> READY ` and `guard.test.ts` holds the missing title `"OTHER READY 1x1. <staged title>"` — refused with `requireReady`, approved without, which is what makes it a test of the *anchor*. Revert to the bare token: **2 failed** (it failed **0** before this round). Report row M3 corrected to R1 |
| **M1** `140x40` matched `140x400` | **FIXED** | `READY_SIZE_END = "."` closes the token; the shell prints it in the same `printf`. Revert: **3 failed**, incl. an end-to-end terminal reporting 72x400. My independent check: `readySizeToken(140,400)` does not contain `readySizeToken(140,40)`, while a Terminal profile suffix after the token still matches |
| **M2** `READYING` satisfied the token | **FIXED** | `READY_SEPARATOR` makes READY a word. Revert: **5 failed**. Probed: `<staged> READYING` and `<staged> READY` (token with nothing after) are both refused |
| **M3** the scale was inferred | **FIXED** | `RunDeps.displayScale` threaded from `main.ts`, recorded per repetition and per toolbar/observe row, and it **decides** `sizeAsStaged`; the inferred `scale` stays as the cross-check. Reverts: ignore the real scale → **3 failed**; drop the field from the repetition → **1 failed**. Hand-worked table below |
| **M4** the sentinel run never drove a terminal case | **FIXED** | `results.test.ts` now stages `terminalCase` with a READY title carrying a sentinel *and* asserts `sizeAsStaged === true`, so it is not vacuous. A title leaked into the terminal path's `scale` is now caught by `results.test.ts` (**1 failed**) — it was invisible there before; leaked into `sizeAsStaged`, **3 failed**. The "nothing is a string" walker recurses and has a self-test |
| **M5** heredoc guard blind to a first-line delimiter | **FIXED** | `if (("\n" + truth).includes(…))`. Revert: **1 failed**. Probed both positions of the delimiter |
| **M6** report wordings | **FIXED** | §3 now says "typed producers + a hand-written key allow-list + the sentinel run"; the M3 row is replaced by R1 and marked wrong. Both match what I can verify in the code |
| **M7** the alternative hypothesis | **RECORDED** | In `stage.ts` (`chromeAliveCommand` doc) and in the report: 708 pt is exactly the staged height, so "one of the two numbers was used" fits the data as well as "the flags never arrived". No code chooses; `chromeWaitMs`/`stageMs`/`sizeAsStaged`/`displayScale` settle it |
| **M8** environment reach of the `.command` | **FIXED** | The re-exec preamble; analysed in full below. Revert (delete the three lines): **1 harness test + 3 of my probes** failed |

Not touched by this round, and I confirmed it byte-for-byte: `thresholds.ts`, `score.ts`,
`summary.ts`, `helper.ts`, `config.ts`, `pages.ts`, `server.ts` are **identical** to `pre-fix1`. So
no pass mark, no scorer arithmetic and no acceptance rule moved in this round at all. The only
removed assertions in the diff are ones replaced by stronger successors (each verified biting above);
no test was weakened.

---

## (a) The re-exec preamble

```
if [ -z "$CLAVE_EVAL_CLEAN" ]; then
  exec /usr/bin/env -i CLAVE_EVAL_CLEAN=1 TERM=xterm-256color PATH=/usr/bin:/bin /bin/bash --noprofile --norc "$0"
fi
```

- **Can it loop?** No. The second pass is entered with `CLAVE_EVAL_CLEAN=1` in its environment —
  `env -i NAME=VAL cmd` exports it — so `[ -z … ]` is false and the block is skipped. I verified the
  variable really arrives by running that exact `env -i … bash --noprofile --norc -c` line with a
  trivial command of my own (never the staged script): `guard=1`. `exec` replaces the process, so
  there is no parent to return to, and the rendered file contains exactly **one** `exec /usr/bin/env`
  and exactly **two** occurrences of `CLAVE_EVAL_CLEAN` (the guard and the assignment). If `exec`
  itself fails the non-interactive shell exits — fail-closed, the case records `notStaged`.
- **`$0`.** It appears exactly **once** in the whole script and is quoted (`--norc "$0"`), so a path
  with spaces — the temp folder's may have them — is one word. A *relative* `$0` still resolves,
  because `exec` does not change the working directory and `env -i` does not touch it. LaunchServices
  hands `/usr/bin/open` an absolute path, so this is belt and braces.
- **Does `env -i` break `tput` or `clear`?** No. `TERM` is given, and I confirmed under exactly this
  environment that `tput cols`/`tput lines` answer and that `clear`, `tput`, `cat` and `sleep` all
  resolve on the pinned `PATH` (`/usr/bin/clear`, `/usr/bin/tput`, `/bin/cat`, `/bin/sleep` all
  exist; `printf` is a bash builtin). ncurses needs no `HOME` to read the system terminfo.
- **Does it execute anything derived from the screen, the title or the environment?** No. The only
  two command substitutions in the whole file are the two `tput` reads (probed: exactly two `$(`),
  there are **no backticks at all**, and their outputs are passed as quoted `%s` arguments to
  `printf`, never evaluated. The title is rejected outright if it holds a single quote or any control
  character, and it is the harness's own `CLAVE-EVAL <case> <nonce>`; the truth sits in a quoted
  heredoc whose delimiter guard now also covers offset 0. The rendered script parses under `bash -n`.
  The re-exec strictly *reduces* environment reach: `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS` and
  every rc file are gone, and the reasoning about `unset` being impossible (both are readonly in
  bash) is correct.

## (b) `displayScale` deciding `sizeAsStaged` — worked by hand

Staged 1160 x 640 pt; tolerance is **4 px on each axis**, i.e. 2 pt at 2x.

| Captured px | `displayScale` | `scale` (cross-check) | `sizeAsStaged` |
|---|---|---|---|
| 1416 x 1768 (the measured first run) | 2 | null | **false** ✓ |
| 2320 x 1280 | 2 | 2 | **true** ✓ |
| 1740 x 960 | 1.5 | null | **true** — measured honestly, the cross-check disagreeing is itself the finding ✓ |
| 2320 x 1280 | 1.5 | 2 | false ✓ |
| 2320 x 1280 | 1 | 2 | **false** — the one false accept of round 0 is gone ✓ |
| 2324 x 1284 (+4) / 2316 x 1276 (−4) | 2 | — | true (the tolerance) |
| 2325 x 1280 (+5), 2320 x 1285, 2326 x 1280 | 2 | — | false ✓ |
| 1406 x 1754 against a terminal staging | 2 | null | **null** (cells, judged by the shell's own title) ✓ |

**Can a wrong size pass?** Only a window within ±4 px of the exact expected pixel size — at 2x, two
points on each axis. A window one whole point too wide at 2x is caught. The only way round it is
`displayScale` being *unknown*, which falls back to the old inference and its integer-multiple false
accept; `main.ts` supplies the number for every mode that stages, and the value is in the file, so
the fallback is visible when it happens (observation N3).

## (c) The guard

Every probe of the original review is still refused, and two new ones with it: another run's nonce,
another case's ready title, a bare `" READY 72x40."`, the same ready title carried by Chrome, the
staged title without READY, `READYING`, `READY` with nothing after it, an empty title, `null`, and
the anchor case `"OTHER READY 1x1. <staged title>"` (refused with the demand, approved without).
Over a corpus of eleven titles x two apps, everything `requireReady` approves is approved without it:
still a narrowing, never a widening.

**No number is ever parsed out of a title.** There is no `parseInt`/`parseFloat`/`Number(` on any
title anywhere in the topic (the only `Number(` calls are the CLI argument parsers). The single
title-derived value is one `String.includes` producing a **boolean**; `staged.columns/rows` come from
`cases.ts`, `displayScale` from Electron, `scale` from arithmetic on `stats`. Absurd titles
(`READY 999999x1.`) are approved deliberately — the guard asks whether the shell finished, not how
big it is — and they reach the file only as `sizeAsStaged: false`.

## (d) Sentinel non-vacuity for terminal rows

`results.test.ts` drives a real terminal repetition (READY title + size token + sentinel), asserts
`outcome === "ok"` and `sizeAsStaged === true` first, then asserts the file contains none of the
sentinels, no `READY` and no `CLAVE-EVAL`. Both of my leak injections into the terminal path — into
`sizeAsStaged` and into `scale` — are now caught **by `results.test.ts` itself**, which was exactly
the hole of Minor 4. The repetition key set pins `displayScale` by name, and the "nothing is a
string" walker recurses to every depth and has a test that the walker bites.

---

## New breakage and new nits

No functional regression found: 698/698 green, `tsc` clean, acceptance untouched, no privacy or guard
regression. Four things are worth the fixer's attention, none of them blocking.

**N1 (minor) — I2's actual wiring in `main.ts` is untested.** Reverting
`screen.getDisplayNearestPoint({x: position.xPt, y: position.yPt})` to `screen.getPrimaryDisplay()`
fails **zero** tests of the whole suite, and dropping `display.scaleFactor` would be equally silent:
`main.ts` has no test but the source-scan in `helper.test.ts`, and R3/R4/R8 all mutate the pure
functions below it. The repaired half of I2 is the half that had the bug. This is the same class of
defect as round 0's I4 — a fix whose load-bearing line no test holds.
*Suggested fix:* extend `helper.test.ts`'s source scan of `main.ts` with two needles
(`getDisplayNearestPoint(` and `display.scaleFactor`) and one ordering assertion (the display is
asked before `createPageServer`), which is the same cheap instrument that file already uses.

**N2 (minor) — `--position` cannot express a display to the LEFT of or ABOVE the primary.**
`wholePoint` (`config.ts`, unchanged this round) accepts digits only, so a coordinate is
non-negative — but in macOS's global space a second display arranged left of or above the built-in
one has negative x or y. I2 makes the nearest display decide, and then the option cannot name half
the arrangements it exists for. Not introduced here, but it is what stands between I2 and the Retina
check actually being runnable on an arbitrary setup.
*Suggested fix:* allow one leading `-` in `wholePoint` and bound the magnitude by `POSITION_MAX_PT`,
or record the limitation in the run instructions ("arrange the target display right of or below the
built-in one").

**N3 (nit) — `HINTS[results.code]` is a prototype-reachable lookup.** `reader-eval.mjs` replaced
`results.code === "DISPLAY_TOO_SMALL"` with `HINTS[results.code] ?? ""`. `??` only guards
null/undefined, so a `code` of `constructor` or `toString` prints
`function Object() { [native code] }` into the summary (verified by calling `formatSummary` directly).
The results file is the harness's own output with fixed codes, so this is not reachable in a real
run — but the previous form could not do it at all.
*Suggested fix:* `Object.prototype.hasOwnProperty.call(HINTS, results.code) ? HINTS[…] : ""`, or
build `HINTS` with `Object.create(null)`.

**N4 (nit) — two small holes in the re-exec guard.** (i) There is no `--` before `"$0"`, so a `$0`
beginning with `-` would be parsed by bash as options; unreachable from an absolute temp path, and
fail-closed if it ever happened. (ii) `[ -z "$CLAVE_EVAL_CLEAN" ]` means an owner who already exports
that name — even as `0` — silently skips the hardening. Both are one token each:
`--norc -- "$0"`, and `[ "$CLAVE_EVAL_CLEAN" != 1 ]`.

## Observations for the run record

- `env -i` also drops `HOME`, `LANG` and `LC_ALL`, so the staged shell runs in the C locale. Nothing
  in the script re-encodes anything — `cat` passes the heredoc's bytes through and `printf %s` does
  the same — so the accented truth still renders as UTF-8 (Terminal's encoding is a profile setting,
  not a locale one). Worth one line if the accents case behaves oddly, because this is new this round.
- The printed summary's `NOT AS STAGED` line shows the captured pixels and the staged points but
  **not** `displayScale`, which is now the number that decides the verdict. An owner reading only the
  terminal output cannot tell a wrong window size from a wrong display assumption without opening the
  JSON. One field in `stagingLines` would close it.
- Timing: the third `sleep 0.4` costs 0.4 s per terminal staging and leaves the budget comfortable —
  READY lands ~1.2 s after the shell starts against a 2 s settle plus a 15 s guard timeout and a 40 s
  hold.
- The two claims only a screen can settle are unchanged and correctly stated: whether SCK's
  `contentRect` matches Chrome's outer bounds (fail-closed, diagnosable from `stats`, `staged` and now
  `displayScale`), and whether 0.4 s is enough settling for `TIOCSWINSZ`.

---

**Verdict: ALL ADDRESSED.** All four Importants and all eight Minors are fixed, each pinned by a test
that fails when the fix is reverted, and the fix diff broke nothing: no acceptance, scoring or
threshold change, no privacy or guard regression, 698/698 and `tsc` clean. Four new items, none
blocking: N1 (a fix whose load-bearing line no test holds) is worth closing before the next run
because it is the one that could silently come undone; N2 limits how far I2 can actually be used;
N3 and N4 are one-token hardening.
