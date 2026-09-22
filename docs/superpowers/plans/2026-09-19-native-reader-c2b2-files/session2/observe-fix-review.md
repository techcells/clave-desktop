# Independent review — OBSERVE mode fixes (O1, O3, O4, O5, O6)

2026-09-21. Reviewer did not write the change. Nothing was run against a screen, no bundle was
launched, no script was executed, no browser or Terminal window was opened, no git.

Method: diffed `session2/pre-observe-fix/` against `app/src/readerEval` and `app/scripts/reader-eval.*`;
read every changed file; ran the harness suite and `tsc` against a private byte-identical copy
(`$S/s3/rv/app`, verified `diff -rq` clean against `app/` before and after); re-ran the developer's
18 mutations plus 17 of the reviewer's own, each restored by writing the original bytes back and
`cmp`-ed against `app/`.

**Baseline, re-verified after every probe:** 18 files / **1092 tests pass**, `tsc --noEmit` clean,
`bytes.test.ts` green (it walks the whole `readerEval` folder recursively — `bytes.test.ts:38-41` —
so `observe.ts` and `observe.test.ts` are inside the scan, and the folder scan grew from 16 files to
18 without the scan needing a change).

---

## 1. ACCEPTANCE — can an observe run be accepted without having earned it?

**No counter-example found.** The chain is `accepted` → `observeVerdict.passed` → `reason === null`
(`summary.ts:348-355`, `:246`), and `reason` is decided in a fixed order at `summary.ts:231-235`:

| Probe | Where it is decided | Result |
| --- | --- | --- |
| no `--expect` at all | `summary.ts:232` `expect === null ? "EXPLORATORY"` | `passed: false`, exit 2. Pinned by `summary.test.ts` *"never passes a run that was asked for nothing, however perfectly it read"* — including the exact one-read run of 2026-09-21 |
| expected private case never read | `summary.ts:215-217` `missingCases` | `INCOMPLETE`, the case is NAMED |
| expected case read and the read failed | same — `usable` is `outcome === "ok"` only (`summary.ts:209`) | `INCOMPLETE`, and `privateMissed` stays 0 (`summary.test.ts` asserts both) |
| read ok with `private: false` on a private case | `summary.ts:210` `private !== true` | `privateMissed: 1` → `NOT_AS_EXPECTED` |
| read ok with `private: null` (no strip) on a private case | same | `privateMissed: 1` → fails. Deliberately `!== true`, not `=== false` |
| `windowGone` three times | `run.ts:905` keeps the row in `failed`, never `done` | row survives to the file with `outcome: windowGone`, `readAttempts: 3`; `missingCases` names it; terminal prints `NOT READ: windowGone` |
| normal case flagged private | `summary.ts:211` `falsePrivate` | `NOT_AS_EXPECTED`, and it fails **wherever it occurs**, expected set or not |
| empty `--expect` | `observe.ts:74` (`raw.length === 0`) and `reader-eval.mjs:85` | refused: `BAD_EXPECT` / `problem: "--expect"` |
| a set resolving to **zero cases** | `summary.ts:233` `expect.cases.length === 0` | `INCOMPLETE`. Explicitly guarded and explicitly tested (`summary.test.ts` *"fails an expectation that resolved to no case at all"*) |
| duplicates in a comma list | `observe.ts:79` and `reader-eval.mjs:88` | refused on both sides |
| `--expect` in a non-observe mode | `config.ts:227` `EXPECT_NOT_APPLICABLE`; `reader-eval.mjs:299` `problem: "--expect"` | refused with a fixed code in BOTH parsers |
| **caller forgets the new parameter** | `summary.ts:327` and `:196` both default to `null` | the strict answer: `EXPLORATORY`, never accepted. Probe R3 (defaulting it to a zero-case expectation instead) **bit**. |

`inExpectSet` (`observe.ts:50-58`) decides membership on the case's own `app` and `expectPrivate`,
never on its name — the right call, and tested both ways.

## 2. RETRY

