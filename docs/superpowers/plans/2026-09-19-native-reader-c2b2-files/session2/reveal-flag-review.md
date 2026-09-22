# Independent review — `--reveal-toolbar` (the reveal channel)

2026-09-21. Reviewer: independent, adversarial. Inputs: `observe-fix-dev-report.md` section "Reveal flag"
(R1–R16), the diff `reveal.diff` (10 files), and the code before it. Nothing was run against a screen;
no bundle was launched; no harness program half was executed. All mutation work was done on a private
copy and every file was restored and `cmp`-ed clean against `app/`.

**Verdict up front: the channel does what the owner approved and nothing more.** The fence holds on
both sides, the strip is the only text that can reach it, and no other file of the harness changed.
Two Important findings are about the file's *lifetime* and about a *missing tripwire*, not about the
fence itself.

---

## 1. THE FENCE — can the channel be switched on any other way?

**No.** Both parsers carry the identical rule and it is order-independent.

| Question | Answer | Where |
| --- | --- | --- |
| another mode (`all`, `accuracy`, `toolbar`, `coldstart`)? | refused | `app/src/readerEval/config.ts:300` (`REVEAL_NOT_APPLICABLE`), `app/scripts/reader-eval.mjs:329-331` (`problem: "--reveal-toolbar"`) |
| `--expect` given AFTER the flag? | refused — the check runs after the whole argument loop | `reader-eval.mjs:329` sits below the loop that ends at `:320`; pinned in both orders by `reader-eval.test.ts` "is refused beside an expectation, in either order" |
| env var set by hand to an odd value? | only the exact string `1` turns it on; `0`, `false`, `no`, empty and `1 ` are all `BAD_REVEAL`, never read as "off" | `config.ts:291-293`, `REVEAL_ON` at `config.ts:29` and `reader-eval.mjs:65` |
| a stale shell variable? | `evalEnv` builds the child environment from scratch and writes the variable only when the flag was given | `reader-eval.mjs:345-375`, specifically `:368` |
| both parsers identical? | yes — mode set and expectation rule match exactly; `MODES` at `reader-eval.mjs:26` covers the same five modes the bundle's `EVAL_MODES` does, and all four non-`observe` ones are enumerated in both test files | — |

**Can a revealing run exit 0 or print ACCEPTED? No, structurally.** The flag requires `expect === null`
(`config.ts:300`); `summarise` maps a null expectation to `reason: "EXPLORATORY"` and `accepted: false`
(`app/src/readerEval/summary.ts:243`, and the default argument at `:339` is the strict one); the terminal
prints `READER_EVAL SHORTFALL` unless `summary.accepted === true` (`reader-eval.mjs:820`) and
`exitCodeFor` returns 2 for anything that is not `accepted === true` (`reader-eval.mjs:842-847`). So a
results file produced by a revealing run cannot be accepted by the terminal side either. `config.test.ts`
pins the second half of this directly ("leaves a revealing run exploratory, and so unacceptable").

One residual, noted for completeness rather than as a defect: the terminal's sweep is not itself gated
on `options.reveal` (see Important 2).

---

## 2. WHAT is revealed

Correct, and narrower than I expected.

- **Only a read that came back `ok`.** The reveal block sits inside the `answer.ok && outcome === "ok"`
  arm (`app/src/readerEval/run.ts:928-946`); the failure arm at `:947` touches nothing. Pinned by
  `run.test.ts` "reveals nothing for a read that failed".
- **Only a window the guard approved.** The read happens through `approve(...)`/`readApproved`
  (`run.ts:900-902`); `guard.ts` is byte-identical to before this diff.
- **Only the assembled strip and lines inside the band.** `revealRowOf` filters on
  `line.bottomPx <= bandPx` (`app/src/readerEval/observe.ts:410`) — the *same* rule the Rust side used
  to assemble `toolbarText` in the first place (`app/native/reader/src/toolbar.rs:42-44`,
  `line.bottom * image_height_px <= band_px`). So the strip cannot contain anything the line filter
  would exclude; the two are the same predicate applied to the same numbers.
- **No band → no lines.** `bandPx === null ? [] : ...` (`observe.ts:410`). An unknown bundle id produces
  no `toolbarText` (`toolbar.rs:41` returns `None`) and no `bandPx` (`protocol.rs:277-280` only inserts
  it when geometry was asked for and produced), so an unknown app reveals an empty strip and no lines.
