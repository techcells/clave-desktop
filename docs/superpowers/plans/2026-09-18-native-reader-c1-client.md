# Native Reader C-1 (TypeScript Reader Client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the main-process half of the native reader: a supervised `ReaderClient` that implements the existing `Reader` port over a JSON-lines helper process, fully tested against a scripted helper, with no native code and no downloads.

**Architecture:** `app/src/main/reader/` holds the line protocol (`protocol.ts`), the numbers (`constants.ts`) and the client (`readerClient.ts`), which owns the request table, the deadlines, re-entry, the helper's lifecycle (start deadline, backoff, give-up, planned restart with a warm replacement) and the permission episode logic. It reaches the process only through a `HelperLink` port, as `model/client.ts` reaches its host through `HostLink`. `app/src/shell/readerLink.ts` is the real link over `child_process`. Nothing is wired into `app.ts` yet: that, the Rust helper and `reader:eval` are plan C-2.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.1, zod 4.6.5 (already installed; used only through the port's existing parsers), Node `child_process` and `readline`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-native-reader-design.md` — sections 3 (protocol), 4 (re-entry, deadlines, supervision, focus subscribers, and its phase-0 note), 5.3 (permission), 7 (TypeScript test layer), 10.1 items 2, 7, 12. Findings: `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`.

## Global Constraints

- NO git at all: no init, commit, branch, push. Tasks end with a "Checkpoint" step instead.
- Never `cd`. Run project scripts from the repo root as `pnpm --dir app <script>`.
- No downloads or installs. This plan needs none; if a step seems to need one, stop and report.
- Every code block labelled with a path is the COMPLETE file. It was run before this plan was written (see "Verification record"). Create each file by extracting the block from your task brief with a script and byte-compare — never retype: the files contain the characters `✓`, `í`, `→` and typographic punctuation, and cheap models have corrupted such characters in this repo before. After each task run `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-18-native-reader-c1-client.md <task number>` and expect `mismatches: 0`.
- Do not modify any existing file. This plan only ADDS files. In particular do not touch `app/src/main/ports/reader.ts`, `app/src/main/capture/loop.ts`, `app/src/main/constants.ts`, `app/src/main/log.ts`, `app/src/shell/app.ts`. (Never re-extract an older plan's code blocks over the code: the executed plans no longer match their documents.)
- `app/src/main/imports.test.ts` applies to the new files under `app/src/main/`: no import of `electron`, `vitest`, `standins` or `/testing/` from production files, and no `console.` anywhere in them.
- The client logs nothing and writes nothing. Its only side channel is `onEvent`, which carries one bare code from a closed set. Recognised text and window titles travel only in the values returned to the caller.
- Exact values (from the spec and phase 0): protocol number 1; client deadlines 4 s for calls and budget + 4 s for `read` (inside main's 5 s and budget + 5 s); start deadline 90 s (a cold start was measured at about 45 s); backoff 0.5 s doubling to 30 s, reset after 60 s ready; give up after 5 unplanned exits in 10 minutes; planned restart after 500 reads or 6 hours; shutdown grace 1 s.
- Each task is reviewed independently with reproducing probes before the next begins. The mutation probes listed in Tasks 2 and 3 are the minimum: the reviewer applies each one to a scratch copy, confirms the stated tests fail, and restores the file.
- When the plan is finished: `pnpm --dir app test` reports 835 passed (768 existing + 61 new + 6 more cases of `imports.test.ts`, which runs two checks per production file under `app/src/main/` and now sees three more files) and `pnpm --dir app typecheck` is clean.

## Decisions this plan makes (flag any you disagree with before execution)

| # | Decision | Why |
|---|---|---|
| D1 | Calls that arrive before the helper says `ready` are answered at once, not held: `permission()` → `unknown`, `frontWindow()` → `null`, `read()` → `failed`, `requestPermission()` → resolves. | Spec 10.1 item 2 left this open under one constraint: a cold start (about 45 s) must not trip the loop's failure window. The loop starts every cycle with `frontWindow()`, and `null` is "no window", which it does not count. Holding calls would run into main's 5 s timeout and count as failures. |
| D2 | With NO helper (waiting for a backoff, given up, disposed) `frontWindow()` rejects with `ReaderDown`. | Only a rejection reaches the loop's failure count, so only a rejection lets a reader that is down for good surface through `onReaderProblem` (spec section 4, "helper down"). |
| D3 | The planned restart warms a replacement up while the old helper keeps serving, and swaps only when no call is in flight. A replacement that dies counts as an exit and puts the next attempt off by a full period. | Spec 10.1 item 2. About 120 MB for the overlap instead of 60 MB. |
| D4 | The helper answers `permission` with `granted`, `denied` or `refused` (check says yes, last capture refused). The client turns `refused` into one automatic helper restart (answering `unknown` meanwhile) and, if the next helper is refused too, into `needsRestart`. A good read ends the episode. | Spec 5.3: "what works outranks what the check says", one automatic restart. `needsRestart` is never the helper's to say. |
| D5 | After giving up, a NEW `onFocusChange` subscription revives the supervisor. | Spec: "until capture is switched off and on again". The loop subscribes on every `start()`; the port has no other signal. |
| D6 | One unreadable line fails every call in flight on that helper but does not kill it. A protocol mismatch stops the supervisor without counting as a crash. | A stray line must not cause a restart loop; restarting the same binary cannot cure a mismatch. |
| D7 | New numbers live in `app/src/main/reader/constants.ts`, not in the hardened `app/src/main/constants.ts`; events go to an injected `onEvent`, not to `log.ts`. | This plan adds files only. C-2 maps events to log codes when it wires the reader in. |
| D8 | A superseded read is settled as `timeout` and its id is forgotten; ids are never reused across helpers. | Spec section 4: an earlier frame can never answer a later call. |
| D9 | `{window: null}` is "no window"; a window that is present but does not parse makes `frontWindow()` REJECT. (Added 2026-09-18 after the Task 1–5 review, finding I1; the first version answered `null`.) | A helper with a broken window shape would otherwise yield `noWindow` forever, which the loop never counts, and capture would sit "on" reading nothing. |
| D10 | A read budget is capped at `CLIENT_MAX_READ_BUDGET_MS` (60 s). (Added after review, M1.) | `setTimeout` treats more than 2³¹−1 ms as 1 ms: an absurd budget timed the read out at once and killed a healthy helper. |
| D11 | A replacement that dies while warming up is reported (`HELPER_EXIT`) but not counted towards giving up. (Added after review, M4.) | It served nobody; counting it could set "gave up" while a healthy helper was still serving. |

## File Structure

| Path | Responsibility |
|---|---|
| `app/src/main/reader/constants.ts` | Every number of the client, with its reason |
| `app/src/main/reader/protocol.ts` | Message types, `HelperLink` port, `encode`, `parseLine`, `parseHelperPermission` |
| `app/src/main/reader/protocol.test.ts` | What is accepted and refused on the wire |
| `app/src/main/testing/fakeReaderHelper.ts` | A scripted helper for tests, driven by hand |
| `app/src/main/reader/readerClient.ts` | The `Reader` port over a supervised helper |
| `app/src/main/reader/readerClient.test.ts` | Calls, re-entry, deadlines, permission episodes, focus, dispose |
| `app/src/main/reader/readerClient.supervision.test.ts` | Exits, backoff, give-up and revival, start deadline, protocol mismatch, planned restart |
| `app/src/main/reader/readerClient.leak.test.ts` | Nothing read from a screen leaves through a side channel |
| `app/src/shell/readerLink.ts` | `HelperLink` over a real child process |
| `app/src/shell/testing/fakeHelperProcess.mjs` | A scripted helper as a real process |
| `app/src/shell/readerLink.test.ts` | The client end to end over a real pipe |

---

### Task 1: The line protocol

**Files:**
- Create: `app/src/main/reader/constants.ts`
- Create: `app/src/main/reader/protocol.ts`
- Test: `app/src/main/reader/protocol.test.ts`

**Interfaces:**
- Produces: `READER_PROTOCOL`, `CLIENT_CALL_DEADLINE_MS`, `CLIENT_READ_GRACE_MS`, `CLIENT_MAX_READ_BUDGET_MS`, `HELPER_START_DEADLINE_MS`, `HELPER_BACKOFF_FIRST_MS`, `HELPER_BACKOFF_MAX_MS`, `HELPER_HEALTHY_AFTER_MS`, `HELPER_EXIT_LIMIT`, `HELPER_EXIT_WINDOW_MS`, `HELPER_PLANNED_RESTART_READS`, `HELPER_PLANNED_RESTART_MS`, `HELPER_SHUTDOWN_GRACE_MS`, `HELPER_MAX_LINE_CHARS`; types `ToHelper`, `FromHelper`, `HelperPermission`, `HelperLink {send(line), onLine(cb), onExit(cb), closeInput(), kill()}`; functions `encode(message: ToHelper): string`, `parseLine(line: string): FromHelper | null`, `parseHelperPermission(body): HelperPermission | null`.

- [ ] **Step 1: Write the constants**

`app/src/main/reader/constants.ts`:
```ts
/**
 * The line protocol spoken with the native helper. A helper announcing another number is never used.
 *
 * 2 added three things to 1: `read` carries `expect`, the window main approved, and the helper
 * refuses to capture anything else; `windowGone` as a read failure reason distinct from `failed`;
 * and a numbers-only `stats` object on `ok` and `black` answers, which the port's parser strips.
 *
 * Why the number moved, when `windowGone` alone did not justify it: `expect` is a privacy rule, and
 * a rule only holds if both sides keep it. A helper that does not enforce `expect` still captures
 * and recognises whatever is in front and sends main the text — exactly the leak this closes —
 * while looking, from main's side, like a helper that works. So main must be able to refuse it, and
 * this number is the only thing it can refuse on. That this is not theoretical was measured: the
 * development bundle ran for most of a day with a helper older than the app beside it.
 */
export const READER_PROTOCOL = 2;

/** The client's own deadlines sit inside main's (`READER_CALL_TIMEOUT_MS` 5 s, and 5 s on top of the read budget). */
export const CLIENT_CALL_DEADLINE_MS = 4_000;
export const CLIENT_READ_GRACE_MS = 4_000;
/** No read is ever given longer than this, whatever the caller asks for (and a timer cannot hold much more than 24 days). */
export const CLIENT_MAX_READ_BUDGET_MS = 60_000;

/**
 * How long a freshly started helper may take to say `ready`. The helper warms the recogniser up
 * first, and the first-ever recognition of a binary was measured at about 45 s (phase 0, P3).
 */
export const HELPER_START_DEADLINE_MS = 90_000;

export const HELPER_BACKOFF_FIRST_MS = 500;
export const HELPER_BACKOFF_MAX_MS = 30_000;
/** A helper that stayed ready this long resets the backoff. */
export const HELPER_HEALTHY_AFTER_MS = 60_000;

/** This many unplanned exits inside the window and the supervisor stops restarting. */
export const HELPER_EXIT_LIMIT = 5;
export const HELPER_EXIT_WINDOW_MS = 10 * 60_000;

/** Memory hygiene: replace the helper after this many reads or this much time, whichever comes first. */
export const HELPER_PLANNED_RESTART_READS = 500;
export const HELPER_PLANNED_RESTART_MS = 6 * 60 * 60_000;

/** After `shutdown` and closing its input, a helper gets this long before it is killed. */
export const HELPER_SHUTDOWN_GRACE_MS = 1_000;

/**
 * How long a helper may go on saying `denied` before it is replaced with a fresh one — the FIRST
 * time. The interval doubles after each replacement that is again answered `denied`, up to
 * `CLIENT_DENIED_REFRESH_MAX_MS`, and any other answer puts it back to this value.
 *
 * Measured in the first real run: `CGPreflightScreenCaptureAccess` is cached per process, and our
 * helper never attempts a capture while denied (unlike the phase-0 probe, which did and thereby
 * refreshed the cache). So the helper that was running when the owner switched Screen Recording on
 * kept answering `denied` until it was killed, while a helper started afterwards answered `granted`
 * at once. The cure is a fresh process, and the client is where it belongs: attempting a capture to
 * refresh the cache can raise a macOS prompt, which is not ours to raise.
 *
 * The age check is what keeps this from becoming a restart storm — somebody asks about permission
 * every second or two — so at most one replacement per interval while denied, and none at all once
 * the answer changes.
 */
export const CLIENT_DENIED_REFRESH_MS = 5_000;

/**
 * The longest the denied refresh ever waits.
 *
 * Why it backs off at all: the engine asks `permission()` every 10 s whatever else is happening,
 * including with capture off and the app idle in the tray. At a fixed 5 s that is a process spawn
 * plus a Vision warm-up every 10 s, for ever, on the machine of somebody who has simply declined —
 * roughly 1-5% of a core, indefinitely, to keep asking a question that has been answered. Doubling
 * turns "for ever" into a cost that fades: 5, 10, 20, 40, 60, 60 … so a user who never grants
 * settles at one replacement a minute.
 *
 * What it costs, stated honestly: the interval is only long after minutes of being denied, so the
 * common case — the user grants access while the onboarding screen is open, a minute or two in —
 * still notices within a few seconds. The bad case is real though: grant access after a long denied
 * stretch and the fresh helper may be up to 60 s away, plus the asker's own poll. Two things keep
 * that from biting: any non-`denied` answer resets the interval, and so do the two moments where the
 * user is plainly about to grant — pressing the button that calls `requestPermission()`, and
 * switching capture on, which subscribes to focus again.
 */
export const CLIENT_DENIED_REFRESH_MAX_MS = 60_000;

/** A longer line is not parsed at all. A full screen of text is a few tens of kilobytes. */
export const HELPER_MAX_LINE_CHARS = 2_000_000;
```

- [ ] **Step 2: Write the failing test**

`app/src/main/reader/protocol.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {HELPER_MAX_LINE_CHARS} from "./constants";
import {encode, parseHelperPermission, parseLine} from "./protocol";

