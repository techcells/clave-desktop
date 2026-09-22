# Task 5 review — Client and link minors (the four C-1 inputs)

Reviewer: independent (N = 5). Scratch copy: `…/scratchpad/exec/rev-5/app` (node_modules symlinked; no pnpm
ever run against it). Every file of the topic was read in full and compared with
`…/scratchpad/exec/c2b1-backup/app`. Nothing under `/Users/sardorastanov/techcells/asset-to-evidence` was
modified; every mutated file was restored and proved byte-identical with `cmp` against the real `app/`.

Baseline in the copy: `src/main/reader` + `src/shell/readerLink.test.ts` + `src/main/imports.test.ts`
→ **6 files, 156 passed** (matches the dev report). With `src/shell/realReader.test.ts` → **7 files, 162
passed** (also matches). `tsc --noEmit` clean for both `tsconfig.json` and `tsconfig.renderer.json`.

---

## 1. Answers to the task's questions

### Q1. While a helper drains, can a NEW call reach it?

**No.** Every call obtains its helper from `usable()` (`readerClient.ts:267–272`), which only ever hands
back `current`. `drain()` takes the helper out of `current`/`replacement` **before** anything else
(`readerClient.ts:179–180`), so from the moment it drains it is unreachable. There is no interleaving
window either: `permission()`, `read()`, `frontWindow()` and `requestPermission()` all run
`usable()` → `ask()` synchronously, with no `await` in between, so no other call can observe a
half-drained state.

Verified by probe "a drained helper is never sent a new call and its exit is never counted"
(PASSES): after the drain, a `permission`, a `read` and a `frontWindow` add **zero** messages to the
drained helper's `received`.

### Q2. Can a drained helper's exit be counted towards giving up, or emit `HELPER_EXIT`?

**No.** `gone()` (`readerClient.ts:124–143`) only emits/counts inside `if (helper === replacement)` /
`else if (helper === current)`. A drained helper is neither, so its exit settles it and nothing else —
no `HELPER_EXIT`, no `noteExit()`, no `scheduleRestart()`. Same probe confirms it for a spontaneous
exit; the existing test at `readerClient.test.ts:303–319` confirms it for the kill-by-deadline path
(`events` is exactly `["HELPER_WEDGED"]`).

`HELPER_WEDGED` **is** still emitted for a draining helper (`readerClient.ts:304`, dev decision 3) and
that read settles as `timeout`, which `loop.ts:189` does count against the reader. That is correct:
the binary really did hang.

### Q3. Does `dispose()` during a drain leave no process and no timer?

**Correct, including with two helpers draining at once.** `dispose()` builds `live` from
`[current, replacement, ...retiring, ...draining]` (`readerClient.ts:431`) and awaits each one's
`onGone`. `retire()` clears any previous kill timer before setting a new one (`readerClient.ts:154–155`),
and `gone()` clears `startTimer`/`healthyTimer`/`killTimer` and removes the helper from both sets
(`readerClient.ts:127–129`).

Plan probe (iii) — two helpers draining simultaneously (a denied refresh firing again before the first
has gone), `exitOnInputClosed = false` — **PASSES**: after `dispose()` + the grace period, all three
fake processes are `killed` and `vi.getTimerCount()` is `0`.

### Q4. What is the most memory the splitter can hold for one line?

`HELPER_MAX_LINE_CHARS` (2,000,000 chars) **plus one stdout chunk**, because the cap is checked after
`held += text.slice(from)` (`readerLink.ts:68–74`) — i.e. ~4 MB of UTF-16 plus the decoded chunk string,
against `readline`'s unbounded growth. `finish()` compares `held.length + tail.length` *before*
concatenating (`readerLink.ts:49–53`), so the terminated-over-long path never builds the big string at
all. Probe "holds at most the cap plus the chunk that crossed it" (40 × 64 KiB chunks, no newline)
**PASSES**; `pending()` returns to 0 after the marker.

### Q5. Is the marker line refused by `parseLine` by construction, not by accident?

