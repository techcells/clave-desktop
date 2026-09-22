# O8 fix round 4 - developer report

Date: 2026-09-21. Answers `session2/o8-rereview3.md` under the controller's ruling (F1 rows and keep
the code; pin every genuine survivor; F3 port pattern `[1-9][0-9]{0,4}`; F6 comment; F7 accepted).

## Method

Nothing under the repo's `app/` was edited. All work is in a private copy:

    /private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/968041bc-02a0-4da7-9b7a-22bc3d9d97fd/scratchpad/fix4/app

(rsync of `app/` without `node_modules`, `dist`, `dist-preview`, `native/reader/target`,
`reader-eval/out`; `node_modules` symlinked to the repo's). Two more read-only symlinks sit beside
the copy, `fix4/eval` and `fix4/docs`, pointing at the repo's `eval/` and `docs/`, because
`src/eval/*`, `src/core/eval.test.ts` and `src/renderer/model/views.test.ts` read `../eval/fixtures`
and `../docs/*.md` relative to `app/`; without them 17 unrelated tests fail with ENOENT. No git, no
`cd`, no pnpm, no install, no app/helper/reader launch. vitest and tsc were called directly with
node v24.19.0. Edits were made by node scripts that assert each anchor occurs exactly once
(`fix4/tools/`), with ASCII-only new text; every non-Latin test character is built with
`String.fromCodePoint`.

## Changed files (relative to app/)

| file | sha256 in the copy | sha256 in the repo (unchanged, round 3) |
| --- | --- | --- |
| src/core/exclusions/sites.ts | a3aa25821654bd846e8e39e1e3178b12b9022666cf24887fcd6e956aeb026a79 | 31ba278c751c9cd7b8b71f7262688cc9776afafe49dfa210f580421838008346 |
| src/core/exclusions/sites.test.ts | c27cd936212252c6f772477e9dda4fef0720294e34930700701a193f049f0df2 | 5556dbb82d413fb2fe72c67bf74e952461e676b7a08c85e1c0e10f87db903d96 |

Every other file under `src/core/exclusions` (`defaults.ts`, `index.ts`, `index.test.ts`,
`malformed.test.ts`, `privateWindows.ts`, `privateWindows.test.ts`, `rules.ts`, `rules.test.ts`) is
`cmp`-identical to the repo. `index.ts` / `index.test.ts` did not need a change.

Inside `sites.ts` the first 925 bytes (`SITE`, `HOST`, `parseSites`, `extractHosts`) and the last 755
bytes (`hostMatches`, `titleMentions`, `siteExcluded`) are byte-identical to round 3, which the
review showed byte-identical to pre-O8. 20 000 generated strips through round-3 and current
`extractHosts` / `siteExcluded`: 0 differences.

Byte check of both changed files: no control character other than LF; no literal `\uXXXX` escapes;
0 letters outside the Latin script; the non-ASCII code points are the same set as in round 3
(U+2014, U+2026, U+2022, U+00A1, U+00B7 in `sites.ts`; U+2014, U+2022, U+00A1, U+2026, U+2304 in the
test file) with identical counts except U+2014, one FEWER in each file (it sat in the two comments
that were rewritten in ASCII). Nothing was added outside ASCII.

### Code changes in sites.ts (exhaustive)

1. `TAIL` and `TAIL_REQUIRED`: port `([0-9]{1,5})` -> `([1-9][0-9]{0,4})`. Narrowing only. The range
   check (`PORT_MIN`, `PORT_MAX`, `tailFits`) is untouched. The one-line doc comment on `TAIL` became a
   block that states the lead-digit rule; the range comment gained a paragraph that says the two
   guards now overlap and which half of each is redundant.
2. F6: the `GLYPHS_IN_FRONT` paragraph about the deleted lookahead now says what is true of the
   shipped code: measured before the hyphen rule, answer-neutral since, stays deleted.
3. F7: the residual-hole block gained one sentence: `-github.com` / `--github.com` are address lines
   by the glued-glyph strip, `---github.com` is refused, accepted by the owner's ruling.

No pattern other than the two port groups changed. `LOCALHOST_HOST` keeps its label group.

Differential run round 3 vs now, 300 000 port-shaped inputs (host + `:` + 0-7 digits weighted to
zeros + tail): newly true 0; newly false 43 828; newly false that are NOT a zero-padded port: 0.
All 37 true rows and 45 false rows of the review's section 4 (measured renderings, real addresses,
must-stay-false list, and the four F3 strings now false) were re-checked by script: 0 wrong.

