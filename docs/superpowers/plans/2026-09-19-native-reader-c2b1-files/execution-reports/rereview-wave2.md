# Re-review of the SECOND fix wave — C-2b-1 (2026-09-19)

Scope: the four residuals (**I-W1, M-W2, M-W3, M-W1**) and the two test gaps (**O1, O2**) of
`$S/exec/rereview-wave.md`, against `$S/exec/fixwave2.diff` (8 files) and the "Second wave" section of
`$S/exec/fixwave-report.md`.

Private copy: `$S/exec/rr-wave2/app`, `diff -rq` clean against
`/Users/sardorastanov/techcells/asset-to-evidence/app` at the start, after every single mutation
(`cmp` each time) and at the end. Nothing under the repo was modified. No bundle was launched or
replaced, no path under `~/Applications` was passed to anything, the helper never read a real screen,
the eval harness was never run.

## The dev-bundle test: why it was safe to run, checked again from scratch

Read `scripts/dev-bundle.mjs` whole. Module top level is: five imports, three `const`s, two exported
pure functions (`resolveOutDir`, `runningAppCheck`), and the gate at `:136-138`
(`if (process.argv[1] && process.argv[1].endsWith("dev-bundle.mjs")) buildBundle();`). Every side
effect — `rmSync`, `mkdirSync`, `cpSync`, `writeFileSync`, `codesign` — is inside `buildBundle()`.

Not taken on trust. Before importing anything I ran my own throwaway probe under vitest in the private
copy, which forced a failure so the runner would print the value:

```
argv: ["/Users/…/bin/node",
       "/Users/…/node_modules/.pnpm/vitest@5.0.1_…/node_modules/vitest/dist/workers/forks.js"]
```

A test file runs inside that worker, so an import of `dev-bundle.mjs` from a test sees exactly that
`argv[1]`; it cannot end with `dev-bundle.mjs`. Second, independent net: the private copy has no
`app/dist` and no `native/reader/target`, so a fired gate would hit `fail("HELPER_MISSING")` /
`fail("DIST_MISSING")` and `process.exit(1)` **before** the pgrep probe and long before the first
`rmSync`. The probe was deleted; `scripts/dev-bundle.test.ts` then ran 11 passed, printing neither
`DEV_BUNDLE_OK` nor `DEV_BUNDLE_FAILED` — `buildBundle` never ran, in any run of this re-review.

## Verdicts

| # | Item | Verdict | Evidence |
|---|---|---|---|
| I-W1 | an unanswered `pgrep` refuses with `DEV_BUNDLE_FAILED PGREP_UNANSWERED`, before anything is removed/written/signed; three-way pure function | **ADDRESSED** | §1 |
| M-W2 | `defaultLocation` derives from the RESOLVED outDir | **ADDRESSED** (two spelling holes remain, both stated in §2) | §2 |
| M-W3 | the `scheduler.rs` comment is exactly true to the code | **ADDRESSED for the reported defect**, one new enumeration gap (**M-W4**, Minor) | §3 |
| M-W1 | `userAway` NEUTRAL per D6; away time excluded by advancing `lastProductiveAt`, never past now | **ADDRESSED** — all four probes (a)–(d) behave as required | §4 |
| O1 | moving `stopLoop()` after the deletion now fails a test | **ADDRESSED** | §5 |
| O2 | removing `drain`'s idempotence guard now fails a test | **ADDRESSED** | §6 |

Whole-copy state after all restores:

| Check | Result |
|---|---|
| vitest, whole suite | 87 files, **1562 passed, 1 skipped** (the skip is the helper-binary test; the copy has no `native/…/target`) |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `tsc --noEmit -p tsconfig.renderer.json` | exit 0 |
| `build-native.mjs --test` | **231 passed, 0 failed**, no `warning:` lines |
| byte check, all 8 touched files | 0 control bytes besides `\n`/`\t`; non-ASCII limited to em dash, horizontal ellipsis, rightwards arrow and the pre-existing Cyrillic А in `scheduler.rs` (present in `$S/exec/prewave2` too) |
| `dev-bundle.mjs` generated-`main.js` writer line | **byte-identical** to the pre-wave2 line (4 literal `\n`, 2 literal `` \` ``) |
| stale references to the old `refuseForRunningApp` | none anywhere in `src/`, `scripts/`, `reader-eval/` |

---

## §1 — I-W1: the unanswered `pgrep`

**The fix.** `runningAppCheck({defaultLocation, status, output})` → `"proceed" | "running" |
"unanswered"` (`dev-bundle.mjs:66-71`). Only two determinations: `status === 1` → proceed;
`status === 0` with a non-blank line → running. Everything else, including `status === null` (the
catch at `:98` now maps a spawn failure to `null` rather than 2), falls through to `"unanswered"`.
`:99-101`: `running` → `fail("APP_RUNNING", …)`, `unanswered` → `fail("PGREP_UNANSWERED")`, and
`fail` is `console.error("DEV_BUNDLE_FAILED", code, detail ?? ""); process.exit(1)` (`:82`).

**The ORDER, read line by line.** Between the top of `buildBundle` and the refusal (`:73-101`) there
is nothing but `const` bindings, `existsSync` checks, the definition of `run`, and the `pgrep` call
itself. The first removal is `rmSync(bundle, …)` at `:111`; the first writes are `mkdirSync` `:113`,
`cpSync` `:114`, `writeFileSync` `:121-122`, `cpSync` `:123`; the first signature is `codesign` at
`:126`. The refusal is therefore before everything, and also before `plutil -extract` /
`REFUSING_TO_REPLACE` and before the codesigning-identity lookup. ✅

**Revert proof.** `runningAppCheck`'s final `return "unanswered"` → `return "proceed"` (the wave-1
behaviour): `scripts/dev-bundle.test.ts` → **3 failed | 8 passed** (the three refusal tests).
Restored, `cmp` byte-identical.

**Is the pattern specific enough?** The pattern is `join(bundle, "Contents/MacOS")`, an ERE.

- *The script's own node process cannot match it.* Its command line carries at most the `--out`
  argument, and the pattern is always that plus `/Clave Agent Dev.app/Contents/MacOS` — strictly
  longer than anything on the command line. `pgrep` also excludes itself. Probed: a node process that
  calls `pgrep -f <path>` with that path in its own `-e` argument gets **status 1**.
- *An unrelated process that holds the path DOES match.* Probed with a scratch path (nothing under
  `~/Applications` was involved): `tail -f "<scratch>/Clave Agent Dev.app/Contents/MacOS/clave-reader"`
  running → `pgrep -f "<scratch>/…/Contents/MacOS"` → **status 0** with its pid. So an editor, a
  `tail`, a `codesign` in flight with that path in its arguments makes the script refuse. **Does it
  matter:** refusing is the safe direction, and it cannot refuse *for ever* — the owner closes that
  process. What they see is `DEV_BUNDLE_FAILED APP_RUNNING quit "Clave Agent Dev" first`, which in
  that case names the wrong culprit; the cost is a minute of confusion, never a replaced bundle.
- *An unanswerable `pgrep` blocks the build until it is fixed.* Probed: an invalid ERE gives status 2
  (`pgrep: Cannot compile regular expression`), so a home directory containing `[` would refuse every
  default-location build for ever. What the owner sees is `DEV_BUNDLE_FAILED PGREP_UNANSWERED ` and
  nothing more — pgrep's own status and stderr are discarded by `run`. Both points are the ruling's
  accepted cost, not a defect; see O-B and O-C below for the two one-line narrowings.

---

## §2 — M-W2: `defaultLocation` from the destination

`resolveOutDir(argv, home)` (`:39-46`) resolves the destination and compares it with
`resolve(join(home, "Applications"))`. `buildBundle` takes `outDir` **and** `defaultLocation` from it
(`:75`), so the flag no longer decides anything.

**Revert proof.** `defaultLocation: dir === defaultDir` → `defaultLocation: at < 0` (the wave-1 rule):
**2 failed | 9 passed** ("guards a `--out` with no path after it…", "guards a `--out` that names the
default location…"). Dropping only the `~` expansion (`const named = given;`): **1 failed**. Restored
after each, `cmp` byte-identical.

**The dispatch's list, each checked by evaluating the real expression** (no filesystem involved):

| Spelling | `dir` | guarded |
|---|---|---|
| no `--out` | `/Users/nobody/Applications` | **yes** |
| `--out` with nothing after it | `/Users/nobody/Applications` | **yes** |
| `--out ~/Applications` | `/Users/nobody/Applications` | **yes** |
| `--out ~/Applications/` (trailing slash) | `/Users/nobody/Applications` | **yes** |
| `--out /Users/nobody/../nobody/Applications`, `…/Applications/./` | `/Users/nobody/Applications` | **yes** |
| `--out /tmp/somewhere`, `~/Applications-old`, `…/Applications2`, `…/Applications/sub` | as given | no (correct) |
| `--out ~` | `/Users/nobody` | no (correct — a different destination) |

Two spellings still reach the granted bundle with the guard off, both because the function is
deliberately pure (`resolve` normalises `.`/`..`/slashes but does not touch the disk):

- **a symlink**: `--out /tmp/apps` where `/tmp/apps → ~/Applications`;
- **case**: `--out ~/applications` on the case-insensitive default APFS volume.

Neither is reachable by accident, both would need `realpathSync` (a filesystem call) or a
case-insensitive compare to close, and the first wave's hole (`--out` with no path — a plausible
typo) is gone. Recorded as **O-A**, not as a defect against the ruling.

---

## §3 — M-W3: the `scheduler.rs` comment

The reported defect is gone: the positional claim ("the returns down to and including step 4b. The
two after it…") is replaced by named steps, and the black frame is now correctly placed at step 4,
before 4b. The parenthetical about the `checkpoint!()` returns is also right — none of them clears,
at any step, including the one at 9b which runs after `cache.store`.

Each claim checked against `handle_read`:

| Claim (`scheduler.rs:288-296`) | True? |
|---|---|
| steps 2 and 3 clear | ✅ `:307, :315, :321, :328` (step 2, four returns) and `:349, :357, :365` (step 3, three) |
| step 4b clears | ✅ `:388` |
| the black frame at step 4 does NOT clear | ✅ `:372-374` |
| the recogniser error at step 6 does NOT clear | ✅ `:404-406` |
| both are reached only after the window was matched against `expect` | ✅ `is_approved` at `:326` precedes both; `clear_unless(window.window_id)` at `:331` means the surviving entry is that window's own text |
| the `checkpoint!()` returns clear nothing, at any step | ✅ `:271-279`, and the 9b checkpoint is below `cache.store` |
| the 60 s idle rule in `worker` still empties the entry | ✅ `worker.rs:129` `CACHE_IDLE_CLEAR` |

### M-W4 (Minor, new) — the list of clearing returns omits step 8b

The sentence reads "*The same clear follows every early return below that means 'we do not know what
is in front, or we may not read it': **steps 2, 3 and 4b**.*" There is a fourth: the second
`still_in_front` check at **step 8b** (`scheduler.rs:454-457`) also `cache.clear()`s and returns
`WindowGone`, and it is exactly a return of that meaning. The behavioural claims are all true —
"exactly two returns do NOT clear" is still correct — but the enumeration is not complete, and step
8b's own comment block (`:445-453`) makes a point of that very clear being the thing that enforces
"text from a window that failed the re-check is never retained". Fix: "…: steps 2, 3, 4b and 8b."

---

## §4 — M-W1: `userAway` neutral, the away span off the clock

**The fix.** `loop.ts:135-137` takes `at = now()` once and keeps `lastCycleAt`; `:153`
`if (outcome === "userAway") { lastProductiveAt = Math.min(at, lastProductiveAt + sincePreviousCycle); return; }`.
No `clearStreak()`, no `endStreak()`, `noticeUp` untouched — D6 neutrality restored; `stats[outcome]`
is still incremented at `:260` before `noteOutcome`, so `userAway` still appears in `CAPTURE_OFF`.
`start()` initialises `lastCycleAt` beside `lastProductiveAt` (`:311-312`).

**Revert proofs.** Wave-1 body (`clearStreak(); lastProductiveAt = at;`) → **4 failed** (three of the
wave's own tests plus my own probe (b)). Line removed entirely (pre-wave-1) → **3 failed** (including
my own probe (a)). Restored after each, `cmp` byte-identical.

**My own probes** (written in the private copy, run, deleted —
`src/main/capture/rrprobe2.away.test.ts`, six cases, all green on the fixed code):

| Probe | Result |
|---|---|
| (a) one barren minute at the desk → 30 min locked/away → back | nothing at the moment of return, nothing five minutes later; raised once at ten minutes of **presence**. `since` ≤ the raise moment, ≥ 10 min before it, and dated **inside** the away stretch |
| (b) 4 min present / 5 min away, thirteen times (nearly two hours), nothing readable | raised **exactly once**; `since ≤ raise` and at least 10 min before it |
| (c) empty chair for two hours | **never** raised, > 200 `userAway` cycles |
| (d) 9 barren minutes, `stop()`, an hour away, `start()`, 9 more minutes | not raised (the old nine do not carry over), raised at 11 min of the new run — the clock starts with the run |
| (e) a present barren machine | still raised at the ten-minute mark, unchanged |
| (f) a productive cycle after an away stretch | `onReadingAgain` fires; an away stretch alone retracts nothing |

**Can `lastProductiveAt` exceed `now()` or move backwards?** No, on both counts, and the invariant is
stronger than the `Math.min`: `lastCycleAt` is set to `at` at the **top of every** `noteOutcome`, and
`lastProductiveAt` is only ever set to `at` or to `min(at, …)`, so `lastProductiveAt ≤ lastCycleAt`
holds always and `lastProductiveAt + sincePreviousCycle ≤ at` follows. Monotonic `now()` therefore
makes the clamp unreachable — and indeed **no test bites** when I replace `Math.min(at, x)` with `x`
(55 passed). It is a correct belt-and-braces guard, not dead: it is what bounds the damage if
`lastCycleAt` is ever stale or `Date.now()` steps backwards (an NTP correction, which would also move
the clock backwards in the pre-wave code). Same for `lastCycleAt = now()` in `start()`: removing it
also breaks no test, and by the invariant above it cannot change an outcome (on the first cycle of a
run both readings give `at`). Honest, redundant, cheap. Recorded as **O-D**.

**Across `stop()`/`start()`**: `start()` resets `streak`, `noticeUp` (via the `endStreak` in `stop`),
`lastProductiveAt` and `lastCycleAt`, so nothing of the previous run's clock survives — probe (d).
A late cycle of the old generation calling `noteOutcome("stopped")` after a restart only sets
`lastCycleAt = now()`, which it already is.

**Is `since` still a sensible "Since HH:MM"?** It can never be in the future, and never later than the
raise: `lastProductiveAt ≤ at` by construction, and the raise additionally requires
`at - lastProductiveAt ≥ BARREN_AFTER_MS`, so `since` is always at least ten minutes before the
notice. What it is **not** any more is a moment at which anything happened: after a lunch it is dated
inside the away stretch (probe (a) asserts exactly that — `lockedAt < since < backAt`). The sentence
it feeds ("reading is on and nothing has come through since 12:41") is still true, but 12:41 is now a
bookkeeping time, not the last read. That is inherent in the ruling's design (excluding spans has to
move the anchor somewhere), and it belongs in the D6 addendum next to the `empty` and `stats()` lines.

### Residual R-1 (Minor, pre-existing shape, now instant again) — a gap in which NO cycle ran is still counted as presence

Only a `userAway` **cycle** excludes time. A stretch in which the loop ran no cycles at all — a
machine that slept — is excluded only if the first cycle after the wake happens to see idle ≥ 5 min.
If the machine is woken by a keypress, it does not: idle is 0, the cycle is barren, and
`at - lastProductiveAt` is the whole night.

Probed (written, run, deleted — `src/main/capture/rrprobe2.sleep.test.ts`): 2.5 barren minutes at the
desk (past the 24 cycles, under the 10 minutes — 24 cycles is only two minutes at `ACTIVE_POLL_MS =
5 s`), six minutes away, then `vi.setSystemTime(+8 h)` with no timer firing, then idle 0 and one
poll → **the notice is raised on that very first cycle, dated before the sleep**.

This is not introduced by this wave — pre-wave-1 behaves identically — but it is a small regression
against wave 1, which cleared the streak and so delayed the same (still 8-hours-stale) notice by
about 2.5 minutes. The narrowing that covers both this and the lunch case is to treat *any* gap much
larger than the poll interval as time the loop was not measuring — i.e. advance `lastProductiveAt` by
`sincePreviousCycle` whenever that span exceeds, say, `IDLE_POLL_MS * 2`, whatever the outcome — and
it is a C-2b-2 measurement question rather than something to change under a re-review.

---

## §5 — test gap O1: the `deleteAllData` order

The discriminator is `expect(off[0]!.counts).toEqual({blockers: 0, noWindow: 3})`
(`engine.nothingRead.test.ts:276-280`), replacing a `toMatchObject` that ignored `blockers`.

**Mutation applied by hand** (not the fixer's word for it): `await stopLoop()` moved from the top of
`deleteAllData` to immediately after `for (const path of deletablePaths(paths)) await fs.remove(path);`
→ `src/main/engine.nothingRead.test.ts` → **1 failed | 12 passed**, with exactly the confound:

```
AssertionError: expected { blockers: 1, noWindow: 3 } to deeply equal { blockers: +0, noWindow: 3 }
```

Restored, `cmp` byte-identical. The gap is closed.

**The fixer's reasoning about the background `evaluate` is correct**, checked in the code and not only
in the test: `stopLoop()` (`engine.ts:258-262`) returns `Promise.resolve()` when `!loop.running()`,
and `evaluate` (`:316-337`) writes only through `background(stopLoop())` on the `!wanted &&
loop.running()` branch or `log.event("CAPTURE_ON")` on the `wanted && !loop.running()` branch. With
the loop already stopped and awaited at the top, `session.signOut()`'s `onChange →
background(evaluate())` finds `loop.running() === false` (no write) and `wanted === false`, because
`blockers()` contains `SIGNED_OUT` (`:266`) — no write either. The single `CAPTURE_OFF` the test sees
is the awaited one, which is why `blockers` is 0 rather than 1.

## §6 — test gap O2: `drain`'s idempotence guard

New test: "does not send a helper away twice when a promotion and the refused cure land together"
(`readerClient.test.ts:261-291`). Mutation: `if (helper.gone || helper.retired) return;` removed from
`drain` (`readerClient.ts:183`) → over the three reader-client files (67 tests) → **1 failed**, that
test. Restored, `cmp` byte-identical.

The wave-1 guard it complements is still pinned: removing `!helper.retired && !helper.gone` from the
denied-refresh condition (`:369`) fails "sends a helper away once, however many denied answers land on
it at the same time". Both halves now bite, each on its own test.

---

## New breakage introduced by this wave

**None Critical, none Important.** Checked, in the changed lines only:

- `runningAppCheck` / `resolveOutDir` replace `refuseForRunningApp`: no other caller anywhere
  (`grep` over `src/`, `scripts/`, `reader-eval/`), and `package.json`'s `dev:bundle` still runs
  `node scripts/dev-bundle.mjs`, so the gate still fires for a real run and `pnpm … -- --out X`
  still reaches `process.argv` as `["node", ".../dev-bundle.mjs", "--out", "X"]`.
- `outDir` is now absolute where it used to be whatever was typed; `mkdirSync`/`cpSync`/`join` are
  indifferent to that, and a relative `--out` still lands under the cwd.
- `loop.ts`: the only behaviour change is the `userAway` line; every other outcome path is
  byte-identical apart from `at` replacing repeated `now()` calls, which also removes a (harmless)
  skew between the two readings in the barren branch.
- `engine.ts`: comment only. `scheduler.rs`: comment only (`build:native --test` recompiled, 231
  passed, 0 warnings).
- The three test files add assertions and cases; no existing assertion was weakened. The one renamed
  test ("a user who is away neither extends the streak nor **ends** it") now asserts the *stronger*
  D6 claim — the streak survives the away stretch whole.

## Observations (out of scope, no effect on the verdict)

- **O-A** — `resolveOutDir` is pure, so a symlinked path to `~/Applications`, or `~/applications` on
  the case-insensitive boot volume, still writes to the granted bundle with the guard off (§2).
- **O-B** — the guard runs before `existsSync(bundle)`, so on a machine whose `pgrep` cannot answer,
  even the **first** build at the default location is refused, though there is no grant to protect
  yet. `if (existsSync(bundle))` around the refusal would narrow it.
- **O-C** — `fail("PGREP_UNANSWERED")` prints no detail: pgrep's status and stderr are dropped by
  `run`. `fail("PGREP_UNANSWERED", \`status ${probe.status}\`)` would cost nothing and tell the owner
  whether they are looking at a missing binary or a bad pattern. Neither `PGREP_UNANSWERED` nor
  `APP_RUNNING` appears in `docs/HANDOFF.md` or in the C-2b-1 plan's Step 2, where the owner meets
  them — a documents-stage line, alongside the `reader-eval/out` one still open from M5.
- **O-D** — the `Math.min` clamp and `lastCycleAt = now()` in `start()` are both unreachable under the
  invariant `lastProductiveAt ≤ lastCycleAt`; no test bites when either is removed (§4). Correct and
  worth keeping, but a later reader should know they are guards, not mechanism.
- **R-1** — a sleep gap is counted as presence when the wake comes with input (§4): the notice can
  appear on the first cycle after the lid opens, dated to the night before.
- **O-E** — `chromeTeardownPattern` still has no end anchor (carried over from the first re-review,
  untouched by this wave).

## Verdict

All six items of the dispatch are **ADDRESSED**. Two new Minor items to record, neither of them a
regression in behaviour: **M-W4** (the `scheduler.rs` clearing-return list omits step 8b) and **R-1**
(a sleep gap still counts as presence; pre-wave-1 behaviour, 2.5 minutes earlier than wave 1's).