**By construction of the chosen prefix, pinned by a test — but nothing structural forbids changing it.**
`HELPER_OVERLONG_LINE = "!over-long line discarded"` (`readerLink.ts:12`); `parseLine` refuses it in the
`JSON.parse` try/catch at `protocol.ts:56`, because `!` cannot begin a JSON value. The two live in
different modules, so the guarantee rests on `readerLink.test.ts:136–138`
(`expect(parseLine(HELPER_OVERLONG_LINE)).toBeNull()`). That test does bite (mutation B2 fails it
indirectly; a direct edit of the constant to `{}` would fail it outright). Acceptable, and the comment
at `readerLink.ts:6–11` states the intent. Also good: the marker carries no fragment of what it
replaced, so an over-long line cannot leak screen text into its own rejection.

### Q6. After a mismatch, does ANY path spawn again before `dispose()`?

**YES — see Finding F1.** `start()` is blocked by `gaveUp` (`readerClient.ts:254`) and `onFocusChange`
is blocked by `mismatched` (`readerClient.ts:416`), but `maybePlanReplacement()`
(`readerClient.ts:259–264`) consults neither, and it is called from `usable()` on **every** call. Because
the mismatch branch sets `helper.retired = true` before `gone()` (`readerClient.ts:220–221`),
`postponeReplacement()` is skipped, so the planned restart stays permanently due and a new helper is
spawned per call. D14(d) ("a protocol mismatch is permanent for the life of the client") does not hold.

### Q7. Carried item 39 (the "61 helpers in five minutes" baseline)

Confirmed corrected, and the new numbers check out. The comment is at
`readerClient.test.ts:481–487`; `PIPELINE_TICK_MS = 10_000` (`src/main/constants.ts:13`) and
`engine.ts:430` is the caller, so "about 30 replacements — 31 helpers — in five minutes" at a fixed 5 s
interval is right (300 s / 10 s). `CLIENT_DENIED_REFRESH_MS`'s own comment
(`constants.ts:46–61`) never cited the five-minute figure, so "not changed" is right too.

### Q8. The `HelperLink` contract (A1) and the pre-registration buffer (A2)

The contract is at `protocol.ts:25–36` and is accurate about what the client actually does
(`launch()` registers both callbacks synchronously, `readerClient.ts:248–249`). Both production callers —
`realReader.ts:39` and `readerEval/main.ts:101` — create the link *inside* the spawn thunk and register in
the same turn, so `early` (`readerLink.ts:106`) can never fill in the product today; it is insurance only.
That insurance introduces a new hazard: see Finding F3.

---

## 2. Mutation table — every row of the developer's table re-run

Driver: `…/exec/rev-5/mutate.py` (exact-string replacement asserted to occur once, run, restore,
`filecmp` + `cmp` against the real repo). All eight bit, with exactly the tests the dev report names.

| # | Mutation | Result | Tests that failed |
|---|---|---|---|
| A | `readerLink.ts`: drop the pre-registration buffer | **BIT** | "delivers them, in order, the moment `onLine` is registered"; "holds a bounded number of them, keeping the first…" |
| A' | restore drop-oldest (`push` then `shift`) | **BIT** | "holds a bounded number of them, keeping the first…" |
| B1 | splitter: keep accumulating past the cap | **BIT** | "never buffers a line past the cap, and reports it exactly once" |
| B2 | splitter: never set `discarding` | **BIT** | "never buffers a line past the cap…"; "loses the call a helper answers with a line past the cap, and nothing else" (real pipe) |
| B3 | `chunk.toString("utf8")` instead of `StringDecoder` | **BIT** | "keeps a character whose bytes are split across two chunks" |
| C1 | cure path kills instead of draining | **BIT** | "restarts the helper once by itself…"; "lets a read that is already in flight finish…"; "a helper on its way out that never answers is killed…" |
| C2 | `drain`: leave the helper in service | **BIT** | "lets a read that is already in flight finish…"; "sends the helper on its way out nothing more…"; "a helper on its way out that never answers is killed…"; "dispose in the middle of the drain owns both helpers"; "lets the calls in flight finish on the helper being replaced…" |
| D | `onFocusChange`: drop `!mismatched` | **BIT** | "a mismatch is permanent: switching capture off and on again does not start the same binary again" |

**None did not bite.**

### The nine original C-1 probes, re-run against today's code

