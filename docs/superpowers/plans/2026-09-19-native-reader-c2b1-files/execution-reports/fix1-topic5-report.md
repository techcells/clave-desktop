# Fix round 1 — topic 5 (reader client and link minors)

Baseline before any edit: `src/main/reader src/shell/readerLink.test.ts src/shell/realReader.test.ts
src/main/imports.test.ts` → **7 files, 162 passed**. After: **7 files, 167 passed** (5 new tests; two
existing link tests adjusted for the deferred flush). `pnpm typecheck` clean (both tsconfigs).
Mutation driver kept at `…/exec/fix1-t5-mutate.py`; every mutation was restored and the file compared
byte-for-byte (`filecmp`, shallow=False) with the copy taken before it — all `restored-identical: True`.

---

## F1 — a mismatch is now permanent on the planned-restart path too — ADDRESSED

**Test first.** `src/main/reader/readerClient.supervision.test.ts:173` — "a mismatch announced by a
planned replacement is permanent too: no later call starts another" (drives the mismatch through the
*replacement* path, then makes 5 more calls). On the unfixed code: `expected [ … ] to have a length of
2 but got 7` — one spawn per call, exactly the reviewer's probe.

**Fix.** `src/main/reader/readerClient.ts:279` (`maybePlanReplacement`): the guard is now
`if (mismatched || !current || !current.ready || replacement) return;`, with a comment saying why the
planned restart stays due (the mismatch branch retires the helper before `gone()`, so
`postponeReplacement()` is skipped) and that `start()`'s `gaveUp` guard is the other door.

**Audit of every `launch()` call site** (there are exactly two, and every spawn path reaches one of
them): `start()` — held by `gaveUp`, which the mismatch branch sets and which `onFocusChange` only
clears when `!mismatched`; `maybePlanReplacement()` — now held by `mismatched`. The restart timer
(`scheduleRestart` → `start`), revival by subscription (`onFocusChange` → `usable` → `start` /
`maybePlanReplacement`) and `drain()`'s `start()` all pass through those two. So after a mismatch no
path spawns again for the life of the client.

**Revert proof.** Mutation `mismatched || ` removed → **BIT**: 1 failed, 82 passed — "a mismatch
announced by a planned replacement is permanent too". The other half of the decision still bites too:
mutation D (drop `!mismatched` from `onFocusChange`) → "a mismatch is permanent: switching capture off
and on again does not start the same binary again".

**Decided:** guard on `mismatched` only, not on `gaveUp`. A planned restart during a *recoverable*
give-up is wanted — `current` is still serving, and a warm replacement is how it gets renewed — and
guarding it would be a behaviour change no finding asks for.

---

## F2 — the `refused` cure has the same `!gaveUp` guard as the denied refresh — ADDRESSED

**Test first.** `src/main/reader/readerClient.test.ts:356` — "the refused cure does not take the last
working helper away after the supervisor has given up", the twin of the denied test below it and the
same give-up-while-serving construction (4 counted crashes, enough reads to plan a replacement, fifth
crash promotes it). On the unfixed code: `expected 'unknown' to be 'needsRestart'`, and the client
dropped to `gaveUp` with no process at all.

**Fix.** `src/main/reader/readerClient.ts:377` — `if (cureTried || gaveUp) return "needsRestart";`,
with the comment that mirrors the denied branch's.

**Decided — `needsRestart`, not `unknown`.** The cure *is* a fresh helper and `start()` refuses to
launch one once we have given up, so the only remaining cure is the user restarting the app — which
gets both a helper without the stale grant and a supervisor that has not given up. `needsRestart` is
therefore true and actionable, and it is the one permission value that surfaces:
`engine.ts:246` turns it into the `PERMISSION_NEEDS_RESTART` blocker, which `Onboarding.tsx:224`
shows. `unknown` would fall through to `NO_PERMISSION` — not what we know (the system check said yes)
— and a reader that needs a restart would say nothing at all, exactly the silent-death shape the
denied guard was written against.

**Revert proof.** Mutation `|| gaveUp` removed → **BIT**: 1 failed, 82 passed — "the refused cure does
not take the last working helper away after the supervisor has given up".

---

## F3 — both sides — ADDRESSED

### Client side (the wedge)

**Test first.** New top-level describe `src/main/reader/readerClient.test.ts:775`, "reader client: a
link that delivers lines from inside `onLine`", with a link that says its piece re-entrantly:

- "a mismatching `ready` delivered during registration stops the client for good, and says so" —
  pins the whole wedge: `state()` must be `gaveUp` (was `"starting"` for ever), `frontWindow()` must
  **reject** (it answered `null` for ever, so the loop never counted a failure), one spawn, one
  `HELPER_PROTOCOL_MISMATCH`, `vi.getTimerCount() === 0`. On the unfixed code:
  `expected 'starting' to be 'gaveUp'`.
