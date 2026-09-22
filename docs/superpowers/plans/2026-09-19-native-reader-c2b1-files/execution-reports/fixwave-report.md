# Fix wave after the final whole-plan review — C-2b-1 (2026-09-19)

Single implementer, whole repo mine, whole suite run. Paths are relative to
`/Users/sardorastanov/techcells/asset-to-evidence/app/`. Every mutation below was applied with
`$S/exec/fixwave/mutate.py` (exact-string replacement, byte backup) and restored with `cmp` proving
the file is byte-identical again.

## INCIDENT — the dev bundle was rebuilt by a test import (my doing, item 3)

At 20:03 the first run of the new `scripts/dev-bundle.test.ts` **executed** `scripts/dev-bundle.mjs`:
that script was written as top-level statements with no `import.meta`/argv gate, so importing the
module for its pure function ran the whole program. It rebuilt, re-signed and replaced
`~/Applications/Clave Agent Dev.app` in place (its ordinary `dev:bundle` behaviour — same bundle id,
same identity, `codesign --verify --deep --strict` exit 0, `Contents/Resources/app/main.js` present).

- Nothing was launched. `pgrep -fl clave-reader` and `pgrep -fl "Clave Agent Dev"` printed nothing
  before, during and after; no bundle was opened, no helper was sent `read`/`frontWindow`, no data
  folder was touched.
- Nothing was running from the bundle at the time, so this is not the `PERMISSION_LOST` shape from
  the first-run record (that one was a replacement *under a running app*). By the script's own
  header the grant survives rebuilding and re-signing with the same certificate — but **the owner
  should confirm Screen Recording is still granted to "Clave Agent Dev" before Task 9.**
- The bundle now contains the current `dist/` and the current `clave-reader`, both of which were
  rebuilt again later by `smoke`/`build:native` in this session, so a `pnpm --dir app dev:bundle` by
  hand before the first-run session is worth doing anyway.
- Fixed at the root, in the same change: the program half is now gated on `argv[1]`, so importing the
  module can never build, sign or replace anything again. Re-running the test afterwards left the
  bundle's mtime untouched.

---

## 1. I2 — the per-run tallies are lost everywhere but `evaluate()`

**Changed**

- `src/main/engine.ts:252-263` — new `stopLoop()`: the one way a running loop is stopped and the one
  place `CAPTURE_OFF {blockers, ...loop.stats()}` is written. Returns the write so a caller that must
  not lose it can await it. Fixed codes and closed count keys only, so no privacy cost.
- `src/main/engine.ts:335` (`evaluate`) — `background(stopLoop())`, replacing the inline
  stop+log; comment moved to `stopLoop`.
- `src/main/engine.ts:551` (`startFreshFor`) — `await stopLoop()`.
- `src/main/engine.ts:730-735` (`deleteAllData`) — `await stopLoop()` at the TOP, where `loop.stop()`
  was. **Order, decided and justified in the comment:** before `DATA_DELETED` and before the files
  go, so the line is deleted along with the data it describes. Writing it after the deletion would
  re-create `app.log` — the last file this call removes — with a record of a run whose data the user
  has just asked to be erased. Awaited (not backgrounded) precisely so it cannot land after the
  removal.
- `src/main/engine.ts:769-777` (`quit`) — `const written = stopLoop();` before the drain, `await
  written;` inside the existing quit drain, just before `await savePool()`. Awaited because quitting
  is how most runs end and an unawaited write would be lost to the process exiting; it shares the
  drain the quit already does, so it costs no new wait.

**Tests** (`src/main/engine.nothingRead.test.ts`, 4 new):
"carries the run's totals out when the app quits, which is how most runs end";
"carries them out when a different account signs in under a running loop";
"carries them out before deleting all data, and writes nothing to the log afterwards" (asserts the
CAPTURE_OFF line is present in `app.log` *at the moment the file is removed*, that it precedes
`DATA_DELETED`, and that nothing is written after);
"says nothing when the loop was not running, and never writes two lines for one run".

