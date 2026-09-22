# O8 review - "a measured browser with no address on its strip is not kept"

**Reviewer:** independent (did not write the change) - **Date:** 2026-09-21
**Under review:** `app/src/core/exclusions/sites.ts`, `app/src/core/exclusions/index.ts` (+ their tests),
developer report `session2/o8-dev-report.md`, diff `s3/o8.diff`, baseline `session2/pre-o8/exclusions/`.
**Method:** read-only against `$R`; every mutation run in a private copy, restored and `cmp`-ed.

**Verdict: Not approved. Two Critical findings must be answered before this ships.**

Everything the report says it did, it did. The five mutations reproduce to the letter, the byte-identity
claims hold, 440/440 pass and `tsc` is clean. The problems are not in the bookkeeping: the rule does not
do what the code comment and the report say it does, and one of the three new regexes is a cubic-time
ReDoS in the main-process hot path.

---

## Findings

### C1 (Critical) - the rule is not fail-closed: any tab title with a dotted word defeats it

`showsAddress` (`sites.ts:58-61`) asks "is there an address-looking token ANYWHERE in the strip?".
But the strip is not the address field. `native/reader/src/toolbar.rs:38-44` joins **every recognised
line whose bottom edge falls inside the band** with `"\n"`, and the band is 82 pt in Chrome and 41 pt in
Safari (`toolbar.rs:16`). In Chrome that band is the tab strip *plus* the omnibox - `toolbar.rs:96` calls
the line it tests `"tab title"`. In Safari the compact tab bar draws the other tabs' titles in the same
row as the address field, which this repo already states as fact two files away:
`exclusions/privateWindows.ts:28-29` - "a tab whose title contains the word, shown in the compact tab bar
inside the strip, skips that read."

So a real browser strip essentially always carries tab titles, and the new rule is satisfied by any of
them containing a dotted lowercase word with a 2+ letter tail.

**Probe** (the exact measured O8 scenario, plus one ordinary tab open):

```
after({app: "Safari", title: "Some page"}, "Translation Available")                  -> "unknownWindow"   (caught)
after({app: "Safari", title: "Some page"}, "Translation Available\nNode.js docs")    -> null              (KEPT)
after({app: "Google Chrome", title: "Untitled"}, "chrome://settings\nNode.js docs")  -> null              (KEPT)
after({app: "Google Chrome", title: "Untitled"}, "Release 10.0.0.1 notes")           -> null              (KEPT)
after({app: "Google Chrome", title: "Untitled"}, "localhost setup guide")            -> null              (KEPT)
```

`showsAddress` returns true for all of these, none of which contains an address:

| strip text | why true |
| --- | --- |
| `Node.js`, `ASP.NET`, `README.md`, `index.html`, `main.py`, `config.json`, `Dockerfile.dev`, `report.final.pdf`, `v2.final`, `Mr.Smith replied`, `we are done.Next up` | `HOST` (`sites.ts:2`) - dotted word, alphabetic 2+ tail |
| `bob@example.com` | `HOST` - an email address is a host with a name in front |
| `Release 10.0.0.1 notes`, `Version 1.2.3.4 release notes`, `Meeting at 10.30.15.20` | `IPV4` (`sites.ts:33`) - the octet range check only rejects `256.x`, not a four-group version number preceded by a space |
| `localhost setup guide`, `How to run localhost` | `LOCALHOST` (`sites.ts:32`) - the bare English word |
| `[09:12:33] build ok` | `IPV6` (`sites.ts:34`) - see C2/I3 |

**How strong is the evidence, honestly?** Weak. On Chrome, "some token in the strip is dotted" is close to
a tautology, so for Chrome the rule is very nearly a no-op except for a genuinely blank band. On Safari
it works only for a window with no other tab whose title carries a dotted word - a single-tab window,
which is not the common case. The report's headline "Fail closed: no address, no read" (`index.ts:69`)
and section 2's claim that the false list is the bound are both wrong, because the false list is made
entirely of *whole strips* consisting of one banner, and a real strip is a banner plus tab titles. Neither
the report nor the doc comment mentions the tab-title channel anywhere, although `privateWindows.ts`
documents it as a known cost of the neighbouring rule.

**Is it worse than nothing?** No - keep it. It really does close the empty strip and the single-tab
translation banner at no cost. It is a partial fix presented as a complete one.

**Is there a materially better, still simple rule?** Yes: scope the question to a **line**, not the strip.
Safari's normal strip is 15-26 characters (`readerEval/score.ts:155`) and is the address alone; Chrome's
omnibox line is the URL. A tab title is prose with spaces. So:

