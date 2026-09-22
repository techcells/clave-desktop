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
