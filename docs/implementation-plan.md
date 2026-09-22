# Implementation plan

Status: draft 6, 2026-09-17. Spikes S1 and S2 done. Reading approach changed to screenshots only. Owner: Sardor.

## What we are building

A small desktop app that, while switched on, reads the text of whatever the user is
working on, turns stretches of real work into short evidence statements, and sends
only the statements the user approves to their Clave profile.

It does two things and nothing else:

1. Read what the user is working on.
2. Turn it into evidence the user approves or rejects.

The experiment it serves: ask about 50 freelancers, contractors and startup people to
install it; 20 installs is success. We also track whether it is still switched on a
week later.

## Settled decisions

| Area | Decision |
|---|---|
| Shell | Electron + TypeScript, own repository |
| Reading the screen | **Screenshots only, on every platform (decided 2026-09-17, supersedes accessibility-first).** A small Rust native module captures the focused window and runs the operating system's built-in text recognition. The accessibility layer is not used and the Accessibility permission is never requested |
| Review volume | A capped daily digest: statements are collected through the day, near-duplicates removed, the strongest few per skill kept, at most about ten shown. Anything beyond the cap is dropped, never queued |
| Model | Qwen3.5-4B, 4-bit GGUF (~2.74 GB), run with node-llama-cpp, downloaded on first launch |
| When the model runs | Once per stretch of activity ("scenario"), never per frame |
| Retention | Text only, in memory, rolling 60 minutes. Fallback screenshots are deleted right after recognition. Nothing raw is written to disk |
| Output rule | Statements never contain another person's name, a company, client, product, quote, ticket id, URL or identifying figure. Enforced by prompt AND by a check in code |
| Review | Approve or reject per item. No editing. Nothing leaves before approval |
| Backend | clave-back only: login, read taxonomy, write approved evidence. Evidence is not tied to a call. No clave-ai dependency |
| Platforms | Structure supports Mac, Windows, Linux. Build and test Mac first, Windows second |
| Control | Manual on/off, always-visible state, user-editable excluded-apps list |
| Users | English and Portuguese speaking. Statements are written in English (assumption, see open decisions) |

## Architecture

```
┌────────────────────────── Electron main process ──────────────────────────┐
│ auth · taxonomy cache · scenario segmenter · model runner · upload · tray │
└───────▲──────────────────────────▲───────────────────────────▲────────────┘
        │ IPC                      │ messages                  │ HTTPS (JWT)
┌───────┴────────┐        ┌────────┴──────────┐        ┌───────┴────────┐
│ Renderer (UI)  │        │ Reader helper     │        │ clave-back     │
│ React          │        │ utilityProcess    │        │ mini API       │
│ onboarding     │        │ loads Rust module │        └────────────────┘
│ on/off         │        │ capture window    │
│ review list    │        │ recognise text    │
└────────────────┘        └───────────────────┘
```

Why the reader lives in a separate process: native capture and recognition code is the
likeliest thing to crash. In a separate process, a crash restarts the
helper and the app keeps running.

Data flow for one stretch of work:

```
trigger → is the app/window excluded? ── yes → skip (nothing is read)
                     │ no
                     ▼
        capture the focused window, recognise its text, delete the image
                     ▼
        unchanged since last read? ── yes → skip
                     │ no
                     ▼
        scrub secrets → append to in-memory window
                     ▼
        scenario closes (app change / idle / 10 min cap)
                     ▼
        pick candidate skills locally → model pass (JSON-schema constrained)
                     ▼
        name/organisation check in code → discard violations
                     ▼
        pending evidence → user approves or rejects → upload approved
```

Fail closed everywhere: if we cannot tell which app or window is focused, we do not read.

## Design concepts adopted from prior art

We studied how screenpipe (continuous local screen capture, commercial licence) solved
the same low-level problems. None of its code is used. These are the ideas we adopt,
restated for our design, each with the reason it exists. Most are scars from real bugs.

### Deciding when to read

- **Two classes of trigger.** Context changes (app switch, window or tab change, the
  idle heartbeat) always produce a read. Content changes (typing pause, clipboard,
  scroll stop) are rate limited with their own floor of about 1.5 seconds.
- **Defer, do not drop.** When a content trigger arrives inside the floor, remember it
  and honour it on the next tick, so the end state of a typing burst is never lost.
