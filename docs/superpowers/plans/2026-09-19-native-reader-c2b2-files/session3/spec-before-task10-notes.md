# Native reader (sub-project C): design

Status: written 2026-09-18 after a section-by-section brainstorm with the owner, every section
approved. Self-reviewed. Awaiting the owner's read-through before a plan is written.
Phase 0 spikes done 2026-09-18, all six passed; see section 10.

Builds on: `docs/implementation-plan.md` (standing decisions on capture, recognition, permissions),
`docs/superpowers/specs/2026-09-17-desktop-app-design.md` (sub-project B, built and hardened),
`docs/superpowers/reviews/2026-09-17-desktop-engine-review.md` and
`2026-09-18-desktop-shell-review.md` (requirements B put on C), `app/src/main/ports/reader.ts`
(the contract) and `app/src/main/capture/loop.ts` (its only caller).

## 1. Purpose and scope

C replaces the stand-in `app/src/standins/devReader.ts` with a real reader for macOS: it reports the
front window, captures that one window, recognises its text with the system's built-in recognition,
drops the image, and answers. It implements the existing `Reader` port without changing it. The
capture loop, the port, the constants and the core are not changed.

The reader decides nothing. It never sees the exclusion rules. Main asks the core `mayCapture`
before every read and re-checks the window after it; that stays the only privacy gate.

### Decisions made in this brainstorm

| # | Decision |
|---|---|
| 1 | Oldest supported system: macOS 14. One capture path: ScreenCaptureKit's one-shot screenshot of a single window id |
| 2 | The spec is written with decision branches; the spikes are phase 0 of the plan; the plan proper is written after they report, without branches |
| 3 | No Apple Developer account yet. Spikes use a stable self-signed local certificate. Re-verifying under a Developer ID is an exit item carried to packaging; C is accepted without it |
| 4 | Recognition quality is measured on staged windows with known text, plus a short manual checklist run by the owner. No real screen text is ever saved |
| 5 | The native piece is a standalone Rust helper program speaking JSON lines over stdin/stdout, not a napi-rs addon. Reasons: crash isolation, no dependence on `ELECTRON_RUN_AS_NODE` (which can then be disabled in shipped builds), its own event loop for focus notifications, about 10 MB of memory, and the same protocol serves Windows and Linux later |

Note 2026-09-18 (phase 0, P3): decision 5's "about 10 MB of memory" was a brainstorm estimate and is
wrong. Measured resident memory over a 1,000-read soak was flat at 58.0–63.8 MB for the Rust probe
(61.7 MB at 1,000 reads) and 44.3–53.3 MB for the Swift probe (46.5 MB at 1,000 reads). The decision
itself stands — crash isolation, no `ELECTRON_RUN_AS_NODE`, its own event loop, one protocol for
later platforms — but the memory budget to carry is ~60 MB, not ~10 MB. See section 10.

Standing decisions this design keeps (from `docs/implementation-plan.md`): screenshots only, no
accessibility layer; Screen Recording is the only permission; focused window only; accurate
recognition mode, language correction off, grayscale input; the image is never written to disk and
is dropped as soon as recognition returns; unknown means no capture.

### Out of scope

Windows and Linux readers; audio; a per-app cap on recognitions (section 5.4); signing and
notarisation; clave-back (sub-project D).

## 2. Architecture

```
main (TypeScript)                                helper (Rust, one program)
┌───────────────────────────────┐   stdin/stdout  ┌──────────────────────────┐
│ capture loop (unchanged)      │   JSON lines    │ protocol  (read/write)   │
│        │ Reader port          │ ◄─────────────► │ scheduler (one job, ids) │
│ ReaderClient                  │                 │ windows   (front window) │
│  ├─ transport (spawn, lines)  │                 │ capture   (ScreenCaptureKit)
│  ├─ supervisor (restart)      │                 │ recognise (Vision)       │
│  └─ request table (ids)       │                 │ focus     (event loop)   │
└───────────────────────────────┘                 │ permission               │
                                                  └──────────────────────────┘
```

| Path | Contents |
|---|---|
| `app/native/reader/` | The Rust crate, building the executable `clave-reader`. `src/macos/` holds everything that touches Apple APIs. `src/` holds the protocol, scheduler, text assembly and checks, which are platform-neutral and unit-tested without a screen |
| `app/src/main/reader/` | `readerClient.ts` (implements `Reader`), `transport.ts`, `supervisor.ts`, `protocol.ts` (message shapes, validated with zod) |
| `app/src/shell/` | One wiring change: build the real reader when the helper exists. `devReader` stays for `start:scripted`, the smoke test and the tests |

Main trusts nothing from the helper. Every line is validated by `protocol.ts`, then by the existing
`parseFrontWindow`, `parseReadResult` and `parsePermission`. A malformed line counts as a failed read.

Rust dependencies, to be approved by the owner when the plan runs: the Apple framework bindings
(the `objc2` family: foundation, app-kit, core-graphics, screen-capture-kit, vision) and
`serde`/`serde_json`. The plan lists exact crates and versions. No other crates.

### The fallback branch

If spike P1 finds that the Screen Recording grant reaches no child process at all, `capture` moves
out of the helper: `ReaderClient` captures the window with Electron's `desktopCapturer` (no native
code in main) and the `read` message carries the image bytes to the helper, which recognises and
drops them. The image exists in memory only. Nothing else in this design changes.

## 3. Protocol

One JSON object per line, UTF-8, in both directions.

Main to helper: `{id, op}` where `op` is `permission`, `requestPermission`, `frontWindow`,
`read` (with `budgetMs`), `cancel` (with `target`, the id to cancel) or `shutdown`.

Helper to main: `{id, ...result}` for each request except `cancel` and `shutdown`, and two events:
`{event:"ready", protocol:1}` once at start and `{event:"focus"}` on a focus change. Main does not
use a helper whose protocol number differs from its own; every call then answers as in "helper down".

Results: `permission` answers `{permission}`; `frontWindow` answers `{window}` or `{window:null}`;
`read` answers the `ReadResult` shape of the port; `requestPermission` answers `{}`.

### Privacy on the channel

Recognised text and window titles travel only inside `read` and `frontWindow` answers. The helper's
stderr carries error codes only. `ReaderClient` logs counts and codes only. C adds a leak test of its
own, in the style of the existing ones.

Note 2026-09-19 (C-2a): protocol 1 now carries a fifth read failure reason, `windowGone`, alongside
`failed`, `timeout`, `locked` and `black` (owner decision O4, after the first real run measured 6 of
36 reads landing on "the frontmost app has no qualifying window right now"). The protocol number is
**unchanged**, and that is defensible for two reasons: main's parser collapses any reason it does not
know to `failed`, so an older main paired with a newer helper merely loses the distinction and
behaves exactly as before; and the helper binary ships inside the same bundle as main, so the two
sides are always deployed together. If the helper is ever shipped separately from main, this
reasoning stops holding and the number has to move. See
`docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`.

Note 2026-09-19 (C-2b-1): **the protocol number is now 2**, and this **supersedes** the sentence in
the note above that it is unchanged (owner decision O7). The reason the C-2a note gave for leaving it
at 1 — "the helper binary ships inside the same bundle as main, so the two sides are always deployed
together" — turned out to be false in development, which is where all the running happens today: the
helper inside `~/Applications/Clave Agent Dev.app` was built on 2026-09-18 21:53 and the checkout had
moved on twice by the next afternoon, so a stale helper ran against a newer main for a day without
either side noticing. A number that moves makes that loud (`READER_PROTOCOL_MISMATCH`, every call
answering as "helper down") instead of silent.

What protocol 2 carries, over 1:

- `read` carries `expect: {app, title, bundleId?}` — the front window main has just approved (owner
  decision O6). The helper compares all three as they arrive (`bundleId` absent and `bundleId`
  present are different windows) and answers `windowGone` for anything else **without capturing**.
  A `read` with no usable `expect` answers `failed` and captures nothing (D1); see the note at the
  end of 5.3.
- `read` may carry `lines: true`, which only `reader:eval` ever sends: an un-cached `ok` answer then
  also carries the recognised lines with pixel boxes (`text, topPx, bottomPx, leftPx, rightPx`) and
  `stats.bandPx`. A cache hit carries neither. The app's own client cannot send it — `ToHelper` has
  no `lines` member — and the lines are the same cleaned lines `text` is made of, so nothing new
  crosses the pipe (D11).
- `ok` and `black` answers may carry a numbers-only `stats` object: `captureMs`, `recogniseMs`,
  `cacheHit`, `width`, `height`, `bandPx`. It is built field by field in the helper, never spread;
  the port's zod parser strips it, so only `reader:eval` ever reads one (D3).
- Ids: the helper ignores an `id` or a `cancel` target above 2^53 − 1 and reads a `budgetMs` above it
  as 0 ("no deadline of my own"); the client counts its own ids up from 0. Documented on both sides
  (D13).

One consequence for section 1, recorded here because no approved sentence is edited: "It implements
the existing `Reader` port without changing it" is **no longer true**. The port gained `expect` on
`read` under O6, as it gained the `windowGone` failure reason under O4. The capture loop, the
constants and the core are still not changed by C-2b-1 beyond passing `expect` through.

## 4. Re-entry, deadlines and supervision

### Re-entry

`ReaderClient` numbers every call. When `read()` is called while an earlier read is outstanding, the
client settles the earlier one locally as `{ok:false, reason:"timeout"}` (main has already stopped
listening), sends `cancel` for it, then sends the new read.

