# Re-review — `--reveal-toolbar`, fix round 1

2026-09-21. Scoped re-review, not a fresh review: the question is whether the two Importants and the
seven Minors of `session2/reveal-flag-review.md` are closed and whether `s3/revealfix.diff` broke
anything. Section 3 (the new heartbeat) is the one place fresh eyes were asked for, and it got them.

Nothing was run against a screen. No bundle was launched, no generated script executed, no browser or
Terminal window opened, no `dist/reader-eval.cjs` and no `reader-eval.mjs` program half. All mutation
work was done on the private copy `s3/rr2/app`; every file was restored by writing the original bytes
back and `cmp`-ed clean against `app/` afterwards (`ALL RESTORED CLEAN`).

**Baseline, before and after the mutation battery:** 18 files, **1231 tests, all pass** (1173 before
this round); `tsc --noEmit` exit 0; `bytes.test.ts` and `imports.test.ts` are inside the harness
folder and green.

**Verdict up front: both Importants are closed, all seven Minors are closed in the code, and the
heartbeat cannot be abused to switch revealing on.** What is left is three missing tripwires and one
new sibling name, listed at the bottom. None of them blocks the session.

---

## 1. Important 1 — the file's lifetime

### The three mechanisms, checked against the brief's five requirements

| Required | Where | Mutation |
| --- | --- | --- |
| SIGINT/SIGTERM/SIGHUP clear the reveal file, its `.partial`, the heartbeat, and exit | `reader-eval.mjs:463-493` (`REVEAL_SIGNALS`, `installRevealSignalHandlers`), clearing through `clearRevealFile` at `:428-432`, exit 130 | **X8** (handler no longer clears) → **BIT** |
| Startup sweep deletes EVERY `observe-reveal-*`, `.partial`, `observe-alive-*` | `sweepRevealOrphans` / `isRevealOrphan` (`:435-460`), called at `:1161` before `clearRunFiles` and before the bundle is launched. The prefix `observe-reveal-` also catches `…json.partial` and `…json.claimed` | **X9** (no sweep) → **BIT**; **X10** (`observe-alive-` dropped from the predicate) → **BIT** (2) |
| Bundle writes only while the heartbeat is ≤ 5 s old; otherwise deletes and stops for the rest of the run, never resumes | `createRevealGate` (`observe.ts:595-619`): `stopped` is latched, `reveal()` returns early once set; `heartbeatFresh` at `:560` | **X5** (heartbeat ignored) → **BIT**; **X7** (`end()` stops deleting) → **BIT** |
| No heartbeat = dead | `heartbeatFresh(null)` is `false` by construction (`ageMs !== null && …`); `main.ts:244-248` returns `null` when `statSync` throws | **X6** (`null` counts as alive) → **BIT** |
| End of run deletes when the heartbeat is stale | `end()` at `observe.ts:610-616`, called from `main.ts:453` in the `finally` | **X7** → **BIT** |

### The accepted deviation, checked the way the brief asked

With a **fresh** heartbeat `end()` leaves the file for the terminal. That is only safe if the
terminal's final sweep really runs after the bundle exits and before cleanup. It does, and the
ordering is structural, not incidental:

- `running.done` is set by `waitForExit(child).then(...)` (`reader-eval.mjs:1119`) — `open -n -W`
  returns when the **bundle** has exited.
- `watchObserve`'s `while (!running.done)` loop therefore ends after the bundle is gone, and `sweep()`
  is called once more **below the loop** (`:1092`), which is the sweep that prints the last strip.
- Only then does `runEval` return, and only then does `withRevealCleanup`'s `finally` call
  `clearRevealFile` (`:504-510`, invoked at `:1167` with the single `process.exit` **outside** it).

So the last strip is printed **and** nothing survives. The deviation is sound as written.

### Every way out, and what is on disk afterwards

**Bundle side** (`main.ts`). The gate object is created at `:286`, but it touches no filesystem until
its first `reveal()`; the three refusals above the `try` therefore leave nothing whatever they do.

