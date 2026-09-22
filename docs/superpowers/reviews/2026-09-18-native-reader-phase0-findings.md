# Native reader phase 0: findings

Machine: macOS 27.0 (26A428), Electron 44.4.1, Swift 6.4, host bundle `dev.clave.readerspike` signed with the self-signed
certificate "Clave Agent Dev" (untrusted root, `codesign --verify --deep --strict` = 0). Host launched with `open -n` only.
Records below are quoted from the logs; they contain no screen text and no titles.

## P1 — does the Screen Recording grant reach a standalone helper started by the app? PASS (2026-09-18)

Before the grant (06:48:13Z), both the long-lived helper A and a fresh helper B:
`{"capture":"error","errorCode":-3801,"errorDomain":"com.apple.ScreenCaptureKit.SCStreamErrorDomain","preflight":false,"titles":0,"window":true}`
The owner added ClaveReaderSpike.app to Screen & System Audio Recording by hand and switched it on; the list shows it as
"ClaveReaderSpike" (the bundle's file name, not its CFBundleName "Clave Reader Spike") — confirmed by the owner in chat on
2026-09-18. The owner did not give a wall-clock time for when the grant was switched on; the grant can only be bounded by
the logs, between the last `error` record at 06:48:59.555Z and the first `ok` record at 06:50:23.136Z in p1p2.jsonl.
First record after the grant (06:50:23.136Z):
A: `{"capture":"ok","height":714,"preflight":true,"titles":8,"width":1263,"window":true}`
B: `{"capture":"ok","height":714,"preflight":true,"titles":12,"width":1263,"window":true}`
The owner enabled the Screen & System Audio Recording entry for the app bundle; after that, the helper binary inside the
bundle (`Contents/MacOS/clave-reader-probe`, separately signed with the same certificate, started by the app with
`child_process`) captured a window through ScreenCaptureKit. No alternative attribution path was isolated.
Consequence: the standalone helper is the design. The Node-child form and the capture-in-main fallback are not needed.
Side observations:
- The ungranted signal is SCStreamErrorDomain -3801 together with preflight=false and titles=0. This is what the product maps to `failed`.
- `titles` was briefly 4 without the grant (06:48:56Z). Titles visible without a grant exist (presumably the process's own
  or system windows), so "titles == 0" must not be used alone as the permission signal.
- Electron's own `desktopCapturer.getSources` in main answered "Failed to get sources." before AND after the grant in the
  running app. The fallback floor was therefore NOT shown to work in an already-running app; irrelevant now that P1 passed.

Deviations: the first watch of this run was aborted because the owner closed the staged Terminal window partway through
(log kept as `out/p1p2-aborted.jsonl`); the owner then restarted the watch, producing `out/p1p2.jsonl` quoted above. The
plan's Step 1 `tccutil reset` was skipped because the bundle id was new and the smoke-test record (`out/host-smoke.jsonl`)
already showed the ungranted state.

## P2 — after a fresh grant, is restarting the helper enough? Which app does the prompt name? PASS, with one failure inside (2026-09-18)

- Helper restart: PASS and better. Fresh helper B captured at the first tick after the grant with the app never restarted,
  and the ALREADY RUNNING helper A also flipped to `capture:"ok"`, `preflight:true` in the same tick. macOS 27 did not offer
  "Quit & Reopen" (owner's report). In this single run, on macOS 27.0, both the fresh helper and the already-running helper
  picked up the grant without an app restart, and macOS offered no "Quit & Reopen"; one run does not establish frequency.
  The design keeps the automatic helper restart and the `needsRestart` answer as specified.
- System prompt: FAIL. `CGRequestScreenCaptureAccess()` called from the helper returned `{"requested":false}`. The owner
  later reported (chat, 2026-09-18): a dialog "did open and I approved it, but don't remember the name". So a dialog was
  shown around 06:46Z and accepted, yet which one is NOT established: three things happened within a minute (the keychain
  may ask to let `codesign` use the new key at ~06:45Z; the smoke run's first refused capture at 06:46:12Z; the helper's
  request at 06:46:42Z), and the app name in the dialog is unknown. What IS established: after that approval the request
  still answered `false`, captures stayed at -3801, and the owner saw no entry appear in the Screen & System Audio Recording list
  (screenshot), and had to add the app with +/drag; the list then showed it as "ClaveReaderSpike" (the bundle's file name,
  not its CFBundleName "Clave Reader Spike") — the same entry name as in P1, confirmed by the owner in chat on 2026-09-18,
  which answers which app the list names. Main's failing `desktopCapturer` call did not register the app either.
  Consequence for the design: `requestPermission()` cannot rely on the helper raising the system prompt or on the app
  appearing in the list by itself. The build plan must (a) test the request once more from a properly packaged app in
  /Applications (this bundle lived under /private/tmp, which may matter), and (b) keep B's flow of opening the settings pane
  and telling the user to add/enable the app, which works regardless.

## P1 addendum — the list entry vanished; control experiment (2026-09-18, 07:02Z)

Anomaly: at ~06:58Z the owner's screenshot of Screen & System Audio Recording showed NO ClaveReaderSpike entry, while the
helper still captured (`out/list-check.json`: `capture:"ok"`, `preflight:true`). Owner: "90% sure it disappeared from the
list" (owner's chat message, recorded verbatim in the ledger), did not remove it by hand. `tccutil reset ScreenCapture dev.clave.readerspike` answered "No such bundle identifier"
(OSStatus -10814, application not found): the app registry does not know the bundle, which lives under /private/tmp. The
bundle had been re-signed twice (same certificate) between the grant and the screenshot; whether re-signing, the temp
location or something else hid the entry was not isolated.
Control: an identical twin bundle (`ClaveReaderControl.app`, same Electron, same main.js, same probe binary, same
certificate, bundle id `dev.clave.readerspike.control`, never granted), launched the same way from the same session:
- control:  `{"capture":"error","errorCode":-3801,"errorDomain":"com.apple.ScreenCaptureKit.SCStreamErrorDomain","preflight":false,"titles":0,"window":true}`
- original: `{"capture":"ok","height":346,"preflight":true,"titles":11,"width":625,"window":true}`
Designated requirements differ only in the identifier (`identifier "dev.clave.readerspike[.control]" and certificate leaf = H"a5d1…f9ff"`).
The capturing process itself, `Contents/MacOS/clave-reader-probe`, has the SAME code identity in both bundles
(`identifier "clave-reader-probe" and certificate leaf = H"a5d1c7e3469eced30f622ae6284ac1747272f9ff"` in both, per `codesign -d -r-`),
so the different outcomes cannot be keyed to the capturing binary's own identity; the access is attributed through the
enclosing app bundle that started it (macOS's responsible-process attribution).
Conclusion: the access is tied to the identity of the enclosing app bundle that starts the helper and is NOT inherited from the launching process
(Claude.app, which is itself granted). P1's verdict stands. P1's second criterion ("System Settings lists the grant under
the app") held when granted by the owner's account and does not hold now: a grant can be in force while the list shows no
entry. Consequence for the product: never infer permission state from anything but the helper's own check and capture
result, and expect users to be unable to find/revoke the entry in some states — to be re-examined with a packaged app in
/Applications.

## P2 addendum — the prompt, the list, and a second grant pickup, on a properly located twin (2026-09-18, 07:06Z to 07:10Z)

Setup: with the owner's approval the never-granted twin bundle was copied to `~/Applications/ClaveReaderControl.app`
(bundle id `dev.clave.readerspike.control`, same certificate) and launched with `open -n`. Log: `out/p6.jsonl`.
- The list: after its first refused capture (launched just after 07:06:55Z by the controller's clock; the check record itself
  carries no timestamp; -3801) the owner reported the entry "ClaveReaderControl" IS in the
  Screen & System Audio Recording list. The same bundle under /private/tmp was never listed (owner's screenshots), and
  `tccutil` could not resolve the /private/tmp app's bundle id (-10814). Consistent with: only apps in a location the app
  registry knows are listed. Only these two locations were compared; the cause was not isolated further.
- The prompt: the owner sent a screenshot of the macOS 27 dialog: "“ClaveReaderControl” is requesting to bypass the system
  private window picker and directly access your screen and audio. This will allow ClaveReaderControl to record your screen
  and system audio, including personal or sensitive information that may be visible or audible." Buttons: Allow / Open
  System Settings. It names the bundle FILE name. The owner reported it in the same chat message as switching the toggle on
  ("on, no Quit & Reopen, also I got this popup"), without saying which came first; the owner later said they clicked Allow.
  (On the first launch from ~/Applications the owner saw no prompt; earlier, around 07:05Z, the owner saw a prompt
  while only /private/tmp bundles existed and did not remember its name.) When exactly macOS raises this dialog was not
  isolated; that it exists, its wording, and the name it uses are established.
- Grant pickup replicated: last refused record 07:09:07.147Z, first `ok` 07:09:10.504Z, for BOTH the running helper A and the
  fresh helper B, `preflight:true`, the app never restarted, no "Quit & Reopen" offered (owner). Two runs, two bundles, same result.
- `CGRequestScreenCaptureAccess()` from the helper was NOT retested on the properly located twin; its earlier `false`
  answer under /private/tmp stands as the only measurement.
- Electron's `desktopCapturer.getSources` in main answered "Failed to get sources." in every record of every app process
  that was already running when its grant arrived (26 records across `host-smoke`, `p1p2-aborted`, `p1p2` and `p6`), and
  answered `{"sources":4,"nonEmpty":4}` in every record of the two app processes launched after the grant (3 records in
  `out/resign-watch.jsonl`, 2 in `out/resign-watch-rust.jsonl`) — 31 `main` records in all, 26 failures and 5 successes.
  (Corrected 2026-09-18 by the final whole-phase review; the earlier wording here said "every record of every run", which
  the logs contradict.) So the capture-in-main fallback is not dead — but Electron's main process, unlike the helper, needs
  a relaunch to see a fresh grant. It is not needed since P1 passed.
Consequences for the product: the name users see in the dialog and the list is the .app file name; the dialog's wording is
alarming ("bypass the system private window picker") and onboarding must prepare users for it; during development the app
must run from a registered location (not a temp folder) or its entry cannot be seen or revoked.

## P6 — revoking the grant while the helper runs: PASS (2026-09-18, 07:10Z)

Run on the twin in ~/Applications (the only bundle with a visible toggle); log `out/p6.jsonl`. Owner: switched the toggle
OFF, macOS showed no quit prompt; the app kept running — the log has a single `started` line and no `finished` line, and the
controller's `pgrep` at 07:11:22Z (command output recorded in the ledger, not in a log file) showed the twin's Electron
process still alive.
Last granted record 07:10:01.609Z: A and B `{"capture":"ok","height":162,"preflight":true,"titles":18,"width":240,"window":true}`.
First record after the revocation, 07:10:27.108Z, for BOTH the long-running helper A and the fresh helper B:
`{"capture":"error","errorCode":-3801,"errorDomain":"com.apple.ScreenCaptureKit.SCStreamErrorDomain","preflight":false,"titles":4,"window":true}`
then at 07:10:30.191Z the same with `"titles":0`.
Verdict: the capture is REFUSED with an error (never black, never stale pixels), and the permission check stops saying
granted even inside the process that was already running. Section 5.3 of the spec stands as written: refused capture →
`failed`; `permission()` leaves `granted`. The same error domain and code (-3801) were seen in every ungranted state in
this phase (never granted, and revoked). One revocation, one macOS version.

## P3: ScreenCaptureKit + Vision from Rust (objc2) — PASS

**Verdict: PASS.** A plain Rust binary, built with the objc2 framework crates and
run from inside the signed host bundle, captures one named window with
ScreenCaptureKit and recognises its text with Vision at 92 ms median over 1,000
reads, with flat memory and the same accuracy as the Swift probe. One run of
each measurement; numbers below are that run, not an average of several.

**Crate versions (resolved, `rust/Cargo.lock`, rustc 1.98.1 aarch64-apple-darwin):**
objc2 0.6.4, block2 0.6.2, objc2-foundation 0.3.2, objc2-core-foundation 0.3.2,
objc2-core-graphics 0.3.2, objc2-screen-capture-kit 0.3.2, objc2-vision 0.3.2,
serde_json 1.0.151. Transitive, all also 0.3.2 unless noted: objc2-encode 4.1.0,
dispatch2 0.3.1, objc2-core-media, objc2-core-video, objc2-core-image,
objc2-core-ml, objc2-image-io, objc2-io-surface, objc2-metal, objc2-av-foundation,
objc2-core-audio, objc2-core-audio-types, objc2-uniform-type-identifiers,
zmij 1.0.23. `zmij` 1.0.23 in `Cargo.lock` is a dependency declared by
`serde_json` 1.0.151 itself (author David Tolnay, repository
github.com/dtolnay/zmij), verified from the downloaded crate sources.
Nothing had to be added to `Cargo.toml`; the eight approved crates pulled in the
rest themselves.

**Accuracy (Step 4, both probes on the same staged Terminal window, back to back):**
- Swift `clave-reader-probe`: `{"accuracy": 0.9882, "markers": true, "accents": 1.0}`
- Rust `reader-spike`:        `{"accuracy": 0.9902, "markers": true, "accents": 1.0}`
- Difference **0.0020**, inside the 0.01 gate. The Rust answer is very slightly
  better, matching the deliberate difference that Rust recognises the colour
  image while Swift greyscales first.

**Soak, 1,000 reads each (first and last line of each file; no `failed` line, no rerun needed):**
- `out/p3-soak-rust.jsonl` first `{"medianMs":89,"reads":100,"rssMB":61.3}`
  last `{"medianMs":94,"reads":1000,"rssMB":61.7}` — max medianMs across the ten
  lines was 104 (at 600 reads), **RSS grew 0.4 MB** between read 100 and 1,000.
- `out/p3-soak-swift.jsonl` first `{"medianMs":54,"reads":100,"rssMB":51}`
  last `{"medianMs":46,"reads":1000,"rssMB":46.5}`.
- Gates: every Rust medianMs < 400 (max 104) PASS; Rust RSS growth 0.4 MB ≤ 20 MB
  PASS; accuracy within 0.01 PASS.

**Rust is ~2× slower per read than Swift (92 ms vs 46 ms), and Rust's steady RSS
is ~15 MB higher (≈61 MB vs ≈46 MB), also flat.** Untested hypothesis: the
colour-vs-grey difference above accounts for one or both gaps, versus objc2
overhead; no grey-Rust or colour-Swift variant was run to isolate it. Both
times are far inside the 400 ms gate.

**Spellings fixed: zero.** The brief's Rust source compiled on the first attempt
with no errors. Every ScreenCaptureKit and Vision method name, argument order
and `unsafe` marker was already correct for objc2 0.6 / objc2-* 0.3. The
compiler only warned about **six surplus `unsafe` blocks** in `recognise()` —
objc2-vision exposes `VNRecognizeTextRequest::new`, its setters,
`performRequests_error`, `results`, `topCandidates` and `VNRecognizedText::string`
as *safe* functions. Useful for the build plan: the objc2 Vision surface needs
much less `unsafe` than the ScreenCaptureKit surface, which does require it.

**Time: about 20 minutes** of the three-hour box, nearly all of it the one
runtime bug below plus the two soaks.

### The one real surprise, and it is a production concern

The first build ran but aborted with SIGABRT the moment it touched a real
window. Crash report stack:

```
abort <- __assert_rtn <- SkyLight SLSGetDisplaysWithRect <- SLGetDisplaysWithRect
      <- -[SCContentFilter setContentsAndStreamTypeMacOS]
      <- -[SCContentFilter initWithDesktopIndependentWindow:]
```

`SCContentFilter` asks SkyLight for the display under the window, and SkyLight
`assert`s (not an error return — a hard `abort`) in a process that has never
opened a window-server connection. A plain Rust CLI binary has not. The Swift
probe never hit this only because its `check()` happens to call
`CGPreflightScreenCaptureAccess()` and `CGWindowListCopyWindowInfo()` first.

Fix, the only source change made (two hunks, `main()` prologue, no behaviour or
JSON change):

```rust
let _ = CGPreflightScreenCaptureAccess();
let _ = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0);
```

Measured, not assumed: with **only** `CGPreflightScreenCaptureAccess()` the
probe still aborted with an identical stack. The **window-list** call is the one
that opens the connection. For the build plan: any non-AppKit process that
creates an `SCContentFilter` must first make a CoreGraphics window-server call,
or it will `abort` rather than return an error — there is nothing to catch.

`SCShareableContent` itself is fine: its completion block fires on a background
queue and the blocking `mpsc::recv()` on the main thread returns normally with
no run loop running (a control run against a non-existent owner returned
`{"capture":"noWindow"}` promptly). The brief's `struct Sendable<T>` +
`unsafe impl Send` pattern for moving retained objects out of a completion block
caused no trouble across 2,000 captures.

**Second production concern: what the ~45 s first recognition actually measured.**
The first `read` ever made by the Rust probe reported `recogniseMs` ≈ 45,251
(`out/p3-rust.json`), and the first by the Swift probe ≈ 46,900 (`out/p3-swift.json`).
Steady-state inside the soaks was ≈ 92 ms (Rust) / ≈ 46 ms (Swift) per read. LATER,
two fresh one-shot Swift processes recognised in a few hundred ms or less —
`out/warm-1.json`: `recogniseMs` 200, `captureMs` 121; `out/warm-2.json`:
`recogniseMs` 87, `captureMs` 92 — so the cold cost is NOT paid by every new
process. What triggers the cold cost again (first use by a given binary, a new
build or signature, a reboot, a system cache eviction) was NOT isolated in this
phase; that the mechanism is a model load/compile is a hypothesis, not a
measurement.
Consequence: the product's helper should run one throwaway recognition before it
announces `ready`, and the build plan should measure the cold cost again after a
rebuild and after a reboot. The earlier claim that a helper spawned per read
would pay ~45 s every time is removed — it exceeds what was measured.

**Consequence for spec section 6:** the macOS layer does not need to be a Swift
static library on account of binding quality — objc2 reaches both frameworks
correctly and at speed. The window-server bootstrap above is the one thing a
Rust implementation must not forget.

## P4

Spike P4 measures macOS text-recognition accuracy on staged windows with known
text (17 reads: 4 pages x light/dark x 14/11px, plus 1 Terminal read).

### Staging changes made (before/after)

One change, applied once, to `stage/www/code.html` only (no other page touched,
scorer/truth/thresholds untouched):

- Before: `.marker{font:12px Menlo,monospace;opacity:.6;margin:8px 0}`
- After:  `.marker{font:12px Menlo,monospace;opacity:1;margin:8px 0}`

Reason: run 1 (pre-fix) came back with `"markers": false` for `code-light-14`
and `code-light-11` (the only two failures out of 17). Inspecting those two
JSON outputs showed the captured text was correctly the staged `code.html`
page (title "Staged code", correct URL, correct code body) — not a wrong
window — but the `STARTMARKER`/`ENDMARKER` lines were dropped or garbled by
OCR. The `.marker` rule uses `opacity:.6` over the base text color, which in
light mode (near-black text `#1d1c1d` over white `#fff`) blends to roughly
2:1 contrast, versus roughly 3.5:1 in dark mode (near-white text `#d1d2d3`
over `#1a1d21`) — low enough in light mode to be unreliable for the OCR
engine on this specific page. Raising opacity to `1` for `code.html` removed
the transparency blending entirely (full-contrast text) without touching
chat/ticket/pt, which already passed. One rerun (of the 3 allowed) fixed
both failures; all 17 cases came back `"markers": true` afterward.

### 17 score lines (final, accepted run)

```
{"case":"chat-light-14","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"chat-dark-14","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"chat-light-11","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"chat-dark-11","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"ticket-light-14","score":{"accuracy": 0.9983, "markers": true, "accents": 1.0}}
{"case":"ticket-dark-14","score":{"accuracy": 0.9983, "markers": true, "accents": 1.0}}
{"case":"ticket-light-11","score":{"accuracy": 0.9966, "markers": true, "accents": 1.0}}
{"case":"ticket-dark-11","score":{"accuracy": 0.9983, "markers": true, "accents": 1.0}}
{"case":"code-light-14","score":{"accuracy": 0.948, "markers": true, "accents": 1.0}}
{"case":"code-dark-14","score":{"accuracy": 0.9626, "markers": true, "accents": 1.0}}
{"case":"code-light-11","score":{"accuracy": 0.9709, "markers": true, "accents": 1.0}}
{"case":"code-dark-11","score":{"accuracy": 0.973, "markers": true, "accents": 1.0}}
{"case":"pt-light-14","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"pt-dark-14","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"pt-light-11","score":{"accuracy": 1.0, "markers": true, "accents": 1.0}}
{"case":"pt-dark-11","score":{"accuracy": 0.9975, "markers": true, "accents": 1.0}}
{"case":"terminal","score":{"accuracy": 0.9882, "markers": true, "accents": 1.0}}
```

(Pre-fix run 1, superseded, for the record only — and it is **not** nearly
identical. Corrected 2026-09-18 by the final whole-phase review: `diff
out/p4-run.log out/p4-run2.log` shows **10 of the 17 cases moved** between run 1
and run 2 and only 7 were unchanged. `out/p4-run2.log` is byte-identical to the
accepted `out/p4-scores.jsonl`.

| case | run 1 | run 2 (accepted) | moved |
|------|-------|------------------|-------|
| chat-light-14  | 1.0    | 1.0    | — |
| chat-dark-14   | 1.0    | 1.0    | — |
| chat-light-11  | 0.9884 | 1.0    | yes |
| chat-dark-11   | 1.0    | 1.0    | — |
| ticket-light-14| 1.0    | 0.9983 | yes |
| ticket-dark-14 | 0.9983 | 0.9983 | — |
| ticket-light-11| 0.9983 | 0.9966 | yes |
| ticket-dark-11 | 0.9966 | 0.9983 | yes |
| code-light-14  | 0.7838 (markers false) | 0.948 (markers true) | yes, staging fix |
| code-dark-14   | 0.9418 | 0.9626 | yes |
| code-light-11  | 0.7609 (markers false) | 0.9709 (markers true) | yes, staging fix |
| code-dark-11   | 0.9626 | 0.973  | yes |
| pt-light-14    | 1.0    | 1.0    | — |
| pt-dark-14     | 1.0    | 1.0    | — |
| pt-light-11    | 1.0    | 1.0    | — |
| pt-dark-11     | 1.0    | 0.9975 | yes |
| terminal       | **0.8686** | 0.9882 | yes |

Only the two `code-light-*` cases were the ones the staging fix was made for; the
`.marker` opacity change touched `stage/www/code.html` only and does not style
scored text in any other case. The other eight cases moved with no staging change
at all — the largest being `terminal` 0.8686 → 0.9882 and `code-dark-14`
0.9418 → 0.9626. **`terminal`'s run-1 score of 0.8686 is below its 0.95
threshold**, on the case the accepted run passed at 0.9882. Run 1 is not used for
the judgment below, but it shows that a single read of one staged window can move
a case by more than 0.1, so these per-case numbers are samples, not stable
figures.

Cause of the `terminal` movement: not established. The run-1 JSONs were deleted
by the rerun — `tools/run_p4.sh` does `rm -f out/p4/<case>.json` before each read
— so the two terminal captures cannot be compared for window size, line count or
a scrolled-off marker. The accepted `out/p4/terminal.json` is 1263 × 714 px with
18 recognised lines. `run_p4.sh` opens a fresh Terminal window for this case on
every run and reads whichever Terminal window is frontmost, so a different window
size or content between the two runs is possible but unevidenced.)

### Per-group minimum accuracy, pass/fail

| group    | threshold | min accuracy | result |
|----------|-----------|--------------|--------|
| chat     | >= 0.97   | 1.0          | PASS   |
| ticket   | >= 0.97   | 0.9966       | PASS   |
| terminal | >= 0.95   | 0.9882       | PASS in the recorded run (0.9882); an earlier discarded run of the same staged window scored 0.8686, below the 0.95 threshold |
| pt       | >= 0.95 (accents 1.0) | 0.9975 (accents min 1.0) | PASS |
| code     | >= 0.90   | 0.948        | PASS   |

All five groups pass their spec thresholds in the accepted run. No group required
owner escalation. The terminal qualification above was added 2026-09-18 by the
final whole-phase review; the threshold is unchanged and no verdict is reinterpreted.

### Light vs dark, 14px vs 11px breakdown (min accuracy per slice)

| group  | light min | dark min | 14px min | 11px min |
|--------|-----------|----------|----------|----------|
| chat   | 1.0       | 1.0      | 1.0      | 1.0      |
| ticket | 0.9966    | 0.9983   | 0.9983   | 0.9966   |
| code   | 0.948     | 0.9626   | 0.948    | 0.9709   |
| pt     | 1.0       | 0.9975   | 1.0      | 0.9975   |

(terminal has a single read — no light/dark or 14/11 split.)

### Character confusions

No case fell under its threshold in the accepted run, so the brief's
"list the five most frequent character confusions" step does not apply to
any group. For completeness, a difflib `SequenceMatcher` diff of the OCR
body (text between `STARTMARKER`/`ENDMARKER`) against each truth file was
still run for the two lowest-margin cases, to see what the residual errors
look like:

- `code-light-14` (0.948): `` `->' `` (backtick misread as apostrophe, 3
  occurrences), `}->1` (1), `<->«` (1), `.->-` (1), one bare `}` line
  dropped, one `seen.add(key)` line rendered with an extra space
  (`add (key)`). The backtick/apostrophe confusion matches the brief's own
  worked example for this class of page.
- `ticket-light-11` (0.9966): `_->' '` (underscore misread as a space, 1
  occurrence); and one substitution that is **not** an artifact: the
  recogniser emitted `U+0410 CYRILLIC CAPITAL LETTER A` where the truth has
  Latin `A`.

### Script homoglyphs (corrected 2026-09-18 by the final whole-phase review)

The Latin/Cyrillic "A" pair above was first written up here as "an alignment
artifact of the diff". That explanation is wrong. Scanning the `text` field of
every accepted-run output for letters outside the Latin script:

- P4: `U+0410 CYRILLIC CAPITAL LETTER A` is present in **5 of the 17** files —
  `ticket-light-14`, `ticket-dark-14`, `ticket-light-11`, `ticket-dark-11` (in
  all four it is the leading `A` of the same staged heading, whose truth line in
  `truth/ticket.txt` is `Acceptance criteria`) and `code-light-14` (the `A`
  inside the staged constant `MAX_ATTEMPTS` in `truth/code.txt`). One occurrence
  per file. Neither truth file contains any Cyrillic character.
- P5: the same character is present in **5 of the 50** captures — all of them
  `ticket-dark-14` variants, i.e. 5 of the 8 captures of that page/theme/size,
  again as the heading's leading `A`. So it recurs across spikes and browsers,
  but not on every read of the same page.
- P3 (`out/p3-rust.json`, `out/p3-swift.json`, `out/p3-rust-nowindow.json`) and
  the two warm reads: no non-Latin letters at all.

So the recogniser returns a character that is visually identical to a Latin
letter but has a different code point, systematically in the same words across
themes and sizes, on some but not all reads. A homoglyph defeats plain substring
and regex matching silently. Everything downstream in sub-project A works on this
string — `src/core/` scrubbing, the phone and name rules, secrets patterns,
skill-name matching, the English check — so the helper's text assembly must apply
a documented normalisation before the text is matched or compared. At minimum:
map Cyrillic and Greek look-alikes to Latin when the surrounding word is
Latin-script. That is stated here as a requirement for the build plan to design
and test, not as a finished algorithm. This is the one P4 error class that is not
harmless punctuation noise.

The remaining differences are residual/expected OCR noise at small sizes, well inside each
group's threshold margin, not systemic issues.

### Timing (median over the 17 reads, final run)

- median `captureMs` = 89 ms
- median `recogniseMs` = 162 ms

Caveat: another agent may have been compiling Rust in the background on this
machine during this run; these numbers may be slightly inflated versus an
idle machine.

### Window pixel size of the reads

- Chrome-profile reads (16 of 17): 1268 x 708
- Terminal read (1 of 17): 1263 x 714

### Pre-flight rule correction (process note)

The brief's Step 3 pre-flight was originally read as
`pgrep -fl "Google Chrome" | grep -v "user-data-dir=$SPIKE/chrome-profile"`
must be empty. That check failed (the owner's own Chrome process, pid 44667,
was resident in the background with flag `--no-startup-window`), and the
run was initially reported BLOCKED. The controller clarified the intent is
window-based, not process-based: a background Chrome process with no open
window cannot supply owner content to the probe. This was independently
verified before proceeding by running the host's `check --owner "Google
Chrome"` scenario, which returned `{"capture":"noWindow","window":false}`
both before run 1 and again before run 2 (the rerun). No owner Chrome window
was ever open during either run; nothing belonging to the owner's own Chrome
was read or killed; the only process killed by the runner, both times, was
one matching `user-data-dir=<SPIKE>/chrome-profile`.

### Caveats

- Each case (page x theme x size, plus terminal) was read exactly once; these
  are single-sample measurements, not repeated-trial statistics.
- Run-to-run variance is real and unquantified (added 2026-09-18 by the final
  whole-phase review): the discarded run 1 of the same 17 cases differed on 10 of
  them, eight of which no staging change touched, the largest movement being
  `terminal` 0.8686 → 0.9882. A single read of one staged window can move a case
  by more than 0.1. Two samples per case is not enough to state a distribution,
  so no variance figure is claimed here; the build plan's `reader:eval` must read
  every case several times and report min/median.
- Another agent may have been compiling Rust in the background during this
  run, which may have slightly inflated `captureMs`/`recogniseMs`.
- One staging fix was required and one full rerun was used (of the 3 allowed)
  before all 17 cases passed with `"markers": true`.

## P4 addendum — display scale of the measurement (controller, 2026-09-18)

`system_profiler` shows the main display is an external 2560 x 1440 monitor at 1x ("UI Looks like: 2560 x 1440"); the
built-in Retina panel is secondary. The P4 captures are 1268 x 708 px for a window of the same size in points, i.e. every
P4 (and P3, P5) read was taken at 1x pixel density — the HARDER case: 11 px text is 11 physical pixels tall. The accuracy
numbers are therefore a 1x result; 2x Retina was not measured (expected to be no worse, untested). Low-contrast text being
dropped (the marker finding above) was also observed at 1x only.
`out/p4/terminal.json` also contains the Terminal window's title-bar text (local user name and a truncated path): a captured
window includes its own title bar, so in the product the title text reaches the pipeline inside `text` as well as in
`window.title`. All `out/` files are deleted in Task 9.

## P5 (Chrome) — address host and private label in the toolbar band: PASS (2026-09-18)

Chrome part of Task 8 only. Safari (Step 4) is pending — it needs the owner
to open normal/private windows by hand; owner was away. Arc is not installed
on this machine: Arc: not tested.

### Setup

`tools/toolbar.py` and `tools/run_p5.sh` were created by extracting the two
fenced code blocks (`python`, then `bash`) from `sdd/task-8-brief.md` with a
small extraction script (`extract_p5.py`, run once, not kept in `$SPIKE`),
substituting the real `$SPIKE` path for `<absolute path>` — never retyped by
hand. `python3 tools/toolbar.py --selftest` → `SELFTEST OK`. `bash -n
tools/run_p5.sh` → clean (no output, exit 0).

Pre-flight (window-based, per the Task 7/P3 correction already on record in
this file): `check --owner "Google Chrome"` returned
`{"capture":"noWindow","preflight":true,"titles":4,"window":false}` —
`window:false` and `preflight:true` as required, so the run proceeded. No
owner Chrome window was open at any point; the only process ever killed by
`run_p5.sh` was one matching `user-data-dir=$SPIKE/chrome-profile` (the
script's own `pkill` after each case).

### Run

`run_p5.sh` ran once, to completion, no reruns needed: all 40 cases (4 hosts
x 5 page variants x {normal, incognito}) passed on the first pass with
`"host": true` for every normal case, so none of the staging-fix conditions
in the brief (error page, first-run surface, search-instead-of-navigation)
were triggered. No staging changes were made.

Lock-rule check (mandatory before trusting the run): 0 of 40 cases had
`"capture"` other than `"ok"` or zero `lines` — screen did not lock and the
display did not sleep during the run. Each case was read exactly once.

### Counts

- Normal host hits: **20 / 20** (need ≥ 19/20)
- Incognito private-label hits: **20 / 20** (need 20/20)
- Incognito host hits (also correct while private): **20 / 20**
- False-private count (running `toolbar.py <file> <host> Incognito` against
  all 20 NORMAL captures): **0 / 20** — no normal-window capture ever showed
  "Incognito" anywhere in the top band.

`--incognito` with a custom `--user-data-dir` worked as expected in every
one of the 20 incognito cases; this is a recognition success, not a staging
workaround.

### Exact private-label text recognised

Recomputed directly from the 20 `out/p5/incognito-*.json` files: there is no
single private-label string. The OCR renders the incognito icon plus the
word "Incognito" three different ways, all on the same row as the
address-bar text (topPx 54-57, bottomPx 69-74):

- `* Incognito` — 11 / 20
- `Incognito` — 8 / 20
- `- Incognito` — 1 / 20

Consequence: the product must not match an exact string. It must match the
word "incognito" case-insensitively as a substring of a top-band line (the
leading `*`/`-`/nothing is just the OCR's rendering of the incognito icon
glyph, not stable text). Example top-band lines from one incognito capture
(`incognito-app.clave.localhost-chat-light-14.json`):

```
{topPx:55, bottomPx:71, text:"app.clave.localhost:8765/chat.html?th..."}
{topPx:55, bottomPx:70, text:"- Incognito"}
```

### Band height

Expressing the band as a fraction of window height is the wrong carrier: a
browser toolbar's height is fixed in points and does not grow with the
window, so a fraction of a taller/shorter window is not what determines
whether the markers fall inside the band. It is also untested here — all 40
captures reported the same `height: 708` px (verified by re-reading every
`out/p5/*.json` file), so invariance across window heights was never
exercised in this run; widths did vary (630 px for 35 cases, 1268 px for 5),
which had no effect, but that says nothing about a different *height*.

- Largest `hostBottomPx` seen: 74 px (normal-app.clave.localhost-code-light-11)
- Largest `privateBottomPx` seen: 73 px (incognito-staging.jira.localhost-ticket-dark-14)
- Overall max: 74 px, at 1x pixel density (see "P4 addendum" — this whole
  machine's captures, P3-P5, were taken at 1x, the harder case). After a 10%
  margin: 74 * 1.10 = **81.4 px, i.e. about 82 px at 1x**.
- The product should carry the band in **points**, multiplied by the
  display's pixel scale at capture time, not as a fraction of capture
  height. 2x (Retina) was not measured in this spike.
- For the record, not to be used: 81.4 / 708 = 0.1150 (11.5% of this run's
  708 px capture height).

### Window pixel size

All captures reported `height: 708`. `width` was `630` for 35 of 40 cases
and `1268` for 5 of 40 (one incognito case, four normal cases — an
unexplained Chrome new-window sizing variance, not correlated with a
failure; host/private detection succeeded in all of them). No case fell
outside the `topPx < 260` band regardless of width.

### 5 lowest-margin cases (margin = 260 - bottomPx; smaller = closer to the BAND_PX cutoff)

1. `normal-app.clave.localhost-code-light-11` (host, bottomPx 74, margin 186)
2. `incognito-staging.jira.localhost-ticket-dark-14` (private, bottomPx 73, margin 187)
3. `incognito-app.clave.localhost-code-light-11` (private, bottomPx 72, margin 188)
4. `incognito-app.clave.localhost-pt-dark-11` (host, bottomPx 72, margin 188)
5. `incognito-app.clave.localhost-chat-dark-11` (private, bottomPx 72, margin 188)

All margins are large relative to `BAND_PX=260`; nothing came close to the
threshold in this run.

### Verdict

Chrome: reliable. Address host recognised in 20/20 normal captures (exceeds
the ≥19/20 bar) and the private-window label recognised in 20/20 incognito
captures (across three distinct OCR renderings — see "Exact private-label
text recognised") with zero false positives on normal captures. A band of
roughly 82 px at 1x pixel density comfortably covers both markers in every
case measured; carry that as points x display scale, not as a fraction of
capture height (11.5% is for the record only — see "Band height").

### Caveats

Scope: this is a single run, each case (host x page-variant x mode) read
exactly once — single-sample measurements, not repeated-trial statistics.
It used Google Chrome 153.0.8010.52 (read by the controller from the app's
Info.plist) on macOS 27.0, with a fresh default profile only: no bookmarks
bar, no extensions-toolbar growth, no side panel, no tab groups, and no
non-default theme were present, and each of those can change the toolbar's
height or contents. One window height was exercised (see "Band height"),
and captures were 1x pixel density only (see "P4 addendum") — 2x was not
measured. Safari (Step 4) is pending, owner away, not run in this pass; Arc
is not tested (not installed on this machine). The window-width variance
(630 vs 1268 px) is unexplained but did not affect any result and was not
investigated further, out of scope for this spike.

Method, verified: the host match comes from the address-bar line (format
`host:port/path?query`, topPx 54-57), not from the tab-title line (topPx
13-15, bottomPx 27-29, text `Staged <name>`, which never contains a host).
The page body starts at `STARTMARKER`, topPx 111 in every capture — inside
the generous 260 px search band used by `toolbar.py` — and produced no
false host/incognito match in this run (0 hits below the address-bar row).
That is a property of this run's fixed, short synthetic page content, not
proof the band is safe: the product's band must be much tighter than 260 px
(the ~82 px figure above), otherwise page text containing a host name or the
word "incognito" could match.

## P5 (Safari) — 2026-09-18, Safari 27.0 on macOS 27.0, owner-staged

Method: the owner opened one Safari window with one tab, on the 1x external display, and loaded the five staged pages
(chat, ticket, code, pt, chat dark) from `http://127.0.0.1:8765/`; then the same five in a private window (File → New
Private Window) with the normal window closed or minimised. After each load the controller ran one `read --owner Safari`
through the host's `run` scenario and `toolbar.py <file> 127.0.0.1 [Private]`. Files: `out/p5/safari-normal-1..5.json`,
`safari-private-1..5.json`. Capture size 1285 x 1424 px in all ten.
Results:
- Host recognised: normal 5/5, private 5/5. Safari's compact address field shows the host only; renderings seen in the top
  band: `@ 127.0.0.1` (7) and `• 127.0.0.1` (3) — the leading mark is the recogniser's rendering of the icon next to the address.
- Private label recognised: 5/5. Renderings: `• Private` (2), `Private` (2), `¡• Private` (1), always on the address row.
- False "private" in the five normal reads: 0/5.
- Geometry at 1x: host and label lines lie between topPx 16 and bottomPx 37 in all ten reads; the staged page's first
  recognised content is the STARTMARKER line, whose box is `topPx` 76 / `bottomPx` 89 in all 9 files where it was
  recognised (it was not recognised in `safari-private-3`) — one line's box, not a range across files — and the first
  body line follows at about topPx 99–105. Safari's band is therefore about 37 px (≈41 px with a 10% margin) at 1x —
  roughly half of Chrome's ~82 px. The product needs a per-browser band (in points × display scale), not one number.
- In `safari-private-3` (code page, light) the STARTMARKER line directly under the toolbar was NOT recognised, while the
  first code line, ENDMARKER, host and label were: another instance of small faint text being dropped (see P4).
Verdict: Safari 27.0 — host and private detection reliable in this sample (5 + 5 reads, one window size, 1x, default
toolbar layout: no favourites bar, no tab overview, a single tab; with several tabs Safari's compact layout may shorten or
hide the host — NOT tested). Only a bare IP host was used; `*.localhost` names were not tried in Safari.
Arc: not installed, not tested.
(The "P5 (Chrome)" figures above now state the verified ranges: address-bar lines are topPx 54–57, bottomPx 69–74 across
all 40 Chrome captures — the single case at topPx 54 is `incognito-app.clave.localhost-pt-dark-11`, the single case at
bottomPx 74 is `normal-app.clave.localhost-code-light-11`. Corrected in place 2026-09-18 by the final whole-phase review;
the separate correction sentence that used to sit here is no longer needed.)

## P4 addendum 2 — repeat reads of the terminal case (controller, 2026-09-18, after the final review)

To give the owner data on the run-to-run question raised by the final review (C3): the staged Terminal window was opened
once and read TEN times in a row through the host's `run` scenario (`out/p4-repeat/terminal-1..10.json`).
Result: accuracy 0.9882 in all ten reads, `markers: true`, and ONE distinct recognised text (identical SHA-256 over the ten
`text` values); capture 1426 x 1750 px, 19 lines. The character errors are the same five every time: `✓`→`v` (twice),
`❯`→`>`, one `s`→` S`, one inserted space.
What this establishes: recognition of an unchanged window is deterministic on this machine; the 0.8686 of the discarded
first P4 run cannot be recognition noise over the same pixels — the window read in that run must have differed (size,
wrapping, scroll position, or which Terminal window was frontmost). Which of these it was is NOT established: that run's
capture was overwritten. (The P3 implementer separately reported a 625 px wide staged Terminal window whose first line had
scrolled off; not shown to be the same event.)
What it does not establish: accuracy on narrow or wrapped terminal windows; variance on the browser cases (not repeated).
This capture (1426 x 1750) is larger than the recorded P4 terminal read (1263 x 714); whether it was taken on the 2x
built-in display was not verified.
Consequence: `reader:eval` must stage each window at fixed, recorded sizes — including a narrow terminal — and read each
case several times (spec 10.1 item 15). Thresholds unchanged.
