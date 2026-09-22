# C-2b-1 Task 7 — the permission step's copy, and the "nothing to read" line in the window

Scratch copy: `/private/tmp/claude-501/-Users-sardorastanov-techcells-asset-to-evidence/494108c1-19cf-47bf-bf1e-320fb82023e4/scratchpad/ws/app`.
Covers carried item 5 of `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`
(onboarding copy; the restart sentence is wrong and must go), spec 10.1 items 4–5, and the renderer
half of the nothing-read notice whose main-process half is in `reports/task2-dev-report.md`.

Only `app/src/renderer/**` was touched. Nothing was written into the real repo, and nothing into
`ws/app` outside `src/renderer/` (verified: `diff -rq base/app/src/renderer ws/app/src/renderer`
lists exactly the files below plus `model/controls.test.ts`, which is task 2's fixture, not mine).

## Files changed

| File | What |
|---|---|
| `src/renderer/copy.ts` | `onboarding.permission` is now `{lead, steps(appFile), aside}`; new `onboarding.stillWaitingPermission`; new `NOTHING_READ` record; new `home.since`; new `APP_FILE` and `PERMISSION_STEPS` at the foot of the file |
| `src/renderer/model/views.ts` | new `nothingReadLine(status, at)`, `stillWaiting(startedAt, now)`, `LONG_WAIT_MS`; imports `COPY` / `NOTHING_READ` from `../copy` |
| `src/renderer/screens/Onboarding.tsx` | `PermissionStep`: the three-step list, the aside, the delayed "still waiting" line; the existing 1.5 s grant poll now also answers `stillWaiting` |
| `src/renderer/screens/Home.tsx` | one `aria-live="polite"` paragraph carrying `nothingReadLine(...)`, placed after the extraction-paused note and before the blocker |
| `src/renderer/styles.css` | one new block, `.steps` (the numbered instruction list) |
| `src/renderer/dev/mockBridge.ts` | three scenarios — `home-nothing-notallowed`, `home-nothing-nowindow`, `home-nothing-other` — and a `nothingRead()` status helper |
| `src/renderer/model/views.test.ts` | +11 tests in three new `describe`s |

`src/renderer/dev/preview.tsx` needed **no** change: it routes any `home-*` scenario to the home
hash already, and `SCENARIOS` drives the picker.

## The final user-facing strings, verbatim (for the owner to read and approve)

**Permission step — lead (`.lede`, under the "Screen Recording" heading):**

> macOS will ask whether this app may record the screen. The dialog says “screen and audio”: this app reads the text of the window in front, and keeps no picture and no sound.

**Permission step — the three steps** (rendered as a numbered list; the digits are the list's, not the
strings' — see "How the frontend-design skill was applied"):

> 1. Choose Open System Settings in the dialog, not Deny.
> 2. Switch on “Clave Agent.app”. If it is not in the list, add it with the + button.
> 3. Come back here. No restart is needed.

**Permission step — aside (quiet note under the steps):**

> macOS may offer Quit & Reopen. Later is fine.

**Permission step — while waiting** (unchanged, then the new second line after ~20 s):

> Waiting for Screen Recording
>
> Still waiting. It can take up to a minute after you switch it on.

**Unchanged, still there, for the rare case it really describes** (`BLOCKERS.PERMISSION_NEEDS_RESTART`):

> Screen Recording is on. The app needs a restart to use it.  ·  Restart now

**Gone, and a test keeps it out of the file:**

> ~~macOS will ask you to allow Screen Recording. After you allow it, the app has to restart once.~~

**The nothing-read line on Home** (one quiet line, no rule down the side, no button). The sentence is
chosen by `why`, and `Since HH:MM` is appended with the home screen's existing `Intl.DateTimeFormat`
clock — the same one `Paused until 17:30.` uses:

> Reading is on. The windows in front are ones this app does not read. Since 14:12.   *(notAllowed)*
>
> Reading is on. There has been no window to read. Since 14:12.   *(noWindow)*
>
> Reading is on. Nothing has been readable for a while. Since 14:12.   *(other)*

Two wording notes for the owner:

- The brief proposed "It says “screen and audio”." The subject of "It" would have been the dialog,
  one sentence after "macOS"; it now reads "The dialog says “screen and audio”:" and the colon
  carries the correction that follows. Every fact is kept, including that the app keeps no sound.
- The brief proposed step 1 as "Choose Open System Settings." The app's own button underneath carries
  the same label, so the step now says *in the dialog* and names the button not to press. That is one
  more measured fact (the dialog's buttons are Open System Settings / Deny), not an invention.

## Test counts

| Target | Tests | New |
|---|---|---|
| `src/renderer` (the brief's command) | **123 in 5 files** | **+11** (was 112) |

The 11: 3 in `the permission step's copy`, 7 in `the nothing-read line` (one of which is an
`it.each` over `NOTHING_READ_WHY`, so three cases), 1 in `waiting for the grant`.

No component test framework exists in this repo (`find src -name '*.test.tsx'` → nothing), so none
was added; the screens are covered by the view-model functions they render and by typecheck.

## Typecheck

- `tsc --noEmit -p tsconfig.renderer.json` — **clean, exit 0, no output**.
- `tsc --noEmit -p tsconfig.json` — **clean, exit 0, no output**.

## Mutation table — every new test shown to bite

Each mutation applied by script to a `cp`-aside backup of the real file, the renderer suite and the
renderer typecheck run, then the backup copied back and `filecmp`-verified byte-identical. SHA-256 of
`copy.ts` and `views.ts` before the four runs equals the SHA-256 after them
(`d8e6bedb…30cff0` and `fed2e881…8640c1`).

| # | Mutation | Result |
|---|---|---|
| a | The old restart sentence put back as `permission.lead` | **2 tests fail** — *has stopped telling the user that allowing it costs a restart* (`expected … not to contain 'After you allow it, the app has to re…'`) and *prepares the user for what macOS will say…* Typecheck still clean, which is exactly why the test reads the file's TEXT. |
| b | `nothingReadLine` drops the `capture !== "on"` half of its guard | **1 test fails** — *says nothing at all unless reading is actually on…* (`expected 'Reading is on. There has been no wind…' to be null`). Typecheck clean: nothing but the test catches this. |
| c | `other` removed from `NOTHING_READ` | **Both.** Typecheck fails: `copy.ts(46,14): error TS2741: Property 'other' is missing in type '{ notAllowed: string; noWindow: string; }' but required in type 'Record<NothingReadWhy, string>'`. And **3 tests fail**, including *has a sentence for every reason the engine can give, and no more*. So a fourth reason added to the engine without copy is a compile error, and a reason deleted is caught twice. |
| d | The app file name hard-coded into step 2, the `appFile` parameter ignored | **1 test fails** — *puts the app FILE's name in the second step, and takes it from whatever it is handed* (`expected 'Switch on “Clave Agent.app”…' to contain 'Probe Name.app'`). Typecheck clean. |

## `{appFile}`: where the name comes from, and the one gap

`AppInfo` carries `version`, `modelSha256`, `modelSizeBytes`, `standIns` and nothing about the
bundle, and the brief forbids new IPC — so `APP_FILE` is derived in `copy.ts` as
`` `${COPY.appName}.app` `` = **"Clave Agent.app"**, and `PERMISSION_STEPS` is the substituted list
the screen renders (the screen holds no words, per the file's rule).

**Known gap, deliberate and recorded in the code comment:** the dev bundle's file is
**"Clave Agent Dev.app"**, so a developer reading a dev build sees a name one word short of the entry
in their own System Settings list. Shipping builds read right. Curing it properly means the bundle
telling the window its own file name (one more field on `AppInfo`), which is a main-process change and
belongs with whoever next opens that surface.

## The delayed "still waiting" line — what pattern was used

The renderer has no injected-clock-into-a-component pattern, but it does have the pattern the brief
asks for one step down: a pure view-model function handed its time formatting (`reviewRows(view,
localDay)`). So the rule is a pure function in `model/views.ts` —
`stillWaiting(startedAt, now) => now - startedAt >= LONG_WAIT_MS`, `LONG_WAIT_MS = 20_000` — tested at
0, at the boundary − 1 ms, at the boundary, and past it. The component supplies the two timestamps
from the poll it **already runs** (`PERMISSION_POLL_MS = 1500`); no second timer and no new timers
architecture. `startedAt` is captured inside the effect, which runs once per mount because `askStatus`
is a dependency-free `useCallback`. `setWaitedLong` is called on every tick with the same value,
which React treats as a no-op, so the paragraph above it in that file — the one explaining why the
poll must not re-render the window every 1.5 s — still holds.

## Accessibility

The app already uses polite live regions for status text in exactly two places: `Frame`'s `.announce`
line (rendered once, above the screens) and Review's `.said` outcome line. Review's is the pattern
that fits: the paragraph is **always** in the page and its text changes, because a live region has to
exist before its content changes or nothing is announced. Home's nothing-read paragraph is built the
same way — `<p className="note" aria-live="polite">{line ?? ""}</p>` — using `.note`, which differs
from `.said` only in having the top margin every other quiet line on Home has. When empty it draws no
line box, and its 10px margin is smaller than the 22px divider margin that follows, so it costs no
space. One consequence, small and deliberate: it occupies an `.enter > *` slot, so the entrance
animation delays of the elements below it shift by one step.

## How the frontend-design skill was applied, and what was deliberately NOT changed

Read first: the whole of `styles.css` (its "THE LEDGER" direction note), all four screens,
`components/Controls.tsx`, `Frame.tsx`. This is an addition inside a finished, hardened visual
language, so the skill was applied as *fit*, not as direction-setting.

What the skill actually changed in the work:

- **Structure is information.** The three steps genuinely are a sequence — they are the order macOS
  puts them in — so a numbered list is the honest device rather than decoration. Consequently the
  digits were taken **out of the copy strings** (the brief proposed `"1. Choose…"`) and made the
  list's own counter, which is precisely how `CLAIMS` / `.claims` already works in this codebase:
  strings carry words, CSS carries numbering.
- **Spend boldness in one place.** The one new class, `.steps`, borrows the existing margin-numeral
  device from `.claims` but is set in the prose sans at 12.5px `--ink-2`, not the 14px serif: the five
  claims are the app's promises and carry the editorial weight, while these are directions and must
  not out-rank the lead sentence above them. The counter is a plain decimal, not the claims'
  `decimal-leading-zero` — three steps are counted, not catalogued.
- **Writing as design material.** Active voice, control names exactly as macOS spells them (Open
  System Settings, Deny, Quit & Reopen, the + button), one job per line, and the failure/emptiness
  rule: the nothing-read line explains the state and does not apologise, does not offer a fix that
  does not exist, and does not use the attention colour that would make a working app look broken.

What was deliberately **not** touched:

- No palette, type stack, spacing token, `--spine`, masthead, tab bar or entrance animation change.
- No new colour, no new font, nothing downloaded, no new asset.
- `.problem` (the amber rule down the left edge) was **not** used for the nothing-read line: it is not
  a problem, and the whole point of the notice is that nothing is broken.
- `Frame`'s `.announce` line and its three-state dot were left alone; the tray already says its own
  sentence (`COPY.tray.onNothing`) and did not need a second opinion in the masthead.
- The permission step's heading, its button, its `PERMISSION_NEEDS_RESTART` branch, and the restart
  button all stay exactly as they were.
- `BLOCKERS`, `firstBlocker` and the home screen's one-sentence-one-button path are untouched — a test
  asserts the nothing-read status never produces a blocker.

## Visual verification — what was and was not done

`scripts/build.mjs --preview` has **no output override**: `previewOut` is hard-coded to
`join(app, "dist-preview")` and the script also wipes and rebuilds `app/dist` unconditionally
(including copying the native reader helper), which is outside my remit and in a tree other agents
are editing. So it was not run.

Instead the preview entry alone was built with the repo's **own** `rendererBuildOptions` and its own
`findForbiddenRendererInputs(…, PREVIEW_FORBIDDEN)` check, into a scratch folder outside `ws`
(`scratchpad/task7-preview/`, script `build-preview.mjs`). It builds clean and the forbidden-import
check passes, which proves the new code compiles into a real browser bundle and reaches nothing it
must not.

**The window itself was not looked at.** The preview needs JavaScript, and the browser pane renders a
`file://` page outside the project folder as a static snapshot only; starting a static server is
forbidden by the brief. So the layout claims above are from reading the stylesheet and the DOM the
components produce, not from a screenshot. **Nobody has yet seen these two surfaces rendered.**

## Non-ASCII audit

Compared character-by-character against `base/app/src/renderer/copy.ts`.

- **Lost: none.** The base file's single `U+2014 —` is still there.
- **Added on purpose:** `U+201C “` ×3 and `U+201D ”` ×3 (two pairs inside user-facing strings — around
  "screen and audio" and around the app file name — and one pair quoting the macOS dialog in a
  comment); `U+2014 —` ×6 and `U+00B7 ·` ×3 (comment prose, matching the punctuation `styles.css` and
  `views.ts` already use); `U+2192 →` ×2 (the System Settings path, in a comment).
- Bytes on disk verified with `hexdump`: the quotes are `e2 80 9c` / `e2 80 9d`, i.e. real characters,
  **not** backslash-u escapes that a writing tool decoded or failed to decode.
- The other changed files add no non-ASCII beyond `—` and `·` in comments (`views.ts`, `Home.tsx`,
  `Onboarding.tsx`, `styles.css`, `mockBridge.ts`, `views.test.ts`).

## Decisions worth a second opinion

1. **The step numbers moved from the strings into the list.** If the owner wants the digits inside the
   copy (so the strings read the same in a review document as on screen), it is a two-line change in
   `copy.ts` plus dropping the `.steps` counter.
2. **`views.ts` now imports `copy.ts`.** It did not before (it took only types). The brief asked for
   the mapping to be a pure function in `model/views.ts`, and a function that returns a sentence has to
   reach the sentences. The exhaustive `Record<NothingReadWhy, string>` stays in `copy.ts`, where all
   the words live.
3. **`home.since` is a separate sentence** ("Since 14:12.") rather than a clause, so the first sentence
   stays byte-identical to the one the tray uses next to it.
4. **The mock scenarios set `since` to 23 minutes ago** — past the engine's ten-minute threshold and a
   wall-clock time that is obviously not "just now".
5. **No preview scenario for the delayed "still waiting" line.** It is time-based; in the preview it
   appears by itself 20 s after `onboarding-permission` opens. A scenario for it would mean a knob on
   the clock, which is more machinery than the line is worth.

## Not done

- Nobody has looked at either surface rendered (see "Visual verification").
- The dev bundle's file name gap (see "`{appFile}`").
- No component tests, because the repo has no framework for them and the brief forbids adding one.
