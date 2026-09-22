# Task 7 review — Renderer: permission copy, nothing-read line

Reviewer: independent, fresh session. Scratch copy: `.../scratchpad/exec/rev-7/app`. Files read in
full: `src/renderer/copy.ts`, `src/renderer/model/views.ts` (+`views.test.ts`),
`src/renderer/screens/Onboarding.tsx`, `src/renderer/screens/Home.tsx`, `src/renderer/styles.css`,
`src/renderer/dev/mockBridge.ts`, `src/renderer/dev/preview.tsx`. Compared throughout against
`.../scratchpad/exec/c2b1-backup/app/src/renderer/**` and against
`/Users/sardorastanov/techcells/asset-to-evidence/app/src/renderer/**` (the installed copy).

## Answers to the task's questions

1. **Is every user-facing word in `copy.ts` and none in a screen?** Yes. `grep` over
   `screens/Onboarding.tsx` and `screens/Home.tsx` for quoted/JSX text finds only comments, `case`
   labels, internal string comparisons (`status.capture === "on"`, etc.) and prop names — every
   rendered string traces to `COPY.*`, `BLOCKERS.*`, `PERMISSION_STEPS`, `CLAIMS` or `KNOWN_LIMITS`.
2. **Are the five pitch claims byte-identical to the backup?** Yes. `diff` of `copy.ts` against the
   backup shows the `CLAIMS` array (lines 8–14) untouched; every diff hunk is elsewhere (additions).
3. **Does the nothing-read line vanish when capture is off or the field is null?** Yes for those two
   cases (pinned by `views.test.ts:154-158`, re-verified). **No** for a third case the guard does not
   cover — see Important finding below: a `why` value outside the closed `NothingReadWhy` list makes
   the line render the literal word "undefined" instead of vanishing.
4. **Is it free of problem styling and of any button?** Yes. `Home.tsx:82` renders
   `<p className="note" aria-live="polite">{nothingReadLine(...) ?? ""}</p>` — `.note`, never
   `.problem`; no `<Button>` in that block. `styles.css` diff against the backup adds only the `.steps`
   block, touches nothing about `.problem` or buttons.
5. **Does the still-waiting line use the step's existing poll and no new timer?** Yes.
   `Onboarding.tsx:202-222`: one `useEffect`, one `setInterval(look, PERMISSION_POLL_MS)` (unchanged,
   1500 ms), and `stillWaiting(startedAt, Date.now())` is computed inside the same `look()` tick that
   already calls `clave.recheckPermission()`. No second timer exists anywhere in the file.
6. **Is every non-ASCII character of the old `copy.ts` still present?** Yes. Script comparison: the
   backup's sole `U+2014 —` is one of the 7 now in the file (1 original + 6 added, matching the dev
   report's own count). Curly quotes are real UTF-8 (`e2 80 9c` / `e2 80 9d`), not escapes. No
   character in U+0370–03FF or U+0400–04FF anywhere in the topic's files.
7. **Does every sentence of the permission step match a measured fact of the first-run record's
   "Permission" section?** Yes for content; one Minor dating slip — see below.

## Owner-approved strings vs. installed `copy.ts` — byte check

Compared the dev report's "final user-facing strings" section against the installed
`app/src/renderer/copy.ts` character for character:

| String | Match |
|---|---|
| `permission.lead` | Identical, including `“screen and audio”` (`e2 80 9c` / `e2 80 9d`) |
| `permission.steps` (3 strings, `appFile` substituted) | Identical |
| `permission.aside` | Identical |
| `checkingPermission` ("Waiting for Screen Recording") | Identical, unchanged |
| `stillWaitingPermission` | Identical |
| `BLOCKERS.PERMISSION_NEEDS_RESTART` sentence/action | Identical, unchanged |
| Old restart sentence | Confirmed absent (both by `diff` against backup and by mutation (a) re-run) |
| `NOTHING_READ` (3 sentences) + `home.since` | Identical to dev report's quoted lines |

No byte discrepancies found. `hexdump`/Python byte scan confirms all six curly quotes are
`e2 80 9c`/`e2 80 9d` (3 `“` + 3 `”`, matching the dev report's own audit: two pairs in user-facing
strings, one pair in a comment).

## Mutation table — all four re-run independently

| # | Mutation | Result | Restore verified |
|---|---|---|---|
| a | Old restart sentence put back as `permission.lead` | **2 tests fail**, as claimed (`has stopped telling the user...`, `prepares the user for what macOS will say...`) | `cmp` byte-identical to installed |
| b | `nothingReadLine` drops `capture !== "on"` | **1 test fails**, as claimed | `cmp` byte-identical to installed |
| c | `other` removed from `NOTHING_READ` | **Typecheck fails** (`TS2741`, exact message match) **and 3 tests fail**, as claimed. Side note: one of the 3 failures independently reproduces the Important finding below — `expected 'undefined Since 11:05.' to contain 'Nothing has been readable'` | `cmp` byte-identical to installed |
| d | `appFile` param ignored, name hard-coded | **1 test fails**, as claimed | `cmp` byte-identical to installed |