describe("reader protocol: what main sends", () => {
  it("encodes each message as one line of JSON", () => {
    expect(encode({id: 3, op: "read", budgetMs: 1500, expect: {app: "Code", title: "query.sql"}}))
      .toBe('{"id":3,"op":"read","budgetMs":1500,"expect":{"app":"Code","title":"query.sql"}}');
    expect(encode({op: "cancel", target: 2})).toBe('{"op":"cancel","target":2}');
    expect(encode({op: "shutdown"})).not.toContain("\n");
  });

  it("a read carries the window main approved, bundle id and all", () => {
    const expected = {app: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs"};
    expect(encode({id: 3, op: "read", budgetMs: 1500, expect: expected}))
      .toBe('{"id":3,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Docs"}}');
  });
});

describe("reader protocol: what the helper may send", () => {
  it("reads the two events", () => {
    expect(parseLine('{"event":"ready","protocol":2}')).toEqual({kind: "ready", protocol: 2});
    expect(parseLine('{"event":"focus"}')).toEqual({kind: "focus"});
  });

  it("splits an answer into its id and everything else", () => {
    expect(parseLine('{"id":7,"permission":"granted"}')).toEqual({kind: "answer", id: 7, body: {permission: "granted"}});
    expect(parseLine('{"id":0,"window":null}')).toEqual({kind: "answer", id: 0, body: {window: null}});
  });

  it.each([
    ["not JSON", "ready"],
    ["an array", "[1]"],
    ["a bare string", '"focus"'],
    ["null", "null"],
    ["an unknown event", '{"event":"moved"}'],
    ["ready without a protocol number", '{"event":"ready"}'],
    ["ready with a fractional protocol", '{"event":"ready","protocol":1.5}'],
    ["an answer without an id", '{"permission":"granted"}'],
    ["a negative id", '{"id":-1}'],
    ["a string id", '{"id":"7"}'],
    ["an id too large to be exact", '{"id":9007199254740993}']
  ])("refuses %s", (_name, line) => {
    expect(parseLine(line)).toBeNull();
  });

  it("an event wins over an id, so an event can never be mistaken for an answer", () => {
    expect(parseLine('{"event":"focus","id":1}')).toEqual({kind: "focus"});
  });

  it("does not even parse a line that is too long", () => {
    const line = `{"id":1,"text":"${"a".repeat(HELPER_MAX_LINE_CHARS)}"}`;
    expect(parseLine(line)).toBeNull();
  });
});

describe("reader protocol: the helper's permission answer", () => {
  it("knows three values and nothing else", () => {
    expect(parseHelperPermission({permission: "granted"})).toBe("granted");
    expect(parseHelperPermission({permission: "denied"})).toBe("denied");
    expect(parseHelperPermission({permission: "refused"})).toBe("refused");
    expect(parseHelperPermission({permission: "needsRestart"})).toBeNull();
    expect(parseHelperPermission({permission: 1})).toBeNull();
    expect(parseHelperPermission({})).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --dir app test src/main/reader/protocol.test.ts`
Expected: FAIL — cannot resolve `./protocol`.

- [ ] **Step 4: Write the protocol**

`app/src/main/reader/protocol.ts`:
```ts
import type {FrontWindow} from "../../core/types";
import {HELPER_MAX_LINE_CHARS} from "./constants";

/** One JSON object per line, in both directions. */
export type ToHelper =
  | {id: number; op: "permission" | "requestPermission" | "frontWindow"}
  /** `expect` is the window main approved, and the only one the helper may capture (protocol 2). */
  | {id: number; op: "read"; budgetMs: number; expect: FrontWindow}
  | {op: "cancel"; target: number}
  | {op: "shutdown"};

export type FromHelper =
  | {kind: "ready"; protocol: number}
  | {kind: "focus"}
  /** `body` is everything the helper sent except `id`. It is NOT validated here: the caller knows which call it answers. */
  | {kind: "answer"; id: number; body: Record<string, unknown>};

/**
 * What the helper says about the permission. `refused` means the system check says yes while the
 * last capture was refused; turning that into the port's `needsRestart` is the client's business.
 */
export type HelperPermission = "granted" | "denied" | "refused";
const HELPER_PERMISSIONS: readonly string[] = ["granted", "denied", "refused"];

/**
 * The process on the other side of the pipe. The shell provides the real one; tests provide a fake.
 *
 * The client registers `onLine` and `onExit` synchronously — in the same turn in which `spawn()`
 * returns, before it awaits anything — and registers each of them exactly once. In return a link
 * MUST deliver every line the helper wrote, from its very first byte, to whichever callback is
 * registered: a link that only begins reading when `onLine` is called drops whatever the helper
 * said before that. The line at risk is `ready`, the first thing a helper sends, and losing it costs
 * the whole start deadline (90 s) and then a kill, for a helper that was up all along. Both halves
 * of this are held up by tests: the client's, in `readerClient.test.ts`, and the real link's, which
 * buffers early lines so that a link is robust even against a client that breaks its half.
 *
 * A link MUST NOT call the `onLine` sink from inside `onLine`: lines it was holding are delivered on
 * a later turn, in order, and ahead of any line that arrives meanwhile. `onLine` is registered while
 * the client is still starting the helper, so a line handed straight back would be handled against a
 * helper that is not yet in its place. The client survives that now (see `launch` in
 * `readerClient.ts`), but keeping it from arising at all is the link's half.
 */
export interface HelperLink {
  /** `line` has no trailing newline. Must not throw once the helper is gone. */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** Called at most once, however the helper went away. */
  onExit(cb: () => void): void;
  /** Closes the helper's input; a well-behaved helper exits on that. */
  closeInput(): void;
  kill(): void;
}

export function encode(message: ToHelper): string {
  return JSON.stringify(message);
}

/**
 * The helper is another process: anything that is not exactly one of its three message kinds is `null`.
 *
 * The id bound, stated here because it is an agreement two languages have to keep (D13): an id is a
 * non-negative integer no larger than `Number.MAX_SAFE_INTEGER` (2^53 − 1), which is the largest one
 * `JSON.parse` returns unchanged. `Number.isSafeInteger` below is that rule on this side. The helper
 * holds the same line from the other direction — Rust would happily accept and echo any `u64` — so an
 * `id` or a `cancel` `target` above the bound is ignored there rather than answered, and a `budgetMs`
 * above it is read as 0, which its scheduler takes as "no deadline of my own" (see `MAX_SAFE_INTEGER`
 * in `native/reader/src/protocol.rs`). Unreachable in the product: the client counts its own ids up
 * from 0, one per call.
 */
export function parseLine(line: string): FromHelper | null {
  if (line.length > HELPER_MAX_LINE_CHARS) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ("event" in record) {
    if (record.event === "focus") return {kind: "focus"};
    if (record.event === "ready" && Number.isSafeInteger(record.protocol)) return {kind: "ready", protocol: record.protocol as number};
    return null;
  }
  if (!Number.isSafeInteger(record.id) || (record.id as number) < 0) return null;
  const {id, ...body} = record;
  return {kind: "answer", id: id as number, body};
}

export function parseHelperPermission(body: Record<string, unknown>): HelperPermission | null {
  return typeof body.permission === "string" && HELPER_PERMISSIONS.includes(body.permission) ? (body.permission as HelperPermission) : null;
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --dir app test src/main/reader/protocol.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Checkpoint**

Run `pnpm --dir app typecheck` (clean) and `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-18-native-reader-c1-client.md 1` (`mismatches: 0`).

---

### Task 2: The reader client

**Files:**
- Create: `app/src/main/testing/fakeReaderHelper.ts`
- Create: `app/src/main/reader/readerClient.ts`
- Test: `app/src/main/reader/readerClient.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces; from `app/src/main/ports/reader.ts`: `Reader`, `Permission`, `ReadResult`, `parseFrontWindow`, `parseReadResult`; from `app/src/main/ports/system.ts`: `Now`; from `app/src/core/types.ts`: `FrontWindow`.
- Produces: `createReaderClient(deps: {spawn: () => HelperLink; now: Now; onEvent?: (event: ReaderClientEvent) => void}): ReaderClient`; `ReaderClient extends Reader { state(): ReaderClientState }`; `ReaderClientState = "idle" | "starting" | "ready" | "waiting" | "gaveUp" | "disposed"`; `ReaderClientEvent = "HELPER_EXIT" | "HELPER_START_TIMEOUT" | "HELPER_WEDGED" | "HELPER_PROTOCOL_MISMATCH" | "HELPER_GAVE_UP" | "HELPER_REPLACED"`; `class ReaderDown extends Error` (message `READER_DOWN`). For tests: `createFakeHelpers(): FakeHelpers` with `spawn`, `all`, `latest()`, `failNextSpawn`, `exitOnInputClosed`, and per helper `received`, `killed`, `inputClosed`, `emit`, `emitRaw`, `ready(protocol?)`, `answerLast(body)`, `lastId()`, `exit()`, `exited()`.

- [ ] **Step 1: Write the scripted helper the tests drive**

`app/src/main/testing/fakeReaderHelper.ts`:
```ts
import type {FrontWindow} from "../../core/types";
import {READER_PROTOCOL} from "../reader/constants";
import type {HelperLink, ToHelper} from "../reader/protocol";

/** One scripted helper process. Tests drive it by hand: nothing is answered unless the test says so. */
export interface FakeHelper {
  /** Every message main sent to this helper, decoded, in order. */
  received: ToHelper[];
  killed: boolean;
  inputClosed: boolean;
  /** Sends one message as a line. */
  emit(message: Record<string, unknown>): void;
  /** Sends a raw line, for malformed input. */
  emitRaw(line: string): void;
  ready(protocol?: number): void;
  /** Answers the most recent message that carried an id. */
  answerLast(body: Record<string, unknown>): void;
  /** The id of the most recent message that carried one. */
  lastId(): number;
  /** The most recent `read`, so a test can see the window main said it had approved. */
  lastRead(): {id: number; op: "read"; budgetMs: number; expect: FrontWindow};
  /** The helper goes away on its own, as in a crash. */
  exit(): void;
  exited(): boolean;
}

export interface FakeHelpers {
  spawn(): HelperLink;
  /** Every helper ever started, oldest first. */
  all: FakeHelper[];
  /** The most recently started helper. */
  latest(): FakeHelper;
  /** When set, the next `spawn()` throws, as when the binary is missing. */
  failNextSpawn: boolean;
  /** When true (the default) a well-behaved helper exits as soon as its input is closed. */
  exitOnInputClosed: boolean;
}

export function createFakeHelpers(): FakeHelpers {
  const helpers: FakeHelpers = {
    all: [], failNextSpawn: false, exitOnInputClosed: true,
    latest() {
      const last = helpers.all[helpers.all.length - 1];
      if (!last) throw new Error("no helper was started");
      return last;
    },
    spawn() {
      if (helpers.failNextSpawn) { helpers.failNextSpawn = false; throw new Error("SPAWN_FAILED"); }
      let onLine: (line: string) => void = () => undefined;
      let onExit: (() => void) | null = null;
      let gone = false;
      const leave = (): void => { if (gone) return; gone = true; const cb = onExit; onExit = null; cb?.(); };
      const helper: FakeHelper = {
        received: [], killed: false, inputClosed: false,
        emitRaw(line) { if (!gone) onLine(line); },
        emit(message) { helper.emitRaw(JSON.stringify(message)); },
        // A well-behaved helper announces the protocol main speaks; a test that wants a mismatch
        // passes another number, so the default must follow the constant rather than repeat it.
        ready(protocol = READER_PROTOCOL) { helper.emit({event: "ready", protocol}); },
        lastId() {
          for (let i = helper.received.length - 1; i >= 0; i--) {
            const message = helper.received[i];
            if (message && "id" in message) return message.id;
          }
          throw new Error("no message with an id was received");
        },
        lastRead() {
          for (let i = helper.received.length - 1; i >= 0; i--) {
            const message = helper.received[i];
            if (message && message.op === "read") return message;
          }
          throw new Error("no read was received");
        },
        answerLast(body) { helper.emit({id: helper.lastId(), ...body}); },
        exit: leave,
        exited: () => gone
      };
      helpers.all.push(helper);
      return {
        send(line) { if (!gone) helper.received.push(JSON.parse(line) as ToHelper); },
        onLine(cb) { onLine = cb; },
        onExit(cb) { onExit = cb; },
        closeInput() { helper.inputClosed = true; if (helpers.exitOnInputClosed) leave(); },
        // A real `kill` is followed by the exit notification; the client must not depend on that.
        kill() { helper.killed = true; gone = true; }
      };
    }
  };
  return helpers;
}
```

- [ ] **Step 2: Write the failing test**

`app/src/main/reader/readerClient.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers, type FakeHelpers} from "../testing/fakeReaderHelper";
import {
  CLIENT_CALL_DEADLINE_MS, CLIENT_DENIED_REFRESH_MS, CLIENT_MAX_READ_BUDGET_MS, CLIENT_READ_GRACE_MS, HELPER_BACKOFF_MAX_MS,
  HELPER_EXIT_LIMIT, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS, HELPER_SHUTDOWN_GRACE_MS, HELPER_START_DEADLINE_MS
} from "./constants";
import type {HelperLink} from "./protocol";
import {createReaderClient, ReaderDown, type ReaderClient, type ReaderClientEvent} from "./readerClient";

const WINDOW = {app: "Code", bundleId: "com.microsoft.VSCode", title: "query.sql"};

describe("reader client: calls", () => {
  let helpers: FakeHelpers;
  let events: ReaderClientEvent[];
  let client: ReaderClient;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  /** A client whose helper is up and ready. */
  async function ready(): Promise<void> {
    void client.permission();                 // any call starts the helper
    helpers.latest().ready();
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    helpers = createFakeHelpers();
    events = [];
    client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (e) => events.push(e)});
  });
  afterEach(() => { vi.useRealTimers(); });

  it("starts no helper until it is used", () => {
    expect(helpers.all).toHaveLength(0);
    expect(client.state()).toBe("idle");
  });

  it("while the helper warms up: permission is unknown, there is no window, a read fails, and nothing is sent", async () => {
    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("starting");
    expect(await client.frontWindow()).toBeNull();
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed"});
    await client.requestPermission();
    expect(helpers.all).toHaveLength(1);
    expect(helpers.latest().received).toEqual([]);
  });

  it("asks the helper once it is ready, and hands back what the port's own parsers accept", async () => {
    await ready();
    expect(client.state()).toBe("ready");

    const permission = client.permission();
    helpers.latest().answerLast({permission: "granted"});
    expect(await permission).toBe("granted");

    const front = client.frontWindow();
    helpers.latest().answerLast({window: WINDOW});
    expect(await front).toEqual(WINDOW);

    const read = client.read({budgetMs: 1500, expect: WINDOW});
    expect(helpers.latest().received.at(-1)).toEqual({id: helpers.latest().lastId(), op: "read", budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "SELECT 1", toolbarText: "example.com", extra: "dropped"});
    expect(await read).toEqual({ok: true, window: WINDOW, text: "SELECT 1", toolbarText: "example.com"});
  });

  it("no front window is null; a window that does not parse rejects, so the loop counts it", async () => {
    await ready();
    const none = client.frontWindow();
    helpers.latest().answerLast({window: null});
    expect(await none).toBeNull();
    const bad = client.frontWindow().then(() => "resolved", (error: unknown) => error);
    helpers.latest().answerLast({window: {app: 7}});
    expect(await bad).toBeInstanceOf(ReaderDown);
    const missing = client.frontWindow().then(() => "resolved", (error: unknown) => error);
    helpers.latest().answerLast({});
    expect(await missing).toBeInstanceOf(ReaderDown);
    expect(client.state()).toBe("ready");                        // a bad answer does not cost the helper its life
  });

  it("a malformed read answer is a failed read; a helper's failure reason passes through", async () => {
    await ready();
    const bad = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, text: 5});
    expect(await bad).toEqual({ok: false, reason: "failed"});
    const locked = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "locked"});
    expect(await locked).toEqual({ok: false, reason: "locked"});
  });

  // The client does not interpret a reason, it passes the parsed result on. `windowGone` has to
  // arrive at the loop as itself: turned into `failed` it would count towards switching capture off.
  it("passes a vanished window through as its own reason", async () => {
    await ready();
    const gone = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: false, reason: "windowGone"});
    expect(await gone).toEqual({ok: false, reason: "windowGone"});
  });

  // Protocol 2. `expect` is a privacy instruction to another process, so what goes on the wire is
  // written out field by field rather than spread from whatever object main happened to hand over.
  it("puts exactly the three known fields of the approved window on the wire", async () => {
    await ready();
    const noted = {app: "Code", title: "query.sql", note: "main's own bookkeeping"};
    void client.read({budgetMs: 1500, expect: noted});
    expect(helpers.latest().lastRead().expect).toEqual({app: "Code", title: "query.sql"});
    expect(Object.keys(helpers.latest().lastRead().expect)).toEqual(["app", "title"]);

    void client.read({budgetMs: 1500, expect: WINDOW});
    expect(helpers.latest().lastRead().expect).toEqual(WINDOW);
    expect(Object.keys(helpers.latest().lastRead().expect).sort()).toEqual(["app", "bundleId", "title"]);
  });

  // The helper measures what a read cost (protocol 2). Those numbers are for the evaluation
  // harness; the port hands the caller the port's own fields and nothing else.
  it("strips the helper's measurements out of a read answer", async () => {
    await ready();
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "SELECT 1", stats: {captureMs: 31, recogniseMs: 198, cacheHit: false}});
    expect(await read).toEqual({ok: true, window: WINDOW, text: "SELECT 1"});
  });

  it("anything but a known permission value is unknown", async () => {
    await ready();
    const p = client.permission();
    helpers.latest().answerLast({permission: "needsRestart"});   // not the helper's to say
    expect(await p).toBe("unknown");
  });

  it("an unreadable line fails whatever was being asked", async () => {
    await ready();
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().emitRaw("Segmentation fault");
    expect(await read).toEqual({ok: false, reason: "failed"});
    expect(client.state()).toBe("ready");        // one stray line does not cost the helper its life
  });

  it("drops an answer nobody is waiting for", async () => {
    await ready();
    helpers.latest().emit({id: 999, ok: true, window: WINDOW, text: "stale"});
    const front = client.frontWindow();
    helpers.latest().answerLast({window: WINDOW});
    expect(await front).toEqual(WINDOW);
  });

  describe("re-entry", () => {
    it("a second read settles the first as a timeout, cancels it, and can never be answered by it", async () => {
      await ready();
      const first = client.read({budgetMs: 1500, expect: WINDOW});
      const firstId = helpers.latest().lastId();
      const second = client.read({budgetMs: 1500, expect: WINDOW});
      expect(await first).toEqual({ok: false, reason: "timeout"});
      expect(helpers.latest().received).toContainEqual({op: "cancel", target: firstId});

      // The earlier frame arrives late, under the earlier id: it must not answer the later call.
      helpers.latest().emit({id: firstId, ok: true, window: WINDOW, text: "EARLIER FRAME"});
      let answered = false;
      void second.then(() => { answered = true; });
      await settle();
      expect(answered).toBe(false);

      helpers.latest().answerLast({ok: true, window: WINDOW, text: "later frame"});
      expect(await second).toEqual({ok: true, window: WINDOW, text: "later frame"});
    });

    it("a read does not disturb a front-window call in flight", async () => {
      await ready();
      const front = client.frontWindow();
      const frontId = helpers.latest().lastId();
      void client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().emit({id: frontId, window: WINDOW});
      expect(await front).toEqual(WINDOW);
      expect(helpers.latest().received.filter((m) => "op" in m && m.op === "cancel")).toEqual([]);
    });
  });

  describe("deadlines", () => {
    it("a read that outlives budget plus grace is a timeout, and the wedged helper is killed and replaced", async () => {
      await ready();
      const wedged = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      await vi.advanceTimersByTimeAsync(1500 + CLIENT_READ_GRACE_MS - 1);
      expect(wedged.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toEqual({ok: false, reason: "timeout"});
      expect(wedged.killed).toBe(true);
      expect(events).toContain("HELPER_WEDGED");
      await vi.advanceTimersByTimeAsync(500);
      expect(helpers.all).toHaveLength(2);
    });

    it("a front-window call that is never answered rejects, so the loop counts it", async () => {
      await ready();
      const front = client.frontWindow();
      const outcome = front.then(() => "resolved", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
      expect(await outcome).toBeInstanceOf(ReaderDown);
      expect(helpers.all[0]?.killed).toBe(true);
    });

    it("a permission call that is never answered is unknown; a permission request just ends", async () => {
      await ready();
      const p = client.permission();
      await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
      expect(await p).toBe("unknown");
    });

    it("treats a nonsense budget as zero rather than passing it on", async () => {
      await ready();
      void client.read({budgetMs: Number.NaN, expect: WINDOW});
      expect(helpers.latest().received.at(-1)).toMatchObject({op: "read", budgetMs: 0});
    });

    it("caps an absurd budget instead of overflowing the timer and killing a healthy helper", async () => {
      await ready();
      const read = client.read({budgetMs: 2 ** 31, expect: WINDOW});
      expect(helpers.latest().received.at(-1)).toMatchObject({op: "read", budgetMs: CLIENT_MAX_READ_BUDGET_MS});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(helpers.latest().killed).toBe(false);
      helpers.latest().answerLast({ok: false, reason: "black"});
      expect(await read).toEqual({ok: false, reason: "black"});
    });
  });

  describe("the helper goes away under a call", () => {
    it("a read fails, a front-window call rejects, permission is unknown", async () => {
      await ready();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const front = client.frontWindow().then(() => "resolved", (error: unknown) => error);
      const permission = client.permission();
      helpers.latest().exit();
      expect(await read).toEqual({ok: false, reason: "failed"});
      expect(await front).toBeInstanceOf(ReaderDown);
      expect(await permission).toBe("unknown");
      expect(events).toContain("HELPER_EXIT");
    });
  });

  describe("permission: what works outranks what the check says", () => {
    it("restarts the helper once by itself when captures are refused, and only then asks the user to restart", async () => {
      await ready();
      const first = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await first).toBe("unknown");                       // not the user's problem yet
      // With nothing in flight the old helper is asked to go at once — asked, not killed: it is
      // being replaced on suspicion, and a helper that leaves when asked never needs killing.
      expect(helpers.all[0]?.received.at(-1)).toEqual({op: "shutdown"});
      expect(helpers.all[0]?.inputClosed).toBe(true);
      expect(helpers.all[0]?.exited()).toBe(true);
      expect(helpers.all).toHaveLength(2);                       // at once, without backoff
      expect(events).not.toContain("HELPER_EXIT");               // and it was no crash

      helpers.latest().ready();
      await settle();
      const second = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await second).toBe("needsRestart");
      expect(helpers.all).toHaveLength(2);                       // no restart loop
    });

    /**
     * The other way the same helper can be sent away twice, and the one the `drain` guard is
     * actually for: a warmed-up replacement is waiting, the `refused` answer settles the last call
     * in flight, and `tryPromote()` — which runs inside `onLine`, before the `permission()`
     * continuation gets its turn — promotes the replacement and retires this helper. The cure then
     * calls `drain()` on a helper that is already on its way out. Without the guard that is a second
     * `shutdown` and a kill timer restarted, extending the grace period, for one replacement that
     * has already happened.
     */
    it("does not send a helper away twice when a promotion and the refused cure land together", async () => {
      helpers.exitOnInputClosed = false;      // so a retired helper is still there to be retired again
      await ready();
      // Enough reads that the next call plans the routine replacement.
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();
      const answer = client.permission();     // plans the replacement, and asks the serving helper
      expect(helpers.all).toHaveLength(2);
      helpers.latest().ready();               // warm, but a call is in flight: not promoted yet
      await settle();
      expect(events).not.toContain("HELPER_REPLACED");

      serving.answerLast({permission: "refused"});
      expect(await answer).toBe("unknown");
      expect(events).toContain("HELPER_REPLACED");                              // promoted first
      expect(serving.received.filter((m) => m.op === "shutdown")).toHaveLength(1);
      expect(helpers.all).toHaveLength(2);    // and the cure started nothing of its own
    });

    /**
     * The cure used to kill the old helper where it stood, which settled a `read` in flight as
     * `failed` — and the capture loop counts `failed` against the reader, in the same failure window
     * that decides whether to switch capture off and tell the user the reader is broken. Our own
     * cure must not reach the loop looking like the illness.
     */
    it("lets a read that is already in flight finish, and only then asks the old helper to go", async () => {
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const readId = old.lastId();
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      expect(await refused).toBe("unknown");

      expect(helpers.all).toHaveLength(2);                       // the fresh helper is already warming up
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);   // and nobody hurried the old one
      expect(old.killed).toBe(false);
      old.emit({id: readId, ok: true, window: WINDOW, text: "finished after the cure began"});
      expect(await read).toEqual({ok: true, window: WINDOW, text: "finished after the cure began"});

      expect(old.received.at(-1)).toEqual({op: "shutdown"});     // its last call answered: now it may go
      expect(old.inputClosed).toBe(true);
      expect(events).toEqual([]);                                // going when asked is no crash, and counts for nothing
    });

    it("sends the helper on its way out nothing more: later calls go to the fresh one", async () => {
      await ready();
      const old = helpers.latest();
      void client.read({budgetMs: 1500, expect: WINDOW});        // never answered, so `old` stays alive
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      const sent = old.received.length;

      const fresh = helpers.latest();
      fresh.ready();
      await settle();
      const granted = client.permission();
      fresh.answerLast({permission: "granted"});
      expect(await granted).toBe("granted");
      expect(old.received).toHaveLength(sent);
    });

    it("a helper on its way out that never answers is killed by its own call's deadline", async () => {
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      await vi.advanceTimersByTimeAsync(1500 + CLIENT_READ_GRACE_MS);

      expect(await read).toEqual({ok: false, reason: "timeout"});
      expect(old.killed).toBe(true);
      // `HELPER_WEDGED` is said for a helper on its way out as well: the code states that the binary
      // hung inside a native call, which is true whoever was waiting for it, and a helper that hangs
      // on every read would otherwise be replaced in silence for ever. Its exit still counts for
      // nothing — it was out of service before it hung.
      expect(events).toEqual(["HELPER_WEDGED"]);
    });

    it("dispose in the middle of the drain owns both helpers", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const refused = client.permission();
      old.answerLast({permission: "refused"});
      await refused;
      const fresh = helpers.latest();
      expect(fresh).not.toBe(old);

      const done = client.dispose();
      expect(await read).toEqual({ok: false, reason: "failed"});  // nobody is listening any more
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(fresh.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    /**
     * The twin of "does not take the last working helper away after the supervisor has given up"
     * below, on this path. The cure IS a fresh helper, and once the supervisor has given up there is
     * none to be had — `start()` refuses — so draining the helper that is still answering perfectly
     * well would leave the client with no process at all: `state()` `gaveUp`, `permission()`
     * `unknown` for ever, and nothing on screen, because giving up is only logged.
     *
     * The answer is `needsRestart`, not `unknown`. The system check says yes while captures are
     * refused — that is something real and something the user can act on — and restarting the app is
     * exactly the cure we can no longer perform ourselves: a new process gets both a fresh helper
     * (curing the stale grant) and a supervisor that has not given up. `unknown` would reach the
     * engine as `NO_PERMISSION` (`engine.ts:246`), which is not what we know, and would leave a
     * reader that needs a restart saying nothing at all.
     */
    it("the refused cure does not take the last working helper away after the supervisor has given up", async () => {
      await ready();
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();                                  // a crash: counted
        await settle();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);  // the restart timer fires
        helpers.latest().ready();
        await settle();
      }
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();
      const planned = client.permission();                        // this call plans the replacement
      serving.answerLast({permission: "granted"});
      await planned;
      const warming = helpers.all.length;
      expect(warming).toBe(6);                                    // five so far, plus the one warming up
      serving.exit();                                             // the fifth crash: given up, but not down
      await settle();
      expect(events).toContain("HELPER_GAVE_UP");
      helpers.latest().ready();
      await settle();
      expect(client.state()).toBe("ready");

      const refused = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await refused).toBe("needsRestart");                 // the user's turn: we cannot cure it
      expect(helpers.all).toHaveLength(warming);                  // and the helper we have is still ours
      expect(client.state()).toBe("ready");
      const again = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await again).toBe("granted");                        // still answering, call after call
    });

    it("a good read ends the episode, so a later refusal gets its own automatic restart", async () => {
      await ready();
      const p1 = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      await p1;
      helpers.latest().ready();
      await settle();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().answerLast({ok: true, window: WINDOW, text: "fine again"});
      await read;
      const p2 = client.permission();
      helpers.latest().answerLast({permission: "refused"});
      expect(await p2).toBe("unknown");
      expect(helpers.all).toHaveLength(3);
    });
  });

  // Measured in the first real run: the system check is cached for the life of the process and the
  // helper never captures while denied, so the helper that was running when the owner switched
  // Screen Recording on kept saying `denied` until it was killed, while a fresh one said `granted`
  // at once.
  describe("permission: a stale `denied` is cured by a fresh helper", () => {
    /** A ready helper with nothing in flight: the first `permission()` is answered before it is ready. */
    async function readyIdle(): Promise<void> {
      expect(await client.permission()).toBe("unknown");   // starts the helper; nothing is asked yet
      helpers.latest().ready();
      await settle();
    }

    async function denied(): Promise<string> {
      const p = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      return p;
    }

    it("leaves a young helper alone, so polling every second cannot cause a restart storm", async () => {
      await readyIdle();
      expect(await denied()).toBe("denied");
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS - 1);
      expect(await denied()).toBe("denied");
      expect(helpers.all).toHaveLength(1);
      expect(helpers.all[0]?.received.some((m) => m.op === "shutdown")).toBe(false);
    });

    it("replaces a helper that has been saying denied for long enough, and blames it for nothing", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      expect(await denied()).toBe("denied");                        // this call still answers what it knows
      const old = helpers.all[0];
      expect(old?.received.some((m) => m.op === "shutdown")).toBe(true);
      expect(old?.inputClosed).toBe(true);
      expect(helpers.all).toHaveLength(2);                          // a fresh one, at once
      expect(events).not.toContain("HELPER_EXIT");                  // going when asked is not a crash
      expect(events).not.toContain("HELPER_GAVE_UP");
    });

    /**
     * Two polls in flight at once — the engine's tick and a recheck from the window, say — both
     * answered `denied` by the same helper that is old enough to be replaced. The first answer
     * sends it away; the second must find a helper already on its way out and leave it alone,
     * rather than retire it a second time (a second `shutdown`, and the grace period extended by a
     * restarted kill timer) and charge one replacement two doublings of the wait.
     */
    it("sends a helper away once, however many denied answers land on it at the same time", async () => {
      helpers.exitOnInputClosed = false;        // so a retired helper is still there to be retired again
      await readyIdle();
      // Older than the DOUBLED interval: the first answer doubles the wait before the second is
      // looked at, so a younger helper would be spared the second drain by the doubling alone.
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS * 2);
      const old = helpers.latest();

      const first = client.permission();
      const second = client.permission();
      const ids = old.received.flatMap((message) => ("id" in message ? [message.id] : []));
      expect(ids).toHaveLength(2);
      old.emit({id: ids[0] as number, permission: "denied"});
      old.emit({id: ids[1] as number, permission: "denied"});
      expect(await first).toBe("denied");
      expect(await second).toBe("denied");

      expect(old.received.filter((message) => message.op === "shutdown")).toHaveLength(1);
      expect(helpers.all).toHaveLength(2);      // one replacement, not two

      // And the wait doubled once, not twice: the next replacement is due after ten seconds.
      helpers.latest().ready();
      await settle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS * 2);
      const third = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await third).toBe("denied");
      expect(helpers.all).toHaveLength(3);
    });

    it("the fresh helper's answer is the one that counts", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      await denied();
      helpers.latest().ready();
      await settle();
      const p = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await p).toBe("granted");
    });

    it("twenty denied polls a second apart replace the helper at most once per five seconds", async () => {
      await readyIdle();
      for (let second = 0; second < 20; second++) {
        if (!helpers.latest().exited()) {
          const p = client.permission();
          // A helper that is not ready yet is never asked, so there is nothing to answer.
          if (helpers.latest().received.some((m) => "id" in m)) helpers.latest().answerLast({permission: "denied"});
          await p;
        }
        helpers.latest().ready();
        await settle();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(helpers.all.length).toBeLessThanOrEqual(1 + Math.floor(20 / (CLIENT_DENIED_REFRESH_MS / 1_000)));
      expect(events).not.toContain("HELPER_GAVE_UP");
      expect(client.state()).toBe("ready");
    });

    // The refresh is our decision about a helper that is answering perfectly well, so it costs the
    // calls it is holding nothing: they are answered by the helper that took them, and only then is
    // it asked to go. Settling them as "down" instead would reach the capture loop as `failed` and
    // count against the reader in the window that switches capture off.
    it("lets the calls in flight finish on the helper being replaced, and never sends it another", async () => {
      await readyIdle();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      const old = helpers.latest();
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      const readId = old.lastId();
      const front = client.frontWindow();
      const frontId = old.lastId();
      expect(await denied()).toBe("denied");
      const sent = old.received.length;
      expect(helpers.all).toHaveLength(2);                          // the fresh one is warming up already
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);

      old.emit({id: frontId, window: WINDOW});
      expect(await front).toEqual(WINDOW);
      expect(old.received.some((m) => m.op === "shutdown")).toBe(false);   // one call still open
      old.emit({id: readId, ok: true, window: WINDOW, text: "its last word"});
      expect(await read).toEqual({ok: true, window: WINDOW, text: "its last word"});
      expect(old.received.at(-1)).toEqual({op: "shutdown"});        // nothing left to hold it here
      expect(old.inputClosed).toBe(true);

      // The fresh helper is not ready, so these are answered without anybody being asked.
      expect(await client.permission()).toBe("unknown");
      expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed"});
      expect(old.received).toHaveLength(sent + 1);                  // the shutdown, and nothing else
      expect(events).not.toContain("HELPER_EXIT");
    });

    /**
     * One poll a second, every one answered `denied`, each fresh helper readied at once — the
     * engine's tick, sped up. Answers with the seconds (counted from the first poll of this call) at
     * which a new helper was spawned.
     */
    async function pollDeniedFor(seconds: number): Promise<number[]> {
      const spawnedAt: number[] = [];
      for (let second = 0; second < seconds; second++) {
        const before = helpers.all.length;
        if (!helpers.latest().exited()) {
          const p = client.permission();
          // A helper that is not ready yet is never asked, so there is nothing to answer.
          if (helpers.latest().received.some((m) => "id" in m)) helpers.latest().answerLast({permission: "denied"});
          await p;
        }
        if (helpers.all.length > before) spawnedAt.push(second);
        helpers.latest().ready();
        await settle();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      return spawnedAt;
    }

    // The engine asks every 10 s whatever else is happening, so a fixed 5 s wait would charge a user
    // who has simply declined a process and a Vision warm-up every 10 s for ever. Doubling makes the
    // cost fade: over five minutes this poller pays 7 replacements instead of 60. The 60 is a rate
    // only a unit test reaches — it polls once a second, so a fixed 5 s interval is due again every
    // 5 s (300 / 5). The app's own asker is the engine's tick, `PIPELINE_TICK_MS`, at 10 s, where the
    // same fixed interval would cost about 30 replacements — 31 helpers — in five minutes. Either
    // baseline is many times the 7 measured here, which is the point of the test.
    it("doubles the wait after each replacement that is still denied, up to a minute", async () => {
      await readyIdle();
      const spawnedAt = await pollDeniedFor(300);
      // The gaps are the intervals used: 5, 10, 20, 40, then capped at 60, 60.
      expect(spawnedAt).toEqual([5, 15, 35, 75, 135, 195, 255]);
      expect(helpers.all).toHaveLength(8);
      expect(events).not.toContain("HELPER_EXIT");
      expect(events).not.toContain("HELPER_GAVE_UP");
    });

    it("an answer that is not denied puts the wait back to the first interval", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);   // the wait is now 40 s
      const before = helpers.all.length;
      const granted = client.permission();
      helpers.latest().answerLast({permission: "granted"});
      expect(await granted).toBe("granted");
      // Six more seconds is enough only because the wait went back to five.
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("asking the user for permission puts the wait back, because they are about to grant it", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);
      const before = helpers.all.length;
      const asked = client.requestPermission();
      helpers.latest().answerLast({});
      await asked;
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("switching capture on puts the wait back: that is the user's try again", async () => {
      await readyIdle();
      expect(await pollDeniedFor(36)).toEqual([5, 15, 35]);
      const before = helpers.all.length;
      client.onFocusChange(() => undefined);
      await pollDeniedFor(6);
      expect(helpers.all).toHaveLength(before + 1);
    });

    it("does not take the last working helper away after the supervisor has given up", async () => {
      // Giving up while a helper is still serving needs the fifth counted exit to promote a warming
      // replacement, and a replacement is only planned after HELPER_PLANNED_RESTART_READS reads or
      // six hours — six hours would push the earlier exits out of the ten-minute window, so reads it
      // is. This is the state the re-review reached.
      await readyIdle();
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();                                  // a crash: counted
        await settle();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);  // the restart timer fires
        helpers.latest().ready();
        await settle();
      }
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) {
        const read = client.read({budgetMs: 1500, expect: WINDOW});
        helpers.latest().answerLast({ok: false, reason: "black"});
        await read;
      }
      const serving = helpers.latest();                           // the helper that has done the reads
      const planned = client.permission();                        // this call plans the replacement
      serving.answerLast({permission: "granted"});
      await planned;
      const warming = helpers.all.length;
      expect(warming).toBe(6);                                    // five so far, plus the one warming up
      serving.exit();                                             // the fifth crash, with a replacement ready to take over
      await settle();
      expect(events).toContain("HELPER_GAVE_UP");
      helpers.latest().ready();
      await settle();
      expect(client.state()).toBe("ready");                       // a helper is still serving

      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      const p = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await p).toBe("denied");
      // Without the guard this would retire the last helper, `start()` would refuse to replace it,
      // and `permission()` would answer `unknown` for ever with nothing on screen to say why.
      expect(helpers.all).toHaveLength(warming);
      expect(client.state()).toBe("ready");
      const again = client.permission();
      helpers.latest().answerLast({permission: "denied"});
      expect(await again).toBe("denied");
    });
  });

  describe("focus", () => {
    it("tells every subscriber, survives one that throws, and stops telling one that unsubscribed", async () => {
      const seen: string[] = [];
      client.onFocusChange(() => { seen.push("a"); });
      client.onFocusChange(() => { throw new Error("bad subscriber"); });
      const off = client.onFocusChange(() => { seen.push("c"); });
      helpers.latest().ready();
      await settle();
      helpers.latest().emit({event: "focus"});
      expect(seen).toEqual(["a", "c"]);
      off();
      helpers.latest().emit({event: "focus"});
      expect(seen).toEqual(["a", "c", "a"]);
    });

    it("subscribing starts the helper, and subscriptions survive a helper restart", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      expect(helpers.all).toHaveLength(1);
      helpers.latest().ready();
      await settle();
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(500);
      helpers.latest().ready();
      await settle();
      helpers.latest().emit({event: "focus"});
      expect(count).toBe(1);
    });

    it("ignores focus events from a helper that is not ready", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      helpers.latest().emit({event: "focus"});
      expect(count).toBe(0);
    });
  });

  describe("dispose", () => {
    it("asks the helper to go, closes its input, and needs no kill when it leaves", async () => {
      await ready();
      const helper = helpers.latest();
      await client.dispose();
      expect(helper.received.at(-1)).toEqual({op: "shutdown"});
      expect(helper.inputClosed).toBe(true);
      expect(helper.killed).toBe(false);
      expect(client.state()).toBe("disposed");
    });

    it("kills a helper that does not leave within the grace period", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const helper = helpers.latest();
      const done = client.dispose();
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(helper.killed).toBe(true);
    });

    it("fails calls in flight, answers every later call as down, starts nothing, and tells no one", async () => {
      await ready();
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      await client.dispose();
      expect(await read).toEqual({ok: false, reason: "failed"});
      expect(await client.permission()).toBe("unknown");
      expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed"});
      await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
      await vi.advanceTimersByTimeAsync(HELPER_START_DEADLINE_MS);
      expect(helpers.all).toHaveLength(1);
      expect(count).toBe(0);
      await client.dispose();                                     // twice is fine
    });

    // A helper that has been asked to go is still a process. Until now `dispose` only knew about
    // `current` and `replacement`, so one that had been retired earlier — and that ignores both
    // `shutdown` and a closed stdin — was held by nothing but its own kill timer, which outlived the
    // client: the process was still there after the app believed the reader was gone.
    it("waits for a stubborn helper that a promotion retired, and kills it", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      const p = client.permission();                     // any call plans the replacement
      old.answerLast({permission: "granted"});
      await p;
      expect(helpers.all).toHaveLength(2);
      helpers.latest().ready();                          // the replacement takes over and retires `old`
      await settle();
      expect(events).toContain("HELPER_REPLACED");
      expect(old.inputClosed).toBe(true);
      expect(old.killed).toBe(false);                    // stubborn: it is still running
      // The promoted helper then crashes, so the stubborn `old` is the only thing still on its way
      // out. If `dispose` does not know about it, it has nothing to wait for and returns at once.
      helpers.latest().exit();
      await settle();

      let resolvedWhileItRan = false;
      const done = client.dispose().then(() => { resolvedWhileItRan = !old.killed && !old.exited(); });
      await settle();
      expect(resolvedWhileItRan).toBe(false);
      // One helper on its way out, one kill timer: re-retiring it must not orphan the first one.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a stubborn helper that the denied refresh retired, and kills it", async () => {
      helpers.exitOnInputClosed = false;
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(CLIENT_DENIED_REFRESH_MS);
      helpers.failNextSpawn = true;                      // no fresh helper, so `old` is all there is
      const p = client.permission();
      old.answerLast({permission: "denied"});
      expect(await p).toBe("denied");
      expect(helpers.all).toHaveLength(1);
      expect(old.inputClosed).toBe(true);
      expect(old.killed).toBe(false);

      let resolvedWhileItRan = false;
      const done = client.dispose().then(() => { resolvedWhileItRan = !old.killed && !old.exited(); });
      await settle();
      expect(resolvedWhileItRan).toBe(false);
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await done;
      expect(old.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

/**
 * `HelperLink` asks the client to register `onLine` and `onExit` in the same turn as `spawn()`
 * returns, and the real link holds back whatever the helper said before that — delivering it on a
 * later turn, never from inside `onLine` itself. This is the client's half of the same contract: a
 * link that DOES deliver re-entrantly must not be able to wedge it.
 *
 * It could. `launch()` registered the callbacks before the caller had put the new helper into
 * `current` or `replacement`, so a line delivered during registration was handled against a helper
 * the client did not know about yet. A mismatching `ready` reached `gone()`, which found the helper
 * in neither slot and so recorded nothing and scheduled nothing; `start()` then assigned the already
 * dead helper to `current`. The client sat in "starting" for ever — no timers, no further spawn, and
 * `frontWindow()` answering `null` instead of rejecting, so the capture loop never counted a failure
 * (`loop.ts`) and a reader that was dead for good never surfaced as a reader problem.
 */
describe("reader client: a link that delivers lines from inside `onLine`", () => {
  /** A link that says its piece the moment the client registers, and answers nothing afterwards. */
  const reentrant = (lines: string[]): HelperLink => ({
    send: () => undefined,
    onLine(cb) { for (const line of lines) cb(line); },
    onExit: () => undefined,
    closeInput: () => undefined,
    kill: () => undefined
  });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a mismatching `ready` delivered during registration stops the client for good, and says so", async () => {
    const events: ReaderClientEvent[] = [];
    let spawned = 0;
    const client = createReaderClient({
      spawn: () => { spawned += 1; return reentrant(['{"event":"ready","protocol":1}']); },
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("gaveUp");                        // not "starting" for ever
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);   // the loop counts this
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect({spawned, events}).toEqual({spawned: 1, events: ["HELPER_PROTOCOL_MISMATCH"]});
    expect(vi.getTimerCount()).toBe(0);
    await client.dispose();
  });

  /** A link that never notices it was asked to go: only the kill timer ends it, so dispose waits. */
  async function disposeOf(client: ReaderClient): Promise<void> {
    const done = client.dispose();
    await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
    await done;
  }

  it("a good `ready` delivered during registration leaves the client ready", async () => {
    const client = createReaderClient({spawn: () => reentrant(['{"event":"ready","protocol":2}']), now: () => Date.now()});
    void client.permission();
    expect(client.state()).toBe("ready");
    await disposeOf(client);
  });

  it("a replacement whose `ready` arrives during registration takes over, and says so", async () => {
    const events: ReaderClientEvent[] = [];
    const first = {say: (_line: string) => undefined as void, shutdown: false};
    let spawned = 0;
    const client = createReaderClient({
      spawn: () => {
        spawned += 1;
        if (spawned > 1) return reentrant(['{"event":"ready","protocol":2}']);
        return {
          send: (line) => { if (line.includes("shutdown")) first.shutdown = true; },
          onLine(cb) { first.say = cb; },
          onExit: () => undefined,
          closeInput: () => undefined,
          kill: () => undefined
        };
      },
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    void client.permission();
    first.say('{"event":"ready","protocol":2}');
    await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
    void client.permission();                                    // plans the replacement, ready on arrival
    expect(spawned).toBe(2);
    // The swap is not left waiting for a line that a warm helper has no reason to send.
    expect(events).toEqual(["HELPER_REPLACED"]);
    expect(first.shutdown).toBe(true);
    await disposeOf(client);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --dir app test src/main/reader/readerClient.test.ts`
Expected: FAIL — cannot resolve `./readerClient`.

- [ ] **Step 4: Write the client**

The supervision half of this file (backoff, give-up, start deadline, planned restart) is exercised by Task 3's tests; it is delivered here because the two halves share one state machine and cannot be split without inventing an intermediate design.

`app/src/main/reader/readerClient.ts`:
```ts
import type {FrontWindow} from "../../core/types";
import {parseFrontWindow, parseReadResult, type Permission, type Reader, type ReadResult} from "../ports/reader";
import type {Now} from "../ports/system";
import {
  CLIENT_CALL_DEADLINE_MS, CLIENT_DENIED_REFRESH_MAX_MS, CLIENT_DENIED_REFRESH_MS, CLIENT_MAX_READ_BUDGET_MS, CLIENT_READ_GRACE_MS,
  HELPER_BACKOFF_FIRST_MS, HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT,
  HELPER_EXIT_WINDOW_MS, HELPER_HEALTHY_AFTER_MS, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS,
  HELPER_SHUTDOWN_GRACE_MS, HELPER_START_DEADLINE_MS, READER_PROTOCOL
} from "./constants";
import {encode, parseHelperPermission, parseLine, type HelperLink, type ToHelper} from "./protocol";

/** Codes only. Nothing the helper read from a screen can travel through here. */
export type ReaderClientEvent =
  | "HELPER_EXIT" | "HELPER_START_TIMEOUT" | "HELPER_WEDGED" | "HELPER_PROTOCOL_MISMATCH" | "HELPER_GAVE_UP" | "HELPER_REPLACED";

export type ReaderClientState = "idle" | "starting" | "ready" | "waiting" | "gaveUp" | "disposed";

export interface ReaderClient extends Reader {
  state(): ReaderClientState;
}

/** `frontWindow()` rejects with this when there is no helper to ask. See `frontWindow` below for why it must reject. */
export class ReaderDown extends Error {
  constructor() { super("READER_DOWN"); }
}

type Op = "permission" | "requestPermission" | "frontWindow" | "read";
/** `down`: the helper went away or sent something unreadable. `deadline`: it never answered. `superseded`: a later read replaced this one. */
type Answer = Record<string, unknown> | "down" | "deadline" | "superseded";
interface Pending { op: Op; timer: ReturnType<typeof setTimeout>; settle(answer: Answer): void }

interface Helper {
  link: HelperLink;
  ready: boolean;
  gone: boolean;
  /** We asked it to go, or gave up on it on purpose: its exit is not a crash. */
  retired: boolean;
  readyAt: number;
  reads: number;
  pending: Map<number, Pending>;
  startTimer: ReturnType<typeof setTimeout> | null;
  healthyTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  onGone: (() => void) | null;
}

/**
 * The `Reader` port over a supervised native helper (sub-project C). The helper decides nothing and
 * is trusted with nothing: every line it sends is parsed here and then checked again by the port's
 * own parsers. Text and titles are only ever handed to the caller; this file logs nothing.
 */
export function createReaderClient(deps: {spawn: () => HelperLink; now: Now; onEvent?: (event: ReaderClientEvent) => void}): ReaderClient {
  let current: Helper | null = null;
  /** A planned restart in progress: the next helper, warming up while `current` still serves. */
  let replacement: Helper | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = HELPER_BACKOFF_FIRST_MS;
  let exits: number[] = [];
  let gaveUp = false;
  /**
   * A helper announced a protocol number we do not speak. Kept apart from `gaveUp` because the two
   * are cured by different things: giving up after five crashes is about a machine that may recover,
   * and a new focus subscription is the user's "try again" (D5), while a mismatch is about the
   * binary on disk, which the same client will spawn again and which cannot have changed. Reviving
   * from it buys a process spawn and a Vision warm-up per subscription, and one more
   * `HELPER_PROTOCOL_MISMATCH` each time, for an answer that is already known.
   */
  let mismatched = false;
  let disposed = false;
  let nextId = 0;
  /** One automatic helper restart per "check says yes, capture says no" episode; a good read ends the episode. */
  let cureTried = false;
  /** How old a helper must be before a `denied` answer replaces it. Doubles while the answer stays `denied`. */
  let deniedRefreshMs = CLIENT_DENIED_REFRESH_MS;
  /** Helpers that have been asked to go but have not gone yet. `dispose` owns them too. */
  const retiring = new Set<Helper>();
  /** Helpers taken out of service that are still answering calls made before that. `dispose` owns them too. */
  const draining = new Set<Helper>();
  const subscribers = new Set<() => void>();

  /** Back to asking often. Called whenever the answer is not `denied`, and whenever the user is about to grant. */
  function resetDeniedRefresh(): void {
    deniedRefreshMs = CLIENT_DENIED_REFRESH_MS;
  }

  function emit(event: ReaderClientEvent): void {
    try { deps.onEvent?.(event); } catch { /* an observer must never break the reader */ }
  }

  function send(helper: Helper, message: ToHelper): void {
    try { helper.link.send(encode(message)); } catch { /* a dead pipe shows up as an exit */ }
  }

  function settleAll(helper: Helper, answer: Answer): void {
    const waiting = [...helper.pending.values()];
    helper.pending.clear();
    for (const p of waiting) { clearTimeout(p.timer); p.settle(answer); }
  }

  function noteExit(): void {
    emit("HELPER_EXIT");
    const t = deps.now();
    exits = [...exits.filter((at) => t - at < HELPER_EXIT_WINDOW_MS), t];
    if (exits.length >= HELPER_EXIT_LIMIT && !gaveUp) {
      gaveUp = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      emit("HELPER_GAVE_UP");
    }
  }

  function scheduleRestart(): void {
    if (disposed || gaveUp || restartTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, HELPER_BACKOFF_MAX_MS);
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
  }

  /** Puts the planned restart off by a full period, measured from now. */
  function postponeReplacement(): void {
    if (current) { current.readyAt = deps.now(); current.reads = 0; }
  }

  /** The one place a helper leaves: by its own exit, by our kill, or at the end of a shutdown. Idempotent. */
  function gone(helper: Helper, killIt: boolean): void {
    if (helper.gone) return;
    helper.gone = true;
    retiring.delete(helper);
    draining.delete(helper);
    for (const timer of [helper.startTimer, helper.healthyTimer, helper.killTimer]) if (timer) clearTimeout(timer);
    if (killIt) { try { helper.link.kill(); } catch { /* already gone */ } }
    settleAll(helper, "down");
    if (helper === replacement) {
      replacement = null;
      // It served nobody, so its death interrupts nothing: reported, but not counted towards giving up.
      if (!helper.retired) { emit("HELPER_EXIT"); postponeReplacement(); }
    } else if (helper === current) {
      // A replacement that is already warming up simply takes over, ready or not.
      current = replacement;
      replacement = null;
      if (!helper.retired) { noteExit(); if (!current) scheduleRestart(); }
    }
    helper.onGone?.();
  }

  function retire(helper: Helper): void {
    helper.retired = true;
    settleAll(helper, "down");
    send(helper, {op: "shutdown"});
    try { helper.link.closeInput(); } catch { /* already gone */ }
    if (helper.gone) return;
    retiring.add(helper);
    // Retiring the same helper twice (promoted away under a call, then disposed) must not leave the
    // first timer running with nobody holding it: one helper, one kill timer, always the latest.
    if (helper.killTimer) clearTimeout(helper.killTimer);
    helper.killTimer = setTimeout(() => gone(helper, true), HELPER_SHUTDOWN_GRACE_MS);
  }

  /**
   * Send a helper away and put a fresh one in its place, without blaming it for going and without
   * cutting short what it is still doing.
   *
   * Out of service first. `retire` only asks: the helper does not leave until it exits or the kill
   * timer fires, and until then it would still be `current`, so `usable()` would keep handing it out
   * and calls would be sent to a process on its way out. Taking it out here — exactly as `gone`
   * would, replacement first — closes that window. When it does finally exit, `gone` finds it is
   * neither `current` nor `replacement` any more and does nothing but settle it: no `HELPER_EXIT`,
   * nothing counted towards giving up.
   *
   * Then drained, not retired. `retire` settles every call in flight as "down", and a `read` settled
   * that way reaches the capture loop as `failed` — which the loop counts against the reader, in the
   * same failure window that decides whether to switch capture off. The two callers here (the one
   * automatic restart of a `refused` episode, and the denied refresh) are OUR decisions about a
   * helper that has done nothing wrong and may be halfway through a capture: charging the reader for
   * them would mean our own cure looks like the illness. So the helper keeps the calls it already
   * has, under their own existing deadlines — including the one that kills it if it is truly wedged
   * — and is asked to go as soon as the last of them is answered, or at once if it has none.
   */
  function drain(helper: Helper): void {
    // Once only. Two calls in flight on the same helper can both come back with the answer that
    // sends it away (two `denied` polls, say), and the second must find a helper already going and
    // do nothing: retiring it again would send a second `shutdown` and restart the kill timer,
    // extending the grace period, for one replacement the caller has already paid for.
    if (helper.gone || helper.retired) return;
    if (helper === current) { current = replacement; replacement = null; }
    else if (helper === replacement) replacement = null;
    if (helper.pending.size === 0) retire(helper);
    else draining.add(helper);
    start();   // a no-op when a warming replacement has just been promoted into `current`
  }

  /** A helper on its way out has answered the last call it was holding: nothing keeps it here now. */
  function leaveIfDrained(helper: Helper): void {
    if (helper.pending.size === 0 && draining.delete(helper)) retire(helper);
  }

  /** The warmed-up replacement takes over between calls, never under one. */
  function tryPromote(): void {
    if (!replacement || !replacement.ready) return;
    if (current && current.pending.size > 0) return;
    const old = current;
    current = replacement;
    replacement = null;
    emit("HELPER_REPLACED");
    if (old) retire(old);
  }

  function notifyFocus(): void {
    for (const cb of [...subscribers]) { try { cb(); } catch { /* one bad subscriber must not silence the others */ } }
  }

  function onLine(helper: Helper, line: string): void {
    if (helper.gone) return;
    const message = parseLine(line);
    // Unreadable: whatever was asked has failed — and a helper on its way out has nothing left to wait for.
    if (!message) { settleAll(helper, "down"); leaveIfDrained(helper); tryPromote(); return; }
    if (message.kind === "focus") { if (helper === current && helper.ready) notifyFocus(); return; }
    if (message.kind === "ready") {
      if (helper.ready) return;
      if (message.protocol !== READER_PROTOCOL) {
        // Restarting the same binary cannot help: stop here, for good, and do not count it as a
        // crash. `mismatched` is what makes it "for good" — see its declaration.
        emit("HELPER_PROTOCOL_MISMATCH");
        mismatched = true;
        gaveUp = true;
        helper.retired = true;
        gone(helper, true);
        return;
      }
      helper.ready = true;
      helper.readyAt = deps.now();
      if (helper.startTimer) { clearTimeout(helper.startTimer); helper.startTimer = null; }
      helper.healthyTimer = setTimeout(() => { backoff = HELPER_BACKOFF_FIRST_MS; }, HELPER_HEALTHY_AFTER_MS);
      tryPromote();
      return;
    }
    const p = helper.pending.get(message.id);
    if (!p) return;                                   // an answer nobody waits for any more is dropped
    helper.pending.delete(message.id);
    clearTimeout(p.timer);
    p.settle(message.body);
    leaveIfDrained(helper);
    tryPromote();
  }

  /**
   * The one place a helper is started. Answers whether a process was started at all — where it went
   * is `slot`, and it is put there BEFORE its callbacks are registered, `onExit` before `onLine`.
   *
   * That order is what makes the client robust against a link that hands a line straight back from
   * inside `onLine`. `HelperLink` asks a link to deliver on a later turn and the real one does, but
   * if one did not, the line would be handled by `onLine` against a helper that was in neither slot
   * and had no exit callback: `gone()` would find it nowhere, record nothing and schedule nothing,
   * and this function's caller would then assign the already dead helper to `current` — "starting"
   * for ever, no timers, no further spawn, and `frontWindow()` answering `null` rather than
   * rejecting, so a reader that is dead for good never reaches the capture loop's failure count.
   * Assigned first, the same line settles the helper exactly as it would at any other moment.
   */
  function launch(slot: "current" | "replacement"): boolean {
    let link: HelperLink;
    try { link = deps.spawn(); } catch { return false; }
    const helper: Helper = {
      link, ready: false, gone: false, retired: false, readyAt: 0, reads: 0, pending: new Map(),
      startTimer: null, healthyTimer: null, killTimer: null, onGone: null
    };
    if (slot === "current") current = helper; else replacement = helper;
    helper.startTimer = setTimeout(() => { emit("HELPER_START_TIMEOUT"); gone(helper, true); }, HELPER_START_DEADLINE_MS);
    link.onExit(() => gone(helper, false));
    link.onLine((line) => onLine(helper, line));
    return true;
  }

  function start(): void {
    if (disposed || gaveUp || current) return;
    if (!launch("current")) { noteExit(); scheduleRestart(); }
  }

  function maybePlanReplacement(): void {
    // Nothing plans a restart of a binary we cannot speak to. This runs on EVERY call, and the
    // mismatch branch retires the helper before `gone()`, so `postponeReplacement()` is skipped and
    // the planned restart stays due: without this guard a mismatch announced by a replacement — the
    // old helper carrying on, the client still "ready" — would start, and SIGKILL, another copy of
    // the same binary per call, for ever. `start()` is held by `gaveUp` instead; this is the other
    // door, and both have to be shut for `mismatched` to mean what it says.
    if (mismatched || !current || !current.ready || replacement) return;
    if (current.reads < HELPER_PLANNED_RESTART_READS && deps.now() - current.readyAt < HELPER_PLANNED_RESTART_MS) return;
    if (!launch("replacement")) postponeReplacement();
  }

  /** The helper that can take a call right now, starting one if none is running or on its way. */
  function usable(): Helper | null {
    if (disposed) return null;
    if (!current && !restartTimer) start();
    maybePlanReplacement();
    return current && current.ready ? current : null;
  }

  const starting = (): boolean => !disposed && current !== null && !current.ready;

  /**
   * The approved window as the protocol carries it: the three known fields, copied one by one.
   *
   * Never a spread of what the caller handed us. `FrontWindow` is a shape main built from the
   * helper's own earlier answer, and spreading it would send whatever else happened to be on that
   * object — a note main added, a field a future version introduces — to a process on the other
   * side of a pipe, unexamined. Three named fields is the whole wire format, and it stays that way.
   */
  function onTheWire(expect: FrontWindow): FrontWindow {
    return expect.bundleId === undefined
      ? {app: expect.app, title: expect.title}
      : {app: expect.app, bundleId: expect.bundleId, title: expect.title};
  }

  /** What is being asked. `read` carries its budget and the window main approved; the rest carry nothing. */
  type Question = {op: Exclude<Op, "read">} | {op: "read"; budgetMs: number; expect: FrontWindow};

  function ask(helper: Helper, question: Question, deadlineMs: number): Promise<Answer> {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!helper.pending.delete(id)) return;
        resolve("deadline");
        // It is stuck inside a native call that cannot be cancelled. Killing the process is the only
        // cancel that always works — including for a helper that is draining, whose calls are exactly
        // why it is still alive. The code is emitted for a draining helper too: it states a fact about
        // the binary (it hung), which is true whether or not we had already decided to replace it, and
        // a helper that wedges on every read would otherwise be silently replaced for ever.
        emit("HELPER_WEDGED");
        gone(helper, true);
      }, deadlineMs);
      helper.pending.set(id, {op: question.op, timer, settle: resolve});
      send(helper, question.op === "read"
        ? {id, op: "read", budgetMs: question.budgetMs, expect: onTheWire(question.expect)}
        : {id, op: question.op});
    });
  }

  return {
    state() {
      if (disposed) return "disposed";
      if (current) return current.ready ? "ready" : "starting";
      if (gaveUp) return "gaveUp";
      return restartTimer ? "waiting" : "idle";
    },

    async permission(): Promise<Permission> {
      const helper = usable();
      if (!helper) return "unknown";
      const answer = await ask(helper, {op: "permission"}, CLIENT_CALL_DEADLINE_MS);
      if (typeof answer === "string") return "unknown";
      const said = parseHelperPermission(answer);
      if (said === "granted") { resetDeniedRefresh(); return said; }
      if (said === "denied") {
        // `denied` can be stale: the system check is cached for the life of the process, and this
        // helper never captures while denied, so it has nothing that would refresh it. A helper old
        // enough to have missed a grant is replaced; the answer to THIS call is still `denied`,
        // because that is what we know. See CLIENT_DENIED_REFRESH_MS for the measurement.
        //
        // Not while we have given up: `start()` would refuse to launch the replacement and this
        // would take the last working helper away, leaving `permission()` answering `unknown` for
        // good — with nothing on screen, because giving up is only logged.
        //
        // Each replacement that is again answered `denied` doubles the wait, so a user who has
        // genuinely declined is not charged a process and a warm-up every few seconds for ever.
        //
        // And only while this helper is still the one in service. Two `denied` answers that arrive
        // together must cost ONE replacement and ONE doubling: `drain` refuses the second by itself,
        // but the wait is doubled here, so it needs the same condition or one replacement is charged
        // twice over.
        if (!gaveUp && !helper.retired && !helper.gone && deps.now() - helper.readyAt >= deniedRefreshMs) {
          deniedRefreshMs = Math.min(deniedRefreshMs * 2, CLIENT_DENIED_REFRESH_MAX_MS);
          drain(helper);
        }
        return "denied";
      }
      resetDeniedRefresh();     // `refused` is an answer about capture, and it is not `denied`
      if (said !== "refused") return "unknown";
      // The system check says yes while captures are refused. A fresh helper cures a stale grant, so
      // try that once, by ourselves; only if the next helper is refused as well is it the user's turn.
      //
      // And not at all once we have given up, for the reason the denied refresh above gives: there is
      // no fresh helper to be had — `start()` would refuse to launch one — so draining would take the
      // last working helper away and leave the client with no process at all. The answer is then
      // `needsRestart` rather than `unknown`, because restarting the app is exactly the cure we can no
      // longer perform ourselves: it gets both a helper without the stale grant and a supervisor that
      // has not given up. `unknown` would reach the engine as `NO_PERMISSION`, which is not what we
      // know, and would leave a reader that needs a restart saying nothing at all.
      if (cureTried || gaveUp) return "needsRestart";
      cureTried = true;
      // Drained, not killed: this helper may be in the middle of a read, and killing it would settle
      // that read as `failed`, which the capture loop counts against the reader. Our own cure must
      // not look to the loop like the reader failing. See `drain`.
      drain(helper);
      return "unknown";
    },

    async requestPermission(): Promise<void> {
      // The user is being shown the system prompt, so they are about to grant: ask often again,
      // however long the answer has been `denied`.
      resetDeniedRefresh();
      const helper = usable();
      if (helper) await ask(helper, {op: "requestPermission"}, CLIENT_CALL_DEADLINE_MS);
    },

    /**
     * `null` means "no window", which the capture loop does not count as a failure. So `null` is only
     * answered while a helper is on its way (a cold start can take most of a minute and must not trip
     * the loop's failure window). With no helper at all, or one that went away under the call, this
     * REJECTS: only a rejection reaches the loop's failure count, and so only a rejection lets a
     * reader that is down for good surface as a reader problem.
     */
    async frontWindow(): Promise<FrontWindow | null> {
      const helper = usable();
      if (!helper) { if (starting()) return null; throw new ReaderDown(); }
      const answer = await ask(helper, {op: "frontWindow"}, CLIENT_CALL_DEADLINE_MS);
      if (typeof answer === "string") throw new ReaderDown();
      if (answer.window === null) return null;
      // A window that is there but does not parse is the helper's fault, not an empty desktop: only a
      // rejection reaches the loop's failure count.
      const window = parseFrontWindow(answer.window);
      if (!window) throw new ReaderDown();
      return window;
    },

    async read(opts: {budgetMs: number; expect: FrontWindow}): Promise<ReadResult> {
      const helper = usable();
      if (!helper) return {ok: false, reason: "failed"};
      // Main has already stopped listening to an earlier read: settle it here, tell the helper to drop
      // it, and forget its id so that whatever it still answers can never be taken for this read.
      for (const [id, p] of [...helper.pending]) {
        if (p.op !== "read") continue;
        helper.pending.delete(id);
        clearTimeout(p.timer);
        p.settle("superseded");
        send(helper, {op: "cancel", target: id});
      }
      const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? Math.min(Math.floor(opts.budgetMs), CLIENT_MAX_READ_BUDGET_MS) : 0;
      const answer = await ask(helper, {op: "read", budgetMs, expect: opts.expect}, budgetMs + CLIENT_READ_GRACE_MS);
      if (answer === "deadline" || answer === "superseded") return {ok: false, reason: "timeout"};
      if (answer === "down") return {ok: false, reason: "failed"};
      helper.reads += 1;
      const result = parseReadResult(answer);
      if (result.ok) cureTried = false;
      return result;
    },

    onFocusChange(cb: () => void): () => void {
      subscribers.add(cb);
      // Switching capture off and on again subscribes again: that is the user's "try again", so a
      // long denied backoff is dropped along with the give-up state. Not after a protocol mismatch
      // though: there is nothing to try again, only the same binary saying the same number.
      resetDeniedRefresh();
      if (gaveUp && !mismatched && !current) { gaveUp = false; exits = []; backoff = HELPER_BACKOFF_FIRST_MS; }
      usable();
      return () => { subscribers.delete(cb); };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      subscribers.clear();
      // The helpers already on their way out belong to dispose too. A stubborn one — retired by the
      // denied refresh or by a promotion, and ignoring both `shutdown` and a closed stdin — is
      // otherwise held only by its own kill timer, which outlives this client: the process would
      // still be there after the app believes the reader is gone. A draining one is not held even by
      // that: it is waiting for an answer that, once the app is going away, nobody wants any more.
      const live = [...new Set([current, replacement, ...retiring, ...draining])].filter((h): h is Helper => h !== null && !h.gone);
      current = null;
      replacement = null;
      await Promise.all(live.map((helper) => new Promise<void>((resolve) => { helper.onGone = resolve; retire(helper); })));
    }
  };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --dir app test src/main/reader/readerClient.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 6: Reviewer's mutation probes** (apply to a scratch copy of `readerClient.ts`, run this task's test file, restore)

| Mutation | Must fail |
|---|---|
| In `frontWindow`, replace `if (!helper) { if (starting()) return null; throw new ReaderDown(); }` with `if (!helper) return null;` | at least 1 test here (and 3 in Task 3) |
| Delete the line `if (cureTried) return "needsRestart";` | "restarts the helper once by itself…" |
| In `onLine`, replace the `focus` line's condition `helper === current && helper.ready` with `true` | "ignores focus events from a helper that is not ready" |
| In `notifyFocus`, remove the `try`/`catch` around `cb()` | "tells every subscriber, survives one that throws…" |

- [ ] **Step 7: Checkpoint**

`pnpm --dir app typecheck` clean; `pnpm --dir app test src/main/imports.test.ts` passes (it now scans the new files); `verify-plan-code.py … 2` prints `mismatches: 0`.

---

### Task 3: Supervision tests

**Files:**
- Test: `app/src/main/reader/readerClient.supervision.test.ts`

**Interfaces:**
- Consumes: `createReaderClient`, `ReaderDown`, `createFakeHelpers`, the constants of Task 1.
- Produces: nothing new. This task proves the supervision half of `readerClient.ts`. If a test fails, the defect is in `readerClient.ts` as delivered by Task 2: report it, do not weaken the test.

- [ ] **Step 1: Write the tests**

`app/src/main/reader/readerClient.supervision.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers, type FakeHelpers} from "../testing/fakeReaderHelper";
import {
  HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT, HELPER_HEALTHY_AFTER_MS, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS,
  HELPER_START_DEADLINE_MS
} from "./constants";
import {createReaderClient, ReaderDown, type ReaderClient, type ReaderClientEvent} from "./readerClient";

const WINDOW = {app: "Code", title: "query.sql"};

describe("reader client: supervision", () => {
  let helpers: FakeHelpers;
  let events: ReaderClientEvent[];
  let client: ReaderClient;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  async function ready(): Promise<void> {
    void client.permission();
    helpers.latest().ready();
    await settle();
  }

  /** One complete good read on the current helper. */
  async function goodRead(): Promise<void> {
    const read = client.read({budgetMs: 1500, expect: WINDOW});
    helpers.latest().answerLast({ok: true, window: WINDOW, text: "text"});
    await read;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    helpers = createFakeHelpers();
    events = [];
    client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (e) => events.push(e)});
  });
  afterEach(() => { vi.useRealTimers(); });

  it("restarts after an exit with a doubling backoff, and a long healthy run resets it", async () => {
    await ready();
    helpers.latest().exit();
    expect(client.state()).toBe("waiting");
    await vi.advanceTimersByTimeAsync(499);
    expect(helpers.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all).toHaveLength(2);                         // 0.5 s

    helpers.latest().exit();
    await vi.advanceTimersByTimeAsync(999);
    expect(helpers.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all).toHaveLength(3);                         // 1 s

    helpers.latest().ready();
    await vi.advanceTimersByTimeAsync(HELPER_HEALTHY_AFTER_MS);
    helpers.latest().exit();
    await vi.advanceTimersByTimeAsync(500);
    expect(helpers.all).toHaveLength(4);                         // back to 0.5 s
  });

  it("while waiting to restart there is no helper at all: the front-window call rejects", async () => {
    await ready();
    helpers.latest().exit();
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    expect(await client.permission()).toBe("unknown");
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed"});
    expect(helpers.all).toHaveLength(1);                         // a call does not jump the backoff
  });

  it("never waits longer than the maximum backoff", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    expect(helpers.all).toHaveLength(HELPER_EXIT_LIMIT);
  });

  it("gives up after five unplanned exits in ten minutes, says so once, and stays down", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    expect(client.state()).toBe("gaveUp");
    expect(events.filter((e) => e === "HELPER_GAVE_UP")).toHaveLength(1);
    const started = helpers.all.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    expect(helpers.all).toHaveLength(started);
  });

  it("a new focus subscription after giving up is the user's try-again", async () => {
    await ready();
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      helpers.latest().exit();
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
    }
    const started = helpers.all.length;
    client.onFocusChange(() => undefined);
    expect(helpers.all).toHaveLength(started + 1);
    expect(client.state()).toBe("starting");
  });

  it("a helper that cannot even be started counts as an exit and is retried", async () => {
    helpers.failNextSpawn = true;
    expect(await client.permission()).toBe("unknown");
    expect(events).toEqual(["HELPER_EXIT"]);
    expect(client.state()).toBe("waiting");
    await vi.advanceTimersByTimeAsync(500);
    expect(helpers.all).toHaveLength(1);
  });

  it("allows a cold start of a minute and a half, then treats silence as a crash", async () => {
    void client.permission();
    await vi.advanceTimersByTimeAsync(HELPER_START_DEADLINE_MS - 1);
    expect(client.state()).toBe("starting");
    expect(await client.frontWindow()).toBeNull();               // still "no window", never a failure
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers.all[0]?.killed).toBe(true);
    expect(events).toEqual(["HELPER_START_TIMEOUT", "HELPER_EXIT"]);
  });

  // Protocol 1 is the one that matters now: a helper left over from before `read` carried the
  // approved window would capture and recognise whatever is in front, and there is no other way to
  // tell it apart from a helper that keeps the rule.
  it("never uses a helper that speaks another protocol, and does not restart it in a loop", async () => {
    void client.permission();
    helpers.latest().ready(1);
    await settle();
    expect(helpers.latest().killed).toBe(true);
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("gaveUp");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(helpers.all).toHaveLength(1);
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
  });

  /**
   * A give-up after five crashes is about a machine that may well recover, so switching capture off
   * and on again revives it (D5, tested above). A mismatch is about the binary on disk, and the only
   * binary this client can spawn is the same one: reviving would buy a process start and a Vision
   * warm-up for every subscription, and one more `HELPER_PROTOCOL_MISMATCH` each time, to be told
   * again what is already known.
   */
  it("a mismatch is permanent: switching capture off and on again does not start the same binary again", async () => {
    void client.permission();
    helpers.latest().ready(1);
    await settle();
    expect(client.state()).toBe("gaveUp");

    client.onFocusChange(() => undefined)();       // capture off again
    client.onFocusChange(() => undefined);         // and on
    expect(helpers.all).toHaveLength(1);
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("gaveUp");

    expect(await client.permission()).toBe("unknown");
    expect(await client.read({budgetMs: 1500, expect: WINDOW})).toEqual({ok: false, reason: "failed"});
    await expect(client.frontWindow()).rejects.toBeInstanceOf(ReaderDown);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(helpers.all).toHaveLength(1);
  });

  /**
   * The helper that announces the wrong number is not always the first one. A planned replacement
   * announces its protocol too, and when it is the one that mismatches, `current` is still serving:
   * `state()` stays "ready", so nothing about the client looks broken. `maybePlanReplacement()` runs
   * on EVERY call (the engine asks for the permission every ten seconds), and the mismatch branch
   * retires the helper before `gone()`, which skips `postponeReplacement()` — so the planned restart
   * stays due and each call would start, and SIGKILL, another copy of the same binary for ever.
   */
  it("a mismatch announced by a planned replacement is permanent too: no later call starts another", async () => {
    await ready();
    await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
    void client.permission();                                    // this call plans the replacement
    expect(helpers.all).toHaveLength(2);
    helpers.latest().ready(1);                                   // which speaks a protocol we do not
    await settle();
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);
    expect(client.state()).toBe("ready");                        // the good helper carries on serving

    const started = helpers.all.length;
    for (let i = 0; i < 5; i++) {
      void client.permission();
      if (helpers.all.length > started) helpers.latest().ready(1);
      await settle();
    }
    expect(helpers.all).toHaveLength(started);                   // D14(d): a mismatch is permanent
    expect(events).toEqual(["HELPER_PROTOCOL_MISMATCH"]);        // said once, not once per call
  });

  describe("the planned restart", () => {
    it("after enough reads, warms a replacement up while the old helper keeps serving, then swaps between calls", async () => {
      await ready();
      const old = helpers.latest();
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) await goodRead();
      expect(helpers.all).toHaveLength(1);

      const during = client.read({budgetMs: 1500, expect: WINDOW});                // this call notices that it is time
      expect(helpers.all).toHaveLength(2);
      const next = helpers.latest();
      expect(old.received.at(-1)).toMatchObject({op: "read"});     // and is still served by the old helper
      next.ready();                                                // ready while a call is in flight: no swap yet
      await settle();
      expect(old.inputClosed).toBe(false);
      old.answerLast({ok: true, window: WINDOW, text: "served by the old one"});
      expect(await during).toMatchObject({ok: true, text: "served by the old one"});

      expect(old.received.at(-1)).toEqual({op: "shutdown"});       // swapped as soon as nothing was in flight
      expect(old.inputClosed).toBe(true);
      expect(events).toEqual(["HELPER_REPLACED"]);                 // and it was no crash
      const after = client.read({budgetMs: 1500, expect: WINDOW});
      expect(next.received.at(-1)).toMatchObject({op: "read"});
      next.answerLast({ok: true, window: WINDOW, text: "served by the new one"});
      expect(await after).toMatchObject({text: "served by the new one"});
    });

    it("a read that was superseded and never answered does not hold the swap up", async () => {
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.read({budgetMs: 1500, expect: WINDOW});                          // abandoned by main, never answered by the helper
      const second = client.read({budgetMs: 1500, expect: WINDOW});
      helpers.latest().ready();                                    // the replacement is warm
      await settle();
      old.answerLast({ok: true, window: WINDOW, text: "second"});
      await second;
      expect(old.inputClosed).toBe(true);                          // nothing is in flight any more: swapped
    });

    it("also happens after six hours", async () => {
      await ready();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      expect(helpers.all).toHaveLength(2);
    });

    it("a replacement that dies while warming up is an exit, and the old helper simply carries on", async () => {
      await ready();
      const old = helpers.latest();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      helpers.latest().exit();
      expect(events).toEqual(["HELPER_EXIT"]);
      expect(client.state()).toBe("ready");
      const read = client.read({budgetMs: 1500, expect: WINDOW});
      expect(helpers.all).toHaveLength(2);                         // the next attempt is a full period away
      old.answerLast({ok: true, window: WINDOW, text: "still here"});
      expect(await read).toMatchObject({text: "still here"});
    });

    it("a replacement that dies while warming up does not count towards giving up", async () => {
      await ready();
      // Four real crashes inside the ten-minute window: one short of giving up.
      for (let i = 0; i < HELPER_EXIT_LIMIT - 1; i++) {
        helpers.latest().exit();
        await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
        helpers.latest().ready();
        await settle();
      }
      const serving = helpers.latest();
      // Enough reads to make a planned restart due, still inside the same window.
      for (let i = 0; i < HELPER_PLANNED_RESTART_READS; i++) await goodRead();
      const read = client.read({budgetMs: 1500, expect: WINDOW});                  // notices it is time, starts a replacement
      expect(helpers.latest()).not.toBe(serving);
      helpers.latest().exit();                                     // which dies while warming up
      expect(events).not.toContain("HELPER_GAVE_UP");              // it interrupted nothing
      expect(client.state()).toBe("ready");
      serving.answerLast({ok: true, window: WINDOW, text: "still serving"});
      expect(await read).toMatchObject({text: "still serving"});

      serving.exit();                                              // the fifth REAL crash does count
      expect(events).toContain("HELPER_GAVE_UP");
    });

    it("if the old helper dies while the replacement warms up, the replacement takes over without a second start", async () => {
      await ready();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      void client.permission();
      const next = helpers.latest();
      helpers.all[0]?.exit();
      expect(client.state()).toBe("starting");
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
      expect(helpers.all).toHaveLength(2);
      next.ready();
      await settle();
      expect(client.state()).toBe("ready");
    });

    it("focus events from a replacement that has not taken over are ignored", async () => {
      let count = 0;
      client.onFocusChange(() => { count += 1; });
      helpers.latest().ready();
      await settle();
      await vi.advanceTimersByTimeAsync(HELPER_PLANNED_RESTART_MS);
      const held = client.read({budgetMs: 1500, expect: WINDOW});                  // keeps the old helper busy, so no swap
      const next = helpers.latest();
      next.ready();
      await settle();
      next.emit({event: "focus"});
      expect(count).toBe(0);
      helpers.all[0]?.answerLast({ok: true, window: WINDOW, text: "x"});
      await held;
    });
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --dir app test src/main/reader/readerClient.supervision.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 3: Reviewer's mutation probes** (scratch copy of `readerClient.ts`, run this file, restore)

| Mutation | Must fail |
|---|---|
| In `tryPromote`, delete `if (current && current.pending.size > 0) return;` | "after enough reads, warms a replacement up…" and "focus events from a replacement…" |
| In `read`, delete the line `helper.pending.delete(id);` inside the re-entry loop | "a read that was superseded and never answered does not hold the swap up" |
| In `noteExit`, change `exits.length >= HELPER_EXIT_LIMIT` to `exits.length > HELPER_EXIT_LIMIT` | "gives up after five unplanned exits…" |
| In the `ready` branch of `onLine`, delete `helper.retired = true;` | "never uses a helper that speaks another protocol…" (a `HELPER_EXIT` appears) |
| In `launch`, change `HELPER_START_DEADLINE_MS` to `CLIENT_CALL_DEADLINE_MS` | "allows a cold start of a minute and a half…" |

One mutation is known to survive and is NOT a test gap: in `gone`, replacing `if (!current) scheduleRestart();` with `scheduleRestart();` changes nothing observable, because `start()` refuses to run while `current` exists. Leave both guards.

- [ ] **Step 4: Checkpoint**

`verify-plan-code.py … 3` prints `mismatches: 0`.

---

### Task 4: The leak test

**Files:**
- Test: `app/src/main/reader/readerClient.leak.test.ts`

**Interfaces:**
- Consumes: `createReaderClient`, `ReaderDown`, `ReaderClientEvent`, `createFakeHelpers`, constants.

- [ ] **Step 1: Write the test**

`app/src/main/reader/readerClient.leak.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers} from "../testing/fakeReaderHelper";
import {CLIENT_CALL_DEADLINE_MS, HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT} from "./constants";
import {createReaderClient, ReaderDown, type ReaderClientEvent} from "./readerClient";

const MARKER = "SECRET-ON-SCREEN-4471";
/** The title main approved, which protocol 2 puts on the wire. A window title is the user's too. */
const APPROVED = "SECRET-WINDOW-TITLE-9082";
const EVENT_CODES: readonly ReaderClientEvent[] = ["HELPER_EXIT", "HELPER_START_TIMEOUT", "HELPER_WEDGED", "HELPER_PROTOCOL_MISMATCH", "HELPER_GAVE_UP", "HELPER_REPLACED"];

describe("reader client: nothing read from a screen leaves through a side channel", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("events are bare codes, errors carry no text, and nothing is written to the console or stderr", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });

    const helpers = createFakeHelpers();
    const events: unknown[][] = [];
    const client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (...args: unknown[]) => { events.push(args); }});
    const window = {app: MARKER, title: MARKER};

    void client.permission();
    helpers.latest().ready();
    await vi.advanceTimersByTimeAsync(0);

    const read = client.read({budgetMs: 1500, expect: {app: MARKER, bundleId: MARKER, title: APPROVED}});
    helpers.latest().answerLast({ok: true, window, text: MARKER, toolbarText: MARKER});
    expect(await read).toMatchObject({text: MARKER});                       // the caller gets it; nobody else does

    // The approved title goes to the helper's stdin and nowhere else. It reaches the one process
    // that has to know it, on the one channel that is meant to carry it, and the assertions at the
    // end of this test say that no event, error, console line or stream ever saw it.
    expect(helpers.latest().lastRead().expect).toEqual({app: MARKER, bundleId: MARKER, title: APPROVED});

    const bad = client.read({budgetMs: 1500, expect: {app: MARKER, title: APPROVED}});
    helpers.latest().emitRaw(`{"id": oops ${MARKER}`);                       // an unreadable line full of screen text
    await bad;

    const errors: unknown[] = [];
    const front = client.frontWindow().catch((error: unknown) => { errors.push(error); });
    await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);             // wedged → killed → HELPER_WEDGED, HELPER_EXIT
    await front;
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
      helpers.latest().emitRaw(MARKER);
      helpers.latest().exit();
    }
    await client.dispose();

    expect(events.length).toBeGreaterThan(3);
    for (const args of events) {
      expect(args).toHaveLength(1);
      expect(EVENT_CODES).toContain(args[0]);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ReaderDown);
    expect(String((errors[0] as Error).message)).toBe("READER_DOWN");
    expect(JSON.stringify((errors[0] as Error).stack ?? "")).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(APPROVED);
    expect(JSON.stringify(events)).not.toContain(APPROVED);
    expect(JSON.stringify(errors.map((error) => [(error as Error).message, (error as Error).stack ?? ""]))).not.toContain(APPROVED);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --dir app test src/main/reader/readerClient.leak.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 3: Reviewer's probe**

