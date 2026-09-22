# Independent review D — `reader:eval` repair loop 3

Scope: the report's sections after "Fix round 2" (terminal rows 40 → 30, "Toolbar notStaged", `--limit`),
`$S/s1/loop3.diff` against `$S/s1/rrC/app`, read against `reviewC.md` / `rereviewC.md`.

Method: read-only against `$R/app`; every mutation in the private copy `$S/s1/rvD/app`, exact-string,
restored and `cmp`-checked. **Nothing was run:** no harness, no bundle, no generated `.command`, no
`pnpm`, no `dist/reader-eval.cjs`, no browser or Terminal window. The probes below are vitest files
written into `rvD` and deleted afterwards; `rvD/app/src` and `rvD/app/scripts/reader-eval.mjs` are
byte-identical to `$R/app` at the end of this review.

Gates:

| gate | result |
|---|---|
| `vitest run --root rvD/app src/readerEval scripts/reader-eval.test.ts` | **864 passed in 17 files** |
| `tsc --noEmit -p rvD/app/tsconfig.json` | **exit 0, no output** |
| `src/readerEval/bytes.test.ts` | **40 passed** |
| `rvD` vs `$R/app` after all mutations | **identical** (`diff -r` clean) |

---

## 1. The page server: both loopback families, and the per-case counters

**Strictly loopback — yes.** `server.ts:114-119` binds the two addresses by literal name,
`"127.0.0.1"` and `"::1"`; `0.0.0.0` and `::` appear nowhere in the module. Probe (written into
`rvD`, run, deleted): enumerated this machine's non-internal IPv4 interfaces and fetched
`http://<lan-ip>:<port>/chat.html` for each — **every one rejected at connect**, while `127.0.0.1`
and `[::1]` on the same port answered 200.

**Serves only its own generated pages — yes.** The handler (`server.ts:96-112`) touches no
filesystem at all: `pageOf` (`server.ts:48-52`) matches `^\/([a-z]+)\.html$` and then checks
membership of `PAGE_NAMES`, and the body is `renderPage` over `truth[name]` held in memory. Probe:
`/../../../../etc/passwd`, `/%2e%2e%2f%2e%2e%2fetc%2fpasswd`, `/etc/passwd`,
`/chat.html/../../etc/passwd`, `/CHAT.html`, `/chat.htm`, `/chat.html.bak`, `/` — **all 404**.
**Any Host is answered:** `new URL(request.url ?? "/", "http://127.0.0.1")` (`server.ts:97`) ignores
the header entirely, confirmed with `Host: evil.example.com` → 200. That is correct for this
harness (one server, four `*.localhost` names) and is not a DNS-rebinding exposure because nothing
off the loopback can reach the socket.

**`::1` unavailable, or the port taken on `::1`:** it **silently serves IPv4 only, and the fact is
not recorded anywhere.** `boundIpv6` (`server.ts:119`) is surfaced as `PageServer.ipv6`
(`server.ts:27, 122`) and then *nothing reads it* — a grep of `src/` and `scripts/` for `ipv6`
outside `server.ts` returns only an unrelated word in `src/core/guard/numbers.ts:103`. It is not in
`EvalResults`, not in `EvalSummary`, not in the terminal summary. See **Important 1**.

**The counters — bounded? keyed to this run's nonce?** **No, on both counts.** `record`
(`server.ts:92-95`) keys a `Map` by `acceptStagedTitle(url.searchParams.get("stagedTitle"))`
(`server.ts:100`), and `acceptStagedTitle` (`pages.ts:75-77`) delegates to `isStagedTitle`
(`stagedTitle.ts:178-180`), which is **a prefix test and a length-greater-than test — no case name,
no nonce, no upper bound**. Any local process can therefore mint unlimited distinct keys of
arbitrary length. See **Important 2**.

