# Independent review — plan C-2b-2, Task 1 (three harness additions to `reader:eval`)

Reviewer: independent; did not write the code. Nothing was launched, staged, opened or read. No
bundle was started; `scripts/reader-eval.mjs`'s program half was never run (its gate at
`scripts/reader-eval.mjs:349-351` keys on `process.argv[1].endsWith("reader-eval.mjs")`, which under
vitest is the vitest entry — importing the module cannot reach `main()`); `dist/reader-eval.cjs` was
not touched; nothing under `~/Library/Application Support/Clave Agent Dev/` was opened.

Working copy `$S/exec2/rev/app`; `pnpm` never run against it. The real repo was not modified:
`diff -r -q $S/exec2/rev/app/src/readerEval $R/app/src/readerEval` is empty and both scripts `cmp`
clean after every mutation round.

## Verification I ran myself

| Check | Result |
|---|---|
| Harness tests (`src/readerEval` + `scripts/reader-eval.test.ts`) | 17 files, **590 passed** — matches the report |
| Whole suite in the copy | 86 passed + 1 skipped files, **1660 passed + 1 skipped** — matches |
| `tsc --noEmit -p tsconfig.json` | exit 0, no output |
| `tsc --noEmit -p tsconfig.renderer.json` | exit 0, no output |
| Developer's 17 mutations, re-run from scratch | **all 17 bite**, all restores byte-identical (see table) |
| 10 mutations of my own | 6 bite, **4 do not** (findings 1-3) |
| Byte scan, 32 files (`src/readerEval/**` + both scripts) | no byte < 0x20 outside tab/newline, no 0x7f, all valid UTF-8; non-ASCII is U+2014 and U+2026 only (plus `score.test.ts`'s pre-existing accented fixtures) |
| Files changed vs `$S/exec2/backup` | **15**: 13 under `src/readerEval/**` + `scripts/reader-eval.{mjs,test.ts}` |

My probes live in `$S/exec2/probe-saved.ts` (42 tests, all green against the installed code); the
mutation drivers are `$S/exec2/rev-mutate.py` (the developer's 17) and `$S/exec2/rev-mutate2.py` /
`rev-mutate3.py` (mine).

---

## Answers

### 1. `coldstart`

**No path writes a `read` or `frontWindow` line, starts the page server, creates the temp staging
folder, or stages a window.** Two independent gates:

- `run.ts:493-499` — `runMode` returns three empty lists for `coldstart`, so `runAccuracy`,
  `runToolbar` and `runObserve` are never entered.
- `main.ts:196-197` — `runMode` is not even called: `staging === null` short-circuits to
  `{accuracy: [], toolbar: [], observe: []}`.
- `main.ts:171-177` — the scratch `mkdirSync`, `readTruth()` and `createPageServer()` are all inside
  the `stagesWindows(mode)` branch (`config.ts:42-44`).
- `main.ts:180` — `writeObserveUrls` is guarded by `staging &&`.

The only two lines a `coldstart` run ever writes to the helper are `permission` (`main.ts:191`) and
`shutdown` (`main.ts:230`). My probe asserts this on the lines a fake link *received*
(`link.sent` is `[]` after `runMode("coldstart", …)`), and that no stager command, script or
preferences write happened. The developer's own test at `run.test.ts` ("writes no read and no
frontWindow line at all") does the same and mutation **a** proves it bites.

**When `ready` never comes, comes with the wrong protocol, or the helper exits:** `main.ts:185-188`
writes `serialiseError({error: "PROTOCOL", code: "PROTOCOL"})`, and `results.ts:379-381` serialises
exactly `{error, code}` — a fixed code, never a message string. `helper.ts:134-143` turns an exit
into `{ok: false, why: "down"}`, which is `!ready.ok`, so the same path. The catch-all at
`main.ts:238-240` writes `{"error":"HARNESS","code":"HARNESS"}` with no message and no stack.

**`readyMs`** is spawn → `ready` on an injected clock: `helper.ts:104-107` reads `deps.now()` *before*
`deps.start()` (and `createChildHelperLink` spawns inside `start`'s body, `main.ts:119`). Mutations
**d1** (from process start) and **d2** (from the moment `ready` arrived) both bite. It is finite and
≥ 0 in every mode for any monotonic clock, and `startAndWaitReady` still reports the interval when
`ready` never came (my probe: `{ok:false, why:"timeout"}` with `readyMs === 120_000`).

**What is written when the helper never becomes ready: nothing.** The run takes the PROTOCOL branch
and the measured `readyMs` is discarded — see Minor 1. `summary.ts:204-212` is the other half: a
non-finite `readyMs` becomes `readyMs: null` with `passed: false`, never a pass beside a number the
harness does not have.

### 2. The guard with Chrome in `observe`

I could not construct any sequence that gets a `read` written for a window this run did not stage.
Every one of these produces `readLines === []` and an empty result list (probe `Q2`):

| Attempt | Why it fails |
|---|---|
| Safari window carrying a `chrome-…` case title | `guard.ts:61` compares `app` exactly; `"Safari" !== "Google Chrome"` |
| Chrome window carrying a `safari-…` case title | same, plus the substring test at `guard.ts:62` |
| another run's nonce | `stagedTitleFor` embeds the nonce (`stagedTitle.ts:17-19`); mutation **c** bites |
| case-folded app (`"google chrome"`, `"GOOGLE CHROME"`, `" Google Chrome"`) | exact compare, no trim, no fold |
| the accuracy or toolbar cases' staged titles seen during `observe` | no observe case's staged title is a substring of theirs |
| a case name that is a prefix of another | the `" "` before the nonce (`stagedTitle.ts:18`) blocks it: `"CLAVE-EVAL chrome-private-chat <n>"` is not a substring of `"CLAVE-EVAL chrome-private-chat-dark <n>"`. I also asserted exhaustively over all 38 case names × 38 that no staged title contains another. |

`chrome-private-chat` vs `chrome-private-chat-dark`: not confusable, and in any case the real table
(`cases.ts:221-232`) has no such pair — the five variants are `chat-light-14`, `ticket-dark-14`,
`code-light-11`, `pt-dark-11`, `chat-dark-11`.

**A title containing two staged titles** is read once per matching case (probe `Q2b`: 2 reads, rows
`chrome-normal-…` and `chrome-private-…`), because `runObserve` (`run.ts:448-468`) polls again after
`break` and the second case is no longer `seen`. This is **fail-closed**, not a leak: the window is
one the harness's own page was asked to title, both rows are recorded, and one of the two must
disagree with its own `expectPrivate`, which fails the run at `summary.ts:165-166, 174`. It is only
reachable by hand-crafting a `stagedTitle` query parameter. Recorded as an observation, not a
finding.

**Every `read` carries `expect` equal to the approved window and nothing else.** Probe: the read line
has exactly the keys `{id, op, budgetMs, expect, lines}` (`helper.ts:54-56`), and `expect` deep-equals
the `FrontWindow` the guard approved, suffix (`" - Google Chrome"`) and all. A read cannot be sent
without an `Approval`, which only `guard.ts` can mint (`guard.ts:33-39`, `helper.ts:46`).

**Both browsers' observe reads ask for `lines`** — `run.ts:454` is one call shared by Safari and
Chrome, and they should: `hostBottomPx` / `privateBottomPx` come only from the line boxes and are
carried item 30's whole measurement. Chrome's is pinned (mutation **f**); **Safari's is not** —
finding 3.

### 3. D17 for Chrome, and the app string

- A staged `chrome-private-*` window whose read shows no private marker **fails the run**: probe
  gives `private: false` → `summary.ts:165` `privateMissed = 1` → `passed: false` → `accepted: false`.
  `private !== true` is the test, so a `null` strip counts as missed too (mutation **R5** bites).
- A `chrome-normal-*` flagged private **fails the run**: `summary.ts:166` `falsePrivate = 1`.
- **Zero reads is incomplete**, never a pass: `summary.ts:174` requires `usable.length > 0`.

**The app string is correct.** `run.ts:463` passes `theCase.app`, which for a Chrome observe case is
`CHROME = "Google Chrome"` (`cases.ts:27`, `cases.ts:209`) — the exact string
`privateWindows.ts:33`'s `isSafari` rejects and the exact string `defaults.ts:28,40` list under
`BROWSERS` / `MEASURED_BROWSERS`. Because the guard already required `window.app === theCase.app`, it
is byte-for-byte what the product itself would pass at `exclusions/index.ts:62`. Verified
behaviourally: `hasPrivateToolbarMarker("…/acme/private-api  Private", "Google Chrome")` is `false`
while the same strip under `"Safari"` is `true`, and `"… Incognito"` is `true` for both. The rule is
the product's own, called (`run.ts:350,356`), not copied. **Not pinned by any test** — finding 2.

### 4. Results privacy

Each new field, traced to its origin:

| Field | Origin | Can it carry a helper/title string? |
|---|---|---|
| `helper.readyMs` (`results.ts:236,303`) | `Date.now()` subtraction (`helper.ts:107`) | No — a number by type and by construction |
| `permission` (`results.ts:242,304`) | `permissionOf` → `parseHelperPermission` → closed union, `?? "unknown"` (`helper.ts:78-81`, `protocol.ts:86-88`) | No — mutation **h** proves the fallback |
| `position` (`results.ts:255,306`) | `readEvalSettings` → `wholePoint` digits only (`config.ts:77-94`), or `null` | No |
| observe rows' pixel figures (`run.ts:343-362`) | `linesOf`/`statsOf`/`bandPxOf`, every field type-checked to `number`/`boolean` (`run.ts:123-160`) | No |
| observe rows' `app` (`results.ts:331`) | `theCase.app`, a fixed name from `cases.ts` | No |

I drove a hostile fake helper through **all five modes** — `stats` carrying strings and an extra key,
a `permission` answer that is a long sentence containing a window title, `lines[].text` and
`toolbarText` sentinels, a `window` whose `app`, `title` and `bundleId` are sentinels, and a `ready`
event with extra `build`/`host` fields — and asserted on the serialised file. **No sentinel survives
in any mode.** The `ready` event is reduced to `{protocol}` at `helper.ts:122-126`.

**Is the sentinel test still non-vacuous?** For the envelope, yes: removing `helper` (mutation **g**,
7 tests), letting the raw permission string through (**h**, 4), and dropping `position` (**n**, 8) all
fail. For the **row bodies, no** — replacing `results.ts:330-331`'s hand-written allow-list with a
naive spread of the row objects fails **zero** tests. Finding 1.

### 5. `--position`

Both parsers refuse identically. I ran a 25-value table through `parsePosition` (`config.ts:88-94`)
and `parsePositionArg` (`scripts/reader-eval.mjs:65-81`) side by side; every one is `null` on both
sides: `a,b`, `1`, `""`, `","`, `1,`, `,2`, `1,2,3`, `-5,3`, `5,-3`, `3.2,1`, `1,3.2`, `" 3,4"`,
`"3 ,4"`, `"3,4 "`, `1e3,4`, `0x20,4`, `Infinity,4`, `NaN,4`, `+3,4`, Arabic-Indic digits, full-width
digits, `9007199254740993,1`, `12,34,`, `"3,4\n"`, `"3\t,4"`. Accepts agree too (`120,80`, `0,0`,
`3000,140`, and `040,060` → 40,60 on both). Mutations **b1**, **b2**, **b3** show each side's table
bites on its own. An absent `CLAVE_EVAL_POSITION` is the default; an empty one is `BAD_POSITION`
(mutation **m**); the CLI sets the variable only when asked (mutation **k**).

**Huge values:** both accept anything up to `Number.MAX_SAFE_INTEGER`. `--position 999999,999999` is
taken. I judge this a **defect, but a Minor one** — see Minor 3: it fails closed (every case times
out as `notStaged`, the run is `incomplete`, never a false pass), so it costs the owner a wasted run
rather than a wrong number.

**The value reaches `--window-position=` for every Chrome staging:** `run.ts:197` (accuracy) and
`run.ts:377` (toolbar, both `normal` and `incognito`, since `incognito` is a separate flag on the same
command — `stage.ts:74-75`). Probe: with `--variant bookmarks-bar` and position `1600,200`, every
`open` command in both modes carries `--window-position=1600,200` and `--window-size=1268,708`
unchanged, incognito stagings included. The bookmarks-bar variant goes through
`writePreferences`, not the command line, so it cannot interfere. Mutations **j** and **R10** bite
each staging separately. Chrome `observe` stages nothing (the owner does), so there is correctly no
position there. **Nothing screen-derived reaches a command line**: the only numbers are
`BROWSER_WINDOW`'s constants and the parsed position; `RunDeps.position`'s doc comment (`run.ts:84-97`)
states honestly that a Terminal window is not moved, and `run.test.ts` pins that the terminal script
contains no coordinate.

### 6. `summarise`

Systematic sweep, modes × shapes (probe `Q6`), re-running the earlier re-reviewer's idea with
`coldstart` added: **no mode can be `accepted: true` having measured nothing.**

| mode | empty everything | why not accepted |
|---|---|---|
| `accuracy` | `accepted: false` | `missingGroups` = all five (`summary.ts:244-246`) |
| `toolbar` | `false` | `full` is false at `summary.ts:123` |
| `observe` | `false` | `read === 0` at `summary.ts:174` |
| `all` | `false` | all three |
| `coldstart` | `false` | `NOTHING_MEASURED` = `{NaN, "unknown"}` (`summary.ts:192`) |

`coldstart` is accepted **only** with `granted` + a finite `readyMs` (`summary.ts:210`): `0` passes,
`43912` passes, `denied`/`refused`/`unknown` fail, `NaN`/`±Infinity` fail and record `readyMs: null`.
Mutations **e**, **i**, **R9** all bite. `coldstart` is `null` in every other mode including `all`
(`summary.ts:242`, mutation **i**).

### 7. The structural move

Nothing `main.ts` used to guarantee is lost, with one small exception (Minor 4). Compared line by
line against `$S/exec2/backup/src/readerEval/main.ts`:

- **Page server before the helper, for staging modes:** kept — `main.ts:171-177` builds the staging
  (including `createPageServer`) and `main.ts:180` writes `observe-urls.json`, both before
  `startAndWaitReady` at `main.ts:183`. The reason (the terminal side gives up after 20 s while a
  cold helper takes up to 90 s) is now a comment at `main.ts:178-179`.
- **The temp folder is removed on every exit path:** kept — `removeScratch()` is still in the outer
  `finally` at `main.ts:241-246`, and it is `rmSync(..., {force: true})`, so the coldstart case where
  the folder was never created is a no-op.
- **The `NO_GRANT` refusal** is unchanged in strength: the old `permission.body.permission !==
  "granted"` and the new `permissionOf(...) !== "granted"` accept exactly the same answers, and the
  new one additionally launders the string. `requestPermission` is still never called.
- **The three refusals still come before anything is staged**, in the same order.
- **`observe-urls.json` gained `app`** (`main.ts:143`) — a fixed name from the case table.

### 8. Mutations

All 17 of the developer's mutations re-run from scratch in my own copy (`$S/exec2/rev-mutate.py`,
results in `$S/exec2/rev-mutations.json`). **Every one bites; every restore is byte-identical; the
failing counts match the report exactly.**

| # | File | Mutation | failing | restore |
|---|---|---|---|---|
| a | `run.ts` | `coldstart` runs the observe loop | 1 | identical |
| b1 | `config.ts` | a coordinate read with `Number()` | 8 | identical |
| b2 | `reader-eval.mjs` | the same, CLI side | 7 | identical |
| b3 | `config.ts` | the digit check lets a dot through | 1 | identical |
| c | `run.ts` | observe drops the nonce for a Chrome case | 1 | identical |
| d1 | `helper.ts` | `readyMs` from process start | 2 | identical |
| d2 | `helper.ts` | `readyMs` from `ready` | 2 | identical |
| e | `summary.ts` | coldstart accepted whatever the permission | 5 | identical |
| f | `run.ts` | no line boxes for a Chrome observe read | 1 | identical |
| g | `results.ts` | helper start time not written | 7 | identical |
| h | `helper.ts` | permission written as the helper's own string | 4 | identical |
| i | `summary.ts` | coldstart folded into `all` | 2 | identical |
| j | `run.ts` | accuracy staging ignores the position | 1 | identical |
| k | `reader-eval.mjs` | CLI always sends a position variable | 2 | identical |
| l | `cases.ts` | observe cases back to Safari only | 3 | identical |
| m | `config.ts` | empty `CLAVE_EVAL_POSITION` falls back | 1 | identical |
| n | `results.ts` | staged position not written | 8 | identical |

**My own ten** (`$S/exec2/rev-mutations2.json`); the four with **0 failing** are findings 1-3:

| # | Mutation | failing | verdict |
|---|---|---|---|
| R1 | `results.ts:331` observe rows serialised by spreading the row | **0** | **does not bite** → Important 1 |
| R2 | `results.ts:330` toolbar rows serialised by spreading the row | **0** | **does not bite** → Important 1 |
| R3 | observe guard takes whatever app the window reports | 2 | bites |
| R4 | `run.ts:454` Safari observe read stops asking for lines | **0** | **does not bite** → Minor 3 |
| R5 | a private window with no strip stops counting as missed | 1 | bites |
| R6 | `stagesWindows` says coldstart stages windows | 1 | bites |
| R7 | a helper that did not answer `permission` called `granted` | 1 | bites |
| R8 | `run.ts:463` observe rule always given Safari's app name | **0** | **does not bite** → Important 2 |
| R9 | coldstart accepted with a non-finite `readyMs` | 5 | bites |
| R10 | toolbar staging ignores the position | 1 | bites |

Three probe tests of mine close all four gaps; with them present R1 fails 2, R2 fails 1, R4 fails 2,
R8 fails 1 (`$S/exec2/rev-mutations3.json`). They are in `$S/exec2/probe-saved.ts` under
`REVIEWER: claims nothing currently pins`.

**Byte scan:** 32 files (all of `src/readerEval/**` plus both scripts) — no control byte outside tab
and newline, no `0x7f`, all valid UTF-8, non-ASCII limited to U+2014 / U+2026 and `score.test.ts`'s
pre-existing accented fixtures. The report's claim holds.

---

## Findings

### Critical

None. I could not break the guard, the allow-list or any acceptance rule.

### Important 1 — the results allow-list is unpinned for the `toolbar` and `observe` row bodies

`app/src/readerEval/results.ts:330-331` (claim stated at `results.ts:11-15` and `results.test.ts:50-54`)

`serialiseResults` builds every row by hand, and the file comment says "It never spreads an input and
never serialises an object it was handed… It has to be written in here, in a diff somebody reads."
No test holds that for a toolbar or an observe row. The sentinel run does drive the observe path, but
the sentinels never get *into* an `ObserveCaseResult` — `toolbarFacts` (`run.ts:343-362`) has already
filtered them — so driving it proves nothing about the serialiser. This task doubled the number of
observe rows (Safari + Chrome, `cases.ts:221-232`), which makes it the row shape most likely to grow
a field next.

*Reproducing probe:*
```
# in a copy, replace results.ts:331 with:
#   observe: results.observe.map((entry) => ({...entry})),
# and results.ts:330 with:
#   toolbar: results.toolbar.map((entry) => ({...entry})),
node $R/app/node_modules/vitest/vitest.mjs run --root <copy> src/readerEval scripts/reader-eval.test.ts
# -> 17 files, 590 passed. Nothing notices.
```

*Suggested fix:* extend `results.test.ts:219` ("ignores a field that was never meant to be written")
with a toolbar row carrying `text: "SMUGGLED-BODY-TOOLBAR"` and an observe row carrying
`toolbarText: "SMUGGLED-STRIP-OBSERVE"`, cast through `as never` exactly as the accuracy row is, and
assert neither reaches the file. Twelve lines; probe `PROBE R1/R2` in `$S/exec2/probe-saved.ts` is
ready to paste.

### Important 2 — the app string handed to the product's private rule in `observe` is unpinned

`app/src/readerEval/run.ts:463` (rule at `run.ts:350,356`; core at `core/exclusions/privateWindows.ts:33-37`)

The code is **correct** — `theCase.app`, which the guard has already matched exactly against the
window — and this is the whole of D17 for Chrome. But hard-coding `"Safari"` there fails no test.
The consequence of that regression is not academic: Safari's bare-word badge (`SAFARI_BADGE`,
`privateWindows.ts:32`) would then apply to Chrome, so a normal Chrome window on any address
containing `private` as a path segment — the exact case `privateWindows.ts:25-27` exists to exclude —
would be recorded as `private: true`, i.e. a `falsePrivate` that fails a run for a reason that is not
real, while the harness would no longer be measuring the product's actual Chrome rule at all. The
existing Chrome test (`run.test.ts`, "does not call a normal Chrome window private") uses a strip with
no private word in it, which is why it does not catch this.

*Reproducing probe:*
```
# replace run.ts:463's  app: theCase.app  with  app: "Safari"
# -> 17 files, 590 passed.
```

*Suggested fix:* one test — a `chrome-normal-*` observe row whose `toolbarText` is
`"127.0.0.1/acme/private-api  Private"` must come back `private: false` and `falsePrivate: 0`, and the
same strip in a `safari-*` row must come back `private: true`. Probe `PROBE R8`.

### Minor 1 — a `coldstart` whose helper never becomes ready throws away the number it measured

`app/src/readerEval/main.ts:183-188`

`startAndWaitReady` returns a usable `readyMs` even when `ready` is a timeout or a `down`
(`helper.ts:103-108`, proven by mutations d1/d2), but `main.ts:185-188` writes
`{"error":"PROTOCOL","code":"PROTOCOL"}` and returns, discarding it. `coldstart` exists to answer
"how long does a cold helper take" and "does the grant reach it" — and a helper that takes longer
than `DEFAULT_READY_TIMEOUT_MS` (120 s, `helper.ts:51`) is precisely the interesting answer. The owner
gets a fixed code instead of "it was still not ready after 120 000 ms". Fails safe, so Minor.

*Suggested fix:* for `mode === "coldstart"` only, write the ordinary results file with
`helper: {readyMs}`, `permission: "unknown"` and the shortfall verdict instead of the PROTOCOL error;
or leave it and record in the session log that a PROTOCOL result from `coldstart` means "not ready
within 120 s".

### Minor 2 — `readyMs` is taken from a wall clock, and a negative value would be accepted

`app/src/readerEval/main.ts:183`, `app/src/readerEval/summary.ts:206`

`now: () => Date.now()` is not monotonic. A cold helper start is 43-90 s (spec 10.1 item 4), long
enough for an NTP step to land inside it, and `summary.ts:206` only asks `Number.isFinite`, so
`readyMs: -500` would be recorded and `accepted: true`
(probe `Q6 > REVIEWER NOTE: a negative readyMs is accepted`). *Suggested fix:* either pass
`performance.now()` at `main.ts:183`, or tighten `summary.ts:206` to
`Number.isFinite(helper.readyMs) && helper.readyMs >= 0`. The second is one token and needs no new
injection point.

### Minor 3 — `lines: true` is pinned for the Chrome observe read but not the Safari one

`app/src/readerEval/run.ts:454`

Mutation **f** (the developer's) mutates the call to `lines: theCase.app !== CHROME`, which only
removes Chrome's. The mirror, `lines: theCase.app === CHROME`, fails **zero** tests — so a change
that silently dropped Safari's line boxes would pass. That is the one path carried item 29 (the
Safari private window, "the single most consequential unmeasured behaviour in the sub-project")
depends on for `privateBottomPx`. Pre-existing, but this task is what made the call shared between
two browsers and claimed the equality in prose (`cases.ts:204-205`). *Suggested fix:* assert
`reads[0].lines === true` in the existing Safari observe test too — probe `PROBE R4`, four lines.

### Minor 4 — an absurd `--position` is accepted by both parsers

`app/src/readerEval/config.ts:84`, `app/scripts/reader-eval.mjs:77`

Both stop at `Number.isSafeInteger`, so `--position 999999,999999` is taken and passed to
`--window-position=`. The window lands off every display, the guard never sees it, and every case
comes back `notStaged` — fail-closed, so the run is `incomplete`, never a false pass — but it costs
the owner a full ten-minute session for a typo the parser could have caught before the bundle opened,
which is the reason decision 4 refuses a malformed position in the first place. I judge an absurd
value a defect rather than acceptable latitude, but a small one. *Suggested fix:* one bound, written
once per side, e.g. `value > 30_000 ? null : value`, with the two rows added to the existing refusal
tables.

### Minor 5 — `waitReady` no longer runs inside the `try/finally` that shuts the helper down

`app/src/readerEval/main.ts:183-184` (was: `waitReady` inside the `try`)

Folding `waitReady` into `startAndWaitReady` moved it outside `main`'s `try`, so a rejection there
would skip `helper.shutdown()` (`main.ts:230`). Unreachable today —
`createEvalHelper.waitReady` (`helper.ts:165-179`) returns a promise that only ever resolves — and the
outer `app.quit()` would take the child with it. Worth a line of awareness rather than a change.

### Minor 6 — an arithmetic slip in the dev report's addendum

`$S/exec2/task-1-dev-report.md`, addendum: "Fourteen files now differ from the pristine copy
(thirteen under `src/readerEval/**` plus the two scripts…)" — 13 + 2 = 15, and `diff -r -q` against
`$S/exec2/backup` shows **15**. §1's "Thirteen files changed" was written before the addendum added
two more and was not updated either. The file list itself is complete and correct.

---

## Observations (no action)

- **A doubly-titled window is read once per matching case** and both rows are recorded; one must
  disagree with its own `expectPrivate`, so the run fails. Only reachable by hand-crafting a
  `stagedTitle` parameter. Fail-closed.
- **A failed observe read is never retried** for that case (`run.ts:451`), so a transient `black` or
  `timeout` costs the whole case and makes the run incomplete. Pre-existing and deliberate.
- **The observe row's `app` is not printed** by `formatSummary` (`scripts/reader-eval.mjs:241`), but
  the case name carries the browser slug, so nothing is lost.
- The decision to record `permission` in **every** mode (dev decision 2) is harmless: in the other
  four it can only be `granted`, because `main.ts:192-195` refuses otherwise.
- `main.ts` remains untested, as the report states. The two claims it now carries —
  "coldstart stages nothing" and "which parts a mode runs" — are values elsewhere
  (`stagesWindows`, `runMode`) that tests do hold, which is a real improvement over three
  `mode === …` tests buried in the entry point.

---

## Verdict

**CHANGES REQUIRED** — two Important findings, both closed by adding tests only; no behaviour change
is needed anywhere. The installed code is correct on every question I was asked: `coldstart` really
sends nothing, the guard really cannot be made to read an unstaged window in either browser, the
private rule really is the product's own called with the product's own Chrome name, the results file
really carries no string a helper or a title could have supplied, and no mode can be accepted having
measured nothing. What is missing is proof, in the two places the plan's own Step 2 standard demands
it.

Spec compliance: ✅
Quality: Not approved
