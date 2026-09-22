# O8 fix round 4 - independent re-check

**Verdict: ALL ADDRESSED.** No Critical, no Important. Four Minor findings, all in code round 4 did
NOT touch (pre-existing unpinned guards my own hunt turned up), plus two comment nits.

**Reviewer:** independent; wrote neither the change nor any earlier review. **Date:** 2026-09-21.
**Under review:** `app/src/core/exclusions/sites.ts` (sha256 a3aa2582...026a79) and `sites.test.ts`
(c27cd936...0df2) as installed in the repo, against `session2/o8-rereview3.md` and
`session3/o8-fix4-dev-report.md`. Round-3 baseline: `session3/pre-fix4/` (31ba278c... / 5556dbb8...).
Both installed hashes equal the ones the developer reported.

**Method.** Read-only against the repo; this file is the only thing written under it. Private copy of
`app/` in the session scratch dir (rsync without `node_modules`, `dist`, `dist-preview`,
`native/reader/target`, `reader-eval/out`; `node_modules` symlinked). No git, no `cd`, no pnpm, no
install, no app/helper/reader launch. vitest and tsc called directly with node v24.19.0. Each
mutation: node script, exact string replace asserting exactly ONE occurrence, vitest JSON reporter on
`src/core/exclusions`, restore from the pristine byte copy, sha256 checked after every one (54 of 54
restores identical). Differential runs import round 3, round 4 and the mutated variants side by side
as separate module files. Non-Latin probe characters built with `String.fromCodePoint` only. At the
end the copy and the repo files are sha256-identical to pristine.

---

## 1. Diff round 3 -> round 4 of sites.ts

`diff` shows five hunks: the X21 paragraph (comment), the `TAIL` doc comment + `TAIL` pattern, the
`TAIL_REQUIRED` pattern, the added range/pattern overlap paragraph (comment), the F7 sentence
(comment). With all comments stripped the two files have 99 code lines each and exactly TWO differ:

```
- const TAIL = /^(?::([0-9]{1,5}))?(?:[/?#]\S*)?[^\p{L}\p{N}]{0,3}$/u;
+ const TAIL = /^(?::([1-9][0-9]{0,4}))?(?:[/?#]\S*)?[^\p{L}\p{N}]{0,3}$/u;
- const TAIL_REQUIRED = /^(?::([0-9]{1,5})(?:[/?#]\S*)?|[/?#]\S*)[^\p{L}\p{N}]{0,3}$/u;
+ const TAIL_REQUIRED = /^(?::([1-9][0-9]{0,4})(?:[/?#]\S*)?|[/?#]\S*)[^\p{L}\p{N}]{0,3}$/u;
```

Byte level: common prefix 6532 bytes, common suffix 2501 bytes. `extractHosts` ends at byte 924
(inside the prefix); `hostMatches` .. EOF starts at 20434, the suffix starts at 18688 - so `SITE`,
`HOST`, `parseSites`, `extractHosts`, `hostMatches`, `titleMentions`, `siteExcluded` are
byte-identical. Non-ASCII census of both files matches the developer's claim (sites.ts: U+2014,
U+2026, U+2022, U+00A1, U+00B7; test: U+2014, U+2022, U+00A1, U+2026, U+2304; no letter outside
Latin, no control character but LF).

Test file: 115 lines added; the only lines REMOVED are the old 3-row padded-port block and its
comment (replaced by the 15-row block) and one header comment line that was extended. No existing
row was dropped or weakened.

**Differential fuzz, round 3 vs round 4 `showsAddress`** (every input also run through both
`extractHosts` and `siteExcluded`: 0 differences, 900 000 inputs):

| corpus | N | r4 true | newly TRUE | newly false | newly false that is not a zero-padded port |
| --- | --- | --- | --- | --- | --- |
| port-shaped (lead x host x `:`digits/edge ports x tail x trailing/2nd line) | 300 000 | 32 993 | **0** | 11 514 | **0** |
| character atoms | 300 000 | 14 942 | **0** | 33 | **0** |
| seed mutation of 12 real strips | 300 000 | 82 666 | **0** | 1 043 | **0** |
| strict per-line run (below) | 400 000 | - | **0** | 80 063 | **0** |

The strict run classifies per LINE: every line round 3 accepted and round 4 refuses must carry a port
token `0` + 1-4 digits, and removing the padding must make round 4 accept it again. 80 063 of 80 063
pass. That corpus held 74 070 ports of six or more digits with a non-zero lead and 51 004 all-zero
ports, so the upper and lower edges were exercised, not just the middle.

