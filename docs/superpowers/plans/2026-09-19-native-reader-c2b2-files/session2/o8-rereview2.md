# O8 re-review 2 - fix round 2 ("a measured browser with no address on its strip is not kept")

**Reviewer:** independent scoped re-reviewer (round 2). Did not write the change, did not write either
earlier review. **Date:** 2026-09-21
**Under review:** `app/src/core/exclusions/sites.ts` + `index.ts` (+ their tests) after fix round 2,
against `session2/o8-rereview.md` (N1, N2, N3, minors N4-N6), `session2/o8-dev-report.md` section
"Fix round 2" (15 mutations), the diff `s5/o8fix2.diff`, the round-1 code `s4/rr/.../exclusions`, and
the pre-O8 baseline `session2/pre-o8/exclusions`.
**Method:** read-only against `$R`. Every probe and every mutation was applied in the private copy
`$S/s5/rr/app`, restored from a byte copy and `cmp`-ed after each one; `pnpm` never ran against it.
**38 mutations** were applied one at a time (the developer's 15 re-run in my own wording, plus 23 new
ones aimed at each individual condition of the grammar). Nothing under `$R` was modified except this
file. All ten `src/core/exclusions/*.ts` files are `cmp`-identical to `$R/app` as I finish and no
probe file is left behind.

**Verdict: Approved with reservations.** N1, N2 and N3 are all genuinely fixed, and the two that were
fail-open are fixed at the root rather than patched at the symptom. The hunt the brief asked for did
find what it was looking for: **seven guards that no test pins** (plus three surviving mutations that
are provably behaviour-neutral). None of the seven is a live fail-open - the code is right today -
but each is a privacy guard that a future edit can delete in silence, which is the third consecutive
round in which this code has carried a guard asserted in a comment before it was asserted in a test.
Two findings are Important; five are Minor; none is Critical.

---

## Part 1 - the three findings, re-checked

| # | Verdict | One-line evidence |
| --- | --- | --- |
| **N1** letterless/digitless trailing tokens, Unicode-aware | **Fixed** | all 22 probes false, all 9 measured renderings still true, the round-1 regression mutation fails 29 tests |
| **N2** no line cap, cap before matching, truncated final line | **Fixed** | 16-line cap re-added fails 7 tests; I could not build a truncated token that passes |
| **N3** closed `BROWSER_ADDRESS_LABELS`, false consolation corrected | **Fixed, with one deliberate gap and one undisclosed one** | list closed and pinned; `\|` separator case is a knowing, correct, fail-closed refusal; the list is English-only and nothing says so (P6) |

### N1 - Fixed. One predicate at both ends, and it is the right predicate.

`isGlyph(token, maxChars)` is `token.length <= maxChars && !HAS_LETTER_OR_DIGIT.test(token)` with
`HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u`, and `lineIsAddress` calls it for the leading run and for
every trailing token. The four counting constants are unchanged (2 x 2 leading, 3 x 3 trailing) and
each of the four is independently pinned - see the mutation table: `LEADING_GLYPHS_MAX` 3 failures,
`LEADING_GLYPH_CHARS_MAX` 4, `TRAILING_GLYPHS_MAX` 3, `TRAILING_GLYPH_CHARS_MAX` 4.

Measured in the private copy, all as the brief requires:

| probe | result |
| --- | --- |
| `Node.js API`, `main.py fix`, `README.md doc`, `github.com PR`, `site.com a b c` | **false** |
| `index.html <2 CJK chars>`, `<2 CJK chars> github.com`, `github.com <3 Arabic chars>` | **false** |
| `github.com 42`, `1 github.com`, `github.com v2` (the digit half) | **false** |
| `@ @ @ github.com`, `@@@ github.com`, `github.com @ @ @ @`, `github.com @@@@` (the bounds) | **false** |
| `@@ github.com`, `github.com @@@` (the bounds are exactly where they say) | **true** |
| `after({app:"Safari",title:"Accounts"}, "Translation Available\nNode.js API")` | **`unknownWindow`** |
| `@ 127.0.0.1`, `• 127.0.0.1`, `¡• 127.0.0.1`, `"@ 127.0.0.1\nC ="` | **true** |
| `app.clave.localhost:8765/chat.html?th...`, `127.0.0.1:57174/chat.html?theme=light&size=14…` | **true** |
| `github.com/acme/repo`, `localhost:3000/dashboard`, `[::1]:8080` | **true** |