| Way out | `revealGate.end()` runs? | On disk afterwards |
| --- | --- | --- |
| `BAD_*` / `REVEAL_NOT_APPLICABLE` config refusal (`:271`) | no gate exists (`reveal` unknown) | nothing — no reveal file was ever named |
| `DISPLAY_TOO_SMALL` / `POSITION_OFF_DISPLAY` (`:329`) | no (above the `try`) | nothing — gate created, never written |
| `PAGE_SERVER` refusal (`:357`) | no (above the `try`) | nothing — same |
| `PROTOCOL`, `NO_GRANT` (`:374`, `:381`) | **yes** (inside the `try`) | nothing was written (no read happened); `end()` deletes if the heartbeat is stale, no-op otherwise |
| normal finish, results written (`:449`) | **yes** | fresh heartbeat → one reveal file, claimed and printed by the terminal's final sweep, then removed by it, then `clearRevealFile`. Stale heartbeat → already deleted at the first stale write, and again by `end()` |
| `--seconds` deadline inside `runObserve` | **yes** (ordinary return) | as above |
| thrown error anywhere inside the `try` | **yes** (`finally`) | as above; the outer catch at `:462` writes only `{"error":"HARNESS","code":"HARNESS"}` |
| bundle SIGKILLed / crashes | no | file may remain; `open` exits → terminal's final sweep claims and prints it, then `clearRevealFile` removes it |

**Terminal side** (`reader-eval.mjs`).

| Way out | On disk afterwards |
| --- | --- |
| bad arguments (`:1141`) | nothing of this run's — but note the orphan sweep has not run yet either, so a previous run's orphan is not cleaned by a mistyped invocation |
| `BUNDLE_MISSING`, `ENTRY_MISSING` (`:1146`, `:1151`) | same — before `outDir`, nonce and sweep |
| normal finish / `SHORTFALL` / `OPEN_EXIT` / `NO_RESULTS` / `UNREADABLE_RESULTS` | reveal file, `.partial` and heartbeat all removed by `withRevealCleanup`'s `finally` |
| thrown error in `runEval` | same `finally` runs, then the top-level `catch` prints `READER_EVAL_FAILED HARNESS` and exits 1 — no stack, no absolute paths |
| SIGINT / SIGTERM / SIGHUP | handler clears reveal + `.partial` + heartbeat, exits 130. The bundle sees the heartbeat go stale within ≤ 5 s, deletes its file and stops revealing for the rest of the run |
| SIGKILL / power loss | whatever was on disk survives until the **next** run's `sweepRevealOrphans`, which removes it whatever its nonce |

One note on the signal path that makes it better than it looks: `sweepReveal` is entirely synchronous
(rename, read, print, unlink), and Node delivers signals on the event loop, so a handler can never fire
*inside* it. The claim-and-print window is unreachable by SIGINT/SIGTERM/SIGHUP — only SIGKILL or power
loss can land in it. See Minor A below for what that leaves.

**Important 1: closed.**

---

## 2. Important 2 — the on/off gate

The reviewer's M9 mutation, redone here by hand (**X1**): in `main.ts:415`,
`writeReveal: reveal ? … : undefined` → `writeReveal: observesWindows(mode) ? … : undefined`.

**Result: FAILS** — `helper.test.ts` › "hands the reveal writer to the run only when the validated
setting says so". 1 failed / 1230 passed. The probe that left 1173 green last round now bites.

The other two halves of the lock:

- `runObserve` refuses to call the writer unless `deps.reveal === true` **and** the writer exists
  (`run.ts:950`). **X2** (dropping the `deps.reveal === true` conjunct) → **BIT**, `run.test.ts` ›
  "never calls a reveal writer it was not told to use, even when one is handed to it".
- The terminal **prints** only when the flag was given (`revealing` at `reader-eval.mjs:1042`, used at
  `:1066`) while **removal stays unconditional** (`claim` + `remove` at `:1064` and `:1072` sit outside
  the `revealing` check). **X3** (print ungated) → **BIT**; **X4** (removal made conditional) → **BIT**,
  both on "sweeps a stray strip away without printing it when the run did not ask to reveal".

