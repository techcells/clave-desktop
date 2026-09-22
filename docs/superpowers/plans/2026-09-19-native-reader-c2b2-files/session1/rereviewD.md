# Re-review D — `reader:eval`, the "Loop 3 fix round"

Scope: `$S/s1/harness-repair-report.md` section "Loop 3 fix round" (G1–G13) against `$S/s1/loop3fix.diff`
and the code now (`$R/app`), read against `reviewD.md` (I1–I4, M1–M7). Item **A** (the short staged
titles) is reviewed fresh, not merely re-checked.

Method: read-only against `$R/app`; every mutation exact-string in the private copy `$S/s1/rrD/app`,
restored and `diff -rq`-checked. **Nothing was run**: no harness, no bundle, no generated `.command`,
no `pnpm`, no `dist/reader-eval.cjs`, no browser or Terminal window. `scripts/reader-eval.mjs`'s
entry gate (`process.argv[1].endsWith("reader-eval.mjs")`, line 495) was read before the module was
imported by any test. One throwaway vitest probe was written into `rrD`, run and deleted; `rrD/app/src`
and `rrD/app/scripts` are byte-identical to `$R/app` at the end of this review.

## Gates

| gate | result |
|---|---|
| `vitest run --root rrD/app src/readerEval scripts/reader-eval.test.ts` | **908 passed in 17 files** |
| `tsc --noEmit -p rrD/app/tsconfig.json` | **exit 0, no output** |
| `src/readerEval/bytes.test.ts` | **40 passed** |
| `rrD/app/src`, `rrD/app/scripts` vs `$R/app` after every mutation | **identical** (`diff -rq` rc 0) |

---

## A. NEW DESIGN — the short staged titles

Measured shape (probe): 78 cases across the three tables, **78 distinct ids**, every staged title
**27 characters** — `CLAVE-EVAL t13 38f0f465d288`, `CLAVE-EVAL a00 …`, `CLAVE-EVAL o02 …`; the
terminal's finished title is `CLAVE-EVAL a16 38f0f465d288 READY 140x30.` (41 with the READY mark).

**Can two cases of one run share an id? No.**

- Across tables: one letter each (`CASE_ID_LETTERS`, `cases.ts:401`). Revert **A2** (`toolbar: "a"`)
  → **3 failures** in `cases.test.ts`.
- Within a table: the index is the position in the static array, unique by construction.
- A *name* collision across tables would silently shrink `CASE_IDS` (it is keyed by name) and give
  two cases one id. The `allStagedIds()` set-size assertion catches that; the probe confirmed it
  directly — 78 names, 78 ids, no duplicates.
- **The bookmarks-bar variant adds no case.** `--variant bookmarks-bar` is a Chrome *profile*
  preference (`stage.ts:45-46`, `chromePreferences`), written into the staged profile; it does not
  appear in any table, in the id, or in the title. One run has one variant, so it cannot collide.

**Is the id→case mapping a pure function of the static tables? Yes.**

`CASE_IDS` (`cases.ts:408-412`) is a module-level `Map` built once from `ACCURACY_CASES`,
`TOOLBAR_CASES`, `OBSERVE_CASES` in declaration order; `stagedIdFor` is a lookup **by name**.
`interleavedToolbarCases` and `limitedTo` reorder and slice the *run*, never the map. Revert **A5**
(toolbar ids taken from the interleaved index instead) → **1 failure**, the `" t13 "` pin in
`cases.test.ts` — so the index identity is held by a test, not by reading. `--limit` is applied only
inside `runAccuracy`/`runToolbar` (`run.ts:631, 751`); `runObserve` takes the whole table, and a limit
on `observe` is now refused outright.

**The observe URLs cannot be mislabelled.** `writeObserveUrls` (`main.ts:168-180`) and `runObserve`
(`run.ts:785`) both call `stagedTitleOf(theCase.name, nonce)` over the same `OBSERVE_CASES`, in the
same process. The JSON carries `case`, `app` and `expectPrivate` as explicit fields, and the terminal
half (`formatObserveUrls`, `reader-eval.mjs:230-241`) only reformats those fields — it derives nothing
from the id and parses nothing out of the URL. Revert **A6** (observe URL back to the long title) →
**1 failure** (`helper.test.ts`, the source-shape pin).

**The guard still refuses** (probe, all passing):

