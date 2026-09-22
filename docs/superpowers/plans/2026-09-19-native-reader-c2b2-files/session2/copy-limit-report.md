# Copy change: fourth KNOWN_LIMITS entry (Chrome/Safari address-bar limit)

## Files changed

Both under `app/src/renderer/**`, nothing else touched:

- `app/src/renderer/copy.ts` — added the new sentence to `KNOWN_LIMITS`, with a provenance comment.
- `app/src/renderer/model/views.test.ts` — added a test pinning the four-entry list verbatim and in order; imported `KNOWN_LIMITS`.

No git commands were run (per instructions). No other files were touched — `Onboarding.tsx`, which renders `KNOWN_LIMITS`, needed no change since it already maps over the array with no fixed-length assumption.

## The final `KNOWN_LIMITS` list, verbatim

```ts
/** Stated plainly in onboarding (spec section 7, step 5). */
export const KNOWN_LIMITS: readonly string[] = [
  "It cannot recognise a confidential fact that is phrased in ordinary words.",
  "It does not recognise a name written entirely in capital letters.",
  // Owner decision O8 (2026-09-21): the core does not keep a Chrome or Safari read whose toolbar
  // strip shows no address, because Safari was measured showing “Translation Available” in place of
  // the host for the first seconds after a page load, during which an excluded site could not be
  // recognised.
  "In Chrome and Safari it only reads a page while the address is visible.",
  "That is why nothing leaves until you have read it and said yes."
];
```

The new sentence is the third of four entries, placed before the closing line ("That is why nothing leaves...") as instructed — the closing line still reads as a conclusion that follows from all three limits above it, including the new one.

## Where it renders

Grepped `app/src/renderer` for `KNOWN_LIMITS`: it is imported and rendered in exactly one place.

- `app/src/renderer/screens/Onboarding.tsx`, onboarding step "What it cannot do" (`COPY.onboarding.limits`, step index where `neverRead`/limits are shown):
  ```tsx
  <div>
    <p className="label">{COPY.onboarding.limits}</p>
    <ul className="plain">{KNOWN_LIMITS.map((limit) => <li key={limit}>{limit}</li>)}</ul>
  </div>
  ```
  This is a plain `<ul className="plain">` — `.plain` (in `styles.css`) is a simple vertical list with an em-dash `::before` bullet on each `<li>` (`list-style: none`, no grid, no column layout, no fixed row count). It already scales to any number of entries; a fourth line is a fourth `<li>`, nothing more. No layout, grid, or test in the codebase assumes exactly three entries — checked with `grep -rn "toHaveLength(3)\|KNOWN_LIMITS"` across `app/src`; the only length-3 assertions found belong to unrelated things (`PERMISSION_STEPS`, reader-helper pool sizes, etc.).

### How the frontend-design skill was applied

Invoked `frontend-design:frontend-design` first, as instructed. Its process (brainstorm → plan → critique → build) is scoped to *new* visual work; here the deliverable is one more line of body copy inside an existing, already-generic vertical list (em-dash bullets, `--ink-2` color, 12.5px type) that is part of the established onboarding visual language. Applying the skill meant confirming — rather than overriding — that language: I read `.plain`'s CSS rule, confirmed it has no per-item count assumption (unlike, say, a 3-column grid would), and left it untouched rather than "improving" a design nobody asked to redesign. That is the deliberate choice here: restraint, not a new pattern, because the brief explicitly said this is one sentence in an existing list, not a redesign.

## Tests

- Added: `it("states the known limits in order, ending on the sentence they lead to", ...)` inside the existing `describe("the pitch", ...)` block in `app/src/renderer/model/views.test.ts`, next to the existing `CLAIMS` verbatim/position test. It does a `toEqual` against the full 4-element array (content and order both pinned in one assertion, since `toEqual` on an array checks position).
- Existing "five pitch claims" test (`uses the five claims verbatim from the overall plan`, `repeats the same five claims verbatim on the page the app links to`) was left untouched and still passes — confirmed byte-identical `CLAIMS` behavior, unaffected by this change.

**Test counts:**
- Before this change: 124 tests passing (5 files) in `src/renderer`.
- After this change: **125 tests passing (5 files)** in `src/renderer`.

```
 Test Files  5 passed (5)
      Tests  125 passed (125)
```

### Proving the new test bites

1. Copied the finished `copy.ts` (with the sentence) to a scratchpad backup.
2. Temporarily removed the new sentence and its comment from `copy.ts` (the live file under `src/renderer`).
3. Ran `pnpm --dir $R test src/renderer` — the new test **FAILed** as expected:
   ```
   ❯ src/renderer/model/views.test.ts (90 tests | 1 failed)
     ❯ the pitch (5)
       × states the known limits in order, ending on the sentence they lead to
   AssertionError: expected [ …(3) ] to deeply equal [ …(4) ]
   -   "In Chrome and Safari it only reads a page while the address is visible.",
   Tests  1 failed | 124 passed (125)
   ```
   (All other 124 tests still passed, confirming the failure was isolated to the new assertion.)
4. Restored `copy.ts` from the scratchpad backup with `cp`.
5. `cmp` between the backup and the restored file: **byte-identical** — restoration was exact.
6. Re-ran the full suite and typecheck (see below) to confirm the final state is clean.

## Typecheck

```
$ tsc --noEmit && tsc --noEmit -p tsconfig.renderer.json
```
Clean, no output, exit 0.

## Byte audit

Compared the final `copy.ts` against the saved pre-edit baseline at
`docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session2/pre-copy/copy.ts` (itself confirmed byte-identical to the file at the start of this task, via `cmp`, before any edits were made).

- `diff` between baseline and final file shows **only** the intended 5 added lines (the comment block + the new sentence) — nothing else in the file changed.
- Non-ASCII character census (baseline → final):
  - `—` (em dash): 7 → 7 (unchanged)
  - `·` (middle dot): 3 → 3 (unchanged)
  - `→` (arrow): 2 → 2 (unchanged)
  - `“` `”` (curly quotes): 3 → 4 each (the +1 is the new comment's own `“Translation Available”`, matching the file's existing curly-quote style used for quoted UI/dialog text, e.g. `“screen and audio”`)
  - No pre-existing non-ASCII character count decreased — confirmed programmatically (Python `Counter` diff), not just eyeballed.
- Control-byte scan of the final file: **0 control bytes found** (checked bytes < 0x09, 0x0B–0x0C, 0x0E–0x1F).
- Edits were made with the `Edit` tool using exact-string old/new blocks copied from what was actually read from disk (never a full-file retype), so no risk of the "write tools decode backslash escapes into literal characters" failure mode the task warned about — no backslash escapes were used at all, curly quotes were written as literal characters directly.

## Summary

Status: **done**. `KNOWN_LIMITS` now has 4 entries, verbatim as specified, with the new sentence placed third (before the closing line). Renders unchanged visually except for the new list item, in the existing `.plain` list style on the onboarding "What it cannot do" step.

- Tests: 125/125 passing in `src/renderer` (up from 124; 1 new test added).
- Typecheck: clean.
- Byte audit: clean — all pre-existing non-ASCII characters intact, no control bytes added, diff shows only the intended insertion.
- New test proven to bite (FAILed when the sentence was removed on a backup copy, then exact restore confirmed via `cmp`).

Report path: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session2/copy-limit-report.md`
