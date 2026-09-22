import {CoreError} from "../../core/errors";
import type {ModelConversation, ModelPort} from "../../core/types";
import {MODEL_CRASH_LIMIT, MODEL_CRASH_WINDOW_MS, MODEL_IDLE_UNLOAD_MS, MODEL_REQUEST_TIMEOUT_MS} from "../constants";
import type {Now} from "../ports/system";
import type {FromHost, HostLink, ToHost} from "./protocol";

export interface ModelClient extends ModelPort {
  /** True after `MODEL_CRASH_LIMIT` host exits within `MODEL_CRASH_WINDOW_MS`. Capture must go off. */
  broken(): boolean;
  /** "Try again" on the problem screen. */
  reset(): void;
  /** Kills the host. Used on quit and by "delete all local data". */
  shutdown(): void;
  onBroken(cb: () => void): () => void;
}

type Pending = {resolve(message: FromHost): void; reject(error: CoreError): void};

/**
 * The core's ModelPort over a supervised host process. The host is started on demand, restarted
 * after an exit, and stopped after ten idle minutes to give its memory back.
 */
export function createModelClient(deps: {spawn: () => HostLink; now: Now}): ModelClient {
  let link: HostLink | null = null;
  let nextId = 0;
  let open = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let exits: number[] = [];
  let isBroken = false;
  const pending = new Map<number, Pending>();
  const listeners = new Set<() => void>();

  // Bumped every time the current host goes away (crash or an exit we asked for). A conversation
  // remembers the generation it was opened on; once the counter has moved past it, the conversation's
  // host is gone for good and the conversation is stale, whatever new host may since have spawned.
  let generation = 0;

  function failAll(): void {
    for (const p of pending.values()) p.reject(new CoreError("MODEL_FAILED"));
    pending.clear();
  }

  function recordCrash(): void {
    const t = deps.now();
    exits = [...exits.filter((at) => t - at < MODEL_CRASH_WINDOW_MS), t];
    if (exits.length >= MODEL_CRASH_LIMIT && !isBroken) { isBroken = true; for (const cb of listeners) cb(); }
  }

  function teardown(): void {
    link = null; open = 0; generation += 1;
    failAll();
  }

  function ensure(): HostLink {
    if (link) return link;
    let started: HostLink;
    try { started = deps.spawn(); }
    catch (error) { recordCrash(); throw error; }
    started.onMessage((message) => {
      const p = pending.get(message.requestId);
      if (!p) return;
      pending.delete(message.requestId);
      if (message.type === "failed") p.reject(new CoreError("MODEL_FAILED")); else p.resolve(message);
    });
    started.onExit(() => {
      if (link !== started) return;          // an exit we asked for, already torn down
      teardown();
      recordCrash();
    });
    link = started;
    return started;
  }

  function request(build: (requestId: number) => ToHost): Promise<FromHost> {
    if (isBroken) return Promise.reject(new CoreError("MODEL_FAILED"));
    const requestId = ++nextId;
    return new Promise<FromHost>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) reject(new CoreError("MODEL_FAILED"));
      }, MODEL_REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      try { ensure().send(build(requestId)); }
      catch { pending.delete(requestId); clearTimeout(timer); reject(new CoreError("MODEL_FAILED")); }
    });
  }

  function stopHost(): void {
    const current = link;
    teardown();
    current?.kill();
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = open === 0 && link ? setTimeout(stopHost, MODEL_IDLE_UNLOAD_MS) : null;
  }

  return {
    async open(settings) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      // Every way out of this that is not a live conversation must leave the idle timer armed again:
      // a host that was spawned and then failed to answer would otherwise sit there for good, with
      // nothing counting it as idle and nothing ever unloading it.
      let opened: FromHost;
      try { opened = await request((requestId) => ({type: "open", requestId, settings})); }
      catch (error) { armIdle(); throw error; }
      if (opened.type !== "opened") { armIdle(); throw new CoreError("MODEL_FAILED"); }
      const conversationId = opened.conversationId;
      const myGeneration = generation;
      open += 1;
      // Cleared again here, not only on the way in: another `open()` that gave up while this one was
      // waiting for its reply re-arms the timer on its way out, and a live conversation must never
      // have the host unloaded from under it.
      armIdle();
      let closed = false;
      const conversation: ModelConversation = {
        async ask(userText, form, limits) {
          // Stale: this conversation's host is gone. Reject locally, never spawn a new one for it.
          if (myGeneration !== generation) throw new CoreError("MODEL_FAILED");
          const answer = await request((requestId) => ({type: "ask", requestId, conversationId, userText, form, maxTokens: limits.maxTokens}));
          if (answer.type !== "answer") throw new CoreError("MODEL_FAILED");
          return answer.value;
        },
        async close() {
          if (closed) return;
          closed = true;
          if (myGeneration !== generation) return;   // stale: resolve locally, send nothing, leave `open` alone
          open = Math.max(0, open - 1);
          // Armed BEFORE the reply is awaited: the conversation is over as far as this side is
          // concerned, so a host that never acknowledges the close must not add its request timeout
          // on top of the idle wait. A later `open()` clears this timer as usual.
          armIdle();
          try { await request((requestId) => ({type: "close", requestId, conversationId})); }
          catch { /* best-effort: close never rejects, even on a "failed" reply or a timeout */ }
        }
      };
      return conversation;
    },
    broken: () => isBroken,
    reset() { isBroken = false; exits = []; },
    shutdown() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; stopHost(); },
    onBroken(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}