```
export function showsAddress(toolbarText: string): boolean {
  return toolbarText.split("\n").some(lineIsAddress);
}
// after dropping a leading glyph run, the part before the first / ? # must carry no space,
// and must itself match one of the four grammars anchored at the start.
```

That rejects `Node.js docs`, `Release 10.0.0.1 notes`, `localhost setup guide`, `README.md - GitHub`,
`[09:12:33] build ok`, and keeps every measured true case in `sites.test.ts` including
`@ 127.0.0.1`, `• github.com`, `app.clave.localhost:8765/chat.html?th` and `https://www.paypal.com/signin`.
**It must not ship on my say-so**: it needs one observe run over real Chrome and Safari strips first, to
confirm the omnibox is recognised as its own line and not glued to a neighbouring control. C-2b's observe
harness already produces exactly that.

The exact fix is `reader`-side and belongs in C: `toolbar.rs:41-43` has the per-line geometry
(`Line` carries `top`/`bottom`/`x`/`right`) and throws it away in the join. Handing the core the address
**row** instead of the whole band makes this question exact rather than heuristic.

---

### C2 (Critical) - `IPV6` is a cubic-time ReDoS on an input the core treats as untrusted

`sites.ts:34`: three greedy runs over the same character class, separated by two mandatory colons, ending
in a literal `]`. When the `]` is missing the engine enumerates every way to split the run into three
parts - O(n^3).

**Probe** (measured, this machine, plain `node`):

| strip | time |
| --- | --- |
| `"[" + ":".repeat(400)` | 17 ms |
| `"[" + ":".repeat(800)` | 150 ms |
| `"[" + ":".repeat(1600)` | **1.17 s** |
| `"[" + ":".repeat(3200)` | **8.6 s** |
| `"[" + ":".repeat(6400)` | **68 s** |
| `"[" + "a:".repeat(800)` (hex, 1601 chars) | 295 ms |
| `("[" + ":".repeat(300)).repeat(300)` (90 KB, short runs) | **3.5 s** |

The last row matters most: it needs no single huge run, only many ordinary-length ones. `LOCALHOST`,
`IPV4` and `HOST` are all clean - each returned in under 1 ms on 100 KB adversarial input, so `IPV6` is
the whole problem.

**Why this is Critical and not theoretical.** The core states its own threat model at
`core/index.ts:30-34`: "A read comes from another process, so a field that should be text may be anything."
There is no length cap anywhere on the way in - `main/ports/reader.ts:106` is `z.string().optional()` with
no `.max()`. And the project has already written this rule down for a sibling module:
`readerEval/score.ts:152-158` caps its strip scan at 1024 with the rationale "a helper that one day
returned a whole page as its strip would otherwise spend the owner's session in this loop." The new code
is in the privacy core, runs on **every** read on the main process, and does not follow that rule.
Reachability through a well-behaved reader is low (real strips are 15-96 chars); reachability through a
broken or hostile one is total, and that is precisely the case the core says it defends against.

**Suggested fix** - one greedy class plus one literal is linear, and the colon count moves to JS, which
also fixes I3:

```
const IPV6_BRACKETED = /\[[0-9a-f.:]{0,45}\]/gi;   // 45 = longest real literal; linear, no ambiguity
const looksIpv6 = (s: string) =>
  [...s.matchAll(IPV6_BRACKETED)].some((m) => m[0].includes("::") || (m[0].split(":").length - 1) >= 3);
```

`::` or 3+ colons keeps `[::1]`, `[2001:db8::1]`, `[fe80::1]`, a full 8-group literal, and rejects
`[09:12:33]`. Add the 1024-character cap from `score.ts` as a belt-and-braces second line.

---

### I1 (Important) - the stated reason for the rule ORDER is factually wrong

`index.ts:74-76` and report sections 3 and 9 (D-O8-2) both say: `privateWindow` is in `AWAY_REASONS`,
which tells the segmenter the user is away, `unknownWindow` is not, "so the order is load-bearing beyond
the counter name", and getting it backwards "would stop a private window closing a stretch of work."

That is not what the code does. `AWAY_REASONS` (`core/index.ts:28`) is consulted in exactly one place,
`core/index.ts:75`, inside `gate()`, and `gate()` only ever sees the reason from `before()`
(`core/index.ts:73`). The `after()` reason is used at `core/index.ts:155-156` and goes straight to
`deny()` - the segmenter is never told. Worse, `core/index.ts:78` has already called
`segmenter.captureAllowed(now, true)` before `after()` runs.

