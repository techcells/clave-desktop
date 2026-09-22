# Native reader C-2b-2: measurements record

Record of the sessions of plan `docs/superpowers/plans/2026-09-19-native-reader-c2b2-acceptance.md`.
Everything below is a number, a fixed code, a count, a process fact or the owner's own words. No
recognised text and no window title is recorded anywhere. The controller's running ledger, every
developer report, review and re-review of these sessions are in
`docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/` (`session1/ledger.md` is the detailed
source for this file). Results files: `app/reader-eval/out/` (numbers only).

## Environment

| | 2026-09-20 | 2026-09-21 |
|---|---|---|
| macOS | 27.0 (26A428) | 27.0 |
| Displays | built-in Retina 2560x1600 (2x) ONLY | external 2560x1440 at 1x = main; built-in Retina 2x secondary |
| Chrome / Safari | 153.0.8010.52 / 27.0 | same |
| Window manager | yabai 7.1.25 running (not yet known to the controller) | yabai; runtime rules added by the owner; stopped by the owner for the acceptance runs |
| Bundle | `~/Applications/Clave Agent Dev.app`, protocol 2 | re-created 06:3x with the failure-detail helper |

## Task 1 — harness additions (2026-09-19/20): DONE and reviewed
`coldstart` with `helper.readyMs`, `--position` (now −20000..20000), Chrome in `observe`, numbers-only
`position`. Reports in the plan's files folder.

## Session 1 (Task 2) — first launch and shake-down

**The grant survived** both re-creations of the bundle on 2026-09-19 (the 20:03 accident and Task 9):
measured by the helper's own answer, `permission: granted`, never yet confirmed by the owner in System
Settings.

**Cold start after a reboot and a long idle (carried item 4).** The machine was rebooted 2026-09-19
23:41; the first helper start since, at 13:22 the next day (13 h 40 min up): `readyMs` **150**; the
second, a minute later: **135**. No ~45 s cold cost. Caveat: whether some other process used Vision
text recognition in between is unknown. The eval entry (`CLAVE_DEV_ENTRY=reader-eval`, a window-less
Electron inside the real bundle, the helper next to the executable, protocol 2) works end to end and
the grant reaches the helper it spawns.

**FINDING S1-F1 — `READER_PROBLEM` in real use, cause still unknown.** 2026-09-20, Retina-only day,
the owner working normally under yabai: run 1 (56 s) kept 12, unchanged 3, noWindow 2, empty 2; run 2
(8 min 46 s) kept 129, unchanged 15, empty 7, **failed 4 (+ the fifth, which tripped the limit and
was not tallied — a bug, since fixed)**, windowGone 3, noWindow 2 → `READER_PROBLEM`, capture off. No
timeout, no helper exit, no wedge, no mismatch, no permission loss; the same helper throughout
(22 MB). The owner: "Reading got turned off automatically for no reason, and it showed this error
saying that something failed." Protocol 2 and the three approved-window comparisons worked against
real titles (144 productive cycles) — carried item 37's real-titles half is observed.
Not reproduced since: 36 + 90 + 90 + … staged reads without one `failed`; on 2026-09-21 (external 1x
main, yabai tiling) reading ran from 07:04 for hours with no trip. Leads, none proven: the 2x-only
display; yabai moving/resizing a window while it is captured. **Instrument built because of it
(reviewed, in the bundle since 2026-09-21 06:3x):** every `failed` carries a closed-set detail end to
end — `noExpect`, `noGrant`, `captureRefused`, `captureTimeout`, `captureError`, `captureNoContent`,
`captureNoImage`, `recogniseError`, client-side `helperDown`, loop-side `failedFrontWindow`,
`failedReadCall`, `timeoutFrontWindow`, `timeoutRead`, `failedUnknown` — tallied per run under fixed
log keys and written with `CAPTURE_OFF`; the failure that trips the limit is now tallied before the
problem is raised. The next trip names its stage.