- **Fresh approval every attempt.** `run.ts:861` re-reads the front window at the top of every poll;
  `run.ts:868` builds a new `Approval` from *that* window; `run.ts:870` reads it. `readApproved`
  puts `approval.window` into the `read` line's `expect` (`helper.ts:190-193`), and `approve`
  (`guard.ts:71-81`) is unchanged — exact app, this case's staged title carrying this run's nonce.
  No `Approval` is ever stored across iterations. ✅
- **Bounded twice.** By attempts (`run.ts:867`, `OBSERVE_READ_ATTEMPTS_MAX = 3`, `observe.ts:123`)
  and by the clock (`run.ts:860` `deps.now() < until`), with `deps.sleep(OBSERVE_POLL_MS)` (2 s,
  `thresholds.ts:77`) at the bottom of every iteration. No spin. ✅
- **A case is closed only by an `ok` read.** `done` is written only in the success branch
  (`run.ts:896`); the failure branch writes `failed` (`run.ts:905`) and a later success deletes the
  failed row (`run.ts:903`). `wanted.every(name => done.has(name))` is the only early exit. ✅
- **After 3 failures:** reported with `outcome` + `readAttempts: 3`, named in `missingCases`, run
  `INCOMPLETE`, printed `NOT READ: <code>`. ✅ (see Minor 3 for the one wrinkle.)

## 3. FILES

- **Nonce is unpredictable** terminal-side: `randomBytes(6).toString("hex")` (`reader-eval.mjs:741`).
- **Not validated bundle-side** — see **Important 3**. `config.ts:243` takes `CLAVE_EVAL_NONCE`
  verbatim and `main.ts:176`/`:190` now put it into a file NAME.
- **Atomic:** both files go through `writeAtomic` (`main.ts:79-83`, write `.partial` then `rename`).
  The progress writer is additionally wrapped in a `try`/`catch` so a write failure loses the
  commentary, not the run (`main.ts:195-197`). ✅
- **Progress file contents:** six fields per row, all number/boolean/case name/fixed code by TYPE
  (`results.ts:390-400`) and written out one by one (`serialiseObserveProgress`, `results.ts:747-762`).
  No title, no text, no host string — the host is deliberately **not** in the progress file.
  Sentinel-pinned: M9 (spread the row in `run.ts`) and M10 (spread it in `results.ts`) both **bit**,
  and `results.test.ts:135-167` drives the real sentinel run through the progress path.
- **The old fixed-name urls file is never read** by the code (grep: the string survives only in two
  comments) — but the *call site* that reads it is untested. See **Important 1**.

## 4. `hostDistance` (`score.ts:186-203`)

Pure; takes a `string | null` and a host, returns one integer or `null`; the strip is not stored
(`run.ts:660-662` computes it from the string in hand and the string dies with the function).
Bounded 0..64 (`score.ts:151`, `:202`). `null` for no strip, an empty strip, or an empty host.
Correctness pinned in `score.test.ts`: exact → 0 (and agrees with `hostInToolbar` on the same pair),
one substitution → 1, dropped dot → 1, absent → > 2, strip of 200 000 characters → bounded.

**Cost** (measured by the reviewer with a stand-alone copy of `lev` + `hostDistance`, not by running
the harness): O(strip × host²) over 5 window widths, with an early return at distance 0.

| strip | host | bounded (1024) | unbounded |
| --- | --- | --- | --- |
| 200 000 | 9 (`127.0.0.1`) | **18 ms** | 1891 ms |
| 200 000 | 63 (grammar max) | **554 ms** | — |
| 96 (the real measured strip) | 9 | **2 ms** | — |

So no quadratic blow-up in the strip; the 1024 bound is what buys that. See Minor 1 and 2.

## 5. `--host`