**Exhaustive sweep:** `host:p` for p = 0..70000 through `localhost`, `example.com`, `127.0.0.1`,
`[::1]`, `intranet`, plus `0p` and `00p` for p = 0..9999: 450 005 strings, round 4 is true exactly
when the port is canonical and in 1..65535. **0 mismatches.**

Claim "the only behavioural change is the port group, narrowing only": **CONFIRMED.**

---

## 2. The 16 genuine survivors of re-review 3, re-applied (failing tests out of 505)

| mut | condition | rr3 | now | killing rows (first) |
| --- | --- | --- | --- | --- |
| H3 | `LOCALHOST_HOST` label may START with a hyphen | survived | **killed 3** | `a.-b.localhost`, `a.-b.localhost:3000`, `app.-clave.localhost:8765/...` |
| H4 | `LOCALHOST_HOST` label may END with a hyphen | survived | **killed 4** | `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost` |
| H8 | `LOCALHOST_HOST` back to `[a-z0-9-]+` | survived | **killed 7** | same block |
| H6 | `SINGLE_LABEL` may END with a hyphen | survived | **killed 5** | `wik-/`, `wiki-/x`, `wiki-:8080` |
| H13 | `SINGLE_LABEL` forbids a hyphen inside | survived | **killed 4** | `my-wiki/`, `dev-box:8080`, `intranet-om:8080` |
| U3 | `TAIL_REQUIRED` class back to ASCII | survived | **killed 6** | `intranet:8080` + CJK / Cyrillic / Arabic-Indic digit |
| U9 | `TAIL_REQUIRED` class drops `\p{L}` | survived | **killed 9** | + `wiki:127z`, `intranet:8080A` |
| G3 | `TAIL` `{0,3}` -> `{0,4}` | survived | **killed 4** | `github.com....`, `localhost:3000....`, `127.0.0.1....` |
| G4 | `TAIL` `{0,3}` -> `{0,2}` | survived | **killed 3** | `github.com...`, `127.0.0.1...`, `[::1]...` |
| G5 | `TAIL_REQUIRED` `{0,3}` -> `{0,4}` | survived | **killed 3** | `localhost:3000....`, `intranet:80....`, `intranet:8080.,).` |
| G6 | `TAIL_REQUIRED` `{0,3}` -> `{0,2}` | survived | **killed 2** | `intranet:80...`, `intranet:8080.,)` |
| G8 | `LEADING_GLYPH_CHARS_MAX` 2 -> 3 | survived | **killed 3** | `@@@ github.com`, `*@: 127.0.0.1`, `@@ @@@ github.com` |
| G10 | `TRAILING_GLYPH_CHARS_MAX` 3 -> 4 | survived | **killed 3** | `github.com @@@@`, `example.com ....` |
| K1 | `BRACKETED` 45 -> 46 | survived | **killed 1** | the 45-character-bound test |
| K3 | `BRACKETED` 45 -> 39 | survived | **killed 1** | the 45-character-bound test |
| K4 | `BRACKETED` class accepts anything | survived | **killed 5** | `[12:30:45:PM]`, `[a:b:c:word]`, `[fe80not:1:2:3:4]` |

**16 of 16 killed**, with the developer's exact counts.

### The six that became behaviour-neutral (R1, R10, R11, R12, X30, X35)

All six leave the suite green (505/505), as the developer says. Differential vs round 4:

| mut | change | port-shaped 300k | atoms 300k | seed-mutation 300k |
| --- | --- | --- | --- | --- |
| R1 | `PORT_MIN` 1 -> 0 | 0 | 0 | 0 |
| R10 | lower bound dropped | 0 | 0 | 0 |
| R11 | `TAIL` `[0-9]{0,4}` -> `{0,5}` | 0 | 0 | 0 |
| R12 | `TAIL_REQUIRED` same | 0 | 0 | 0 |
| X30 | `TAIL` `[0-9]{0,4}` -> `*` | 0 | 0 | 0 |
| X35 | `TAIL_REQUIRED` same | 0 | 0 | 0 |

The corpus is sensitive: the same 900 000 inputs show 9 557 differences for "lead digit `[0-9]`"
(F01) and the edge-port list contains `0`, `65536`, `99999`, `100000`, `655350`, `1` + thirty zeros
and four hundred nines.

Proof, independent of the fuzz:
- **R1 / R10.** A captured port matches `[1-9][0-9]*`-shaped text, so `Number(port) >= 1` always;
  the lower comparison can never be false.
