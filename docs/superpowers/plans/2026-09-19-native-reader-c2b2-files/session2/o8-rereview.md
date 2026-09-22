# O8 re-review - fix round 1 ("a measured browser with no address on its strip is not kept")

**Reviewer:** independent re-review (did not write the change, did not write the first review) - **Date:** 2026-09-21
**Under review:** the fix round 1 of `app/src/core/exclusions/sites.ts` + `index.ts` (+ their tests),
against `session2/o8-review.md` (C1, C2, I1-I3, M1-M3), `session2/o8-dev-report.md` section
"Fix round 1", the diff `s4/o8fix.diff`, the pre-fix code `s3/rv3/.../exclusions`, and the pre-O8
baseline `session2/pre-o8/exclusions`.
**Method:** read-only against `$R`; every mutation and every candidate patch applied in the private
copy `$S/s4/rr/app`, restored from a byte copy and `cmp`-ed after each one. Nothing under `$R` was
modified except this file.

**Verdict: Not approved - but narrowly.** Both Criticals of the first review are genuinely fixed, and
fixed well. Three new Important findings remain, all of them in the redesigned per-line rule; the
first one is a fail-open the doc comment explicitly denies, and its patch is four tokens long and
costs exactly one invented test case. This is one small edit plus two owner decisions from approval.

---

## Part 1 - the first review's findings, re-checked

| # | Verdict | Evidence |
| --- | --- | --- |
| **C2** ReDoS | **Fixed** | see below |
| **C1** rule not fail-closed | **Fixed in the direction asked; new holes found - N1, N2** | see below and Part 2 |
| **I1** false order justification | **Fixed** | see below |
| **I2** single-label hosts dropped | **Fixed; one side effect (N1/N5)** | see below |
| **I3** false IPv6 claim + 2 unpinned guards | **Fixed** | see below |
| **M1** trailing punctuation | **Fixed** | `github.com.` `github.com,` `(github.com)` `localhost:3000,` `localhost:3000]` `"github.com"` `<github.com>` `github.com;` all true now. Still false: `[github.com]` and `...github.com` (a leading `[` is excluded from the glyph class, and 3 dots exceed the 2-character leading limit). Rare; on the record. |
| **M2** recogniser confusions | **Recorded, no code** - accurate, with one change of direction: `1ocalhost:3000` is now **true** (the new single-label grammar accepts it), where the review measured it dropped. Still dropped: `github.c0m`, `l27.0.0.1`, `github com`, `[fe80::1%25en0]:8080`. |
| **M3** `unknownWindow` mixes causes | **Recorded, no code** - accurate; it now counts three causes. |

### C2 (ReDoS) - Fixed. The cap is applied before any matching, and everything is linear.

The cubic `IPV6` is gone. `showsAddress` is now `toolbarText.slice(0, 2048).split("\n", 16).some(lineIsAddress)`
- the slice is the **first** operation, so no pattern ever sees more than 2048 characters, and every
pattern is anchored at the start of one whitespace-delimited token.

I re-ran the first reviewer's exact probes plus fourteen of my own, through `showsAddress` and through
`after()` end to end (private copy, vitest, `process.hrtime`):

| input | `showsAddress` | `extractHosts` |
| --- | --- | --- |
| `"[" + ":".repeat(1600)` (was 1.17 s) | **0.005 ms** | 0.013 ms |
| `"[" + ":".repeat(3200)` (was 8.6 s) | **0.006 ms** | 0.007 ms |
| `"[" + ":".repeat(6400)` (was 68 s) | **0.003 ms** | 0.012 ms |
| `("[" + ":".repeat(300)).repeat(300)`, 90 KB (was 3.5 s) | **0.011 ms** | 0.211 ms |
| `"[" + "a:".repeat(800)` | 0.004 ms | 0.010 ms |
| 100 KB of `a` / `a.` / `a-` / `.` / `1.` / `ab.cd ` | 0.011-0.031 ms | 0.11-2.06 ms |
| `"http://" + "a".repeat(100000)` | 0.022 ms | 0.264 ms |
| `"a".repeat(99000) + ":8080"` (worst seen) | **0.434 ms** | 0.264 ms |
| `"x ".repeat(50000)` / `"x\n".repeat(50000)` | 0.056 / 0.020 ms | 0.31 / 0.07 ms |
| `"github.com/?" + "a".repeat(100000)` | 0.013 ms | 1.028 ms |