**Can a request put a string into results?** **No.** `served()` is called at exactly two sites,
`run.ts:475` and `run.ts:693`, both with the harness's own `stagedTitle`, and only `.count` /
`.lastStatus` — two numbers — are spread into a row (`run.ts:476-478`, `703-704`). The key itself
never leaves the map. `results.test.ts:430-464` pins the repetition's exact key list and walks it at
every depth refusing any string but `outcome`; `results.test.ts:329-342` does the same for the
toolbar and observe rows. That half is solid.

---

## 2. `frontAppSeen` / `stagedTitleSeen`

**`approve` is byte-for-byte unchanged.** Extracted the whole function from `rrC/app/src/readerEval/guard.ts`
and from `$R/app/src/readerEval/guard.ts` and compared: **identical, 740 bytes** (`guard.ts:71-82`),
as is the `APPROVED` brand block. The diff touches only the `GuardOutcome` type and the loop.

**No title or app string is retained beyond the boolean.** `guard.ts:121-131`: the window is bound
to a local `const`, two booleans are set from `window.app === expectation.app` and
`window.title.includes(STAGED_TITLE_PREFIX)`, and only `{sawApp, sawStagedTitle}` escapes. `run.ts`
turns them into `boolean | null` (`run.ts:492-493`, `701-702`) and `results.ts:159-162, 234-237`
types them `boolean | null`. Nothing logs.

**They cannot change which window is read.** Before: `approve(await deps.frontWindow(), expectation)`.
After: the same value in a `const`, then `approve(window, expectation)` (`guard.ts:129`). The
`Approval` brand is still only mintable by `approve`, and `approve` did not change.

**Privacy of the polling itself.** The guard already had the front window's title in hand for
`approve` — loop 3 adds no new call, no new poll, and no new retention. The one new thing is that a
*refused* window now contributes one bit to the file. Two notes:

- `stagedTitleSeen` is **not gated on the app** (`guard.ts:127`), so a front window of *any*
  application whose title merely contains `CLAVE-EVAL ` sets it true — the owner's editor with this
  very report open, a Terminal tab whose title shows a `--limit` command line. That is one bit about
  a foreign window in the results file, and it makes the documented reading of the field
  ("our browser on a page that is not ours", `guard.ts:88-90`) wrong in exactly that case. **Minor 1.**
- The information content is one bit about a string this harness owns, so it is a correctness
  problem for the diagnosis rather than a privacy leak. No case name, host, app or title is kept.

---

## 3. `--limit`

**Both parsers identical.** `countArg` (`scripts/reader-eval.mjs:97-105`) and `parseLimit`
(`src/readerEval/config.ts:140-148`) apply the same rule character for character: length 1–4, every
`charCodeAt` in 48–57, `Number.isSafeInteger`, `1 <= n <= LIMIT_MAX`, `LIMIT_MAX = 1000` in both
(`reader-eval.mjs:49`, `config.ts:91`). No regex in either. `CLAVE_EVAL_LIMIT` set-and-unreadable is
refused with the fixed code `BAD_LIMIT` (`config.ts:168-170`), never defaulted — the same discipline
as the variant and the position.

**A limited run can never be accepted.** `summarise` takes `limited` and `accepted` opens with
`limited === null &&` (`summary.ts:294-295`), before every other conjunct. I could not construct a
counter-example:

- `--limit 40` on a 40-case toolbar run **is still "limited"** — `main.ts:304` sets `limited` from
  `limit === null`, not from `cases < of`, so `{cases: 40, of: 40}` is present and `accepted` is
  false. **I think that is right and I would keep it.** The flag is a statement about *what the
  owner asked to measure*; making the refusal depend on an arithmetic coincidence would mean
  `--limit 40` accepted and `--limit 39` not, for reasons no one reading the file could reconstruct.
  The file still carries `cases: 40, of: 40`, so a reader can see it was in fact the whole table.
- `summarise`'s default `limited = null` is only reachable from tests; `main.ts:326` always passes
  the computed value.