In a scratch copy of `readerClient.ts`, change the unreadable-line branch of `onLine` to start with `process.stderr.write(line);`. The leak test must fail. Restore.

- [ ] **Step 4: Checkpoint**

`verify-plan-code.py … 4` prints `mismatches: 0`.

---

### Task 5: The real child-process link

**Files:**
- Create: `app/src/shell/readerLink.ts`
- Create: `app/src/shell/testing/fakeHelperProcess.mjs`
- Test: `app/src/shell/readerLink.test.ts`

**Interfaces:**
- Consumes: `HelperLink` (Task 1), `createReaderClient` (Task 2).
- Produces: `createChildHelperLink(spawnChild: () => ChildProcessWithoutNullStreams): HelperLink`. C-2 will call it with `spawn(<path to clave-reader>, [], {stdio: ["pipe", "pipe", "pipe"]})`.

- [ ] **Step 1: Write the scripted helper process**

`app/src/shell/testing/fakeHelperProcess.mjs`:
```js
// A scripted stand-in for the native reader helper, as a REAL child process, for readerLink.test.ts.
// argv[2]: "normal" (default) | "stubborn" (ignores its input being closed) | "noisy" (also writes to
// stderr) | "overlong" (answers its first call with one line past main's cap, then behaves)
import {writeSync} from "node:fs";
import {createInterface} from "node:readline";

const mode = process.argv[2] ?? "normal";
const say = (message) => process.stdout.write(JSON.stringify(message) + "\n");
// A blocking write straight to fd 2, as a native helper would do it: if the parent does not drain
// stderr, this never returns and `ready` is never sent.
if (mode === "noisy") writeSync(2, "STDERR-NOISE-MUST-BE-IGNORED\n".repeat(20000));
say({event: "ready", protocol: 2});

// The one window this stand-in ever has in front. Protocol 2: a read says which window main
// approved, and anything else is refused without a capture — so this fake refuses too, which is how
// readerLink.test.ts can see that `expect` really travelled down the pipe.
const FRONT = {app: "Fake", title: "fake window"};
const approved = (expect) => expect !== null && typeof expect === "object"
  && expect.app === FRONT.app && expect.title === FRONT.title && expect.bundleId === undefined;

// One line longer than HELPER_MAX_LINE_CHARS (2,000,000), written once: a helper with a runaway
// buffer, seen from the other end of a real pipe. Main must refuse it without holding it.
let flooded = false;

const lines = createInterface({input: process.stdin});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.op === "shutdown") { if (mode !== "stubborn") process.exit(0); return; }
  if (mode === "overlong" && !flooded) { flooded = true; process.stdout.write(`${"x".repeat(2_100_000)}\n`); return; }
  if (message.op === "permission") say({id: message.id, permission: "granted"});
  else if (message.op === "frontWindow") say({id: message.id, window: FRONT});
  else if (message.op === "read") {
    say({event: "focus"});
    if (!approved(message.expect)) say({id: message.id, ok: false, reason: "windowGone"});
    else say({id: message.id, ok: true, window: FRONT, text: "line one\nlínea dos ✓", stats: {captureMs: 3, cacheHit: false}});
  }
  else if (message.op === "requestPermission") say({id: message.id});
});
lines.on("close", () => { if (mode !== "stubborn") process.exit(0); });
if (mode === "stubborn") setInterval(() => undefined, 1000);
```

