# Desktop app (sub-project B): design

Status: written 2026-09-17 after a section-by-section brainstorm with the owner, every section
approved. Self-reviewed. Awaiting the owner's read-through before a plan is written.

Builds on: `docs/implementation-plan.md` (overall plan, one pitch, spike results),
`docs/superpowers/specs/2026-09-17-core-pipeline-design.md` (sub-project A, built and hardened:
`app/src/core/`, 257 tests), `docs/superpowers/reviews/2026-09-17-core-pipeline-final-review.md`.

## 1. Purpose and scope

B is the Electron app around the core pipeline: it decides when to read the screen, runs the local
model, keeps the pending statements, shows them to the user once a day, and uploads what the user
approves. It targets macOS first.

B depends on two pieces that do not exist yet: the native reader (sub-project C) and the clave-back
endpoint (sub-project D). **B is built against two ports, `Reader` and `ClaveApi`, and ships with
stand-ins for both.** C and D each replace one stand-in later; the ports are their contract.

### Decisions made in this brainstorm

| # | Decision |
|---|---|
| 1 | B builds against ports with stand-ins (`devReader`, `stubApi`); login, taxonomy and upload are fully specified here but wired to the stub until D lands |
| 2 | The model is downloaded on first run from a URL held in configuration, verified against a SHA-256 pinned in the app; capture is gated on a self-test |
| 3 | One daily review prompt at a time the user picks (default 17:30); no prompt when the pool is empty; the list is always reachable from the tray |
| 4 | Extraction runs on battery with three guards: pause under 20% battery while unplugged, pause under serious thermal pressure, unload the model after 10 idle minutes |
| 5 | Core in the main process; model in a `utilityProcess`; reader in its own child process; sandboxed renderer |
| 6 | Core change: `signal("modelPaused" | "modelResumed")` so closed scenarios wait in the queue during a pause (the 60-minute drop still applies) |
| 7 | Rejected statements are not remembered in v1 (remembering would mean storing their text) |
| 8 | The UI is built with the `frontend-design` skill (owner's instruction); see section 7 |

### Not in B

The native reader (C). The real clave-back client (D). Sentry, usage events, signing, notarisation,
auto-update and the installer (the fifth piece). Windows and Linux. Audio, editing statements,
search, a timeline, any local database, any setting beyond those in section 7.

## 2. Processes and folders

```
┌──────────────────────────── main process ─────────────────────────────┐
│ core pipeline · capture loop · pool/outbox · API client · tray · power │
└───▲───────────────▲──────────────────▲──────────────────────▲─────────┘
    │ typed IPC     │ messages         │ messages             │ HTTPS
┌───┴────────┐ ┌────┴───────────┐ ┌────┴──────────┐   ┌───────┴────────┐
│ renderer   │ │ model host     │ │ reader        │   │ clave-back     │
│ React,     │ │ utilityProcess │ │ child process │   │ (stubApi until │
│ sandboxed  │ │ node-llama-cpp │ │ (devReader    │   │  D exists)     │
└────────────┘ └────────────────┘ │  until C)     │   └────────────────┘
                                  └───────────────┘
```

Screen text exists in exactly two places: briefly in the reader, and in the core's 60-minute
in-memory buffer in main. The renderer never receives screen text.

```
app/src/
  core/                 sub-project A (exists)
  main/
    ports/              reader.ts, claveApi.ts         interfaces and types only
    capture/            loop.ts
    model/              host.ts (utility entry), client.ts (ModelPort over messages),
                        supervisor.ts, download.ts, selfTest.ts
    account/            session.ts, taxonomy.ts
    review/             pool.ts, uploader.ts, sentLog.ts, scheduler.ts (daily prompt)
    storage/            secureFile.ts (safeStorage + atomic write), paths.ts
    power.ts            battery, thermal, lock/unlock, sleep/resume, idle time
    settings.ts
    ipc.ts              the typed channel list, shared with the preload
    log.ts              codes and counts only
    app.ts              wiring, lifecycle, single-instance lock, tray
  preload/              exposes the ipc.ts calls and nothing else
  renderer/             React: onboarding, home, review, settings, copy.ts
  standins/             devReader.ts, stubApi.ts
eval/run.ts             real-model evaluation runner
```

Each `main/` module takes its dependencies (ports, clock, filesystem, pipeline) as arguments, so
every one is unit-tested without Electron.

## 3. The two ports

### 3.1 Reader

```ts
type Permission = "granted" | "denied" | "needsRestart" | "unknown";
type ReadFailure = "locked" | "black" | "timeout" | "failed";

interface Reader {
  permission(): Promise<Permission>;
  requestPermission(): Promise<void>;
  frontWindow(): Promise<FrontWindow | null>;                 // core's FrontWindow
  read(opts: {budgetMs: number}): Promise<
    | {ok: true; window: FrontWindow; text: string; toolbarText?: string}
    | {ok: false; reason: ReadFailure}>;
  onFocusChange(cb: () => void): () => void;                  // returns unsubscribe
  dispose(): Promise<void>;
}
```

The reader decides nothing. It never sees the exclusion rules. Whether it is a `utilityProcess` or a
child of the main binary is C's choice (spike S2 showed macOS grants differ between the two). Every
value that crosses this port is validated in main before use; a malformed value counts as
`{ok: false, reason: "failed"}`.

### 3.2 ClaveApi

```ts
interface Session { token: string; expiresAt: number; userId: string }
interface Taxonomy { version: string; skills: Skill[]; competencies: Competency[] }   // core types
interface ApprovedStatement {
  clientItemId: string; statement: string; kind: "skill" | "competency"; targetId: string;
  createdAt: number; taxonomyVersion: string; pipelineVersion: string;
}
type ApiErrorCode = "BAD_CREDENTIALS" | "UNAUTHORISED" | "OFFLINE" | "SERVER" | "BAD_RESPONSE";

interface ClaveApi {
  signIn(identifier: string, password: string): Promise<Session>;
  refresh(session: Session): Promise<Session>;
  profile(session: Session): Promise<{names: string[]}>;
  taxonomy(session: Session, knownVersion?: string): Promise<Taxonomy | "unchanged">;
  submitEvidence(session: Session, items: ApprovedStatement[]): Promise<{accepted: string[]}>;
}
```

Failures reject with an `ApiError` carrying one `ApiErrorCode` and nothing else. `clientItemId` is
the pending statement's id, so a retried upload is safe to repeat. Responses are validated with zod.

### 3.3 Stand-ins

- `devReader`: replays `eval/fixtures/*.json`, or a folder of `.txt` files (file name = app and
  title), as if they were windows, on a timer. Permission is always `granted`.
- `stubApi`: accepts any sign-in, serves `standins/taxonomy.json`, appends uploads to
  `stub-uploads.jsonl` in the data folder.
- One build-time flag selects them. A test asserts the production build refuses to start with
  either stand-in, and that the stand-ins are not in the production bundle.

## 4. Capture loop (`capture/loop.ts`)

**Runs only when** the user is signed in, a taxonomy is loaded, the model is verified and the
self-test has passed, the permission is `granted`, and the switch is on. When any of these stops
holding, the loop sends the core `captureOff` (which closes the open scenario) and stops calling the
reader. "Pause for 1 hour" is the same as off, with a timer that switches back on.

**Triggers.** No fixed 5-second timer.
- a reader focus-change event, read 400 ms later;
- while the user is active, a poll every 5 s;
- when there has been no input for 60 s (`powerMonitor.getSystemIdleTime()`), a heartbeat every 30 s.

**One read at a time.** A trigger during a read sets a dirty flag; one more read follows. Reads are
never queued.

**One cycle.**
1. `front = reader.frontWindow()`; null → skip.
2. `pipeline.mayCapture(front)`; denied → skip. Nothing has been captured.
3. `reader.read({budgetMs: 1500})`; not ok → count the reason, skip.
4. `reader.frontWindow()` again; if app or title differ from step 1 → discard the read.
5. `pipeline.ingest({...front, text, toolbarText, at})`.

`pipeline.tick()` runs every 10 s whether or not capture is on (expiry must keep working).

**Launch.** The switch state is restored from `settings.json`. If it was on and every precondition
holds, capture resumes and the app shows one notification saying capture is on; otherwise it stays
off and the home screen says why.

**Lock, sleep, quit.** `powerMonitor` lock and suspend → `signal("locked")`; unlock and resume →
`signal("unlocked")`. On quit: `captureOff`, wait up to 5 s on `whenIdle()`, save the pool, exit.

All intervals above are named constants in `main/constants.ts`.

## 5. Model runner

**Pinned pair.** node-llama-cpp 3.21.1 and `Qwen3.5-4B-Q4_K_M.gguf`. The app carries the file's
SHA-256 and size. The download URL is a configuration value (initially the public upstream file).

**Download (`download.ts`).** Resumable HTTP range download into
`~/Library/Application Support/<app>/models/`, progress events, pause/resume, free-disk check before
starting. After the last byte the SHA-256 is checked; a mismatch deletes the file. A file that has
not been verified is never loaded.

**Host and client.** `host.ts` (utility process) loads the model once and serves `open`, `ask`,
`close`, `unload`. It constructs `QwenChatWrapper({thoughts: "discourage", variation: "3.5"})` and a
grammar from the JSON form, and enforces `maxTokens`. `client.ts` implements the core's `ModelPort`
over messages. The host never logs prompts or answers.

**Supervisor.** Restarts the host when it exits. A call in flight when the host exits rejects with
`MODEL_FAILED` (the core retries once). Three exits within 10 minutes → capture off, tray "problem",
home screen "Model problem" with a "Try again" button.

**Self-test (`selfTest.ts`).** Runs after the download, and whenever the app version or model hash
changes. It runs the core's `extract` on one built-in synthetic scenario and requires a
schema-valid statements answer within 120 s. Capture cannot be switched on until it passes. It
doubles as the one-time warm-up.

**Power guards (`power.ts`).** Extraction is paused while (a) battery is under 20% and the machine
is unplugged, or (b) macOS reports serious or critical thermal state. On entering a pause main sends
the core `signal("modelPaused")`; on leaving, `signal("modelResumed")`. The model is unloaded after
10 minutes without a scenario and loaded again on demand.

**Load on demand and the open timeout.** The core gives `open()` 30 s (`MODEL_OPEN_TIMEOUT_MS`).
A warm load measured about 2 s; the slow first load per executable (about 21 s) is absorbed by the
self-test. The client loads the model inside `open()` when it is unloaded. If a load exceeds the
limit the core retries once, by which time the load has finished; a test covers this path.

### Core change required

`Pipeline.signal` gains `"modelPaused"` and `"modelResumed"`. While paused, the extraction queue
does not start a new scenario; a running one finishes. Queue size (3, oldest dropped) and the
60-minute drop in `tick()` are unchanged, so the sixty-minute promise holds. A counter
`pipeline.pausedDrops` counts scenarios dropped while paused. Tests in `pipeline.test.ts`.

## 6. Account, persistence, upload

**Session.** Email or handle plus password → `signIn`. The password is never stored. On launch the
token is validated; it is refreshed when under 24 h from expiry. A refused refresh signs the user
out and switches capture off. `profile()` supplies `userNames`.

**Taxonomy.** Fetched at sign-in and once a day with `knownVersion`. Cached as plain JSON (public
data). On change → `pipeline.configure(...)`. Fetch failure → keep the cache. No cache → capture
cannot start.

**On disk** (data folder; everything else is memory only):

| File | Contents | Protection |
|---|---|---|
| `session.bin` | the sign-in token AND the display names on the account (used to keep the user's own name out of their statements; never sent anywhere) | `safeStorage` |
| `pool.bin` | pending statements (`exportPool()`) + whose they are | `safeStorage` |
| `outbox.bin` | approved, not yet uploaded + whose they are | `safeStorage` |
| `sent-log.json` | what was uploaded and when, each entry stamped with the account that sent it | plain; shown in the app |
| `settings.json` | exclusions, excluded sites, review time, switch state, onboarding step + the owning account | plain |
| `taxonomy.json` | cached taxonomy | plain |
| `app.log` | codes and counts only, size-capped | plain |
| `models/` | the model file | plain |

Writes are atomic (temp file, then rename). The pool is saved after every change and on quit, and
restored with `importPool` on launch. A `.bin` file that fails to decrypt or parse is deleted and
counted; an unreadable session also signs the user out. An unreadable `settings.json` falls back to
the **defaults** (never to "no exclusions") and capture stays off until the user opens Settings.
If `safeStorage` is unavailable the app refuses to store anything and says so.

**One machine, several accounts.** Everything about a person is stamped with their `userId`:
`pool.bin`, `outbox.bin`, every `sent-log.json` entry, and `settings.json`. One account's data is
shown to nobody else and to nobody at all while signed out — the review screen's pending list,
"waiting to upload" and the sent log are all empty then, without anything being deleted. When a
DIFFERENT account signs in, the previous owner's pool and unsent outbox are discarded (never
uploaded to the wrong profile) and both are logged with a count; their settings are reset to the
defaults with capture off; their sent-log entries stay on disk but are hidden. Until that reset is
actually on disk, the mismatch itself blocks capture and the settings screen shows the defaults,
never the other account's choices. A file that names no owner at all (written before the stamp
existed) is adopted by the next account to sign in: the choices are kept, but capture starts off and
the last prompt day is cleared, because nobody can say who agreed to have their screen read.
Sent-log entries without an owner are dropped on load rather than shown to whoever signs in next.

