# Fix-round report — topics 6 and 7 of plan C-2b-1

Fixer file set: `src/core/pipeline.homoglyphs.test.ts`; `src/renderer/model/views.ts` + `views.test.ts`;
`src/renderer/copy.ts` (one comment line only). All paths below are relative to
`/Users/sardorastanov/techcells/asset-to-evidence/app`.

## Topic 6 — Important: "titles are not repaired" had no regression test

**File:** `src/core/pipeline.homoglyphs.test.ts:86-104` (new test appended after the existing
"leaves a user's own Cyrillic words alone..." case, inside `describe("recognition homoglyphs in a
read the core is handed", ...)`).

**What changed:** added
`it("leaves a twin in a window's title unrepaired, because a title comes from the window server, not
recognition", ...)`. It builds a title `` `depl${cyrillicO}y - zsh` `` where `cyrillicO =
String.fromCodePoint(0x043e)` (the twin of Latin "o" from `core/text/homoglyphs.ts`'s `TWINS` table),
reads it through the real pipeline (`GATE_NO` script, `text: \`${long("deploy")}\n\``), awaits
`finish()`, and asserts `model.calls[0].userText` contains the literal, unrepaired bracket
`` `[Terminal — ${title}]` `` (the `[app — title]` header `compact.ts`'s `render` puts in front
of every kept block). If a future edit repairs the title, this substring changes to `deploy` (no
twin) and the assertion fails.

Per the character-discipline rule in fixer-rules.md, the twin is built from `String.fromCodePoint`
(a numeric literal, `0x043e`), never typed as a character and never written as a bare `\u` escape in
this file's source. Verified with a byte scan after every edit
(`python3 -c "... [b for b in data if b > 0x7e]"`): the file contains exactly the same two
pre-existing em dashes it had before (file header line 8, line 56 — `e2 80 94`, U+2014) and no other
non-ASCII byte, no control byte below 0x20 other than `\n`/`\t`. The `—` and `0x043e` that appear
in the diff are literal backslash-text in the source (an escape sequence and a hex literal
respectively, exactly like the file's pre-existing `"Incоgnito"` style), not decoded characters.

**Test name:** `leaves a twin in a window's title unrepaired, because a title comes from the window
server, not recognition` (`src/core/pipeline.homoglyphs.test.ts`).

**Revert proof (on the real `src/core/index.ts`, per the ruling — not a separate backup copy, since
the test imports the real module; the rule "you do NOT edit `src/core/index.ts` for real" was
honored by restoring it before moving on):**
1. Backed up `src/core/index.ts` to the scratchpad (`exec/index.ts.bak`) and confirmed `cmp` identical
   to the installed file.
2. Mutated the installed file's `ingest`, line 160, from `title = scrub(read.title).text` to
   `title = scrub(repaired(read.title)).text` (i.e., made `ingest` repair the title too — the exact
   mutation topic 6's ruling specifies).
3. Ran `pnpm --dir app test src/core/pipeline.homoglyphs.test.ts src/core/text src/renderer`:
   **1 failed** — exactly the new test, with the twin gone from the received text
   (`+ [Terminal — deploy - zsh]` vs `- [Terminal — deplоy - zsh]`). All 170 other tests in the run
   stayed green, i.e. the mutation is caught by exactly the test meant to catch it and nothing else.
4. Restored `src/core/index.ts` from the backup; `cmp` against the backup: **byte-identical**.
5. Re-ran the same test command: **171 passed, 0 failed**.

`src/core/index.ts` is left exactly as it was found; the only permanent change for this topic is the
new test in `pipeline.homoglyphs.test.ts`.

## Topic 7 — Important I-1: `nothingReadLine` rendered the literal word "undefined"

**File:** `src/renderer/model/views.ts:81-90` (function `nothingReadLine`).

**What changed:** added a guard so an index miss on `NOTHING_READ[status.nothingRead.why]` (a `why`
value outside the closed `NothingReadWhy` union, reachable at runtime because `EngineStatus` crosses
IPC as unvalidated JSON) returns `null` instead of letting the template literal stringify `undefined`:

```ts
export function nothingReadLine(status: EngineStatus, at: (epochMs: number) => string): string | null {
  if (status.capture !== "on" || status.nothingRead === null) return null;
  const sentence = NOTHING_READ[status.nothingRead.why];
  if (sentence === undefined) return null;
  return `${sentence} ${COPY.home.since(at(status.nothingRead.since))}`;
}
```
Added a dense comment explaining the IPC-unvalidated-JSON reasoning, matching the suggested fix in
`task-7-review.md` almost verbatim (ruling matched the reviewer's suggestion here).

**Test (written first, TDD):** `src/renderer/model/views.test.ts:161-167`, inside
`describe("the nothing-read line", ...)`:
`it('returns null rather than the word "undefined" when the engine sends a why outside the closed
list', ...)` — casts `"aFourthReasonTheTypeDoesNotKnowAbout" as unknown as NothingReadWhy` and asserts
`nothingReadLine(reading(bogus), at)` is `null`.

**TDD sequence:**
1. Added the test against the unmodified `views.ts`. Ran
   `pnpm --dir app test src/renderer`: **1 failed** (`expected 'undefined Since 11:05.' to be null`),
   123 other tests green.
2. Applied the fix above. Re-ran: **124 passed, 0 failed** (file `views.test.ts`: 89 tests, no —
   confirmed total suite: 5 test files, 124 tests, all green).

**Revert proof:** backed up the fixed `views.ts` aside, copied the pre-fix backup (captured before any
edit) back over the installed file, re-ran `pnpm --dir app test src/renderer`: **1 failed**, same
assertion failure as step 1 above. Restored the fixed file from the aside copy; `cmp`: byte-identical.
Re-ran: **124 passed, 0 failed**.

## Topic 7 — Minor M-1: provenance comment misdated the permission-dialog measurement

**File:** `src/renderer/copy.ts:140` (inside the JSDoc above `COPY.onboarding.permission`).

**What changed:** exact-string edit, date only:
`macOS 27, 2026-09-19)` → `macOS 27, 2026-09-18)` (the dialog was actually observed on 2026-09-18 per
`docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`'s `### Permission (first run,
2026-09-18)` section; the 2026-09-19 second-run section explicitly did not re-observe the dialog).
Confirmed with `grep -n "2026-09-19\|2026-09-18"` that this was the only date occurrence in the file
before and after the edit (now reads `2026-09-18` at line 140, no other date string in the file).

**Byte check (curly quotes):** compared curly-quote counts between the installed `copy.ts` (after the
edit) and the untouched reference copy `$S/exec/rev-7/app/src/renderer/copy.ts`:
- Reference: 3 × `“` (`e2 80 9c`), 3 × `”` (`e2 80 9d`).
- Installed, post-edit: 3 × `“`, 3 × `”` — **match**.
Also scanned for control bytes below 0x20 other than `\n`/`\t`: none found.

**Test run:** `pnpm --dir app test src/renderer` → **5 test files passed, 124 tests passed, 0 failed**
(this run includes the topic-7 I-1 fix and its new test above; `copy.ts`'s own consumers —
`views.test.ts`'s "the permission step's copy" describe block, which reads `copy.ts`'s source text
directly — stayed green, confirming the comment-only edit changed nothing user-facing).

## Final combined test run (all four files together)

`pnpm --dir app test src/core/pipeline.homoglyphs.test.ts src/core/text src/renderer`:
**7 test files passed, 171 tests passed, 0 failed.**

## Decisions / notes

- Topic 6's dispatch instruction to build the twin "from code points... never write a backslash-u
  escape through the edit tools without checking the bytes on disk afterwards" was read as: prefer
  `String.fromCodePoint(0x...)` for the twin itself (done), and where a `\u` escape was still the
  natural way to express the literal `[app — title]` bracket inside a template literal (matching this
  file's own pre-existing convention, e.g. `"Incоgnito"`), verify the on-disk bytes afterward
  (done — see byte scan above). No Cyrillic/Greek character was ever typed.
- One self-correction during this task: my first draft of the new test's prose comments ended up with
  a literal `—` sitting as inert text inside `//` comments (harmless but sloppy — a `//` comment
  doesn't interpret JS escapes). Reworded those two comments to avoid needing an em dash in prose,
  keeping `—` only inside the one executable template literal where it belongs and is correct.
- `src/core/index.ts` was mutated and restored exactly once, for the topic 6 revert proof, per the
  explicit instruction to do this on the real file rather than a detached copy. It is confirmed
  byte-identical to its pre-task state (`cmp`) and was not part of any permanent change.
- No typecheck run: not in the dispatch's required test list, and running it project-wide risked
  surfacing other fixers' concurrent in-progress edits outside this file set. Happy to run it if
  wanted.

## Status

**DONE**
- Topic 6 Important (titles not repaired, no regression test): ADDRESSED
- Topic 7 Important I-1 (`nothingReadLine` renders "undefined"): ADDRESSED
- Topic 7 Minor M-1 (provenance comment misdates dialog measurement): ADDRESSED

Test counts for the tests run (`src/core/pipeline.homoglyphs.test.ts src/core/text src/renderer`):
**171 passed, 0 failed** (7 test files).

Concerns: none. All four owned files left in a green, restored-where-required state; no file outside
the owned set was left modified (the one transient mutation to `src/core/index.ts` was reverted and
verified byte-identical before this report was written).
