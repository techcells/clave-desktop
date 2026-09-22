# C-2b-1 Task 6 — sub-project A must not assume the reader repaired homoglyphs

Spec `2026-09-18-native-reader-design.md` 10.1 item 13, sub-project-A half; open as item 34 of
`2026-09-19-native-reader-c2a-first-run.md`. Developed in the scratch copy; nothing outside the four
files below was touched.

## Files added / changed

| File | What |
|---|---|
| `app/src/core/text/homoglyphs.ts` | **new.** `repairHomoglyphs(text)`: the reader's rule and the reader's table, in TypeScript. |
| `app/src/core/text/homoglyphs.test.ts` | **new.** Shared-fixture cases + idempotence + two-way table parity against `text.rs` + the whitespace boundary. |
| `app/src/core/pipeline.homoglyphs.test.ts` | **new.** Four end-to-end `ingest` cases: the matchers a twin defeats, and the one it must not over-repair. |
| `app/src/core/index.ts` | **changed.** `ingest` repairs `read.text` and `read.toolbarText` before `gate` / `exclusions.after` / `scrub`. One import, one module-level `repaired<T>` helper, three lines inside `ingest`, plus doc comments. |
| `app/native/reader/fixtures/homoglyphs.json` | **new.** 18 shared cases, pure ASCII. |
| `app/native/reader/src/text.rs` | **changed, test module only.** One test that loads the shared fixture with `include_str!` + `serde_json` and asserts the same two things for `normalise_homoglyphs`. Non-test code untouched (diff is a pure insertion of 23 lines inside `mod tests`). |

### Where the module went, and why there
`src/core/` is organised by concern (`exclusions/`, `scrub/`, `guard/`, `scenarios/`, `candidates/`),
so the repair got its own `text/` folder rather than being buried in `scrub/`: it is not scrubbing,
it runs before scrubbing, and the guard and the English check depend on it just as much.
`imports.test.ts` is satisfied — `homoglyphs.ts` imports nothing at all and calls no `console`. The
two test files read from disk with `node:fs`, which that test permits (it only scans non-`.test.ts`
files) and which is the point: they read `text.rs` and the shared fixture so they can prove the two
implementations still agree instead of restating the core's own opinion.

### The table
Ported mechanically: `work/gen_table.py` parses the `('\u{XXXX}', 'c')` pairs out of
`native/reader/src/text.rs` and prints the TypeScript rows, comments and all; the module is
`head + generated-table + tail` concatenated by shell, never retyped. **37 pairs in, 37 pairs out.**
The test re-parses the Rust table at run time and checks both directions: every pair the reader
knows repairs to the same letter here, and nothing else in `U+0370..U+04FF` is touched.

## Test counts

| Suite | Command | Result |
|---|---|---|
| TypeScript, `src/core` + `src/eval` | `vitest run --root $S/ws/app src/core src/eval` | **392 passed**, 24 files (346 before; **46 new**: 42 in `text/homoglyphs.test.ts`, 4 in `pipeline.homoglyphs.test.ts`) |
| Typecheck | `tsc --noEmit -p tsconfig.json` | clean, no output |
| Rust | `node scripts/build-native.mjs --test` | **194 passed**, 0 failed (193 before; **1 new**) |

The Rust suite was run, repeatedly, and never hit a compilation failure from the other agent's files.

## Mutation table (backup, mutate, run, restore, `cmp`)

| # | Mutation | Tests that failed |
|---|---|---|
| a | `ingest` repairs neither field (`const body = read.text`, `toolbarText = read.toolbarText`) | `does not hide a private window behind a Cyrillic o in its toolbar badge`; `does not hide an excluded site behind a Cyrillic o in its host`; `still scrubs a secret whose match a Cyrillic e would break` (3 failed) |
| b | body repaired, toolbar strip not | the two toolbar-strip tests above (2 failed). The secret test correctly still passes — it does not go through the strip. |
| c | wholly-twin words repaired too (`shouldRepairWord` returns `twin`) | 19 failed: `leaves a user's own Cyrillic words alone on the way to the model`, and the fixture rows `a wholly-twin word beside an English word is left alone`, `all-caps Cyrillic beside English survives`, `a real Russian sentence is untouched`, `a real Greek word is untouched`, `a real Greek sentence is untouched`, `newlines separate words…`, `U+0085 NEXT LINE is whitespace…`, `a word of digits and underscores…` (each also in its `is idempotent:` form), plus `treats U+0085 NEXT LINE as whitespace, which \s does not` and `splits on the rest of White_Space…` |
| d | one pair (`U+043E` -> `o`) deleted from the ported table | `repairs every pair the reader's TWINS table carries, to the same letter`; fixture rows `a Cyrillic small o inside a Latin word is repaired` and `…inside a host is repaired`; both `pipeline.homoglyphs` toolbar tests (5 failed) |
| e | `WHITE_SPACE` replaced by JavaScript's `/\s/` | `U+0085 NEXT LINE is whitespace, so the Cyrillic word beside English survives`; `U+FEFF is not whitespace, so it does not split a word the reader keeps whole`; the `is idempotent:` form of the first; `treats U+0085 NEXT LINE as whitespace, which \s does not`; `does not treat U+FEFF as whitespace, which \s does` (5 failed) |
| f | one `out` in the shared fixture corrupted (`MAX_ATTEMPTS` -> `MAX_ATTEMPT5`) | **Rust** `text::tests::the_shared_fixture_holds_in_this_implementation_too` FAILED, naming the case; **TS** `phase 0: a Cyrillic capital A inside a screaming-snake-case constant is repaired` (proves both sides really read the fixture) |

