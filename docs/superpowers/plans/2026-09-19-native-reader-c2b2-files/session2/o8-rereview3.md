# O8 re-review 3 - fix round 3 ("a measured browser with no address on its strip is not kept")

**Verdict: APPROVED WITH RESERVATIONS.**

**Reviewer:** independent re-reviewer, round 3. Did not write the change or any earlier review.
**Date:** 2026-09-21
**Under review:** `app/src/core/exclusions/sites.ts`, `index.ts`, `sites.test.ts`, `index.test.ts` after
fix round 3, against `session2/o8-rereview2.md` (P1-P6, 38 mutations) and the "Fix round 3" section of
`session2/o8-dev-report.md`. Baseline for byte comparison: `session2/pre-o8/exclusions/`.

**Method.** Read-only against the repo; this file is the only thing written under it. Everything ran
in a private copy of `app/` in the session scratch directory (no `node_modules`, `dist`,
`dist-preview`, `native/reader/target`, `reader-eval/out`; `node_modules` symlinked). `pnpm` never ran
against it; vitest and tsc were called directly with node v24.19.0. No git, no `cd`, no app/helper/
reader launch, nothing under the app-support directory opened. Each mutation was applied by a node
script doing an exact string replace that asserts exactly ONE occurrence, then the file was restored
from a pristine byte copy and checked by SHA-256; all 111 restores were identical (110 mutations plus one proposed fix, F3). As I finish, the
four files in the private copy and in the repo are `cmp`-identical to the pristine copy, and the one
probe test file I created in the private copy is deleted. Non-Latin probe text was built from code
points only.

One-paragraph summary: every one of re-review 2's seven genuine survivors is now killed, all 37 of
its still-applicable mutations reproduce, the port range check, the hyphen rule and the Unicode-aware
glued classes all behave as described, non-regression is byte-exact and nothing is slow. But the
report's headline claim - "genuine survivors: ZERO" - does not hold for the code round 3 itself
added: **the hyphen rule is pinned in the `DOMAIN` grammar and at the START of the single label, and
nowhere else** (three genuine survivors), and the Unicode-aware class is pinned for `TAIL` but not
for `TAIL_REQUIRED` (two genuine survivors). Same kind of defect as the last three rounds: stated in
a comment and in the report ("in all three host grammars") before it is stated in a test. One
Important, seven Minor, no Critical. One row of the brief's expected-false list is TRUE by a
deliberate, pinned developer decision (`-github.com`) and needs an owner ruling.

---

## 1. Baseline (private copy)

```
node .../vitest/vitest.mjs run --root <copy> src/core/exclusions   -> 5 files, 391 passed (391)   [report: 391 OK]
node .../typescript/bin/tsc --noEmit -p <copy>/tsconfig.json       -> clean (exit 0)
node .../typescript/bin/tsc --noEmit -p <copy>/tsconfig.renderer.json -> clean (exit 0)
```

Not run by me: the wider gates (`src/core src/eval`, `src/main src/renderer`, 689 / 1359). The brief
scoped this round to `src/core/exclusions`; I make no claim about those totals.

---

## 2. The 38-mutation table of re-review 2, re-run against the CURRENT code

Conditions were re-located by meaning. "killed N" = N of 391 tests fail.