The helper runs one capture job at a time on a worker thread. A cancelled job stops at the next step
boundary (before capture, before recognition, or through Vision's own cancel) and its image is
dropped. The next job always takes a fresh capture. Answers carry their id; the client drops any
answer whose id is no longer in its table. An earlier frame therefore cannot answer a later call.
The one thing carried between jobs is the same-pixels cache of section 5.2, which is used only when
the new capture is pixel-identical.

`frontWindow` and `permission` are answered outside the job thread, so they never queue behind a
slow recognition.

### Deadlines

The helper enforces `budgetMs` itself and answers `timeout` when capture plus recognition runs over.
The client keeps its own deadline inside main's: `budgetMs` + 4 s for `read`, 4 s for the others
(main's are `READ_BUDGET_MS` + 5 s and 5 s). When a client deadline passes, the helper is wedged in
a native call that cannot be cancelled: the client settles the call (`timeout` for `read`, the
"helper down" answers below for the others), kills the helper and lets the supervisor restart it.
Apart from `frontWindow()` (see "helper down"), the client's promises never reject.

### Supervision

| Event | Behaviour |
|---|---|
| The helper exits | Every pending call settles (`failed` for `read`, the "helper down" answers for the others); the loop counts that in its existing failure window |
| Restart | Backoff from 0.5 s, doubling to 30 s; reset after a minute of healthy running |
| Five unplanned exits in ten minutes | The supervisor stops restarting. Calls answer as "helper down" until capture is switched off and on again; the loop's existing `onReaderProblem` shows this to the user |
| Planned restart (memory hygiene) | After 500 reads or 6 hours, only while no call is outstanding. Not counted as a crash |
| Main dies | The helper exits when its stdin closes |
| `dispose()` | Sends `shutdown`, closes stdin, kills after 1 s, clears subscribers and pending calls |

Helper down means: `permission()` answers `unknown`, `read()` answers `failed`,
`requestPermission()` resolves without effect, and `frontWindow()` **rejects**. The rejection is
deliberate: a cycle starts with `frontWindow()`, and the loop records `null` as "no window", which
is not a failure. Only a rejection reaches the loop's failure window, so only a rejection lets a
reader that is down for good surface through `onReaderProblem`. The loop already catches it.

### Focus subscribers

The client keeps a set of subscribers. Each callback runs inside a try/catch. Subscriptions belong to
the client, so they survive helper restarts. The returned function removes exactly that subscriber.

Note 2026-09-18 (phase 0, P3): a cold start can cost far more than any deadline in this section. The
first-ever recognition per binary was measured at 45,251 ms (Rust) and 46,900 ms (Swift), while later
fresh processes started warm at 87–200 ms; what triggers the cold cost was not isolated. Nothing in
this section was written with a ~45 s startup in mind: `READ_BUDGET_MS` is 1.5 s, the client's
deadlines are `budgetMs` + 4 s and 4 s, the planned restart is every 500 reads or 6 hours, and five
unplanned exits in ten minutes stop the supervisor. The reconciliation is a design requirement for
the build plan, not a change to this section — see section 10.1 item 2. In outline: the helper warms
up with one throwaway recognition **before** it emits `ready`; the supervisor's start deadline must
allow a cold start (≥ 60 s) without counting it as a crash or as one of the five exits; the planned
restart starts the replacement and waits for its `ready` before retiring the old helper; and what
calls arriving before `ready` do — answer `failed` at once, or be held — is an open decision for the
build plan, bound by the constraint that the loop's failure window (five failures in ten minutes →
`onReaderProblem`) must not trip during a cold start.

Note 2026-09-19 (C-2a): three additions to supervision that the build made, none of which changes a
sentence above.
(a) **The denied refresh** (plan C-2a, D13). While `permission()` answers `denied` and the current
helper is older than the refresh interval, the client retires that helper — not counted as a crash,
and with no capture attempted, so no macOS prompt is raised — starts a fresh one, and still answers
`denied` for that call. The interval starts at 5 s and doubles to at most 60 s while the answer stays
`denied`; it resets on any non-`denied` answer, on `requestPermission()` and on a new focus
subscription, and no refresh happens after the supervisor has given up. This exists because the first
real run measured that `CGPreflightScreenCaptureAccess` is cached per process and this helper never
attempts a capture while denied, so the helper that was running when the grant arrived answered
`denied` for ever; the backoff exists because the engine asks every 10 s regardless, and a flat 5 s
would mean a process spawn plus a Vision warm-up every 10 s for ever on the machine of somebody who
has simply declined.
(b) **`dispose()` owns the helpers on their way out** (D14): it awaits, and if necessary kills, every
retired-but-not-gone helper as well as `current` and `replacement`, and retiring a helper clears its
previous kill timer. Without this a retired helper was held by nothing but a timer that outlived the
client.
(c) **`frontWindow()` rejects for a window that is present but cannot be parsed**, not only when the
helper is down (from C-1). It follows from the reasoning above: the loop records `null` as "no
window", which is not a failure, so only a rejection lets a reader that is answering nonsense surface
through `onReaderProblem`.

Note 2026-09-19 (C-2b-1): four changes to this section's mechanics, from C-1's four deferred design
inputs (D14). None of them changes a sentence above.
(a) **Draining instead of killing.** The two paths that used to take a helper away under a call in
flight — the `refused` cure and the denied refresh — now DRAIN it: no new call reaches it, the calls
already sent are allowed to finish, and only then does it retire. A killed read used to be counted
against the reader. `HELPER_WEDGED` is still emitted for a draining helper, because it is the only
signal of a binary that hangs on every read. The `refused` cure also carries the `!gaveUp` guard the
denied refresh already had, so after a give-up one `refused` answer can no longer drain the last
working helper for ever; after a give-up a `refused` answer yields `needsRestart`, which is the only
value of the four that surfaces to the user.
(b) **A protocol mismatch is permanent for the life of the client.** A new focus subscription no
longer respawns a binary that cannot have changed. The five-unplanned-exits give-up above is
unaffected and is still revived by a new subscription.
(c) **The `HelperLink` contract, written down and made safe.** `onLine` is meant to be registered
synchronously after the spawn; because that is a contract and not a guarantee, the real link now
buffers the FIRST 64 lines that arrive before `onLine` is registered — `ready` is the first line, so
the first lines are the ones worth keeping — and flushes them in order once it is. A helper that
talks past that while nobody is listening loses the later lines, which only happens when the client
has already broken its half of the contract.
(d) **A line is capped while it is being read.** `readline` is replaced by a splitter that stops
accumulating at the cap rather than after it, and delivers one marker line that `parseLine` refuses
by construction, so main never holds an unbounded line and an over-long line costs one failed read
instead of memory.

## 5. What the helper does

### 5.1 Front window

From the window server only: the frontmost app, then that app's topmost normal window (layer 0,
on screen, non-trivial size): window id, app name, bundle id, title. macOS reveals window titles only
to a process with the Screen Recording grant, so without the grant there is no title and the answer
is `null`. When the screen is locked, `frontWindow` answers `null` and `read` answers `locked`.

Note 2026-09-18 (phase 0, P1/P6): the sentence "macOS reveals window titles only to a process with
the Screen Recording grant" is too strong. An ungranted process still counted non-empty window
titles in four records: `out/p1p2.jsonl` 06:48:56.474Z (4 titles) and `out/p6.jsonl` 07:08:54.832Z
(1), 07:09:07.147Z (4) and 07:10:27.108Z (4, after the grant was revoked) — all with `-3801` and
`preflight:false`. Which windows those titles belonged to was not examined. Consequences: a present
title must never be read as proof of permission, `titles == 0` must not be the permission signal,
and `frontWindow()` must gate on the helper's own permission state — it answers `null` when *this*
window has no title, not because the grant is missing. See section 10.

### 5.2 One read

A cancellation check runs between each step.

1. Find the front window; remember its window id.
2. Capture that window id only, through ScreenCaptureKit, at full pixel density, without cursor or
   shadow. Other windows are never in the image, even when they overlap it.
3. Black check: a fixed grid of a few hundred pixel samples. All black answers `black`.
4. Same-pixels shortcut: hash every pixel. If the hash equals that window id's last recognised
   frame, answer with that frame's text and skip recognition. The cache holds one entry (window id,
   hash, text, toolbar text), lives in memory only, and is cleared when the front window id changes
   and when the helper restarts.

   Corrected 2026-09-19 (C-2a, fix round 4): those two rules are not enough. Both only fire *inside*
   a read, so when reads stop — reading switched off, the screen locked, the user away, the app idle
   in the tray — the last window's recognised text stayed in the helper's memory until the process
   exited, in practice up to the 6-hour planned restart, against the app's "Nothing older than an
   hour exists anywhere". The cache is now **also** emptied after 60 s in which the helper was asked
   for no read at all (`CACHE_IDLE_CLEAR`, a timed wait in the worker), and at every early return of
   the read that means this window is not being read now: locked, no grant, no front window, the
   window gone before the capture, and a capture the system refused. Dropping the `String` is what is
   promised; Rust does not zero freed memory and neither does the allocator, so the claim is about
   what the process retains, not about pages that have not yet been reused.
5. Recognise with Vision: accurate mode, language correction off, grayscale input, languages English
   and Portuguese.
6. Assemble the text: lines ordered top to bottom, then left to right within a row, joined with
   newlines. Strip known noise (digit runs from editor line-number gutters).
7. Toolbar strip: only when the bundle id is on a fixed list of browsers, the recognised lines whose
   boxes sit in the top band of the window also become `toolbarText`. No second capture, no second
   recognition. The band height comes from spike P5.