- **R11 / R12 / X30 / X35.** Whatever follows the port group in either tail is a path starting
  `[/?#]`, or the closing-mark class `[^\p{L}\p{N}]`, or end of token - none can consume an ASCII
  digit. So in a successful match the port group holds the WHOLE maximal digit run after the colon.
  For runs of 1-5 digits the mutated and original patterns capture the same text. For a run of 6 or
  more with a non-zero lead the original fails to match and the mutated one captures a value
  >= 100000 (or `Infinity` for an absurd run; `Number` is monotone), which the untouched upper bound
  refuses. Same answer in every case.

**Is leaving them unpinned acceptable? YES.** No input can distinguish them, so no row can pin them;
the overlap is a direct consequence of the ruling (narrow the pattern AND keep the range); it is
written down in the source; and the thing that matters - that BOTH halves of a pair cannot vanish
together - is pinned: I removed both halves of each pair as single mutations and each is killed
(F21 upper pair: killed 6; F22 / F23 lower pair through `TAIL` / `TAIL_REQUIRED`: killed 11 / 12).

---

## 3. My own mutations (32 fresh; 54 in total with section 2)

| mut | condition | result |
| --- | --- | --- |
| F01 | `TAIL` lead `[1-9]` -> `[0-9]` | killed 8 |
| F02 | `TAIL_REQUIRED` lead `[1-9]` -> `[0-9]` | killed 8 |
| F03 | `TAIL` lead digit optional (`[1-9]?`) | killed 7 |
| F04 | `TAIL_REQUIRED` lead digit optional | killed 6 |
| F05 | `TAIL` `{0,4}` -> `{0,3}` | killed 3 |
| F06 | `TAIL_REQUIRED` `{0,4}` -> `{0,3}` | killed 2 |
| F07 | `TAIL` lead `[2-9]` | killed 2 |
| F08 | `TAIL_REQUIRED` lead `[2-9]` | killed 2 |
| F09 | `TAIL` lead `[1-8]` | killed 3 |
| F10 | `TAIL_REQUIRED` lead `[1-8]` | killed 2 |
| F11 | `TAIL` later digits `[1-9]` (no zero inside a port) | killed 19 |
| F12 | `TAIL_REQUIRED` later digits `[1-9]` | killed 12 |
| F13 | `TAIL` `0*` allowed in front (padding back, value still ranged) | killed 10 |
| F14 | `TAIL_REQUIRED` same | killed 10 |
| F15 | `PORT_MAX` 65535 -> 65534 | killed 5 |
| F16 | `PORT_MAX` -> 65536 | killed 3 |
| F17 | `PORT_MIN` 1 -> 2 | killed 4 |
| F18 | range `&&` -> `\|\|` | killed 5 |
| F19 | `TAIL` port group non-capturing (range silently skipped) | killed 4 |
| F20 | `TAIL_REQUIRED` port group non-capturing | killed 3 |
| F21 | `TAIL` `{0,5}` AND `PORT_MAX` 999999 (both halves of the upper pair) | killed 6 |
| F22 | `TAIL` lead `[0-9]` AND `PORT_MIN` 0 (both halves of the lower pair) | killed 11 |
| F23 | `TAIL_REQUIRED` lead `[0-9]` AND `PORT_MIN` 0 | killed 12 |
| F24 | IPv4 FIRST octet `25[0-5]` -> `25[0-9]` | killed 1 |
| **F25** | **IPv4 LATER octets `25[0-5]` -> `25[0-9]`** | **SURVIVED - genuine (M1)** |
| **F26** | **IPv4 FIRST octet may have a leading zero (`[0-9]?[0-9]`)** | **SURVIVED - genuine (M1)** |
| **F27** | **IPv4 LATER octets may have a leading zero** | **SURVIVED - genuine (M1)** |
| F28 | `DOMAIN` TLD may hold digits | killed 1 |
| F29 | `LOCALHOST_HOST` removed from the host list | killed 1 |
| **F30** | **glyph strip and scheme strip swapped in `isAddressToken`** | **SURVIVED - genuine (M2)** |
| F31 | port taken modulo 65536 | killed 2 |
| F32 | `TAIL` path may start with `:` | killed 20 |

**Round 4's new code (F01-F23): 23 of 23 killed. Zero survivors in anything round 4 wrote.**

### Survivors with probes