All four mutations bite exactly as the dev report describes. `pnpm --dir app` was never invoked;
`vitest`/`tsc` were called directly per the Global Constraints.

## Probes

- **Dev report's four** — covered by the mutation table above (they are the same four).
- **(i) `why` outside the closed list, through a cast.** Wrote a standalone probe test
  (`model/views.probe.test.ts`, deleted afterward) calling `nothingReadLine` with
  `nothingRead.why` cast to a value not in `{notAllowed, noWindow, other}`. **The probe bites**:
  `nothingReadLine` returns `"undefined Since 11:05."`, not `null`. See Important finding.
- **(ii) `stillWaiting` exactly at the boundary.** Already pinned by `views.test.ts:169-172`
  (`stillWaiting(1000,1000)` false, `startedAt+LONG_WAIT_MS-1` false, `startedAt+LONG_WAIT_MS` true,
  `+60_000` true). Re-read the implementation (`now - startedAt >= LONG_WAIT_MS`, `>=` is correct for
  an inclusive boundary): **probe does not find a defect.**

## Findings

### Important

**I-1 — `nothingReadLine` can render the literal word "undefined" instead of vanishing.**
`src/renderer/model/views.ts:81-84`:

```ts
export function nothingReadLine(status: EngineStatus, at: (epochMs: number) => string): string | null {
  if (status.capture !== "on" || status.nothingRead === null) return null;
  return `${NOTHING_READ[status.nothingRead.why]} ${COPY.home.since(at(status.nothingRead.since))}`;
}
```

`NOTHING_READ[status.nothingRead.why]` is a plain object index. If `why` is ever a string outside
`{notAllowed, noWindow, other}`, the index returns `undefined`, and the template literal stringifies
it, producing `"undefined Since 14:12."` — not `null`. `Home.tsx:82`'s `?? ""` does not catch this,
because the returned value is a non-null string.

This is not purely academic: per D15 (Global Constraints/Decisions), `EngineStatus` crosses the IPC
boundary as unvalidated JSON with no zod schema — "a malformed status would reach the renderer
unvalidated — as every other status field already does" is the plan's own accepted cost for *other*
fields, but this specific probe (Task 7's independent probe (i)) explicitly requires the opposite
outcome here: "it must render nothing rather than `undefined`." The dev report's own stated design
rule for this line — "does not use the attention colour that would make a working app look broken" —
is violated by the word "undefined" appearing in a live region on the home screen. A stale renderer
bundle talking to a newer main process that ever adds a fourth `NothingReadWhy` value (the exact
skew the file's own doc comment says it wants to guard against, but only catches at compile time when
the *type* changes, not when a *value* outside it arrives at runtime) would hit this.

Reproduced with a standalone vitest probe (see above); not present in the shipped test suite.

**Suggested fix:**
```ts
export function nothingReadLine(status: EngineStatus, at: (epochMs: number) => string): string | null {
  if (status.capture !== "on" || status.nothingRead === null) return null;
  const sentence = NOTHING_READ[status.nothingRead.why];
  if (sentence === undefined) return null;
  return `${sentence} ${COPY.home.since(at(status.nothingRead.since))}`;
}
```
plus a test asserting `nothingReadLine` returns `null` for a `why` reached through an unsafe cast.

### Minor

**M-1 — a provenance comment misdates the permission-dialog measurement.**
`src/renderer/copy.ts:138-139`:

> "What macOS is about to show, in the order the user meets it (measured with the owner on macOS 27,
> 2026-09-19)."

The only actual observation of the dialog's wording, its buttons, and the System-Settings entry name
is in the first-run record's `### Permission (first run, 2026-09-18)` section
(`docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md:30`). The record's later
"second run (2026-09-19, ...)" section explicitly did **not** re-observe the dialog: the grant was
already in place after the bundle was re-created, "the owner saw no new Screen Recording prompt"
(line 148-149), and "D-A was not re-tested in real use... the stale-`denied` path never arose" (line
168). So the dialog wording this copy is built from was measured on 2026-09-18, not 2026-09-19; the
comment appears to have borrowed the review document's own filename/finalization date rather than the
date of the specific observation. Purely a documentation nit — not user-facing, doesn't affect any
approved string — but worth a one-word date fix for the next person who audits provenance.

## Verdict

The five approved strings (lead, three steps, aside), the unchanged waiting/blocker strings, and the
three `NOTHING_READ` sentences are all byte-identical to what the dev report says the owner approved,
including exact non-ASCII bytes. All five pitch claims are untouched. No user-facing word lives outside
`copy.ts`. The nothing-read line correctly uses no problem styling and no button, and the still-waiting
line correctly reuses the existing poll with no new timer. All four of the developer's mutations
reproduce exactly as claimed. One independent probe (i) finds a real gap: the nothing-read line does
not degrade to "nothing" the way the plan requires when handed a `why` outside its closed list — it
shows "undefined" instead. One minor documentation dating slip.

**Verdict: APPROVED WITH MINORS** (one Important, fixable with a two-line guard and a test; one Minor).

Spec compliance: ✅
Quality: Approved