- [ ] **Step 2: Write the failing test**

`app/src/shell/readerLink.test.ts`:
```ts
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {HELPER_MAX_LINE_CHARS} from "../main/reader/constants";
import {parseLine} from "../main/reader/protocol";
import {createReaderClient, type ReaderClientEvent} from "../main/reader/readerClient";
import {createChildHelperLink, createLineSplitter, HELPER_OVERLONG_LINE, PRE_REGISTRATION_LINES_MAX} from "./readerLink";

const SCRIPT = fileURLToPath(new URL("./testing/fakeHelperProcess.mjs", import.meta.url));
const helper = (mode: string) => () => createChildHelperLink(() => spawn(process.execPath, [SCRIPT, mode], {stdio: ["pipe", "pipe", "pipe"]}));

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A child process just real enough for the link: the three streams and the two events it listens to. */
function fakeChild(): ChildProcessWithoutNullStreams & {stdout: PassThrough} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true
  });
  return child as unknown as ChildProcessWithoutNullStreams & {stdout: PassThrough};
}

/** Long enough for what was written to a stream to reach the link. */
const flushed = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

describe("reader link: lines that arrive before the client is listening", () => {
  // Delivered on a later turn, never from inside `onLine`: the client registers `onLine` before it
  // has put the new helper into `current` or `replacement`, so a line handed back re-entrantly is
  // handled against a helper the client does not know about yet. That cost it a `ready` — a
  // mismatching one used to wedge it in "starting" for ever. The client is robust against it now
  // (`readerClient.test.ts`), and this end keeps its side of the bargain as well.
  it("delivers them, in order, on a later turn — never from inside `onLine`", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    child.stdout.write('{"event":"ready","protocol":2}\n{"event":"focus"}\n');
    await flushed();                               // the helper has spoken; nobody was listening yet

    const seen: string[] = [];
    link.onLine((line) => seen.push(line));
    expect(seen).toEqual([]);                      // not re-entrantly, from inside the registration
    // A line that arrives in the gap must not overtake them: order is order, whatever the timing.
    child.stdout.emit("data", Buffer.from('{"id":1,"permission":"granted"}\n'));
    expect(seen).toEqual([]);
    await flushed();
    expect(seen).toEqual(['{"event":"ready","protocol":2}', '{"event":"focus"}', '{"id":1,"permission":"granted"}']);

    child.stdout.write('{"id":2,"permission":"denied"}\n');
    await flushed();
    expect(seen).toHaveLength(4);                  // and from then on straight through
  });

  // Bounded, and what overflows is the END of the burst: the beginning is `ready`, which is the
  // whole reason to keep anything. Filling these already means the client broke its half of the
  // contract, so the lines that go are answers to calls nobody made.
  it("holds a bounded number of them, keeping the first: a helper talking into the void cannot grow main", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    child.stdout.write('{"event":"ready","protocol":2}\n');
    for (let i = 0; i < PRE_REGISTRATION_LINES_MAX + 36; i++) child.stdout.write(`{"id":${i}}\n`);
    await flushed();

    const seen: string[] = [];
    link.onLine((line) => seen.push(line));
    await flushed();
    expect(seen).toHaveLength(PRE_REGISTRATION_LINES_MAX);
    expect(seen[0]).toBe('{"event":"ready","protocol":2}');                   // the line it is all for
    expect(seen[1]).toBe('{"id":0}');
    expect(seen.at(-1)).toBe(`{"id":${PRE_REGISTRATION_LINES_MAX - 2}}`);     // and the newest went
  });
});

describe("reader link: a pipe that fails", () => {
  /**
   * An `error` event with no listener is thrown — in Electron's main process, which is the one
   * process the user cannot afford to lose, for a helper that is replaceable. stdin has had a
   * listener since C-1 (a write to a helper that has just died is an EPIPE); the read ends are the
   * same hazard from the other direction, and the helper's death arrives through `exit` regardless.
   */
  it("survives an error on any of the three pipes, and keeps working", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    const seen: string[] = [];
    link.onLine((line) => seen.push(line));

    expect(() => child.stdout.emit("error", new Error("EIO"))).not.toThrow();
    expect(() => child.stderr.emit("error", new Error("EIO"))).not.toThrow();
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();

    child.stdout.write('{"event":"focus"}\n');
    await flushed();
    expect(seen).toEqual(['{"event":"focus"}']);
  });
});

describe("reader link: the line splitter", () => {
  const collect = (): {lines: string[]; splitter: ReturnType<typeof createLineSplitter>} => {
    const lines: string[] = [];
    return {lines, splitter: createLineSplitter((line) => lines.push(line))};
  };

  it("splits several lines out of one chunk, and joins one line out of several chunks", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.push(Buffer.from("3}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(splitter.pending()).toBe(0);
  });

  it("strips a carriage return, and keeps an empty line empty", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"a":1}\r\n\r\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', "", '{"b":2}']);
  });

  it("keeps a character whose bytes are split across two chunks", () => {
    const {lines, splitter} = collect();
    const bytes = Buffer.from('{"text":"línea dos ✓"}\n');
    splitter.push(bytes.subarray(0, 12));          // cuts the í in half
    splitter.push(bytes.subarray(12, 22));         // and the ✓ too
    splitter.push(bytes.subarray(22));
    expect(lines).toEqual(['{"text":"línea dos ✓"}']);
  });

  it("drops a line that was never terminated when the stream ends", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"half":'));
    splitter.end();
    expect(lines).toEqual([]);
    expect(splitter.pending()).toBe(0);
  });

  // Ten megabytes and no newline: `readline` would have held every byte of it in main, because the
  // cap used to be checked only once the line had arrived.
  it("never buffers a line past the cap, and reports it exactly once", () => {
    const {lines, splitter} = collect();
    const chunk = Buffer.from("x".repeat(1_000_000));
    for (let i = 0; i < 10; i++) {
      splitter.push(chunk);
      expect(splitter.pending()).toBeLessThanOrEqual(HELPER_MAX_LINE_CHARS + chunk.length);
    }
    expect(lines).toEqual([HELPER_OVERLONG_LINE]);
    expect(splitter.pending()).toBe(0);

    splitter.push(Buffer.from('\n{"back":"in step"}\n'));   // the rest of it, then a real line
    expect(lines).toEqual([HELPER_OVERLONG_LINE, '{"back":"in step"}']);
  });

  it("reports an over-long line that does end, rather than handing it on to be refused later", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from(`${"x".repeat(HELPER_MAX_LINE_CHARS + 1)}\n{"next":1}\n`));
    expect(lines).toEqual([HELPER_OVERLONG_LINE, '{"next":1}']);
  });

  it("keeps a line of exactly the cap, which is what the parser still accepts", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from(`${"x".repeat(HELPER_MAX_LINE_CHARS)}\n`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(HELPER_MAX_LINE_CHARS);
  });

  // The marker stands in for a line the client must refuse: it only behaves like the over-long line
  // it replaces because the protocol's own parser throws it away.
  it("reports it with something the protocol parser refuses", () => {
    expect(parseLine(HELPER_OVERLONG_LINE)).toBeNull();
  });
});

describe("reader link: a real child process speaking the line protocol", () => {
  it("carries every call through the client, accents and symbols intact, and leaves when asked", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({spawn: helper("normal"), now: () => Date.now(), onEvent: (e) => events.push(e)});
    let focus = 0;
    client.onFocusChange(() => { focus += 1; });
    await until(() => client.state() === "ready");

    expect(await client.permission()).toBe("granted");
    expect(await client.frontWindow()).toEqual({app: "Fake", title: "fake window"});
    expect(await client.read({budgetMs: 1500, expect: {app: "Fake", title: "fake window"}}))
      .toEqual({ok: true, window: {app: "Fake", title: "fake window"}, text: "line one\nlínea dos ✓"});
    // The approved window really travelled down the pipe: this helper refuses anything else, and
    // the answer's own `stats` is stripped by the port before the caller ever sees it.
    expect(await client.read({budgetMs: 1500, expect: {app: "1Password", title: "Vault"}}))
      .toEqual({ok: false, reason: "windowGone"});
    expect(focus).toBe(2);
    await client.requestPermission();

    await client.dispose();
    expect(events).toEqual([]);                                  // a clean shutdown is not a crash
  });

  it("is not blocked by a helper that floods its stderr", async () => {
    const client = createReaderClient({spawn: helper("noisy"), now: () => Date.now()});
    void client.permission();
    await until(() => client.state() === "ready");
    expect(await client.permission()).toBe("granted");
    await client.dispose();
  });

  it("kills a helper that ignores both shutdown and its input being closed", async () => {
    const client = createReaderClient({spawn: helper("stubborn"), now: () => Date.now()});
    void client.permission();
    await until(() => client.state() === "ready");
    const started = Date.now();
    await client.dispose();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);    // it was given its grace period first
  }, 10_000);

  // The cap in the splitter and the cap in `parseLine` have to agree end to end: an over-long line
  // costs the call that was in flight and nothing else — the helper is not killed (C-1 decision D6)
  // and the pipe is back in step at the next newline.
  it("loses the call a helper answers with a line past the cap, and nothing else", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({spawn: helper("overlong"), now: () => Date.now(), onEvent: (e) => events.push(e)});
    void client.permission();
    await until(() => client.state() === "ready");

    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("ready");
    expect(await client.permission()).toBe("granted");
    expect(events).toEqual([]);
    await client.dispose();
  });

  it("a binary that does not exist shows up as an exit, not as a thrown error", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({
      spawn: () => createChildHelperLink(() => spawn("/nonexistent/clave-reader", [], {stdio: ["pipe", "pipe", "pipe"]})),
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    expect(await client.permission()).toBe("unknown");
    await until(() => events.includes("HELPER_EXIT"));
    await client.dispose();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --dir app test src/shell/readerLink.test.ts`