- `serialiseResults` writes the block (`results.ts:577-583`) and `exitCodeFor` is untouched — a
  non-accepted run exits **2** (`reader-eval.test.ts:590`, and the `LIMITED RUN` line at
  `reader-eval.mjs:394-398` is printed above the verdict).

**Order independence of the acceptance counts.** `summariseToolbar` (`summary.ts:135-165`) filters
by `mode`, counts `host === true` over the normal rows, `private === true` over the incognito rows
and `private === true` over the normal rows, and gates `passed` on
`full = normal.length === 20 && incognito.length === 20` (`TOOLBAR_CAPTURES_PER_MODE = 20`,
`thresholds.ts:54`). Every count is set-based; none looks at position or at "the first n". So
interleaving the full run changes nothing about acceptance, and a limited run fails `full` before
any threshold is consulted. Thresholds read `hostHitsMin: 19`, `privateHitsMin: 20`,
`falsePrivateMax: 0` (`thresholds.ts:43-50`) — untouched.

**Thresholds file byte-identical:** `cmp` of `rrC/app/src/readerEval/thresholds.ts` and
`thresholds.test.ts` against `$R/app` — **identical, both**.

---

## 4. Terminal rows 40 → 30

**Nothing still assumes 40 rows.** A grep of `src/readerEval` and both script files for `\b40\b`
returns: the two comments recording the measurement (`cases.ts:189-194`), one line of prose in
`stagedTitle.ts:117` and `results.ts:129` describing the *old* run, test fixtures that pass their own
`columns`/`rows` (`run.test.ts`, `stage.test.ts`, `guard.test.ts`), `TERMINAL_HOLD_SECONDS = 40`
(`stage.ts:278` — seconds, unrelated) and `BROWSER_WINDOW`'s `xPt: 40` (`cases.ts:54`). No
production row count of 40 survives. Revert proof **D1** bites (below).

**30 rows holds the whole truth plus markers without scrolling.** `app/reader-eval/truth/terminal.txt`
is **12 lines**, longest line **66 characters**. 12 + STARTMARKER + ENDMARKER = **14 lines** into a
screen the script has just cleared, so 30 is more than double what is needed, with 16 rows of slack.
66 < 72 means the narrow case does not wrap either. `stage.ts:341-348` already states exactly this
("14 lines into a window asked for 30 rows"), and the column count — which is what the narrow case
is *for* — is unchanged at 140 / 72 (`cases.ts:206-207`).

---

## 5. Results schema 3

Every new field is a number, a boolean or a fixed code:

| field | where | type |
|---|---|---|
| `frontAppSeen` | `results.ts:159`, `234` | `boolean \| null` |
| `stagedTitleSeen` | `results.ts:160`, `235` | `boolean \| null` |
| `pageRequests` | `results.ts:161`, `236` | `number \| null` |
| `pageStatus` | `results.ts:162`, `237` | `number \| null` |
| `summary.limited` | `results.ts:321-326`, `344` | `{reason: "LIMITED"; cases: number; of: number} \| null` — `reason` is a closed one-member union |
| `schema` | `results.ts:372` | literal `3` |

Sentinel coverage is **non-vacuous and thorough**: `results.test.ts:430-464` pins the repetition's
exact sorted key list (all four new names present), asserts no string at any depth with a walker
that is itself proved to bite, and `results.test.ts:329-342` pins the toolbar and observe row key
lists. The schema literal is pinned twice — by the type (`tsc`) and by a source-shape assertion on
`main.ts` (`helper.test.ts:210`). The `limited` block has its own round-trip test
(`results.test.ts:407-427`).

Two gaps in the *sentinel/revert* net, not in the types: see **Important 3** and **Important 4**.

---

## 6. Revert proofs re-run

Each proof: exact-string mutation in `rvD`, full harness suite + `tsc`, restore, `cmp` against
`$R/app`. **Every restore was `cmp`-identical.**