**Revert proof** — mutation: the three new sites back to `loop.stop()` (`$S/exec/fixwave/i2.json`).
Failing: the first three of the four above (3 failed | 10 passed). Restored, `cmp` OK, 13 passed.

## 2. The notice flash after a long lock (final review M1)

**Root cause**: `userAway` is neutral for the COUNT but the CLOCK kept running, and the ~20 barren
cycles the locked screen produces before the idle clock reaches `AWAY_AFTER_SECONDS` stayed in the
streak. Both halves of the condition were then satisfied by a stretch in which nobody was there.

**Changed**

- `src/main/capture/loop.ts:129-141` (`noteOutcome`) — a `userAway` cycle now restarts BOTH halves:
  `clearStreak(); lastProductiveAt = now();`. `noticeUp` is deliberately untouched (a notice already
  up is still true; retracting it would say "reading again" about an empty chair). Comment says why.
- `src/main/capture/loop.ts:25-31` — the `CycleClass` doc, which claimed neutral cycles do nothing at
  all, now names the one that does more.

**Tests** (`src/main/capture/loop.test.ts`):
- The over-claiming comment at the old `:532` ("Walking away for lunch must never raise this") is
  corrected, and its test is now "a user who is away neither extends the streak nor carries the one
  from before it": after the empty chair, 32 barren cycles raise nothing (the ten minutes run from
  the return), and when it is finally raised the streak excludes the pre-away cycle and `since` is
  the return.
- New, the reviewer's own scenario inverted: "says nothing right after a locked lunch, however many
  barren cycles the lock itself made" — 5 min productive, lock (12 active + 8 idle barren cycles),
  30 min away, back with nothing readable: silent for the first 61 cycles / 5 minutes after the
  return, raised only once ten minutes have passed SINCE the return, with `since` after the lock.

**Revert proof** — mutation: delete the `userAway` line. Both tests fail (2 failed | 45 passed);
before the fix they failed with "expected not to be called at all, but was called 1 times", i.e. the
flash itself. Restored, `cmp` OK, 47 passed.

## 3. `dev:bundle` refuses while the app is running (M2) + the argv gate

**Changed** (`scripts/dev-bundle.mjs`, restructured with a python script, not an editor, because the
file holds backslash escapes in the generated `main.js` body):

- `:30-45` — new exported pure function `refuseForRunningApp({defaultLocation, status, output})`.
  Refuses only when the bundle is the DEFAULT one (`~/Applications`) AND pgrep definitely matched
  (exit 0 with at least one pid). Status 1 is "nothing matched"; any other status is an answer pgrep
  could not give, and that is not a running app — refusing on it would make the script unusable for
  a reason it cannot state.
- `:47` / `:105-111` — the program half is now `function buildBundle()`, gated on
  `process.argv[1].endsWith("dev-bundle.mjs")` (the same arrangement as `reader-eval.mjs`). The
  comment records the incident above as the reason.
- `:66-74` — the probe: `pgrep -f <bundle>/Contents/MacOS` via the existing `execFileSync` helper,
  run before anything is removed, written or signed; `fail("APP_RUNNING", 'quit "Clave Agent Dev"
  first')`, i.e. `DEV_BUNDLE_FAILED APP_RUNNING quit "Clave Agent Dev" first`.
- The local `const main = join(app, "dist/main.cjs")` no longer shadows a function name (wrapper
  named `buildBundle`).

**Tests** (`scripts/dev-bundle.test.ts`, new, 4): refuses on exit 0 with a pid (one or many); goes
ahead on exit 1; goes ahead on any other status and on an empty stdout; never refuses a `--out`
build whatever pgrep found. Nothing in the file runs a process.

**Revert proof** — two mutations: (a) `refuseForRunningApp` always false → "refuses when pgrep
matched…" fails; (b) drop the `!defaultLocation` half → "never refuses a --out build…" fails. Each
1 failed | 3 passed; restored, `cmp` OK, 4 passed.