- **Never `text`.** `run.ts:941-943` passes `toolbarOf`, `linesOf`, `bandPxOf` and nothing else;
  `textOf` is never called on this path. `serialiseObserveReveal` (`observe.ts:438-455`) rebuilds six
  row fields and six line fields by name, so nothing can ride along.
- **Never a window title.** `answer.body.window` is not passed into `revealRowOf` at all. (The report's
  own honest caveat stands: another tab's title *drawn in the band* is pixels the recogniser read, and
  will be printed. The usage text and the run banner both say to use a single-tab window —
  `reader-eval.mjs:160-169` and `:965-968`.)
- **Caps.** 8 lines (`observe.ts:336`), 120 code points each (`:339`), cut after replacement and by code
  point so an astral character is never halved (`:351-358`).

### Control characters and terminal escape injection

**Terminal escape injection through recognised text is not possible on the ordinary path, and this is
belt-and-braces:** ESC (0x1b) is replaced on the bundle side (`observe.ts:355`) and again on the terminal
side where the bytes actually reach the tty (`reader-eval.mjs:604-613`), and the text is only ever
printed inside `quoted(...)`. A 7-bit CSI sequence cannot survive either filter.

What "control characters" covers is exactly `code < 0x20 || code === 0x7f` — C0 plus DEL. See Minor 1
for what that leaves through (C1, bidi, zero-width) and why it is worth one more line of predicate.

---

## 3. WHERE it goes, and how long it lives

- **Its own file**, `observe-reveal-<nonce>.json`, named off this run's nonce
  (`observe.ts:390`, `reader-eval.mjs:403-405`), written by a callback separate from `writeProgress`
  (`main.ts:220-227`, wired at `:373`), never stored on an `ObserveCaseResult` (`run.ts:929-933` keeps
  the row and the revealed strip in two different maps).