**Other real-use observations.** The planned helper restart fired for the first time in real use
(`READER_HELPER_REPLACED` at 19:22, 01:22 and twice more; never an exit). Helper CPU 2026-09-21:
33 s in 13.2 min of reading ≈ **4.2 % of one core**; RSS 82–93 MB. The smoke run prints nothing at
all while the dev app is running (single-instance lock) and passes once it is quit — it should say
so. Closing the app's window does not quit a tray app: `dev:bundle` correctly refused with
`APP_RUNNING` (its guard's first real use); on the owner's "quit" the controller sent SIGTERM.
**Open question S1-Q2:** the owner reported toggling reading off and on at about 10:20 on
2026-09-21; `app.log` has no line after `CAPTURE_ON` 07:04:12 (no `CAPTURE_OFF`, no tallies). Whether
the toggle reached the engine is not established (the log swallows its own write failures by design).

**Harness shake-down: what only a screen decided.** Three repair loops (E1), each developed,
reviewed with reproducing probes, fixed and re-reviewed:
1. Both Terminal cases `noMarkers`: the guard passed on the title before the script had printed →
   a `READY` token in the harness's own title grammar, printed after ENDMARKER (a narrowing).
2. Every staged window the wrong size (708x884 pt on 2026-09-20; 844x1424 px on 2026-09-21), Chrome
   and Terminal alike → not Chrome's flags: **the owner's tiling window manager re-tiles every new
   window.** Self-diagnosis added (`staged`, `displayScale`, `sizeAsStaged`; a repetition not as
   staged makes its case incomplete); the owner added runtime yabai rules
   (`title="CLAVE-EVAL" manage=off`, `app="^Terminal$" manage=off`); the title rule still missed 2 of
   90 Chrome stagings (applied at window creation, before Chrome had set its title), so the
   acceptance runs were made with yabai stopped.
3. Terminal reported 80x24: `$(tput cols)` runs with stdout on a pipe and falls back to terminfo →
   `stty size < /dev/tty` with a bounded poll; `readyColumns`/`readyRows` recorded (two bounded
   integers — the one deliberate exception to "no number parsed from a title").
4. `terminal-narrow` opened on the Retina display, which cannot hold 40 rows → both terminals staged
   at 30 rows.
5. First Chrome case of a run `notStaged` in 2 of 3 runs → one automatic re-stage, 30 s for the first
   staging of a run, `stageAttempts` recorded.
6. Toolbar mode 40/40 `notStaged`: the page was fetched (200), Chrome in front, our prefix seen, and
   the guard still refused — the ~73-character staged titles did not survive into the window title
   the window server reports. Staged titles are now `CLAVE-EVAL <fixed-width id> <nonce>` (27 chars,
   cap 40 enforced); results keep the full case names. Also from that loop: both loopback families
   bound as a matched pair (never a wildcard), request counters pre-seeded with this run's titles,
   `--limit` (a limited run can never be accepted), `PAGE_SERVER` as a named refusal.
The guard's rule, the scorer and the thresholds were never changed (checked byte-identical at every
review).

## Task 3 — acceptance numbers at 1x (2026-09-21, external display, yabai stopped)

**Accuracy, five repetitions, 18 cases, 90 reads, all `ok`, all as staged — ACCEPTED**
(`accuracy-ca74052c41fa.json`):

| Group | Minimum | Median | Threshold |
|---|---|---|---|
| chat | 1.0000 | 1.0000 | ≥ 0.97 |
| ticket | 0.9983 | 1.0000 | ≥ 0.97 |
| code | 0.9709 | 0.9751 | ≥ 0.90 |
| Portuguese | 1.0000, accents 1.0 | 1.0000 | ≥ 0.95, accents kept |
| terminal (140x30 and 72x30) | 0.9902 | 0.9902 | ≥ 0.95 |

A run five minutes earlier with yabai running (`accuracy-0d511033d396.json`) had every group above
its threshold too (chat 1.0, ticket 0.9983, code 0.9563, pt 1.0, terminal 0.9882/0.9902) but was
INCOMPLETE by the harness's own rule — 2 of 90 stagings re-tiled — and is not the accepted run.
Timings over those 90 reads: capture median 39 ms (max 101), recognition median 136 ms (max 177);
so capture + recognition ≈ 175 ms per read ≈ 3.5 % of one core at the 5 s poll (carried item 13).
**Same-pixels cache (item 27):** the immediate second read of an unchanged staging was a cache hit
in **90 of 90**. The narrow terminal, the case phase 0 could not explain (0.8686 once): 0.9902 in all
five repetitions.

**Toolbar, 40 Chrome stagings, default toolbar — ACCEPTED** (`toolbar-c1a1e7e0357d.json`): address
host **20/20** normal (need ≥ 19) and 20/20 incognito; private badge **20/20** (need 20); false
private **0/20** (need 0); all as staged, all on the first attempt. `hostBottomPx` 70–74,
`privateBottomPx` 70–75, `bandPx` 82 — the badge is 7 px inside the band at worst. This is the first
real `toolbarText` from Chrome's band on the Rust path (carried item 36) and it uses the core's own
`hasPrivateToolbarMarker`.