| tried | result |
|---|---|
| each of the other 77 cases' ids, this nonce | refused, every one |
| this case's id, another run's nonce | refused |
| `CLAVE-EVAL t1 <nonce>` and `CLAVE-EVAL t130 <nonce>` against `t13` | refused; and `t13`'s title does not sit inside either — the space and the nonce separate them |
| `<staged> READYING 140x30.` where READY is demanded | refused; the real ready title is approved |
| the right title in Safari / Terminal / `"google chrome"` | refused (app compared exactly) |
| a title carrying TWO of this run's staged titles | **approved for both** — see the observation below |

Revert **A4** (an unknown name falls back to its long self instead of throwing `EVAL_UNKNOWN_CASE`)
→ 1 failure. Revert **A3** (long titles again) → 4 failures across `cases.test.ts` and
`server.test.ts`. Revert **A1** (variable-width id) → 1 failure.

**`approve` is unchanged and still the only producer of an `Approval`.** Extracted and compared
against `rvD`: **identical, 740 bytes**. `{[APPROVED]: true` occurs exactly once in `src/`
(`guard.ts:80`); there is no `as Approval` cast anywhere. Every `read` still carries
`expect: approval.window` (`helper.ts:192`, `encodeRead`).

**The page still only takes a title that is ours.** `PAGE_SCRIPT` keeps prefix + `length > prefix`
(`pages.ts:49`), the same rule as `acceptStagedTitle`, interpolated from the constant. Revert **A7**
(`if(t)document.title=t`) → **3 failures** in `pages.test.ts`.

**The counter map takes no key but this run's pre-seeded titles.** See I2/I3 below.

*Observation, not a new defect:* a window whose title contains two of this run's staged titles is
approved for **both** cases (probe). That is the pre-existing shape of the substring rule — both
titles are ours and minted this run — and it is unchanged by this loop; the harness stages one window
at a time. Recording it because item A asked.

**Verdict A: sound.** One Minor, below (`STAGED_TITLE_MAX` is decorative).

---

## B. `refusedTitleLength`

**Bounded, and only for our app with our prefix.** `guard.ts:146-151`: the block is entered only when
`ours && window.title.includes(STAGED_TITLE_PREFIX)`, the value is
`Math.min(window.title.length, REFUSED_TITLE_LENGTH_MAX)` with `REFUSED_TITLE_LENGTH_MAX = 10_000`,
the longest such refusal is kept, and **no title is retained** — only `.length`. Reachable range is
11..10 000 or `null`.