Three independent conditions now stand between "the owner did not ask" and "a strip exists or is
printed", and each of the three is pinned.

**Important 2: closed.**

---

## 3. Fresh eyes on the heartbeat

**Can a heartbeat make the bundle reveal when the flag was never given? No — and it is not close.**
`revealGate` is `null` unless `reveal` is true (`main.ts:286`); `writeReveal` is `undefined` unless
`reveal` is true (`:415`); `runObserve` demands `deps.reveal === true` as well (`run.ts:950`). The
heartbeat is read *only* from inside `revealGateFor`, which an ordinary run never constructs. The
bundle never lists the out folder and never looks for an alive file on its own initiative. A heartbeat
is a *permission to keep writing*, never a permission to start. X1 and X2 pin two of the three.

Worth stating because it is mildly surprising: an ordinary (non-revealing) `observe` or `all` run
**does** write `observe-alive-<nonce>` — `beat` at `:1086` is not gated on the flag. That file is zero
bytes and carries nothing, the bundle of such a run never reads it, and the orphan sweep and
`clearRevealFile` both remove it. It is noise, not a channel.

**Clock skew and mtime.** `Date.now() - statSync(alivePath).mtimeMs`, both wall clock.

- Clock steps **backwards** → negative age → deliberately **fresh** (`heartbeatFresh` allows it,
  documented at `observe.ts:552-559`). **X19** (rejecting negative ages) → **BIT**. Correct: the
  alternative is a stepped clock silently killing the owner's diagnosis.
- Clock steps **forwards** by more than 5 s → a live terminal's heartbeat reads stale → the bundle
  deletes and stops. **Fail-closed**: the owner loses strips, never gains them.
- **mtime granularity** is the safe direction too. APFS stores nanoseconds; even a 1-second-granularity
  filesystem errs by at most 1 s against a 5 s window with a 1 s beat.
- **A heartbeat in the future** keeps the gate open. Reaching that requires either the owner's own
  stepped clock or write access to `app/reader-eval/out` — and in both cases the run must *already* be
  a revealing one, because nothing else constructs the gate. It cannot turn the channel on.

**Is the name built from the validated nonce only? Yes.** `observeAliveName(nonce)` (`observe.ts:548`)
and its twin in the CLI (`:408`) interpolate the nonce and nothing else, and the bundle's nonce has
passed `parseNonce` — exactly 12 characters, each `0-9a-f`, counted by hand (`config.ts:224-232`),
refused as `BAD_NONCE` otherwise (`:311`) before anything uses it. No traversal, no length surprise.
The terminal's own nonce is `randomBytes(6).toString("hex")`.

**Is anything other than zero bytes written into it?** No. The terminal writes the empty string
(`writeFileSync(join(outDir, name), "", {mode: 0o600})`, `:1037`), and the bundle **never reads its
contents** — only `statSync(...).mtimeMs`. So even a heartbeat written by something else can convey
nothing but a timestamp. This is not pinned by a test (see Minor C).

**No abuse path found.**

---

## 4. The Minors