**End-to-end** (allowed form only): `node scripts/dev-bundle.mjs --out $S/exec/fixwave/out/bundlecheck`
→ `DEV_BUNDLE_OK`, i.e. the restructure still builds and signs, and a `--out` build is not refused.
The scratch bundle was deleted afterwards. Nothing was launched.

## 4. Documentation and comments

- `src/main/reader/protocol.ts:58-70` — D13's missing TypeScript-side sentence: the id bound is
  `Number.MAX_SAFE_INTEGER` (2^53 − 1); the helper ignores an `id`/`cancel` target above it rather
  than answering, and reads a `budgetMs` above it as 0 ("no deadline of my own"); the client counts
  its own ids up from 0.
- `native/reader/src/protocol.rs:8-11` — `windowGone` removed from "what 2 added over 1"; it was
  added under protocol 1, in C-2a (**checked against the pre-plan backup**: `PROTOCOL_VERSION = 1`
  there, with `FailReason::WindowGone` already present). Comment fixed, code correct.
- `native/reader/src/protocol.rs:133` — "counts its ids up from one" → "up from 0, one per call"
  (`readerClient.ts:70` is `nextId = 0`). Comment fixed, code correct.
- `native/reader/src/scheduler.rs:277-289` (M4 S-a) — the promise of a clear at "every early return
  below" is narrowed to what the code does: every return down to and including step 4b clears; the
  black-frame and recogniser-error returns deliberately do not, and the comment now says why (by
  then the window has been checked three times, so the surviving entry is that same approved
  window's own text, and the 60 s idle rule still applies). Comment fixed, code left alone — the
  review itself says it is not a leak.
- `native/reader/src/scheduler.rs:208-226` (M4 S-b) — the "both halves" paragraph moved: `is_approved`
  now documents the three fields it actually compares, and the window-id half is documented on
  `still_in_front`, where it lives.

No test change: all four are comments. `build:native` recompiled clean (see below).

## 5. T5-M5 and T5-M1

**T5-M5** — `src/shell/readerLink.ts:89-95`: an `error` listener on ALL THREE pipes
(`for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", …)`), replacing the
stdin-only one. An `error` event with no listener is thrown, i.e. an uncaught exception in Electron's
main process, for a helper that is replaceable; the death itself still arrives through `exit`.
Test (`src/shell/readerLink.test.ts`, new describe "reader link: a pipe that fails"): "survives an
error on any of the three pipes, and keeps working" — each `emit("error")` must not throw, and the
link still delivers a line afterwards. Mutation: back to stdin only → that test fails
(1 failed | 15 passed). Restored, `cmp` OK.

**T5-M1** — two changes, because the finding has two halves and the reviewer's one-liner covers only
the first:
- `src/main/reader/readerClient.ts:178-184` — `drain()` is idempotent:
  `if (helper.gone || helper.retired) return;`.
- `src/main/reader/readerClient.ts:363-369` — the denied branch doubles `deniedRefreshMs` only while
  the helper is still in service (`!helper.retired && !helper.gone`), so two `denied` answers that
  arrive together cost ONE replacement and ONE doubling. Without this the drain guard alone leaves
  the wait doubled twice for one replacement.
Test (`src/main/reader/readerClient.test.ts`): "sends a helper away once, however many denied answers
land on it at the same time" — two `permission()` calls in flight on a helper older than the DOUBLED
interval (a younger one is spared by the doubling alone, which is why the first draft of this test
passed against the bug), both answered `denied`: exactly one `shutdown`, exactly one replacement, and
the next replacement due after ten seconds rather than twenty.
Mutation: remove both guards → that test fails (1 failed | 47 passed). Restored, `cmp` OK.

## 6. The load-sensitive test

`src/main/engine.test.ts:338-345` — "prompts once at the review time, only when there is something to
review" now carries an explicit 30 s timeout with a comment saying why (24 fake hours of 5 s polls
against a wall-clock deadline; it failed under load average 169 during the final review, identically
on pre-plan code). Nothing else in the test was touched; no assertion relaxed.

## 7. M5 — the eval's Chrome profile out of the repo

**Changed**