So in `after()`, `privateWindow` and `unknownWindow` are equally inert toward the segmenter; **only the
counter name differs**. This bites hardest for the very example the comment uses: Safari puts no marker in
the window title (`privateWindows.ts:26`), so a Safari private window is recognised **only** in `after()`
and therefore never marks the user away at all, before or after O8.

The chosen order is still the right one (the more specific reason is the more useful one, and M4/M5 pin
it). Only the justification is wrong - but it is wrong in a doc comment in the privacy core, where a
future maintainer will reason from it.

**Fix:** correct `index.ts:74-76` to say the order is about which reason is reported, and drop the
segmenter claim. Separately worth an owner decision, out of O8's scope: *should* an `after()`
`privateWindow` mark the user away? Today it does not, and the comment shows at least one person believes
it does.

**Probe:** `grep -n captureAllowed app/src/core/index.ts` returns lines 75 and 78 only, both inside
`gate()`, both above the `after()` call at line 155.

---

### I2 (Important) - single-label hosts are dropped; work is silently not kept

A host with no dot matches none of the four grammars. Measured:

| strip | kept? |
| --- | --- |
| `intranet/`, `intranet`, `http://wiki/`, `wiki`, `jira/browse/ABC-1` | **dropped** (`unknownWindow`) |
| `localhost:5173`, `127.0.0.1:8000/docs`, `0.0.0.0:3000`, `192.168.0.12`, `[::1]:3000` | kept |
| `myapp.test`, `foo.local`, `host.docker.internal:8080`, `db.svc.cluster.local:5432`, `mysite.internal` | kept |
| `xn--80ak6aa92e.com` (punycode) | kept |

The developer's stated target user is "developers who spend the day on `localhost:3000`", and that case is
handled well. But the same user on a company LAN reaches `http://wiki`, `http://jira`, `http://grafana`
and `/etc/hosts` single-label aliases, and every one of those reads is now silently dropped with no
user-visible explanation (D-O8-6 leaves the limit unstated). The report does not mention this shape at all.

**Fix:** add a fourth grammar for a bare single label followed by `:port`, `/`, or end - e.g. a lone
`[a-z0-9-]{2,}` token that is the whole line, with a port or a path. Under C1's line-scoped rule this is
safe, because a tab title is prose; under today's whole-strip rule it would be far too broad, so **do C1
first**. Until then, record this in `KNOWN_LIMITS` alongside the copy sentence already proposed.

---

### I3 (Important) - the doc comment's IPv6 justification is false, and two of the four claimed guards have no test

`sites.ts:29-30` claims two colons is "the least a real one can have (`[::1]`) and one more than a clock
(`[09:12]`)". A clock with seconds - `[09:12:33]` - has two colons and **matches**: `showsAddress("[09:12:33] build ok")`
is `true`. That is a live contributor to C1.

Worse, the suite does not defend either guard. I ran two extra mutations against the full
`src/core src/eval` gate; **both survived with 440/440 passing**:

| mutation | result |
| --- | --- |
| `IPV6` replaced by a regex matching any `[` at all (the entire two-colon guard removed) | **440 passed - no test bites** |
| `LOCALHOST`'s trailing lookahead removed (the guard the comment says makes `localhosting` not an address) | **440 passed - no test bites** |

Report section 2 lists four "why each fence is there" claims. The two that are tested (`1.2.3.4.5`,
`256.1.1.1`) are pinned by the false list. The two quoted above are not: neither `[09:12]`/`[09:12:33]`
nor `localhosting` appears anywhere in `sites.test.ts` - only the bare `09:12`, which cannot reach `IPV6`
because it has no bracket.

**Fix:** add `[09:12]`, `[09:12:33]`, `[2026-09-21]` and `localhosting` to the false table, and
`[2001:db8::1]` to the true table. The C2 fix makes the first three pass.

---

### M1 (Minor) - trailing punctuation drops an otherwise good address

`HOST`'s tail is `(?=[:/\s]|$)` and `LOCALHOST`'s is `(?=[/?#\s]|$)`, so a closing character kills the
match: `github.com,` `(github.com)` `github.com.` `localhost:3000,` `(localhost)` `localhost:3000]` all
return false, while `127.0.0.1,` and `192.168.0.12/admin` return true (`IPV4`'s tail is a negative class,
which is the more forgiving shape). Pre-existing in `HOST` and shared with `siteExcluded`, so not a
regression - but O8 turns it from "site not recognised" into "read not kept". Low frequency; an OCR pass
over a toolbar rarely appends punctuation. Making `LOCALHOST`'s tail a negative class
`(?![0-9a-z.-])`, to match `IPV4`, would be consistent and cheap.

### M2 (Minor) - recogniser confusions: which bite

