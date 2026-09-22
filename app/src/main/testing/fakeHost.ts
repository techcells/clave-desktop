import type {FromHost, HostLink, ToHost} from "../model/protocol";

export interface FakeHosts {
  spawn(): HostLink;
  /** How many host processes were started. */
  spawned: number;
  /** Every message sent to any host. */
  received: ToHost[];
  /** Answers for `ask`, in order. A missing answer means the host stays silent. */
  answers: unknown[];
  /** Makes the running host exit as if it had crashed. */
  crash(): void;
  alive(): boolean;
}

/** A scripted model host: opens and closes instantly, answers `ask` from a queue. */
export function createFakeHosts(answers: unknown[] = []): FakeHosts {
  let exit: (() => void) | null = null;
  const hosts: FakeHosts = {
    spawned: 0, received: [], answers,
    crash() { const e = exit; exit = null; e?.(); },
    alive: () => exit !== null,
    spawn() {
      hosts.spawned += 1;
      // A freshly started process would not remember conversation ids from a prior incarnation.
      let conversation = 0;
      let onMessage: (message: FromHost) => void = () => undefined;
      const reply = (message: FromHost) => queueMicrotask(() => onMessage(message));
      return {
        onMessage(cb) { onMessage = cb; },
        onExit(cb) { exit = cb; },
        kill() { exit = null; },
        send(message) {
          hosts.received.push(message);
          if (message.type === "open") reply({type: "opened", requestId: message.requestId, conversationId: ++conversation});
          else if (message.type === "ask") { if (hosts.answers.length > 0) reply({type: "answer", requestId: message.requestId, value: hosts.answers.shift()}); }
          else reply({type: "done", requestId: message.requestId});
        }
      };
    }
  };
  return hosts;
}