## Not yet done (plan tasks 4–10)
Safari private and normal in one session and the compact layout (Task 4, item 29 — still the most
consequential unmeasured behaviour); Chrome bookmarks bar and other toolbars, and the band-rule
decision (Task 5, item 30); permission in real use — a grant under a running app, item 26,
"Quit & Reopen", revocation through the poll, lock, sleep (Task 6); a working day of RSS/CPU/`black`/
notice sampling (Task 7; the cold-start half is done above); the manual checklist and the same two
acceptance runs on the 2x display with `--position` (Task 8); browser names (Task 9); acceptance of
sub-project C (Task 10). Also open: S1-F1's cause; S1-Q2; the owner looking at the two new renderer
surfaces; D16.

## Session 2 (Task 4 — Safari), 2026-09-21 afternoon

Detailed ledger: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session1/ledger.md` (from
"Session 2" on); developer reports and reviews: `…/c2b2-files/session2/`.

**Safari private windows are skipped — MEASURED, PASS (carried item 29).** `reader:eval -- observe
--expect safari-private` (results `observe-c3d2022f1708.json`): 5 of 5 private pages read `ok`, private
marker found 5/5, badge bottom 32–34 px inside the 41 px band. Control in the same session,
`--expect safari-normal` (`observe-2258e25f2302.json`): 5 of 5 read, false-private 0/5. Safari 27.0,
external 1x display, single-tab windows, yabai stopped, default toolbar. Not yet: the compact layout
with many tabs, 2x.

**Safari's address host: a real finding, root cause found.** The host was missing from the strip on
the same three page kinds every time (both chat pages and the Portuguese page; `hostDistance` 8–9,
i.e. nothing resembling it). With the owner's approval ("yes") a debug flag `--reveal-toolbar`
(exploratory runs only, terminal only, never written to results, temp file deleted on every exit
path incl. signals, heartbeat-gated on the bundle side) showed the recognised strip of those staged
windows: `Translation Available` + a glyph, where a page with the host found showed `@ 127.0.0.1` and,
as a separate line, `C =`. **Safari shows "Translation Available" in place of the host for the first
seconds after a translatable page loads.** Not a recognition fault, not a band fault. Consequence:
in that window an excluded SITE cannot be recognised and the read would have been kept.

**Owner decision O8 ("yes", 2026-09-21): a Chrome or Safari read whose toolbar strip shows no address
is not kept (fail closed).** Built in `app/src/core/exclusions/` (`showsAddress`, asked per LINE: at
most two leading and three trailing letterless glyph tokens around ONE address token — domain,
`localhost`/`*.localhost`, range-checked IPv4, bracketed IPv6, single-label host only with a port or
path, port 1–65535, host labels not starting/ending with a hyphen; a closed list of leading browser
labels, today exactly "Not secure", English only; input capped at 2048 characters; every pattern
linear). Rule order in `after()`: private marker → excluded site → no address (`unknownWindow`);
measured browsers only; `extractHosts`/`siteExcluded` byte-identical to before. It took three
refused or reserved reviews to get there (whole-strip matching kept `Translation Available` beside a
`Node.js docs` tab; a cubic ReDoS in an IPv6 pattern, 68 s at 6.4 KB, never run in real use; trailing
tokens not letter-checked; a 16-line cap that cut Chrome's omnibox line off; Chrome's persistent
"Not secure" label; seven unpinned guards). Known, documented residual hole: a tab whose whole title
is one address-like token (`Node.js`, `README.md`, a truncated `README.md …`, `Not secure Node.js`)
still counts — closing it needs the reader to hand the core the address ROW (design item for the
owner). Owner-approved copy, his words "use the shorter one under What it cannot do": KNOWN_LIMITS now
has "In Chrome and Safari it only reads a page while the address is visible."
Owner: his Chrome is in English ("english"). Chrome treats loopback hosts as secure, so the staged
pages never show "Not secure": how that label is recognised is still unmeasured.

**Harness, from this session (all reviewed):** observe needs `--expect <set>` to be able to pass and
ends as soon as the set is read; progress lines; retries (3) on a failed read; nonce-named run files
and a validated 12-hex nonce; `NOT READ` vs `would be KEPT` labels; `hostDistance`; `--host`;
`--reveal-toolbar`; `addressLine` (the core's own `showsAddress` per row, information only); results
schema 5.

## Session 3 (evening of 2026-09-21): O8 closed, Chrome's omnibox, Task 4 finished

Ledger: same file, from "Session 3" on; reports: `…/c2b2-files/session2/o8-rereview3.md` and `…/c2b2-files/session3/`.
Environment: as the 2026-09-21 column above; yabai stopped throughout; Safari 27.0; Chrome 153.0.8010.52.

**O8 core rule: COMPLETE.** Re-review 3 (approved with reservations: 16 unpinned guards, none a live defect) →
fix round 4 (114 test rows; one behavioural change, a narrowing: a port is `[1-9][0-9]{0,4}`, so zero-padded
ports no longer count) → re-check ALL ADDRESSED (1.3 million-input differential: 0 newly true). Suite 2990 in 90
files with the harness work below; typecheck clean.

**Chrome's real omnibox satisfies O8's per-line rule: `addressLine` 40/40** (`toolbar-49b1f6b62fab.json`,
ACCEPTED again: host 20/20, private 20/20, false-private 0/20; `hostBottomPx` 70–74, `privateBottomPx` 72–74,
`bandPx` 82; all as staged, first attempt). Default toolbar, loopback hosts, 1x.

**Task 4 Step 3 — in-app control: PASS.** Two reading runs in the app (scripted model): a normal Safari window in
front → `kept` 41, `notKept` 5, `failed` 0; a private Safari window in front → `kept` 0, `notKept` 42, and the
owner: "there was only one statement before and after". The off/on toggles all reached the log (S1-Q2 not
reproduced).

**Task 4 Step 4 — many tabs, and a layout nobody had measured.** The owner's Safari was already in the COMPACT
tab layout, so every earlier Safari number was compact/one tab. Measured tonight with eight tabs, staged page in
tab 5, five pages each: compact normal false-private 0/5 (`observe-cd70f8c6a0b6.json`), compact private 5/5
(`observe-2b2934df8283.json`), SEPARATE private 5/5 (`observe-b49ea1a6dedd.json`), SEPARATE normal 0/5
(`observe-200f0ae53c41.json`); badge bottom 31–34 px in the 41 px band in all. `addressLine` true in 10 of those
20 reads: the misses are the translatable pages in their first seconds (O8's measured reason), plus ONE read
(compact, code page) with the host present but no address line, not reproduced in two exploratory reveal runs
(owner's "yes" to a reveal that also showed his other tabs' titles): in the compact layout each tab and the
address are separate recognised lines, so the rule fits; the one miss was transient. Open observation for the
"address ROW" design item and for Task 7's `notKept` share.

**Harness:** `toolbar --not-secure` (owner decision "A": the page server stays on loopback; only the eval's own
Chrome profile maps the reserved name `clave-eval.test` to 127.0.0.1; never accepted; `--reveal-toolbar` allowed
with it), reviewed, fixed, re-checked ALL ADDRESSED; results schema 6. Not yet run against a screen.

**"Not secure" (owner decision "A") — MEASURED.** `toolbar --not-secure --limit 4 --reveal-toolbar` then the full
40 (`toolbar-9d4af4de1f44.json`, `toolbar-2022c0133c3a.json`; exploratory, never accepted by construction):
Chrome 153 draws the chip at once and it is recognised as ITS OWN line (icon letter + "Not Secure"), the address
as a separate line: host (`clave-eval.test`) 40/40, private 20/20, false-private 0/20, `addressLine` 39/40 (the
miss an incognito read, dropped as private anyway). No infobar text in the band, no HTTPS-first interstitial,
the resolver rule works on a fresh profile.

**Task 5 — non-default Chrome toolbars: PASS, no band-rule change.** Bookmarks bar shown (owner saw it):
`toolbar-267e2480123c.json` ACCEPTED, host 20/20, private 20/20, false-private 0/20, `addressLine` 40/40,
`privateBottomPx` 72 of `bandPx` 82. Owner's own Chrome, combined worst case (his words: normal window "Tab
group, Side panel open, Pinned extensions"; incognito "Tab group, Side panel open"; theme "Default"):
`observe` chrome-normal 5/5 read, false-private 0/5; chrome-private 5/5 private, badge 73–74 px of 82; host and
`addressLine` 10/10. Not measured: a non-default theme; 2x.

## Session 4 (2026-09-21 23:10 – 2026-09-22 00:06): Task 6 — permission in real use, Steps 1–5 PASS

All on the finished install (the blocker surface, not onboarding), scripted model, macOS 27.0; the owner did
every System Settings and `tccutil` action himself.

| Step | What happened | Verdict |
|---|---|---|
| 1 grant under a running app (item 14, D-A) | `tccutil reset`, launch: Home shows "Screen Recording is switched off for this app." + OPEN SYSTEM SETTINGS. Entry switched on, macOS offered Quit & Reopen, owner chose Later: blocker gone — owner: "it was instant". Helper replaced by the app itself (pid 41570 → 41655), no `READER_HELPER_EXIT`, no code at all for that replacement. One minute of reading after it: `kept` 20, `failed` 0 | PASS |
| 2 after a long wait (item 26) | 14 minutes on the blocker, helper being replaced about once a minute; button + entry on, Later: "it was instant again" | PASS |
| 3 Quit & Reopen (item 15) | On a re-grant he chose Quit & Reopen: "it came back by itself"; same scripted mode (`.dev-launch.json`), no `NO_READER_YET`; reading, on at the quit, came on again | PASS |
| 4 revocation (item 28) | Entry switched off while reading: owner counted "7 seconds"; `PERMISSION_LOST` + `CAPTURE_OFF` (run: `kept` 23, `failed` 0, blockers 1), no `READER_PROBLEM`, no helper exit. Re-grant: `CAPTURE_ON` by itself within seconds (seen twice) | PASS |
| 5 lock, display sleep (item 35) | Lock ~2 min: same helper, CPU +0.28 s in 2 min 50 s (≈0.16 % of a core vs ≈4 % reading), run tallies `noWindow` 15, `failed` 0. Display sleep: `noWindow` 15, `failed` 0, `black` 0. In both the `locked` tally stayed 0 and no `CAPTURE_OFF`/`CAPTURE_ON` pair was logged — a lock shows up as `noWindow` | PASS (with that note) |
| 6 machine sleep and the nothing-read clock | not done (owner stopped for the night) | OPEN |

## Session 5 (2026-09-22 morning): Task 6 Step 6, Task 8 at 2x, Task 7 start

Ledger: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session1/ledger.md`, "Session 5"; Task 7
samples: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session3/task7-samples.txt` (process
facts only). Environment: macOS 27.0; main display external 2560x1440 at 1x at the origin, built-in Retina
to its RIGHT at origin 2560,540, 1440x900 points in a scaled ("more space") mode with a 2560x1600 px backing
(Electron reports `displayScale` 2); Chrome 153.0.8010.52; Safari 27.0; yabai running at 08:34, NOT running
from ~09:5x on (`yabai --stop-service` answered "Could not find service ... in domain for user gui: 501";
0 processes; not stopped by an agent); the dev app was reading in the background during every eval run.

**Task 6 Step 6 (machine sleep and the nothing-read clock, new item 4 / R-1): NOT TESTABLE HERE (E4).**
Owner, verbatim: "continue" (08:34). Setup as planned: reading on, the Clave Agent window itself (an
excluded app) in front while he kept touching the machine (both constants must hold: `BARREN_CYCLE_LIMIT`
24 AND `BARREN_AFTER_MS` 10 min; five minutes without input is `userAway`, neutral). Owner, verbatim (09:41):
"siz" (= "six"). Reading on (`CAPTURE_ON` 28, the last code), no `READER_NOTHING_TO_READ`. Then, with a
screenshot of the Apple menu with Sleep greyed out, owner, verbatim: "Sleep is disabled for me for some
reason." `pmset -g`: `SleepDisabled 1` (needs sudo to change). Ruling: a system setting is not changed for
one measurement. What it would take: `sudo pmset -a disablesleep 0`, the ten-minute sleep, then `1` again,
another day. Partly covered already: lock and display sleep (Session 4, Step 5) raised no false notice.
Cost if wrong: the sleep/resume reset of the nothing-read clock stays unverified in real use.
**Task 6: DONE (Steps 1-5 PASS, Step 6 not testable here).**

**Task 7 started 09:44** (owner, verbatim: "today"). Sampler: a nohup shell loop, every ten minutes, process
facts only. Baseline codes at start: `CAPTURE_ON` 28, `CAPTURE_OFF` 24, `PERMISSION_LOST` 3,
`READER_HELPER_EXIT` 1, `READER_HELPER_REPLACED` 6, `READER_PROBLEM` 2. Helper 58088 (replaced overnight by
plan) RSS 65 MB, app main 87 MB. Owner, verbatim (09:5x): "I can't wait for 6 hours, I need to finish
building this app in max 3-4 hours". Ruling: the sampler keeps running while Tasks 8, 9 and 10 are done
inside those hours; Task 7 is recorded with the hours the day gives (3-4 instead of the plan's "at least
six") as a QUALIFICATION he accepts or refuses at Task 10. Cost if wrong: the six-hour planned restart is
not seen inside the sample (seen in real use six times already) and the RSS curve is shorter.
Samples so far (time, helper pid, RSS, CPU time): 09:44:27 58088 66,720 KB 0:30.35; 09:54:27 58088
43,792 KB 0:37.32; 10:04:27 71387 33,424 KB 0:04.33; 10:14:27 71387 101,280 KB 0:28.85. The helper pid
changed between 09:54 and 10:04; the reason is not recorded in the sources (a `READER_HELPER_REPLACED`
count after the change is not in the ledger). The CPU growth 30 -> 37 s in the first ten minutes is the
app's own reading: the 2x eval runs used the eval's OWN helper.

**Task 8, Retina (item 8): BOTH ACCEPTANCE RUNS ACCEPTED AT 2x, same thresholds.** Owner (screenshot of
Arrange Displays), verbatim: "To the right is the original Mac laptop display, and to the left is the
monitor". First attempt at `--position 2600,500` was REFUSED `POSITION_OFF_DISPLAY` (nothing opened): the
guess of the Retina's origin was wrong; CoreGraphics (read via ctypes, no window, no read) gave origin
2560,540 and 1440x900 points. Position used: **2600,600**.

| Run | Results file | Numbers |
|---|---|---|
| accuracy x5, 09:55:48-09:59:57, nonce d6fdec16da23 | `accuracy-d6fdec16da23.json` | READER_EVAL ACCEPTED. chat min 1.0000; ticket min 1.0000; code min 0.9605, median 0.9709; pt 1.0000, accents 1.0; terminal min 0.9902 (140x30 0.9922, 72x30 0.9902). 90/90 ok and as staged; Chrome captures 2320x1280 px (= 2x the 1160x640 pt); captureMs median 27 (max 161), recogniseMs median 113 (max 191), no slower than 1x; same-pixels cache hit on the repeat read 90/90 |
| toolbar, 10:00:13-10:01:55, nonce 39912ad56508 | `toolbar-39912ad56508.json` | READER_EVAL ACCEPTED. host 20/20, private 20/20, false-private 0/20, addressLine 40/40; hostBottomPx 141-152, privateBottomPx 143-148, bandPx 164 (= 82 pt x 2, as the spec expects); 40/40 as staged, attempt 1 |

So P4 and P5 hold at 2x. The S1-F1 lead "capture fails at 2x" gets no support from 130 clean 2x reads.
Not measured at 2x: Safari (the plan's "82 for Safari via observe" was not run).

**The morning run's tallies (reading on ~08:3x-10:18, through Step 6's six minutes, the 2x eval runs and
the owner's VS Code stint).** Owner, verbatim (10:18): "done, it was VS Code". `CAPTURE_OFF` line: kept 387,
unchanged 230, notKept 71, denied 24, empty 8, windowGone 17, userAway 52, noWindow 98, **black 1**,
**failed 1 = failedCaptureError 1**, blockers 0 (sum 889, i.e. ~900 cycles). No `READER_PROBLEM`, no
`READER_NOTHING_TO_READ` (correct: Step 6's stint was six minutes, under the ten the clock needs). This is
the FIRST real-use `black` (item 11: 1 in ~900 cycles) and the FIRST named failed stage: `captureError`,
one in ~900 cycles, during a period in which the eval opened and closed 130 windows on the other display (a
capture landing on a window being torn down is the plausible reading, not proof). The 2026-09-20 trip had
5 failed in 165 cycles; today 1 in ~900. Owner, verbatim: "no new statements got added" during VS Code -
but the app showed 4 waiting statements vs 1 in the morning, so statements DID get added today; the
scripted model repeats a fixed set and duplicates are not added, so attribution to VS Code is impossible
from this run. Ruling: one dedicated three-minute run (pool emptied by him first, VS Code only) for the
gutter check; if no statement appears, the gutter half is recorded as not testable with the scripted model.

## Spec section 9 "Done means", item by item

Plan Task 10 Step 1. Each row names what verified the item (task, results file, number) or what is open.
Rows marked PENDING are to be filled in on 2026-09-22.

| # | Item (spec section 9) | Status | Evidence |
|---|---|---|---|
| 1 | All six spikes reported; the design branch chosen | DONE 2026-09-18 | Spec section 10, P1-P6, all PASS; the standalone helper of section 2 is the design (`docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`) |
| 2 | TypeScript and Rust tests pass; the existing tests still pass; typecheck clean; `SMOKE OK` | Last recorded run 2026-09-21: `pnpm --dir app test` 2990 passed in 90 files, typecheck clean, native 251, zero warnings; `SMOKE OK` 2026-09-21 06:3x (with the dev app quit; it prints nothing beside the running dev app). No code changed in Sessions 4-5. PENDING: the numbers of 2026-09-22 (re-run today) | Ledger, end of Sessions 3 and 4; measurements record, Session 1 (smoke) |
| 3 | The staged-window run meets P4 and P5 on the owner's machine | PASS at 1x AND at 2x, thresholds untouched; every group on its MINIMUM. Named gaps: Safari at 2x not run; a non-default Chrome theme not measured (owner uses Default); other browsers: PENDING (Task 9, owner decision) | Task 3, 1x: `accuracy-ca74052c41fa.json` (chat 1.0000, ticket 0.9983, code 0.9709, pt 1.0000/accents 1.0, terminal 0.9902, 90/90 as staged) and `toolbar-c1a1e7e0357d.json` (host 20/20, private 20/20, false-private 0/20, bandPx 82). Task 4, Safari 1x: `observe-c3d2022f1708.json` private 5/5, `observe-2258e25f2302.json` false-private 0/5; eight tabs compact `observe-cd70f8c6a0b6.json` 0/5, `observe-2b2934df8283.json` 5/5; separate `observe-b49ea1a6dedd.json` 5/5, `observe-200f0ae53c41.json` 0/5; badge 31-34 px in the 41 px band. Task 5: `toolbar-267e2480123c.json` bookmarks bar (owner: "yes" the bar was visible) host 20/20, private 20/20, false-private 0/20, addressLine 40/40, badge 72 of 82; owner's own Chrome, tab group + side panel + pinned extensions: `observe-732dc6d12b14.json` normal 5/5, false-private 0/5; `observe-fbebe0578832.json` private 5/5, badge 73-74 of 82; no band-rule change (E3 did not arise). Task 8, 2x: `accuracy-d6fdec16da23.json` and `toolbar-39912ad56508.json` (table above). O8 (owner "yes") added the per-line address rule; Chrome's omnibox satisfies it 40/40 (`toolbar-49b1f6b62fab.json`, `toolbar-267e2480123c.json`, `toolbar-39912ad56508.json`); "Not secure" measured exploratory (`toolbar-9d4af4de1f44.json`, `toolbar-2022c0133c3a.json`: host 40/40, addressLine 39/40) |
| 4 | The manual checklist is recorded | PARTLY. Done: locked screen (Session 4 Step 5: same helper, CPU +0.28 s in 2 min 50 s, `noWindow` 15, `locked` 0, no CAPTURE_OFF/ON pair; display sleep: `noWindow` 15, `failed` 0, `black` 0); grant revoked mid-run (Session 4 Step 4: "7 seconds", `PERMISSION_LOST` + `CAPTURE_OFF`, no `READER_PROBLEM`, no helper exit, reading resumed by itself on re-grant). PENDING, this morning: the owner's real VS Code (gutter check in a dedicated three-minute run), overlapping windows, second display (two displays are attached today), full-screen app (read and excluded), helper killed mid-read (`kill -9` x3, expect `READER_HELPER_EXIT` +3, no `READER_PROBLEM`) | Task 6 (Session 4 table above); Task 8 |
| 5 | `pnpm --dir app start:reader` reads the real screen end to end through the unchanged loop | DONE with the scripted model: statements produced end to end on protocol 2 against real titles (2026-09-20: 144 productive cycles; 2026-09-21 in-app control: normal Safari kept 41, private Safari kept 0 / notKept 42, owner: "there was only one statement before and after"; 2026-09-22 morning run kept 387). The real MODEL once with `start:reader` (owner present) has NOT been run in this plan; the spec's wording is `pnpm --dir app start`, the plan's is `start:reader` | Task 2 Step 2; Task 4 Step 3; Session 5 tallies |
| 6 | The helper's memory after 1,000 reads is recorded | PENDING (Task 7 sampling is running; 3-4 h instead of 6 by the owner's time). So far: the morning run's tallies give ~697 reads that reached a helper and answered (kept 387 + unchanged 230 + notKept 71 + empty 8 + black 1; `windowChanged` not listed in that line), spread over two helper processes (58088, then 71387 from between 09:54 and 10:04). RSS samples: 58088 66,720 KB (09:44) -> 43,792 KB (09:54); 71387 33,424 KB (10:04) -> 101,280 KB (10:14). Earlier single-process figures: 2026-09-20 22 MB after ~11 min; 2026-09-21 92 -> 82 MB over 13.2 min, 93 MB at the end of the day; C-2a 71 MB after 5 min -> 85 MB after 3 h. Whether the planned restart (500 reads / 6 h, `READER_HELPER_REPLACED` seen 6 times in real use) bounds it: not yet read off one sampled process | Task 7; `session3/task7-samples.txt` |
| 7 | The Developer ID re-check is listed in `docs/HANDOFF.md` as carried to packaging | DONE (confirmed 2026-09-22) | `docs/HANDOFF.md` line 121: "Carried to packaging: repeat P1, P2 and P6 under a real Developer ID." |

Open beside the seven items, for the acceptance sentence in HANDOFF: S1-F1's cause (one `READER_PROBLEM`
on 2026-09-20 with 5 `failed` in 165 cycles; the detail instrument has since named one `captureError` in
~900 cycles, and the 130 staged 2x reads of Task 8 showed none); S1-Q2 (a toggle leaving no log line on 2026-09-21 10:2x, not
reproduced since); the "address ROW" design item (O8's residual hole; one transient Safari compact miss;
one Chrome incognito line merge); Task 9 (browser names, owner decision); the owner looking at the
onboarding permission step rendered (the Home blocker surface he has seen; the onboarding step and the
nothing-read line he has not); D16; Cmd+Q once not quitting the tray app (sub-project B's list).


### Filling the PENDING rows (2026-09-22, 11:50, owner's "end of day")

- Item 2: `pnpm --dir app test` 2990 passed in 90 files; typecheck clean; `test:native` 251; `SMOKE OK` (app quit).
- Item 3's Task 9 gap: owner's choice "Not testable here (Recommended)": no third browser installed; what it takes: install one he approves, two minutes in front, `denied` grows and `kept` does not. Safari at 2x is now measured: `observe-52cfaebdb27e.json`, private 5/5, badge bottom 67 px in an 82 px band (41 pt x 2).
- Item 4, the remaining manual checks: full-screen read app on the second display (in-app, VS Code on the Retina display): `kept` 30, `failed` 0, PASS; helper `kill -9` three times a minute apart (10:52-10:54): `READER_HELPER_EXIT` 1 -> 4, a fresh helper within 8 s each time, no `READER_PROBLEM`, the run went on (`kept` 169), PASS; VS Code gutter check and the "overlapping windows" content judgement: NOT TESTABLE with the scripted model (fixed statements, duplicates not added), need the real model; excluded app in full screen: NOT DONE (the app's own window cannot go full screen; what it takes: exclude an ordinary app in Settings and full-screen it).
- Item 6: about 1,170 reads through the app's helper on 2026-09-22 (625 kept, 445 unchanged, 91 not kept, 8 empty); helper RSS 27-101 MB over three helper processes, ending at 27 MB, no growth trend; the planned 500-read restart happened about 10:0x (`READER_HELPER_REPLACED`), the new helper starting at 33 MB. CPU: helper about 1.7 % of one core over 40 reading minutes (incl. idle cycles), app main about 0.2 %. `black` 1 and `failed` 1 (`captureError`) in about 1,200 cycles. `READER_NOTHING_TO_READ` never fired. Sampling covered the morning only (09:44-11:29 of reading), the owner's time; whether that stands in for the plan's six hours is his qualification to accept.
- Task 7 samples: `docs/superpowers/plans/2026-09-19-native-reader-c2b2-files/session3/task7-samples.txt`.

### Acceptance (2026-09-22, afternoon)

Owner, verbatim: "I accept both C qualifications". Both qualifications (Task 7 sampled a morning instead of six hours; Task 6 Step 6 machine sleep not testable with `SleepDisabled 1`) are accepted, and sub-project C is ACCEPTED. The named gaps listed above stay open as gaps; none was closed by this acceptance.
