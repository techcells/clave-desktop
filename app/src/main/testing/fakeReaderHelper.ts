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
