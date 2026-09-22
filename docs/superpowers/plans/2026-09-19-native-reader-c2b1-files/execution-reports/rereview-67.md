# Re-review 67 — topics 6 and 7 of plan C-2b-1, fix round 1

Scope: `src/core/pipeline.homoglyphs.test.ts`; `src/renderer/model/views.ts` + `views.test.ts`;
`src/renderer/copy.ts` (one comment line). Private copy: `.../scratchpad/exec/rr-67/app`. Baseline
test run before any mutation: `vitest run src/core/pipeline.homoglyphs.test.ts src/core/text
src/renderer` → 7 test files, 171 passed, 0 failed.

## Findings table

| Finding | Verdict | Evidence |
|---|---|---|
| T6 Important — "titles are not repaired" had no regression test | **ADDRESSED** | New test `leaves a twin in a window's title unrepaired, because a title comes from the window server, not recognition` added at `src/core/pipeline.homoglyphs.test.ts:86-104`, using `String.fromCodePoint(0x043e)` (no literal Cyrillic character in source — confirmed by byte scan, 0 hits in U+0370–03FF/U+0400–04FF, 0 stray control bytes). Reverted by hand: mutated the real-module-imported `src/core/index.ts:160` from `title = scrub(read.title).text` to `title = scrub(repaired(read.title)).text` in the rr-67 copy, re-ran the same command — **1 failed** (exactly the new test; diff shows the twin present in `- [Terminal — deplоy - zsh]` vs the mutated `+ [Terminal — deploy - zsh]`), **170 other tests stayed green**. Restored `src/core/index.ts` from a pre-mutation backup, `cmp` byte-identical, re-ran: 171/171 passed again. `src/core/index.ts` carries no diff in `fix1-all.diff` at all — confirms the fixer's claim that the file was left exactly as found. |
| T7 I-1 — `nothingReadLine` must return `null` for a `why` outside the closed list | **ADDRESSED** | Fix at `src/renderer/model/views.ts:81-92`: indexes `NOTHING_READ[status.nothingRead.why]` into a `sentence` local and returns `null` when it is `undefined`, instead of letting the template literal stringify `undefined`. New test at `views.test.ts:161-167` casts `"aFourthReasonTheTypeDoesNotKnowAbout" as unknown as NothingReadWhy` and asserts `null`. Reverted the guard by hand (restored the original one-line `return` with no `sentence`/`undefined` check), re-ran `vitest run src/renderer` — **1 failed**: `expected 'undefined Since 11:05.' to be null`, **123 other tests stayed green**. Restored `views.ts` from backup, `cmp` byte-identical, re-ran: 124/124 passed. |
| T7 M-1 — only the date in the provenance comment of `copy.ts` changed | **ADDRESSED** | `diff` of rr-67's `copy.ts` against `$S/exec/rev-7/app/src/renderer/copy.ts` (the untouched pre-fix reference copy for this topic) shows exactly **one** line differs: `macOS 27, 2026-09-19)` → `macOS 27, 2026-09-18)` at line 140. Curly-quote byte count identical between the two files: 3× `“` (`e2 80 9c`) and 3× `”` (`e2 80 9d`) in both. No control bytes below 0x20 (other than `\n`/`\t`) in either file. No user-facing string changed (the edit sits inside a `/** ... */` JSDoc comment above `COPY.onboarding.permission`, not inside any returned string literal). |

## New-breakage scan (fix diff, topic files only, changed lines)

Extracted the four relevant hunks from `fix1-all.diff` (`src/core/pipeline.homoglyphs.test.ts`,
`src/renderer/copy.ts`, `src/renderer/model/views.test.ts`, `src/renderer/model/views.ts`):

- `pipeline.homoglyphs.test.ts`: pure addition (one new `it(...)` block appended before the closing
  `});`), no existing line touched.
- `copy.ts`: single-line date change inside a comment, nothing else.
- `views.test.ts`: pure addition (one new `it(...)` block inserted), no existing line touched.
- `views.ts`: the `nothingReadLine` body changed from a one-line `return` to the three-line
  guarded version; no other function in the file touched.

No Critical or Important breakage introduced. Full `src/renderer` and
`src/core/pipeline.homoglyphs.test.ts src/core/text` suites pass at 171/171 in the current
(un-mutated) state of the rr-67 copy.

## Character/control-byte scan (all four topic files)

Scanned all four files for literal characters in U+0370–03FF (Greek) and U+0400–04FF (Cyrillic), and
for control bytes below 0x20 other than `\n`/`\t`: **0 hits in all four files.**

## Observations (out of scope, do not affect verdict)

- None worth flagging. The fixer's report's account of its process (TDD order, revert proofs, byte
  scans) matches what independent re-verification in this sandbox found in every particular checked.

## Verdict

**ALL ADDRESSED.** No new Critical/Important breakage found in the topic 6/7 files.