- **Drain and reduce.** Each tick, take every waiting trigger and reduce them to one
  read: newest wins, but a context change outranks trailing noise.
- **Heartbeat.** Read at least every 30 seconds while switched on and unlocked, so a
  long static stretch still belongs to a scenario.
- **Reset the change hash on a context change**, so the first read of a new window is
  never suppressed by the previous window's fingerprint.
- **Locked or asleep means stopped.** Check lock state before the first read ever
  runs. Detect lock from the OS session state and from the focused app's identity
  (login window, screensaver). Back the lock notifications with a slow poll, because
  they get lost across sleep.
- **Grace after wake and unlock.** The OS briefly reports permissions as denied after
  waking. Wait about ten seconds before believing a "permission lost" signal.
- **Every OS call on the loop has a timeout.** A timeout skips that tick; it never
  freezes the loop.
- **Count every skip separately**: excluded, unchanged, locked, timed out, thin. A
  separate "loop is alive" clock from the "last successful read" clock, so a static
  screen is not mistaken for a broken app.

### Why screenshots only (decided 2026-09-17)

Accessibility-first was chosen for cost and accuracy, then dropped after the spikes:

- The single-pitch rule removed its marketing benefit ("no screenshots" is never claimed).
- VS Code exposes almost no text through accessibility, so developers need Screen Recording
  anyway. Accessibility would add a second permission without removing the first.
- Accessibility is the more frightening permission: macOS describes it as the ability to
  monitor the keyboard and control any app. Screen Recording can only see.
- Windows had already become recognition-first because accessibility walks froze apps there.
  Screenshots only means one mechanism everywhere.
- Accessibility reads execute inside the other app and can make it stutter, crash, or corrupt
  text being typed. A screenshot cannot disturb anything.
- A screenshot contains only what the user could see. Accessibility returned large amounts of
  off-screen and hidden text, which is noise for evidence and a channel for hidden instructions.
- Measured cost gap is small: about 150 ms per recognition against about 65 ms per
  accessibility read, and we only read on change.
- It removes the reader-process workaround and its packaging trade-off.

Given up: character-exact text (recognition measured 97 to 100% on chat and tickets, about 90%
on code with punctuation errors), exact browser addresses for site exclusions, and some battery.
macOS also requires an app restart after granting Screen Recording and re-asks periodically.

The accessibility findings from spike S2 stay in "Spike results" as reference in case the
approach is ever revisited as an optimisation.

### Capturing and recognising text

- **Capture the focused window only**, never the whole screen, so other windows are never in
  the image. Where the platform allows, excluded windows are left out by the system itself.
- **Find the focused app and window from the window server**, not from any other source.
  Unknown means do not capture.
- **Recognition settings**: accurate mode, language correction off, grayscale input. The
  system's fast mode is unusable on small text and must never be used.
- **Delete the image as soon as recognition returns.** It is never written to disk.
- **Reject unusable frames cheaply** before recognising: a fixed grid of a few hundred pixel
  samples detects an all-black frame (sleeping display, protected content) at the same cost
  for any resolution.
- **Check before paying**: hash the captured window; skip recognition when it matches the last
  one recognised for that window. Promote the "already done" marker only after the text was
  actually accepted, so a failed recognition retries instead of silently hiding content.
- One recognition job at a time. If a throttle says "not now", skip the whole read.
- Apps that change constantly (terminals streaming output, video) are capped to a few
  recognitions per minute.
- Strip known recognition noise, such as long digit runs from editor line-number gutters.
- Wrap each native call so that memory is released per call; long-running recognition loops
  are a known source of slow memory growth, so the reader process is restarted periodically.

### Exclusions and privacy

- **Decide before capturing anything.** The app-level exclusion check runs on the app name
  alone, before any capture. Title-dependent rules run on the window title, also before
  capture.
- **Exclusion entries are plain strings with an optional `App::Title` scope**, so a
  user can exclude one Slack channel without excluding Slack. The ignore list is
  absolute and checked first.
- **Websites**: without the accessibility layer there is no exact browser address. Sites are
  excluded by window title and by recognising the address bar strip of the captured window,
  matched on the host with domain boundaries. This is less precise than an exact address, so
  defaults are cautious: when a browser window matches an excluded site by either signal, the
  whole read is dropped.