- `src/readerEval/stage.ts:1,9-38` — new pure `evalScratchPaths(tmpDir, runId)` →
  `{dir, profileDir}`: `<tmp>/clave-reader-eval-<runId>/` and its `chrome-profile/`. The doc says why
  (Chrome writes the profile, it carries user-name paths and machine state, and the repo has no
  ignore file, so the "copy `app/` without node_modules/dist/target" recipes would carry it along).
- `src/readerEval/main.ts:57-71` — the run's scratch folder, named from a fresh `randomBytes(6)`
  rather than the run's `nonce` (the nonce can come from the environment and a path is no place to
  find out what is in it), plus `removeScratch()`, which never throws.
- `src/readerEval/main.ts:94-101` — `writeScript` writes the `.command` files into the scratch folder;
  `writePreferences` writes into the scratch profile.
- `src/readerEval/main.ts:154` — `mkdirSync(scratch.dir)` once the run is configured.
- `src/readerEval/main.ts:177` — `profileDir: scratch.profileDir`, so the teardown pattern
  (`chromeTeardownPattern`, unchanged) is built from that exact path and can still match only this
  run's own `--user-data-dir=`.
- `src/readerEval/main.ts:211-213` — `removeScratch()` in the outer `finally`, so every path out (the
  three refusals included) removes the folder. The results JSON and `observe-urls.json` still go to
  `app/reader-eval/out/`.

**Tests** (`src/readerEval/stage.test.ts`): the file's `profileDir` fixture is now a temp-dir path
(it was the old repo path), plus a new describe with three tests — the folder is per run under the
OS temp directory; it is nowhere inside the repo for the REAL `os.tmpdir()`; and the teardown pattern
matches that profile and neither another run's nor the temp dir itself.

**Revert proof** — mutation: `evalScratchPaths` builds under `/checkout/app/reader-eval/out` again →
2 of the 3 new tests fail. Restored, `cmp` OK, 20 passed. The harness was never run.

---

## Final results

| Check | Result |
|---|---|
| `pnpm --dir app test` | **87 files, 1553 passed, 0 failed, 0 skipped** |
| `pnpm --dir app typecheck` | clean, exit 0 (both configs) |
| `pnpm --dir app test:native` | **231 passed, 0 failed** |
| `pnpm --dir app build:native` | `BUILD_NATIVE_OK`, **0 warnings** (forced a real recompile by touching the two edited .rs files; a cached "Finished in 0.04s" would not have re-emitted any) |
| `handshake_check.py … clave-reader` | **ALL CHECKS PASSED** |
| `pnpm --dir app smoke` | **SMOKE OK** |
| `pgrep -fl clave-reader` | prints nothing |

