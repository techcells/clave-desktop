# Task 6 review — Homoglyphs in the core

Reviewer: independent, scratch copy `rev-6/app`. Payload files reviewed:
`src/core/text/homoglyphs.ts`, `src/core/text/homoglyphs.test.ts`, `src/core/pipeline.homoglyphs.test.ts`,
`src/core/index.ts`, `native/reader/fixtures/homoglyphs.json`, and the fixture test added to
`native/reader/src/text.rs`.

## Questions

**Is the repair applied before `gate`, `exclusions.after` and `scrub` on every path through `ingest`?**
Yes. `src/core/index.ts:151-160`: `ingest(read)` calls `repaired(read.text)` and
`repaired(read.toolbarText)` as the very first two statements of the function body, unconditionally,
before `gate(read, "reads.skipped")` (line 153), before `exclusions.after` (line 155), and before
`scrub(body)` (line 160). There is no branch or early return ahead of lines 151-152, so every call to
`ingest` repairs first, on every path.

**Are titles untouched?** Yes. `read.title` is never passed through `repaired()`; it goes straight into
`gate(read, ...)` (line 153, which reads `front.title` inside `exclusions.before`) and into
`scrub(read.title).text` (line 160). Confirmed by reading — see also the finding below: **no test
currently asserts this**, so the "yes" above is a code-reading answer, not a test-backed one.

**Is the TS table the Rust table (parity test fails when a pair is removed on EITHER side)?**
Yes, verified two ways:
1. Independently parsed both `TWINS` arrays with a throwaway script (not the shipped test) and
   compared code-point-for-letter: 37 pairs each, same order, same mapping, `as sets equal: True`.