| proof | what was reverted | tests | tsc | bites |
|---|---|---|---|---|
| D1 | terminal rows 30 → 40 | 1 failure | clean | ✅ |
| E1 | `boundIpv6 = false` (IPv4 only) | 1 failure | clean | ✅ (but see Important 1) |
| E2 | counter + page title keyed by the raw query value | 1 failure | clean | ⚠️ **bites for the wrong reason** |
| **E2′** | counter keyed by the raw value, page title still gated | **0 failures** | clean | ❌ **does not bite** |
| E3 | `sawApp` never set | 5 failures | clean | ✅ |
| E4 | `sawStagedTitle` always true | 6 failures | clean | ✅ |
| E5 | `notStaged` row reports `null` for both booleans | 2 failures | clean | ✅ |
| **E6a** | `...page()` dropped from the **OK accuracy** repetition | **0 failures** | clean | ❌ **does not bite** |
| E6b | toolbar row reports `null` for both counters | 1 failure | clean | ✅ |
| **E7** | `pageStats: staging.server.served` deleted from `main.ts` | **0 failures** | clean | ❌ **does not bite** |
| F1 | `limited === null &&` removed from `accepted` | 2 failures | clean | ✅ |
| F2 | toolbar cases taken from the top, not interleaved | 1 failure | clean | ✅ |
| F3 | `--limit` ignored by the accuracy part | 1 failure | clean | ✅ |
| F4 | a bad limit defaulted instead of refused | 9 failures | clean | ✅ |
| F5 | no `LIMITED RUN` line | 1 failure | clean | ✅ |
| F6 | `limited` dropped from the serialiser | 1 failure | clean | ✅ |

The F-series is exactly as the report describes, including the failure counts it quotes (F1 = 2,
F4 = 9). The E-series has three holes, all in the half the loop exists for.

---

## Findings

### Critical

None. No privacy rule is loosened: `approve` is byte-identical, the staged-title grammar and nonce
are untouched, the server is loopback-only and serves nothing from disk, no string from a window or
a request reaches the file, the thresholds file is byte-identical, and a limited run cannot be
accepted.

### Important

**I1 — a run that lost the IPv6 half is indistinguishable from one that got it.**
`server.ts:119-122` computes `boundIpv6` and exposes it as `PageServer.ipv6`; nothing in `run.ts`,
`results.ts`, `summary.ts`, `main.ts` or `reader-eval.mjs` ever reads it. The entire premise of this
loop is "the toolbar path may be failing because `*.localhost` goes to `::1` first"; if `::1` cannot
be bound at the chosen port on the next run, the file looks exactly like loop 2's and the owner
learns nothing. Worse, a `::1` EADDRINUSE means **some other local process now receives the staged
URLs** — our nonce, case name and host — as Chrome's first connection attempt.
*Probe:* revert E1 (`const boundIpv6 = false;`). One test fails — but that test skips itself on a
machine with no IPv6 loopback (`server.test.ts:129`), and no bit of it reaches the results file.
*Fix:* record it — a top-level `pageServerIpv6: boolean` in `EvalResults` (a boolean, within the
ruling) and one line in `formatSummary`; and on a `::1` bind failure, close both sockets and retry
the pair on a fresh ephemeral port a bounded number of times, refusing with a fixed code
(`PAGE_SERVER`) if no matched pair can be had. A matched pair is the only state in which the two
families mean the same thing.