`after()` end to end, measured browser, 90 KB adversarial strip: **0.215 ms**; at 1 MB: 3.2 ms (`a`)
and 12.8 ms (`ab.cd `). All of that is `siteExcluded`/`extractHosts`, which is uncapped by design.

**The developer's `extractHosts`/`HOST` claim holds, on both counts.** Linear: I added seven shapes
built specifically to make `(?:[a-z0-9-]+\.)+[a-z]{2,}` restart a long attempt at many positions -
`(" " + "a.".repeat(300)).repeat(300)`, `" ".repeat(50000) + "a.".repeat(25000)`,
`(" " + "ab.".repeat(300) + "1").repeat(300)` (270 KB), and four more. Worst: **1.63 ms on 270 KB**;
worst through `after()`: 1.73 ms. `[a-z0-9-]+` cannot cross a `.`, so the inner repetition has no
ambiguity to enumerate, and the `(?:^|[^a-z0-9.-])` prefix means an attempt can only start after a
separator - there is no quadratic shape. Fail closed: capping `extractHosts` would drop an excluded
site named past the cap, which turns a deny into a keep. Uncapped is the right call, and the doc
comment says so.

Pinned by tests: mutation **D** (remove the input cap) fails 2 tests asserting the truncation
structurally, not only a clock.

### C1 - fixed in the direction asked, and the old rule really was the no-op described

Every probe of the first review now answers correctly, and the six that were KEPT are now pinned in
`index.test.ts`. My mutation **A** (ask the question over the whole strip again - any token anywhere)
fails **31 / 199**, i.e. the line scope is load-bearing across the whole table, not just the six.
The `file:///` deviation (old D-O8-5) is retired in the fail-closed direction, correctly.

The residual hole is disclosed and pinned. It is, however, wider than the doc says - see N1 and N5.

### I1 - Fixed. The corrected causal claim is the true one.

Verified independently: `AWAY_REASONS` is `core/index.ts:28`, read at **line 75 only**, inside
`gate()`; `gate()` is called with `before()`'s reason at line 136 and 153; `segmenter.captureAllowed(now, true)`
is line 78, above the `after()` call at line 155. So in `after()` every reason is inert toward the
segmenter, exactly as the new comment now says - and it says plainly that the earlier version was
wrong. Rule order unchanged and re-verified by diff: `index.ts` differs from `pre-o8/` by exactly one
import line and one inserted block; the three rules are still private marker (`:62`) -> excluded site
(`:63`) -> no address (`:91`), the last gated on `isMeasuredBrowser`.

### I2 - Fixed. `wiki/`, `jira/browse/ABC-1`, `intranet:8080`, `grafana:3000/d/abc`, `http://wiki/` are kept; `wiki`, `intranet`, `jira`, `grafana`, `Dockerfile` are not.

Mutation **C** (`TAIL_REQUIRED` -> `TAIL`) fails 14, including `Private`, `New Tab` and `* Incognito`
- the guard is real. The side effect on the residual hole is N1/N5. Note that in Chrome this fix is
largely neutralised in practice by N3.

### I3 - Fixed. Both of the first reviewer's surviving mutations now bite.

`bracketedIsIpv6` says the true thing (`[::1]` is two colons and `[09:12:33]` is also two, so `::` or
three). Re-run in the private copy: mutation **E** (drop the guard) fails 3, mutation **F** (`TAIL`
matches anything) fails 3. `[09:12]`, `[09:12:33]`, `[2026-09-21]`, `[]`, `[abc]`, `localhosting`,
`localhostel`, `notlocalhost` are in the false table; `[2001:db8::1]`, `[fe80::1]:8080` in the true one.

---

## Part 2 - attacking the new design with fresh eyes

### N1 (Important) - trailing tokens are length-checked only, never letter-checked: prose passes