**Approve / reject.** Approve → `pipeline.resolve(id, "approved")`, item appended to the outbox.
Reject → `resolve(id, "rejected")`, gone. No editing, no bulk approve.

**Uploader.** Sends the whole outbox in one `submitEvidence` call when online. Accepted ids move to
the sent log. Failure → retry with backoff (1, 5, 15, 60 min, then hourly). `UNAUTHORISED` → one
refresh, then sign-out; the outbox is kept for the next sign-in by the same `userId` and discarded
if a different user signs in. Outbox items are never dropped silently; the review screen shows
"Waiting to upload (n)".

**Delete all local data.** Capture off, core cleared (new pipeline instance), every file in the
table deleted except `models/` (separate checkbox "also remove the model"), signed out, onboarding
reset.

**Offline.** Everything except upload, the taxonomy refresh and the model download works with
Wi-Fi off. The app makes no other network request; a test asserts the renderer loads no remote
resource (fonts and images are bundled).

## 7. What the user sees

One window, about 420 × 600, opened from the tray. No dock icon.

**Onboarding** (fixed order, each step blocks the next, resumes where the user left off):
1. The pitch: the five claims, verbatim from the overall plan, with a link to `WHAT-LEAVES.md`.
2. Sign in.
3. Download the model (size stated first; progress; pause/resume), then the self-test shown as
   "Checking it works on your machine".