- **Unknown means no.** If app, window or address cannot be determined, do not read. A
  malformed rule disables reading rather than widening it.
- **Defaults out of the box**: password managers, keychain tools, banking sites,
  messengers, the lock screen and system UI, and our own window.
- **Private browser windows**: detect by window title using specific localised phrases,
  never the bare word "private". Bias toward skipping. A precise-but-fragile check
  never overrides the broad one. Keep a regression test for every false positive fixed.
- **Policy (confirmed 2026-09-17): private windows are never read.** Any window we can
  identify as private is skipped entirely, in every browser.
- Chromium private windows carry no marker in their title on Mac, but the incognito label
  is visible in the toolbar of the captured window, so recognition can detect it. Until that
  is verified, users are told to switch the app off or exclude the browser when browsing
  privately.

### Scrubbing secrets

- **Deterministic patterns first, always.** Private key blocks, connection strings with
  credentials, `user:pass@host` addresses, authorization headers, provider API-key
  prefixes with minimum lengths, tokens, emails, phone numbers, cards.
- **A numeric pattern needs proof**: a checksum (cards, bank numbers) or a label keyword
  nearby, matched on word boundaries. Phone numbers require separators or a country
  code. Bare digit runs are never redacted; doing so corrupts ordinary data.
- **Secrets win overlaps.** When two patterns overlap, the credential class wins, so a
  key is never lost to a weaker class.
- **Never fall back to unscrubbed text on an error.**
- Matches are replaced with short fixed labels such as `[SECRET]` and `[EMAIL]`.
- A must-not-match test list grows with every false positive we fix.

### Permissions on Mac

- **One permission: Screen Recording.** Accessibility is never requested.
- It needs an app restart to take effect, and recent macOS versions re-ask periodically.
  Onboarding says so up front and offers a clear restart button.
- **Poll passively until the user acts.** Use checks with no side effects while waiting. Only
  after the user clicks "turn on" do we call anything that can prompt.
- **Open the settings pane first, then the system prompt**, so dismissing the prompt leaves
  the user in the right place.
- **Dismissing a system dialog is a refusal**, never consent to restart the app.
- **More than two states.** Distinguish "granted but needs restart" and "revoked but this
  process still thinks it has it" from plain granted and denied.
- **What actually works outranks what the permission check says.** If captures come back
  empty or black while the check says "granted", treat it as not granted until a capture
  succeeds. This avoids a loop of closing and reopening the recovery screen.
- **Recovery attempts use guards that always reset**, not fire-once flags.
- **Development builds**: macOS ties grants to the signing identity, so unsigned rebuilds lose
  them. Keep the normal build unsigned and fast; use a stably signed build only when testing
  permissions.
- To verify early: whether the Screen Recording grant reaches a separate reader process, as
  spike S2 found the Accessibility grant does not reach Electron's helper program.

### Protecting the machine

- The model pass is the only heavy work we have. Before each pass, sample our own
  processor use; after it, compute how long to rest so the average stays under a
  target. Hold one permit through the rest period so two heavy jobs never overlap.
- Two power modes only: on mains, and on battery (longer intervals, model passes
  deferred). The operating system's low-power mode is a hint to slow down, not a
  signal to stop.

### What we deliberately do not take

Multi-monitor routing, per-monitor state machines, video and image storage, the
change-gated recognition pipeline, per-word recognition boxes, fuzzy de-duplication,
a local database, the pseudonym system, image redaction, the hundreds of national
identifier patterns, machine-learned redaction, encrypted vaults, audio, keystroke and
clipboard content capture, scripting permission, and event telemetry plumbing.

### Platforms

The mechanism is identical everywhere: capture the focused window, recognise, delete. Only
the recognition engine differs: Apple's on Mac, the built-in Windows engine on Windows, a
bundled engine on Linux (expected to be clearly weaker on dark themes and small text). Build
and test Mac first, Windows second, Linux when there is demand. The TypeScript side is
identical on all of them.

## One pitch for every platform (decided 2026-09-17)

Outreach happens before we know what machine someone uses, so there is exactly one
pitch, and every claim in it must be true on Mac, Windows and Linux alike. The rule:
**promise only what holds everywhere; where one platform does better, it simply
over-delivers.**

The claims:

1. You switch it on and off yourself. It never runs unless you started it.
2. It reads the text on your screen. Anything it captures to do that is deleted within
   seconds. Nothing older than an hour exists anywhere, and nothing is stored on disk.
