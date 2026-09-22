# Desktop engine (plan B-1): execution and review record (2026-09-17)

Plan `docs/superpowers/plans/2026-09-17-desktop-engine.md` was executed as written (17 tasks, 458 tests,
every file byte-identical to the plan). The plan's code had been run before, but never independently
reviewed, so every task then got a review with reproducing probes. The reviews found real defects;
they were fixed test-first in five rounds, each re-reviewed by probe. **Now: 545 tests / 38 files pass,
typecheck clean.** The code no longer matches the plan's code blocks (listed at the end of the plan).

## What the reviews found and what was fixed

| Area | Found | Fixed |
|---|---|---|
| Log | filters accepted free text (`Priya.said.the.password` as a key, a name as a code) | closed lists `LOG_CODES` / `LOG_COUNT_KEYS`, checked at run time |
| Storage | a real read error (EACCES/EIO) made the app fail to start; one shared `.tmp` name raced; `.tmp` orphans; encrypted files deleted when the keychain was merely unavailable | read errors count as unreadable; unique temp names with clean-up; saves serialised per file; an unavailable cipher never deletes |
| Settings | failed save rejected; `get()` handed out the live object | `SAVE_FAILED` result; defensive copy |
| Taxonomy | after one failure, retried on every 10-second tick; "unchanged" with no cache counted as success | 15-minute retry interval; treated as failure |
| Scheduler | "yesterday" wrong around DST days; a failed save lost or (later) repeated the prompt | local-calendar arithmetic; one prompt per review day per process |
| Power | callback fired before the function returned | never at construction; the engine reads the initial state |
| Session | memory changed before the save; a refresh could overwrite a NEW user's session with the OLD user's; double refresh; sign-out could fail to sign out | save-then-assign; generation counter bumped first in signIn; one shared refresh; sign-out always clears memory and retries the file removal |
| Uploader | an accepted statement could vanish from every local record; upload under the wrong user if flush ran before the owner check; a retry after a user switch re-sent user A's batch as user B (Critical, found by an end-to-end probe) | sent log first, outbox second, de-duplicated; owner checked in flush and again around the send; `withSession` refuses to retry across an identity change |
| Download | two quick `start()` calls corrupted the partial file | synchronous lock; size check before hashing; `start()` never rejects |
| Model client | stale conversations after a crash spawned hosts and could hit a reused id; silent host leaked requests; a failed open left a 2.7 GB host resident | host generations; per-request timeout (90 s, above the core's limits); idle timer re-armed on every path |
| Self-test | a timed-out run kept using the host | late opens refused, conversation closed exactly once |
| Capture loop | a reader promise that never settled killed the loop for good; clock/idle errors charged to the reader | every reader call raced against a timeout, late results never ingested; idle errors never count against the reader. **The privacy rule held under every probe: no read without a fresh `mayCapture`, no text from an unchecked window.** |
| Engine | user A's pending statements visible to and uploadable by user B; `updateSettings` could forge the self-test gate; delete-all left files and a permanent blocker; unhandled rejections (fatal in Electron main); revoked permission never noticed, then a flaky permission call flapping capture; review prompt counting hidden items | owner-stamped pool; narrow `UserSettingsPatch`; quiesced delete-all; `background()` for every fire-and-forget; guarded listeners; permission re-read each tick, only real answers change it; owner-scoped counts; `takeCounters()` exposed |
| Tests | the "log holds codes only" leak case was vacuous; nothing asserted the adversarial fixtures exist | drives a run that logs, mutation-checked; asserted |

## Decisions made on the owner's behalf

1. An expired token while offline keeps the user signed in locally; only a real refusal signs out.
2. One review prompt per calendar day, even if the review time is moved later that day.
3. When a different account signs in: the previous account's pending pool and unsent outbox are discarded,
   and its exclusions, excluded sites, review time and capture switch are reset to the defaults.
4. `devReader` replays fixtures only; the spec's ".txt folder" mode was skipped.
5. The model file is re-hashed on every launch (integrity over speed); B-2 may cache a verified marker.

## Open items (none blocks plan B-2; the first is a must before two accounts share one Mac)

1. **Settings are not owner-stamped.** The reset in decision 3 hangs off the pool's owner, so when `pool.bin`
   is missing (a corrupt file is deleted by design, the keychain was locked at launch, a save was refused)
   user B inherits user A's exclusions and capture switch. A refused reset write also dead-ends in
   `STORAGE_PROBLEM` until relaunch. Fix: `ownerUserId` in `settings.json` and a reset retried until written.
2. A different account signing in discards the previous account's approved-but-unsent statements silently.
   Keep the behaviour (never upload to the wrong profile); add a log code and say so in the spec.
3. `STORAGE_PROBLEM` is one flag for three files; a success on one can clear another's problem for a tick.
4. A reader whose `onFocusChange` registers and then throws leaves one listener and one timer.
5. For sub-project C: answer `failed`, not `black`, when Screen Recording is revoked; `read()` can be
   re-entered after main gave up on a call (documented in `ports/reader.ts`).
6. Deferred minors from the task reviews are in the execution ledger
   (`.superpowers/sdd/2026-09-17-desktop-engine/progress.md`).
