# Re-review E — "Loop 3 fix round 2", against re-review D

Scope: `$S/s1/harness-repair-report.md` section "Loop 3 fix round 2" (proofs H1–H11) against
`$S/s1/loop3fix2.diff`, checked against re-review D's findings (`$S/s1/rereviewD.md`: Important 1,
Important 2, Minors 1–5) and the code now (`$R/app`, read-only). Every mutation was exact-string in
the private copy `$S/s1/rrE/app` (seeded from `$S/s1/rrD/app` + `loop3fix2.diff`, confirmed identical
to `$R/app` before any mutation), restored and `cmp`/`diff -rq`-checked after each one. **Nothing was
run**: no harness, no bundle, no generated `.command`, no `pnpm`, no `dist/reader-eval.cjs`, no
browser or Terminal window. `scripts/reader-eval.mjs`'s entry gate
(`process.argv[1].endsWith("reader-eval.mjs")`, line 497) is unchanged by the diff and was reconfirmed
before relying on vitest's own import of the module. `node_modules` in `rrE/app` is still the intact
symlink to `$R/app/node_modules`.

## Gates

| gate | result |
|---|---|
| `vitest run --root rrE/app src/readerEval scripts/reader-eval.test.ts` | **924 passed in 17 files** (was 908 in rereviewD; +16 tests, matching the diff exactly — see tally below) |
| `tsc --noEmit -p rrE/app/tsconfig.json` | **exit 0, no output** |
| `src/readerEval/bytes.test.ts` | **40 passed** (file untouched by this diff) |
| `rrE/app/src`, `rrE/app/scripts` vs `$R/app` before any mutation, and after every restore | **identical** (`diff -rq` / `cmp` rc 0 every time) |

New-test tally, counted against the diff: cases.test.ts +1, helper.test.ts +1, results.test.ts +5
(2 describes), run.test.ts +3 (1 describe), server.test.ts +4 (1 describe), reader-eval.test.ts +2
(1 describe) = **16**, and 908 + 16 = 924. No test was deleted or renamed.

---

## Important 1 — the `PAGE_SERVER` refusal reaching the file

**Fixed.** `main.ts:248-266`: the staging block is now `if (stagesWindows(mode)) { ... }` (an IIFE no
longer), and `createPageServer(truth, titles)` is called inside its own `try { ... } catch { ... }`
that writes `serialiseError({error: "HARNESS", code: PAGE_SERVER_REFUSAL})` and `return`s — before the
helper is ever spawned (`spawnHelper` is at line 274, after this block), so there is no helper to
shut down on this path; `removeScratch()` still runs because it is in the outer
`app.whenReady().then()`'s `finally` (line 358-362), which covers every path out of `main()`,
including this early return. `PAGE_SERVER_REFUSAL` (imported at `main.ts:44`) is no longer the dead
import re-review D flagged.

**Revert proof (H1/H2 equivalent).** Removed the inner `try/catch` and let the throw fall through to
the block's caller (the pre-fix shape) → `helper.test.ts`'s new source-shape pin fails
(1 failure: `writes the page server's own refusal code, from the imported constant`). Restored,
`cmp`-identical.

**Terminal side.** `scripts/reader-eval.mjs`: `HINTS.PAGE_SERVER` added (lines 251-252), naming the
refusal and what it means ("another local process may hold it. Nothing was opened."). Revert (dropped
the `HINTS.PAGE_SERVER` entry) → 2 failures (`Object.keys(HINTS)` pin, and the new
"is named, with what it means" test). Restored, `cmp`-identical. `exitCodeFor` is unchanged and
generic (any `error` string exits 1), so `PAGE_SERVER` exits 1 by the same rule as every other
harness refusal — read, not reverted, since nothing about this diff touches that function.

## Important 2 — `refusedTitleLength` walked end to end

**Fixed, at all four sites re-review D named, plus the top-level shape.**

| site | revert | result |
|---|---|---|
| accuracy row (`run.ts:495`, in `none(...)`) | hard `refusedTitleLength: null` | **1 failure** (`run.test.ts`: "is on a notStaged accuracy repetition") |
| toolbar row (`run.ts:707`) | hard `refusedTitleLength: null` | **1 failure** ("is on a notStaged toolbar row") |
| accuracy serialiser (`results.ts:560`) | hard `refusedTitleLength: null` | **1 failure** ("carries the number on an accuracy repetition") |
| toolbar serialiser (`results.ts:502`) | hard `refusedTitleLength: null` | **2 failures** (the number test, and the "null as null, not absent" test — the latter used `withLength(0)`, which a `null` fails on `.toBe(0)`) |

All four restored, `cmp`-identical to `$R/app`.

**Top-level field pins now exist**, closing the exact hole that let `pageServerIpv6` go missing
unnoticed in the earlier round: `results.test.ts` adds "the shape of the file itself" with
`Object.keys(written).sort()` and `Object.keys(written.summary).sort()` pinned by name. Revert (dropped
`pageServerIpv6: results.pageServerIpv6,` from `serialiseResults`) → **3 failures** (both key-list
pins, plus the pre-existing `pageServerIpv6` value test from review D). Restored, `cmp`-identical.

## Minor 1 — IPv4-bind branch, injectable `listen`