3. It never looks at the apps and sites you exclude, or at private browser windows it
   can recognise.
4. Nothing reaches your profile until you read it and say yes. It names no one else.
5. It works with your Wi-Fi off. Only the short statements you approve ever leave.

What we do not claim anywhere: "no screenshots". On Mac most reads take no screenshot
at all, but that is an implementation detail for the FAQ, not a pitch line. Claim 2 is
worded so it is true both when text is read directly and when a screenshot is taken
and deleted.

Consequences for the build:

- Onboarding copy, the website and `docs/WHAT-LEAVES.md` use these five claims
  verbatim on every platform. Only the mechanical permission steps differ per OS.
- Any future platform-specific shortcut must still satisfy all five claims, or it does
  not ship.
- Each claim gets a test or a documented manual check, so the pitch stays provable.

## Making the model step reliable

The model is the part most likely to fail on a stranger's machine. We assume it will
and design so that a failure is caught, contained, reported and never silent.

**Before release**
- Pin the exact pair: runtime version and model file revision, with the file checksum.
  Never "latest". Upgrading either is a deliberate change that re-runs the checks below.
- A release gate, not a per-commit test: on a Mac build machine, download the pinned
  model, load it, run the fixtures in `eval/`, and fail the release unless every output
  validates against the schema.

**On the user's machine, at first launch**
- Check free disk before downloading. Download with resume. Verify the checksum.
- Check memory before loading. If the machine cannot hold the model comfortably, say so
  plainly instead of grinding.
- **Self-test**: load the model, run one tiny built-in sample, validate the result.
  Record load time, generation time and which hardware path was used. Capture does not
  start until the self-test passes. There is no point reading a screen we cannot process.