`lineIsAddress` requires the **leading** tokens to be letterless (`isLeadingGlyph`), but the trailing
tokens are only measured:

```
return trailing.length <= TRAILING_GLYPHS_MAX
  && trailing.every((token) => token.length <= TRAILING_GLYPH_CHARS_MAX);
```

So an address-like token followed by up to **three words of three characters or fewer** is an address
line. English is full of those words. The doc comment asserts the opposite in as many words:
*"A tab title is prose: it has words in it, and a word is longer than three characters or sits where
no glyph can."* It is not, and the report calls them "glyph tokens (`C =`, `+`, `...`)" as well.

**Probe** (measured, private copy):

| line | `showsAddress` |
| --- | --- |
| `README.md doc`, `Node.js API`, `Node.js API v2`, `main.py fix`, `index.html new` | **true** |
| `github.com PR`, `localhost:3000 up`, `app.py old`, `Cargo.toml dep`, `wiki/ new` | **true** |
| `Mr.Smith re`, `v2.final rev`, `ASP.NET 8`, `asp.net 8 doc`, `Dockerfile.dev fix` | **true** |
| `example.com is up`, `github.com the fix`, `site.com a b c`, `foo.bar baz qux` | **true** |
| `10.30.15.20 lab`, `TCP/IP 101`, `report.final.pdf v2` | **true** |

End to end, this re-opens the exact defect O8 was decided on:
`after({app:"Safari", title:"Accounts"}, "Translation Available\nNode.js API")` -> **`null` (KEPT)**.

Every entry of the developer's own false table was saved only by its trailing word being four
characters or longer - `config.json diff`, `main.py failing`, `Mr.Smith replied`, `v2.final review`,
`ASP.NET Core docs`, `Dockerfile.dev changes`. Shorten the word and all of them pass. The table
therefore measures word length, not the property it claims to measure.

The same omission has a second face: `isLeadingGlyph` tests `/[0-9a-z]/i`, which is **ASCII only**, so
in a non-Latin script a whole word counts as a glyph. Measured: `index.html <2 CJK chars>` -> true,
`README.md <2 CJK chars>` -> true, `<2 CJK chars> github.com` -> true. The repo already stages
non-English pages (`pt-*` cases) and the ledger records the owner's system language as probably
neither English nor Portuguese.

**Fix** (applied and measured in the private copy - **229 / 230 pass**, the single casualty named
below):

```
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const isLeadingGlyph = (token: string) =>
  token.length <= LEADING_GLYPH_CHARS_MAX && !HAS_LETTER_OR_DIGIT.test(token);
...
  && trailing.every((token) => token.length <= TRAILING_GLYPH_CHARS_MAX && !HAS_LETTER_OR_DIGIT.test(token));
```

With it, every line in the table above is **false**, the CJK cases are **false**, and every measured
rendering still passes: `@ 127.0.0.1`, `• 127.0.0.1`, `¡• 127.0.0.1`, the real strip
`"@ 127.0.0.1\nC ="` (two lines - see below), `app.clave.localhost:8765/chat.html?th...`,
`127.0.0.1:57174/chat.html?theme=light&size=14…`, `•github.com`, `github.com/acme/...`,
`example.com …`, `github.com/acme/repo +`, `[::1]:8080`, `wiki/`, `intranet:8080`, `github.com.`,
`(github.com)`.

**The one casualty is `github.com/acme/repo C =`, and it should go anyway.** It is invented, exactly
like round 0's `C = github.com/acme/repo` that the developer removed for being invented. The measured
evidence contradicts it: `session1/ledger.md:118` records the real Safari strip as
`"@ 127.0.0.1"` (box y 20-32, x 512-584) **plus** `"C ="` as a *separate recognised line*, and the
recorded `toolbarTextLength` for that case is **15**, which is exactly `"@ 127.0.0.1\nC ="`. The glyph
run arrived on its own line, not appended to the address. That also answers the developer's stated
open risk (D-O8-8) with measurement rather than guesswork, for Safari at least.

### N2 (Important) - `STRIP_SCAN_MAX_LINES = 16` truncates the address line off a real Chrome band, and buys nothing

