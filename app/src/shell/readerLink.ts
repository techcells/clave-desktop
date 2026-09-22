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