- If it fails, the user sees one clear state ("The model could not start on this
  machine"), and we receive the error code.

**On every model pass**
- Output is forced to the schema by the runtime AND validated again in TypeScript.
  The second check is ours and does not depend on the runtime feature being bug-free.
- Fallback ladder for forcing structure: the runtime's schema feature, then a
  hand-written grammar, then plain prompting with strict validation. The self-test
  picks the first rung that works on that machine and remembers it.
- Invalid output: retry once with stricter settings, then discard and count. Never
  upload or show anything that failed validation.
- Hard limits on every pass: maximum output length and a wall-clock timeout. Step-by-step
  thinking is off, or capped, so the model cannot loop forever.
- Hardware fallback: graphics chip first, processor if that fails.
- One pass at a time. The model is unloaded after a quiet period to give memory back.

**Containing a crash**
- The runtime's documentation says it must run in the app's main process. Spike S1
  tests whether it can run in a separate helper instead. If it can, a model crash
  cannot take down the app.
- If it cannot, a crash restarts the app automatically, the next launch reports it, and
  after repeated crashes the model step is disabled with a clear message rather than
  crash-looping.

## Error reporting and usage analytics

Two needs: know what breaks on other people's machines, and know whether the app is
actually used. One hard constraint: **nothing the app read from a screen may ever
appear in a report.** Telemetry is part of what leaves the machine, so it is listed in
`docs/WHAT-LEAVES.md`, explained in onboarding, and can be switched off.

### Errors (Sentry, already used by the company)

Error tooling is the easiest place to leak by accident, so it is locked down:

- **No crash memory dumps.** A native crash dump is a copy of the app's memory, which
  holds recently read text. The dump integration is removed. We get the fact of a
  native crash and where, never the memory.
- **Every error is a code, not a sentence.** Our own errors carry a fixed code
  (`MODEL_LOAD_FAILED`, `READ_TIMEOUT`, `PERMISSION_LOST`, ...) plus numbers. Captured
  text is never placed in an error message, a log line or a thrown exception. A lint
  rule and a test enforce this.
- **A filter runs on every report before sending.** It keeps an allowlist of fields:
  error code, stack frames from our own code, app version, OS version, chip, memory
  size bucket, which stage failed. It drops messages from third-party errors down to
  their type, drops breadcrumbs, local variables, request bodies, file paths containing
  the user's name, and anything not on the allowlist.
- No screenshots, no session replay, no console capture.
- The Rust reader reports failures as codes through the same channel. Panics are
  caught at the boundary and converted to a code.
- A test feeds the filter an error stuffed with fake screen text and fails the build if
  any of it survives.

### Usage (counts only)

A small allowlisted set of events, each with numeric or fixed-choice properties only.
No app names, window titles, addresses, statements or skills.

| Event | Properties |
|---|---|
| first_launch | app version, OS, chip, memory bucket |
| onboarding_step | step name, completed or abandoned |
| permission_state | which permission, state |
| model_download | result, duration, error code |
| model_self_test | result, load ms, generation ms, hardware path, structure rung, error code |
| capture_toggled | on or off |
| daily_summary | minutes switched on; reads performed; skips by reason; scenarios; model passes; statements generated, discarded by rule, approved, rejected, uploaded; errors by code |
| app_error | error code, stage |

- Events are tied to the signed-in account, because the experiment has to answer "which
  of the 50 installed, and who is still active after a week". This is stated in
  onboarding.
- `daily_summary` is the workhorse. It answers "is it being used" without a stream of
  fine-grained events.
- Sent to the analytics tool the company already uses, or to a small clave-back
  endpoint if we prefer to keep it in-house. Decide in Phase 6.
- One switch in the app turns off both errors and usage. Default on, clearly disclosed.
  The install itself is still visible to us through login.

### What this lets us answer

- Installed but never finished onboarding? Which step lost them?
- Did the model start on their machine? How slow was it?
- Is it switched on, and for how long per day?
- Is it producing statements, and are people approving or rejecting them?
- How often do our own safety rules discard a statement? (A high rate means the prompt
  needs work, and we learn it without seeing any content.)

## Spike results

### S1: model in Electron. PASSED (2026-09-17, M2 with 16 GB)

Pinned pair that worked: `node-llama-cpp` 3.21.1 with its prebuilt Metal binary,
`Qwen3.5-4B-Q4_K_M.gguf` (2.74 GB, unsloth build), Electron 44.4.1. The throwaway spike code was removed on
2026-09-17; everything learned from it is recorded below.

| Question | Answer |
|---|---|
| Does the runtime load the model's hybrid architecture? | Yes, on the graphics chip |
| Does forced structured output work? | Yes, including enums, item counts and length limits |
| Does it run in Electron's main process? | Yes |
| Does it run in an Electron utility (helper) process? | **Yes.** The docs' warning is about renderer processes |
| Does the app survive a hard crash of the helper? | Yes. Main stayed alive through two simulated crashes and restarted the helper |

Measurements: model load about 2 s warm; **about 21 s the first time in a new program**
(one-time warm-up, show progress in the UI). Work scenario about 20 s end to end
(decision pass about 7 s), private scenario about 5 s. Around 13 tokens per second.
About 3.4 GB of graphics memory while loaded.

What it took to get there, all of which becomes design input for the core pipeline:

1. **Thinking must be switched off explicitly.** This model thinks before answering by
   default. With forced structure, the runtime filed the start of the answer under
   "thinking" and stripped it, so the opening brace went missing and parsing failed.
   Fix: create the chat wrapper with thinking discouraged and the Qwen 3.5 template
   variant. A thinking budget of zero is not enough.
2. **Reason before deciding, inside the form.** With the yes/no field first, the model
   judged real work as not professional. Putting a short activity summary first fixed it.
   The summary stays local and is never uploaded.
3. **Two passes, not one.** In a single form the model always closed the evidence list
   empty, even when its own summary described the work, because an empty list is the
   cheapest continuation under forced structure. Pass 1: summary, is it professional, did
   the user demonstrate something. Pass 2, only if both are yes: evidence with a minimum
   of one item. Same conversation, so pass 2 reuses what was already read. Side benefit:
   private activity costs only the short first pass.
4. **Output quality was good on the sample.** Five correct statements, no colleague or
   company names, and a technology only a colleague mentioned was correctly not credited.
   Private activity (personal chat, video, shopping) correctly produced nothing.
5. **The code-side check must normalise numbers.** The model wrote "eight million rows"
   and "thirty-second", which slipped past a check for the numerals. Spelled-out figures
   need catching too.
6. It refers to the user by first name. Decide in the core spec whether statements name
   the user or start with the verb, as the existing Clave engine does.
7. Packaging note: this npm version holds back install scripts, so Electron's binary
   download had to be run explicitly. The build setup must account for that.

Decision: **the model and the reader both run in separate processes.** A crash in either
cannot take down the app. (S2 refined how: see below.)

### S2: reading text on Mac via accessibility. DONE; approach later dropped (2026-09-17, M2, macOS 27)

> After this spike the project moved to **screenshots only** (see "Why screenshots only"). The
> findings below are kept as reference. Two still apply directly: a macOS permission grant
> does not automatically reach Electron's helper program, and the window server is the
> reliable source for which app is in front.

The throwaway spike (removed on 2026-09-17) was a Rust napi module (rustc 1.98, napi 3, hand-declared
bindings to the accessibility API) inside a small Electron app. 49 samples over two minutes of
real use. Only numbers were collected; the text stayed in a local git-ignored file.

**Permission attribution**

| Where the reader runs | Trusted by macOS after the user grants Accessibility? |
|---|---|
| Electron main process | Yes |
| Electron `utilityProcess` | **No.** It runs from the inner "Electron Helper" program, which the grant does not cover |
| `child_process.fork` | No. On macOS it also runs "Electron Helper" |
| Child spawned from `process.execPath` with `ELECTRON_RUN_AS_NODE=1` | **Yes.** Same program as main, separate process |

The grant took effect without restarting the app.

**Finding the focused app.** Asking the accessibility layer for the focused application failed
from the child process every time (error -25204, cannot complete). Building the app element
from the window server's frontmost process id worked every time. The window server is
therefore the primary source, not just a cross-check. (The spike shelled out to `lsappinfo`;
production does this natively.)

**Per-app results** (generous 1.5 s budget to measure true coverage)

| App | Samples | Median characters | Median time | Content share | Verdict |
|---|---|---|---|---|---|
| Slack | 6 | 6,314 | 64 ms | 95% | Reads well |
| Chrome | 35 | 25,406 | 67 ms (max 173) | 100% | Reads well |
| Claude desktop (Electron) | 2 | 9,316 | 246 ms | 94% | Reads well; needed the one-time flag, which worked |
| VS Code | 4 | **73** | 19 ms | n/a | **Too little text. Needs the recognition fallback** |
| Finder | 2 | 8,916 | **2,364 ms**, hit the time limit | 100% | Slow native app; low value; candidate for default exclusion |
| Terminal | 0 | | | | Not visited during the run. Still untested |

No failed or empty reads once focus came from the window server.

**Other observations**
- Slack, Chrome and VS Code already had the assistive flag on. Only the Claude app needed it
  set, and the set-once logic worked (one set, then never again).
- VS Code exposes almost nothing of the editor through accessibility unless its screen-reader
  mode is on. Switching that on for the user would visibly change their editor, so we do not.
  VS Code goes through recognition. The earlier recognition test scored about 90% on code with
  only punctuation errors, which is adequate.
- Chrome private windows: the toolbar scan flagged 2 of 35 Chrome reads, which matches a brief
  incognito visit, with no flags on the other 33. Promising, not proven: the scan must be
  narrowed to the toolbar so page text containing the word cannot trigger it, and tested
  deliberately both ways.
- The private-window scan ran after the walk with no deadline, which is why Finder overran
  its budget. Every stage needs its own limit.

**Design changes from this spike**
1. **The reader runs as a child of the app's main program**, started with
   `ELECTRON_RUN_AS_NODE=1`, not in a `utilityProcess`. The model stays in a `utilityProcess`
   (it needs no permission; S1 proved that works). Trade-off: this relies on Electron's
   "run as Node" capability, which hardened apps usually switch off at packaging time. We keep
   it on and note it in the security review. Fallback if that is unacceptable: run the reader
   on a dedicated thread inside the main process, with panics caught at the boundary and
   automatic relaunch.
2. **Focus comes from the window server first.** The accessibility layer's answer is not used
   to find the app.
3. **VS Code and its forks are recognition-first**, alongside terminals and canvas apps.

**Still unverified, carried into the reader spec**
- Text recognition and screen capture from Rust, and whether the Screen Recording grant reaches
  the main-program child the same way Accessibility does.
- Terminal apps.
- Behaviour with a properly signed build. The test binary was only ad-hoc signed.


## Repository layout

```
asset-to-evidence/
  app/                  Electron app
    src/main/           auth, capture loop, segmenter, model runner, upload
    src/core/           pure TypeScript, no Electron imports, fully unit-tested:
                        change gate, secret scrubber, segmenter, candidate
                        matcher, prompt, output schema, name check
    src/renderer/       React UI
    src/reader-host/    utilityProcess entry that loads the native module
  native/reader/        Rust napi-rs crate
    src/macos/          AX tree, Vision OCR, permissions, focus events
    src/windows/        (later) UI Automation, Windows OCR
    src/linux/          (later) AT-SPI, Tesseract
  eval/                 activity fixtures with expected outcomes
  docs/                 this plan, WHAT-LEAVES.md
```

Native surface, kept deliberately tiny:

```ts
checkScreenPermission(): 'granted' | 'denied' | 'needsRestart' | 'unknown'
requestScreenPermission(): void
frontWindow(): { app: string; bundleId: string; title: string; pid: number } | null
readFrontWindow(opts: { budgetMs: number }): {
  text: string; addressBarText?: string; imageHash: string;
  skipped?: 'unchanged' | 'black' | 'locked' | 'timeout'; tookMs: number
} | null
onFocusChange(cb): void        // app switch, window focus change
```

Everything that decides anything stays in TypeScript.

## Phases

Sizes are rough estimates for one developer working with AI assistance.

### Phase 0: prove the three risky things (3 to 5 days)

Throwaway code. Each spike has a pass/fail question. Do not build on top until all pass.

**S1. Model in Electron.**
Does node-llama-cpp's bundled runtime load Qwen3.5-4B (hybrid architecture) and
enforce a JSON schema on it? Feed it a hand-written 10-minute activity text.
- Pass: valid JSON evidence; record seconds and peak memory on the M2 for a ~6k-token input.
- Also answer: must it run in the main process, or can it run in a utility process?
- If it fails to load: bump the runtime; if structured output is broken, fall back to
  a hand-written grammar. If neither works, revisit the model choice.

**S2. Reading text on Mac.**
Rust module, loaded from a utility process, reading the focused window of Slack,
VS Code, Chrome, Terminal, and one design/canvas app.
- Set the assistive flag that makes Chromium/Electron apps expose their text.
- Vision text recognition on the focused-window crop as fallback.
- Pass: a table per app of coverage, source used, and milliseconds per read.
- Also answer: are the Accessibility and Screen Recording grants attributed correctly
  when the reading happens in a helper process?
- (Superseded.) Chrome private windows are now recognised visually: the incognito
  indicator and label are in the captured toolbar strip, so recognition can see them.
  To be verified in the reader spec.
- Set up a stable development signing identity first, or macOS forgets the grants on
  every rebuild.

**S3. Backend contract.**
Write down the shape of "evidence without a call" (request, response, storage) before
building either side, since we change clave-back ourselves (see Phase 5).
Confirm the desktop can use `POST api/security/login`, `refresh` and `validate` as-is.

### Phase 1: app skeleton (2 to 3 days)

- Electron + Vite + React + TypeScript, one small window, tray icon showing on/off.
- Login with email or handle plus password. Token stored with Electron safeStorage,
  validated on launch, refreshed when needed. Password never stored.
- First-run onboarding: one screen explaining what is read, what is kept, what leaves;
  then "Turn on Screen Recording" (the only permission; needs an app restart,
  stated up front). Detect grant state, deep-link to the right settings pane.
- On Windows later: same consent screen, even though the OS does not ask.

### Phase 2: capture loop (4 to 6 days)

- Triggers: focus change events from the native module, plus a light poll while the
  user is active, plus a slow heartbeat when idle. No fixed 5-second timer.
- Exclusion check before any read: default list (messengers, banking, password
  managers, private browser windows by title), user-editable. Unknown → do not read.
- Read with a time budget; one read at a time; drop stale work, keep newest.
- Change gate: hash the text; skip if identical to the last read of that window.
- Secret scrubber, deterministic, runs before anything is kept: private keys,
  connection strings, provider API-key shapes, tokens, emails, cards, phone numbers.
- Rolling window: in memory only, 60 minutes, cleared on quit.
- Segmenter: a scenario is continuous work in one app/window family; it closes on a
  sustained switch away, on idle, or at a 10-minute cap.

### Phase 3: extraction (4 to 6 days)

- Taxonomy cache: competencies and skills pulled from clave-back's existing search
  endpoints at login, refreshed daily, stored locally (public data, safe to persist).
- Candidate skills: match scenario text against skill names and aliases locally
  (exact and fuzzy), keep the top N. The model verifies candidates; it does not invent.
- Prompt: the evidence test ("could someone who never did this say the same?"),
  demonstration versus mention, ignore private and non-professional activity, the
  output rules, English output, empty result is a correct result.
- Output forced to a JSON schema whose skill and competency fields are enums of the
  real ids offered in that prompt. No free-typed taxonomy names.
- Runs when a scenario closes; defers while on low battery or under heavy load.
- Name check in code: collect every name, organisation, email, URL, ticket pattern
  and number seen in that window; discard any statement containing one; discard any
  statement with quotation marks. Count discards.
- Pending evidence is the only thing persisted, encrypted, because it is already
  sanitised and the user must be able to review it later.

### Phase 4: review and upload (2 to 3 days)

- Pending list: statement, skill or competency, when. Approve or reject. No edit.
- Upload approved items; show a local log of exactly what was sent and when.
- "Delete all local data" button.

### Phase 5: clave-back changes (2 to 4 days, done in the same working session as the app)

- New evidence kind that belongs to an account and has no huddle. Either a new
  collection or the existing one with an optional huddle and a `source` field.
- `POST` to write approved items; the account comes from the token, never the body.
  Validates skill, expertise and competency ids. `GET` to list the caller's own items.
- Profile page reads include the new kind (display decision pending, see below).
- Follows the repo's rules: JWT via `TeamExPermission`/`Authorize`, `Datetime*`
  naming, soft delete, `NormalizedSkill` only.
- Taxonomy reads need no new work: skill and competency search already exist.

### Phase 6: trust and packaging (3 to 5 days)

- `docs/WHAT-LEAVES.md`: the complete list of fields that can leave the machine.
- Tests that fail the build: a fixture full of names and secrets must produce zero
  leaks; the upload payload must contain only allowlisted fields.
- Mac signing and notarisation. Per-user install, clean uninstall.
- Model download on first launch with progress, resume and checksum.
- Helper crash → automatic restart. CPU budget; pause on low battery.
- Error reporting and usage counts as specified in "Error reporting and usage
  analytics": locked-down Sentry, allowlisted count events, one off switch, disclosed
  in onboarding, listed in WHAT-LEAVES.md, with a leak test on the report filter.
- First-launch model self-test and the reliability measures in "Making the model
  step reliable".

### Phase 7: run the experiment

- Batches of three or four people, one message variant per batch, iterate.
- After the first batch is stable on Mac, start the Windows reader.

Rough total to a first outside install on Mac: four to six weeks.

## Not in version 1

Audio and call transcription, video, timeline, search, history, a local database,
multi-monitor handling, sync, a settings page beyond on/off and exclusions, editing
evidence, work-history or bio extraction, Linux build, auto-update.

## Risks

| Risk | Mitigation |
|---|---|
| Runtime cannot load the model's hybrid architecture or enforce structure on it | Spike S1 before anything else |
| Screen Recording grant may not reach a separate reader process | Verify first in the reader spec; S2 showed the pattern for Accessibility. Fallback: capture in the main process, recognise in the child |
| Recognition drains battery or lags on large windows | Capture only the focused window, hash before recognising, per-app rate limits, pause on battery |
| Site exclusions less precise without exact addresses | Cautious defaults, match on title and recognised address bar, drop the read on either signal |
| Small model misjudges private content or leaks a name | Exclusion list first, name check in code, approval last; discard counters tell us how often |
| Users react as Zafar first did | Lead the pitch with control and deletion, not "local"; visible state; Wi-Fi-off demo |
| Always-on cost annoys users | Event triggers, change gate, deferred model runs, battery pause |

## Open decisions

1. (Resolved 2026-09-17) The clave-back change is made in the same working session as the app.
2. Are statements always written in English, even for Portuguese-speaking users?
3. How does private evidence look on the profile next to call evidence (label or blend)?
4. Do we open-source the client? It changes the pitch and should be settled before outreach.
5. Is there an Apple Developer account for signing and notarisation?
6. (Resolved 2026-09-17) Error reporting and basic usage analytics are wanted. Remaining
   choice: send usage counts to the company's existing analytics tool or to clave-back.