| mut | class | probe (round 4 -> mutated); fuzz = differences / 300 000 per corpus |
| --- | --- | --- |
| R1, R10, R11, R12, X30, X35 | neutral, PROVED (section 2) | 0 / 900 000 each |
| F25 | GENUINE, fail-open when mutated, pre-existing | `1.2.3.256` false -> true; `10.0.0.256:80` false -> true. fuzz 1724 / 0 / 2079 |
| F26 | GENUINE, fail-open when mutated, pre-existing | `01.2.3.4` false -> true; `@ 01.2.3.4:80` false -> true. fuzz 1722 / 0 / 23 |
| F27 | GENUINE, fail-open when mutated, pre-existing | `1.2.3.04` false -> true; `@ 127.0.01.1` false -> true; `1.2.3.00` false -> true. fuzz 1831 / 0 / 191 |
| F30 | GENUINE, both directions, pre-existing | `(https://github.com)` true -> false; `(http://github.com)` true -> false; `https://` + U+2026 + `wiki#:` false -> true. fuzz 6064 / 365 / 5026 |

None is a live defect - round 4 answers all those probes correctly - and none is in a line round 4
changed. The code today: `1.2.3.256`, `01.2.3.4`, `1.2.3.04` false; `(https://github.com)` true.

---

## 4. Must-be-true / must-be-false lists (round 4, actual)

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
| `"@ 127.0.0.1\nC ="` | true | true |
| `app.clave.localhost:8765/chat.html?th...` | true | true |
| `127.0.0.1:57174/chat.html?theme=light&size=14` + U+2026 | true | true |
| `Not secure 192.168.1.20` | true | true |
| `@ Not secure 192.168.1.20` | true | true |
| `clave-eval.test:51234/toolbar.html` | true | true |
| `Not secure clave-eval.test:51234/x` | true | true |
| also `localhost:1`, `:9`, `:10`, `:100`, `:10000`, `:60000`, `:65535`, `intranet:1`, `intranet:65535`, `intranet:100/x`, `[::1]:1`, `example.com:443/x`, `localhost:3000` + U+2026, `-github.com`, `--github.com` (F7, accepted) | true | all true |
| `Translation Available` | false | false |
| `"Translation Available\nNode.js API"` | false | false |
| `---github.com` | false | false |
| `github-.com` | false | false |
| `cannot secure github.com` | false | false |
| `localhost:0` | false | false |
| `localhost:65536` | false | false |
| `localhost:080` | false | false (round 3: true) |
| also `localhost:00080`, `:08`, `:00000`, `:000080`, `:99999`, `:100000`, `intranet:080`, `ab:080`, `ab:0`, `Q3:0`, `[::1]:0`, `[::1]:080`, `127.0.0.1:0`, `127.0.0.1:01`, `Not secure 192.168.1.20:080`, `localhost:0x50`, `:+80`, `:-80`, `:8 0`, `:80:80`, `:1e3`, `localhost:/x`, `intranet:`, `localhost:0/x`, `wiki:0/x`, `09:12`, `10:30` | false | all false |

**Every row of the brief's two lists is as expected. No unexpected row.**

One row of MY OWN extra list came out other than I guessed: **`localhost:` (host + bare colon) is
true** - in round 3 as well, so it is not a round-4 change. The colon is taken as one of the "up to
three closing marks", the same mechanism re-review 3 F8 already recorded for `github.com-` and
`localhost-`. One-token line, inside the disclosed residual hole, no change asked (M4).

---

## 5. Comment honesty

| comment | true of the code? |
| --- | --- |
| Corrected X21 paragraph (`GLYPHS_IN_FRONT`) | **True.** All five host patterns need `[a-z0-9]` or `[` first. I re-added the lookahead: 0 differences / 300 000, `--.github.com` false with and without. F6 is fixed. |
| F7 sentence (residual-hole block) | **True.** `-github.com`, `--github.com` true; `---github.com` false. Nit: "one or two punctuation marks" has one exception the sentence does not name - `[` is excluded from the class, so `[github.com` is false (the comment above `GLYPHS_IN_FRONT` does say so). |
| `TAIL` doc block | **True.** `[0-9]{1,5}` did accept `:080` / `:00080` (round 3 measured true above); the lead-digit pattern is written in both tails. |
| Range/pattern overlap paragraph | **True**, each clause checked: port 0 no longer parses (R1/R10 neutral); the upper bound is the only thing refusing 65536-99999 (R9-equivalents killed, F16 killed 3); the five-digit limit is redundant given the upper bound (R11/R12/X30/X35 neutral). |
| First paragraph of the same block ("Without this `localhost:0` ... were address lines") | Half stale: without the range check `localhost:0`, `ab:0`, `Q3:0` are NOW still refused by the pattern; only the `99999` half is still literally true. The paragraph that follows corrects it, so a reader is not misled. Nit (M3). |
| New test comment over the padded-port rows | True. |