`split("\n", 16)` keeps the **first** 16 lines. `native/reader/src/toolbar.rs` collects the band's
lines in reading order (top to bottom), and in Chrome the omnibox is the **bottom** row of the band,
under the tab strip. So the cap discards exactly the line the rule needs, first.

**Probe** (a Chrome band modelled as N tab-title lines then the omnibox):

| band | `showsAddress` |
| --- | --- |
| 14 tab lines + `app.clave.localhost:8765/chat.html?theme=light` (316 ch, 15 lines) | true |
| 15 tab lines + the same (336 ch, 16 lines) | true |
| **16 tab lines + the same (356 ch, 17 lines)** | **false** |
| 20 tab lines + the same (436 ch, 21 lines) | **false** |
| 40 longer tab lines + the same (1469 ch) | **false** |

356 characters - the character cap (2048) is nowhere near. The line cap is the binding one, and it is
silent and permanent for that window: unlike Safari's translate banner, a tab count does not go away
in five seconds.

How close is a real Chrome band? From this repo's own recorded runs
(`app/reader-eval/out/toolbar-*.json`, `observe-*.json`), **44 Chrome reads at `bandPx: 82` have
`toolbarTextLength` 130-148**, all with a single staged tab. The Safari band's measured density is
7.5 characters per line (15 characters = 2 lines, ledger:118). The results only record the
whole-capture `lineCount`, not the band's, so I cannot measure the Chrome band's line count - but a
130-148 character band with one tab is already several lines, and every additional tab adds one. Ten
to fourteen open tabs is an ordinary working state for the target user.

**The cap is also unnecessary.** After `.slice(0, 2048)`, the total work of splitting and running
`lineIsAddress` over *all* lines is linear in 2048 characters. I measured it: with the line cap
removed, the 90 KB colon string, 100 KB of `a`, and a 50000-line strip together take **0.64 ms**. The
line cap adds no protection and only risk.

**Fix:** delete `STRIP_SCAN_MAX_LINES` and its `split` limit (keep the 2048-character cap); or, if a
bound is wanted, scan the **last** N lines rather than the first. Cost to the suite: 1 test (the cap
test itself), measured. If the C-2b observe run shows a real Chrome band at or near 16 lines, promote
this to Critical.

### N3 (Important) - Chrome's persistent "Not secure" label drops every http LAN/intranet read, and the "reads again in 5 s" consolation is false for it

Chrome renders the omnibox of a non-trustworthy http origin as `[icon] Not secure | host/path`. That
is *text*, on the address row. Measured, every variant is **false**:

| line | result |
| --- | --- |
| `Not secure example.test/login` | **false - dropped** |
| `Not secure \| example.test/login` | **false** |
| `Not secure  192.168.1.20` | **false** |
| `Not secure wiki/` | **false** |
| `Not secure localhost:3000` | **false** |
| `View site information github.com` | **false** |
| `Reader Available 127.0.0.1` / `127.0.0.1 Reader Available` | **false** |
| `Secure github.com`, `Info github.com`, `Dangerous example.test` | **false** |
| `ℹ github.com`, `🔒 github.com` (symbol glyphs) | true |

No glyph allowance can absorb these, because the leading rule forbids letters outright. The
developer's D-O8-8 names the risk as *icon glyphs* rendered as `C =`; the certain and much larger
version is a **word label**, which he does not name.

**How common in a developer's day.** Chrome treats `localhost` and `*.localhost` as trustworthy, so
`http://localhost:3000` shows no such label - the headline use case is safe. Everything else http is
not: `http://192.168.x.x` (a phone or device on the LAN, a router, a NAS, a printer), and
`http://wiki` / `http://jira` / `http://grafana` - which is precisely the population I2 was just added
to serve. In Chrome, I2's fix is largely neutralised by N3. Safari does not show the label for plain
http, so Safari is unaffected.

This is fail-**closed**, so it is a usability cost, not a privacy hole - but two things need fixing:

1. The doc comment's consolation, *"The cost is bounded: the capture loop reads again a few seconds
   later, when the host is back"*, is **false for this class**: the label is permanent for that page,
   so the read is dropped for as long as the user is on it. That sentence appears in both `sites.ts`
   and `index.ts`.
2. It is not in `KNOWN_LIMITS`, and it is not in the report.

**Fix:** record it honestly (doc comment + a `D-O8-x` row), and settle it with the same C-2b observe
run already required for D-O8-7/8 - stage one `http://192.168.x.x` or single-label page in Chrome and
read whether "Not secure" arrives glued to the address line or as its own line. If it is its own
line, the cost vanishes and only the doc needs correcting; if it is glued, the owner must choose
between dropping those reads and allowing a short list of known browser-chrome words before the
address token.

### N4 (Minor) - the residual hole is honest in kind but understated in extent, and truncation makes it common

The doc names the hole as "a tab title that is by itself exactly ONE address-like token - `Node.js`,
`README.md`, `TCP/IP`". Honest as far as it goes. Two things are missing:

- **The real grammar is wider than three examples.** Measured true: `index.html`, `package.json`,
  `tsconfig.json`, `Cargo.toml`, `docker-compose.yml`, `webpack.config.js`, `app.py`, `run.sh`,
  `main.rs`, `styles.css`, `notes.txt`, `data.csv`, `a.out`, `core.dump`, `CHANGELOG.md`, `foo.bar`,
  `Dr.Who`, `localhost`, `1.2.3.4`, `8.8.8.8`, `10.30.15.20`, `0.0.0.0`, `wiki/`, `wiki:80`. And,
  newly created by I2's single-label rule and not mentioned anywhere: `and/or`, `km/h`, `CI/CD`,
  `AC/DC` - one-token English/technical words that are not address-like at all. (`v1.2.3.4`, `a/b`,
  `N/A`, `24/7`, `I/O`, `:8080`, `x:1`, `w/o`, `9/11` are correctly false.)
- **Truncation puts ordinary tab titles into exactly that shape.** A browser truncates a tab title to
  the tab's width, and the trailing mark is letterless, so it passes even after N1's fix. Measured
  true: `README.md …`, `Node.js …`, `index.html …`, `spec.md …`, `notes.txt …`, `main.py …`,
  `Node.js —`, `README.md -`, `Node.js ...`. With several tabs open this is the *normal* rendering,
  not an edge case. End to end:
  `after({app:"Safari", title:"Accounts"}, "Translation Available\nREADME.md …")` -> **`null` (KEPT)**.

**Is there a cheap further narrowing that drops no real address?** Yes, one: when the token has **no
scheme, no port and no path**, reject a final label that is a common file extension which is not a
TLD - `js`, `json`, `html`, `htm`, `toml`, `yml`, `yaml`, `lock`, `out`, `dump`, `cfg`, `ini`, `xml`,
`csv`, `txt`, `css`, `rs`. No real address can end that way, because a real bare host ends in a real
TLD; so the cost is provably zero. That kills `Node.js`, `index.html`, `package.json`,
`tsconfig.json`, `Cargo.toml`, `docker-compose.yml`, `webpack.config.js`, `a.out`, `core.dump`,
`notes.txt`, `styles.css`, `main.rs` and their truncated forms. It does **not** kill `README.md`,
`app.py`, `run.sh` (`md`, `py`, `sh` are real TLDs) - those need the reader-side address row, as the
doc already says. A second, cheaper-still option is to require the host part to carry no uppercase
letter (browsers always render the host lowercased), which additionally kills `README.md`, `TCP/IP`,
`CHANGELOG.md`, `Cargo.toml`, `CI/CD`, `AC/DC` - but it costs the `LOCALHOST:3000` true case and is
exposed to recogniser case errors, so it is the owner's call, not mine.

**Fix:** state the hole as a grammar rather than three examples, add the truncated forms and the I2
`and/or` class to the `describe("... the residual hole ...")` block so the extent is pinned, and take
the extension deny-list if the owner wants the cheap half of it.

### N5 (Minor) - two measured numbers in the new doc comment are wrong, in the direction that flatters the caps

