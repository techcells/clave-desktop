# Re-review of the fix wave after the final whole-plan review — C-2b-1 (2026-09-19)

Scope: the seven items of the dispatch, against `$S/exec/fixwave.diff` (17 files), the findings in
`$S/exec/final-review.md` (I2 + minors) and `$S/exec/task-5-review.md` (T5-M1, T5-M5).
Private copy: `$S/exec/rr-wave/app`, byte-identical to `/Users/sardorastanov/techcells/asset-to-evidence/app`
at the start (`diff -rq` clean) and restored to byte-identical after every mutation (`cmp` each time).
Nothing under the repo was modified. No bundle was launched, no helper read a real screen, the eval
harness was never run, no path under `~/Applications` was passed to anything.

## The dev-bundle test: why it was safe to run

Read `scripts/dev-bundle.mjs` whole (`$S/exec/rr-wave/app/scripts/dev-bundle.mjs`). Module top level is
now: four imports, three `const`s (`app`, `NAME`, `BUNDLE_ID`), the exported pure
`refuseForRunningApp`, and the gate. Every side effect — `rmSync`, `cpSync`, `mkdirSync`,
`writeFileSync`, `codesign` — is inside `buildBundle()`, called only from
`if (process.argv[1] && process.argv[1].endsWith("dev-bundle.mjs"))` (`:109-111`).

I did **not** take that on trust. Before importing anything I ran a throwaway probe test under vitest
in the private copy that only printed `process.argv[1]`:

```
ARGV1 = ".../node_modules/vitest/dist/workers/forks.js"
ARGV  = ["/Users/.../bin/node", ".../vitest/dist/workers/forks.js"]
```

Test files execute in that worker, so an import of `dev-bundle.mjs` from a test sees exactly that
`argv[1]`; it cannot end with `dev-bundle.mjs`. Second, independent safety net: the private copy has no
`app/dist` and no `native/reader/target`, so even a fired gate would hit
`fail("HELPER_MISSING")`/`fail("DIST_MISSING")` and `process.exit(1)` **before** the first `rmSync`.
The probe was deleted, then `scripts/dev-bundle.test.ts` ran: 4 passed, and the run printed neither
`DEV_BUNDLE_OK` nor `DEV_BUNDLE_FAILED`, i.e. `buildBundle` never ran.

## Verdicts

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | I2 — one `stopLoop()` at every site, awaited in `quit`, written before the data in `deleteAllData` | **ADDRESSED** | see §1 |
| 2 | The notice must not be raised from stale time after a lock/away stretch | **ADDRESSED**, with a consequence to record (M-W1) | see §2 |
| 3 | `dev:bundle` refuses while the app runs | **PARTLY ADDRESSED** — an indeterminate `pgrep` allows the replacement **silently** (I-W1), and `--out` with no path bypasses the guard at the default location (M-W2) | see §3 |
| 4 | Comment / documentation fixes are accurate | **PARTLY ADDRESSED** — three of four are exactly right; the `scheduler.rs` step-ordering sentence is still wrong (M-W3) | see §4 |
| 5 | T5-M5 (three pipes) and T5-M1 (`drain` idempotent, doubling not applied twice) | **ADDRESSED** | see §5 |
| 6 | Only the timeout of the one engine test changed | **ADDRESSED** | see §6 |
| 7 | Eval Chrome profile + `.command` files in a per-run temp folder, removed on every exit | **ADDRESSED** | see §7 |

Whole-suite state of the private copy after all restores:

| Check | Result |
|---|---|
| vitest, whole suite | 87 files, **1552 passed, 1 skipped** (the skip is the helper-binary test; the copy has no `native/.../target`) |
| `tsc --noEmit`, `tsconfig.json` | exit 0 |
| `tsc --noEmit`, `tsconfig.renderer.json` | exit 0 |
| `build-native.mjs --test` | **231 passed, 0 failed**, no `warning:` lines |
| byte check, all 17 touched files | 0 control bytes besides `\n`/`\t`; non-ASCII limited to em dash, MINUS SIGN (matching `protocol.rs`'s pre-existing `2^53 − 1`), horizontal ellipsis, rightwards arrow, and the pre-existing Cyrillic А in `scheduler.rs` / `í`,`✓` in `readerLink*` (both present in `$S/exec/prewave`) |
| `scripts/dev-bundle.mjs` generated-`main.js` writer | byte-identical to the pre-wave line after stripping indentation; 4 literal `\n`, 2 literal `` \` `` intact |

---

## §1 — I2

**Sites.** `grep -rn "loop\.stop()"` over `src/`: the only production occurrence is inside `stopLoop`
(`src/main/engine.ts:260`). All four stop sites go through it — `evaluate` `:335`
(`background(stopLoop())`), `startFreshFor` `:551` (`await`), `deleteAllData` `:735` (`await`, at the
top), `quit` `:772` (`const written = stopLoop()`, `await written` at `:777`). No bare `loop.stop()`
remains outside tests.

**Revert proof.** Put the three new sites back to `loop.stop()` and dropped `await written`
(`$S/exec/rr-wave/i2.json`): `src/main/engine.nothingRead.test.ts` → **3 failed | 10 passed**, the three
being the quit, the sign-in and the deleteAllData tests. Restored, `cmp` byte-identical.

**A failure to write the log cannot block deletion or quitting.** `createLog`
(`src/main/log.ts:47-66`) wraps both `fs.size` and `fs.append` in `try { … } catch { }` and resolves;
nothing outside that try can throw except the pure code. Confirmed with a probe I wrote, ran and
deleted (`src/main/rrprobe.logfail.test.ts`): with `h.fs.append` throwing on every call,
`deleteAllData({removeModel:false})` and `quit()` both resolve — 2 of 2. (A third probe records that an
`fs.append` that *never settles* does hold `quit` open; that is not new — `deleteAllData` already
awaited `log.event("DATA_DELETED")` before the files go, and `quit` already awaits `savePool()` right
below the new line.)

**Nothing re-creates `app.log` with a record of the erased run.** After the removal loop
(`engine.ts:755`) the remaining calls are `sentLog.load()`, `downloader.removeAll()`,
`pipeline.configure`, `startTimers()` and `await evaluate()`. `evaluate` can only write `CAPTURE_OFF`
through `stopLoop`, which returns at once because the loop is not running; and it cannot write
`CAPTURE_ON` because `session.signOut()` has run, so `blockers()` contains `SIGNED_OUT` and
`wouldRun()` is false.

**The new `await` in `startFreshFor` opens no window.** It is called from `signIn` (`:612`) after the
new user is in session and before `ensureSettingsOwner` stamps, so `settingsOwnerPending()` is true and
`wouldRun()` is false for the whole of the await: a tick that lands inside it cannot restart the loop.

### Observation O1 — the **order** in `deleteAllData` is not pinned by a test

I moved `await stopLoop()` from the top of `deleteAllData` to immediately after the
`for (const path of deletablePaths(paths)) await fs.remove(path);` line. All 13 tests in
`engine.nothingRead.test.ts` still **passed**. The reason: `await session.signOut()` (`:744`) fires
`session.onChange` → `background(evaluate())` (`:516`), which finds the loop still running and writes
the `CAPTURE_OFF` line itself — before the deletion, by luck of the fake timers.

The code is right, and the explicit awaited call at the top is what makes it right in production: it
replaces that *unawaited background* write, which would otherwise race the removal loop. But the test
the fixer's report credits with pinning the order does not discriminate the two. If the order is to
stay guaranteed, the third test needs an assertion that bites on it — e.g. record the app.log content at
removal time *with the session listener suppressed*, or assert that `CAPTURE_OFF` precedes
`SETTINGS_RESET_FOR_NEW_OWNER`/the sign-out's own effects. Not a defect in the fix.

---

## §2 — the notice after a lock / away stretch

**The fix.** `src/main/capture/loop.ts:140`:
`if (outcome === "userAway") { clearStreak(); lastProductiveAt = now(); return; }`, ahead of the
neutral branch. Per-run `stats` is unaffected: `stats[outcome]` is incremented at `:247`, before
`noteOutcome` is called at `:248`, so a `userAway` cycle still appears in `CAPTURE_OFF`.

**Revert proof.** Deleting the line: `loop.test.ts` → **2 failed | 45 passed** ("a user who is away
neither extends the streak nor carries the one from before it", "says nothing right after a locked
lunch…"). Restored, `cmp` OK. Each half is separately load-bearing: keeping only
`lastProductiveAt = now()` → 1 failed; keeping only `clearStreak()` → 2 failed.

**`noticeUp` handling is right.** `userAway` deliberately does not retract a notice that is already up.
That is correct on both sides: the sentence ("reading is on and nothing has come through since T") stays
true across an empty chair, `if (noticeUp) return;` (`:146`) still prevents a second raise for the same
streak, and the two things that do retract it — the first productive cycle (`endStreak`) and `stop()`
(`:307`) — are untouched. `engine.ts:237`'s `if (!loop.running()) return;` still guards the late raise.

**Against D6.** The plan's D6 (plan line 42) reads: "Neutral: `userAway`, `stopped`, `timeout`,
`failed`. The notice is raised … after ≥ 24 barren cycles AND ≥ 10 minutes **since the last productive
cycle**". Neutrality there is about the streak COUNT: the clock is defined against the last *productive*
cycle, and `userAway` is not productive. The fix makes a `userAway` cycle behave like a productive one
for **both** halves (count cleared, clock restarted) while still not retracting the notice. That is a
real change to D6, not a clarification of it, and it is larger than either option the final review
offered ("add the away span to `lastProductiveAt`", or "end the streak silently"). D6 already needs a
dated addendum for `empty` and for per-run `stats()` (final review §8.6); this is the third line of it.

### M-W1 (Minor, new) — a genuinely barren machine can now hide for ever

Because the clock restarts at `now()` on **every** `userAway` cycle (and a continuously-away user
produces one every 30 s), the ten minutes can never accumulate for someone who stops touching the
machine for `AWAY_AFTER_SECONDS` (5 min) at least once in every `BARREN_AFTER_MS` (10 min).

**Worst case: unbounded — there is no upper bound in minutes.** The smallest qualifying pattern is
about five idle minutes per ten. Probe (written, run, deleted —
`src/main/capture/rrprobe.away.test.ts`): nothing readable for two straight hours, with the user cycling
4 min at the desk → 1 min idle → 5 min away, twelve times: **`onNothingRead` is never called**. The
control in the same file (same two hours, never idle) raises it once, as it should. With the
`userAway` line removed (pre-wave behaviour) the same probe **fails** — the notice was raised.

This is a realistic shape, not only a pathological one: reading a long document or watching a video in
an app the reader cannot read produces exactly "no input for five minutes, nothing readable".

Recommended narrowing, if this matters to C-2b-2's measurements: carry the presence time rather than
resetting it — remember when the away stretch began and advance `lastProductiveAt` by the away span,
which is the final review's own option (a). That fixes the flash identically (the locked-lunch test
passes with the clock half alone) and still reports a barren machine after ten minutes of *presence*.
Either way, the behaviour belongs in the D6 addendum.

---

## §3 — `dev:bundle` refuses while the app is running

What is right: the probe runs before anything is removed, written or signed (`dev-bundle.mjs:66-74`);
the decision is a pure exported function, unit-tested with no process run anywhere in the test file;
exit status 1 is treated as "nothing matched" and allows the build; an exit 0 with only blank output
allows it; a `--out` build is never refused. Revert proofs: forcing `refuseForRunningApp` to `false`
fails "refuses when pgrep matched…"; dropping the `!defaultLocation` half fails "never refuses a --out
build…". `scripts/dev-bundle.test.ts` → 4 passed on the unmutated code.

### I-W1 (Important, the dispatch's own requirement) — an indeterminate `pgrep` allows it, silently

`refuseForRunningApp` returns `false` for **every** status other than 0, and the catch at `:73` maps a
spawn failure (`error.status === null`, e.g. `ENOENT`) to status 2. So if `/usr/bin/pgrep` is missing,
un-executable, or fails for any reason it cannot express as "no match", the script proceeds to delete
and replace `~/Applications/Clave Agent Dev.app` **and prints nothing at all**: no warning, no code, no
line in the output. The guard degrades to no guard without saying so.

The dispatch's ruling for this item is explicit — "any other failure of pgrep … must not silently
allow". The fixer's stated rationale (refusing "would make the script unusable for a reason it cannot
state") is a reasonable answer to *whether to refuse*; it is not an answer to *saying nothing*.
Minimum fix, one line before the build proceeds:

```js
if (probe.defaultLocation && probe.status !== 0 && probe.status !== 1) {
  console.error("DEV_BUNDLE_WARN", "PGREP_UNANSWERED", `status ${probe.status}: the running-app check did not run`);
}
```

This is the step on which the Screen Recording grant was lost once already (`PERMISSION_LOST`), and it
is run by hand immediately before Task 9, so a silent degradation is exactly the failure that matters.

### M-W2 (Minor, new) — `--out` with no path bypasses the guard at the default location

`defaultLocation` is `outIndex < 0` (`:71`), but `outDir` falls back to `~/Applications` when `--out` is
present with **no** following argument (`:50`: `outIndex >= 0 && process.argv[outIndex + 1] ? … : join(homedir(), "Applications")`).
So `pnpm --dir app dev:bundle -- --out` writes to the default bundle with the guard disabled. The same
hole is open for an explicit `--out ~/Applications`. One-line fix:
`const defaultLocation = outDir === join(homedir(), "Applications");`, which makes the flag irrelevant
and the *destination* decisive — which is what the comment already claims.

---

## §4 — comments and documentation

| Fix | Verdict | Check |
|---|---|---|
| `src/main/reader/protocol.ts:58-70`, D13's TS-side sentence | **accurate** | bound = `Number.MAX_SAFE_INTEGER`, enforced at `:81` (`Number.isSafeInteger` + `≥ 0`); Rust ignores an over-bound `id`/`cancel` `target` (`protocol.rs:90-95` via `non_negative_integer`, `?` drops the whole request) and reads an over-bound `budgetMs` as 0 (`protocol.rs:98` `.unwrap_or(0)`), which `scheduler.rs:142-143` documents as "no deadline of its own"; client ids `nextId = 0` / `nextId++` (`readerClient.ts:70, 318`) |
| `native/reader/src/protocol.rs:8-11`, `windowGone` not new in protocol 2 | **accurate** | pre-plan backup `$S/exec/c2b1-backup/app/native/reader/src/protocol.rs`: `PROTOCOL_VERSION: u64 = 1` (`:14`) with `FailReason::WindowGone` already present (`:349`) |
| `native/reader/src/protocol.rs:134`, ids "up from 0, one per call" | **accurate** | matches `readerClient.ts:70, 318` |
| `native/reader/src/scheduler.rs:208-226` (M4 S-b), the "both halves" split | **accurate** | `is_approved` compares exactly the three named fields (`:214`); the window-id half is now documented on `still_in_front`, which is where `now.window_id == captured.window_id` lives (`:226`) |
| `native/reader/src/scheduler.rs:277-294` (M4 S-a), narrowing the clear promise | **M-W3 below** | |

### M-W3 (Minor, new) — the narrowed `scheduler.rs` sentence is still wrong about where the exceptions are

The new comment says: *"The same clear follows every early return below … — the returns down to and
including step 4b. **The two after it** do NOT clear … A black frame (**step 4**) and a recogniser that
failed (step 6)."*

The black-frame return is at **step 4** (`scheduler.rs:366-368`), i.e. *before* step 4b
(`:379-384`) — not after it. So the sentence contradicts itself within four lines, and its positional
claim ("down to and including 4b" all clear) is false for the one return inside that range that does
not clear. The semantic claim is fine; only the ordering is wrong. It is the same class of drift M4 S-a
was raised about. Fix: "— the returns down to and including step 4b, apart from the black frame at
step 4. That one and the recogniser error at step 6 do NOT clear, and deliberately: …".

(The `checkpoint!()` timeout returns also do not clear, at every step; they are outside the sentence's
own qualifier — "we do not know what is in front, or we may not read it" — so I do not count them.)

---

## §5 — T5-M5 and T5-M1

**T5-M5.** `src/shell/readerLink.ts:89-95`: `for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", …)`.
Revert to stdin-only → "survives an error on any of the three pipes, and keeps working" fails
(**1 failed | 15 passed**). Restored, `cmp` OK. Adding an `error` listener to the two read ends does not
change flow (`child.stderr.resume()` still precedes it) and the death still arrives through `exit`.

**T5-M1.** Both halves present: `drain` returns early for a helper already `gone`/`retired`
(`readerClient.ts:183`), and the denied branch only doubles `deniedRefreshMs` while the helper is still
in service (`:369`). Mutations, against `readerClient.test.ts` + `.supervision` + `.leak` (66 tests):

| Mutation | Result |
|---|---|
| both guards removed | **1 failed** — "sends a helper away once, however many denied answers land on it at the same time" |
| only the doubling guard removed | **1 failed** — the same test |
| only the `drain` guard removed | **66 passed** |

Restored, `cmp` OK. The doubling half is the one the finding's "one replacement, one doubling" turns on,
and it is pinned. I traced the interleavings by hand: `p.settle` runs inside `onLine`, and each
`permission()` continuation is a microtask queued after that synchronous block, so in every ordering the
second answer finds `helper.retired === true` (set by `retire`, reached either through `drain` or
through `leaveIfDrained`) and does nothing. Exactly one `shutdown`, one replacement, one doubling.

### Observation O2 — the `drain` guard is live but untested

No test bites on it, because the doubling guard now stops the second `denied` before it reaches
`drain`. It is not dead code, though: the `refused` cure calls `drain(helper)` after its `await`
(`:392`), and `tryPromote()` — which runs inside `onLine` just before that continuation — can have
retired that same helper in the meantime; without the guard that path sends a second `shutdown` and
restarts the kill timer. Correct as written; worth a test if the shape is ever touched again.

---

## §6 — the load-sensitive engine test

`src/main/engine.test.ts` has exactly one hunk in the whole fix diff (`@@ -337,7 +337,12 @@`): five
comment lines and `});` → `}, 30_000);`. No assertion, timer advance or expectation was touched, and
nothing else in the file changed. **ADDRESSED.**

---

## §7 — the eval's scratch folder

- `evalScratchPaths(tmpDir, runId)` (`src/readerEval/stage.ts:38-41`) → `<tmp>/clave-reader-eval-<runId>/`
  and `<that>/chrome-profile`. Pure, exported, tested.
- Per run, not per machine: the id is a fresh `randomBytes(6).toString("hex")` (`main.ts:67`), not the
  run's `nonce` — right call, the nonce can come from the environment.
- `.command` files → `join(scratch.dir, name)` (`main.ts:94`); Chrome preferences →
  `join(scratch.profileDir, …)` (`:99`); the staged Chrome's `--user-data-dir` → `scratch.profileDir`
  (`:177`). `grep` over `src/readerEval/*.ts` and `scripts/reader-eval.mjs`: **no** remaining
  `join(outDir, "chrome-profile")` anywhere.
- Removed on every exit path: `removeScratch()` sits in the `finally` of the outer
  `app.whenReady().then(…)` (`main.ts:210-214`), which wraps the whole of `main()` — the `OUT` throw, the
  `configured.ok` refusal, `PROTOCOL`, `NO_GRANT`, the results path and the `catch`. `rmSync(…, {recursive: true, force: true})`
  inside its own `try`, so it never throws and never fails a finished run. (A SIGKILL of the harness
  leaves the folder behind — in the OS temp directory, which is the whole point of M5.)
- Teardown still matches only this run's own `--user-data-dir=`: `chromeTeardownPattern` is unchanged
  (`stage.ts:94-96`, `[-]-user-data-dir=${escapeEre(profileDir)}`) and is built from `deps.profileDir`,
  i.e. the run's own scratch path (`run.ts:188, 395`). The new test asserts it matches this run's
  profile, not another run's, and not the temp directory itself.
- Results still in `app/reader-eval/out/`: `outFile` and `observe-urls.json` both use `outDir`
  (`main.ts:50, 130, 145`), untouched.
- `stage.test.ts`'s `profileDir` fixture moved off the old repo path to a temp path, so the staging
  tests now exercise the real shape.

**The harness was never run**, in any mode.

Still open from M5, and out of this wave's scope by the dispatch: adding `reader-eval/out` and
`.dev-launch.json` to the "copy `app/` without node_modules/dist/target" recipes and to HANDOFF's
leftovers — a documents-stage item alongside I1.

---

## New breakage introduced by the fix wave

None Critical. None in behaviour outside the items above. Specifically checked:

- `evaluate` now computes `blockers()` *before* `pipeline.signal("captureOff")` (it was after).
  `blockers()` is a pure read of session/taxonomy/downloader/settings/permission/model/storage state;
  `pipeline.signal` changes none of them. No effect.
- `quit()` calls `blockers()` for the first time, after the five unsubscribes and `stopPower.stop()`.
  All the getters it reads survive those. No effect.
- `startFreshFor`'s new first `await` sits between `loop.stop()` and `previous.signal("captureOff")`.
  Covered above: `wouldRun()` is false for its whole duration, and the function already awaited
  `saving` and `pool.clear()` further down.
- The `drain` early return cannot orphan `current`: a helper is never `current` when `retired`
  (every `retire` call site moves it out first) or when `gone` (`gone()` reassigns `current` at `:136-141`).
- Swallowing `error` on stdout/stderr makes a torn-down read pipe look like a silent helper instead of
  an exception — which is the stated intent, and `exit` still settles everything.

## Observations (out of scope, no effect on the verdict)

- **O1** — the `deleteAllData` ordering is not discriminated by its test (§1).
- **O2** — the `drain` idempotence guard is reachable but untested (§5).
- **O3** — `chromeTeardownPattern` has no end anchor, so `--user-data-dir=<mine>-something` would also
  match. Unchanged by this wave, and unreachable given a fixed-length random run id.
- **O4** — the fixer's report says the quit write is awaited "inside the existing quit drain"; it is
  started before the drain race and awaited immediately after it. Same cost, slightly different words.

## Verdict

Six of the seven items are addressed. Item 3 is **partly** addressed and misses the dispatch's own
constraint (**I-W1**: an indeterminate `pgrep` allows the replacement with no message), with a second
small hole in the same guard (**M-W2**). Item 4 carries one new documentation inaccuracy (**M-W3**).
Item 2's fix works, but its cost — a barren machine that can go unreported indefinitely — is undocumented
and larger than either option the review offered (**M-W1**), and D6 needs the addendum.