4. Turn on Screen Recording: says macOS will ask and the app must restart; opens the settings pane;
   detects the grant; "Restart now".
5. What is never read: default excluded apps and sites, editable here; private windows always
   skipped; the known limits stated plainly (the guard cannot recognise a confidential fact phrased
   in ordinary words, or an all-caps name, which is why every statement needs approval).
6. Review time (default 17:30).
7. Done. Capture stays off until the user switches it on.

**Tray and home.** Tray icon states: off, on, problem. Menu: on/off, "Review (n)", "Pause for
1 hour", Settings, Quit. When the app cannot run, the home screen gives one sentence and one fix
button ("Screen Recording was switched off", "Model problem", "Signed out", "No skills list yet").

**Review.** Today's list, at most ten. Each row: statement, skill or competency name, day captured,
**Approve** and **Reject**. Below: "Waiting to upload (n)" and "Sent" (the log). Empty state:
"Nothing to review today." At the review time, if the list is not empty: one system notification
and a tray dot. Nothing when empty. Missed (app closed or asleep at that time): shown at next
launch or wake, once.

**Settings.** Excluded apps (with "add the app I'm using now"), excluded sites, review time, sign
out, delete all local data, About (version, model hash, `WHAT-LEAVES.md`). Nothing else.

**Copy.** All user-facing text lives in `renderer/copy.ts`. A test asserts the five claims equal
the canonical text.