`sites.ts:25-27`: *"A real strip is a few dozen characters - Safari's measured at 15-26
(`readerEval/score.ts`), Chrome's up to about 96 - so these caps are two orders of magnitude of
headroom."*

- Safari 15-26 is right for normal windows; `score.ts:155` says 50-96 for **private** Safari windows,
  and the recorded runs show Safari up to **102**. The "96" is Safari's private-window figure, not
  Chrome's.
- Chrome's measured strips are **130-148 characters** (44 reads, `bandPx: 82`, single tab). So the
  character headroom is about **14x, one order of magnitude, not two** - and the line headroom (N2) is
  far thinner than that.

Also, the precedent it cites (`score.ts:183-185`) slices *and* drops a trailing lone high surrogate;
the new `slice` does not. Harmless for a boolean, noted only because the comment claims to follow that
rule.

### N6 (Minor) - the report's totals and three mutation rows are stale by exactly 10 tests, and one fixture claim is wrong

Measured now: `test src/core src/eval` = **528 in 24 files**, not the 518 the report's table gives;
`test src/core/exclusions` = 230 (matches); `test src/core src/eval src/main src/renderer` = 1198
(matches); both tsconfigs clean (matches). The mutation table's D/E/F rows say `2 / 218`, `3 / 217`,
`3 / 217`, where the current totals are `2 / 228`, `3 / 227`, `3 / 227`. The gap is exactly the 10
tests the developer says he added last (4 punctuation-run + 3 leading-count + 3 trailing-count), so
these rows and the 518 were measured before that and not refreshed. Every failing test **name** in the
table is exact. Honest slip, not a bad claim - but a report that is checked by its numbers should
carry the final ones.

Separately, the report says of the release-gate fixtures: *"All four browser reads are Google Chrome
with a single-token address strip, so all four are address lines under the new rule."* Measured:
`showsAddress("example.com   Incognito")` is **false** (the trailing token is nine characters). That
read is answered earlier by `hasPrivateToolbarMarker` -> `privateWindow`, so the gate is unaffected
and the fixtures pass - but the claim as written is wrong. The other three are true.

---

## Part 3 - gates, mutations, non-regression

**Gates** (private copy `$S/s4/rr/app`, never `pnpm`):

```
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s4/rr/app src/core src/eval
    -> Test Files 24 passed (24) | Tests 528 passed (528)        [report says 518 - see N6]
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s4/rr/app src/core/exclusions
    -> 230 passed (230)                                          [matches]
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s4/rr/app src/core src/eval src/main src/renderer
    -> 1198 passed (1198)                                        [matches]
node $R/app/node_modules/typescript/bin/tsc --noEmit -p $S/s4/rr/app/tsconfig.json           -> clean
node $R/app/node_modules/typescript/bin/tsc --noEmit -p $S/s4/rr/app/tsconfig.renderer.json  -> clean
```

**Release-gate fixtures: untouched.** `$R/eval/fixtures/*.json` all still dated 2026-09-17, and
`src/eval` is green inside the 528. The four reads carrying a `toolbarText` are unchanged (see N6 for
the report's claim about them).

**All nine developer mutations re-run** (each applied by exact-string edit in the private copy,
restored from a byte copy, `cmp`-clean every time). Failing-test names match the report exactly in all
nine; counts differ only as N6 describes.

| # | mutation | report | reproduced |
| --- | --- | --- | --- |
| A | whole strip again, not per line | 22 / 208 | **31 / 199** (my formulation is stronger - any token anywhere; it also takes out the four counting-guard tests) |
| **B** | drop leading glyph-token **length** limit | 4 / 226 | **4 / 226**, same 4 names |
| B2 | drop trailing glyph-token **length** limit | 15 / 215 | **15 / 215**, same names |
| C | bare single word as a host | 14 / 216 | **14 / 216**, same names |
| D | remove the input cap | 2 / 218 | **2 / 228**, same 2 names |
| E | drop the IPv6 `::`-or-three guard | 3 / 217 | **3 / 227**, same 3 names |
| F | `TAIL` matches anything | 3 / 217 | **3 / 227**, same 3 names |
| **G** | drop leading glyph-token **count** limit | 3 / 227 | **3 / 227**, same 3 names |
| **H** | drop trailing glyph-token **count** limit | 3 / 227 | **3 / 227**, same 3 names |

No mutation survived. The three the first review's process would have worried about (B, G, H - the
ones the developer reports as initially unpinned) all bite now.