**I2 — the counter map is unbounded and keyed by an attacker-supplied string.**
`server.ts:91-95` + `pages.ts:75-77` + `stagedTitle.ts:178-180`. `isStagedTitle` checks the prefix
and "longer than the prefix" — **not this run's nonce, not any case name, no length cap**. The
doc-comment's claim ("a request carrying anything else is counted under the fixed fallback name,
never under itself, so nothing from outside is stored here", `server.ts:34-36`) is false for every
string beginning `CLAVE-EVAL `.
*Probe (written into `rvD`, run, deleted — it passed, i.e. the growth is real):* 200 distinct titles
`CLAVE-EVAL not-our-case-<i> ffffffffffff` plus one `CLAVE-EVAL ` + 4000 `A`s, sent from a foreign
client to `127.0.0.1:<port>/chat.html`; every one came back from `served()` with `count: 1`, i.e.
every one is a live key. A request to a non-existent path stores its key too (the 404 branch,
`server.ts:103`). Node's 16 KiB header limit caps one key at ~16 KB, so a local process can add tens
of thousands of multi-kilobyte keys over a 24-minute run.
*Fix:* pre-seed the map with the staged titles this run will actually mint (the case list is known
before the server starts) and have `record` ignore any key that is not already present — a fixed-size
map, and the doc comment becomes true. Failing that, cap key length and map size.

**I3 — revert proof E2 does not bite as claimed.**
The report says E2 proves the counters are keyed through `acceptStagedTitle`. It bites only because
`server.ts:100` feeds the *same variable* to `renderPage` (`server.ts:109`), and the page's own title
is separately covered by `pages.test.ts`. Reverting only the counter key — `record(key, …)` with
`key = url.searchParams.get("stagedTitle") ?? ""`, page title left gated — passes **864/864, tsc
clean**. So the stated guarantee has no test at all, and (I2) it is not true.
*Fix:* a test that a request carrying a foreign `CLAVE-EVAL …` title cannot be retrieved through
`served()`, and that `served()` of the fallback name counts it instead.

**I4 — the diagnostics can be disconnected from the real run with nothing failing.**
Two reverts, both green:
- `run.ts:556-560`: replacing `...page()` in the **successful** accuracy repetition with
  `pageRequests: null, pageStatus: null` → 864/864 pass. The report claims E6 was strengthened to
  cover "the accuracy path's too"; it covers the accuracy `none()` path (`run.ts:479`), not the OK
  row.
- `main.ts:295`: deleting `pageStats: staging.server.served,` → 864/864 pass, `tsc` clean, because
  `RunDeps.pageStats` is optional (`run.ts:141`). The whole feature would report `null` on every row
  of every real run and no gate would notice. (The wiring *is* present today — I verified
  `main.ts:295` — so the next run will carry the numbers; this is a gap in the net, not a live bug.)
*Fix:* assert the counters on an OK accuracy repetition in `run.test.ts`, and add
`expect(source).toContain("pageStats: staging.server.served")` to the existing `main.ts`
source-shape test — the pattern is already in place at `helper.test.ts:205` and `helper.test.ts:299`.

### Minor

**M1 — `stagedTitleSeen` is not gated on the app** (`guard.ts:127`). Any window of any app whose
title contains `CLAVE-EVAL ` sets it, so the field can be true for a text editor showing this report.
*Fix:* `if (window.app === expectation.app && window.title.includes(STAGED_TITLE_PREFIX))` —
`sawApp` already carries the "somebody else's window" half, so nothing is lost.

**M2 — the IPv4 listen result is discarded** (`server.ts:115`). A failed IPv4 bind leaves
`address()` null, `port = 0` (`server.ts:117`), the IPv6 socket then binds a *different* random port
(`listenOn(ipv6, "::1", 0)`), and every case is staged at `http://…:0/`. Fails open and silent.
*Fix:* refuse with a fixed code when either bind fails.