| rendering | result | comment |
| --- | --- | --- |
| `github.cOm` (O for o) | kept | lowercasing repairs it |
| `github.c0m` (zero for o) | **dropped** | `[a-z]{2,}` tail |
| `github com` (dropped dot) | **dropped** | also defeats `siteExcluded` today, so O8 turns a pre-existing fail-**open** into a fail-**closed**: the privacy-correct direction |
| `1ocalhost:3000`, `l27.0.0.1` | **dropped** | |
| `github.com/acme/...` (Chrome eliding the tail) | kept | host survives at the front |
| `.../acme/repo` (front elided) | dropped | Chrome's omnibox keeps the origin, so this shape is not expected |
| `@ github.com`, `• github.com`, `¡• github.com`, `•github.com` | kept | Safari's leading glyphs are all fine |
| `github.\ncom` (host split across lines) | dropped | not an expected split inside the band |
| `übungen.de` | kept (matches the ASCII tail `bungen.de`) | |
| fully non-ASCII IDN | **dropped** | same blind spot `extractHosts` already has; out of scope for this user |
| `[fe80::1%25en0]:8080` (zone id) | **dropped** | `%` breaks the bracket class; rare |

None of these is common enough to block on. They are listed so the cost is on the record.

### M3 (Minor) - `unknownWindow` now mixes two different things

D-O8-4 already states this: `reads.skipped.unknownWindow` now counts "no strip at all", "a strip with no
address", and the pre-existing malformed-window case. Agreed as an accepted cost, noted because it will
make the C-2b observe numbers harder to read exactly while C1 is open.

---

## Answers to the seven questions

**1. Fail-open holes.** See C1. Real and wide, because the strip always carries tab titles
(`toolbar.rs:38-44`, `toolbar.rs:16`, `toolbar.rs:96`, `privateWindows.ts:28-29`). "An address-looking
token exists somewhere in the strip" is weak evidence that the host is on screen - on Chrome it is close
to always true. Homoglyphs are repaired upstream (`core/index.ts:35-36, 152`) and are not a contributor.
A materially better, still simple rule exists (line-scoped, C1); doing nothing is worse than the current
rule, so do not revert.

**2. Fail-closed cost.** Kept: `localhost:5173`, `127.0.0.1:8000/docs`, `0.0.0.0:3000`, `192.168.0.12`,
`[::1]:3000`, `myapp.test`, `foo.local`, `host.docker.internal:8080`, punycode, Chrome's `...` elision,
Safari's `@`/`•`/`¡•` prefixes. Dropped: single-label hosts (I2 - the one common shape),
`github.c0m`, `github com`, a host split across lines, fully non-ASCII IDN, zone-id IPv6, trailing
punctuation (M1). Verdict: the developer got the main usability call right; I2 is the gap.

**3. Rule order and reasons.** Verified against `pre-o8/`. `index.ts:56-57` invalid/malformed, `:58`
non-browser returns `null`, `:61` no strip -> `unknownWindow` (C-2a D2), `:62` private marker ->
`privateWindow`, `:63` excluded site -> `excludedSite`, `:85` the new rule, gated on `isMeasuredBrowser`.
Probed: `Code`/`Slack` (non-browser), `Opera GX`, `Google Chrome Canary`, `Safari Technology Preview`
(browsers, unmeasured) all return `null` on an empty strip, exactly as pre-o8. `• Private` ->
`privateWindow` and `* Incognito` -> `privateWindow` still fire first, so the Safari bare-word badge is
intact. `extractHosts` / `siteExcluded` are **byte-identical**: I reconstructed `sites.ts` minus the
inserted block and compared bytes against `pre-o8/exclusions/sites.ts` - equal. Same for `index.ts` minus
the new rule and the one import. The order justification is wrong, though - see I1.

**4. The `file:///` deviation.** Not a fail-open hole *for excluded sites*: a local file cannot be an
excluded site, and the mis-parse errs toward over-exclusion, which is safe - `file:///Users/x/chase.com.html`
returns `excludedSite`, and a file read with an excluded name in the window title is caught by
`titleMentions`. So the developer's conclusion is right. But the framing is wrong: this is not a quirk of
file paths, it is **one instance of C1**. `extractHosts` treats as a host any dotted token with a 2+
letter tail - measured: `index.html`, `v2.final`, `main.py`, `config.json`, `Dockerfile.dev`, `node.js`,
`asp.net`, `readme.md`, `mr.smith`, `report.final.pdf`, `done.next`. The same mechanism that keeps
`notes.html` is what keeps a `Node.js` tab title. The developer's argument that narrowing `showsAddress`
below `extractHosts` would be wrong is sound, and it is also why the fix is not narrowing but **scoping**:
ask the question of the address row, not of the band.