| mut | condition attacked | rr2 | now |
| --- | --- | --- | --- |
| I / X13 | trailing tokens length-checked only | 29 | killed 30 |
| J | 16-line cap put back | 7 | killed 7 |
| L / X17 | label may stand alone | 4 | killed 4 |
| M / X2 | drop truncated-final-line guard | 1 | killed 1 |
| N / X10 | ASCII-only glyph test (`isGlyph`) | 4 | killed 5 |
| B | drop leading glyph LENGTH limit | 4 | killed 4 |
| B2 | drop trailing glyph LENGTH limit | 4 | killed 4 |
| C / X33 | `TAIL_REQUIRED` -> `TAIL` for the single label | 14 | killed 14 |
| E | drop the IPv6 `::`-or-three guard | 3 | killed 3 |
| F | `TAIL` matches anything | 3 | killed 10 |
| G | drop leading glyph COUNT limit | 3 | killed 3 |
| H | drop trailing glyph COUNT limit | 3 | killed 3 |
| A | any token anywhere on a line (developer's wording) | 73/43 | killed 85 |
| D | remove the character cap (no `slice`) | 1 | killed 1 |
| K | widen label (any two words in front of a third token) | 14/2 | killed 8 |
| X1 | cap constant -> 1e9 | 4 | killed 4 |
| X3 | newline exception in the truncation guard | 1 | killed 1 |
| X4 | `TOKENS_MAX` early-out | survived, neutral | **SURVIVED - neutral, proven (below)** |
| X5 | `LEADING_GLYPHS_MAX` 2 -> 6 | 3 | killed 3 |
| X6 | `LEADING_GLYPH_CHARS_MAX` 2 -> 40 | 4 | killed 4 |
| X7 | `TRAILING_GLYPHS_MAX` 3 -> 9 | 3 | killed 3 |
| X8 | `TRAILING_GLYPH_CHARS_MAX` 3 -> 40 | 4 | killed 4 |
| X9 | glyph test: drop the letter/digit half | 31 | killed 32 |
| X11 | glyph test drops the DIGIT half | 2 | killed 2 |
| X12 | glyph test drops the LETTER half | 26 | killed 27 |
| X14 | all-glyph-line early-out | survived, neutral | **SURVIVED - neutral, proven (below)** |
| X15 | label matched whole-word (`===` -> `.includes`) | SURVIVED (P1) | killed 4 |
| X16 | label matched case-insensitively | 8 | killed 12 |
| X18 | label may not repeat | 1 | killed 1 |
| X19 | label list contents (+ "secure") | 2 | killed 2 |
| X20 | glued leading run `{1,2}` -> `{1,20}` | SURVIVED (P2) | killed 8 |
| X21 | glued leading-glyph lookahead | survived, neutral | guard deleted; see 2.2 |
| X22 | scheme allow-list | 1 | killed 1 |
| X23 | `DOMAIN` TLD `{2,}` | 1 | killed 1 |
| X24 | IPv4 octet range | 1 | killed 1 |
| X25 | IPv4 exactly four octets | 2 | fewer: killed 2; more: killed 1 |
| X26 | `BRACKETED` `{0,45}` -> `{0,4000}` | SURVIVED (P3) | killed 2 |
| X27 | IPv6 `::`-or-three rule | 3 | three->two: killed 1; drop `::`: killed 4 |
| X28 | single label's mandatory letter | 2 | killed 2 |
| X29 | single label's 2-character minimum | 5 | killed 5 |
| X30 | `TAIL` port digit bound `{1,5}` -> `+` | SURVIVED (P3) | killed 2 |
| X31 | `TAIL` trailing punctuation `{0,3}` -> `*` | SURVIVED (P2) | killed 2 |
| X32 | `TAIL` end anchor | 3 | killed 10 |
| X34 | `TAIL_REQUIRED` trailing punctuation `{0,3}` -> `*` | SURVIVED (P2) | killed 1 |
| X35 | `TAIL_REQUIRED` port digit bound -> `+` | SURVIVED (P3) | killed 2 |
| X36 | per-line scope (lines joined) | 43 | killed 15 (my join-with-space wording; A above is the strong form, 85) |
| X37 | path must start with `/ ? #` | 3 | killed 10 |

**Developer claims checked against this table:** all seven of re-review 2's genuine survivors are
killed, with exactly the counts the report gives (X15 4, X20 8, X31 2, X34 1, X26 2, X30 2, X35 2).
Every representative count in the report reproduces (A 85, X9 32, I 30, X12 27, C 14, X16 12, J 7,
X1 4, X5-X8 3/4/3/4, X22-X24 1/1/1, X18 1, X2/X3 1/1) except F (report 13, mine 10), X32 (8 vs 10)
and X37 (8 vs 10), which differ only in how the mutation is worded.

### 2.1 X4 and X14: behaviour-neutral - CONFIRMED

Differential fuzz of mutated vs original `showsAddress`, 300 000 generated inputs per run, two
corpora (character-level atoms incl. hyphens, colons, brackets, non-Latin letters and digits built
from code points, newlines; seed-mutation of 17 real strips; and a token-level corpus of 1-12 tokens
drawn from glyph runs of 1-4 characters, label words, addresses and prose so that lines longer than
`TOKENS_MAX` and all-glyph lines occur constantly). Original answers true on 44 591 / 50 844 of them.

- **X4** (`tokens.length > TOKENS_MAX` removed): **0 differences / 600 000.** Argument: a line is
  accepted only as `<=2` glyph tokens + `<=LABEL_WORDS_MAX` label words + 1 address + `<=3` glyph
  tokens, each bound enforced again below; `TOKENS_MAX` is the sum of those four, so it rejects
  nothing they admit.
- **X14** (`|| at === tokens.length` removed): **0 differences / 600 000.** Argument: on an all-glyph
  line `tokens[at]` is `undefined`, `undefined?.toLowerCase() === word` is false, `labelWordsAt`
  returns 0 and the identical check on the next line returns false.

### 2.2 X21 ("deleted because it was NOT neutral"): deletion is right, the stated reason is stale

I re-added the lookahead (`/^[^\p{L}\p{N}[]{1,2}(?=[\p{L}\p{N}[])/u`) as a mutation: the suite stays
green (**391/391**) and the differential fuzz shows **0 differences / 600 000**, including the
developer's own probe: `--.github.com` is **false with and without** the lookahead in the shipped
code. The reason: the measurement in the comment was taken while `DOMAIN` still allowed a label to
start with a hyphen. The hyphen rule added in the same round removed the only way the two could
differ. Proof for the shipped grammar: the glyph class is now the exact complement of `[\p{L}\p{N}[]`;
with a front run of 1 glyph character both forms strip 1; with a run of 2 both strip 2 (or, at end of
string, neither yields a host); with a run of 3 or more, one form leaves a token starting with a
glyph character and the other leaves the whole token starting with one, and EVERY host pattern now
needs `[a-z0-9]` or `[` first, so both answer false.

So: deleting the lookahead is harmless and fail-closed-or-equal, the decision D-O8-19 stands, but the
sentence in `sites.ts` ("with the lookahead ... `--.github.com` matches `DOMAIN` whole - an address
line") is **not true of the code it sits in**, and the pinned row `--.github.com` does not pin the
deletion (it passes either way). Finding F6.

---

## 3. New mutations for what round 3 introduced (61 more; 110 mutations in total, plus one proposed fix run the same way)

| mut | condition | result |
| --- | --- | --- |
| R1 | `PORT_MIN` 1 -> 0 | killed 5 |
| R2 | `PORT_MAX` 65535 -> 65536 | killed 1 |
| R3 | `PORT_MAX` -> 99999 | killed 3 |
| R4 | range check removed | killed 8 |
| R5 | `>=` -> `>` (port 1 refused) | killed 2 |
| R6 | `<=` -> `<` (port 65535 refused) | killed 2 |
| R7 | range not applied through `TAIL_REQUIRED` | killed 6 |
| R8 | range not applied through `TAIL` | killed 5 |
| R9 | upper bound dropped | killed 3 |
| R10 | lower bound dropped | killed 5 |
| R11 | `TAIL` port `{1,5}` -> `{1,6}` | killed 2 |
| R12 | `TAIL_REQUIRED` port `{1,5}` -> `{1,6}` | killed 2 |
| H1 | `DOMAIN` label may START with a hyphen | killed 1 |
| H2 | `DOMAIN` label may END with a hyphen | killed 1 |
| **H3** | **`LOCALHOST_HOST` label may START with a hyphen** | **SURVIVED - genuine (F1)** |
| **H4** | **`LOCALHOST_HOST` label may END with a hyphen** | **SURVIVED - genuine (F1)** |
| H5 | `SINGLE_LABEL` may START with a hyphen | killed 2 |
| **H6** | **`SINGLE_LABEL` may END with a hyphen** | **SURVIVED - genuine (F1)** |
| H7 | `DOMAIN` back to `[a-z0-9-]+` (the developer's own) | killed 2 |
| **H8** | **`LOCALHOST_HOST` back to `[a-z0-9-]+`** | **SURVIVED - genuine (F1)** |
| H9 | `SINGLE_LABEL` back to `[a-z0-9-]+` | killed 2 |
| H10 | `DOMAIN` forbids any hyphen inside a label | killed 2 |
| H11 | `DOMAIN` forbids `--` inside a label (punycode) | killed 1 |
| H12 | `LOCALHOST_HOST` forbids a hyphen inside a label | SURVIVED - neutral, proven (below) |
| **H13** | **`SINGLE_LABEL` forbids a hyphen inside** | **SURVIVED - genuine, fail-closed (F4)** |
| H14 | `LOCALHOST_HOST` label group deleted (`/^localhost/i`) | SURVIVED - neutral, proven (below) |
| U1 | `GLYPHS_IN_FRONT` back to ASCII | killed 2 |
| U2 | `TAIL` punctuation class back to ASCII | killed 2 |
| **U3** | **`TAIL_REQUIRED` punctuation class back to ASCII** | **SURVIVED - genuine (F2)** |
| U4 | `GLYPHS_IN_FRONT` drops the `\p{N}` half | killed 4 |
| U5 | `GLYPHS_IN_FRONT` drops the `\p{L}` half | killed 19 |
| U6 | `TAIL` class drops the `\p{N}` half | killed 4 |
| U7 | `TAIL` class drops the `\p{L}` half | killed 4 |
| U8 | `TAIL_REQUIRED` class drops the `\p{N}` half | killed 4 |
| **U9** | **`TAIL_REQUIRED` class drops the `\p{L}` half** | **SURVIVED - genuine (F2)** |
| U10 | `GLYPHS_IN_FRONT` no longer excludes `[` | killed 5 |
| U11 | `GLYPHS_IN_FRONT` letters ASCII-only, digits Unicode | killed 2 |
| W1 | label `startsWith` | killed 2 |
| W2 | label `endsWith` | killed 1 |
| W3 | label: only the FIRST word compared | killed 1 |
| W4 | label: only the LAST word compared | killed 2 |
| G1 | glued leading run `{1,2}` -> `{1,3}` | killed 5 |
| G2 | glued leading run `{1,2}` -> `{1,1}` | killed 2 |
| **G3** | **`TAIL` punctuation `{0,3}` -> `{0,4}`** | **SURVIVED - genuine (F4)** |
| **G4** | **`TAIL` punctuation `{0,3}` -> `{0,2}`** | **SURVIVED - genuine, fail-closed (F4)** |
| **G5** | **`TAIL_REQUIRED` punctuation `{0,3}` -> `{0,4}`** | **SURVIVED - genuine (F4)** |
| **G6** | **`TAIL_REQUIRED` punctuation `{0,3}` -> `{0,2}`** | **SURVIVED - genuine, fail-closed (F4)** |
| G7 | `LEADING_GLYPHS_MAX` 2 -> 3 | killed 2 |
| **G8** | **`LEADING_GLYPH_CHARS_MAX` 2 -> 3** | **SURVIVED - genuine (F4)** |
| G9 | `TRAILING_GLYPHS_MAX` 3 -> 4 | killed 3 |
| **G10** | **`TRAILING_GLYPH_CHARS_MAX` 3 -> 4** | **SURVIVED - genuine (F4)** |
| **K1** | **`BRACKETED` `{0,45}` -> `{0,46}`** | **SURVIVED - genuine (F4)** |
| K2 | `BRACKETED` `{0,45}` -> `{0,60}` | killed 2 |
| **K3** | **`BRACKETED` `{0,45}` -> `{0,39}`** | **SURVIVED - genuine, fail-closed (F4)** |
| **K4** | **`BRACKETED` character class accepts any character** | **SURVIVED - genuine (F5)** |
| O1 | O8 rule not gated on `isMeasuredBrowser` | killed 1 |
| O2 | O8 rule removed | killed 14 |
| O3 | O8 rule moved FIRST (before the private marker) | killed 3 |
| O4 | O8 rule moved before the excluded-site rule | killed 1 |
| O5 | O8 reason changed | killed 14 |
| O6 | O8 condition inverted | killed 32 |

### Every surviving mutation, with its proof or its probe

| mut | verdict | evidence (orig -> mutated); fuzz = differences over 300 000 inputs |
| --- | --- | --- |
| X4 | neutral | 0 / 600 000 (two corpora) + argument in 2.1 |
| X14 | neutral | 0 / 600 000 + argument in 2.1 |
| X21 re-added | neutral in the shipped code | 0 / 600 000, `--.github.com` false both ways + argument in 2.2 |
| H12 | neutral | 0 / 600 000. Any `label(s).localhost` token is matched by `DOMAIN` with `localhost` as the TLD, and when the tail fits, `DOMAIN`'s match ends at the same place |
| H14 | neutral | 0 / 300 000, suite 391/391. Same argument: the label group of `LOCALHOST_HOST` does no work that `DOMAIN` does not already do |
| H3 | GENUINE, fail-open | `a.-b.localhost` false -> true; `app.-clave.localhost:8765/chat.html?th...` false -> true. fuzz 21 |
| H4 | GENUINE, fail-open | `a-b-.localhost:3000` false -> true. fuzz 104 |
| H8 | GENUINE, fail-open | `a-b-.localhost:3000`, `a.-b.localhost` false -> true. fuzz 128 |
| H6 | GENUINE, fail-open | `wik-/` false -> true; `wiki-:8080` false -> true. fuzz 656 |
| H13 | GENUINE, fail-closed | `my-wiki/`, `dev-box:8080`, `intranet-om:8080` true -> false. fuzz 1410 |
| U3 | GENUINE, fail-open | `intranet:8080<2 CJK>` false -> true; `intranet:8080<1 Cyrillic>` false -> true. fuzz 94 |
| U9 | GENUINE, fail-open | `wiki:127z` false -> true; `intranet:8080A` false -> true. fuzz 162 |
| G3 | GENUINE, fail-open | `github.com....` (four dots) false -> true. fuzz 43 |
| G4 | GENUINE, fail-closed | `github.com...` true -> false. fuzz 186 |
| G5 | GENUINE, fail-open | `intranet:80....` false -> true |
| G6 | GENUINE, fail-closed | `intranet:80...` true -> false |
| G8 | GENUINE, fail-open | `*@: 127.0.0.1` false -> true; `@@@ github.com` false -> true. fuzz 14 |
| G10 | GENUINE, fail-open | `example.com ....` false -> true. fuzz 4 |
| K1 | GENUINE, fail-open | a 46-character bracketed literal (`[` + `1:` x22 + `11]`) false -> true |
| K3 | GENUINE, fail-closed | `[ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255]` (the 45-character literal the bound is named after) true -> false |
| K4 | GENUINE, fail-open | `[a:b:c:word]`, `[12:30:45:PM]`, `[fe80not:1:2:3:4]` false -> true. fuzz 4642 |

**Count: 21 survivors of 110. 5 behaviour-neutral (X4, X14, X21-re-added, H12, H14). 16 genuine:
11 fail-open when mutated, 5 fail-closed when mutated.** None of the 16 is a live defect - the code
answers correctly today - each is a guard a later edit can remove with the suite still green.
The developer's claim "genuine survivors: zero" is true of re-review 2's list and false of round 3's
own code; the claim "two documented neutral ones" is confirmed; the claim "X21 was not neutral" was
true when measured and is not true of the shipped code.

---

## 4. Real addresses and the must-stay-false list - actual results

| input | expected | actual |
| --- | --- | --- |
| `my-app.vercel.app` | true | true |
| `my-app.vercel.app/dashboard` | true | true |
| `xn--bcher-kva.example` | true | true |
| `xn--80ak6aa92e.com` | true | true |
| `a-b-c.localhost:3000` | true | true |
| `sub.my-site.co.uk/path?x=1` | true | true |
| `192.168.1.20:8080` | true | true |
| `[::1]:8080` | true | true |
| `localhost:3000/dashboard` | true | true |
| `github.com/acme/repo` | true | true |
| `@ 127.0.0.1` | true | true |
| `<U+2022> 127.0.0.1` | true | true |
| `<U+00A1><U+2022> 127.0.0.1` | true | true |
| `"@ 127.0.0.1\nC ="` | true | true |
| `app.clave.localhost:8765/chat.html?th...` | true | true |
| `127.0.0.1:57174/chat.html?theme=light&size=14<U+2026>` (a real U+2026) | true | true |
| `Not secure 192.168.1.20` | true | true |
| `@ Not secure 192.168.1.20` | true | true |
| also: `@@ github.com`, `github.com @@@`, `<U+2022>github.com`, `(github.com)`, `example.com <U+2026>`, `https://my-app.vercel.app/x`, `my-wiki/`, `dev-box:8080`, `localhost:1`, `localhost:65535`, `MY-APP.Vercel.App`, `a--b.com`, `my-app.vercel.app:443/x` | true | all true |
| `Translation Available` | false | false |
| `"Translation Available\nNode.js API"` | false | false |
| `---github.com` | false | false |
| **`-github.com`** | **false** | **TRUE - see F7** |
| `github-.com` | false | false |
| `cannot secure github.com` | false | false |
| `Not securely github.com` | false | false |
| `localhost:0` | false | false |
| `localhost:65536` | false | false |
| also: `localhost:99999`, `localhost:000080`, `localhost:00000`, `ab:0`, `Q3:0`, `--.github.com`, `a-.localhost:3000`, `a.-b.localhost`, `wik-/`, `wiki-:8080`, `---wiki/`, `my-app-.vercel.app`, `my-app.-vercel.app`, `my-app.vercel-.app`, `<CJK>github.com`, `github.com<CJK>`, `README.md<Arabic>`, `intranet:8080<CJK>`, `localhost:3000<Arabic-Indic digit>`, `<Cyrillic>localhost:3000`, `wiki:127z`, `===github.com`, `github.com....`, `intranet:80....`, `@@@ github.com`, `github.com @@@@`, `example.com ....`, a 46-colon bracketed literal, `[12:30:45:PM]`, `[a:b:c:word]`, `Not secure \| example.test/login`, `Node.js API`, `github.com 42` | false | all false |
| **`localhost:00080`, `localhost:080`, `intranet:00080`, `ab:080`** | (brief: check) | **TRUE - see F3** |

`after()` (measured through a throw-away test file in the private copy, excluded site `github.com`):

| call | result |
| --- | --- |
| `after({app:"Safari",title:"Accounts"}, "Translation Available\nNode.js API")` | `unknownWindow` |
| same, `app:"Google Chrome"` | `unknownWindow` |
| Safari, `"@ 127.0.0.1"` | `null` (kept) |
| Safari, `"<U+2022> Private"` (private marker, no address) | `privateWindow` - private wins |
| Chrome, `"* Incognito"` | `privateWindow` |
| Safari, title names the excluded site, strip `Translation Available` | `excludedSite` - excluded site wins over no-address |
| Safari, strip `github.com` | `excludedSite` |
| Safari, strip `""` | `unknownWindow` |
| Safari, strip `undefined` | `unknownWindow` |
| `" SAFARI "` (padded, upper case), no address | `unknownWindow` |
| Firefox / Arc / Google Chrome Canary (unmeasured), no address | `null` from `after` (they are refused in `before`, as designed) |
| Slack (not a browser), no address | `null` |

Rule order private -> excluded site -> no address, measured browsers only: **confirmed by behaviour
and pinned by tests** (O3 killed 3, O4 killed 1, O1 killed 1, O2 14, O5 14, O6 32).

---

## 5. Non-regression and performance

**Byte level.** `sites.ts` vs `pre-o8/sites.ts`: common prefix **925** bytes, common suffix **755**
bytes, pre-O8 middle **0** bytes (1680 = 925 + 755). The prefix ends at `return [...hosts];\n}` and
the suffix starts at `export function hostMatches`, so `SITE`, `HOST`, `parseSites`, `extractHosts`
and `hostMatches`, `titleMentions`, `siteExcluded` are byte-identical source text. `index.ts` vs
pre-O8: exactly two hunks (`5c5` the import, `63a64,93` the inserted block). `defaults.ts`,
`rules.ts`, `rules.test.ts`, `privateWindows.ts`, `privateWindows.test.ts`, `malformed.test.ts` are
`cmp`-identical to the snapshot.

**Behaviour.** 20 000 generated strips through pre-O8 and current `extractHosts`, `siteExcluded`
(incl. `undefined` strips), `hostMatches` and `parseSites`: **0 differences**.

**Character hygiene.** Non-ASCII code points in the four files: U+2014, U+2026, U+2022, U+00A1,
U+00B7, U+2192, U+2304, U+00E3. Letters outside the Latin script: **0** in all four. The report's
claim is exact.

**Timing** (mean of 5 runs, `process.hrtime`, ~100 KB each; `after()` on a Chrome front window):

| shape | `showsAddress` | `after()` | `extractHosts` |
| --- | --- | --- | --- |
| `"a"` x100000 | 0.012 ms | 0.745 ms | 0.393 ms |
| `("[" + ":"x300)` x334 | 0.003 | 0.283 | 0.270 |
| `"ab.cd "` x17000 | 0.003 | 1.659 | 1.630 |
| `"x\n"` x50000 | 0.498 | 0.612 | 0.070 |
| `"http://" + "a"` x100000 | 0.004 | 0.369 | 0.268 |
| `"a"` x99000 + `:8080` | 0.007 | 0.311 | 0.266 |
| `"-"` x100000 | 0.003 | 0.349 | 0.338 |
| `a` + `"-"` x100000 + `.com` | 0.007 | 0.125 | 0.076 |
| `"a-"` x50000 | 0.002 | 0.415 | 0.344 |
| `"a-."` x33000 | 0.006 | 0.770 | 0.663 |
| `"a-b."` x25000 + `-` | 0.005 | 0.782 | 0.515 |
| `localhost:` + `"9"` x100000 | 0.019 | 0.333 | 0.252 |
| `wiki:` + `"1"` x100000 | 0.003 | 0.348 | 0.259 |
| `[` + `"1:"` x50000, no `]` | 0.005 | 0.388 | 0.315 |
| 45-char valid bracket + `":"` x100000 | 0.003 | 0.211 | 0.168 |
| `"[::1"` x25000 | 0.005 | 0.199 | 0.159 |
| `"a."` x50000 + `!` | 0.003 | 0.645 | 0.523 |
| 1700 lines of `a-a-...-!` | 0.051 | 0.671 | 0.449 |
| `"not secure "` x9000 | 0.005 | 0.401 | 0.323 |
| `"@ "` x50000 | 0.003 | 0.118 | 0.070 |
| one CJK letter x100000 | 0.010 | 0.203 | 0.166 |

Worst `showsAddress` 0.5 ms, worst `after()` 1.7 ms (all of it the deliberately uncapped
`extractHosts`). The one construct round 3 added that could in principle backtrack is the nested
label group `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+`. I timed single lines filling the 2048 window at
512 / 1024 / 2047 characters: `a-a-...!` 0.0049 / 0.0096 / 0.0171 ms, `a.a....!` 0.0047 / 0.0102 /
0.0152, `a-a.a-a.!` 0.0072 / 0.0088 / 0.0177; bracket, port-digit and trailing-dot runs stay at
0.001-0.003 ms. That is linear (doubling the input doubles the time), and the input is capped at 2048
before any pattern runs. **I could not build a super-linear input.**

---

## 6. Findings

### Critical
None.

### Important

**F1 - the hyphen rule (D-O8-18) is pinned in one grammar and a half out of three.**
The report says the rule holds "in all three host grammars" and that "the mutation back to
`[a-z0-9-]+` fails 2" - that mutation was applied to `DOMAIN` only. Measured:

| mutation | suite | probe (orig -> mutated) |
| --- | --- | --- |
| H8 `LOCALHOST_HOST` back to `[a-z0-9-]+` | 391/391 green | `a-b-.localhost:3000`, `a.-b.localhost` false -> true |
| H3 / H4 `LOCALHOST_HOST` start / end loosened | green / green | same probes |
| H6 `SINGLE_LABEL` may END with a hyphen | green | `wik-/`, `wiki-:8080` false -> true |

The pinned rows `---localhost:3000` and `---wiki/` exercise only the START of `SINGLE_LABEL` (they
never reach `LOCALHOST_HOST`'s label group, because there is no label in front of `localhost`). This
is the newest guard in the file and it is the fourth consecutive round with a guard stated in prose
first. Important rather than Minor only for that reason and because it contradicts the round's
headline claim; the code itself is right.

Fix (pick one, both verified):
- rows, false: `"a-b-.localhost:3000"`, `"a.-b.localhost"`, `"wik-/"`, `"wiki-:8080"`; or
- better for `LOCALHOST_HOST`: **delete its label group** (`/^localhost/i`). Mutation H14 shows this
  is answer-neutral (suite green, 0 / 300 000) because `DOMAIN` already matches every
  `label.localhost` token with `localhost` as the TLD. That removes the unpinned surface instead of
  pinning dead code. `wik-/` and `wiki-:8080` still need their two rows.

### Minor

**F2 - "a token containing any letter or digit is never a glyph" is pinned for `TAIL`, not for
`TAIL_REQUIRED`.** U3 (class back to ASCII) and U9 (class drops `\p{L}`) both leave the suite green:
`intranet:8080<2 CJK>`, `intranet:8080<Cyrillic>` false -> true under U3; `wiki:127z`,
`intranet:8080A` false -> true under U9 - the second is a plain Latin letter glued after a
single-label port, and nothing pins it. Fix: rows, false: `"intranet:8080" + CJK`, `"wiki:127z"`,
`"intranet:8080A"`.

**F3 - a zero-padded port of up to five digits is an address.** `localhost:00080`, `localhost:080`,
`intranet:00080`, `ab:080` are all **true** today. The test comment says "a browser never renders
`:000080`, so refusing it is the fail-closed reading" - the same is true of `:00080`, which is
accepted; only the sixth digit is refused. It slightly widens the residual hole (`ab:080`). Fix: port
pattern `[1-9][0-9]{0,4}` in both tails. Verified in the private copy: suite stays 391/391, and the
differential fuzz shows 115 changed answers, **all fail-closed**, all padded ports. Rows, false:
`"localhost:00080"`, `"localhost:080"`, `"intranet:00080"`. (`localhost:0` is then refused twice;
keep the range check.)

**F4 - every glued/spaced bound is pinned far away and not at its edge.** The suite pins 9-13
character runs; the off-by-one is free in both directions:

| mutation | probe | now | mutated |
| --- | --- | --- | --- |
| G3 `TAIL` `{0,3}` -> `{0,4}` | `github.com....` | false | true |
| G5 `TAIL_REQUIRED` `{0,3}` -> `{0,4}` | `intranet:80....` | false | true |
| G8 `LEADING_GLYPH_CHARS_MAX` 2 -> 3 | `@@@ github.com`, `*@: 127.0.0.1` | false | true |
| G10 `TRAILING_GLYPH_CHARS_MAX` 3 -> 4 | `example.com ....` | false | true |
| K1 `BRACKETED` 45 -> 46 | `[` + `1:` x22 + `11]` | false | true |
| G4 / G6 `{0,3}` -> `{0,2}` | `github.com...`, `intranet:80...` | true | false |
| K3 `BRACKETED` 45 -> 39 | `[ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255]` | true | false |
| H13 no hyphen inside a single label | `my-wiki/`, `dev-box:8080` | true | false |

Fix: the eleven rows above, each beside its far twin. (`@@ github.com` true / `@@@ github.com` false
were MEASURED by re-review 2 and are still not rows.)

**F5 - the `BRACKETED` character class is pinned by nothing.** K4 (`[^\]]{0,45}`) leaves the suite
green: `[a:b:c:word]`, `[12:30:45:PM]`, `[fe80not:1:2:3:4]` false -> true. The existing false rows
(`[abc]`, `[2026-09-21]`, `[09:12:33]`) all fail on the colon count, never on the class. Fix: rows,
false: `"[12:30:45:PM]"`, `"[a:b:c:word]"`.

**F6 - a comment in `sites.ts` states a measurement that is false of the shipped code.** See 2.2.
The `GLYPHS_IN_FRONT` comment says that with the lookahead `--.github.com` "matches `DOMAIN` whole -
an address line". With the hyphen rule landed in the same round it does not; the lookahead is now
exactly neutral and the row `--.github.com` passes with or without it. Fix: one sentence - "measured
BEFORE the hyphen rule; with labels unable to start with a hyphen the lookahead is answer-neutral,
and it stays deleted because it buys nothing". No code change.

**F7 - `-github.com`, `--github.com`, `-wiki/`, `--intranet:8080`, `-a.localhost:3000` are address
lines, by a deliberate and pinned decision; the brief for this review expected `-github.com` false.**
The mechanism is the glued-glyph strip (`{1,2}` characters), the same one that makes
`<U+2022>github.com` and `(github.com)` address lines, so the hyphen rule only bites from the third
hyphen (`---github.com` false). This is NOT new in round 3 and not a new fail-open: it is a one-token
line and sits inside the disclosed residual hole, and the spaced form `- github.com` is true by the
leading-glyph rule anyway. The developer disclosed it (four explicit true rows and a comment). It is
here because the owner's expectation and the pinned behaviour disagree, and that should be settled by
the owner, not by a test row: either accept it (no change), or exclude `-` from `GLYPHS_IN_FRONT`
(cost: a recogniser that reads a leading dash glued to the host loses that read; the measured Safari
renderings use a SPACED glyph, so none of the measured set would be lost - I checked that all nine
measured renderings have a spaced or non-hyphen glyph, I did not run this variant through the suite).

**F8 - pre-existing, not introduced by round 3, recorded because the probes turned them up:**
- bracketed literals have no GROUP-COUNT check, so `[09:12:33:456]` (a clock with milliseconds),
  `[1:2:3:4:5:6:7:8:9:10]` and a 23-group literal are address lines. One-token lines, inside the
  residual hole. Fix if wanted: at most 8 colon-separated groups.
- `github.com-`, `localhost-`, `a.bc-`, `xA.ftp://`, `github.comhttp://` are address lines (host +
  up to three closing marks). Residual hole, no change asked.
- an IDN host that Chrome draws in Unicode (`b<U+00FC>cher.example`) is **false**. Fail-closed and
  coherent - `extractHosts` cannot see such a host either, so it could not be checked against the
  excluded list - but it is a second locale-bound cost next to P6 and nothing mentions it.

### New fail-open / unreasonable fail-closed introduced by round 3?

- **Fail-open:** none found. Every behavioural change in round 3 narrows the grammar (port range,
  label ends, Unicode glued classes, lookahead deleted). 600 000 fuzzed inputs against targeted
  loosenings turned up nothing the shipped code accepts that round 2 refused.
- **Fail-closed of a real address:** none found. Hyphenated hosts (`my-app.vercel.app`,
  `sub.my-site.co.uk`, `a-b-c.localhost:3000`, `my-wiki/`, `dev-box:8080`), punycode with `--`
  inside, upper-case hosts, ports 1 and 65535, `:443/path`, and all nine measured renderings are
  true. What is newly refused - a label starting or ending with a hyphen, port 0, ports above 65535 -
  is not a thing a browser draws.

---

## 7. What I could not or did not run

- The wider test gates (`src/core src/eval`, `src/main`, `src/renderer`) and the release-gate fixture
  check: not run; out of the brief's scope. The report's 689 / 1359 totals are unverified by me.
- Nothing that reads a screen, no app/helper/`reader:eval` launch - so every "measured rendering" is
  taken from `o8-rereview2.md` Part 1 and the ledger, not re-measured.
- The F7 variant (exclude `-` from `GLYPHS_IN_FRONT`) was reasoned about, not run through the suite.
- The round-2 code was not available to me as a runnable module, so "not introduced by round 3" for
  F7/F8 rests on reading the round-2 patterns quoted in `o8-rereview2.md`, not on a differential run.

---

**Spec compliance: OK.** O8 - a read of a measured browser whose strip shows no address line is not
kept, fail closed - holds at every form I could build; rule order, gating, reason and non-regression
all comply.

**Quality: approved with reservations.** Round 3 closed everything it was asked to close and found a
real fail-open of its own (`---github.com`). What is left is one kind of thing again: 16 guards with
no test (F1, F2, F4, F5), about twenty rows and optionally two one-line simplifications
(`LOCALHOST_HOST` -> `/^localhost/i`, port -> `[1-9][0-9]{0,4}`), one stale comment (F6), and one
owner ruling (F7). F1 is the one I would not merge without.