**M3 — `pageRequests` / `pageStatus` are writable by a local process that knows the nonce** (which
is on the staged window's own title). `lastStatus` is last-wins, so a foreign 404 can overwrite our
200. Record-only, but worth a sentence beside the interpretation table in `results.ts:147-157`, since
the whole point of the fields is to settle an argument.

**M4 — `--limit` on `observe` or `coldstart` prints "LIMITED RUN: 0 of 0 cases"** and blocks
acceptance of a run the limit never touched. `main.ts:307-309` computes `of` only from the accuracy
and toolbar tables; `cases` is `runs.accuracy.length + runs.toolbar.length`, both zero for those
modes. *Fix:* refuse `--limit` for a mode with no limited part, or count the observe table.

**M5 — `parseLimit` / `countArg` accept a leading zero** (`--limit 04` → 4, `--limit 0004` → 4,
`--limit 00004` refused only by the 4-character length cap), while `boundedCount`
(`stagedTitle.ts:165`) refuses one. The two `--limit` parsers agree with each other, which is the
requirement; recorded for consistency with review C's M4 only.

**M6 — `serialiseResults` copies `limited.reason` instead of writing the literal**
(`results.ts:577-582`). Every other fixed code in that file is hand-written; nothing in the two
"smuggled field" tests reaches inside `limited`. *Fix:* `reason: "LIMITED"`.

**M7 — `main.ts:298-302`: the `limited` JSDoc is mis-indented** (`/**` at six spaces, continuation
at five, `const` at four). Cosmetic.

---

## Verdicts

**Spec compliance ✅** — loopback only, no file serving, no string from a window or a request in the
results file, `approve` byte-identical, staged-title grammar and nonce untouched, thresholds file
byte-identical, every new field a number / boolean / fixed code, a limited run cannot be accepted and
exits 2.

**Quality: Approved with four Importants.** The shipped code is safe to run as it stands — the
staging rules, the guard and the acceptance arithmetic are correct, and the wiring at `main.ts:295`
means the next run really will carry the four diagnostics. What is not yet sound is the *net around*
the new work: two of the loop's own revert proofs (E2, E6) do not bite for the reason claimed, a
third property (E7) has no proof at all, and the `ipv6` flag — the single fact that decides whether
the loop's fix was even in effect — is computed and thrown away. Close I1–I4 before this loop is
called done; M1 should go in with them.

**Verdict: APPROVED FOR THE NEXT STAGED RUN, WITH FOUR IMPORTANTS TO CLOSE.**

---

## My own hypothesis for the 40/40 `notStaged`

**The page was never fetched, and the cause is the URL's host.** For the *normal* twenty this is
forced rather than guessed: I diffed `stageAccuracy`'s browser branch (`run.ts:318-341`) against
`runToolbarCase` (`run.ts:667-682`) field by field — same `chromeStageCommand`, same
`BROWSER_WINDOW`, same `positioned`, same profile dir, same `prepareChrome`, same
`guardTimeoutFor`, same `app: CHROME` (`cases.ts:216`, `cases.ts:270`), same `requireReady: false`,
same page kinds, themes and sizes. For a normal toolbar case **the only difference from a working
accuracy case is `host: theCase.host` instead of `"127.0.0.1"`** — and the incognito half failed
identically, so `--incognito` is not it either. A host-driven failure that never reaches the page
leaves Chrome on its own error page, whose title is the bare host, which is `notStaged` forty times
over. So I think the developer's "candidate" **is** the cause and his counter-evidence is weaker
than he treats it: his probe drove an already-running Chrome with a warm profile and a warm
`HostCache`, not a cold `--user-data-dir` profile issuing its first navigation from the command
line, and `chromeWaitMs ≈ 312` on every row shows each case really was a fresh launch.

**What the new diagnostics will show if I am right:** `pageRequests: 0`, `pageStatus: null`,
`frontAppSeen: true`, `stagedTitleSeen: false` on all forty — the failure *before* the page. If
instead they come back `pageRequests: 1, pageStatus: 200, stagedTitleSeen: true`, the dev report's
remaining suspect (a truncated 73-character title) is what is left — and I can narrow that now: the
native reader does **not** truncate. `app/native/reader/src/macos/windows.rs:159-161` copies
`kCGWindowName` whole into `WindowInfo.title` with no length cap, buffer or slice anywhere on the
path, so a truncation would have to come from the window server itself, not from this repo — which
makes it the least likely branch of the four and would argue for shortening the toolbar case names
only as a last resort.
