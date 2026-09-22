/**
 * Test doubles for the staged-window harness. Nothing here is ever bundled: `imports.test.ts` holds
 * production code to importing nothing from this folder, the same way `src/main` does.
 *
 * The important one is `createFakeLink`: it keeps EVERY line the harness sent, which is how the
 * guard's tests assert the thing that matters most — that no `read` line was ever written at all.
 */
import type {HelperLink} from "../../main/reader/protocol";

export interface FakeLink extends HelperLink {
  /** Every line the harness wrote, in order. */
  sent: string[];
  /** The ops of those lines, for the assertions that only care about that. */
  ops(): string[];
  /** The helper says something. */
  emit(line: string): void;
  /** The helper goes away. */
  exit(): void;
  killed: boolean;
  inputClosed: boolean;
}

export function createFakeLink(): FakeLink {
  const sent: string[] = [];
  let sink: ((line: string) => void) | null = null;
  const exits: Array<() => void> = [];
  const link: FakeLink = {
    sent,
    killed: false,
    inputClosed: false,
    ops: () => sent.map((line) => {
      try { return (JSON.parse(line) as {op?: string}).op ?? ""; } catch { return ""; }
    }),
    send: (line) => { sent.push(line); },
    onLine: (cb) => { sink = cb; },
    onExit: (cb) => { exits.push(cb); },
    closeInput: () => { link.inputClosed = true; },
    kill: () => { link.killed = true; },
    emit: (line) => { sink?.(line); },
    exit: () => { for (const cb of exits.splice(0)) cb(); }
  };
  return link;
}

/** A scheduler that never fires by itself: a test that wants a timeout asks for one. */
export function createManualSchedule(): {schedule: (ms: number, fire: () => void) => () => void; fireAll: () => void; pending: () => number} {
  let timers: Array<{fire: () => void}> = [];
  return {
    schedule: (_ms, fire) => {
      const timer = {fire};
      timers.push(timer);
      return () => { timers = timers.filter((entry) => entry !== timer); };
    },
    fireAll: () => { for (const timer of timers.splice(0)) timer.fire(); },
    pending: () => timers.length
  };
}

/**
 * A helper that answers whatever the test says, line by line, as soon as it is asked.
 *
 * It replies from inside `send`, on a microtask, which is close enough to a real child process for
 * everything this harness does and keeps the tests free of timers.
 */
export function respondTo(link: FakeLink, answer: (request: Record<string, unknown>) => Record<string, unknown> | null): void {
  const original = link.send.bind(link);
  link.send = (line: string): void => {
    original(line);
    let request: Record<string, unknown>;
    try { request = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const body = answer(request);
    if (body === null) return;
    void Promise.resolve().then(() => { link.emit(JSON.stringify({id: request.id, ...body})); });
  };
}