| # | Required | State |
| --- | --- | --- |
| 1 | class covers C0, DEL, C1 (U+009B), bidi (U+202A-E, U+2066-9, U+200E/F, U+061C), zero-width (U+200B-D, U+2060, U+FEFF), U+2028/9, built from code points, no literal characters, both sides | **closed.** Identical range tables at `observe.ts:368-377` and `reader-eval.mjs:709-718`; every group present, U+2028/9 folded into `[0x2028, 0x202e]`. **Byte-scan of all ten touched files: zero literal unsafe code points, zero tabs, zero CR.** **X16** (bundle table back to C0+DEL) → **BIT** (5); **X17** (terminal table) → **BIT** (2), including the cross-check "agrees with the bundle's on every boundary of every range" |
| 2 | lengths in code points | **closed.** `revealLength` (`observe.ts:410`), used at `:469` and `:473`. **X15** → **BIT** |
| 3 | `.partial` cleaned | **closed.** `partialOf` on both sides; in `clearRevealFile` (`:429`), in the gate's `remove` (`main.ts:253-257`), and caught by the orphan sweep's prefix. **X11** → **BIT**; the on-disk test "takes the half-written sibling with it" asserts `readdirSync(dir)` is empty |
| 4 | reveal file 0600 and folder 0700 **asserted on disk** | **code correct, assertion partial** — see Minor B |
| 5 | claim-by-rename before printing | **closed.** `claim` at `:1032-1034`, used at `:1064`, printed from `files.claimed`, unlinked at `:1072`. **X14** → **BIT** (3) |
| 6 | top-level catch → fixed code | **closed in code** (`:1176-1182`, `READER_EVAL_FAILED HARNESS`, exit 1) — **untested**, see Minor C |
| 7 | two documentation slips | **closed.** `clearRevealFile` now named at `:401`; `REVEAL_ON` moved below the import block (`config.ts:30-31`) |

---

## 5. Unchanged by this diff

`cmp` between `s3/rv2/app` (before the fix round) and `app/` — **byte-identical**: `results.ts` (both
serialisers and the whole allow-list), `guard.ts`, `thresholds.ts`, `score.ts`, `summary.ts`,
`cases.ts`, `helper.ts`, `stage.ts`, and every other file of `src/readerEval` and `scripts/`. The
`testing/` folder is identical too, and `native/` differs only by build output under `target/`.

The diff touches exactly ten files, the same ten as last round: `config.ts`, `helper.test.ts`,
`main.ts`, `observe.ts`/`.test.ts`, `results.test.ts`, `run.ts`/`.test.ts`, `reader-eval.mjs`/`.test.ts`.

**The one `Date.now()`.** `grep -c` on `main.ts` returns **1**, at `:246`, inside `heartbeatAgeMs`,
subtracted from an mtime and compared against a 5 s bound. It reaches no reported duration: `readyMs`
and every per-case figure still come off `now()` = `Math.round(performance.now())` (`:159`), and
`helper.test.ts` now pins the count at exactly one, names the line, and separately re-asserts the
monotonic `now`. `reader-eval.mjs` contains no `Date.now()` at all.

---

## Findings

### Critical / Important

**None.**

### Minor A (new, created by the Minor 5 fix) — `.claimed` is not in `clearRevealFile`

`observeFilesFor` mints a fourth name, `observe-reveal-<nonce>.json.claimed` (`reader-eval.mjs:998`),
which holds the strips between the rename at `:1064` and the unlink at `:1072`. `clearRevealFile`
(`:428-432`) names only the reveal file, its `.partial` and the heartbeat — **not** `.claimed`. So the
signal handlers and `withRevealCleanup`'s `finally` do not remove it.

Reachable, narrowly: a throw between the rename and the unlink (an EPIPE on `process.stdout.write`
when the terminal window is closed is the plausible one) unwinds through the `finally`, which clears
the other three and leaves `.claimed` holding recognised text. SIGKILL and power loss land in the same
window. In every case the **next** run's `sweepRevealOrphans` removes it, because the prefix
`observe-reveal-` matches — so it cannot outlive the next run, and SIGINT/SIGTERM/SIGHUP cannot reach
it at all (the sweep is synchronous). **Fix: one name** — add `` `${observeRevealName(nonce)}.claimed` ``
to `clearRevealFile`'s list. It is exactly the family Minor 3 closed.

### Minor B — the 0600 on the real file, and the 0700 on the folder, are not what is asserted