Closed grammar, counted by hand, no regular expression: `observe.ts:174-193` and
`reader-eval.mjs:104-118`. Lowercase a-z, 0-9, `.`, `-`; ≤ 63; every label non-empty and neither
starting nor ending in a hyphen; then **only** `127.0.0.1`, `localhost`, or `*.localhost`. `:`, `/`,
`?`, `@`, space and uppercase are all outside the character class, so nothing else can reach the URL
the owner pastes. On the command line it travels as one `--env NAME=value` argv element to
`/usr/bin/open` spawned without a shell (`reader-eval.mjs:308-312`, `:749`) — no injection surface,
and `=` is not in the grammar. Both parsers are byte-for-byte the same rule; M12 (widen the bundle's)
bit in both `observe.test.ts` and `config.test.ts`, and `HOST_MAX === OBSERVE_HOST_MAX` is asserted.
The host never reaches `stage.ts`'s generated `.command` files — `main.ts` uses it only for
`writeObserveUrls` and `observeHost` (`main.ts:294`, `:339`). ✅

## 6. Labels

One rule, two implementations held to the same table: `readAsExpected` (`observe.ts:134-137`) in the
bundle, `observeLabel` (`reader-eval.mjs:441-448`) on the terminal. `would be KEPT` requires
`outcome === "ok" && expectPrivate && private !== true`; any failed outcome prints
`NOT READ: <code>`. M15 (drop the outcome guard) failed 5 tests — one per outcome code. `privateMissed`
counts only successful reads (`summary.ts:209-210`); probe R1 (count all rows instead) **bit**, and
R2 (drop the `outcome !== "ok"` guard in `readAsExpected`) **bit** 5 times. ✅

## 7. Untouched

`diff -rq` against `session2/pre-observe-fix/readerEval`: **`guard.ts`, `thresholds.ts`, `cases.ts`,
`stage.ts`, `stagedTitle.ts`, `pages.ts`, `server.ts` are byte-identical.** `approve` is untouched.
In `summary.ts` the only changes are `summariseObserve`'s body and `summarise`'s new trailing
parameter — `summariseGroups` and `summariseToolbar` (the accuracy and toolbar acceptance rules) are
untouched, and `accepted`'s expression gained nothing. In `score.ts` the only change is the added
block at `:131-203`; `norm`, `lev`, `accuracy`, `confusions`, `markerHits` are untouched.
Schema 4 is justified and the new fields are all typed (`results.ts:229-240`, `:274-285`, `:341-376`).
Coverage of those fields in the FILE is the gap in **Important 2**.

## 8. Mutation re-run

All 18 of the developer's mutations were re-applied to the private copy and re-run. **17 bit.**

The seven the brief requires, with the first named failure:

| # | Result | First failing test |
| --- | --- | --- |
| M1 exploratory becomes a pass | **BIT** (5) | *the observe verdict › never passes a run that was asked for nothing…* |
| M2 missing expected case stops failing | **BIT** (6) | *…fails when one expected case was never read at all, and names it* |
| M3 a failed read marks the case seen | **BIT** (3) | *a read that failed does not close the case › tries again at the next poll…* |
| M8 `hostDistance` answers 0 for an absent host | **BIT** (5) | *how far the strip was from the host › is 1 for one substitution…* |
| M9 progress row spread in `run.ts` | **BIT** (1) | *…reports six fields and no others, and not one string the helper sent* |
| M10 progress file spreads its rows | **BIT** (1) | *…writes a progress row as six named fields, and drops anything smuggled* |
| **M13 the fixed-name (stale) urls file is read** | ***SURVIVED*** (3 runs) | — see **Important 1** |

The other eleven: M4, M5, M6, M7, M11, M12, M14, M15, M16, M17, M18 all bit, each naming the test the
developer's report names. Every restore `cmp`-ed clean against `app/`.

Reviewer's own 17 probes: R1–R5, R9–R12 bit; **R6 flaked** (survived 1 of 4 — Minor 1);
**R7, R8, R13–R17 survived** (Important 2).

---

## Findings

### Critical

None.

### Important

**I1 — the terminal-side call site of the O3 fix has no test; the exact bug can come straight back.**

*Probe:* on the private copy, change `reader-eval.mjs:698`

```js
const file = readRunFile(outDir, observeUrlsName(nonce));
```

back to `readRunFile(outDir, "observe-urls.json")` — i.e. finding O3 reinstated verbatim. Result:
**18 files / 1092 tests pass**, three runs in a row. `watchObserve` (`reader-eval.mjs:696-722`) is
module-private and is not imported by `reader-eval.test.ts`; the tests at `reader-eval.test.ts:872-916`
cover `observeUrlsName`, `readRunFile` and `clearRunFiles` — the *helpers* — never the caller that
was the bug. `main.ts` has exactly the right tripwire for its half
(`helper.test.ts:376-380`, `expect(source).not.toContain("observe-urls.json")`); the terminal half has
none.

*Suggested fix:* the cheapest is the symmetrical tripwire in `reader-eval.test.ts` —
read `reader-eval.mjs` as text and assert it contains `readRunFile(outDir, observeUrlsName(nonce))`
and `readRunFile(outDir, observeProgressName(nonce))` and **not** `"observe-urls.json"` as a string
literal. Better still, export `watchObserve`'s file resolution (e.g. `observeFilesFor(outDir, nonce)`)
and assert the two paths it returns.

**I2 — none of schema 4's new fields is asserted in the serialised results file.**

*Probes,* each applied alone to the private copy; every one left **1092/1092 green**:

| results.ts | mutation | survived |
| --- | --- | --- |
| `:577` | `hostDistance: value.hostDistance ?? null` → `hostDistance: null` | ✅ |
| `:669` | `readAttempts: entry.readAttempts ?? null` → `readAttempts: null` | ✅ |
| `:707` | `expected: …observe.expected` → `expected: 0` | ✅ |
| `:708` | `missingCases: [...…]` → `missingCases: []` | ✅ |
| `:712` | `reason: …observe.reason` → `reason: null` | ✅ |

`results.test.ts:358-366` asserts the observe/toolbar row **key set** (so a *missing* field is
caught) but never a value, and the observe *verdict* block of `serialiseResults` has no assertion at
all. The verdict LOGIC is covered thoroughly in `summary.test.ts`; what is not covered is the
copying of it onto disk. The consequence is specific: `hostDistance` is the one number the whole O5
fix exists to deliver to the owner, and it could be silently nulled on the way to the file with the
suite still green.

*Suggested fix:* one test in `results.test.ts` that serialises a fully-populated observe verdict and
one populated observe row and asserts the parsed values (`hostDistance: 2`, `readAttempts: 2`,
`expect: ["safari-private"]`, `expected: 5`, `missingCases: ["…"]`, `reason: "INCOMPLETE"`), plus a
key-set assertion on `summary.observe` so a smuggled field there is caught the way a row's is.

**I3 — the run nonce is now part of a file NAME and is still unvalidated on the bundle side.**

`config.ts:243` is `nonce: env.CLAVE_EVAL_NONCE || newNonce()` — no grammar check, unchanged from
before. What changed is where it goes: `main.ts:176` and `:190` build
`join(outDir, "observe-urls-" + nonce + ".json")` and the progress name beside it. Before this task
the nonce never reached a path (the file had a fixed name). `stagedTitleOf` caps the whole staged
title at 40 characters (`cases.ts:446`), which leaves ~25 characters of nonce — more than enough for
`../../../../tmp/x`, and `path.join` normalises it straight out of `outDir`. (`writeObserveUrls` is
not inside a `try`, so it would abort the run rather than fail silently; the progress writer is, so
it would fail silently.)

This is not a privilege boundary — `CLAVE_EVAL_NONCE` is the owner's own environment and the
terminal always mints 12 hex characters — so it does not block the run. It is the closed-grammar
property this harness holds `--limit`, `--position`, `--variant`, `--expect` and `--host` to, absent
on the one input that now names a file.

*Suggested fix:* a `parseNonce` in `config.ts` beside `parseLimit` — lowercase hex, exactly 12,
counted by hand — refusing with a new `BAD_NONCE` code, plus a test that
`observeUrlsName(nonce)` can never contain `/` or `..`.

### Minor

1. **The 1024-character scan bound is pinned only by a wall clock.** `score.test.ts` asserts
   `Date.now() - started < 1_000` on a 200 000-character strip. Removing
   `.slice(0, HOST_STRIP_SCAN_MAX)` (`score.ts:188`) **survived one run of four** — the unbounded
   scan measures 1891 ms stand-alone but came in under a second once inside a warm suite. A timing
   assertion is a flaky guard. Suggest asserting the bound structurally instead (e.g. that a host
   placed at character 2000 of a strip reports a large distance while the same host at character 500
   reports 0), keeping the timing check as a loose backstop.

2. **Worst-case cost is real, if unreachable today.** With the grammar's longest host (63) and a full
   1024-character strip the scan is ~554 ms per read; `toolbar` mode would pay that 40 times. Real
   strips measured 15–96 characters (2 ms). Decision 5 of the dev report is sound; consider also
   narrowing the scan when `hostInToolbar` is already true, since that pair is the common case and
   the `best === 0` early return only helps once it reaches the match.

3. **An expected case that exhausts its three attempts stops the early end.** `run.ts:867` skips it
   forever, so it can never enter `done`, so `run.ts:860`'s `wanted.every(…)` never becomes true and
   the run burns the rest of `--seconds`. Safe direction (the owner may restage the window and the
   guard will refuse nothing), but the usage text's *"it ends as soon as every expected case has been
   read"* is then not quite true. Worth one clause in the `--seconds` help.

4. **`strip.slice(0, HOST_STRIP_SCAN_MAX)` slices UTF-16 units** and can split a surrogate pair at the
   boundary; `lev` then compares a lone surrogate (it spreads to code points). Bounded, no leak, and
   it only perturbs a distance at character 1024 of a strip nobody has produced. Cosmetic.

5. **An expected NORMAL case with no toolbar strip at all passes.** `outcome: "ok"` with
   `toolbarTextPresent: false` gives `host: null`, `private: null`; `readAsExpected` (`observe.ts:136`)
   answers `true` for a normal case on `private !== true`, and `falsePrivate` (`summary.ts:211`) needs
   `private === true`. So `--expect safari-normal` can be ACCEPTED having measured no strip. This
   matches the stated rule and is pre-existing, and it does **not** affect the private direction
   (item 29), which fails on `null`. Flagged so the owner reads a `safari-normal` pass correctly.

6. **The two `--host` grammars are duplicated and tested from different tables.** `observe.test.ts`
   refuses `.localhost`, `-a.localhost`, `a-.localhost`; `reader-eval.test.ts:838-847` omits those
   three. Both implementations agree today (M12 confirms the bundle's is load-bearing). Suggest
   giving the terminal's table the same rows.

7. **The terminal prints `row.outcome` and `row.case` straight from the progress file**
   (`reader-eval.mjs:458-462`) without re-checking they are a fixed code and a case name. The file is
   this run's own — random nonce, deleted before the bundle starts (`reader-eval.mjs:742`) — so this
   is defence in depth only.

8. **`formatSummary` does not check the results file's `schema`.** A version-3 file read by the new
   terminal would print `expect (none)` with no `EXPLORATORY` line and could show `PASS`. Only
   reachable by pointing the formatter at an old file, which the normal flow never does.

---

## Verdict

**Spec compliance ✅** — every rule the brief names holds: without `--expect` an observe run can
never be accepted (exit 2); with it, it passes only if every case of the set was read `ok` and agreed
with its own name; retries are fresh guard approvals against the window in front at that moment,
bounded by attempts and by the clock; the progress file is numbers, booleans, case names and fixed
codes, written atomically through a hand-written allow-list; `hostDistance` is pure, bounded and
leaks nothing; `--host` is a closed loopback-only grammar in both parsers; `would be KEPT` is
reserved for successful reads; thresholds, the guard's `approve`, and the accuracy and toolbar
acceptance rules are byte-identical to the pre-fix snapshot.

**Quality: Approved** — with I1, I2 and I3 to be closed before the next harness change. They are all
test-coverage or defence-in-depth gaps, not live defects: none of them can make the run the owner is
about to do report the wrong answer.

**OK to run with the owner: yes.** The command in the dev report
(`observe --expect safari-private --host app.clave.localhost --seconds 600`) is safe and the
acceptance it produces means what it says. Two things to watch on the day, both already predicted in
the dev report §8: if Safari does not resolve `*.localhost`, every case returns `notStaged` with
`pageRequests: 0` within a minute; and the running commentary only appears because `open` is spawned
with `-W` (`reader-eval.mjs:309`) — if no `read …` lines appear at all while windows are in front,
that is the progress file, not the reader.