**Visual design.** Built with the `frontend-design` skill: one deliberate aesthetic direction chosen
at build time and applied to all four screens, not framework defaults. Constraints the design must
respect: fonts and every asset are bundled (no network), light and dark appearance, the small fixed
window, keyboard operable, and the review list must never make approving easier than reading (no
"approve all", no pre-selected action, equal visual weight for Approve and Reject).

**IPC boundary.** The renderer can receive only: pending statements, taxonomy names, settings,
counts, the sent log, and status codes. `ipc.ts` is the full list; the preload exposes nothing else;
the renderer runs sandboxed with context isolation and no Node integration.

## 8. Failure rules

Fail closed; fixed codes; no text in any error, log line or IPC status.

| Situation | Behaviour |
|---|---|
| Reader exits or times out | restart with backoff; five failures in 10 min → capture off, tray problem |
| Reader returns `locked`, `black`, `failed` | skip the read, count it |
| Permission revoked while running | capture off; home screen shows the fix |
| Model host crashes | section 5 |
| `.bin` file unreadable | delete, count; session → sign out |
| `settings.json` unreadable | defaults; capture off until Settings is opened |
| Clock jump or sleep | core's clock rules; resume counts as unlock |
| Second instance | refused (single-instance lock); two buffers would break the 60-minute promise |
| Disk full | pool save fails → capture off, tray problem; nothing is dropped from memory |