Expected: FAIL — cannot resolve `./readerLink`.

- [ ] **Step 4: Write the link**

`app/src/shell/readerLink.ts`:
```ts
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {StringDecoder} from "node:string_decoder";
import {HELPER_MAX_LINE_CHARS} from "../main/reader/constants";
import type {HelperLink} from "../main/reader/protocol";

/**
 * What an over-long line is replaced with. It is deliberately not JSON, so `parseLine` refuses it
 * exactly as it would have refused the line itself: everything in flight on that helper settles as
 * "down" and the helper keeps its life (C-1 decision D6). It carries nothing of what it replaces —
 * a fixed string cannot leak a fragment of a screen into the report of its own rejection.
 */
export const HELPER_OVERLONG_LINE = "!over-long line discarded";

/** How many lines a link holds for a client that has not registered `onLine` yet. */
export const PRE_REGISTRATION_LINES_MAX = 64;

export interface LineSplitter {
  push(chunk: Buffer): void;
  /** The stream ended. A line still in progress was never terminated, so it is dropped, not delivered half-read. */
  end(): void;
  /** How many characters are held for the line in progress. Never more than the cap plus one chunk. */
  pending(): number;
}

/**
 * The helper's stdout, as lines, with the length cap applied WHILE reading.
 *
 * Why not `readline`: it accumulates an unterminated line without any limit, and the cap in
 * `parseLine` is only consulted once the line finally arrives. A helper that writes bytes and no
 * newline — wedged, confused, or hostile — therefore makes main hold every one of them: hundreds of
 * megabytes in the one process the user cannot afford to lose. Here the line in progress is cut the
 * moment it goes past `HELPER_MAX_LINE_CHARS`, the rest of it is dropped as it arrives, and what the
 * client sees is one marker line that its parser refuses, which is exactly what it saw before.
 *
 * `StringDecoder` rather than `chunk.toString()` because the boundary between two chunks falls
 * wherever the pipe's buffer happened to end: decoding each chunk on its own turns any multi-byte
 * character straddling that boundary into replacement characters, and the text of a read is full of
 * them (`í`, `✓`, every emoji a chat window contains).
 */
export function createLineSplitter(deliver: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let held = "";
  /** The line in progress went over the cap: its remaining bytes are dropped, up to its newline. */
  let discarding = false;

  /** One complete line: `held` plus this chunk's share of it, the terminator already removed. */
  function finish(tail: string): void {
    if (discarding) { discarding = false; return; }        // the end of the line we gave up on
    if (held.length + tail.length > HELPER_MAX_LINE_CHARS) {
      held = "";
      deliver(HELPER_OVERLONG_LINE);                       // over the cap, terminator or no terminator
      return;
    }
    const line = held + tail;
    held = "";
    deliver(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      let from = 0;
      for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", from)) {
        finish(text.slice(from, at));
        from = at + 1;
      }
      if (discarding || from >= text.length) return;
      held += text.slice(from);
      // The cap is checked here, per chunk, so the most that is ever held is the cap plus one chunk.
      if (held.length > HELPER_MAX_LINE_CHARS) {
        held = "";
        discarding = true;
        deliver(HELPER_OVERLONG_LINE);                     // once for the line, however many chunks it takes
      }
    },
    end() { held = ""; discarding = false; },
    pending: () => held.length
  };
}

/**
 * The native reader helper as a child process: one JSON line per message on its stdin and stdout.
 * Its stderr is drained and thrown away — it is never logged, so nothing the helper might print
 * about a screen can reach a file.
 */
export function createChildHelperLink(spawnChild: () => ChildProcessWithoutNullStreams): HelperLink {
  const child = spawnChild();
  child.stderr.resume();
  // A pipe that fails — writing to a helper that has just died (EPIPE), or a read end the OS tears
  // down under us — reaches node as an `error` event, and an `error` event with NO listener is
  // thrown: an uncaught exception in Electron's main process, the one process the user cannot
  // afford to lose, for a helper that is replaceable. There is nothing to do about it here but not
  // die: the helper going away arrives on its own through `exit`, and every call in flight settles
  // with it. All three pipes, because all three are the same hazard.
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", () => undefined);

  let sink: ((line: string) => void) | null = null;
  /**
   * Lines the helper wrote before `onLine` was registered. `HelperLink` asks the client to register
   * in the same turn as `spawn()`, and the client does; this holds the contract up anyway, because
   * the line that would be lost is `ready` and the price of losing it is the full 90 s start
   * deadline.
   *
   * Bounded, because a helper talking into the void — the very case where nobody will ever call
   * `onLine` — must not grow main's memory one line at a time. And when the bound is reached the
   * NEWEST are dropped, not the oldest: what a late registration loses is the beginning of the
   * conversation, and the beginning is `ready`, the whole reason to keep anything at all. Filling
   * these 64 already means the client broke its half of the contract, so the later lines are answers
   * to calls that were never made — worth less than the first line in any case.
   */
  const early: string[] = [];
  /**
   * A flush is on its way. Until it has run, a line that arrives queues behind the held ones rather
   * than going straight to the sink: what was said first is delivered first, whatever the timing.
   */
  let flushing = false;
  const splitter = createLineSplitter((line) => {
    if (sink && !flushing) { sink(line); return; }
    if (early.length < PRE_REGISTRATION_LINES_MAX) early.push(line);
  });
  child.stdout.on("data", (chunk: Buffer) => { splitter.push(chunk); });

  let exited = false;
  const exitCallbacks: Array<() => void> = [];
  const leave = (): void => {
    if (exited) return;
    exited = true;
    splitter.end();
    for (const cb of exitCallbacks.splice(0)) cb();
  };
  child.once("exit", leave);
  child.once("error", leave);           // the binary could not be started at all

  return {
    send(line) { if (!exited && child.stdin.writable) child.stdin.write(`${line}\n`); },
    /**
     * On a later turn, never from inside this call. The client registers `onLine` as part of
     * starting a helper, and a line handed back re-entrantly would be handled while that is still
     * going on — against a helper whose exit callback is not registered and which is not yet in the
     * client's own hands. The client is written to survive that now, but a link that never does it
     * is the half of the contract this file owns.
     */
    onLine(cb) {
      sink = cb;
      if (early.length === 0) return;
      flushing = true;
      queueMicrotask(() => {
        const held = early.splice(0);
        flushing = false;
        for (const line of held) cb(line);
      });
    },
    onExit(cb) { if (exited) cb(); else exitCallbacks.push(cb); },
    closeInput() { if (!child.stdin.destroyed) child.stdin.end(); },
    kill() { child.kill("SIGKILL"); }
  };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --dir app test src/shell/readerLink.test.ts`