8. Drop the image. Answer `{ok:true, window, text, toolbarText?}` with the window of step 1.

Note 2026-09-18 (P5): step 7's band is per browser and is carried in points × display scale, not as a
fraction of window height — see section 10.

Note 2026-09-19 (C-2a): two things the build settled about these steps.
**Steps 1–2 (the helper's scheduler steps 2 and 3).** When there is no front window at the moment of
the read, or the window has vanished by the time the capture runs, the answer is `windowGone` and
**not** `failed` — see the note at the end of section 5.3. A helper without the grant still answers
`failed`: that one genuinely cannot do its job.
**Step 7.** The fixed list of browsers is exactly **Google Chrome and Safari**, the only two bundle
ids with a measured band (10.1 item 8). The core does not read any other browser at all — owner
decision O2, enforced twice in the core (plan C-2a, D2): `before()` refuses a listed browser that is
not measured, so nothing is captured, and `after()` never keeps a browser read that arrives without
`toolbarText`. Browser names are matched as **prefixes on a word boundary**, so "Google Chrome
Canary", "Safari Technology Preview" and "Opera GX" are browsers without a measured strip and are
therefore not read, while the measured-browser check stays an exact match. Accepted cost: an app
whose name merely begins with a browser's name — "Chrome Remote Desktop", the video player "Helium" —
is not read either. That is the safe direction of O2.

Note 2026-09-19 (C-2b-1): the approved window is now checked THREE times inside these steps (D2), and
which returns empty the cache is written down.

**The three comparisons** (`native/reader/src/scheduler.rs`). Before the capture, at step 2: the
front window must equal `expect` field for field, or the answer is `windowGone` and nothing is
captured. After the capture and the black check, before the cache lookup and recognition (step 4b):
the same comparison, and the same window id — a capture takes long enough (about 230 ms measured) for
a window to be renamed under it, and a title is half of what the exclusion rules read. After
recognition, before anything is stored or answered (step 8b): the same again. A mismatch at either
re-check drops the image or the text, clears the cache and answers `windowGone`. Main keeps both of
its own after-checks unchanged: they cost one call, and they are what holds if a reader ever fails to
keep its side.

**Which returns clear the cache.** Every early return down to and including step 4b clears it: the
locked screen (step 1), no grant, a `read` with no usable `expect`, no front window, a front window
that is not the approved one (step 2), a refused capture, a capture the system reports as gone, any
other capture error (step 3), and the 4b mismatch. So does the 8b mismatch. The `clear_unless(window
id)` after step 2's approval keeps only the approved window's own entry. Exactly two returns do NOT
clear, and deliberately: the black frame at step 4 and a recogniser error at step 6, both reached
only after the window has been matched against `expect`, so what survives is that same approved
window's own earlier text, and the 60 s idle rule of the C-2a correction above still empties it. The
cancellation and timeout checkpoints clear nothing at any step: they are not answers about what is in
front.

**The store moved above the last checkpoint.** A read that runs past its budget during recognition
still answers `timeout` and a cancelled one still says nothing, but the text is now kept, so a window
that is marginal against the budget is no longer recognised from scratch every cycle and thrown away.
What enforces "text from a window that failed the re-check is never retained" is the `cache.clear()`
on the 8b branch, not the order of the two statements; a test pins the clear, and the comment in the
code says so, because moving the store leaves every test green while removing the clear does not.

**Step 6, the gutter rule (item 16, D7).** The COMMENT was wrong, not the rule, and the comment was
fixed. Today's behaviour is pinned by tests: a numbered list written flush left as `1 Install /
2 Configure / 3 Run` loses its numerals to the gutter stripper, while `1. Install` and `1) Install`
keep every character. The rule cannot tell a glued editor gutter from a bare-number list, and it only
ever under-strips otherwise.

### 5.3 Failures and permission

| Situation | `read` answers |
|---|---|
| The system refuses the capture (grant revoked or never given) | `failed`, never `black` |
| The window vanished between steps | `failed` |
| Over budget | `timeout` |
| Screen locked | `locked` |
| Anything unexpected | `failed` |

| `permission()` | When |
|---|---|
| `granted` | The system check says yes and no capture has been refused since |
| `denied` | The system check says no |
| `needsRestart` | The check says yes but captures are refused, or the grant arrived after the helper started, and one helper restart did not cure it |
| `unknown` | Helper down |

What works outranks what the check says: a refused capture moves the state off `granted` until a
capture succeeds. On the first sign of the `needsRestart` condition the client restarts the helper
once on its own; only if the condition persists does it answer `needsRestart`. Whether a helper
restart is enough is spike P2.

`requestPermission()` triggers the system prompt from the helper. Opening the settings pane and the
wording around it stay where B put them.

Note 2026-09-18 (phase 0, P2): the first sentence above is the one thing P2 measured as failing.
`CGRequestScreenCaptureAccess()` called from the helper answered `false` (`out/p2-request.jsonl`,
06:46:42.206Z), no attributable prompt was raised, no entry appeared in the Screen & System Audio
Recording list by itself, and the owner had to add the app by hand. That bundle lived in a temp
folder and the call was never retested from a registered location. So `requestPermission()` must be
built as best-effort and must never be the only path to the grant; opening the settings pane and the
wording around it remain the path that works. See section 10.

Note 2026-09-19 (C-2a): the first real run answered P2's open question from an **installed** bundle
(`~/Applications`, self-signed, bundle id `dev.clave.agent.dev`). `requestPermission()` **does** raise
the system dialog from there — the owner's screenshot reads “Clave Agent Dev.app” would like to
record this computer's screen and audio. Grant access to this application in Privacy & Security
settings, located in System Settings. with the buttons Open System Settings / Deny — and the entry
appears in the list under the .app file name. After the grant, macOS offered a second dialog,
“Clave Agent Dev.app” may not be able to record the contents of your screen until it is quit., with
Quit & Reopen / Later; phase 0's twin bundle was **not** offered that, so whether macOS offers it is
not something to rely on either way. The measured consequence for the table above: a helper that was
**already running** when the grant arrived keeps answering `denied` (the system check is cached per
process and this helper never attempts a capture while denied), while a **fresh** helper answers
`granted` at once. So the cure is the client replacing a stale helper, not the app restarting itself:
`needsRestart` stays in the table for the case it describes, the normal path after granting needs no
app restart, and the onboarding sentence "After you allow it, the app has to restart once." is wrong
and is carried to C-2b. Full record:
`docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`.

Note 2026-09-19 (C-2a), on the failure table: a fifth reason, `windowGone`, was added for "the
frontmost app has no qualifying window right now" — an app switch in progress, an overlay or menubar
app — and for a window that vanished between the steps of 5.2. Main records it as the capture loop's
own outcome and does **not** count it as a reader failure (owner decision O4), so the row "The window
vanished between steps → `failed`" above is superseded by this note. The reason: the first real run
measured 6 of 36 ordinary reads landing there, and five reader failures in ten minutes switch capture
off, so ordinary window switching turned reading off. A revoked grant cannot hide behind it, but not
by the −3801 path: on revocation `CGPreflightScreenCaptureAccess` goes **false**, so `frontWindow`
answers null, the loop records `noWindow` and **never calls `read`** — and the engine's periodic
permission poll (`refreshPermission()` every `PIPELINE_TICK_MS` = 10 s, `app/src/main/engine.ts:451`
and `:453`, the constant at `app/src/main/constants.ts:13`) then sees `denied` and switches capture
off. The `SCStreamErrorDomain` −3801 → `Refused` → `failed` path, with the process-wide flag set, is
unchanged and is for a capture the system refuses while the preflight still says yes; it was never
exercised in C-2a. A helper without the grant still answers `failed` to a read that reaches it.

Note 2026-09-19 (C-2b-1): one row is added to the failure table by D1. A `read` that does not say
which window the app approved — no `expect`, or an `expect` this helper cannot read as three fields —
answers **`failed`**, and captures nothing. It is `failed` rather than a state of the screen because
it describes a broken main, and `failed` is the reason the loop counts and eventually shows through
`onReaderProblem`. On a **locked** screen such a read answers `locked`: the lock check comes first,
and either way nothing is captured and the cache is emptied.

### 5.4 Left out on purpose

The plan's cap on recognitions for constantly changing apps. The loop reads at most once per 5 s,
about 3% of one core at 150 ms per recognition. Phase 0 measures the real cost. If a cap is needed
it belongs in the loop, which decides when to read, as a separate small change.

Note 2026-09-19 (C-2b-1): C-2a's review found that this section's "at most once per 5 s" is not quite
what happens (carried item 17). A window whose title ticks every second — a terminal running a command, a player
writing a timestamp, a chat app with an unread count — can cost up to TWO reads per 5 s: the helper's
own focus gate holds a title-only change back to one per 5 s, but that held-back event and the loop's
own 5 s poll can land on either side of each other. D4 decided to leave it: no loop-side minimum
interval was added, because one would delay reads after a real window switch, and the cost is now
visible rather than silent. Where it shows is the counter below.

Note 2026-09-19 (C-2b-1), the nothing-read counter (D6). The loop is main's, not the helper's, but
this is where the cost of reading nothing is discussed, so it is recorded here. Every cycle is
classified once, in a table `tsc` keeps exhaustive both ways:

- **productive** — `kept`, and a new outcome `unchanged` (the read WORKED, the screen had simply not
  moved, which is what someone reading a long document produces for minutes on end);
- **barren** — `noWindow`, `windowGone`, `black`, `windowChanged`, `denied`, `notKept`, `locked`, and
  a second new outcome `empty` (the core's "almost no words on that screen": a video player, an
  image, a near-blank terminal). `notKept` is every other not-kept answer the core gives, its own
  gate reasons included — it is NOT only the after-rules and a failed scrub;
- **neutral** — `userAway`, `stopped`, `timeout`, `failed`. The last two are the reader's own faults
  and already have their way out through `onReaderProblem`.

A notice is raised once per streak, when at least **24** consecutive barren cycles AND at least
**10 minutes** since the last productive cycle (or since the run started) have both been reached. It
is never a blocker: capture stays on, the tray's switch stays checked, and the first productive cycle
clears it. `userAway` is neutral in the strict sense — it neither extends the streak nor ends one —
and does one thing besides: the span it covers is taken OFF the ten-minute clock, so "ten minutes"
means ten minutes in which somebody was there. The accepted consequence, recorded by the fixer: the
first five minutes of any absence are not away time yet (the idle clock has to reach
`AWAY_AFTER_SECONDS`), so a locked lunch leaves about twenty barren cycles and five minutes on the
clock, and the notice then comes five minutes after the user sits down again rather than ten. The
alternative — resetting the clock on every `userAway` — was tried and rejected: somebody who steps
away for five minutes in every ten would hold a genuinely barren machine below the threshold for ever.

Log codes: `READER_NOTHING_TO_READ` carries the streak's tally under fixed outcome-name keys and
numbers only. `CAPTURE_OFF` carries the run's totals from `stats()`, which counts per RUN (the loop
clears it in `start()`), and it is now written at EVERY path that stops the loop — including tray
Quit, a different account signing in, and delete-all-data, where the write goes in before the files
do. Before that, the commonest way a session ends left no tally at all.

### 5.5 Focus detection

App switches: workspace notifications on the helper's own event loop. Changes inside one app (tab,
document): once a second the helper compares the front window id and title with the last seen; a
difference sends `focus`. The check pauses while the screen is locked. The helper does not merge
events; the loop's 400 ms settle timer already does.

Note 2026-09-19 (C-2a): the first real run saw focus events arriving from **both** sources — the
workspace activation notification and the 1 s poll — in the helper inside the signed bundle. That is
spec 10.1 item 17, and it was the stated reason for choosing the standalone helper, so it is worth
recording as observed rather than assumed. One change the build made to this section's "does not
merge events": a **title-only** change is now emitted at most once per 5 s by the helper itself
(`focus_gate.rs`), while a window-id or frontmost-pid change is emitted at once, and a held-back
title change is never lost (it is still a difference against the last announced state at the next
poll). Without it a window whose title ticks every second — a video, a terminal running a command, a
chat app with an unread count — drove a read every second, against 5.4's budget of at most one per
5 s. Privacy does not rest on these events: the loop re-checks the front window and its title before
and after every read and discards on a change.

Note 2026-09-19 (C-2b-1): two changes here, and one hazard to watch.

**The gate keeps a hash, never the title** (D12, carried item 40). `focus_gate.rs` used to hold the
last seen window title for the life of the process, so that it could tell a change from no change,
and nothing cleared it on a lock, a revocation or idleness. It now holds a 64-bit hash of the title
(`DefaultHasher` with fixed keys) beside the pid and the window id. The cost is that a hash collision
loses one title-change event, which the 5 s poll catches anyway.

**Both focus sources are gated on the lock** (carried item 35). This section says "the check pauses
while the screen is locked" of the 1 s poll; the workspace activation notification was not gated at
all, and a notification does arrive while the screen is locked, because the login window itself
becomes frontmost. The rule now lives inside `FocusGate`, which asks the lock question itself on
every poll, so neither source can bypass it. The timer keeps its own `should_observe` pre-check, but
only as an optimisation — so a locked screen costs no preflight and no workspace call — and the
comment in the code says which of the two is the rule.

**Compile-verified only, and one new hazard.** No test can reach these lines without a screen, and
they are the ones to watch in the first run of C-2b-2: `macos/focus.rs:47` (the wiring of
`screen_is_locked` into the gate), `:105` and `:142` (the two `report_focus` calls, one per source),
`:136` (the timer's early return), and `macos/recognise.rs:108` (a line box's right edge). The hazard
is new and was accepted knowingly: `screen_is_locked` is now called inside `gate.borrow_mut()`,
because the look runs inside `poll`. On one run loop the timer block and the notification block
cannot interleave, so it is sound today; if a CoreGraphics call ever pumped the run loop, the second
entry would be a `BorrowMutError`, which the helper's panic guard turns into `E_PANIC` and exit 70 —
a counted helper exit, five of which in ten minutes switch capture off. Watch that code's count in
the first real run.

## 6. Phase 0 spikes

Throwaway code in the session scratchpad, never in `app/`. Each spike ends with a finding written
into the results table at the end of this document. P1 and P3 run first. Every spike needs the
owner's approval for its downloads (the crates) at the time it runs.

| # | Question | Pass | If it fails |
|---|---|---|---|
| P1 | Does the Screen Recording grant reach a standalone helper started by the app (stable self-signed certificate)? | The helper captures a window; System Settings lists the grant under the app | Try the Node-child form (`ELECTRON_RUN_AS_NODE`); if that fails too, the fallback branch of section 2 |
| P2 | After a fresh grant, is restarting the helper enough? Which app does the system prompt name? | The helper captures after its own restart; the prompt names the app | `needsRestart` means restarting the app, which B already handles |
| P3 | ScreenCaptureKit capture by window id and Vision recognition from Rust | One window captured and recognised, median under 400 ms; memory flat over 1,000 reads | The macOS layer becomes a thin Swift static library linked into the Rust program; protocol and scheduler stay in Rust |
| P4 | Recognition quality on the staged windows | Character accuracy: at least 97% chat and tickets, 95% terminal, 95% Portuguese with accents kept, 90% code; reported for light and dark themes and small fonts | The numbers go to the owner before the plan is written; no threshold is lowered silently |
| P5 | Toolbar strip: Chrome and Safari (Arc if installed), normal and private windows | Address host recognised in at least 19 of 20 staged captures; "Incognito"/"Private" in 20 of 20; band height recorded | Private detection recorded as unreliable for that browser; the plan's user advice (exclude the browser) stands |
| P6 | Revoking the grant while the helper runs | `read` answers `failed`; `permission` stops answering `granted` | Section 5.3 is adjusted to what the system actually reports |

Carried to packaging: repeat P1, P2 and P6 under a real Developer ID.

## 7. Testing

| Layer | What | Where |
|---|---|---|
| TypeScript unit tests | `ReaderClient`, transport, supervisor, protocol, against a fake helper (a scripted child process speaking the protocol) | Everywhere, in `pnpm --dir app test` |
| Rust unit tests | Protocol parsing, scheduler and cancellation, text assembly, noise stripping, toolbar band, black check, same-pixels cache, on in-memory data | `pnpm --dir app test:native` |
| Staged-window run | Opens windows with known text (terminal, browser pages styled as chat, tickets and code, Portuguese, light and dark, small fonts, private window); measures accuracy, the window answer, the toolbar strip | `pnpm --dir app reader:eval`, on a Mac with the grant; never in the normal test run |
| Manual checklist | Overlapping windows, the owner's real VS Code, second display, full-screen app, locked screen, grant revoked mid-run, helper killed mid-read | The owner; pass or fail only, no text saved |

The TypeScript layer must cover: a second `read` while the first is outstanding (first settles as
`timeout`, `cancel` is sent); an answer with a stale id is dropped; a malformed line is `failed`; the
helper dying mid-call; backoff and the stop after five exits; the planned restart only between calls;
a protocol mismatch; several focus subscribers including one that throws, and across a restart;
`dispose()`; the leak test.

When the plan is executed, every task gets an independent review with a reproducing probe.

Note 2026-09-19 (C-2b-1): the staged-window run of the third row exists. It is built and unit-tested,
and — stated as plainly as the rest of this document — **it has never met a screen**. Nothing below is
a measurement; it is a description of an instrument whose first run is C-2b-2, with the owner there.

**Two halves.** `pnpm --dir app reader:eval -- <mode>` runs `scripts/reader-eval.mjs`, which is the
half the owner types; it opens the granted development bundle with `CLAVE_DEV_ENTRY=reader-eval`, and
`dist/reader-eval.cjs` inside that bundle is the half that reads. It has to run inside the bundle
because macOS attributes screen access to the app bundle that started the helper: from a terminal the
grant would be the terminal's and nothing measured would be true of the product.

**Modes.** `accuracy` (the staged pages and the two terminals, scored), `toolbar` (40 Chrome stagings
for the address host and the private badge), `observe` (windows the owner stages by hand, including
Safari private windows), and `all`. Each accuracy case is read five times by default at fixed,
recorded window sizes, including a narrow terminal, and the window is re-staged for every repetition
because phase 0 showed unchanged pixels recognise identically (D10); one extra immediate re-read per
staging exists only to record the cache hit.

**The guard.** A window is read only when the window server reports its `app` exactly as the case's
app AND its title contains this run's staged title, which carries a random per-run nonce. An accepted
answer becomes an `Approval`, and an `Approval` cannot be constructed outside `guard.ts`, so there is
no code path that reads a window without one. The `read` then carries `expect` equal to that window,
which is the helper's half of the same rule and the reason the protocol number moved. If the staged
window is not in front inside the timeout, the repetition is `notStaged` and nothing is read.

**Three refusals before anything is read**, in order: a mode or Chrome variant this harness does not
have (`{"error":"HARNESS","code":"BAD_MODE"|"BAD_VARIANT"}`), refused first because it is a question
about the request rather than the machine; a helper that does not announce protocol 2
(`{"error":"PROTOCOL"}`); a helper that does not answer `permission: granted` (`{"error":"NO_GRANT"}`).
`requestPermission` is never called — raising a system dialog is the app's business, not a harness's.

**Nothing measured is never accepted.** A run whose mode asked for verdicts it did not produce is a
shortfall (exit 2), not a pass: an unrecognised mode used to run nothing and report `accepted: true`
with exit 0. A group is judged on its MINIMUM, never its median. A repetition that ended `notStaged`,
`noMarkers`, `windowGone`, `black`, `locked`, `timeout`, `failed` or `down` makes its case incomplete
and never a pass. `observe` fails loudly (D17): a window staged private whose read shows no private
marker, a normal window flagged private, or zero accepted reads each fail the run.

**What results may hold.** Numbers, booleans, fixed codes from closed lists, case and app names this
harness invented, its own nonce, and — for cases under their threshold only — single-character
confusion pairs from between the markers. Never recognised text, never a toolbar strip, never a title
other than the harness's own. The file is built field by field rather than spread, so a field added
upstream cannot ride along, and a test runs a whole fake run whose every recognised string is a
sentinel and asserts that none of them reaches the output. The Chrome profile and the generated
`.command` files live in a per-run folder under the OS temp directory and are removed when the run
ends; only the results JSON and `observe-urls.json` are written, into `app/reader-eval/out/`.

## 8. Build and wiring

- `pnpm --dir app build:native` calls cargo by absolute path (`/opt/homebrew/opt/rustup/bin`); PATH
  is not edited. Output: `app/dist/native/clave-reader`.
- The shell's "refuses to start" guard: the reader half passes when the helper binary exists and
  answers `ready` with the right protocol number. The clave-back half is untouched, so a packaged
  build still refuses to start until D exists.
- `start:scripted` and the smoke test keep using `devReader`, so the existing tests and `SMOKE OK`
  need no grant and no Mac-only step.
- If P1 passes with the standalone helper, the plan includes disabling the `runAsNode` switch for
  packaged builds.

Note 2026-09-19 (C-2a): how development actually runs, as built and as first used with the owner.
The dev bundle `~/Applications/Clave Agent Dev.app` (bundle id `dev.clave.agent.dev`, self-signed
with the "Clave Agent Dev" certificate) is a **thin launcher**: it `require`s this checkout's
`app/dist/main.cjs` and only the helper binary is copied inside it, so rebuilding the app never needs
a new bundle, and its executable keeps the name `Electron` so `app.isPackaged` stays false and the
development switches work (plan C-2a, D10). The helper is looked for **next to the app's executable
first** (`Contents/MacOS/clave-reader`), then in `dist/native/` (D9); `build` copies the helper into
`dist/` on every run, so the two never drift. It is launched only through LaunchServices
(`pnpm --dir app start:reader[:scripted]`), never from a terminal, or macOS would attribute screen
access to the terminal. Measured: 288 MB on disk, the helper runs as a child of the bundle's Electron
process, and the Screen Recording grant survives re-creating the bundle with the same id and
certificate. **Known gap, carried to C-2b:** the switches are passed at launch, so macOS's own
"Quit & Reopen" button relaunches the bundle **without** them and the app then refuses to start with
`NO_READER_YET`. The launcher should bake them in instead.

Note 2026-09-19 (C-2b-1): that gap is closed in the checkout (D9), and `dev:bundle` now refuses to
replace a bundle under a running app.

**The launcher.** The bundle's `Contents/Resources/app/main.js` is a one-line `require` of
`app/scripts/dev-launcher.cjs` in this checkout, which is never copied into the bundle: logic in the
checkout is unit-testable and needs no re-signing to change. That file bakes in `CLAVE_STANDINS`,
`CLAVE_REAL_READER`, `CLAVE_DATA_DIR` and `CLAVE_FIXTURES` as defaults, so a bare relaunch by macOS
starts in a working mode; anything already set in the environment always wins, so `open --env` still
decides when `start:reader` is used. The one switch whose value changes what "working" means,
`CLAVE_SCRIPTED_MODEL`, is remembered in `app/.dev-launch.json`, written by `start-reader.mjs` before
every deliberate launch — and that file is the ONLY thing taken from disk, at exactly one key holding
exactly the string `"1"`, so a stray or tampered file can turn scripted mode on and nothing else.
`CLAVE_DEV_ENTRY=reader-eval` is the one value that redirects the entry point, to
`dist/reader-eval.cjs`; it is never read from the JSON file. `resolveLaunch` is pure and unit-tested
in plain Node, and the impure half is gated on `process.versions.electron`, so requiring the module
from a test does nothing. The cost of D9 is that moving the checkout breaks the relaunch, exactly as
it already breaks the bundle's `require` of `dist/main.cjs`. Not yet exercised: the whole path inside
the REAL bundle, under macOS's own "Quit & Reopen".

**`dev:bundle` refuses while the app is running.** Replacing the bundle under the running app is what
made it log `PERMISSION_LOST` on 2026-09-19. When the destination resolves to `~/Applications` — the
resolved path, not the presence of a `--out` flag — the script runs `pgrep -f` on the bundle's
`Contents/MacOS` path before it removes, writes or signs anything. Exit status 1 (nothing matched)
proceeds; a pid means `DEV_BUNDLE_FAILED APP_RUNNING`; anything else — status 2, a `pgrep` that could
not be spawned, a status 0 naming nobody — means `DEV_BUNDLE_FAILED PGREP_UNANSWERED`. An unanswered
check refuses rather than warns, because this is the step where the grant was lost once. Known holes,
both left: a symlinked or case-different spelling of `~/Applications` is not the default location and
is not guarded, and an unrelated process holding that path in its command line makes the script refuse
(the safe direction). The script's program half is now gated on `argv[1]` as well, so importing the
module from a test can never build, sign or replace anything — see the plan's execution record for the
2026-09-19 incident that made that necessary.

## 9. Done means

1. All six spikes reported in the table below; the design branch chosen.
2. TypeScript and Rust tests pass; the existing 768 tests still pass; typecheck clean; `SMOKE OK`.
3. The staged-window run meets the P4 and P5 numbers on the owner's machine.
4. The manual checklist is recorded.
5. `pnpm --dir app start` reads the real screen end to end through the unchanged loop.
6. The helper's memory after 1,000 reads is recorded.
7. The Developer ID re-check is listed in `docs/HANDOFF.md` as carried to packaging.

## 10. Spike results

Filled in during phase 0. All numbers come from
`docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`, which holds the full records.
Everything below was measured on one machine: macOS 27.0, a 1x external display, a self-signed
certificate, single runs.

| # | Date | Finding | Consequence for the design |
|---|---|---|---|
| P1 | 2026-09-18 | PASS. The standalone helper binary inside the signed app bundle (separately signed with the same certificate, started by the app with `child_process`) captured a window through ScreenCaptureKit as soon as the owner enabled the bundle's Screen & System Audio Recording entry: before the grant `-3801` with `preflight:false`, after it `capture:"ok"` with `preflight:true`, for both a long-lived and a fresh helper. A control experiment settled where the access is attributed: an identical twin bundle (different bundle id, same certificate, and the capturing binary has the SAME code identity in both) was refused while the original captured, so the grant follows the enclosing app bundle, not the capturing binary and not the launching process. The grant also survived re-signing the bundle with the same certificate. One machine, macOS 27.0, self-signed certificate, single runs. | The standalone helper of section 2 is the design. The Node-child form (`ELECTRON_RUN_AS_NODE`) and the capture-in-main fallback are not needed — and the fallback was not needed rather than broken. Corrected 2026-09-18 (final review): Electron's `desktopCapturer.getSources` in main failed in all 26 records of the three app processes that were already running when their grant arrived (`host-smoke`, `p1p2-aborted`, `p1p2`, `p6`), and returned four sources with four non-empty thumbnails in all 5 records of the two app processes launched after the grant (3 in `out/resign-watch.jsonl`, 2 in `out/resign-watch-rust.jsonl`) — 31 `main` records in all. The supportable reading: in these runs Electron's own capture in an app process that was already running when the grant was given kept failing, while a freshly launched app process succeeded; the helper picked the grant up without any relaunch. So the capture-in-main fallback WAS seen working after a relaunch, is not needed, and would have required an app relaunch after the grant. P1's second pass criterion ("System Settings lists the grant under the app") does not always hold: a grant can be in force while the list shows no entry at all for a bundle in a temp folder, which `tccutil` also cannot resolve (-10814). BUILD PLAN: dev builds must run from a registered location (`~/Applications` or `/Applications`), or their entry can be neither seen nor revoked; and permission state must never be inferred from the Settings list, only from the helper's own check and capture result. |
| P2 | 2026-09-18 | PASS on the restart question, with one failure inside. Restarting the helper is enough, and more: the first record after the grant shows a fresh helper B capturing and the ALREADY RUNNING helper A flipped to `capture:"ok"` / `preflight:true` in the same record, with the app never restarted and macOS offering no "Quit & Reopen" (the owner did not time the toggle, so in the first run that record is only bounded to within 84 s of it — last error 06:48:59.555Z, first ok 06:50:23.136Z; the twin replication bounds it to 3.4 s). Replicated on a second bundle in `~/Applications` (last refused record 07:09:07.147Z, first `ok` 07:09:10.504Z, both helpers) — two runs, which do not establish frequency. The prompt: macOS 27 raises a dialog naming the .app FILE name — "requesting to bypass the system private window picker and directly access your screen and audio", buttons Allow / Open System Settings. The failure: the helper's `CGRequestScreenCaptureAccess()` answered `false` (bundle under `/private/tmp`), no entry appeared in the list by itself, and it was not retested from a registered location. | Section 5.3 keeps `needsRestart` and the single automatic helper restart exactly as designed; the "restart the app" branch of P2 is not needed. `requestPermission()` cannot rely on the helper raising the system prompt or on the app registering itself in the list. BUILD PLAN: retest `requestPermission()` from an installed build; keep B's flow of opening the settings pane and telling the user to add and enable the app, which works regardless; and make onboarding prepare users for the dialog's wording and for the fact that the name they will look for is the .app file name, not `CFBundleName`. |
| P3 | 2026-09-18 | PASS. A plain Rust binary built on the objc2 framework crates, run from inside the signed bundle, captured one named window with ScreenCaptureKit and recognised its text with Vision at a median of 89–104 ms across 1,000 reads (highest ten-line median 104 ms at 600 reads), with RSS growing 0.4 MB between read 100 and read 1,000 and accuracy within 0.002 of the Swift probe (Rust 0.9902, Swift 0.9882 on the same window, back to back). The Rust source compiled on the first attempt; no binding spelling had to be corrected. One run of each measurement, macOS 27.0, 1x. **The Rust probe exercised neither production path:** it selected its window by application name through `SCShareableContent` (`rust/src/main.rs:36–48`, whose own comment says so) where the design selects by window id from the window server, and it recognised the **colour** image (`rust/src/main.rs:119`) where the design recognises greyscale. Both of those paths are proven in the Swift probe only (`probe/main.swift:33–46` takes `kCGWindowNumber` and matches `windowID`; `probe/main.swift:70–72,117` converts with `CGColorSpaceCreateDeviceGray` before recognising). The P3 speed and RSS figures are therefore colour-path, app-name figures; the P4/P5 accuracy figures are Swift greyscale, window-id figures. Measured RSS was flat at 58.0–63.8 MB (Rust) and 44.3–53.3 MB (Swift) — about 6× the "about 10 MB" assumed in decision 5; see the note under that table. | Section 6's fallback — moving the macOS layer into a thin Swift static library — is not needed; objc2 reaches both frameworks correctly and at speed. BUILD PLAN must carry: (1) open the window-server connection first — `CGWindowListCopyWindowInfo` before any `SCContentFilter`, otherwise SkyLight `assert`s and the process aborts, which is not catchable; measured that `CGPreflightScreenCaptureAccess` alone does not suffice; (2) run one throwaway recognition before the helper announces `ready` — the first-ever recognition per binary cost ≈45 s (Rust 45,251 ms, Swift 46,900 ms) while later fresh processes started warm at 87–200 ms, and what triggers the cold cost was not isolated, so measure it again after a rebuild and after a reboot. Rust is about 2× slower per read than Swift (92 vs 46 ms) and about 15 MB higher in steady RSS; that the colour-vs-grey input difference explains it is an untested hypothesis. Both are far inside the 400 ms budget. |
| P4 | 2026-09-18 | PASS, all five groups over their section 6 thresholds, minimum accuracy per group: chat 1.0, ticket 0.9966, terminal 0.9882, Portuguese 0.9975 with accents 1.0, code 0.948. 17 reads (4 staged pages × light/dark × 14/11 px, plus one Terminal read), each case read exactly once. Every read was at 1x pixel density on an external 2560×1440 display — the harder case, where 11 px text is 11 physical pixels; 2x Retina was not measured. The residual errors on code are punctuation: backtick read as apostrophe (3 occurrences), `}` as `1`, `<` as `«`. The recogniser also returns script homoglyphs: `U+0410 CYRILLIC CAPITAL LETTER A` appeared for Latin `A` in 5 of the 17 reads — all four `ticket-*` reads (the leading `A` of the same staged heading) and `code-light-14` (inside a screaming-snake-case constant) — i.e. the same character in the same word across both themes and both sizes. **Single-sample caveat, added 2026-09-18 (final review):** each case was read once, and the earlier discarded run of the same 17 cases differed on 10 of them, including `terminal` at 0.8686, below its 0.95 threshold; see 10.2. | Section 5.2 step 5 stands as specified (accurate mode, language correction off, grayscale). No threshold was lowered and nothing had to be escalated to the owner. BUILD PLAN must carry two product facts. Low-contrast and small faint text is DROPPED by the recogniser, not misread: a staged marker line at roughly 2:1 contrast vanished from the text until its opacity was raised, so disabled or secondary UI text can be absent rather than misread — twice in this phase a low-contrast or small line was dropped while the text around it was recognised — and missing text must never be read as "nothing was there". Recognised text can also contain visually identical characters from other scripts (homoglyphs), so the helper's text assembly must apply a documented normalisation before anything matches it; see 10.1 item 13. And a captured window includes its own title bar, so the title text reaches the pipeline inside `text` as well as in `window.title`. Both were observed at 1x only. |
| P5 | 2026-09-18 | PASS for both browsers tested. Chrome 153.0.8010.52: address host recognised in 20/20 normal captures and in 20/20 Incognito captures, private label in 20/20 Incognito captures, and 0/20 false private hits when the label matcher was run against the normal captures. Safari 27.0: host 5/5 normal and 5/5 private, private label 5/5, 0/5 false. The label has no single spelling — Chrome renders it `* Incognito` (11), `Incognito` (8), `- Incognito` (1); Safari `• Private` (2), `Private` (2), `¡• Private` (1) — the leading mark is the recogniser's rendering of the icon glyph. Single run per case, 1x, one window height per browser, default toolbars, Arc not installed. | Section 5.2 step 7's band is per browser and must be carried in points multiplied by the display's pixel scale at capture time, never as a fraction of window height: a toolbar's height is fixed in points, and every capture in this run had the same height, so invariance was never exercised. Measured at 1x: Chrome 153.0.8010.52 (bundle id `com.google.Chrome`) markers reach 74 px, about 82 px with a 10% margin; Safari 27.0 (`com.apple.Safari`) markers reach 37 px, about 41 px with the same margin. **Those are the only two bundle ids with a measured band; every other browser is unmeasured.** The build plan must define what happens for a browser with no measured band. Options to weigh, not decided here: return no `toolbarText` at all, so the core treats the window as an unknown browser; or apply a conservative default band. Neither is free — a too-tall band produces false private-window hits from ordinary page text containing a host name or the word "incognito"/"private", and borrowing another browser's band is never safe (Chrome's and Safari's differ by a factor of two). BUILD PLAN: match the word case-insensitively inside that tight band, never as an exact string; a generous band (the 260 px used by the spike tool) would let ordinary page text containing a host name or the word "incognito" match. Untested and therefore not covered by this result: 2x displays, a bookmarks bar, extension toolbars, side panels, tab groups or non-default themes, Safari with several tabs (its compact layout may shorten or hide the host), and Arc. |
| P6 | 2026-09-18 | PASS. With the helper running, the owner switched the grant off: the last granted record was 07:10:01.609Z and the first record that differed, 07:10:27.108Z, was `-3801` with `preflight:false` for BOTH the long-running helper A and the fresh helper B. (The watch polls every 3 s but writes a record only when it changes, so the two records are 25.5 s apart while the flip itself was seen at the first poll after the owner's toggle; the owner did not time the toggle.) The capture was never black and never a stale frame, macOS showed no quit prompt, and the app was not killed (its Electron process was still running afterwards). One revocation, measured on the twin bundle in `~/Applications`, macOS 27.0. | Section 5.3 stands exactly as written and needs no adjustment: a refused capture answers `failed`, never `black`, and `permission()` leaves `granted` on the refusal — including inside a process that was already running when the grant went away. BUILD PLAN: the ungranted signal is the error domain and code (`SCStreamErrorDomain` -3801), which marked every ungranted state in this phase, never-granted and revoked alike; it must be recognised by domain and code, not by a missing title list, since `titles` was briefly 4 without the grant. |

### 10.1 What the build plan must carry

1. Open the window-server connection before any `SCContentFilter`: call `CGWindowListCopyWindowInfo`
   in the helper's prologue. `CGPreflightScreenCaptureAccess` alone is not enough (measured), and
   without it the process aborts inside SkyLight with nothing to catch. (P3)
2. Run one throwaway recognition before the helper announces `ready`, and design the startup around
   the possibility that it costs up to ~45 s (measured: Rust 45,251 ms, Swift 46,900 ms for the
   first-ever recognition per binary; later fresh processes started warm at 87–200 ms; the trigger
   was not isolated). Specifically: the helper warms up BEFORE it emits `ready`; the supervisor's
   start deadline must allow a cold start (≥ 60 s) without counting it as a crash or towards the
   five-unplanned-exits rule; section 4's planned restart (500 reads / 6 h) must start the
   replacement and wait for its `ready` before retiring the old helper, or the app loses reads for
   the whole warm-up; and what calls arriving before `ready` do — answer `failed` at once, or be held
   until `ready` — is a decision the build plan must make, bound by the constraint that the loop's
   failure window (five failures in ten minutes → `onReaderProblem`) must not trip during a cold
   start, and by the client deadlines (`budgetMs` + 4 s for `read`, 4 s for the others). Measure the
   cold cost again after a rebuild and after a reboot. (P3)
3. Retest `requestPermission()` — `CGRequestScreenCaptureAccess` from the helper — from an installed
   build; it answered `false` from a bundle in a temp folder and was never retried elsewhere. (P2)
4. Keep B's flow of opening the Screen & System Audio Recording pane and telling the user to add and
   enable the app; it works whether or not the system prompt appears. (P2)
5. Prepare the user, in onboarding, for the macOS 27 dialog's wording ("requesting to bypass the
   system private window picker and directly access your screen and audio") and for the entry being
   named after the .app file name. (P2)
6. Run dev builds from a location the app registry knows (`~/Applications` or `/Applications`). From a
   temp folder the entry is not listed and `tccutil` cannot resolve the bundle id (-10814). (P1)
7. Derive permission state only from the helper's own check and its capture result — never from the
   System Settings list, and never from `titles` alone: an ungranted helper still saw 1 to 4 titles,
   so a non-null `frontWindow()` answer does not imply the grant is in force, and `frontWindow()`
   must gate on the helper's own permission state. Map `SCStreamErrorDomain` -3801 to `failed`.
   (P1, P6)
8. Carry the toolbar band per browser, in points multiplied by the display scale at capture time:
   Chrome 74 px measured, about 82 px with margin at 1x; Safari 37 px, about 41 px at 1x. Never a
   fraction of window height. Only those two bundle ids (`com.google.Chrome`, `com.apple.Safari`)
   have a measured band; the plan must define the rule for an unlisted browser — no `toolbarText`,
   or a conservative default band — and must never borrow another browser's band. A too-wide band
   produces false private-window hits from ordinary page text (P5's method note). (P5)
9. Match the private-window word case-insensitively inside that band, never as an exact string: three
   renderings were seen in Chrome and three in Safari. (P5)
10. Treat text that is not recognised as missing, not as absent content: low-contrast and small faint
    text is silently dropped by the recogniser. (P4)
11. Expect a captured window's own title-bar text to arrive inside `text`. (P4)
12. Build the standalone helper of section 2; do not plan the Node-child form or the capture-in-main
    fallback. If the fallback is ever revived, note that Electron's main process picked up a fresh
    grant only after a relaunch (26 records failed in already-running processes, 5 succeeded in the
    two processes launched after the grant), whereas the helper picked it up without any restart.
    (P1, P2)
13. Normalise recognised text for script homoglyphs before it is matched or compared: macOS
    recognition returned `U+0410 CYRILLIC CAPITAL LETTER A` for Latin `A` in 5 of 17 P4 reads (and in
    5 of the 8 `ticket-dark-14` P5 captures), systematically in the same words. The helper's text
    assembly must apply a documented normalisation — at minimum, map Cyrillic and Greek look-alikes
    to Latin when the surrounding word is Latin-script. This is a requirement for the build plan to
    design and test, not a finished algorithm. Anything in sub-project A that string-matches
    recognised text (scrub rules, secrets patterns, skill and person names, the English check) must
    not assume ASCII letters. (P4, P5)
14. Budget the helper at ~60 MB RSS, not the ~10 MB assumed in decision 5: the Rust probe held
    58.0–63.8 MB flat over 1,000 reads (Swift 44.3–53.3 MB). Memory was flat, so this is a fixed
    cost, not a leak. (P3)
15. `reader:eval` (the staged-window run of section 7) must read every case several times — five is
    a reasonable default — and report the minimum and median per case, not a single sample. Phase 0
    read each case once, and the terminal case moved 0.8686 → 0.9882 between two runs. The terminal
    case must be re-measured this way before sub-project C is accepted. A later repeat (findings,
    "P4 addendum 2") read one unchanged staged Terminal window ten times: 0.9882 every time, one
    identical text — so recognition of unchanged pixels is deterministic here and the 0.8686 came
    from a different window state (size, wrap, scroll or frontmost window; which is not
    established). `reader:eval` must therefore also stage each window at fixed, recorded sizes,
    including a narrow terminal. (P4)
16. The first Rust task must prove the two production paths the Rust probe never exercised: window
    selection by window id taken from `CGWindowListCopyWindowInfo` (the probe selected by
    application name through `SCShareableContent`) and greyscale conversion before recognition (the
    probe recognised the colour image), and must re-measure speed and RSS on that combination. The
    P3 figures do not carry over unchanged. (P3)
17. Prove the focus detection of section 5.5 early: workspace notifications on the helper's own event
    loop was a stated reason for choosing the standalone helper, and no spike exercised it. (design)

#### Status of these seventeen items after C-2a (2026-09-19)

Plan `docs/superpowers/plans/2026-09-18-native-reader-c2a-helper.md` was executed and the helper met
real windows for the first time on 2026-09-18/19. Evidence for every "done" below, unless another
file is named, is `docs/superpowers/reviews/2026-09-19-native-reader-c2a-first-run.md`; the code
review that preceded it is the C-2a execution record in the plan.

| Item | Status after C-2a |
|---|---|
| 1 window-server prologue | **Done.** Built as specified and verified by reading; the helper then ran for hours inside the bundle, capturing by `SCContentFilter`, without the SkyLight abort |
| 2 warm-up before `ready`, startup designed for ~45 s | **Partly.** The warm-up, the 90 s start deadline (`HELPER_START_DEADLINE_MS = 90_000`), the planned restart waiting for the replacement's `ready` and the pre-`ready` answers are all built and tested; the cold cost was **not** re-measured after a reboot (D12 below) |
| 3 retest `requestPermission()` from an installed build | **Done.** It raises the dialog from `~/Applications`; wording and both dialogs are recorded in the note at the end of 5.3 |
| 4 keep B's "open the pane and add the app" flow | **Unchanged, carried.** Nothing in C-2a altered it, and the run shows it is still the path that always works |
| 5 onboarding copy for the dialog and the .app file name | **Not done → C-2b.** The wording is now known, and one existing sentence ("After you allow it, the app has to restart once.") was measured to be wrong |
| 6 run dev builds from a registered location | **Done.** `~/Applications`, bundle id `dev.clave.agent.dev`; the entry is listed and can therefore be revoked, unlike phase 0's temp-folder bundle |
| 7 permission only from the helper's own check and capture result; −3801 → `failed` | **Partly.** Built and reviewed exactly so; the −3801 path itself was **never exercised** in C-2a — no capture was refused and the grant was never revoked under a running helper |
| 8 per-browser band in points × scale | **Partly.** Chrome 82 pt and Safari 41 pt are carried as measured, an unlisted bundle id gets no band, and Safari reads really did come back with `toolbarText`; no band-acceptance number was measured on the Rust path |
| 9 match the private word case-insensitively inside the band | **Partly.** All three Chrome and all three Safari renderings are covered by unit tests, and the bare word counts for Safari only (D1). A Safari private window in front for two minutes produced no statement, which is **consistent with the rule working and is not evidence** that the helper delivered the badge in `toolbarText` on the Rust greyscale path: that observation is from the first run, with the pre-fix code, in a session where reading had been switched off by `READER_PROBLEM`, and no control read was completed in it. Carried to C-2b as item 29 |
| 10 unrecognised text is missing, not absent | **Carried as documentation.** Nothing to build; not re-examined |
| 11 title-bar text arrives inside `text` | **Carried as documentation.** Nothing to build; not re-examined |
| 12 build the standalone helper | **Done.** `clave-reader`, one child process of the bundle's Electron, protocol 1 |
| 13 normalise homoglyphs before anything matches | **Partly.** Done in the helper, before the toolbar strip is cut (D4), with a documented table and tests. The sub-project-A half — that anything in A which string-matches recognised text must not assume ASCII — is **not** done: the whole defence sits in the helper |
| 14 budget ~60 MB RSS | **Partly, and the number moved.** Measured on the real combination, in DIFFERENT helper processes, so this is not one growth curve: 28 MB in the first run's helper after its first reads (2026-09-18); in the second run's helper (2026-09-19) 71 MB after five minutes and 85 MB after three hours. Only those last two belong to one process; whether that is growth or a plateau is a new open item |
| 15 `reader:eval` with repeated reads at fixed sizes | **Not done → C-2b** |
| 16 prove window-id selection and greyscale in Rust, re-measure speed and RSS | **Partly.** Both production paths ran on real windows for the first time — 27 `ok` reads of 36, 54–573 ms, median 230 ms, inside the 1 500 ms budget, with the RSS figures above. **Accuracy** on that combination is still unmeasured |
| 17 prove the focus detection early | **Done.** Focus events were seen arriving from both sources in the helper inside the bundle |

#### Addendum 2026-09-19 (C-2b-1): the items whose status moved

Plan `docs/superpowers/plans/2026-09-19-native-reader-c2b1-code.md` was executed and reviewed on
2026-09-19. It was the code half of C-2b by owner decision O5, so nothing in it met a screen and no
item moved to a state that needs one. Only these three moved at all; every other row above stands as
written.

| Item | Status after C-2b-1 |
|---|---|
| 5 onboarding copy for the dialog and the .app file name | **Built, not yet seen.** The permission step now leads with what the dialog will say ("screen and audio") and what is actually true, names the entry after the .app FILE, and says the + button may be needed. The sentence measured wrong in C-2a — "After you allow it, the app has to restart once." — is gone, and a test keeps it out of `copy.ts`; `BLOCKERS.PERMISSION_NEEDS_RESTART` stays for the rare case it really describes. Two things remain: nobody has looked at the surface rendered, and by D16 the file name is derived as `${COPY.appName}.app`, so a DEV build shows "Clave Agent.app" where the list says "Clave Agent Dev.app" — an OPEN CHOICE for the owner (one more `AppInfo` field) |
| 13 normalise homoglyphs before anything matches | **Done, both halves.** The sub-project-A half is now built (D5): the core repairs `text` and `toolbarText` at the top of `ingest`, before the gate, the after-rules and the scrub, with the same one-sentence rule and the same 37-pair table as `text.rs`, pinned by ONE shared pure-ASCII fixture asserted by both the Rust and the TypeScript tests. Titles are NOT repaired — they come from the window server, not from recognition — and a test says so. A no longer depends on which reader produced the text. The example this item was written from (U+0410 for Latin A) is a case in that fixture |
| 15 `reader:eval` with repeated reads at fixed sizes | **Built, never run.** Five repetitions per case by default, minimum AND median reported per case, fixed recorded window sizes including a narrow terminal (72 columns) beside the wide one (140), and a fresh staging per repetition (D10). The instrument exists; the terminal case has NOT been re-measured and no number in section 6 has been checked against the Rust path. The measurement is C-2b-2 |

### 10.2 Still unverified

- Retina/2x displays: every capture in this phase was at 1x. Both the P4 accuracy numbers and the P5
  band figures are 1x results.
- A real Developer ID: P1, P2 and P6 were measured with a self-signed certificate and must be
  repeated once signing exists (already listed as carried to packaging). Note that the grant
  surviving a re-sign was measured only with the *same* certificate; changing the signing identity
  changes the designated requirement and is expected to reset the grant, which was not measured.
- What triggers the ≈45 s cold recognition cost (first use by a binary, a new build or signature, a
  reboot, a cache eviction). Narrowed 2026-09-19 (C-2a, D12): while the plan was written, freshly
  rebuilt, byte-different binaries were ready in 0.1–0.6 s after one machine-level cold cost of
  43.3 s, so the cost belongs to the **machine**, not to the binary or its signature. A reboot and a
  long idle are still untested.
- Non-default browser toolbars: bookmarks bar, extension toolbars, side panels, tab groups, themes.
- Safari with several tabs, where the compact layout may shorten or hide the host.
- Arc: not installed on this machine, not tested. Added 2026-09-19 (C-2a): **no** browser other than
  Chrome and Safari is installed on this machine (the `~/Applications` "Brave/Edge/Helium Apps"
  folders are web-app shortcuts), so that the core refuses an unmeasured browser has never been seen
  in real use — it is covered by unit tests only.
- Messy real screens and the owner's real VS Code — the manual checklist of section 7, which is not
  part of phase 0. Narrowed 2026-09-19 (C-2a): the owner's real VS Code, Safari, Linear and Wispr
  Flow windows were read in ordinary use (27 `ok` of 36 diagnostic reads, 3 `black`, 6 with no front
  window) and the app produced statements end to end; the checklist itself — overlapping windows, a second display, a full-screen app,
  the grant revoked mid-run, the helper killed mid-read — is still not run.
- The capture-in-main fallback of section 2 as a *live* fallback: `desktopCapturer` worked only in
  app processes launched after the grant, and was never exercised as an actual capture path (only
  `getSources` with thumbnails was called).
- Run-to-run variance of recognition is unquantified. Each P4 case was read once, and the discarded
  earlier run of the same 17 cases differed on 10 of them without any staging change — including
  `terminal` at 0.8686, under its 0.95 threshold, against 0.9882 in the accepted run. The staged-window
  run of section 7 must repeat cases rather than read each once (10.1 item 15).
- The **accuracy** of the production combination in Rust. The paths themselves are no longer
  unverified: 2026-09-19 (C-2a) ran selection by window id from `CGWindowListCopyWindowInfo` plus a
  greyscale redraw before Vision on real windows, 27 `ok` reads at 54–573 ms (median 230 ms) inside
  the 1 500 ms budget, with RSS 28 MB in the first run's helper after its first reads and, in the second run's helper (a
  different process), 71 MB after five minutes and 85 MB after three hours. What that run did **not** do is compare any recognised text against known text, so the
  P4/P5 accuracy numbers are still Swift-greyscale figures and no Rust-greyscale accuracy or
  band-acceptance number exists.
- Browsers other than Chrome 153 and Safari 27: no measured toolbar band exists for Arc, Edge,
  Firefox, Brave, Orion or any other Chromium derivative, and the band cannot be derived from window
  height.
- The helper-side focus detection of section 5.5: no spike exercised it. Workspace notifications on
  the helper's own event loop, the one-second front-window id/title comparison, and pausing that poll
  while the screen is locked are all unverified, as is `read` answering `locked` — the screen was
  never locked in any spike run. Narrowed 2026-09-19 (C-2a): focus events **were** seen arriving from
  both sources in the real run. Locking the screen for about a minute and unlocking was exercised at
  the application level — one `CAPTURE_OFF`/`CAPTURE_ON` pair, the same helper alive throughout, no
  problem code, reading resumed — but no `read` was observed answering `locked`, and the helper
  pausing its own poll while locked is still unverified.
- The same-pixels shortcut of section 5.2 step 4: never exercised. No spike took two captures of an
  unchanged window — every spike read re-launched the probe or recaptured per iteration — so it is
  unknown whether successive captures of a static window are pixel-identical often enough for the
  cache to hit. The section 5.4 cost estimate does not depend on it, but the cache's usefulness is
  unmeasured. Unchanged by C-2a: the first real run did not measure cache hits either.

Added 2026-09-19 (C-2a) — questions the first real run opened rather than closed:

- **Helper memory growth.** RSS was 71 MB after five minutes and 85 MB after three hours in the same
  process. Phase 0 called the ~60 MB flat over 1,000 reads; this is the first figure from real,
  varied windows and it is not flat. Whether the planned restart (500 reads or 6 hours) really bounds
  it is unmeasured.
- **`black` on real windows.** The read answered `black` three times in 36 diagnostic reads (twice
  for one app, once for another) with no explanation. The black check samples a fixed grid of at most
  three channels (never alpha), so a genuinely black capture and a capture that failed in some
  unexamined way look the same from outside. The loop does not count `black`, so it is silent.
- **The twelve browser names added to the core's list** (`orion`, `duckduckgo`, `tor browser`,
  `helium`, `sigmaos`, `librewolf`, `waterfox`, `floorp`, `thorium`, `yandex`, `whale`, `min`) were
  taken from published app names and never checked against what macOS reports as
  `kCGWindowOwnerName`. A wrong name costs only the old behaviour for that one browser; "helium" also
  matches an unrelated video player, and the prefix rule means "Chrome Remote Desktop" is not read
  either. Both are the safe direction, and both are unmeasured.
- **Defect D-A after its fix, in real use.** That a client replacing a stale `denied` helper really
  makes onboarding continue by itself was never re-tested on a real grant: at the second run the
  grant was already in place. It is covered by unit tests and by the measurement of the defect
  itself.
- **A revocation, and the −3801 path, against this code.** Neither was exercised in C-2a. They are two
  different paths: a revocation shows up as preflight false → `noWindow` → the engine's 10 s permission
  poll switching capture off, and must be tested there; −3801 → `Refused` → `failed` is for a capture
  refused while the preflight still says yes.
- **The helper's CPU share per read**, because the diagnostic recorded outcomes, timings and sizes
  but not capture durations. Whole-process figures exist: about 2.3 % of one core over 4.5 minutes of
  ordinary use, warm-up included.

Added 2026-09-19 (C-2b-1) — everything this plan built and nothing it measured. C-2b-1 was the code
half by O5, so it narrowed none of the list above; it added instruments, and it added these:

- **The whole of `reader:eval`, beyond its fakes.** It has never met a screen. Its dev report lists 22
  things only a screen decides — first among them Terminal honouring the title escape sequence (if it
  does not, every terminal repetition is `notStaged` and reads nothing) and Chrome honouring
  `--window-size` — in section 6 of
  `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/dev-reports/task8-dev-report.md`. They
  fail loudly rather than produce wrong numbers.
- **The three comparisons against real window titles**, and `stats` and `lines` on real captures. The
  numbers `stats` exists to supply — capture durations, cache hits, frame sizes, the toolbar band in
  pixels — have never been produced by a real read.
- **The compile-verified-only lines of `macos/focus.rs`** (`:47`, `:105`, `:136`, `:142`) and
  `macos/recognise.rs:108`, plus the re-entrancy hazard described in the note at the end of 5.5:
  watch for `E_PANIC` in the first real run.
- **The launcher inside the REAL bundle**, under macOS's own "Quit & Reopen". Proven in a dry-run
  bundle in a scratch folder, and by unit tests of the pure half, only.
- **Both renderer surfaces as rendered pixels** — the rewritten permission step and the nothing-read
  line. Nobody has seen either.
- **The nothing-read notice against a real day.** Whether 24 cycles AND 10 minutes is the right pair
  is a judgement only a day of use settles, and one gap is known: a stretch in which NO cycle ran at
  all — a sleeping machine — counts as presence, so a machine woken by a keypress can raise a notice
  on its first cycle, dated before the sleep.
- **The dev bundle itself is still behind.** Until Task 9's `dev:bundle` has been run by the owner,
  `~/Applications/Clave Agent Dev.app` holds a protocol-1 helper while the checkout speaks protocol 2.
  That bundle was also re-created by accident at 20:03 on 2026-09-19 by an agent's test import, so the
  owner is to confirm that the Screen Recording grant still holds before anything is launched.
