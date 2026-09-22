# Re-review — `--reveal-toolbar`, minors round

2026-09-21. Scoped re-review, not a fresh review: the question is whether Minors A-D of
`session2/reveal-flag-rereview.md` are closed by `s3/minors.diff` and whether the diff broke anything.
Nothing was run against a screen. No bundle was launched, no generated script executed, no browser or
Terminal window opened, no `dist/reader-eval.cjs` and no `reader-eval.mjs` program half. `reader-eval.mjs`
was imported only as a module by vitest, the same way `scripts/reader-eval.test.ts` already does.

All mutation work was done on the private copy `s3/rv3/app`, touching only `src/readerEval/**` and
`scripts/reader-eval.*` — the files another reviewer is using that same copy for (`src/core/**`) were
never opened. Every mutated file was restored by copying the backed-up original bytes back and `cmp`-ed
clean against `app/` afterwards.

**Baseline, before and after the mutation battery:** 18 files, **1249 tests, all pass** (matches the dev
report's post-round total); `tsc --noEmit -p rv3/app/tsconfig.json` exit 0, no output. `rv3/app` was
confirmed byte-identical to `app/` for all six touched files (`helper.test.ts`, `main.ts`,
`observe.test.ts`, `observe.ts`, `reader-eval.mjs`, `reader-eval.test.ts`) before any mutation began, so
the copy under review is genuinely the diff's "after" state.

**Verdict up front: all four minors are fixed and pinned by a test that fails when the fix is hand-reverted, and the diff breaks nothing else.**

---

## Method

For each minor, the exact line(s) the diff added were reverted by hand to the pre-fix shape (an
`Edit`/exact-string or Python byte-write, matching the diff's own "before" text), the named vitest command
was run and the expected test(s) were watched FAIL, then the file was restored from a pre-mutation backup
and `cmp`-ed clean against `app/`.

Command used throughout:
`node app/node_modules/vitest/vitest.mjs run --root rv3/app src/readerEval scripts/reader-eval.test.ts`

## A — `.claimed` joins every cleanup list

**Required:** `observe-reveal-<nonce>.json.claimed` in EVERY cleanup path (`clearRevealFile` -> signal
handlers and the `finally`; the bundle gate's `remove`; the startup orphan sweep).

- Reverted `clearRevealFile` in `reader-eval.mjs` back to `[observeRevealName(nonce),
  partialOf(observeRevealName(nonce)), observeAliveName(nonce)]` (dropping `.claimed`) -> **FAILS**:
  `the last names the strips can be under > clears the claimed copy as well as the file, its partial and
  the heartbeat` and `a throw that reaches the top of the program half > leaves no strip behind when the
  run it wrapped threw` (2 failed / 1247 passed).
- Reverted `revealFileNames` in `observe.ts` (the bundle side) to return only `[file,
  file+.partial]` -> **FAILS**: `observe.test.ts > every name the strips can be on disk under > is the
  file, its half-written sibling and the terminal's claimed copy` and the cross-check
  `reader-eval.test.ts > the last names the strips can be under > agrees with the bundle on what those
  names are` (2 failed / 1247 passed).

Both cleanup lists (`clearRevealFile` and the gate's `remove`, which is built from the same
`revealFileNames`) now name `.claimed`, and the two sides are cross-checked to agree. **Closed.**

## B — the 0600 pinned at the production write site

**Required:** dropping the 0600 mode at the PRODUCTION write site fails a test; both `mkdirSync` calls
carry 0700 and are pinned.

- Reverted `writeRevealFile` in `observe.ts` to call `io.writeFile(temporary, contents)` (no mode
  object) -> **FAILS**: `observe.test.ts > how the reveal file is written > is readable by the owner and
  by nobody else` (real file mode 0644 instead of 0600) and `> writes the temporary file first and the
  final name second` (the fake io throws reading `options.mode`) (2 failed / 1247 passed). `main.ts` no
  longer has anywhere to drop the mode from — it passes only `writeFileSync`/`renameSync`, no mode — so
  the previous round's hole (a call site silently omitting the argument) is structurally gone.
- Reverted `main.ts`'s `mkdirSync(outDir, {recursive: true, mode: 0o700})` to drop `mode` -> **FAILS**:
  `helper.test.ts > ... > creates the out folder for the owner alone` (1 failed / 1248 passed).
- Reverted `reader-eval.mjs`'s `mkdirSync(outDir, {recursive: true, mode: 0o700})` to drop `mode` ->
  **FAILS**: `reader-eval.test.ts > the folder the strips live in > is created for the owner alone by the
  program half` (1 failed / 1248 passed).

The mode is chosen inside `writeRevealFile` itself (production code a test runs against a real folder,
reading the mode off the file it produced), not passed in by a caller that could quietly stop passing it.
Both `mkdirSync` calls are pinned by source assertions, each in the file that owns it. **Closed** — with
the same caveat the dev report states plainly: the folder mode applies when the folder is *created*; an
existing folder keeps its mode, so this is best-effort on a machine whose `out` folder predates the fix,
not an assertion about any particular directory.

## C — top-level catch + zero-byte heartbeat

**Required:** the top-level catch reports a fixed code, exits 1, and leaves no reveal/heartbeat; the
heartbeat is written with zero bytes (writing content fails a test).

- Reverted the program half's `catch` block in `reader-eval.mjs` from `reportHarnessFailure();` back to
  the old inline `process.stderr.write("READER_EVAL_FAILED HARNESS\n"); process.exit(1);` -> **FAILS**:
  `a throw that reaches the top of the program half > is what the program half's catch calls` (source
  pin) (1 failed / 1249 passed — every behavioural test still passes because `reportHarnessFailure`
  itself is unchanged; only the source-pin that ties the catch to calling it breaks).
- Reverted `writeHeartbeat` in `reader-eval.mjs` to write a fixed non-empty string instead of
  `HEARTBEAT_CONTENTS` -> **FAILS**: `the heartbeat > holds zero bytes, and is the owner's alone`
  (statSync size 12, not 0) and `> carries nothing about the run, not even its nonce` (2 failed / 1247
  passed).

`reportHarnessFailure({write, exit})` and `writeHeartbeat(path, io)` are exported production functions a
test can call directly against a real temp folder and a fake `io`, closing the "right but untested" gap
the re-review flagged. **Closed.**

## D — the heartbeat starts before the URL wait

**Required:** the first heartbeat is written BEFORE the URL-wait loop (source-order pin + behaviour).
Usage text has the Ctrl-C line.

- Removed the `beat(files.alive);` call that sits above the `for (let tries = 0; tries <
  URLS_WAIT_TRIES...)` loop in `watchObserve` (`reader-eval.mjs`), leaving the one inside the loop in
  place -> **FAILS**: `when the heartbeat starts > has its first beat above the URL wait in the source`
  (the source-order pin: `firstBeat` now resolves to the in-loop call, which is not before `urlWait`) (1
  failed / 1248 passed).
- Separately, removed the `beat(files.alive);` call *inside* the loop, leaving only the one above it ->
  **FAILS**: `when the heartbeat starts > beats before it waits for the URL file, and again inside the
  wait` (`order.filter(...startsWith("beat"))` has length 1, i.e. it stopped beating during the 20 s
  wait) (1 failed / 1248 passed).

Both halves of the requirement — beat once before the loop, and keep beating inside it — are independently
pinned. **Closed.**

- Usage text: `USAGE` contains `"Ctrl-C in the terminal that RUNS it"` and `"pnpm or sh wrapper"`,
  matching `reader-eval.test.ts > how to stop a run > says to press Ctrl-C in the terminal that runs it`.
  Not separately reverted (a documentation string, no logic to mutate), but present and matches T16 in the
  dev report. **Closed.**

---

## What was not re-litigated

Per the brief, `guard.ts`, `thresholds.ts`, results/progress serialisers, acceptance rules and scoring are
unchanged by this diff — `minors.diff` touches exactly six files (`helper.test.ts`, `main.ts`,
`observe.ts`/`.test.ts`, `reader-eval.mjs`/`.test.ts`), all six of which are accounted for above. The two
Importants and the heartbeat-abuse question from `reveal-flag-rereview.md` are unchanged by this round and
were not re-tested here — they are outside what this diff touches.

## Conclusion

**Baseline and post-round-of-mutations: 18 files, 1249 tests, all pass; `tsc --noEmit` clean.** Eight hand
reverts, one per requirement inside each of the four minors (two each for A, B(x3 combined here as
B-write/B-bundle-folder/B-terminal-folder), C, D), every one produced exactly the expected failure and
nothing else, and every file was restored to be byte-identical to `app/` afterward (`cmp` clean on all six
touched files).

- **Minor A — closed.** `.claimed` is now named on both sides (`revealFileNames` in `observe.ts` and
  `reader-eval.mjs`, cross-checked equal) and is in `clearRevealFile`'s list, so the signal handlers, the
  `finally`, and the bundle gate's `remove` all take it with them.
- **Minor B — closed.** The mode lives inside `writeRevealFile`, a production function a test calls
  against a real folder — there is no call site left where the argument can be silently dropped, closing
  the exact hole the re-review's X12 exploited. Both `mkdirSync` calls carry `mode: 0o700` and are pinned
  by source assertions, with the folder-mode caveat (applies on creation only) stated rather than
  overclaimed.
- **Minor C — closed.** `reportHarnessFailure` and `writeHeartbeat` are now exported, independently
  testable production functions; both are pinned by direct tests plus a source assertion that the real
  catch block calls the former.
- **Minor D — closed.** The heartbeat's first write is pinned above the URL-wait loop in the source, and
  a behavioural test confirms it keeps beating through the wait rather than going silent for up to 20 s.

**ALL ADDRESSED**