**Candidate patches, measured** (applied in the private copy, then restored):

| patch | suite |
| --- | --- |
| N1 letterless trailing + Unicode-aware glyph test | **229 / 230** (only `github.com/acme/repo C =`) |
| Unicode-aware glyph test alone | **230 / 230** (free) |
| N2 drop the line cap | **229 / 230** (only the cap test) |

**Non-regression, byte level.** `sites.ts` differs from `pre-o8/exclusions/sites.ts` by a single
inserted block: common prefix 925 bytes, common suffix 755 bytes, both byte-identical, and the
insertion sits between them. `SITE`, `HOST`, `parseSites`, `extractHosts` are all inside the identical
prefix; `hostMatches`, `titleMentions`, `siteExcluded` are all inside the identical suffix. `index.ts`
differs by one import line plus one inserted block; the rule order (private marker -> excluded site ->
no address) and `isMeasuredBrowser` gating are unchanged. `defaults.ts`, `rules.ts`, `rules.test.ts`,
`privateWindows.ts`, `privateWindows.test.ts`, `malformed.test.ts` are `cmp`-identical to `pre-o8/`.
`copy.ts` untouched; `KNOWN_LIMITS` still carries the owner's sentence at line 24, which stays true
(though N3 is a limit it does not cover).

Every file under `app/src/core/exclusions/` in the private copy is `cmp`-identical to `$R/app` as I
finish, and no probe file is left behind.

---

## For the owner, in one place

1. **D-O8-7 / D-O8-8 still need the C-2b observe run**, as both the developer and the first reviewer
   said. Add one question to it: stage an `http://192.168.x.x` or single-label page in Chrome and read
   whether "Not secure" comes back glued to the address line (N3). The Safari half of D-O8-8 is
   already answered by `ledger.md:118` - the `C =` glyph run was its **own line**.
2. **N2 is a decision only because it is a cap you chose**: 16 lines has no safety value and can
   silently stop Chrome reads once a window has enough tabs.
3. **The residual hole is wider than "three examples"** (N4). Whether to take the free
   file-extension narrowing, and whether to pay the `LOCALHOST:3000` test for the lowercase-host
   narrowing, is yours.

---

**Spec compliance: ❌** - O8 is "a read of a measured browser whose toolbar strip shows no address is
NOT kept, fail closed". The rule is now enormously closer to that than round 0 was, and the failure is
narrow and enumerable rather than "nearly a no-op": a band line of the shape *address-like token +
up to three short words* is still treated as an address (N1), and a truncated one-token tab title is
still treated as an address (N4, disclosed but understated). End to end,
`after({app:"Safari", title:"Accounts"}, "Translation Available\nNode.js API")` still returns `null`.
Rule placement, `isMeasuredBrowser` gating, reason choice, `extractHosts`/`siteExcluded`
non-regression and the fixture gate all comply.

**Quality: Not approved** - N1 (a fail-open that the doc comment explicitly denies, in the privacy
core, with a four-token fix that costs one invented test), N2 (a cap that buys nothing and can
silently stop Chrome reads), N3 (a persistent, unrecorded fail-closed class, plus a false consolation
sentence in two files). N4-N6 are corrections to text, tests and numbers and can ride along.

**Verdict: Not approved, narrowly.** C2 is fixed properly - linear patterns, cap before matching, the
uncapped-`extractHosts` reasoning correct and now tested. C1 is fixed in the right direction and the
line scope is real and well pinned. I1, I2, I3 and M1 are all genuinely closed, the mutation evidence
reproduces name for name, and the developer's disclosure of his own surviving mutation B is the kind
of honesty that makes a report usable. What stands between this and approval is one four-token edit
(N1), one deletion (N2), and telling the truth about "Not secure" (N3).