- **Sentinel test** (`results.test.ts` "keeps a revealed strip out of the results file and out of the
  progress file") drives the same run with the flag ON and asserts the toolbar sentinel appears in the
  reveal channel and in neither of the other two, and the page-body sentinel in none of the three. I
  re-ran it under mutation; it bites (see §5, M2).
- **Deleted at start** — `clearRunFiles` now takes all three names (`reader-eval.mjs:456-460`).
- **Deleted after each print** — `sweepReveal` prints then removes, every poll (`:922-932`).
- **Deleted on the way out** — `withRevealCleanup`'s `finally` (`:421-427`), with the single
  `process.exit` outside it (`:1011`).

### The single-exit restructure, read line by line

`main()` at `reader-eval.mjs:990-1012`:

| line | path | reveal file possible? |
| --- | --- | --- |
| 992 | bad arguments → `process.exit(1)` | no — no nonce and no `outDir` yet |
| 995-998 | bundle missing → `process.exit(1)` | no — same |
| 999-1003 | entry missing → `process.exit(1)` | no — same |
| 1006-1009 | `mkdirSync`, nonce, `clearRunFiles` | the first point a name exists; cleared here |
| 1011 | the one exit, outside the wrapper | every code from `runEval` passes the `finally` |

`runEval` at `:957-988` contains no `process.exit`: the four early returns (`:975`, `:977`, `:983`) and
the final `return exitCodeFor(results)` (`:987`) all unwind through the `finally`. A *throw* inside
`runEval` also runs the `finally` — only the `process.exit` at `:1011` is skipped (see Minor 6). A
source assertion pins both halves (`reader-eval.test.ts` "wraps the whole run in that cleanup, in the
source"), and I confirmed it bites (§5, M8). **I found no path where `process.exit` runs before cleanup.**

### If the terminal side is killed — it does NOT clean up (Important 1)

`grep` for `process.on`, `SIGINT`, `SIGTERM` over `reader-eval.mjs` returns **nothing**. Node's default
SIGINT/SIGTERM disposition terminates the process without running any `finally` — the same premise the
whole restructure rests on (`:954`). So Ctrl-C leaves the file on disk. Worse, `openArgs` launches the
bundle through `/usr/bin/open -n -W` (`:339-343`): the `.app` is started by LaunchServices and is not in
the terminal's foreground process group, so Ctrl-C kills `node` and `open` but **not the bundle**, which
keeps reading windows for the rest of `--seconds` and keeps rewriting the reveal file — and the bundle
deliberately never deletes it (`main.ts:213-215`). Nothing cleans it afterwards either: `clearRunFiles`
only ever touches the *current* run's nonce, so a later run never sees an orphan.

### File permissions

`writeAtomic` (`main.ts:87-91`) uses the default mode; under the observed `umask 022` the reveal file
lands 0644 inside `app/reader-eval/out`, itself 0755 (`mkdirSync(outDir, {recursive: true})`,
`main.ts:232` and `reader-eval.mjs:1006`). No `.gitignore` covers that folder anywhere in the tree.
Single-user Mac, so low — but see Minor 4.

---

## 4. Nothing else changed

The diff touches exactly ten files: `config.ts`/`.test.ts`, `main.ts`, `observe.ts`/`.test.ts`,
`results.test.ts`, `run.ts`/`.test.ts`, `reader-eval.mjs`/`.test.ts`.

Byte-identical (`cmp`, exit 0) between the pre-diff tree and `app/`: **`results.ts`** (both serialisers
and the whole allow-list), **`guard.ts`**, **`thresholds.ts`**, **`score.ts`**, **`summary.ts`**,
`cases.ts`, `helper.ts`, `stage.ts`. No acceptance rule, no threshold and no scoring line moved.

Within the touched non-test files the change is additive: `observe.ts` is appended to at EOF (`@@ -296,3
+296,163 @@`, no existing line altered); `config.ts` gains one constant, one settings field, two refusal
codes, two checks and one field in the returned object; `run.ts` gains one optional dep, one map and one
`if`; `main.ts` gains one writer and one destructured name; only `reader-eval.mjs` is restructured, and
only in its program half.

---

## 5. Mutations re-run (four required + four more)

All on the private copy; every file restored by writing the original bytes back, every restore
`cmp`-clean against `app/`. Baseline: **18 files, 1173 tests, all pass**; typecheck clean; `bytes.test.ts`
green (it is inside `src/readerEval` and scans all ten touched files).

| # | Mutation | Result | What caught it |
| --- | --- | --- | --- |
| M1 | **required** — reveal allowed beside `--expect` (bundle, `config.ts:300`) | **BIT** (1) | `config.test.ts` "refuses it beside an expectation…" |
| M1b | the same, terminal side (`reader-eval.mjs:329`) | **BIT** (1) | `reader-eval.test.ts` "is refused beside an expectation, in either order" |
| M2 | **required** — page body into the reveal file (`run.ts:941`, `toolbarOf` → `textOf`) | **BIT** (2) | `results.test.ts` sentinel test + `run.test.ts` "…never the page body" |
| M3 | **required** — revealed strip kept on the results row (`run.ts:929`) | **BIT** (1) | `run.test.ts` "reveals nothing at all when the run was not asked to" |
| M4 | **required** — file not deleted after printing (`reader-eval.mjs:931`) | **BIT** (1) | `reader-eval.test.ts` "prints the strip once and deletes the file at once" |
| M5 | control characters no longer replaced (`observe.ts:355`) | **BIT** (1) | `observe.test.ts` "replaces control characters rather than printing them" |
| M6 | reveal file not cleared at start (`reader-eval.mjs:457`) | **BIT** (1) | `reader-eval.test.ts` "is one of the files cleared before the bundle starts" |
| M7 | lines below the band revealed (`observe.ts:410`) | **BIT** (3) | `observe.test.ts` x2 + `run.test.ts` |
| M8 | single exit undone — `runEval` calls `process.exit` again (`reader-eval.mjs:987`) | **BIT** (1) | `reader-eval.test.ts` "wraps the whole run in that cleanup, in the source" |
| **M9** | **the bundle's on/off gate removed** (`main.ts:373`, `reveal ? … : undefined` → `observesWindows(mode) ? …`) | **DID NOT BITE — 1173/1173 pass** | nothing |

Every mutation the brief required bites, and every one the developer's table claims bites does bite.
M9 is mine and is the subject of Important 2.

---

## Findings

### Critical

None.

### Important 1 — a killed terminal leaves recognised text on disk, and the bundle keeps writing it

The report's claim "deleted on the way out on every path" is true for every path *the program takes on
its own* and false for the most likely interruption of a 300-second hands-on session: Ctrl-C.

**Probe.** `grep -n "process.on|SIGINT|SIGTERM" app/scripts/reader-eval.mjs` — no matches. Node's default
signal disposition terminates without running `finally`, which is the same fact `reader-eval.mjs:954`
cites as the reason for the restructure. `openArgs` (`:339-343`) uses `open -n -W`, so the bundle is out
of the terminal's process group and survives the Ctrl-C; `main.ts:213-215` states the bundle never
deletes the file itself; `clearRunFiles` (`:456-460`) only ever removes the *current* nonce, so no later
run cleans the orphan. Net effect: after Ctrl-C the file is left holding the full cumulative table of
every strip read so far, and then grows until the bundle's own `--seconds` deadline expires.

**Suggested fix** (small, and all on the terminal side):

1. In `main()`, before `runEval`, register `for (const signal of ["SIGINT", "SIGTERM"])
   process.on(signal, () => { clearRevealFile(outDir, nonce); process.exit(130); })`. That closes the
   common case.
2. Sweep orphans at start: in `clearRunFiles` (or beside it) `readdirSync(outDir)` and remove every name
   beginning `observe-reveal-` — not only this nonce's. That closes the case where the handler itself
   did not run (SIGKILL, power loss), which no in-process fix can.
3. Say the one sentence in the run banner too: if the run is interrupted, `rm app/reader-eval/out/
   observe-reveal-*.json`.

The alternative — having the bundle delete its own file at exit — is worse, and the developer's comment
at `main.ts:213-215` gives the right reason: the last case's strip is written moments before the bundle
quits and the terminal's final sweep reads it after. Leave that as it is.

### Important 2 — the one line that decides whether the bundle writes recognised text at all is untested

`main.ts:373` — `writeReveal: reveal ? observeRevealWriter(nonce) : undefined` — is the last gate between
"the owner did not ask" and "a file of recognised text exists". **Mutating it to write on every observing
run leaves all 1173 tests green** (probe M9 above). Because `sweepReveal` (`reader-eval.mjs:922-932`) is
*not* gated on `options.reveal` either, the consequence of that one-line slip is not a quiet file: it is
recognised text printed on the terminal of an ordinary `observe` or `all` run, including a run with
`--expect` that goes on to be ACCEPTED.

This is not a defect in today's behaviour — the line is correct. It is a missing tripwire in precisely
the place this project has a convention for one: `helper.test.ts` has a whole `describe("the entry
point's diagnostics wiring")` block whose stated reason is that `main.ts` cannot be imported and its
optional `ObserveDeps` fields "could be removed with nothing failing" — and it already pins
`writeProgress`, `observeHost`, `expect`, the file names and the summary argument. `writeReveal` is the
one field of that set that was not added, and it is the only one whose failure direction is a privacy
widening.

**Suggested fix.** Two lines:

1. In `helper.test.ts`'s entry-point block: `expect(source).toContain("writeReveal: reveal ?
   observeRevealWriter(nonce) : undefined")` and `expect(source).toContain("serialiseObserveReveal(")`.
2. Gate the *print* in `sweepReveal` on the flag — pass `reveal` into `watchObserve` and, when it is
   false, remove the file without printing it. Keep the removal unconditional: a stray file should still
   be swept. That makes "an unasked-for run cannot print a strip" true on both sides independently,
   which is the arrangement the rest of this feature already uses.

### Minor 1 — "control characters" is C0 + DEL only; C1, bidi and zero-width pass through

`observe.ts:351-358` and `reader-eval.mjs:604-613` both test `code < 0x20 || code === 0x7f`.

**Probe** (no harness run; `quoted` imported directly): input `safe` + U+202E + `gpj.exe` + U+200B +
U+009B + `[2J` comes back with U+202E, U+200B and U+009B **verbatim**, and `formatRevealRow` passes them
to the print.

ANSI escape injection through the 7-bit path is genuinely blocked (ESC is replaced twice over). The
residue is: U+009B is the 8-bit CSI, which xterm decodes as a control in UTF-8 mode (Terminal.app and
iTerm2 do not); and a bidi override or a zero-width character makes the printed line *read* differently
from what was recognised. Since the entire point of the exercise is the owner eyeballing a strip to
decide what Vision returned, a line that renders in the wrong order is a line that could send the repair
in the wrong direction. Input plausibility is low but not zero — another tab's title is drawn in the same
band and a page title can hold any code point.

**Fix**: in both predicates, also replace `code >= 0x7f && code <= 0x9f`, `code >= 0x200b && code <=
0x200f`, `code >= 0x2028 && code <= 0x202e`, `code >= 0x2066 && code <= 0x2069`. Extend
`observe.test.ts`'s "replaces control characters" case with one of each.

### Minor 2 — the reported original length counts UTF-16 units while the cut counts code points

`observe.ts:414` (`toolbarTextLength: toolbarText.length`) and `:417` (`length: line.text.length`) use
`String.prototype.length`; `revealSafe` cuts on `[...value]`. A strip of 120 astral code points is not
truncated but reports `[240]`, so the number that exists to make truncation visible says the opposite of
the truth. **Fix**: `[...toolbarText].length` in both places, and one test with an astral string that is
*not* truncated.

### Minor 3 — the `.partial` sibling is never cleaned

`writeAtomic` (`main.ts:87-91`) writes `<path>.partial` and renames. `clearRevealFile`
(`reader-eval.mjs:407-409`), `clearRunFiles` (`:456-460`) and `sweepReveal`'s `remove` (`:931`) all name
only the final file. A crash between the write and the rename leaves `observe-reveal-<nonce>.json.partial`
holding recognised text that nothing in the system ever removes. Probability is low (same-directory
rename), cost of the fix is one line: remove the `.partial` sibling in `clearRevealFile` too — and the
orphan sweep suggested in Important 1 should glob both.

### Minor 4 — default file and folder permissions on the one file that carries screen text

0644 file inside a 0755 folder, under no `.gitignore`. Everything else in that folder is numbers, so the
mode was never worth arguing about; this file is not. **Fix**: `writeFileSync(temporary, contents, {mode:
0o600})` for the reveal writer specifically (or for all three — it costs nothing), and `mode: 0o700` on
the `mkdirSync`.

### Minor 5 — a strip can be deleted before it is printed, and the loss is silent

`sweepReveal` reads the file, prints the new rows, then removes **by name** (`reader-eval.mjs:923-931`).
A bundle write that lands between the read and the remove is deleted unread. Normally harmless — the
bundle rewrites the whole cumulative table, so the next write restores it — except when that write was
the bundle's last: the final sweep at `:947` then finds nothing and that case's strip is never printed.
The window is milliseconds against a 1000 ms poll, but the case lost is the last one, and the session
exists to look at exactly these strips. **Fix**: `renameSync` the file to a scratch name, print from the
renamed copy, then unlink it — the same atomic-handoff trick the writer already uses, turned around.

### Minor 6 — an uncaught throw in `runEval` exits through Node's unhandled-rejection path

The cleanup still runs (the `finally` is inside), but `:1011`'s `process.exit` is skipped and Node prints
a stack full of absolute paths — against this harness's own rule that a message carries paths and paths
carry names (`main.ts:26`). `formatSummary` at `:985` is the one call in `runEval` outside a `try`.
**Fix**: wrap the top-level call at `:1016-1018` in a `catch` that writes a fixed code and exits 1.

### Minor 7 — two documentation slips

- `reader-eval.mjs:401` points the reader at `revealFileOf`, which does not exist anywhere in the tree;
  it should say `clearRevealFile`.
- `config.ts:29` puts `export const REVEAL_ON = "1";` *between* two import statements (`:27` and `:30`).
  Legal, and `imports.test.ts` does not object, but it is the only declaration in the file sitting inside
  the import block.

---

## Conclusion

**Spec compliance ✅** — the channel is exactly the widening the owner approved: `observe` only, no
`--expect`, explicit flag, terminal only, off by default, never in the results or progress file, and a
revealing run can never print ACCEPTED or exit 0. Both parsers carry the identical fence. What is shown
is the assembled strip and the band's own lines and nothing else; the band predicate is literally the one
the Rust side used to build the strip. Nothing outside the ten diffed files moved, and the serialisers,
acceptance rules, guard, thresholds and scoring are byte-identical.

**Quality Approved** — 1173 tests green, typecheck clean, `bytes.test.ts` green, and all four required
mutations plus four of my own bite. The one gap in the test net (M9) is called out as Important 2.

**OK to run with the owner: yes** — with one condition attached. Important 2 is about a future edit, not
about today's binary; Important 1 is about today. Either spend the fifteen minutes on the SIGINT/SIGTERM
handler and the orphan sweep before the session, or go ahead as-is and tell the owner in the same breath
as the single-tab instruction: **if you Ctrl-C this run, afterwards run `rm app/reader-eval/out/
observe-reveal-*.json`** — because the bundle will keep writing that file until its own deadline and
nothing else will remove it. The Minors can all wait for the session's findings; Minor 1 is the only one
I would fold in early, and only because it is three clauses in a predicate that already exists.