## 9. Testing

- **Unit (vitest, no Electron):** capture loop, download, supervisor, self-test, session, taxonomy,
  pool, uploader, scheduler, settings, power guards, secure file; with fake reader, fake API, fake
  clock, in-memory filesystem and the core's fake model. Sharpest tests on the loop: never queues
  reads; a window change mid-read discards the read; `read()` is never called unless `mayCapture`
  allowed; nothing is read while any precondition is false.
- **Integration (headless):** real core + stand-ins + fake model: fixtures in, digest out, approve,
  upload to the stub, sent log matches. The core's leak test is extended to the pool, outbox, sent
  log, `app.log` and every IPC message sent to the renderer.
- **Real-model evaluation (`eval/run.ts`):** the fixtures through the real model host, judged by
  `expectReal` (`digestMin`, `digestMax`, `allowedTargets`) plus `outcomes`, `modelMustNotSee`,
  `mustNotAppear`. Manual and a release gate; not part of the normal run. New adversarial fixtures
  are added (scripted statements that contain each category's forbidden terms), since six of the
  eight existing ones cannot fail the guard.
- **Electron smoke test:** launches with stand-ins, completes onboarding, approves one statement.
- **Build guards:** production refuses stand-ins; the renderer bundle imports nothing from `core/`
  or `main/`; the claims match; no remote resource in the renderer.

## 10. Carried in from the core review

Done as B's first task, because B makes them reachable:
- `candidates/ambiguous.ts`: `HINTS` is a plain object, so a skill normalising to `constructor`
  throws and silently drops the scenario. A real taxonomy of 3 to 4 thousand skills can contain it.
- `exclusions/index.ts`: `mayCapture({app: undefined})` throws instead of returning
  `unknownWindow`. The reader is another process and may send malformed data.

## 11. Open points for other sub-projects

- **C** must answer: does the Screen Recording grant reach its process; text recognition from Rust;
  terminal apps; Chrome private-window detection from the toolbar strip.
- **D** must provide the five `ClaveApi` calls; the evidence write is not bound to a call.
- **Fifth piece:** Sentry, usage events (from `takeCounters()`), signing, notarisation, auto-update.
- Owner decisions still open (from `docs/HANDOFF.md` section 5): label for private evidence on the
  profile, open-sourcing the client, Apple Developer account, where usage counts go.