`createPageServer` takes a 6th... third parameter, `listen`, defaulted to the real `listenOn`
(`server.ts:119`). **Confirmed test-seam-only**: `grep` for `createPageServer(` across `src/` finds
exactly one production call site (`main.ts:256`, two arguments only — `truth, titles`, no `listen`
override) and the rest are in `server.test.ts`/`helper.test.ts`. There is no CLI flag, environment
variable, or config path that reaches the third parameter — it is unreachable except by a test
importing the function directly.

Revert proof: raised the retry bound (`PAGE_SERVER_TRIES` → `PAGE_SERVER_TRIES + 3` inside the loop
condition) → **1 failure** ("tries the bounded number of times and no more", expected 5 got 8),
confirming the injected `listen` genuinely drives the real retry loop rather than being decorative.
Restored, `cmp`-identical.

## Minor 2 — `server.ts` docs match behaviour

Read directly. `PageServer.ipv6`'s doc (lines 20-27) now says "It is always `true` on a server this
function returns: a half-bound pair is refused rather than used", replacing the stale "best-effort ...
leaves `ipv6: false`" language re-review D flagged. `createPageServer`'s doc (lines 78-97) now has
"**Neither half alone.**" and describes the retry-then-refuse behaviour the code implements. Both
paragraphs are consistent with the code read above; not reverted (no test pins prose), confirmed by
eye against the function body.

## Minor 3 — `stagedTitles` required, empty list refused

`server.ts:114`: `stagedTitles: readonly string[]` has no default (was `= []`); a caller that omits it
is a compile error, not a caller trusting a fallback. At runtime, line 125:
`if (stagedTitles.length === 0) throw new Error(PAGE_SERVER_REFUSAL);`.

Revert proof: removed the runtime throw → **1 failure** ("refuses an empty seed list, which would
zero every counter" — the promise resolved instead of rejecting). Restored, `cmp`-identical.

## Minor 4 — `STAGED_TITLE_MAX` enforced where minted, pinned to 40

`cases.ts:431`: `STAGED_TITLE_MAX = 40`. `stagedTitleOf` (the function every staging and every
observe-URL path calls — `main.ts:177`, `run.ts:318,672,785`) now enforces it:
`if (title.length > STAGED_TITLE_MAX) throw new Error("EVAL_TITLE_TOO_LONG");` (line 446), no longer
"decorative". `cases.test.ts` pins the cap against the **literal** `40`, not against the constant
itself (`expect(STAGED_TITLE_MAX).toBe(40)`), closing re-review D's exact complaint that raising the
constant used to pass.

Revert proof: `STAGED_TITLE_MAX = 40` → `400` → **1 failure** (the literal pin). Restored,
`cmp`-identical.

*Observation, not a defect of this round, out of scope for the verdict:* `main.ts:254` seeds the page
server's counter map via `stagedTitleFor(id, nonce)` directly — the un-capped minting primitive in
`stagedTitle.ts` — rather than through `stagedTitleOf`. That line is unchanged by `loop3fix2.diff`
(present already in `rrD`), so it predates this fix round and isn't one of the listed items. In
practice it is not reachable with an oversized value through the shipped CLI: `reader-eval.mjs` always
generates the nonce itself (`randomBytes(6).toString("hex")`, `scripts/reader-eval.mjs:467`) with no
flag to override it, and `CLAVE_EVAL_NONCE` is read straight off `process.env` with no length check in
`config.ts`. Recording it because Minor 4 asked where the cap is enforced; it does not change the
verdict on Minor 4, which is about `stagedTitleOf`, the path every actual staging and observe-URL uses
and which does throw.

## Minor 5 — `limited` JSDoc alignment

Read on the bytes (`main.ts:313-319`, via a small script checking each line's leading-space count):
`/**` at 4 spaces, continuation `*` lines at 5, `const limited` at 4 — matching the report's claim
("was at six spaces ... it is at four, with its continuation at five") and no longer the `rvD`
indentation re-review D complained about. No test pins this (cosmetic, as before); confirmed by direct
reading rather than reverted.

---

## Confirmed unchanged by this diff

- `guard.ts`, `thresholds.ts`, `score.ts`, `summary.ts`: `cmp`-identical, byte for byte, to `$R/app`.
  `approve` (`guard.ts:71`) is untouched; the acceptance rules re-review D checked in `summary.ts`
  stand as before.
- `serialiseError` (`results.ts:624-634`): still writes only `error` (closed union), `code` (a fixed
  string a caller supplies), and `readyMs` when it's a finite non-negative number — no message field,
  no path, no window title. The new `PAGE_SERVER` path calls it with `{error: "HARNESS", code:
  PAGE_SERVER_REFUSAL}`, no `readyMs`: the file gains a fixed code, not a string of anything read.
- `EvalError`'s `error` field stays the closed union `"PROTOCOL" | "NO_GRANT" | "HARNESS"`; nothing
  about this diff widens it.

---

## Verdict

Thirteen items were in scope: Important 1, Important 2 (both proved at all four+one sites), and Minors
1-5. All thirteen bite under hand revert (or are confirmed by direct reading where no test exists,
per the original claim: Minor 2's prose and Minor 5's JSDoc). Every reverted file was restored to be
byte-identical to `$R/app`, confirmed by `cmp`/`diff -rq` after each round trip, and the full harness
suite plus `tsc` are green on the untouched code. Nothing else in `src/readerEval` or `scripts/` was
touched by `loop3fix2.diff` beyond the ten files it lists, and the four acceptance-rule files
(`guard.ts`, `thresholds.ts`, `score.ts`, `summary.ts`) are unchanged.

**ALL ADDRESSED — OK TO RUN**