**5. ReDoS / cost.** See C2. `LOCALHOST`, `IPV4`, `HOST` are linear - all under 1 ms on 100 KB adversarial
input. `IPV6` is cubic: 1.17 s at 1.6 KB, 68 s at 6.4 KB, 3.5 s on a 90 KB string built from ordinary
300-character runs. No length cap exists anywhere on the path (`main/ports/reader.ts:106`).

**6. Release gate and fixtures.** Pass, nothing edited. The gate fixtures live at `$R/eval/fixtures/`
(not `app/eval/`). I enumerated every read across all of them: exactly 4 carry a `toolbarText`, all
`Google Chrome`, all with a real host - `youtube.com/watch?v=abc123`, `shop.example.com/cart`,
`https://secure.chase.com/web/auth/dashboard`, `example.com   Incognito`. Matches report section 7 exactly.
`src/eval` is green inside the 440. The reversed assertion is confirmed the **only** existing expectation
that changed: diffing `pre-o8/` against the working tree, `index.test.ts` has exactly one removed line
(the `an empty strip is still a strip` assertion) and `sites.test.ts` has exactly one removed line (the
import statement it replaces). `defaults.ts`, `rules.ts`, `rules.test.ts`, `privateWindows.ts`,
`privateWindows.test.ts` and `malformed.test.ts` are byte-identical to `pre-o8/`.

**7. The five mutations.** All five bite, and reproduce the report's section 5 table to the letter -
same counts, same test names. No mutation failed to bite.

| # | report | reproduced |
| --- | --- | --- |
| M1 drop the new rule | 2 failed / 140 passed | 2 / 140, same 2 names |
| M2 no-address = `extractHosts` empty | 13 / 129 | 13 / 129, same 13 names |
| M3 rule applied to every app | 4 / 138 | 4 / 138, same 4 names |
| M4 rule before the private marker | 2 / 140 | 2 / 140, same 2 names |
| M5 rule before the excluded site | 1 / 141 | 1 / 141, same name |

Restores byte-identical (`cmp` clean on both files). Two mutations of my own **survived** - see I3.

---

## Gates I ran

```
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s3/rv3/app src/core src/eval
    -> Test Files 24 passed (24) | Tests 440 passed (440)          [matches the report]
node $R/app/node_modules/typescript/bin/tsc --noEmit -p $S/s3/rv3/app/tsconfig.json
    -> clean
5 developer mutations + 2 of my own, each restored and cmp-ed            [all restores identical]
ReDoS timing: plain node, IPV6 / IPV4 / LOCALHOST / HOST, up to 112 KB
```

Nothing under `$R` was modified. All mutation work happened in the private copy; `cmp` confirms every
file under `app/src/core/exclusions/` in that copy is identical to `$R/app` as I finish.

---

## Scope notes

The proposed copy sentence in report section 8 is the owner's to judge, not mine, and I have not judged
it. I will only note that if C1 and I2 are fixed as suggested, the limit the sentence describes changes
shape (fewer silent drops from banners, one new class of them from single-label hosts), so the sentence
is worth settling **after** those, not before.

---

**Spec compliance: ❌** - Owner decision O8 is "a read of a measured browser whose toolbar strip shows no
address is NOT kept, fail closed." The implementation is fail-closed only for a strip that carries no tab
titles. On Chrome the band always carries them, and on Safari it carries them whenever a second tab is
open, so the measured defect the decision was taken on - an excluded site kept while Safari shows
`Translation Available` - survives in the common configuration (C1). Rule placement, `isMeasuredBrowser`
gating, reason choice, non-regression of `extractHosts`/`siteExcluded`, and the fixture gate all comply.

**Quality: Not approved** - C1 (the rule does not deliver its stated guarantee, and the doc comment and
report assert that it does), C2 (cubic ReDoS on input the core declares untrusted, in the main-process hot
path, against a rule this repo already wrote down at `readerEval/score.ts:152-158`), I1 (a false causal
claim in a privacy-core doc comment), I2 (an unmentioned usability cost), I3 (a false claim plus two
unpinned guards, both mutations surviving a full green gate).

**Verdict: Not approved.** The work is careful, honest about several of its own costs, and its mutation
evidence is real - the report is not overstating what was tested, it is overstating what the rule
achieves. Fix C2 (small, local, one regex plus a cap). Take C1 to the owner: the decision he approved is
not the behaviour he has, and the honest choice between the line-scoped rule and a reader-side address-row
change is his. I1 and I3 are corrections to text and tests and can ride along. I2 needs C1 first.