## Tests added (sites.test.ts: 391 -> 505 in src/core/exclusions, +114)

Tests were written FIRST and run against the round-3 code: exactly the 12 new F3 rows failed (the
padded ports), every other new row passed, as expected for guards that were right but unpinned. After
the pattern change: 505/505.

| block (test title) | rows | answers |
| --- | --- | --- |
| "a padded port is not a port" (was 3 rows) | 15: `localhost:000080`, `intranet:000080`, `127.0.0.1:000080`, `localhost:00080`, `localhost:080`, `localhost:08`, `localhost:080/x`, `example.com:080`, `a.localhost:080`, `127.0.0.1:080`, `[::1]:080`, `intranet:00080`, `intranet:080`, `ab:080`, `wiki:080/x` | F3 |
| "an unpadded port of one to five digits is a port" | 21 true: `localhost:1/80/10000/65535/9/9000/99`, `127.0.0.1:9090/80/65535`, `example.com:9/10000/80`, `[::1]:9000/80`, `intranet:1/80/10000/65535/9/9000` | F3, own-code guards |
| "and the range is checked through every grammar" | `intranet:65536`, `[::1]:65536`, `[::1]:0` false | F3 |
| "the hyphen rule holds in every host grammar and at every position" | 16 false: `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost`, `a.-b.localhost`, `a.-b.localhost:3000`, `a-.b.localhost`, `app.-clave.localhost:8765/chat.html?th...`, `wik-/`, `wiki-/x`, `wiki-:8080`, `my-wiki-:8080`, `my-wiki-/`, `my-app-.vercel.app`, `my-app.-vercel.app`, `my-app.vercel-.app`, `a.b-.com` | F1 (H3, H4, H6, H8) |
| "a hyphen INSIDE a label is an ordinary host character" | 13 true incl. `my-wiki/`, `dev-box:8080`, `intranet-om:8080`, `a--b/`, `a-b-c.localhost:3000`, `my-app.vercel.app`, `xn--bcher-kva.example` | H13 |
| "nothing with a letter or digit may be glued after a single-label port" | 8 false: `intranet:8080<CJK>`, `intranet:8080<Cyrillic>`, `intranet:8080<Arabic-Indic digit>`, `wiki/x <CJK>`, `wiki:127z`, `intranet:8080A`, `intranet:80x.`, `intranet:8080.A` | F2 (U3, U9) |
| "nor after any other port" | 5 false | U2/U7 companions |
| "the last value each glyph bound accepts" | 15 true: `github.com...`, `localhost:3000...`, `127.0.0.1...`, `[::1]...`, `github.com/acme...`, `intranet:80...`, `intranet:8080.,)`, `@@ github.com`, `*@ 127.0.0.1`, `@@ @@ github.com`, `github.com @@@`, `example.com ...`, `github.com @@@ ... ---`, `((github.com`, `==127.0.0.1` | G4, G6 + edges |
| "and the first value it refuses" | 14 false: `github.com....`, `localhost:3000....`, `127.0.0.1....`, `[::1]....`, `intranet:80....`, `intranet:8080.,).`, `@@@ github.com`, `*@: 127.0.0.1`, `@@ @@@ github.com`, `github.com @@@@`, `example.com ....`, `github.com @@@ .... ---`, `(((github.com`, `===127.0.0.1` | G3, G5, G8, G10 |
| "the bracketed literal is bounded at exactly 45 characters" | one test: the 45-character `[ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255]` true (also with `:8080/x`), `[` + `1:` x22 + `1]` (45) true, `[` + `1:` x22 + `11]` (46) false, lengths asserted | K1, K3 |
| "a bracketed literal holds hex digits, dots and colons only" | 6 false: `[12:30:45:PM]`, `[a:b:c:word]`, `[fe80not:1:2:3:4]`, `[::1 x]`, `[::g]`, `[1:2:3:-]` | K4 / F5 |

Two constants were added to the test file, `CYRILLIC` (U+0436) and `ARABIC_INDIC_DIGIT` (U+0663),
both by `String.fromCodePoint`. The comment over the padded-port rows was rewritten (its claim that
only `:000080` needs refusing is what F3 corrected).

## Mutation proof

Harness `fix4/tools/run_mut.cjs` + `mutations.cjs`: exact-string replace asserting exactly ONE
occurrence, vitest on `src/core/exclusions` with the JSON reporter, restore from the pristine byte
copy (`fix4/fixed/`), sha256 verified after EVERY mutation (58 of 58 restores identical,
a3aa2582...). Counts are failing tests out of 505.