| Probe | Result | Tests that failed |
|---|---|---|
| T2.1 `frontWindow` answers `null` when down | **BIT** | 5, incl. "while waiting to restart there is no helper at all…" |
| T2.2 delete `if (cureTried) return "needsRestart";` | **BIT** | "restarts the helper once by itself…" |
| T2.3 focus from any helper | **BIT** | "focus events from a replacement that has not taken over are ignored"; "ignores focus events from a helper that is not ready" |
| T2.4 no try/catch around a focus subscriber | **BIT** | "tells every subscriber, survives one that throws…" |
| T3.1 promote under a call in flight | **BIT** | "after enough reads, warms a replacement up…"; "focus events from a replacement…" |
| T3.2 keep a superseded read's id | **BIT** | "a read that was superseded and never answered does not hold the swap up" |
| T3.3 give-up off by one | **BIT** | 4, incl. "gives up after five unplanned exits…" and "does not take the last working helper away after the supervisor has given up" |
| T3.4 mismatch counted as a crash | **BIT** | "never uses a helper that speaks another protocol…"; "a mismatch is permanent…" |
| T3.5 a four-second start deadline | **BIT** | 5, incl. "allows a cold start of a minute and a half…" |

All nine still bite. Files restored and byte-compared after each row.

---

## 3. Independent probes (the plan's three, plus five of my own)

Probe file kept at `…/scratchpad/exec/rev-5/rev5Probes.test.ts` (copy to
`<copy>/app/src/shell/rev5Probes.test.ts` to run; it was deleted from the copy afterwards and every
topic file re-verified byte-identical). Result: **7 passed, 3 failed** — the three failures are
findings F1–F3.

| Probe | Result |
|---|---|
| (i) lone `\r` at a chunk end, `\n` at the next chunk's start | **PASS** — one line, no empty line |
| (ii) over-long line then EOF at once | **PASS** — one marker, no crash, splitter usable afterwards |
| (iii) two helpers draining at once, `dispose()` ends both | **PASS** — both killed, `vi.getTimerCount() === 0` |
| mine: no new call reaches a drained helper; its exit is never counted | **PASS** |
| mine: draining the same helper twice | **PASS** (no leak) — two `shutdown`s and one kill timer; see Minor M1 |
| mine: splitter memory bound over 40 chunks | **PASS** |
| mine: mismatch announced by a *planned replacement* | **FAIL → F1** — 5 later calls spawned 5 helpers, 6 `HELPER_PROTOCOL_MISMATCH` events |
| mine: `refused` cure after the supervisor has given up | **FAIL → F2** — state `gaveUp`, last working helper gone |
| mine: a link that flushes buffered lines inside `onLine()` | **FAIL → F3** — state `starting` for ever, `frontWindow()` returns `null` for ever |

---

## 4. Findings

### F1 — Important. A protocol mismatch is NOT permanent: the planned restart spawns the same binary again, once per call

`src/main/reader/readerClient.ts:259–264` (`maybePlanReplacement`), reached from `usable()`
(`readerClient.ts:270`), together with `readerClient.ts:214–222` (the mismatch branch).

D14(d) and the declaration comment at `readerClient.ts:60–67` say a mismatch is permanent "for the life
of the client", and estimate the cost of getting it wrong as "a process spawn and a Vision warm-up per
subscription". The new `mismatched` flag is consulted in exactly one place — `onFocusChange`
(`readerClient.ts:416`) — and `start()` is held by `gaveUp`. `maybePlanReplacement()` is held by
**neither**. So when the mismatching helper is a *planned replacement* rather than the first helper:

- `gone()` takes the `replacement` branch, `current` survives and keeps serving, `gaveUp`/`mismatched`
  are set but `state()` is still `"ready"`;
- because the mismatch branch sets `helper.retired = true` first, `postponeReplacement()` is skipped
  (`readerClient.ts:135`), so `current.readyAt`/`current.reads` are untouched and the planned restart is
  immediately due again;
- every subsequent `usable()` — i.e. every `permission()`, `read()` and `frontWindow()` — launches
  another helper, which announces the same stale protocol and is killed.

