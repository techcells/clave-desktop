# Re-review 5 — reader client and link (fix round 1)

Private copy: `…/scratchpad/exec/rr-5/app` (node_modules symlinked; no pnpm, no git, no bundle, no
helper ever run against a real screen). Every mutation was applied by exact-string replacement,
restored from a `.bak` taken immediately before, and the restored file proved byte-identical with
`filecmp` **and** `cmp` against `/Users/sardorastanov/techcells/asset-to-evidence/app`. Nothing under
the real repo was touched. Both probe files were deleted afterwards; final `cmp` of all nine topic
files: identical.

Baseline in the copy (`src/main/reader src/shell/readerLink.test.ts src/shell/realReader.test.ts
src/main/imports.test.ts`): **7 files, 167 passed** — matches the fixer's report. `tsc --noEmit` clean
for `tsconfig.json` and `tsconfig.renderer.json`, before and after every mutation cycle.

## Verdicts

| Finding | Verdict | Evidence |
|---|---|---|
| F1 — a mismatch is not permanent on the planned-restart path | **ADDRESSED** | `readerClient.ts:279` now `if (mismatched \|\| !current \|\| !current.ready \|\| replacement) return;`. Revert (`mismatched \|\| ` removed) → 2 failed / 106 passed: the fixer's new test *"a mismatch announced by a planned replacement is permanent too…"* (`readerClient.supervision.test.ts:173`) **and** the reviewer's own probe. Call-site audit below. |
| F2 — the `refused` cure has no `gaveUp` guard | **ADDRESSED** | `readerClient.ts:377` now `if (cureTried \|\| gaveUp) return "needsRestart";`. Revert (`\|\| gaveUp` removed) → 2 failed / 106 passed: `readerClient.test.ts:356` *"the refused cure does not take the last working helper away after the supervisor has given up"* and my ruling-adjusted probe. Deleting the whole guard (C-1 probe T2.2) → 3 failed, incl. *"restarts the helper once by itself…"*, so the one-cure-per-episode logic is still pinned. |
| F3 — client not robust against a re-entrant `onLine`; link flushes re-entrantly | **ADDRESSED, both sides** | Client: `readerClient.ts:253` `launch(slot)` assigns the slot first and registers `onExit` before `onLine`. Full revert to the old shape (slot assigned by the caller, `onLine` first) → 3 failed: the reviewer's F3 probe and both new tests (`readerClient.test.ts:775` describe). Link: `readerLink.ts:138` defers the flush on `queueMicrotask` with a `flushing` gate. Revert of the whole body → 1 failed; revert of the `flushing` gate alone → 1 failed (`expected [ '{"id":1,…}' ] to deeply equal []`, i.e. the gap line overtook the held ones). |

### F1 — audit of every spawn path (done myself, not taken from the report)

`deps.spawn()` is called in exactly one place (`readerClient.ts:255`), inside `launch()`. `launch()`
has exactly two call sites: `start()` (`:269`, guarded by `disposed || gaveUp || current`) and
`maybePlanReplacement()` (`:281`, now guarded by `mismatched`). Every other spawn route reaches one of
those two: `usable()` → `start()`/`maybePlanReplacement()` (`:287–288`), the restart timer
(`scheduleRestart` → `start`, `:115`), `gone()` → `scheduleRestart` (`:140`), `drain()` → `start()`
(`:183`), `onFocusChange` → `usable()` (`:443`). `gaveUp` is assigned in two places (`:105`, `:219`)
and cleared in exactly one (`:442`), which is itself guarded by `!mismatched`; `mismatched` (`:218`)
is never cleared. So after a mismatch both doors are shut for the life of the client.

Reviewer's scenario re-run verbatim (planned replacement announces protocol 1, then 5 `permission()`
calls): **no further spawn, exactly ONE `HELPER_PROTOCOL_MISMATCH`**. My own probe extends it past the
report's audit — after the mismatch I also let the still-serving helper die, advanced an hour, and
subscribed to focus again (the revival door): still 2 helpers ever, events exactly
`["HELPER_PROTOCOL_MISMATCH", "HELPER_EXIT"]`, `state() === "gaveUp"`, `vi.getTimerCount() === 0`.

### F2 — the `needsRestart` answer, and the rest of the branch