| mutation | result | failing tests (title: rows) |
| --- | --- | --- |
| H3 | killed 3 | "the hyphen rule holds in every host grammar and at every position": `a.-b.localhost`, `a.-b.localhost:3000`, `app.-clave.localhost:8765/chat.html?th...` |
| H4 | killed 4 | "the hyphen rule holds in every host grammar and at every position": `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost`, `a-.b.localhost` |
| H8 | killed 7 | "the hyphen rule holds in every host grammar and at every position": `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost`, `a.-b.localhost`, `a.-b.localhost:3000`, `a-.b.localhost`, `app.-clave.localhost:8765/chat.html?th...` |
| H6 | killed 5 | "the hyphen rule holds in every host grammar and at every position": `wik-/`, `wiki-/x`, `wiki-:8080`, `my-wiki-:8080`, `my-wiki-/` |
| H13 | killed 4 | "a hyphen INSIDE a label is an ordinary host character": `my-wiki/`, `dev-box:8080`, `intranet-om:8080`, `a--b/` |
| U3 | killed 6 | "nothing with a letter or digit may be glued after a single-label port": `intranet:8080<U+4E2D><U+6587>`, `intranet:8080<U+0436>`, `intranet:8080<U+0663>`; "nor after any other port": `localhost:3000<U+4E2D><U+6587>`, `localhost:3000<U+0436>`, `localhost:3000<U+0663>` |
| U9 | killed 9 | "nothing with a letter or digit may be glued after a single-label port": `intranet:8080<U+4E2D><U+6587>`, `intranet:8080<U+0436>`, `wiki:127z`, `intranet:8080A`, `intranet:80x.`, `intranet:8080.A`; "nor after any other port": `localhost:3000<U+4E2D><U+6587>`, `localhost:3000<U+0436>`, `localhost:3000A` |
| G3 | killed 4 | "and the first value it refuses": `github.com....`, `localhost:3000....`, `127.0.0.1....`, `[::1]....` |
| G4 | killed 3 | "the last value each glyph bound accepts": `github.com...`, `127.0.0.1...`, `[::1]...` |
| G5 | killed 3 | "and the first value it refuses": `localhost:3000....`, `intranet:80....`, `intranet:8080.,).` |
| G6 | killed 2 | "the last value each glyph bound accepts": `intranet:80...`, `intranet:8080.,)` |
| G8 | killed 3 | "and the first value it refuses": `@@@ github.com`, `*@: 127.0.0.1`, `@@ @@@ github.com` |
| G10 | killed 3 | "and the first value it refuses": `github.com @@@@`, `example.com ....`, `github.com @@@ .... ---` |
| K1 | killed 1 | "the bracketed literal is bounded at exactly 45 characters": `(single test)` |
| K3 | killed 1 | "the bracketed literal is bounded at exactly 45 characters": `(single test)` |
| K3b | killed 1 | "the bracketed literal is bounded at exactly 45 characters": `(single test)` |
| K4 | killed 5 | "a bracketed literal holds hex digits, dots and colons only": `[12:30:45:PM]`, `[a:b:c:word]`, `[fe80not:1:2:3:4]`, `[::g]`, `[1:2:3:-]` |
| X4 | SURVIVED |  |
| X14 | SURVIVED |  |
| X21-readd | SURVIVED |  |
| H12 | SURVIVED |  |
| H14 | SURVIVED |  |
| H1 | killed 5 | "a host label may not begin or end with a hyphen": `---github.com`; "the hyphen rule holds in every host grammar and at every position": `a.-b.localhost`, `a.-b.localhost:3000`, `app.-clave.localhost:8765/chat.html?th...`, `my-app.-vercel.app` |
| H2 | killed 8 | "a host label may not begin or end with a hyphen": `github-.com`; "the hyphen rule holds in every host grammar and at every position": `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost`, `a-.b.localhost`, `my-app-.vercel.app`, `my-app.vercel-.app`, `a.b-.com` |
| H5 | killed 2 | "a host label may not begin or end with a hyphen": `---localhost:3000`, `---wiki/` |
| H7 | killed 13 | "a host label may not begin or end with a hyphen": `---github.com`, `github-.com`; "the hyphen rule holds in every host grammar and at every position": `a-b-.localhost:3000`, `a-.localhost:3000`, `a.b-.localhost`, `a.-b.localhost`, `a.-b.localhost:3000`, `a-.b.localhost`, `app.-clave.localhost:8765/chat.html?th...`, `my-app-.vercel.app`, `my-app.-vercel.app`, `my-app.vercel-.app`, `a.b-.com` |
| H9 | killed 7 | "a host label may not begin or end with a hyphen": `---localhost:3000`, `---wiki/`; "the hyphen rule holds in every host grammar and at every position": `wik-/`, `wiki-/x`, `wiki-:8080`, `my-wiki-:8080`, `my-wiki-/` |
| H10 | killed 9 | "sees an address line in xn--80ak6aa92e.com": `(single test)`; "a hyphen INSIDE a label is an ordinary host character": `my-app.vercel.app`, `my-app.vercel.app/dashboard`, `my-app.vercel.app:443/x`, `MY-APP.Vercel.App`, `sub.my-site.co.uk/path?x=1`, `xn--bcher-kva.example`, `a--b.com`; "a one-token tab title that parses as a host still counts": `docker-compose.yml` |
| U2 | killed 5 | "nor after any other port": `localhost:3000<U+4E2D><U+6587>`, `localhost:3000<U+0436>`, `localhost:3000<U+0663>`; "a word in a non-Latin script is not a glyph, spaced or glued": `github.com<U+4E2D><U+6587>`, `README.md<U+0627><U+0644><U+0639>` |
| U7 | killed 8 | "localhost must end where the token ends": `localhosting`, `localhostel`; "nor after any other port": `localhost:3000<U+4E2D><U+6587>`, `localhost:3000<U+0436>`, `localhost:3000A`, `127.0.0.1:80z`; "a word in a non-Latin script is not a glyph, spaced or glued": `github.com<U+4E2D><U+6587>`, `README.md<U+0627><U+0644><U+0639>` |
| U6 | killed 7 | "sees no address line in 1.2.3.4.5": `(single test)`; "a port outside 1-65535 is not a port": `localhost:0`, `localhost:123456`, `127.0.0.1:0`; "a padded port is not a port": `localhost:08`; "and the range is checked through every grammar": `[::1]:0`; "nor after any other port": `localhost:3000<U+0663>` |
| U8 | killed 4 | "a port outside 1-65535 is not a port": `localhost:123456`, `intranet:123456`; "nothing with a letter or digit may be glued after a single-label port": `intranet:8080<U+0663>`; "nor after any other port": `localhost:3000<U+0663>` |
| R1 | SURVIVED |  |
| R2 | killed 3 | "a port outside 1-65535 is not a port": `localhost:65536`; "and the range is checked through every grammar": `intranet:65536`, `[::1]:65536` |
| R3 | killed 5 | "a port outside 1-65535 is not a port": `localhost:65536`, `localhost:99999`, `example.com:70000`; "and the range is checked through every grammar": `intranet:65536`, `[::1]:65536` |
| R4 | killed 5 | "a port outside 1-65535 is not a port": `localhost:65536`, `localhost:99999`, `example.com:70000`; "and the range is checked through every grammar": `intranet:65536`, `[::1]:65536` |
| R5 | killed 4 | "and a port inside the range still is": `localhost:1`, `127.0.0.1:1`; "an unpadded port of one to five digits is a port": `localhost:1`, `intranet:1` |
| R6 | killed 5 | "and a port inside the range still is": `localhost:65535`, `example.com:65535`; "an unpadded port of one to five digits is a port": `localhost:65535`, `127.0.0.1:65535`, `intranet:65535` |
| R7 | killed 3 | "a port outside 1-65535 is not a port": `localhost:65536`, `localhost:99999`; "and the range is checked through every grammar": `intranet:65536` |
| R8 | killed 4 | "a port outside 1-65535 is not a port": `localhost:65536`, `localhost:99999`, `example.com:70000`; "and the range is checked through every grammar": `[::1]:65536` |
| R9 | killed 5 | "a port outside 1-65535 is not a port": `localhost:65536`, `localhost:99999`, `example.com:70000`; "and the range is checked through every grammar": `intranet:65536`, `[::1]:65536` |
| R10 | SURVIVED |  |
| N1 TAIL lead [1-9]->[0-9] | killed 8 | "a padded port is not a port": `localhost:00080`, `localhost:080`, `localhost:08`, `localhost:080/x`, `example.com:080`, `a.localhost:080`, `127.0.0.1:080`, `[::1]:080` |
| N2 TAILREQ lead [1-9]->[0-9] | killed 8 | "a padded port is not a port": `localhost:00080`, `localhost:080`, `localhost:08`, `localhost:080/x`, `intranet:00080`, `intranet:080`, `ab:080`, `wiki:080/x` |
| N3 TAIL {0,4}->{0,3} | killed 3 | "and a port inside the range still is": `example.com:65535`; "an unpadded port of one to five digits is a port": `example.com:10000`, `127.0.0.1:65535` |
| N4 TAILREQ {0,4}->{0,3} | killed 2 | "an unpadded port of one to five digits is a port": `intranet:10000`, `intranet:65535` |
| N5 TAIL {0,4}->{0,5} (=R11) | SURVIVED |  |
| N6 TAILREQ {0,4}->{0,5} (=R12) | SURVIVED |  |
| N7 TAIL {0,4}->* (=X30) | SURVIVED |  |
| N8 TAILREQ {0,4}->* (=X35) | SURVIVED |  |
| N9 TAIL lead [1-9]->[2-9] | killed 2 | "and a port inside the range still is": `127.0.0.1:1`; "an unpadded port of one to five digits is a port": `example.com:10000` |
| N10 TAILREQ lead [1-9]->[2-9] | killed 2 | "an unpadded port of one to five digits is a port": `intranet:1`, `intranet:10000` |
| N11 TAIL lead [1-9]->[1-8] | killed 3 | "an unpadded port of one to five digits is a port": `127.0.0.1:9090`, `example.com:9`, `[::1]:9000` |
| N12 TAILREQ lead [1-9]->[1-8] | killed 2 | "an unpadded port of one to five digits is a port": `intranet:9`, `intranet:9000` |
| N13 TAIL {0,4}->{1,4} | killed 2 | "and a port inside the range still is": `127.0.0.1:1`; "an unpadded port of one to five digits is a port": `example.com:9` |
| N14 TAILREQ {0,4}->{1,4} | killed 2 | "an unpadded port of one to five digits is a port": `intranet:1`, `intranet:9` |
| N15 TAIL lead digit optional | killed 7 | "a padded port is not a port": `localhost:080`, `localhost:08`, `localhost:080/x`, `example.com:080`, `a.localhost:080`, `127.0.0.1:080`, `[::1]:080` |
| N16 TAILREQ lead digit optional | killed 6 | "a padded port is not a port": `localhost:080`, `localhost:08`, `localhost:080/x`, `intranet:080`, `ab:080`, `wiki:080/x` |