This is exactly the scenario the decision was written for (dev decision 4: "a user who replaces the
helper binary under a running app — dev builds do exactly this"). In the product `permission()` is
called on the engine's 10 s tick (`src/main/constants.ts:13`, `engine.ts:430`), so this is a real
`clave-reader` spawn plus a Vision warm-up every 10 s, indefinitely, each one SIGKILLed — and one
`HELPER_PROTOCOL_MISMATCH` per spawn in the log.

The shape of the hole predates C-2b-1, but D14(d) is this task's own decision and its fix is incomplete.

**Reproducing probe:** "a mismatch announced by a planned replacement is not permanent: every later call
spawns another". Observed `helpers spawned by 5 later calls = 5, mismatch events = 6`; the probe asserts
`helpers.all.length` is unchanged.

**Suggested fix:** guard the spawn, not just the revival — in `maybePlanReplacement`, change
`if (!current || !current.ready || replacement) return;` to
`if (mismatched || !current || !current.ready || replacement) return;`. (Guarding on `gaveUp` there
would also stop planned restarts during a recoverable give-up, which may be wanted too, but `mismatched`
is the minimal change that makes D14(d) true.) Add a test alongside "a mismatch is permanent…" in
`readerClient.supervision.test.ts` that drives the mismatch through the *replacement* path.

---

### F2 — Important. The `refused` cure has no `gaveUp` guard, so it can take the last working helper away for good

`src/main/reader/readerClient.ts:351–357`.

The denied-refresh branch guards its drain with `!gaveUp` (`readerClient.ts:341`) and explains why in
`readerClient.ts:335–338`: "`start()` would refuse to launch the replacement and this would take the
last working helper away, leaving `permission()` answering `unknown` for good — with nothing on screen,
because giving up is only logged." There is a dedicated test for it
(`readerClient.test.ts:530–572`).

The cure path immediately below has no such guard. When the supervisor has already given up while a
helper is still serving (five counted exits with a warm replacement taking over — the state the C-1
re-review reached, and the exact state that test constructs), one `refused` answer calls `drain(helper)`;
`drain` sets `current = replacement` (null), `retire`s the helper and calls `start()`, which returns at
once because `gaveUp` is true. The client drops to `state() === "gaveUp"` with no process at all, and
`permission()` answers `unknown` for ever with nothing on screen.

This shape also predates C-2b-1 (the old code did `helper.retired = true; gone(helper, true); start();`,
with the same result), but Task 5 rewrote this exact block and left the asymmetry.

**Reproducing probe:** "the refused cure does not take the last working helper away after the supervisor
has given up". Observed `state = gaveUp, helpers = 6 (was 6)`; the probe asserts `state() === "ready"`.

**Suggested fix:** mirror the denied branch —

```ts
if (cureTried || gaveUp) return "needsRestart";
```

or, if `needsRestart` is the wrong answer while given up, `if (gaveUp) return "unknown";` before the
cure. Either way add the twin of `readerClient.test.ts:530` for the `refused` path.

---

### F3 — Minor (latent, created by A2). The client is not robust against a link that flushes its buffer inside `onLine()`

`src/shell/readerLink.ts:126` (`onLine(cb) { sink = cb; for (const line of early.splice(0)) cb(line); }`)
against `src/main/reader/readerClient.ts:240–251` (`launch`).

The new pre-registration buffer delivers its held lines **synchronously, from inside `onLine()`**. In
`launch()`, `link.onLine(...)` (line 248) runs *before* `link.onExit(...)` (line 249) and before the
caller has assigned the returned helper to `current` or `replacement` (`start()` line 255,
`maybePlanReplacement()` line 262). So a flushed `ready` line is processed against a helper the client
does not yet know about:

- a **mismatching** `ready` calls `gone(helper, true)` while the helper is neither `current` nor
  `replacement`, so nothing is recorded and no restart is scheduled; `start()` then assigns the already
  dead helper to `current`. The client is stuck in `state() === "starting"` for ever, with **no timers**,
  **no further spawn**, and `frontWindow()` answering `null` for ever — so the capture loop never counts
  a failure (`loop.ts:189`) and a completely dead reader never surfaces as a reader problem;
- the good-protocol case survives (the helper is simply `ready` on return) but is promoted without
  `HELPER_REPLACED` when it is a replacement, and `tryPromote()` is not re-run until the next line.

Not reachable in the product today: `realReader.ts:39` and `readerEval/main.ts:101` both build the link
inside the spawn thunk and register in the same turn, so `early` is always empty. But A2 exists precisely
to cover a link that does not, and `protocol.ts:33–35` advertises the buffer as making a link "robust
even against a client that breaks its half" — while the client is not robust against the link that does
the buffering.

**Reproducing probe:** "a mismatching `ready` flushed at registration leaves the client wedged in
`starting`". Observed `state = starting, events = ["HELPER_PROTOCOL_MISMATCH"], timers = 0, spawned = 1,
frontWindow = null`; the probe asserts `state() === "gaveUp"`.

**Suggested fix (either):** (a) flush the buffer on a microtask —
`onLine(cb) { const held = early.splice(0); sink = cb; if (held.length) queueMicrotask(() => { for (const line of held) cb(line); }); }`
— which restores the "no line before `spawn()` returns" invariant the client is written against; or
(b) make `launch()` tolerant: register `link.onExit` before `link.onLine`, and have `start()` /
`maybePlanReplacement()` assign the slot before the callbacks are attached. Whichever is chosen, state
the invariant in the `HelperLink` doc, because right now nothing records that a link must not call the
sink re-entrantly from `onLine`.

---

### Minors

- **M1** `readerClient.ts:178–184`. Two `permission()` calls in flight on the same helper, both answered
  `denied` on a helper older than the doubled interval, call `drain()` on it **twice**: it is retired
  twice (two `shutdown` messages, the kill timer restarted so the grace period is extended by up to
  1 s) and `deniedRefreshMs` doubles twice for one replacement. Nothing leaks — `retire` clears the
  previous kill timer (`readerClient.ts:154`) — and the probe "draining the same helper twice leaves
  exactly one kill timer" pins it. A one-line `if (helper.gone || helper.retired) return;` at the top of
  `drain` would make it idempotent.
- **M2** `readerClient.ts:145–156`. `retire()` clears `killTimer` but not `healthyTimer`, so a retired
  helper's healthy timer can still fire during the grace window and reset `backoff`. Bounded by the kill
  timer and harmless (it only makes the backoff more optimistic), but inconsistent with the care taken
  over the kill timer.
- **M3** `readerLink.ts:60–75` vs the old `createInterface({crlfDelay: Infinity})`. `readline` also split
  on a **lone** `\r`; the splitter does not (only `\n` ends a line, and one trailing `\r` is stripped).
  Harmless — `JSON.stringify` escapes `\r` — but it is an undocumented behaviour change from the file
  this replaced.
- **M4** Dev-report accuracy: the report's "Not changed: `src/main/testing/fakeReaderHelper.ts`" is wrong
  as stated — that file *did* change (`lastRead()`, and `ready()`'s default moved from the literal `1`
  to `READER_PROTOCOL`). It was changed by topic 1, which shares the file; the sentence should say so,
  because several of topic 5's own tests (`readerClient.test.ts:100–110`) depend on `lastRead()`.
- **M5** `readerLink.ts:111`. `child.stdout` has no `error` listener (neither did the readline version),
  so a stream error on stdout would be an unhandled `error` event in main. Pre-existing, out of scope,
  recorded because this change rewrote the stdout wiring.

### Checked and clean (no finding)

- A drained helper's pending map can only empty through `onLine` (answer or unreadable line), both of
  which call `leaveIfDrained` (`readerClient.ts:210, 236`), or through `gone()`, which removes it from
  `draining` (`readerClient.ts:128`). Every pending call carries a deadline timer (`readerClient.ts:296`),
  so a draining helper can never be retained indefinitely: `draining` is bounded and self-emptying.
- `read()`'s supersede loop (`readerClient.ts:393–399`) only ever touches `current`, so it cannot settle
  a draining helper's calls behind `leaveIfDrained`'s back.
- During the gap between a drain and its successor becoming ready, `read()` answers `failed` (which the
  loop counts). In practice the loop reaches `read` only after a successful `frontWindow`, and
  `frontWindow` answers `null` while `starting()` (`readerClient.ts:377`), so the gap is not charged.
- `dispose()` re-`retire`s helpers already in `retiring`/`draining` without orphaning a timer; two
  concurrent drains plus a fresh helper all end at 0 timers (probe iii).
- The leak test (`readerClient.leak.test.ts`) still covers protocol 2's new payload: the approved title
  is asserted to reach the helper's stdin and nothing else, and the marker line carries no screen text.

---

## 5. Verdict

**CHANGES REQUIRED** — two Important findings (F1, F2), both in `readerClient.ts`, both reachable, both
with a one-line fix and a missing test. The developer's own eight mutations and all nine original C-1
probes bite, the three plan probes pass, the splitter and the drain state machine are otherwise sound,
and nothing in this topic leaks screen text or a window title.

Spec compliance: ❌ (D14(d) "a protocol mismatch is permanent for the life of the client" does not hold —
F1; the spec note planned for section 4 in Task 10 would be untrue as written.)

Quality: Not approved
