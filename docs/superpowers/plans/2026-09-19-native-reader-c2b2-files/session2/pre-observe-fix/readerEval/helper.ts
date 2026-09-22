/**
 * Protocol 2 with the native helper, spoken directly.
 *
 * The app's own `ReaderClient` is not used here, deliberately, and the reason is not convenience:
 * the port's parser strips `stats` and knows nothing of `lines`, and those two are most of what this
 * harness measures (`captureMs`, `recogniseMs`, `cacheHit`, the capture size, `bandPx`, and a box per
 * recognised line). So this speaks to the helper itself and keeps the answer body as it arrived. It
 * borrows the two pieces that must not be re-implemented: `HelperLink`/`parseLine` from the port's
 * own protocol module, and `createChildHelperLink` from the shell, so the evaluation is talking to
 * the helper over exactly the transport the product uses.
 *
 * The one thing it does NOT borrow is `encode`, because `read` here carries the evaluation-only
 * `lines` switch, which the app's `ToHelper` type has no member for and must not grow one — the
 * product's client must never be able to ask for line boxes. `helper.test.ts` pins the encoding
 * against `encode()` for the no-lines case, so the two cannot drift.
 */
import type {FrontWindow} from "../core/types";
import {parseHelperPermission, parseLine, type HelperLink} from "../main/reader/protocol";
import {EVAL_READ_BUDGET_MS} from "./thresholds";
import type {Approval} from "./guard";
import type {EvalPermission} from "./results";

/** An answer, or the fixed reason there is none. Never a message string. */
export type Answer =
  | {ok: true; body: Record<string, unknown>}
  | {ok: false; why: "timeout" | "down"};