Every file was restored from its backup and `cmp`-verified byte-identical afterwards; the final run
in the counts table is post-restore.

## Whitespace: where Rust and JavaScript differ

Rust's `char::is_whitespace` is exactly the Unicode `White_Space` property. JavaScript's `\s` is
not. Two differences exist, and both change this function's answer, because both are word-boundary
decisions:

| Character | Rust `is_whitespace` | JS `\s` | Consequence if TS used `\s` |
|---|---|---|---|
| `U+0085 NEXT LINE` | yes | **no** | A `U+0085` between a wholly-Cyrillic word and an English one glues them into one word that contains a Latin letter, so the Cyrillic is rewritten — the exact corruption the rule exists to prevent. |
| `U+FEFF ZERO WIDTH NO-BREAK SPACE` | **no** | yes | Splits a word the reader keeps whole, so the two implementations disagree on a word whose only Latin letters sit on the far side of the BOM. |

`U+180E MONGOLIAN VOWEL SEPARATOR` is in neither set today (it lost `White_Space` in Unicode 6.3 and
current engines dropped it from `\s`), and `U+200B` is in neither, so neither is a difference.
TypeScript therefore spells the class out:
`/[\t\n\v\f\r    -     　]/`. Both differing
characters are fixture cases — asserted in Rust and TypeScript — and each also has a named TS test
saying *why*, so a future edit back to `\s` is told what it broke.

The `U+FEFF` fixture row asserts `<SOM><U+FEFF>port` -> `COM<U+FEFF>port`, i.e. the wholly-Cyrillic
word IS rewritten there, because the BOM does not separate words and the Latin `port` is in the same
word. That is faithful to the Rust rule, not an improvement on it; it is recorded here because it is
the one fixture row whose expected output looks wrong at a glance.

## Decisions, and the cost if each is wrong

1. **Repair in `ingest`, not in the stand-in reader or in `main`.** `ingest` is the one door every
   read comes through, whoever produced it, which is precisely what item 13 asks for. Cost if wrong:
   the core spends the repair on text a good reader already repaired — measured as nothing, because
   the function returns the input unchanged without allocating when no twin is present.
2. **Titles are not repaired.** They come from the window server, not from recognition, so there is
   no recognition error to undo; repairing one could only corrupt a window a user really named in
   Cyrillic or Greek. Cost if wrong: a homoglyph that macOS itself put in a title would still defeat
   `isPrivateTitle`, `matchRule` and `titleMentions`. Nothing has ever observed one. If that changes,
   the fix is one more `repaired(...)` in `ingest` plus the same treatment in `mayCapture` — note
   `gate`/`before` were deliberately left untouched, so it is not a one-line change there.
3. **The rule is copied exactly, including the "never rewrite a wholly-twin word" trade.** The two
   implementations must agree or the text a matcher sees depends on the reader after all, which is
   the bug. Cost: an English word misread *entirely* in Cyrillic capitals still defeats every
   matcher in A. That residual is the reader's documented, owner-visible trade, not a new one.
4. **`repaired<T>` tolerates a non-string.** A read is outside input; `read.text` or
   `read.toolbarText` can be anything. Without the guard, a malformed read would throw out of
   `ingest` instead of being refused by the checks that already refuse it (`scrubFailed`,
   `unknownWindow`). Cost if wrong: none observed — the existing malformed-read tests still pass.
5. **The parity test parses `text.rs` at run time** rather than comparing a checked-in copy of the
   table. Cost if wrong: the test is coupled to the Rust table's formatting and would fail loudly if
   someone reformatted it — which is the cheap direction of that failure.

## Non-ASCII discipline — and one thing worth flagging

Verified by script after every write: `homoglyphs.ts`, `homoglyphs.test.ts`,
`pipeline.homoglyphs.test.ts`, `core/index.ts` and the block added to `text.rs` contain **no** raw
character in `U+0370–U+03FF` or `U+0400–U+04FF` (the only non-ASCII in them is `U+2014` em dash in
prose), and `homoglyphs.json` is **byte-for-byte pure ASCII**. The raw Cyrillic and Greek already
present elsewhere in `text.rs` is pre-existing, and only in test *comments*.

**Flag for the plan.** The write tooling in this session decoded `\uXXXX` sequences in some file
writes into the characters they name (it turned the `` and ` ` in a draft of
`homoglyphs.ts` into real control characters, which broke parsing, and would just as happily have
turned `А` into a bare Cyrillic A). It did *not* do so consistently — the same escapes survived
intact in another file written the same way. Everything delivered here was therefore written with
`<U+XXXX>` tokens expanded by `work/expand.py` (which builds the backslash with `chr(92)`), or
generated by a script whose own source builds characters with `chr(int(hex, 16))`, and then verified
by the audit above. The fixture was generated twice by two independently-written generators and the
outputs compared byte-for-byte: identical apart from one case *name* I deliberately reworded. Anyone
re-running this task should assume the same hazard.

## Not done / out of scope

- `mayCapture` and `exclusions.before` are unchanged (decision 2 above); only `ingest` repairs.
- No counter was added for "a read arrived with twins in it". It would be a real signal about
  reader quality, but `SkipReason`/counter names are product surface and nothing in the brief asked
  for one. Cheap to add later inside `repaired`.
- Only `src/core`, `src/eval` and the native suite were run, per the brief. The whole TypeScript
  suite was not.