Byte check on all 17 touched files: **0 control bytes** other than `\n`/`\t`; the only non-ASCII
beyond the em dashes and ellipses the codebase already uses is the CYRILLIC CAPITAL LETTER A in
`scheduler.rs`, which is pre-existing, deliberate homoglyph test data (the line is byte-identical to
the pre-plan backup's). Backslash escapes in the rewritten `dev-bundle.mjs` verified present as
backslash + letter on disk.


---

# Second wave — the re-review's four residuals and two test gaps (2026-09-19)

Same rules. Before running `scripts/dev-bundle.test.ts` I re-read the argv gate in
`scripts/dev-bundle.mjs` (`:109-111`, every side effect inside `buildBundle()`); the bundle's mtime
in `~/Applications` is unchanged from 20:03 through the whole of this wave, and no path under it was
passed to anything. The eval harness was not run.

## I-W1 — an unanswered `pgrep` now REFUSES

`scripts/dev-bundle.mjs:48-71`: `refuseForRunningApp` (boolean) is replaced by
`runningAppCheck({defaultLocation, status, output})`, returning `"proceed" | "running" |
"unanswered"`. Only two answers are determinations: status 1 is "nothing matched" (proceed) and
status 0 with at least one pid is "running". Everything else — status 2, a pgrep that could not be
spawned (`status === null`), and a status 0 that names nobody — is `"unanswered"`.
`:99-101`: `if (answer === "running") fail("APP_RUNNING", ...)`, `if (answer === "unanswered")
fail("PGREP_UNANSWERED")`, i.e. `DEV_BUNDLE_FAILED PGREP_UNANSWERED` exactly, and `process.exit(1)`
before anything is removed, written or signed. `:97` maps a spawn failure to `null` rather than 2, so
the pure function sees the real shape.

Tests (`scripts/dev-bundle.test.ts`): status 0 with one pid and with two → `running`; status 1 →
`proceed`; status 2 and 127 → `unanswered`; status `null` (spawn failure) → `unanswered`; status 0
with blank or empty output → `unanswered`; and every one of 0/1/2/null at a non-default location →
`proceed`.

Revert proof: `runningAppCheck`'s last line back to `return "proceed"` (the wave-1 behaviour) →
3 failed | 8 passed (the three refusal tests). Restored, `cmp` OK.

## M-W2 — `defaultLocation` comes from the resolved destination

`scripts/dev-bundle.mjs:30-46`: new pure `resolveOutDir(argv, home)` → `{dir, defaultLocation}`. It
resolves the destination (`path.resolve`, and a `~`/`~/…` the shell did not expand) and compares it
with the resolved `~/Applications`; `buildBundle` takes both from it (`:75`). `--out` with no path
after it, `--out ~/Applications`, `--out <the same path spelled differently>` and a trailing slash are
all the default location and are all guarded; the flag itself no longer decides anything.

Tests: no `--out` → default + guarded; `--out /tmp/somewhere` → that path, not guarded; `--out` with
nothing after it → default + guarded; the default named four ways → guarded; and three neighbours
(`Applications2`, `Applications/sub`, `~/Applications-old`) → not guarded. The home in the test file
belongs to nobody and nothing is passed to the filesystem.

Revert proof: `defaultLocation: at < 0` (the wave-1 rule) → 2 failed | 9 passed. Restored, `cmp` OK.

## M-W3 — the `scheduler.rs` sentence made true to the code

`native/reader/src/scheduler.rs:286-294`: the positional claim is gone. It now names the three
returns that clear (steps 2, 3 and 4b) and the two that do not (the black frame at step 4, the
recogniser error at step 6), says why both are safe (each is reached only after the window has been
matched against `expect`, so the surviving entry is that same approved window's own text), and adds
the one the old sentence's qualifier silently excluded: the `checkpoint!()` cancel/timeout returns
clear nothing either, at any step. Comment only; `build:native` recompiled with 0 warnings.

## M-W1 — `userAway` back to NEUTRAL, with the away span excluded from the clock

`src/main/capture/loop.ts`:
- `:106-112` — `lastProductiveAt` now documented as "plus every span the user was away for", and a
  new `lastCycleAt` (when the previous cycle of this run ended).
- `:134-154` (`noteOutcome`) — `const at = now()`, `sincePreviousCycle = at - lastCycleAt`, and for
  `userAway`: `lastProductiveAt = Math.min(at, lastProductiveAt + sincePreviousCycle)` and nothing
  else. The streak keeps its count and its tally, `noticeUp` is untouched, nothing is retracted —
  D6's neutrality restored. `Math.min` is the "never past `now()`" rule: excluded time can only
  cancel time that passed.
- `:312` — `lastCycleAt` initialised in `start()` beside `lastProductiveAt`.
- `:25-31` — the `CycleClass` doc says neutral means neutral again, and names the one extra thing
  `userAway` does.

Tests (`src/main/capture/loop.test.ts`):
- (a) "says nothing right after a locked lunch…" — the reviewer's scenario, now asserting silence in
  the first half minute after the return AND through the next two and a half minutes, the raise only
  once the clock (which excludes the half hour of lunch) passes ten minutes, and `since` strictly
  between the lock and the return.
- (b) "still says it when a barren machine is used four minutes in every nine" — the re-reviewer's
  scenario, twelve stretches of 4 min present / 5 min away with nothing readable: raised exactly
  once, with ≥ 24 barren cycles in the streak and > 100 away cycles in the run.
- (c) "says nothing about two hours in which nobody was at the machine at all".
- (d) "a user who is away neither extends the streak nor ends it" — the D6 test, with its original
  name and its original claim restored: the streak survived the away stretch whole (the counts at the
  raise equal every barren cycle of the run, the pre-lunch one included), the away cycles did not
  count towards the 24, and the clock stands at the return. The other neutral-outcome test (`timeout`
  / `failed`) is untouched and green.

Revert proofs: the wave-1 reset (`clearStreak(); lastProductiveAt = at;`) → 3 failed, (b) among them;
removing the `userAway` line entirely → 2 failed, (a) among them. Restored after each, `cmp` OK.

## Test gap O1 — the `deleteAllData` order is now discriminated

Decision on the background write: with `stopLoop()` awaited at the top it is **not** a defect and
cannot happen. By the time `session.signOut()` fires `onChange` → `background(evaluate())`, the loop
is already stopped, so `stopLoop()` inside that `evaluate` returns at once and writes nothing; and it
cannot write `CAPTURE_ON` either, because `SIGNED_OUT` is in `blockers()` and `wouldRun()` is false.
The unawaited write the re-reviewer saw exists only once `stopLoop()` is moved — which is exactly
what the awaited call at the top pre-empts, and that is now said in the comment (`engine.ts:731-740`).

The discriminator: the line captured at the moment `app.log` is removed is now asserted with
`toEqual({blockers: 0, noWindow: 3})` (`engine.nothingRead.test.ts:276-280`). A line written any
later comes from the post-sign-out `evaluate` and counts `SIGNED_OUT`. Worth asserting for its own
sake, too: the tallies must be stamped with the state the run ran in.

Revert proof: `await stopLoop()` moved from the top to immediately after
`for (const path of deletablePaths(paths)) await fs.remove(path);` → "carries them out before
deleting all data…" fails with `expected { blockers: 1, noWindow: 3 } to deeply equal { blockers: 0,
noWindow: 3 }` — the confound itself, now caught. Restored, `cmp` OK.

## Test gap O2 — `drain`'s idempotence guard reached through the promotion path

New test in `readerClient.test.ts` ("permission: what works outranks what the check says"): "does not
send a helper away twice when a promotion and the refused cure land together". `HELPER_PLANNED_RESTART_READS`
reads, then a `permission()` that plans the replacement; the replacement is made ready while the call
is in flight (no promotion yet, asserted); the answer is `refused`, so `tryPromote()` runs inside
`onLine` — promoting the replacement and retiring the serving helper — before the `permission()`
continuation calls `drain()` on it. Asserts `HELPER_REPLACED`, exactly one `shutdown` on that helper,
`"unknown"` to the caller, and no third helper.

Revert proof: removing `if (helper.gone || helper.retired) return;` from `drain` → 1 failed | 84
passed, that test. (In the first wave no test bit on this guard; it does now.) Restored, `cmp` OK.

## Second-wave results

| Check | Result |
|---|---|
| `pnpm --dir app test` | **87 files, 1563 passed, 0 failed, 0 skipped** |
| `pnpm --dir app typecheck` | clean, exit 0 (both configs) |
| `pnpm --dir app test:native` | **231 passed, 0 failed** |
| `pnpm --dir app build:native` | `BUILD_NATIVE_OK`, **0 warnings** (forced recompile after the comment edit) |
| `handshake_check.py … clave-reader` | **ALL CHECKS PASSED** |
| `pnpm --dir app smoke` | **SMOKE OK** |
| `pgrep -fl clave-reader` | prints nothing |

Byte check on the eight files this wave touched: 0 control bytes besides `\n`/`\t`; no non-ASCII
beyond the em dashes already in the codebase, except the pre-existing Cyrillic А in `scheduler.rs`.
`dev-bundle.mjs` still carries its 6 literal `\n` and 2 literal `` \` `` escapes as bytes on disk,
and `~/Applications/Clave Agent Dev.app` was not modified at any point in this wave.