export interface EvalHelperDeps {
  link: HelperLink;
  /** Starts a timer and returns its canceller. Injected so the tests never wait for a real clock. */
  schedule(ms: number, fire: () => void): () => void;
  /** How long any call may take. The read gets this on top of its budget. */
  callTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export interface EvalHelper {
  /** The protocol number the helper announced, or a failure. */
  waitReady(): Promise<Answer>;
  permission(): Promise<Answer>;
  frontWindow(): Promise<Answer>;
  /**
   * The only way to read. It takes an [`Approval`], which only `guard.ts` can mint, and it sends the
   * approved window back as `expect`: there is no overload, no option and no default that omits it.
   */
  readApproved(approval: Approval, options: {lines: boolean; budgetMs?: number}): Promise<Answer>;
  shutdown(): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** Protocol 2's `read` line, with the evaluation-only `lines` switch. */
export function encodeRead(id: number, budgetMs: number, expect: FrontWindow, lines: boolean): string {
  return JSON.stringify(lines ? {id, op: "read", budgetMs, expect, lines: true} : {id, op: "read", budgetMs, expect});
}

/** The window of an `ok` read answer, or `null` if the body is not shaped like one. */
export function readWindow(body: Record<string, unknown>): FrontWindow | null {
  const window = body.window;
  if (typeof window !== "object" || window === null || Array.isArray(window)) return null;
  const record = window as Record<string, unknown>;
  if (typeof record.app !== "string" || typeof record.title !== "string") return null;
  return typeof record.bundleId === "string"
    ? {app: record.app, bundleId: record.bundleId, title: record.title}
    : {app: record.app, title: record.title};
}

/**
 * The helper's answer to `permission`, as one of four fixed words.
 *
 * The product's own parser does the recognising, exactly as the private-window rule is the product's
 * own and not a copy: a helper answer is another process's JSON, and `body.permission` is a STRING
 * that this harness then writes into a file. `parseHelperPermission` returning `null` — an answer
 * that is not one of the helper's three words, or is not a string at all — becomes `unknown` here,
 * so nothing the helper said can ride into the results under this name.
 */
export function permissionOf(answer: Answer): EvalPermission {
  if (!answer.ok) return "unknown";
  return parseHelperPermission(answer.body) ?? "unknown";
}

/** A helper process that exists, and the clock reading taken immediately BEFORE it was spawned. */
export interface StartedHelper {
  helper: EvalHelper;
  spawnedAt: number;
}

/**
 * Spawn the helper, noting when.
 *
 * Synchronous, and that is the point. The clock is read BEFORE `start()` — `start` is what spawns
 * the process, since `createChildHelperLink` spawns inside its own body — so the interval
 * `waitReadyFrom` later reports covers process creation, the recogniser's warm-up and the `ready`
 * line: the quantity `HELPER_START_DEADLINE_MS` (90 s) is set against and the one phase 0 measured
 * at 43-45 s. Timed from anywhere else, from this process's own start or from the moment `waitReady`
 * was called, it would be a different quantity under the same name, so the clock is injected and
 * `helper.test.ts` pins which one it is.
 *
 * And it returns before anything is awaited, so the caller holds the helper first and waits second
 * — which is what lets `main.ts` put the wait inside the `try` whose `finally` shuts the helper
 * down. A single `await` that did both left a spawned process with nobody holding it if it threw.
 */
export function spawnHelper(deps: {start: () => EvalHelper; now: () => number}): StartedHelper {
  const spawnedAt = deps.now();
  return {helper: deps.start(), spawnedAt};
}

/** `ready` (or the fixed reason there was none), and how long it took from the spawn. */
export async function waitReadyFrom(
  started: StartedHelper,
  now: () => number
): Promise<{ready: Answer; readyMs: number}> {
  const ready = await started.helper.waitReady();
  return {ready, readyMs: now() - started.spawnedAt};
}

export function createEvalHelper(deps: EvalHelperDeps): EvalHelper {
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pending = new Map<number, (answer: Answer) => void>();
  let readyResolve: ((answer: Answer) => void) | null = null;
  let nextId = 1;
  let down = false;

  deps.link.onLine((line) => {
    const message = parseLine(line);
    if (message === null) return;                                  // not ours to interpret; the helper is a process
    if (message.kind === "focus") return;                          // the harness stages its own windows; focus is noise
    if (message.kind === "ready") {
      const settle = readyResolve;
      readyResolve = null;
      settle?.({ok: true, body: {protocol: message.protocol}});
      return;
    }
    const settle = pending.get(message.id);
    if (!settle) return;                                           // a late answer to a call that already gave up
    pending.delete(message.id);
    settle({ok: true, body: message.body});
  });

  deps.link.onExit(() => {
    down = true;
    const settle = readyResolve;
    readyResolve = null;
    settle?.({ok: false, why: "down"});
    for (const [id, waiting] of [...pending.entries()]) {
      pending.delete(id);
      waiting({ok: false, why: "down"});
    }
  });

  async function call(line: (id: number) => string, timeoutMs: number): Promise<Answer> {
    if (down) return {ok: false, why: "down"};
    const id = nextId;
    nextId += 1;
    return await new Promise<Answer>((resolve) => {
      let settled = false;
      const finish = (answer: Answer): void => {
        if (settled) return;
        settled = true;
        cancel();
        pending.delete(id);
        resolve(answer);
      };
      pending.set(id, finish);
      const cancel = deps.schedule(timeoutMs, () => { finish({ok: false, why: "timeout"}); });
      deps.link.send(line(id));
    });
  }

  return {
    async waitReady() {
      if (down) return {ok: false, why: "down"};
      return await new Promise<Answer>((resolve) => {
        let settled = false;
        const finish = (answer: Answer): void => {
          if (settled) return;
          settled = true;
          cancel();
          readyResolve = null;
          resolve(answer);
        };
        readyResolve = finish;
        const cancel = deps.schedule(readyTimeoutMs, () => { finish({ok: false, why: "timeout"}); });
      });
    },
    permission: async () => await call((id) => JSON.stringify({id, op: "permission"}), callTimeoutMs),
    frontWindow: async () => await call((id) => JSON.stringify({id, op: "frontWindow"}), callTimeoutMs),
    readApproved: async (approval, options) => {
      const budgetMs = options.budgetMs ?? EVAL_READ_BUDGET_MS;
      return await call((id) => encodeRead(id, budgetMs, approval.window, options.lines), budgetMs + callTimeoutMs);
    },
    shutdown() {
      deps.link.send(JSON.stringify({op: "shutdown"}));
      deps.link.closeInput();
    }
  };
}