Legend. H/U/G/K/X/R ids are the review's. K3b is my extra edge (`{0,45}` -> `{0,44}`). N1-N16 are
mutations of my own new code, each tail separately: N1/N2 lead digit `[1-9]` -> `[0-9]`; N3/N4
`{0,4}` -> `{0,3}`; N5/N6 `{0,4}` -> `{0,5}` (the review's R11/R12 re-located); N7/N8 `{0,4}` -> `*`
(X30/X35 re-located); N9/N10 `[1-9]` -> `[2-9]`; N11/N12 `[1-9]` -> `[1-8]`; N13/N14 `{0,4}` ->
`{1,4}`; N15/N16 lead digit made optional. R7/R8: the range not applied through one tail.

### The review's complete survivor list, re-run

All 16 GENUINE survivors are killed: H3 3, H4 4, H8 7, H6 5, H13 4, U3 6, U9 9, G3 4, G4 3, G5 3,
G6 2, G8 3, G10 3, K1 1, K3 1, K4 5. **Genuine survivors from the review's list: ZERO.**

The 5 NEUTRAL ones still survive, as they should, and are still neutral in this code - differential
fuzz of mutated vs current `showsAddress` (`fix4/tools/fuzz.mjs`, 300 000 character-atom inputs +
300 000 port-shaped inputs, original true on 22 747 and 88 869 of them): X4 0 / 600 000,
X14 0 / 600 000, X21-re-added 0 / 600 000, H12 0 / 600 000, H14 0 / 600 000. The fuzz is sensitive:
the same corpora show 15 397 differences for N1 and 14 813 for R9.

### Survivors created by this round (hunt over my own new code)

First pass found two GENUINE survivors of my own: N11 and N12 (`[1-9]` -> `[1-8]`, a port starting
with 9 refused) - no row had a port beginning with 9. It also showed that `localhost:N` rows pin
`TAIL` only weakly, because `localhost` falls through to the single-label grammar and
`TAIL_REQUIRED`. Fixed with rows `localhost:9`, `localhost:9000`, `localhost:99`, `127.0.0.1:9090`,
`example.com:9`, `example.com:10000`, `[::1]:9000`, `127.0.0.1:65535`, `intranet:9`, `intranet:9000`.
After that: N11 killed 3, N12 killed 2, N3 killed 3.

Remaining survivors of this round, all NEUTRAL and all a direct consequence of the ruling "narrow the
pattern AND keep the range check" - the two guards now overlap:

| mutation | was (round 3) | now | why neutral | fuzz |
| --- | --- | --- | --- | --- |
| R1 `PORT_MIN` 1 -> 0 | killed 5 | SURVIVED | a port that parses starts with 1-9, so it is never 0 | 0 / 600 000 |
| R10 lower bound dropped | killed 5 | SURVIVED | same | 0 / 600 000 |
| N5, N6 `{0,4}` -> `{0,5}` (R11, R12) | killed 2 / 2 | SURVIVED | six digits with a non-zero first digit is >= 100000 > 65535, refused by the range | 0 / 600 000 each |
| N7, N8 `{0,4}` -> `*` (X30, X35) | killed 2 / 2 | SURVIVED | same; an absurdly long run becomes a huge Number or Infinity, still > 65535 | 0 / 600 000 each |

These cannot be pinned by a row - no input distinguishes them - and they are written down in
`sites.ts` (the paragraph added to the `PORT_MIN` comment says which half of each guard is redundant
and that neither may be dropped for the other). The guards they overlap with ARE pinned: R2 3, R3 5,
R4 5, R5 4, R6 4, R7 3, R8 4, R9 5; N1 8, N2 8, N3 3, N4 2, N9 2, N10 2, N13 2, N14 2, N15 7, N16 6.
Dropping BOTH halves of a pair is caught (R4 kills 5; N1/N2 kill 8).

**Totals: 58 mutations, 47 killed, 11 survived, all 11 proven neutral. Genuine survivors: zero.**

## Counts (end state, in the copy)

    vitest run --root <copy> src/core/exclusions   -> 5 files, 505 passed (505)      [repo: 391]
    vitest run --root <copy>                       -> 88 files: 87 passed, 1 skipped; 2828 tests: 2827 passed, 1 skipped
                                                      [repo baseline 2714 / 88; 2714 + 114 = 2828]
    tsc --noEmit -p <copy>/tsconfig.json           -> clean (exit 0)
    tsc --noEmit -p <copy>/tsconfig.renderer.json  -> clean (exit 0)

## Deviations from the ruling, with reasons

1. None in code. Every item of the ruling was done as written; `extractHosts` / `siteExcluded` are
   byte-identical; `LOCALHOST_HOST` keeps its label group; F7 behaviour is unchanged and still pinned
   true (`-github.com`, `--github.com`) / false (`---github.com`) by the existing rows.
2. More rows than the ruling lists (sibling positions, the 9-lead ports, glued-run `((` / `(((`
   edges, `[::g]`, `[1:2:3:-]`). Reason: the ruling asked for every sibling position and for a hunt
   over my own guards; the hunt found N11/N12.
3. "Target zero genuine survivors" is met, but the ruling's F3 makes six previously KILLED mutations
   neutral (R1, R10, R11, R12, X30, X35 - table above). That is inherent in keeping both guards, not
   a choice of mine; it is documented in the source comment rather than hidden. If the owner would
   rather have every guard killable, the only way is to drop one of the two (not recommended: the
   range check is the only thing refusing 65536-99999).
4. Two read-only symlinks (`fix4/eval`, `fix4/docs`) were added BESIDE the copy so the whole suite
   can run; they are not inside `app/` and nothing was written through them except this report,
   which was written directly to the repo path as the deliverable.
5. One harmless row: `[::1 x]` in the bracket-class list is two tokens, so it is refused by the line
   shape rather than the class (K4 does not flip it). It is correct and stays; the other five rows of
   that list are what kill K4.

## Not run

Nothing that reads a screen; no app, helper or `reader:eval` launch. The measured renderings are
taken from the review's section 4, not re-measured. Timing was not re-measured: the only pattern
change replaces one bounded digit run by a one-character class plus a shorter bounded run, which
cannot add backtracking, and the suite's 50 ms adversarial test still passes.

## To apply

Copy the two files from the private copy over `app/src/core/exclusions/sites.ts` and
`sites.test.ts` and verify the sha256 values above.