| revert | tests | tsc | bites |
|---|---|---|---|
| **B1** drop the `Math.min` bound | 1 failure | clean | ✅ |
| **B2** drop the `ours &&` gate (review D's M1) | 1 failure | clean | ✅ |
| **B3** accuracy row reports a hard `null` (`run.ts:495`) | **0 failures** | clean | ❌ |
| **B5** toolbar row reports a hard `null` (`run.ts:707`) | **0 failures** | clean | ❌ |
| **B4** accuracy serialiser writes `null` (`results.ts:560`) | **0 failures** | clean | ❌ |
| **B6** toolbar serialiser writes `null` (`results.ts:502`) | **0 failures** | clean | ❌ |

Probe: a truncated title gives `{sawApp: true, sawStagedTitle: true, refusedTitleLength: 20}`; the
same title in Visual Studio Code gives `{false, false, null}`; our app on a host-titled error page
gives `{true, false, null}`.

**Verdict B: the value is right and the wiring is unproved.** See **Important 2**.

---

## C. Review D's findings

| # | claim | verdict | evidence |
|---|---|---|---|
| **I1** | `pageServerIpv6` recorded | ✅ | **C1b** (drop it from `main.ts`) → 1 failure **and** `tsc` TS2741; **C1c** (drop it from the serialiser) → 2 failures |
| | matched pair or bounded retry | ✅ | **C1e** (`::1` made unbindable) → the refusal really fires: `server.test.ts` errors in `beforeAll`, 25 tests skipped. **C1f** (half-bound kept) → 3 failures |
| | fixed code `PAGE_SERVER` | ❌ | **Important 1** below |
| | Minor 2, the IPv4 bind checked | ⚠️ present, unproved | **C1d** (drop `if (!await listenOn(ipv4…)) continue;`) → **0 failures** |
| **I2** | counter map pre-seeded and bounded | ✅ | `server.ts:112-118`, 79 keys (78 titles + the fallback); **C2** (take any key) → 1 failure; **C2b** (seed with `[]`) → 1 failure |
| **I3** | the replaced proof bites for the claimed reason | ✅ | **C2** reverts only `record`'s key gate — `pages.ts` and `pages.test.ts` untouched — and the single failure is the new `server.test.ts` case, which sends four foreign titles including our own grammar with another run's nonce and a 4 000-character one |
| **I4** | diagnostics wiring pinned | ✅ | **C4a** (`pageStats` unwired) → 1; **C4b** (OK accuracy row nulls) → 1; **C4c** (OK toolbar row nulls) → 2; plus **A6** and **C2b** on the same source-shape test |
| **M1** | `stagedTitleSeen` gated on the app | ✅ | **B2** → 1 failure; probe confirms |
| **M4** | `--limit` refused for observe/coldstart in BOTH parsers | ✅ | **C5a** (`config.ts`) → 2 failures; **C5b** (`reader-eval.mjs`) → 2 failures. The bundle side returns the fixed code `LIMIT_NOT_APPLICABLE`; the CLI side prints `USAGE`, as it does for every other bad flag |
| **M5** | zero-padded limits refused in both | ✅ | **C6a** → 3 failures; **C6b** → 2 failures |
| **M6** | the serialiser writes the literal `"LIMITED"` | ✅ | **C7** (copy the input's `reason`) → 1 failure |
| **M3** | the counters' weakness stated | ✅ | `results.ts:161-166`, beside the interpretation table |
| **M7** | the `limited` JSDoc aligned | ❌ | unchanged: `/**` at 6 spaces, continuation at 5, `const` at 4 (`main.ts:303-309`), exactly as in `rvD`. Cosmetic — see Minor 5 |

Every restore was byte-identical to `$R/app`.

---

## D. E2 — the acceptance half

- `thresholds.ts`, `thresholds.test.ts`, `score.ts`, `score.test.ts`: **`cmp`-identical to `$S/s1/rvD`**.
- **`summary.ts` is not in the fix diff at all** and is byte-identical to `rvD`. So every acceptance
  rule review D checked stands unchanged: `accepted` still opens with `limited === null &&`
  (`summary.ts:294-295`), the toolbar counts are still set-based and gated on
  `normal.length === 20 && incognito.length === 20`, the group thresholds are untouched. Only
  `summary.test.ts` changed, and only to add `refusedTitleLength: null` to its row fixtures.
- `exitCodeFor` and the `LIMITED RUN` line are unchanged; a limited run still exits 2.

---

## Findings

### Critical

None. No privacy rule is loosened. `approve` is byte-identical and still the sole minter of an
`Approval`; the staged-title grammar, the prefix and the nonce are untouched; the shortening moves
the *case name* out of the window title, which narrows what a title says rather than widening it; the
page server is loopback-only, serves nothing from disk, and its counter map now holds only keys this
run minted; no string from a window or a request reaches the file; the thresholds and the scorer are
byte-identical; a limited run still cannot be accepted.

### Important

**Important 1 — the `PAGE_SERVER` refusal code never reaches the results file.**
`createPageServer` throws `new Error(PAGE_SERVER_REFUSAL)` (`server.ts:168`). It is called from the
`staging` IIFE at `main.ts:249-256`, which is **outside** the `try` that begins at `main.ts:266`, so
the throw escapes `main()` into the catch at `main.ts:345`, which writes
`serialiseError({error: "HARNESS", code: "HARNESS"})`. The owner sees `READER_EVAL_FAILED HARNESS`
with no code at all — `formatSummary` suppresses the code when it equals the error
(`reader-eval.mjs:318`) — and cannot tell a loopback-pair refusal from any other harness throw.
The smoking gun is in the diff itself: `PAGE_SERVER_REFUSAL` is **imported at `main.ts:44` and never
used**; `tsconfig.json` has no `noUnusedLocals`, so `tsc` is silent about it. The report's I1 row
claims "a run that cannot have both is refused with the fixed code `PAGE_SERVER`", and
`server.test.ts:199` only asserts that the constant's *value* is `"PAGE_SERVER"`.
*Why it matters here:* this refusal fires exactly when some other local process holds the `::1` port —
the case where the staged URLs, nonce and all, would have gone to that process. That is the one
failure the owner most needs named.
*Fix:* catch it where it is thrown —
`try { server = await createPageServer(truth, titles); } catch { writeAtomic(outFile, serialiseError({error: "HARNESS", code: PAGE_SERVER_REFUSAL})); return; }` —
and pin it with a source-shape assertion beside the four in `helper.test.ts`, plus a `HINTS` line so
the terminal says what to do about it.

**Important 2 — `refusedTitleLength`, the number this loop says will decide the next run, can be
dropped between the guard and the file with nothing failing.**
Four independent reverts each pass **908/908 with `tsc` clean**: the accuracy row (`run.ts:495`), the
toolbar row (`run.ts:707`), the accuracy serialiser (`results.ts:560`) and the toolbar serialiser
(`results.ts:502`), each replaced by a hard `null`. Every mention of the field outside `guard.test.ts`
is either a key-list pin (`results.test.ts:335, 341, 478` — which a `null` satisfies) or a fixture
that sets it to `null` (`summary.test.ts`). This is precisely the gap review D raised as **I4** for
`pageRequests`/`pageStatus`; it was closed for those two and reproduced one loop later for the new
field. The report's own prediction — "the rows come back `notStaged` again with `refusedTitleLength`,
and a value of 27 would mean … the last suspect standing" — rests on a path no test walks.
*Fix:* the pattern is already in place. In `run.test.ts`, drive a `notStaged` accuracy repetition and
a `notStaged` toolbar row through a fake front window whose title is a truncated staged title, and
assert the row carries the length; in `results.test.ts`, round-trip one row with a non-null value and
assert the file holds the number.

### Minor

**Minor 1 — the IPv4 bind check has no proof.** `C1d` (dropping
`if (!await listenOn(ipv4, "127.0.0.1", 0)) continue;`) passes 908/908. Review D's Minor 2 is fixed in
the code and unpinned; on this machine the branch is unreachable, so it will stay unpinned unless
`listenOn` is injectable.

**Minor 2 — `server.ts`'s own documentation describes the behaviour the fix removed.**
`PageServer.ipv6` (lines 20-27: "a page server that would not start is a worse outcome than one that
answers on IPv4 alone") and `createPageServer`'s doc (lines 91-93: "The IPv6 socket is best-effort …
leaves `ipv6: false` and a run that works exactly as it did before") are both false now; the function
refuses instead. Two paragraphs, in the one file whose doc-comment being false was half of review D's
I2. Related: `pageServerIpv6` can now only be `true` or `null`, and review D's requested
`formatSummary` line was not added — defensible, but then the field's doc should say so (it partly
does, `results.ts:411-419`).

**Minor 3 — `createPageServer`'s `stagedTitles` defaults to `[]`.** A caller that forgets the argument
gets a map holding only the fallback, so `served()` answers `{count: 0, lastStatus: null}` for every
case and every row reports `pageRequests: 0` — which is exactly the reading "the browser never asked
for the page", the conclusion this loop's diagnostics exist to reach. `main.ts` is pinned
(`C2b` bites), so this is a shape risk rather than a live bug; a required parameter would remove it.

**Minor 4 — `STAGED_TITLE_MAX` is decorative.** Nothing enforces it at runtime, and both tests that
use it compare against the constant itself, so raising it to 400 passes 908/908 (**A8**). The
shortness is really held by the two assertions beside it (`not.toContain(name)` and "shorter than the
old form"), which do bite. Either assert the cap against a literal, or check it where a title is
minted.

**Minor 5 — M7 is reported as done and is not.** The `limited` JSDoc at `main.ts:303-309` has `/**` at
six spaces, its continuation at five and `const` at four — byte-for-byte the `rvD` indentation review D
complained about. Cosmetic, but the report's Review D table says it was aligned.

---

## Verdicts

**Spec compliance ✅** — staged titles are shorter, unique per case, fixed-width, and carry no case
name; ids are a pure function of the three static tables and cannot drift with `--limit`, the
interleaving or the Chrome variant; the observe URLs and the run recover the case from the same table
in the same process; `approve` is byte-identical and still the only minter of an `Approval`; every
`read` carries `expect`; the page takes a title only under the prefix grammar; the counter map is
pre-seeded and fixed-size; every new field is a number, a boolean or a fixed code; the acceptance
half (`summary.ts`, `thresholds.ts`, `score.ts`) is byte-identical to what review D approved.

**Quality: approved for the next staged run with two Importants to close.** Thirteen of the fix
round's claims hold and bite under hand reverts; two do not. Neither Important can make a run read a
window it did not stage, and neither blocks staging — but both attack the *evidence* the next run is
supposed to produce: one loses the name of the refusal that means another process holds our port, the
other leaves the loop's decisive number on a path no test walks. Close **Important 1** and
**Important 2** before the run, since both are a few lines and both are about being able to believe
the file afterwards; Minors 1–5 can follow.

**Verdict: NOT ALL ADDRESSED — two Importants and five Minors open.**