---

## 6. Tests, typecheck, timing (private copy)

```
vitest run --root <copy> src/core/exclusions  -> 5 files, 505 passed (505)
tsc --noEmit -p <copy>/tsconfig.json          -> clean (exit 0)
```

Timing of `showsAddress`, median of 7 after a warm-up, ~100 KB inputs:

| shape | ms |
| --- | --- |
| `a` x100000 | 0.0004 |
| `localhost:` + `9` x100000 / + `0` x100000 | 0.0004 / 0.0003 |
| `wiki:` + `1` x100000 / + `0` x100000 | 0.0003 / 0.0003 |
| `:` x100000; `a:` x50000; `a:1` x33000; `ab:10:` x16000 | 0.0003 each |
| `localhost` + `:1` x50000 | 0.0003 |
| `[::1]:` + `9` x100000; `127.0.0.1:` + `10` x50000; `[` + `1:` x50000 | 0.0003-0.0004 |
| 8000 lines `ab:0123456789` | 0.052 |
| 6000 lines `localhost:1000000` | 0.055 |
| one 2047-character line `ab:1010...` (fills the window) | 0.0011 |
| `x\n` x50000 | 0.21 |

Worst 0.21 ms. The new port group is a one-character class plus a shorter bounded run; it adds no
backtracking and I could not build a slow input.

---

## 7. Findings

### Critical
None.

### Important
None.

### Minor (all pre-existing, none in a line round 4 changed)

**M1 - the IPv4 octet grammar is pinned for the FIRST octet's range only.** F25, F26, F27 survive.
The one existing row (`256.1.1.1`) kills F24 only. Probes, all false today and true under mutation:
`1.2.3.256`, `10.0.0.256:80`, `01.2.3.4`, `1.2.3.04`, `127.0.01.1`. Fix: those five rows, false.

**M2 - the ORDER glyph-strip-then-scheme-strip is pinned by nothing.** F30 survives. `(https://github.com)`
and `(http://github.com)` are true today and false when swapped; `https://` + U+2026 + `wiki#:` is
false today and true when swapped. Fix: rows `(https://github.com)` true and one scheme-then-glyph
row false (build the glyph from a code point).

**M3 - comment nit.** First paragraph of the `PORT_MIN` block is half stale (section 5). One clause:
"... `localhost:0` was too, until the port pattern refused a leading zero".

**M4 - recorded only.** `localhost:` (and by the same rule `github.com:`) is an address line: host
plus a closing mark. Round 3 identical; same family as re-review 3 F8. No change asked.

### New fail-open / unreasonable fail-closed introduced by round 4?
- **Fail-open: none.** 0 newly-true over 1 300 000 differential inputs; the change is a strict
  narrowing of one capture group.
- **Fail-closed of a real address: none.** What is newly refused is a port written with a leading
  zero, which no browser draws. The exhaustive sweep shows every canonical port 1..65535 is accepted
  through all four host grammars plus the single label.

---

## 8. Developer claims, checked

| claim | result |
| --- | --- |
| only the two port groups changed; rest is comments | confirmed (2 code lines of 99) |
| `extractHosts` / `siteExcluded` byte-identical, 0 behavioural differences | confirmed (bytes + 900 000 inputs) |
| round 3 -> 4: newly true 0, every newly false a padded port | confirmed (1 300 000 inputs, per-line strict check) |
| all 16 genuine survivors killed, with those counts | confirmed, counts identical |
| R1, R10, R11, R12, X30, X35 now neutral | confirmed by proof and 0 / 900 000 each |
| dropping BOTH halves of a pair is caught | confirmed (F21 6, F22 11, F23 12) |
| 505 / 505, tsc clean | confirmed for `src/core/exclusions` and `tsconfig.json` |
| "genuine survivors: zero" | true of re-review 3's list and of round 4's own code; my hunt found 4 genuine survivors in OLDER, untouched code (M1, M2) |

## 9. Not run
The whole-suite total (2828) and `tsconfig.renderer.json`; anything that reads a screen; any app,
helper or `reader:eval` launch. Measured renderings are taken from re-review 3 section 4, not
re-measured.