2. Mutation-tested both directions in the live test (`src/core/text/homoglyphs.test.ts`):
   - Deleting a pair from the **TypeScript** table (`о` -> `o`) fails 5 tests (matches dev
     report's mutation d).
   - Deleting the same pair from the **Rust** table only (leaving it in TS) — **not in the dev
     report's own mutation table** — fails 2 tests: `repairs every pair the reader's TWINS table
     carries, to the same letter` (length assertion, 36 != 37) and `changes nothing the reader's
     table does not list` (the TS table still repairs a code point the Rust table no longer lists).
   Both mutations were reverted and `cmp`-verified byte-identical against the real repo afterward.

**Does any new source file contain a literal Cyrillic or Greek character?** No. Scanned every topic
file plus the fixture, code point by code point, for U+0370-03FF and U+0400-04FF:
`homoglyphs.ts`, `homoglyphs.test.ts`, `pipeline.homoglyphs.test.ts`, `core/index.ts`,
`homoglyphs.json` — **0 hits** in all five. `text.rs` has 88 raw-character hits, but every one is
inside a doc comment or test comment (lines like `` /// `Аcceptance` and `MAX_АTTEMPTS` `` and
`` // "МОСКВА today" ``, never in executable code or the `TWINS` table itself, which uses `\u{XXXX}`
escapes). Diffed against the pre-install backup: these comment lines are unchanged from the backup,
i.e. pre-existing, not introduced by this task — consistent with the dev report's own disclosure.
`homoglyphs.json` was independently re-verified as byte-for-byte pure ASCII (`.decode("ascii")`
succeeds).

## Rule-by-rule comparison against `text.rs`

- **Word splitting.** `splitKeepingWhitespace` (TS) iterates by code point (`for...of`) exactly as
  `split_keeping_whitespace` (Rust) iterates by `char_indices`/`char`. The `WHITE_SPACE` regex was
  extracted from the live file and tested programmatically against the 25-code-point Unicode
  `White_Space` set: zero missing, zero false positives — an exact match for Rust's
  `char::is_whitespace`, which is defined as `White_Space`.
- **Latin-letter ranges, including the U+00D7/U+00F7 exclusion.** `isLatinLetter` (TS,
  `homoglyphs.ts:109-114`) and `is_latin_letter` (Rust, `text.rs:228-235`) use numerically identical
  bounds: `0x41-0x5A`/`0x61-0x7A` (`A-Z`/`a-z`), explicit `false` for `0xD7`/`0xF7`, then
  `0xC0-0xFF` and `0x100-0x24F`. Same shape, same numbers, same order of checks.
  the "cheap reject" range optimisation in Rust's `is_twin` is a Rust-only cheap accept path, and
  the map lookup (`isTwin`/`TWINS.has`) is the exact equivalent by construction.
- **The twin table.** Confirmed identical (see parity question above): 37 pairs, same order, same
  target letters, both directions defended by tests, both directions independently mutation-tested.

## Probes

**(i) A fixture case of my own, written as escapes.** Added to
`native/reader/fixtures/homoglyphs.json` in this copy only, via a Python script that builds the
characters from `chr(0x...)` and re-serialises with `ensure_ascii=True` (see the character-discipline
incident below for why):

```
in:  "c" + U+03BF + "mpanies" + U+0085 + U+041C U+041E U+0421 U+041A U+0412 U+0410
out: "companies" + U+0085 + U+041C U+041E U+0421 U+041A U+0412 U+0410
```
i.e. a Latin word with a Greek omicron in it, then `U+0085 NEXT LINE`, then a wholly-Cyrillic word
("MOSKVA" in capitals). Ran both suites:
- TypeScript: `src/core/text/homoglyphs.test.ts` — **44 passed** (was 42; the new row adds one
  "repairs" case and one "is idempotent" case, both green).
- Rust: `node scripts/build-native.mjs --test` — **224 passed, 0 failed**, including
  `text::tests::the_shared_fixture_holds_in_this_implementation_too`, which reads the same fixture
  file via `include_str!`.

Both languages agree on this case. As a sanity check on the harness itself, I also corrupted this
same fixture row's `out` value and reran the Rust suite: `the_shared_fixture_holds_in_this_implementation_too`
**FAILED** as expected, confirming the Rust side really is reading and asserting on the file I edited,
not a cached copy.

**(ii) Repair `title` as well — which test says titles are left alone?**
**None does.** I mutated `src/core/index.ts:160` from
`title = scrub(read.title).text` to `title = scrub(repaired(read.title)).text` and ran the *entire*
`src/core` suite (not just the topic's own tests): **380 passed, 0 failed** — completely unaffected.
This is a real gap, not a hypothetical one: decision 2 of the dev report ("Titles are not repaired")
is a considered, spec-consistent design choice with a real cost if reversed by accident (a Cyrillic-
or Greek-named window title would be silently corrupted), but nothing in the shipped test suite would
catch a future edit that added the repair call. Reverted and `cmp`-verified identical afterward.

## Mutation table — re-run

All six of the dev report's mutations were reproduced independently in this copy (mutate, run, watch
fail, restore, `cmp` byte-identical against the real repo):

| # | Mutation | My result |
|---|---|---|
| a | Neither field repaired in `ingest` | 3 failed (matches: the two toolbar-strip tests + the secret test) |
| b | Body repaired, toolbar strip not | 2 failed (the two toolbar-strip tests; secret test still passes, as expected) |
| c | `shouldRepairWord` drops the Latin-letter requirement (wholly-twin words repaired too) | 19 failed |
| d | One TS-table pair deleted (`о -> o`) | 5 failed |
| e | `WHITE_SPACE` replaced by `/\s/` | 5 failed |
| f | Fixture `out` corrupted (`MAX_ATTEMPTS` -> `MAX_ATTEMPT5`) | TS: 1 failed (the named case); Rust: `the_shared_fixture_holds_in_this_implementation_too` FAILED |

No mutation failed to bite. One extra direction not in the dev's table — deleting a pair from the
**Rust** side only, leaving TypeScript's copy intact — was tested separately above (parity question)
and also bites correctly (2 tests fail).

## A character-discipline incident during this review

While adding probe (i), I first tried an `Edit` call with `ο`/`М`-style escapes typed
directly into the JSON. The file-writing tool **silently decoded them into literal Cyrillic/Greek
characters** on disk — the exact hazard the dev report's own "Flag for the plan" section warned about.
I caught it with a `python3 -c "...".decode('ascii')` check immediately after (which is why that
check is now part of my method for this file), restored the fixture from the pre-install backup,
verified byte-identical with the real repo, and re-added the probe case using a Python script that
builds the characters from `chr(0x...)` and writes back with `json.dump(..., ensure_ascii=True)`,
never letting an escape sequence pass through a text-writing tool call. Final file re-verified pure
ASCII. This is not a finding against the payload — it reproduces exactly what the developer already
disclosed and defended against — but it is worth recording for whoever reviews the next topic: **do
not trust `Write`/`Edit` with `\uXXXX` text in this environment; generate and verify with a script.**

## Findings

**Important — Finding 1: the "titles are not repaired" decision (spec 10.1 item 13 / decision 2 of
the dev report) has no regression test.** `src/core/index.ts:147-152,160`. Reproducing probe: change
line 160 to `title = scrub(repaired(read.title)).text` and run `vitest run src/core` — 380/380 still
pass. Suggested fix: add a case to `pipeline.homoglyphs.test.ts` analogous to the existing toolbar/body
cases, e.g. a window whose *title* carries a twin that would defeat `isPrivateTitle`/`matchRule` if
repaired (or, more directly, a case whose `title` contains a twin and asserts the kept scenario's
rendered text — via `compact.ts`'s `render`, which does place `title` into the text sent to the model
— still contains the raw, unrepaired twin). Either form would turn red the moment someone adds
`repaired()` around `read.title`.

No Critical findings. No other Important or Minor findings — the implementation matches `text.rs`
rule-for-rule (word splitting, the Latin-letter ranges including the U+00D7/U+00F7 exclusion, and the
37-pair twin table, all independently verified by script rather than by trusting the dev report), the
repair correctly runs before `gate`/`exclusions.after`/`scrub` on every path, titles are correctly
left alone in the code (just not tested for it — Finding 1), and no source file in scope carries a
literal Cyrillic or Greek character.

## Verdict

**APPROVED WITH MINORS** (one Important finding: missing regression coverage for a correct, already-
shipped behaviour — not a functional defect, so it does not block, but should be closed before this
becomes the kind of thing item 34 already once was).

Spec compliance: ✅
Quality: Approved