- "a replacement whose `ready` arrives during registration takes over, and says so" — the second,
  quieter half the reviewer noted: `HELPER_REPLACED` and the old helper's `shutdown`. On the unfixed
  code: `expected [] to deeply equal [ 'HELPER_REPLACED' ]`.
- "a good `ready` delivered during registration leaves the client ready" — a regression guard; it
  passed before the fix as well, and is kept because it is the case the product actually has.

**Fix.** `src/main/reader/readerClient.ts:253` — `launch(slot: "current" | "replacement"): boolean`
puts the new helper into its slot **before** registering the callbacks, and registers `onExit` before
`onLine`; `start()` and `maybePlanReplacement()` call it with their slot instead of assigning the
result. A line handed back during registration is then handled against a helper that is already in
the client's hands, so `gone()` records it, `tryPromote()` sees it, and the caller can no longer
assign an already dead helper to `current`. Dense comment at the function saying exactly that.

**Revert proof.** Mutation: slot assignment moved after the two registrations and `onLine` registered
before `onExit` (the old order) → **BIT**: 2 failed, 81 passed — the mismatch-wedge test and the
replacement-takeover test.

### Link side (never deliver from inside `onLine`)

**Fix.** `src/shell/readerLink.ts:135` — `onLine` sets the sink and flushes the held lines on a
`queueMicrotask`; a new `flushing` flag makes lines that arrive in that gap queue behind the held ones
(`splitter` callback, `readerLink.ts:113`), so ordering is preserved whatever the timing.

**Test.** `src/shell/readerLink.test.ts:39` — renamed to "delivers them, in order, on a later turn —
never from inside `onLine`": asserts nothing is delivered from inside the registration, then emits a
line synchronously into `stdout`'s `data` listener (which lands in the gap) and asserts all three
arrive in the order the helper wrote them. "holds a bounded number of them…" gained one `await
flushed()` for the same reason; nothing else about it changed.

**Revert proofs.** (a) old synchronous body → **BIT** (1 failed, 14 passed); (b) `flushing` dropped
from the splitter callback only → **BIT** (the out-of-order line). The reviewer's own mutations on
this code still bite after the rewrite: A (buffer never delivered) → 2 failed; A' (drop-oldest) → 1
failed ("holds a bounded number of them, keeping the first…").

**Not done, outside my file set:** the reviewer asks for the invariant to be stated in the `HelperLink`
doc — that is `src/main/reader/protocol.ts`, which I do not own. The invariant is written out in full
at both ends I do own (`readerClient.launch`'s comment and `readerLink.onLine`'s). Whoever owns
`protocol.ts` should add one sentence to the `HelperLink` contract: a link must not call the `onLine`
sink from inside `onLine` — deliver held lines on a later turn.

---

## The nine original C-1 probes

Their tests are ordinary tests in this suite and all run green (verbose reporter, names confirmed one
by one): "while waiting to restart there is no helper at all…", "restarts the helper once by itself…",
"focus events from a replacement that has not taken over are ignored", "ignores focus events from a
helper that is not ready", "tells every subscriber, survives one that throws…", "after enough reads,
warms a replacement up…", "a read that was superseded and never answered does not hold the swap up",
"gives up after five unplanned exits…", "does not take the last working helper away after the
supervisor has given up", "never uses a helper that speaks another protocol…", "a mismatch is
permanent…", "allows a cold start of a minute and a half…".

## Bytes

Every edited file re-checked on disk with python3 after the edits: no byte < 0x20 other than `\n`/`\t`,
and every backslash escape (`\n`, `\r`) still present as a backslash form. The only non-ASCII bytes are
the pre-existing `í`/`✓` in the link tests.

## Not touched

`src/main/testing/fakeReaderHelper.ts` and `src/shell/testing/fakeHelperProcess.mjs` needed no change;
the new tests use the existing `ready(protocol?)`, `lastId()` and `answerLast()`. Minors M1–M5 were
outside the rulings and were left alone.

## Addendum — `protocol.ts` added to my file set

`src/main/reader/protocol.ts:35` — the `HelperLink` contract now states the invariant: a link MUST NOT
call the `onLine` sink from inside `onLine`; held lines are delivered on a later turn, in order, ahead
of any line that arrives meanwhile, with a pointer to `launch` for the client's half. Exact-string
edit, doc comment only; bytes checked on disk (no control bytes, only the pre-existing em dashes),
`src/main/reader src/shell/readerLink.test.ts` → 5 files, 98 passed, typecheck clean on both tsconfigs.