Expected: PASS, 4 tests (one of them waits out the 1 s grace period, so about 1.3 s in total).

- [ ] **Step 6: Reviewer's probes**

(a) In a scratch copy of `readerLink.ts` delete `child.stderr.resume();`: "is not blocked by a helper that floods its stderr" must fail (the fixture writes 580 KB to fd 2 with a BLOCKING write, as a native helper would; `process.stderr.write` is asynchronous for pipes on macOS and would not block, which is why the fixture does not use it). That probe leaves a blocked fixture process behind: run `pkill -f fakeHelperProcess` afterwards. (b) Delete `child.once("error", leave);`: "a binary that does not exist…" must fail. (c) After the test run, `pgrep -fl fakeHelperProcess` must print nothing: no helper process may outlive the tests.

- [ ] **Step 7: Checkpoint**

`verify-plan-code.py … 5` prints `mismatches: 0`.

---

### Task 6: Whole-suite check and handoff

**Files:**
- Modify: `docs/HANDOFF.md` (the status table row for C and the dated block at the top of section 0)

- [ ] **Step 1: Run everything**

Run: `pnpm --dir app test` → expected `Tests  835 passed (835)` in 62 files. Run: `pnpm --dir app typecheck` → clean. Run: `pnpm --dir app smoke` → `SMOKE OK` (nothing is wired in, so this must be unchanged). Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-18-native-reader-c1-client.md` → `mismatches: 0`.

- [ ] **Step 2: Confirm nothing existing changed**

Run: `find app/src -newer docs/superpowers/plans/2026-09-18-native-reader-c1-client.md -type f` and confirm every path listed is one of the eleven files of this plan's File Structure.

- [ ] **Step 3: Update the handoff**

In `docs/HANDOFF.md`, with the Edit tool and without reflowing existing text: in the C row add "C-1 (TypeScript reader client) executed <date>: `app/src/main/reader/`, `app/src/shell/readerLink.ts`, 61 tests; not wired in"; in the dated block at the top of section 0 add one line: "Next: plan C-2 — the Rust helper `clave-reader` (spec 10.1 items 1, 2, 8–11, 13, 16, 17), wiring in `app/src/shell/app.ts`, log codes for the client's events, `reader:eval`. C-1's decisions D1–D8 are in `docs/superpowers/plans/2026-09-18-native-reader-c1-client.md`."

- [ ] **Step 4: Checkpoint**

Report the three command outputs and the file list of Step 2.

---

## Verification record (2026-09-18)

Every code block above was developed and run before this document was assembled, in a scratch workspace that linked `app/node_modules`, `app/src/core`, `app/src/main/ports` and `app/src/main/constants.ts` (so the code ran against the real port, parsers and types) and contained only the eleven new files. Results there: 59 tests in 5 files pass (17 protocol, 23 client, 14 supervision, 1 leak, 4 link with real child processes, accents and `✓` intact across the pipe); `tsc --noEmit` with the app's own `tsconfig.json` exits 0. This document was then generated from those files by script, so its blocks are byte-identical to what ran.
Mutation checks run while planning, each against the full reader test set: answering `null` from `frontWindow()` when down → 4 tests fail; swapping helpers under a call in flight → 2 fail; focus from any helper → 2 fail; removing the restart-loop guard → 1 fails; keeping a superseded read's id → 1 fails (this one survived at first; the test "a read that was superseded and never answered does not hold the swap up" was added because of it); writing an unreadable line to stderr → the leak test fails; removing the `try`/`catch` in `notifyFocus` → 1 fails; give-up off by one → 2 fail; a protocol mismatch counted as a crash → 1 fails; a 4 s start deadline → 2 fail; no `error` handler in the link → 1 fails; stderr not drained → 1 fails (this one survived twice: first because 58 KB fits in the pipe buffer, then because Node's own stderr writes do not block on macOS; the fixture now makes a blocking 580 KB write). One equivalent mutant is documented in Task 3.
NOT verified: the files inside `app/` itself (nothing was created there while planning), `imports.test.ts` over the new files, the 827 total, and `pnpm --dir app smoke`. Earlier plans in this repo had defects despite such checks, so the per-task reviews stay.

## Execution record (2026-09-18)

Tasks 1–5 executed by extraction (verifier 0 mismatches), reviewed independently: 13 of 13 mutation probes behaved as listed, six adversarial areas held. The review's Important finding I1 and Minors M1, M4 were fixed in one round (decisions D9–D11), each proven by reverting the fix and watching its test fail; the first M4 test the controller dictated could not fail (a six-hour clock advance aged every exit out of the ten-minute window) and was replaced. The code blocks in this document were then re-synchronised FROM the code, so they describe the fixed code: 61 tests (17 protocol, 24 client, 15 supervision, 1 leak, 4 link). The "Verification record" above describes the state before those fixes (59 tests). Deferred to plan C-2 as design inputs: `HelperLink.onLine` must be registered synchronously after spawn; cap line length in `readerLink.ts` before buffering; the automatic-restart path should retire a helper gracefully when calls are in flight; reviving after a protocol mismatch respawns the same binary once per subscription.

Task 6 (2026-09-18): `pnpm --dir app test` → 62 files, 835 passed; `pnpm --dir app typecheck` → exit 0; `pnpm --dir app smoke` → `SMOKE OK`; verifier → `mismatches: 0`; the only files changed under `app/src` are the eleven of this plan; no fixture process left running. The 829 this plan first predicted was the planner's arithmetic error: it forgot that `imports.test.ts` grows by two cases per new production file (57 → 63).

Update 2026-09-18 (C-2a, first real run): two defects found with the owner at the machine changed this client, and the blocks above were re-synchronised FROM the code again. (1) A helper that was already running when Screen Recording was granted kept answering `denied` (the system check is cached per process, and the helper never captures while denied): while the answer is `denied` the client now replaces the helper with a fresh one, not counted as a crash, at an interval that starts at 5 s and doubles to 60 s, reset by any other answer, by `requestPermission()` and by a new focus subscription; never after giving up. (2) `dispose()` now also owns helpers that were retired but have not exited yet. Separately the `Reader` port gained the failure `windowGone` (no front window at read time, or it vanished between steps), which this client passes through and the capture loop does not count as a fault. The per-file test counts quoted in the tasks above are those of the first execution; the reader folder now holds more tests (whole suite: 914).

## Self-review record

- Spec coverage: section 3 protocol → Task 1; section 4 re-entry, deadlines, supervision table (exit, backoff, five exits, planned restart, main dies is the helper's side → C-2, `dispose()`), focus subscribers → Tasks 2–3; "helper down" answers incl. the rejecting `frontWindow()` → Task 2 (D1, D2); 5.3 permission states and the single automatic restart → Task 2 (D4); section 7's TypeScript list: second read while the first is outstanding, stale id dropped, malformed line, helper dying mid-call, backoff and the stop after five exits, planned restart only between calls, protocol mismatch, several focus subscribers incl. one that throws and across a restart, `dispose()`, the leak test → Tasks 2–4; "a fake helper (a scripted child process speaking the protocol)" → Task 5. Spec 10.1 item 2's open decision → D1, with the 90 s start deadline and the warm replacement (D3). Out of this plan by design (C-2): the helper itself, wiring, log codes, `reader:eval`, `build:native`, the shell's start guard.
- One deviation from the spec's letter: section 4 says the planned restart happens "only while no call is outstanding"; this plan STARTS the replacement at any time and SWAPS only while no call is outstanding, which is what 10.1 item 2 requires.
- Type consistency: `HelperLink`'s five methods are the ones `fakeReaderHelper.ts`, `readerLink.ts` and `readerClient.ts` use; `ReaderClientEvent`'s six codes are the ones the leak test lists; test counts per file were taken from the run.
## Note 2026-09-19 (C-2b-1)

The code blocks above were re-synchronised from the code after plan C-2b-1 (`docs/superpowers/plans/2026-09-19-native-reader-c2b1-code.md`) changed these files: protocol 2 (`read` carries `expect`, numbers-only `stats`), a documented `HelperLink` contract with the id bound, draining instead of killing on the cure and denied-refresh paths, a protocol mismatch that is permanent for the life of the client, `needsRestart` for a `refused` answer after a give-up, a helper assigned to its slot before its callbacks are registered, and in `readerLink.ts` a line splitter that caps a line while reading it, a bounded pre-registration buffer flushed on a later turn, and error listeners on all three pipes. The test counts, mutation tables and the Verification record in this document describe C-1 as it was executed on 2026-09-18 and are history.
