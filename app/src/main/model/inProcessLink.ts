import {createHostCore, type ModelBinding} from "./hostCore";
import type {FromHost, HostLink} from "./protocol";

/**
 * A HostLink with no process behind it: the host core runs in the caller's process. Used by the
 * evaluation gate (a command-line run has no Electron to fork from). The desktop app never uses it:
 * there the model lives in a utility process so a native crash cannot take the app down.
 */
export function createInProcessLink(deps: {binding: ModelBinding; modelPath: string}): HostLink {
  let onMessage: (message: FromHost) => void = () => undefined;
  let alive = true;
  const core = createHostCore({binding: deps.binding, modelPath: deps.modelPath, post: (message) => { if (alive) queueMicrotask(() => onMessage(message)); }});
  return {
    send(message) { if (alive) void core.onMessage(message); },
    onMessage(cb) { onMessage = cb; },
    onExit() { /* nothing here can exit on its own: a native crash takes the whole command down */ },
    kill() { if (!alive) return; alive = false; void core.shutdown(); }
  };
}