The code is right: `writeAtomic(path, contents, REVEAL_FILE_MODE)` with `REVEAL_FILE_MODE = 0o600`
(`main.ts:97`, `:253`). But **X12** — dropping the third argument at the call site, so the real reveal
file is written 0644 — **leaves all 1231 tests green**. The on-disk assertion in `observe.test.ts:556`
is made against the test's *own* writer (`writeFileSync(…, {mode: 0o600})` at `:536`), not `main.ts`'s;
the only thing holding `main.ts` is `expect(source).toContain("REVEAL_FILE_MODE = 0o600")`
(`helper.test.ts:434`), which pins the **declaration**, not its **use**. This is the same shape as the
reviewer's original Important 2, one notch milder. **Fix: one line** —
`expect(source).toContain("writeAtomic(path, contents, REVEAL_FILE_MODE)")`.

The folder half is weaker than the report states. `mode: 0o700` is on the **terminal's** `mkdirSync`
only (`reader-eval.mjs:1157`); the bundle's (`main.ts:266`) still has no mode, so a bundle run without
the terminal creates it 0755. And `mkdirSync` does not change an **existing** folder: on this machine
`app/reader-eval/out` is `drwxr-xr-x` today, so the 0700 is inert until the folder is removed. **X13**
(dropping the mode) also leaves 1231 green; nothing asserts the folder's mode on disk anywhere.

Practical exposure is small — the file itself is 0600 and this is a single-user Mac — but the report's
"asserted on disk, on both sides" is not what the tree contains. Either assert it and set it on both
sides, or say plainly that the folder mode is best-effort.

### Minor C — three things that are right and untested

- **X18** (removing the whole top-level `try/catch` around `main()`) → 1231 green. Minor 6's fix has
  no tripwire; it is the same "source pin or nothing" situation as the rest of the program half.
- **X20** (writing the nonce into the heartbeat instead of `""`) → 1231 green. Zero bytes is a stated
  property of the channel and nothing holds it.
- The **out folder mode**, above.

A `reader-eval.test.ts` source assertion for the first and an `expect(beat-written-bytes).toBe(0)`
style check for the second would cost three lines between them.

### Minor D — the heartbeat does not start until the URL wait ends

`beat(files.alive)` is inside the `while` loop (`:1086`), below the URL-wait `for` loop, which runs up
to 80 × 250 ms = 20 s. So for the first stretch of a run there is no heartbeat file at all, and a
bundle that wrote a strip in that window would read "no heartbeat", conclude the terminal is dead,
delete and **stop revealing for the entire run** — silently, and with no way back.

It is safe today only because of an ordering in the other half: `main.ts:363` writes the URLs file
**before** `spawnHelper` at `:367`, so the terminal breaks out of the wait within 250 ms of the bundle
starting, while the first read is at minimum a helper cold start away. Nothing states that dependency
and nothing tests it. **Fix: one line** — call `beat(files.alive)` inside the URL-wait loop too, and
the coupling disappears.

---

## Conclusion

The diff does what it claims and breaks nothing: **1231 tests green, typecheck clean, `bytes.test.ts`
green, byte-scan clean, and the serialisers, acceptance rules, guard, thresholds, scoring and every
other file of the harness byte-identical to the pre-diff tree.** Nineteen of my twenty-one mutations
bit, including the reviewer's own M9 and every mechanism of both Importants.

- **Important 1 — closed.** Signals, orphan sweep and heartbeat each verified by mutation; every way
  out of both halves walked and tabulated; the accepted `end()` deviation checked at the ordering that
  makes it safe (final sweep after the bundle exits, cleanup after that) and found sound.
- **Important 2 — closed.** The reviewer's probe now fails, and there are three independent locks
  where there was one.
- **The heartbeat cannot switch revealing on.** Name from the validated nonce only, zero bytes,
  content never read, skew fail-closed in the safe direction, future stamps harmless because the flag
  is still required.
- **Minors 1, 2, 3, 5, 7 — closed and pinned. Minor 6 — closed, unpinned. Minor 4 — code right,
  assertion not what was asked for.**

**OK to use the flag with the owner: yes.** Nothing above changes what a revealing run puts on his
screen or leaves on his disk. Minor A is the only one I would fold in before the session, because it
is a single name in a list and it is the one residual that can still leave recognised text on disk
across a crash. Minors B, C and D are tripwires and a comment, and can wait for the session's findings.