Tested (see above). The ruling's collateral checks: `cureTried` is **not** consumed on the `gaveUp`
path (the guard returns before `cureTried = true`), so a client that later recovers from a
*recoverable* give-up still has its one automatic restart — the episode logic is intact, and
`cureTried = false` on a good read (`:432`) is untouched. `resetDeniedRefresh()` still runs before the
guard. The answer is real at the far end: `ports/reader.ts:4` admits `needsRestart` and
`engine.ts:251` turns it into the `PERMISSION_NEEDS_RESTART` blocker, so the fixer's justification for
`needsRestart` over `unknown` holds.

### F3 — ordering, losses, duplicates, and the exit race (the ruling's list)

My probes (7, all pass on the fixed code):

- **held → gap → after**: 3 lines held, 2 written into the gap, 1 after the flush → delivered
  `A B C D E F`: order preserved, none lost, none duplicated.
- **helper exits before the microtask**: the exit callback fires first, then the held lines are still
  delivered exactly once, in order; nothing throws. In the client those lines land on a helper whose
  `gone` is already true and `onLine` returns at `:207` — no state change.
- **`spawn()` throws**: `launch` returns `false` before touching either slot, so `start()` still does
  `noteExit(); scheduleRestart()` (state `waiting`, one `HELPER_EXIT`) and `maybePlanReplacement()`
  still does `postponeReplacement()` — the plan is put off, the serving helper keeps serving, no event.
  Both probed.
- **link reports an exit synchronously during registration**: now counted (`HELPER_EXIT`), state
  `waiting`, `frontWindow()` rejects, and the restart timer really spawns again. Against the OLD
  `launch()` this probe **fails** (`expected [] to deeply equal [ 'HELPER_EXIT' ]`) — the old order
  swallowed the exit and left a dead helper in `current` for ever. The reorder therefore closes a
  second latent wedge of the same family, and closes it for the `replacement` slot too (a replacement
  that died during registration used to sit in `replacement` for ever, blocking every future planned
  restart).

The reviewer's buffer mutations were re-applied to the rewritten link and still bite: **A** (buffer
dropped) → 5 failed; **A'** (drop-oldest instead of keep-first) → 2 failed.

### The nine original C-1 probes

All nine mutations re-applied by me against today's code — **all nine bite**: T2.1 frontWindow `null`
when down (6 failed), T2.2 delete the cure guard (3), T2.3 focus from any helper (2), T2.4 no
try/catch around a subscriber (1), T3.1 promote under a call in flight (2), T3.2 keep a superseded
read's id (1), T3.3 give-up off by one (5), T3.4 mismatch counted as a crash (4), T3.5 four-second
start deadline (6). Their twelve target tests were also confirmed present and green by name with the
verbose reporter.

## New breakage in the changed lines

**None found** (nothing Critical or Important). Checked: the slot-first assignment against a
synchronous `gone()` (no double counting — `start()` no longer re-tests `current`, and `gone()` has
already done `noteExit`/`scheduleRestart`; the replacement path's `postponeReplacement()` likewise
runs once); the `HELPER_START_TIMEOUT` timer is set before the callbacks and cleared by `gone()`; the
`flushing` gate cannot strand a flush (it is cleared inside the same microtask, before delivery); the
deferred flush is a no-op in the product, where both link builders (`realReader.ts`,
`readerEval/main.ts`) register in the same turn as `spawn()` so `early` is always empty. Test diffs are
additions only, except the two link tests, whose assertions got strictly stronger.

## Observations (out of scope, no effect on the verdict)

- **O1.** New, tiny loss window in the link: while a flush is pending, an arriving line is appended to
  `early` and so is dropped if the buffer is already at `PRE_REGISTRATION_LINES_MAX` (64) — before the
  fix it went straight to the sink. Reaching it requires 64 lines buffered before registration, which
  the file's own comment already calls "the client broke its half of the contract", and which cannot
  happen in the product. Probed and documented, not a finding.
- **O2.** The reviewer's probe file asserts `expect(await refused).toBe("unknown")` for F2; the ruling
  accepted `needsRestart`, so that one line is superseded. With it adjusted, **all 10 reviewer probes
  pass** (9/10 unchanged; the single failure was exactly that assertion).
- **O3.** Minors M1–M5 of the original review (double `drain`, `retire` not clearing `healthyTimer`,
  the lone-`\r` behaviour change, the dev-report `fakeReaderHelper.ts` sentence, no `error` listener on
  `child.stdout`) were outside the rulings and are still open.
- **O4.** `protocol.ts` gained the invariant the reviewer asked for (`protocol.ts:36–41`), doc only.

## Verdict

**ALL ADDRESSED** — F1, F2, F3 (both sides). No new Critical/Important breakage.