Four independent mutations of the predicate all bite: length-only trailing (the round-1 code) **29
failures**, ASCII-only test **4**, drop the letter half **26**, drop the digit half **2**
(`ASP.NET 8`, `TCP/IP 101`). The digit half is the thinnest, but it is pinned.

**The invented case is gone and the measurement replaced it.** `"@ 127.0.0.1\nC ="` is in the true
table and `ledger.md:118` supports it (`toolbarTextLength` 15 is exactly that string). That is the
right way to settle D-O8-8 for Safari.

### N2 - Fixed. The cap is the only bound, it is applied first, and the truncation rule is sound.

`STRIP_SCAN_MAX_LINES` is gone from the whole tree (grep over `$R/app/src` and the private copy: no
hits). `showsAddress` is now

```
const lines = toolbarText.slice(0, STRIP_SCAN_MAX_CHARS).split("\n");
if (toolbarText.length > STRIP_SCAN_MAX_CHARS && toolbarText[STRIP_SCAN_MAX_CHARS] !== "\n") lines.pop();
return lines.some(lineIsAddress);
```

- **Cap before matching:** the `slice` is the first operation and the two extra reads are an O(1)
  `.length` and an O(1) index, not a match. Re-running the cap constant to 1e9 fails **4** tests
  (a stronger formulation than the developer's D, which fails 1); the cap is pinned structurally.
- **Many tab lines before the address:** bands of 14/16/20/40/100 tab lines plus the omnibox are all
  read, at the predicate and at `after()`. Putting the 16-line cap back fails **7** tests, name for
  name what the report claims.
- **The truncated-final-line rule:** the three branches are pinned; dropping the whole guard fails 1,
  dropping only the newline exception fails 1.
- **I tried to make a truncated token pass and could not.** The shape the brief names - an
  address-like prefix of a longer non-address word ending exactly at the cap - is
  `...\ngithub.commercial-bank-of-nowhere` arranged so the kept text ends at `github.comm`. That
  string *would* be an address line (`DOMAIN` matches it whole), and `showsAddress` answers **false**
  because the guard pops it. The guard is airtight by construction: a line can only be half a line
  when `length > CAP`, and in that case it is dropped unless the cut fell on the newline, in which
  case it is whole. A `\r\n` strip cut on the `\r` is popped too - fail closed.
- One consequence worth writing down, since it is not in the tests: a strip **with no newline at all**
  that is longer than 2048 characters is now always `false`, because its single line is always the
  cut one. Fail closed, ~14x the measured Chrome size, consistent with D-O8-14 - but the describe
  block only pins the multi-line form of that cost.

### N3 - Fixed in code; the gap the developer names is the right call; a second gap is not named at all.

`BROWSER_ADDRESS_LABELS` is an exported `readonly string[]` containing exactly `["not secure"]`, its
contents are asserted by a test (widening it by one word fails 2 tests, one of them that assertion),
it is matched case-insensitively (case-sensitive matching fails 8), it may not repeat (fails 1) and
it may not stand alone (fails 4). The false consolation sentence is corrected in both `sites.ts`
(lines 214-219) and `index.ts` (lines 69-73), and both now distinguish the banner that goes away from
the label that does not.

**Where the label may sit - what the code actually does.** `lineIsAddress` consumes the leading glyph
run first, then `labelWordsAt`, then the address token. So the label sits strictly *between* the
glyphs and the address. Of the orders Chrome could plausibly render:

| rendering | handled? | measured |
| --- | --- | --- |
| `Not secure host` | yes | `Not secure 192.168.1.20` true |
| `[icon] Not secure host` | yes | `@ Not secure 192.168.1.20` true |
| `[icon] Not secure \| host` (a separator between label and address) | **no** | `Not secure \| example.test/login` false |
| `Not secure [icon] host` | no (same rule as above) | `Not secure @ 192.168.1.20` false |
| `host Not secure` | no, correctly | `127.0.0.1 Reader Available` false |

So the two orders that need no guessing are handled, and the one the re-review's own model of Chrome
predicts (`[icon] Not secure | host/path`) is not.

**Is pinning `Not secure | example.test/login` as FALSE the right conservative call? Yes - with one
correction to the reasoning.** It is right because the separator is unmeasured, because the direction
is fail-closed, and because widening a privacy rule on a guess is what put round 0 in trouble; and
pinning it as a false case *with a comment naming it* is exactly how an unresolved risk should be
recorded. The correction: the developer frames the widening as dangerous, and by this rule's own
grammar it is nearly free. `Not secure <anything that parses as a host>` is **already** true today -
I measured `Not secure Node.js`, `Not secure README.md`, `Not secure and/or`, `Not secure TCP/IP` all
**true**. Allowing one letterless glyph token between the label and the address would therefore add
nothing the label has not already opened, while refusing it costs an entire class of pages
*permanently*. The asymmetry runs the other way from the way the report reads it, so if the observe
run shows a separator, taking the one-glyph allowance is not a concession - it is the cheap answer.

**What the measurement has to show** (this is the sentence the observe run should be given):

1. Stage, in the owner's own Chrome, an `http://192.168.x.x` device page **and** a single-label
   `http://wiki`-style page; capture the raw `toolbarText` for each read, not a summary.
2. Read off four things: (a) does the security label come back on the **same recognised line** as the
   host, or as its own line? (b) if the same line, what exactly sits between them - nothing, `|`, a
   bullet, a middle dot? (c) what is the **exact label string in that Chrome's UI language**? (d) does
   the icon glyph precede the label or the address?
3. Then: own line -> no label rule is needed at all and the list can shrink to empty. Same line, no
   separator -> the code is already right. Same line with a separator -> allow exactly one letterless
   glyph token between label and address, nothing more. A different label string -> see P6.

---

## Part 2 - the hunt for guards no test pins

38 mutations, one at a time, each restored from a byte copy and `cmp`-ed (`src/core`, baseline
**622 passed**). Every one of the developer's 15 was re-run in my own wording.

### Reproduction of the developer's 15

| dev # | my wording | report | measured | names |
| --- | --- | --- | --- | --- |
| I | trailing tokens length-checked only | 29 | **29** | match |
| J | put the 16-line cap back | 7 | **7** | match |
| L | label may stand alone | 4 | **4** | match |
| M | drop the truncated-final-line guard | 1 | **1** | match |
| N | ASCII-only glyph test | 4 | **4** | match |
| B | drop leading glyph **length** limit | 4 | **4** | match |
| B2 | drop trailing glyph **length** limit | 4 | **4** | match |
| C | `TAIL_REQUIRED` -> `TAIL` (bare word is a host) | 14 | **14** | match |
| E | drop the IPv6 `::`-or-three guard | 3 | **3** | match |
| F | `TAIL` matches anything | 3 | **3** | match |
| G | drop leading glyph **count** limit | 3 | **3** | match |
| H | drop trailing glyph **count** limit | 3 | **3** | match |
| A | ask the question over the whole strip again | 73 | 43 | my formulation is weaker; theirs is the stronger one |
| D | remove the character cap | 1 | **4** | my formulation (constant -> 1e9) is stronger |
| K | widen the label list | 14 | 2 | I widened by one plausible word; theirs widens to any two words |

Twelve of fifteen reproduce name for name; the three that differ differ only in how the mutation is
worded, and two of those three are stronger in my version. **No claim in the report's mutation table
failed to reproduce.**

### The 23 new mutations, condition by condition

| mut | condition attacked | result |
| --- | --- | --- |
| X1 | 2048-character cap | killed 4 |
| X2 | truncated-final-line guard | killed 1 |
| X3 | the newline exception inside it | killed 1 |
| X4 | `TOKENS_MAX` early-out | **SURVIVED (behaviour-neutral, proven)** |
| X5 | `LEADING_GLYPHS_MAX` 2 -> 6 | killed 3 |
| X6 | `LEADING_GLYPH_CHARS_MAX` 2 -> 40 | killed 4 |
| X7 | `TRAILING_GLYPHS_MAX` 3 -> 9 | killed 3 |
| X8 | `TRAILING_GLYPH_CHARS_MAX` 3 -> 40 | killed 4 |
| X9 | glyph test: drop letter/digit half | killed 31 |
| X10 | glyph test ASCII-only | killed 4 |
| X11 | glyph test drops the **digit** half | killed 2 |
| X12 | glyph test drops the **letter** half | killed 26 |
| X13 | trailing length-checked only (round-1 code) | killed 29 |
| X14 | all-glyph-line early-out | **SURVIVED (behaviour-neutral, proven)** |
| **X15** | **label matched whole-word** | **SURVIVED - finding P1** |
| X16 | label matched case-insensitively | killed 8 |
| X17 | label may not stand alone | killed 4 |
| X18 | label may not repeat | killed 1 |
| X19 | label list contents | killed 2 |
| **X20** | **glued leading glyph run `{1,2}`** | **SURVIVED - finding P2** |
| X21 | glued leading glyph lookahead | **SURVIVED (behaviour-neutral, proven)** |
| X22 | scheme allow-list (`https?` only) | killed 1 |
| X23 | `DOMAIN` TLD length `{2,}` | killed 1 |
| X24 | IPv4 octet **range** check | killed 1 |
| X25 | IPv4 exactly-four-octets | killed 2 |
| **X26** | **`BRACKETED` 45-character bound** | **SURVIVED - finding P3** |
| X27 | IPv6 `::`-or-three colon rule | killed 3 |
| X28 | single label's mandatory letter | killed 2 |
| X29 | single label's 2-character minimum | killed 5 |
| **X30** | **`TAIL` port digit bound `{1,5}`** | **SURVIVED - finding P3** |
| **X31** | **`TAIL` trailing-punctuation bound `{0,3}`** | **SURVIVED - finding P2** |
| X32 | `TAIL` anchored at all | killed 3 |
| X33 | `TAIL_REQUIRED` (port or path compulsory) | killed 14 |
| **X34** | **`TAIL_REQUIRED` trailing-punctuation bound** | **SURVIVED - finding P2** |
| **X35** | **`TAIL_REQUIRED` port digit bound** | **SURVIVED - finding P3** |
| X36 | per-line scope | killed 43 |
| X37 | path must start with `/ ? #` | killed 3 |

**Ten survived; three of the ten change no answer at all.** I checked that claim rather than asserting
it, by running a 28-row differential probe through the original and through each survivor:

- **X4** (`tokens.length > TOKENS_MAX`): 0 differing rows. `TOKENS_MAX` is
  `LEADING_GLYPHS_MAX + LABEL_WORDS_MAX + 1 + TRAILING_GLYPHS_MAX`, i.e. exactly the longest line the
  four later checks already admit, so it is a pure early-out. Worth keeping (it is what stops a
  1000-token line being tokenised further), and correct to derive it rather than hard-code it.
- **X14** (`|| at === tokens.length` in the leading check): 0 differing rows. When the line is all
  glyphs, `labelWordsAt` returns 0 (`tokens[at]` is `undefined`) and the very next line returns false.
- **X21** (the `(?=[0-9a-z[])` lookahead in `GLYPHS_IN_FRONT`): 0 differing rows, and it is provably
  redundant: whenever the lookahead fails, the character left at the front is not `[0-9a-z[]`, and
  every host pattern (`DOMAIN`, `LOCALHOST_HOST`, `IPV4`, `SINGLE_LABEL`) requires an alphanumeric
  start and `BRACKETED` requires `[`, which the glyph class excludes. Stripping anyway can therefore
  never turn a non-match into a match. (It *can* turn a match into a non-match through greed - but
  only if the second character is in the glyph class, in which case the original matched two as well.)

The other **seven are genuine**: each changes at least one answer, in the fail-open direction, with no
test noticing.

---

## Part 3 - new findings

### P1 (Important) - the label's "whole words only" is asserted in the comment and in the ruling, and by nothing else

`labelWordsAt` compares `tokens[at + index]?.toLowerCase() === word`. Change that one `===` to
`.includes(word)` and **the whole suite stays green (622/622)**, while these become address lines:

| probe | now | with the mutation |
| --- | --- | --- |
| `cannot secure github.com` | false | **true** |
| `Not securely github.com` | false | **true** |
| `notsecure secure github.com` | false | **true** |

The doc comment says "matched whole-word and case-insensitively"; the *case* half is pinned by 8
tests, the *whole-word* half by none. This is the newest guard in the file, added this round, on the
one rule that by design lets words stand in front of an address - and it is exactly the failure mode
the developer has now confessed twice ("a guard of mine was asserted in a comment before it was
asserted in a test"). Third time.

**Fix:** two rows in the existing closed-list block -
`"cannot secure github.com"`, `"Not securely github.com"` as false. Cost: two lines, no code change.

### P2 (Minor) - every glyph bound is pinned in its spaced form and none of them in its glued form

The suite pins `=========== github.com` and `example.com .....` (with a space). The same runs glued
onto the token go through `GLYPHS_IN_FRONT` and `TAIL`'s trailing class instead, and those bounds are
unpinned - although the doc comment names glued renderings (`•github.com`, `(github.com)`) as the
very reason those two classes exist.

| mutation | probe | now | mutated | suite |
| --- | --- | --- | --- | --- |
| X20 `GLYPHS_IN_FRONT {1,2}` -> `{1,20}` | `===========github.com`, `.........github.com`, `<<<<<<<<<<<127.0.0.1` | false | **true** | 622/622 green |
| X31 `TAIL [^0-9a-z]{0,3}` -> `*` | `github.com.........`, `example.com.............` | false | **true** | 622/622 green |
| X34 `TAIL_REQUIRED [^0-9a-z]{0,3}` -> `*` | `intranet:80.........` | false | **true** | 622/622 green |

**Fix:** three rows - `"===========github.com"`, `"github.com........."`, `"intranet:80........."`
as false, next to their spaced twins.

### P3 (Minor) - three numeric bounds no test pins, and one range check that does not exist

| mutation | probe | now | mutated | suite |
| --- | --- | --- | --- | --- |
| X30 `TAIL` port `[0-9]{1,5}` -> `[0-9]+` | `localhost:123456`, `localhost:1234567890` | false | **true** | green |
| X35 `TAIL_REQUIRED` port `{1,5}` -> `+` | `intranet:123456` | false | **true** | green |
| X26 `BRACKETED {0,45}` -> `{0,4000}` | a 60-colon bracketed literal; a 12-group hex literal | false | **true** | green |

Separately: there is **no port range check at all**, only a digit count, so `localhost:0` and
`localhost:99999` are address lines although neither is a reachable port. That is a fail-open of the
residual-hole kind (it makes `ab:0` and `Q3:0` address lines) and it is not written down anywhere.
The `BRACKETED` comment's second clause - "Bounded, so there is nothing to enumerate" - is also
doing less work than it claims: `[0-9a-f.:]{0,45}\]` is linear at any bound, because the class is a
single bounded greedy run followed by one literal. The 45 is a *semantic* bound only, and the comment
should say so.

**Fix:** three false rows (`"localhost:123456"`, `"intranet:123456"`, a 60-colon bracketed literal);
optionally reject a port outside 1-65535; correct the `BRACKETED` comment's ReDoS claim.

### P4 (Minor) - N1's Unicode awareness stops at the token boundary

`isGlyph` is Unicode-aware, but `GLYPHS_IN_FRONT` (`[^0-9a-z[]`) and `TAIL`/`TAIL_REQUIRED`
(`[^0-9a-z]`) are still ASCII-only, so a non-Latin letter glued to the token is still treated as
punctuation. Measured today, no mutation needed:

| probe | result | spaced twin |
| --- | --- | --- |
| `<1 CJK char>github.com` | **true** | `<2 CJK chars> github.com` false (pinned) |
| `github.com<2 CJK chars>` | **true** | `github.com <2 CJK chars>` false (pinned) |
| `README.md<3 Arabic chars>` | **true** | `README.md <3 Arabic chars>` false (pinned) |

All three are one-token lines, so they sit inside the disclosed residual hole rather than outside it -
which is why this is Minor and not Important. But the comment says the glyph test is Unicode-aware
"on purpose", and half of the glyph handling in this file is not. The repo stages non-English pages
and the ledger records the owner's system language as probably neither English nor Portuguese.

**Fix:** either widen the two character classes to `[^\p{L}\p{N}[]` / `[^\p{L}\p{N}]` (and re-measure
the true table - `¡• 127.0.0.1` and `…` must stay true), or add one sentence saying the glued
classes are deliberately ASCII and why, plus the three rows above as pinned true.

### P5 (Minor) - the label widens the residual hole, and the widening is not in the residual-hole block

Because the label may stand in front of anything that parses as a host, the hole grew this round from
"a one-token line" to "an optional `not secure` plus a one-token line". Measured true and untested:
`Not secure Node.js`, `Not secure README.md`, `Not secure and/or`, `Not secure TCP/IP`,
`not secure index.html …`. The doc comment does say a word admitted to the list "can stand in front
of anything and still leave the line an address line", so this is disclosed in prose - but the
`describe("... the residual hole ...")` block, whose stated job is that the extent "cannot be mistaken
for a pass", does not contain a single one of them.

**Fix:** two rows in the residual-hole block (`"Not secure Node.js"`, `"Not secure and/or"` as true).

### P6 (Important) - `BROWSER_ADDRESS_LABELS` is English-only, and nothing anywhere says so

`["not secure"]` is the string Chrome draws in an **English** UI. Measured: `Nao seguro 192.168.1.20`,
`No es seguro 192.168.1.20`, `Nicht sicher 192.168.1.20` are all **false**. So on a Chrome whose UI
language is not English, N3's fix is inert and the whole http LAN/intranet class - `http://192.168.x.x`
routers, NAS boxes, printers, phones, and `http://wiki` / `http://jira` / `http://grafana` - stays
**permanently unreadable**, which is precisely the state N3 was raised to end.

This matters here more than it would elsewhere: the project ledger records the owner's own system
language as probably neither English nor Portuguese, and the repo already stages non-English pages
(`pt-*` fixtures). It is fail-closed, so it is not a privacy hole - it is the same kind of defect N3
itself was half about: a comment that tells the reader the cost is handled when for this user it may
not be. Nothing in `sites.ts`, in the tests, in `KNOWN_LIMITS` or in the report mentions locale.
(`KNOWN_LIMITS` does carry "In Chrome and Safari it only reads a page while the address is visible.",
which stays true and covers the user-facing half.)

**Fix:** one sentence in the `BROWSER_ADDRESS_LABELS` comment saying the list is locale-bound and that
a non-English Chrome needs its own measured string; a `D-O8-15` amendment; and one more question on
the C-2b observe run - record the exact label string in the owner's own Chrome UI language.

---

## Part 4 - gates, non-regression, performance

**Gates** (private copy `$S/s5/rr/app`, `pnpm` never invoked):

```
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s5/rr/app src/core/exclusions
    -> 5 files, 338 passed (338)                         [report: 338  OK]
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s5/rr/app src/core src/eval
    -> 24 files, 636 passed (636)                        [report: 636  OK]
node $R/app/node_modules/vitest/vitest.mjs run --root $S/s5/rr/app src/core src/eval src/main src/renderer
    -> 58 files, 1306 passed (1306)                      [report: 1306 OK]
node $R/app/node_modules/typescript/bin/tsc --noEmit -p $S/s5/rr/app/tsconfig.json           -> clean
node $R/app/node_modules/typescript/bin/tsc --noEmit -p $S/s5/rr/app/tsconfig.renderer.json  -> clean
```

Every total in the report's table is exact this time (N6's complaint is answered).

**Release-gate fixtures: untouched.** All 15 files under `$R/eval/fixtures/` still dated 2026-09-17,
and `src/eval` is green inside the 636.

**Exactly four files changed**, confirmed from `s5/o8fix2.diff`: `sites.ts`, `sites.test.ts`,
`index.ts`, `index.test.ts`. `copy.ts` untouched.

**Non-regression, byte level.**

- `sites.ts` vs `pre-o8/sites.ts`: **common prefix 925 bytes, common suffix 755 bytes, and the pre-O8
  middle is 0 bytes** - i.e. the new file is the old file with one block inserted and nothing removed
  or edited. The prefix ends at `return [...hosts];}` and the suffix begins at
  `export function hostMatches`, so `SITE`, `HOST`, `parseSites`, **`extractHosts`** are byte-identical
  on one side and `hostMatches`, `titleMentions`, **`siteExcluded`** byte-identical on the other.
- `index.ts` vs `pre-o8/index.ts`: `diff` reports exactly two hunks - one changed import line
  (`showsAddress` added) and one inserted block at line 64. Rule order in `after()` is unchanged and
  re-verified: private marker `:62` -> excluded site `:63` -> no address `:93`, the last one gated on
  `isMeasuredBrowser`.
- `defaults.ts`, `rules.ts`, `rules.test.ts`, `privateWindows.ts`, `privateWindows.test.ts`,
  `malformed.test.ts` are `cmp`-identical to `pre-o8/`.

**Performance still linear.** 100 KB through `after()` end to end, measured with `process.hrtime` in
the private copy:

| shape (100 KB) | `showsAddress` | `after()` |
| --- | --- | --- |
| `"a".repeat(100000)` | 0.010 ms | 0.322 ms |
| `("[" + ":".repeat(300)).repeat(334)` | 0.008 ms | 0.234 ms |
| `"ab.cd ".repeat(17000)` | 0.011 ms | 2.385 ms |
| `"x\n".repeat(50000)` | 1.017 ms | 0.923 ms |
| `"http://" + "a".repeat(100000)` | 0.012 ms | 0.389 ms |
| `"a".repeat(99000) + ":8080"` | 0.021 ms | 0.450 ms |

Worst case 2.4 ms, all of it in the deliberately uncapped `extractHosts`. Removing the line cap cost
nothing measurable, as N2 predicted.

---

## For the owner, in one place

1. **The C-2b observe run now has four questions, not three.** The three the developer lists, plus:
   **what is the exact security-label string in your own Chrome's UI language** (P6). If it is not
   "Not secure", N3's fix does nothing on your machine.
2. **If the observe run shows the `|` separator, take the one-glyph allowance.** Refusing it is the
   right call while it is unmeasured, but the reasoning in the report overstates the risk: `Not secure
   <anything host-like>` is already an address line, so permitting one letterless glyph between the
   label and the address widens the hole by nothing and buys back the whole LAN/intranet class.
3. **The residual hole (N4) is still open and got slightly wider this round** (P5). The file-extension
   and lowercase-host narrowings are still yours to take or refuse; the real fix is still the
   reader-side address row in sub-project C.

---

**Spec compliance: OK** - O8 is "a read of a measured browser whose toolbar strip shows no address is
NOT kept, fail closed". Rule placement, `isMeasuredBrowser` gating, reason choice, rule order,
`extractHosts`/`siteExcluded` byte-level non-regression and the fixture gate all comply. The defect
the decision was made on is closed at every form I could build: the N1 fail-open is gone
(`Translation Available\nNode.js API` is `unknownWindow`), the N2 line cap that silently dropped
Chrome reads is gone, and the N3 class that was permanently unreadable is readable in an English
Chrome. What remains is the residual hole, which is disclosed as a grammar, pinned at its extent and
at its edge, and is a sub-project C change - and P6, which is a fail-closed locale limit, not a
compliance failure.

**Quality: Approved** - with seven unpinned guards to close (P1-P3), two documentation corrections
(P4, P6) and two test rows (P5). None of them changes a line of the rule's behaviour; all of them are
test rows and comments. P1 and P6 are the two I would not merge without: P1 because the code's newest
privacy guard can be deleted in silence, and P6 because the round's headline fix may be inert on the
owner's own machine and nothing anywhere says so.

**Verdict: Approved with reservations.** This round did the hard thing twice - it fixed the fail-open
the previous round introduced, and it deleted a cap the developer had argued for. The disclosure is
better than the code: the report names its own surviving mutation, replaces an invented test case with
a measurement, and pins its unresolved risk as a false case with a comment. The remaining findings are
all of one kind, and it is the kind this file keeps producing: a property stated in a comment before
it is stated in a test. Seven of them are left.
