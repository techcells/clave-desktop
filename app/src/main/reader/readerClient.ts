import type {FrontWindow} from "../../core/types";
import {parseFrontWindow, parseHelperReadResult, type Permission, type Reader, type ReadResult} from "../ports/reader";
import type {Now} from "../ports/system";
import {
  CLIENT_CALL_DEADLINE_MS, CLIENT_DENIED_REFRESH_MAX_MS, CLIENT_DENIED_REFRESH_MS, CLIENT_MAX_READ_BUDGET_MS, CLIENT_READ_GRACE_MS,
  HELPER_BACKOFF_FIRST_MS, HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT,
  HELPER_EXIT_WINDOW_MS, HELPER_HEALTHY_AFTER_MS, HELPER_PLANNED_RESTART_MS, HELPER_PLANNED_RESTART_READS,
  HELPER_SHUTDOWN_GRACE_MS, HELPER_START_DEADLINE_MS, READER_PROTOCOL
} from "./constants";
import {encode, isPlausibleGrantToken, parseHelperPermission, parseLine, type HelperLink, type ToHelper} from "./protocol";

/** Codes only. Nothing the helper read from a screen can travel through here. */
export type ReaderClientEvent =
  | "HELPER_EXIT" | "HELPER_START_TIMEOUT" | "HELPER_WEDGED" | "HELPER_PROTOCOL_MISMATCH" | "HELPER_GAVE_UP" | "HELPER_REPLACED";

export type ReaderClientState = "idle" | "starting" | "ready" | "waiting" | "gaveUp" | "disposed";

export interface ReaderClient extends Reader {
  state(): ReaderClientState;
  /**
   * Protocol 3. The screen-share grant main keeps (Linux: the ScreenCast portal's restore token).
   * Remembered, and handed to every helper once it is ready, including one started after a crash.
   * An implausible token is ignored. Other platforms' helpers ignore it.
   */
  grant(token: string): void;
  /** Protocol 3. Capture was switched off: the ready helper gives up whatever keeps the screen shared. */
  release(): void;
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
export function createReaderClient(deps: {
  spawn: () => HelperLink;
  now: Now;
  onEvent?: (event: ReaderClientEvent) => void;
  /** Protocol 3: a helper's fresh screen-share grant, for main to keep in place of the spent one. */
  onGrant?: (token: string) => void;
}): ReaderClient {
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

  /** The newest grant: main's, or a helper's fresher one. Every helper gets it once it is ready. */
  let grantToken: string | null = null;

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
    if (message.kind === "grant") {
      if (message.token === null) return;           // a token main would not keep: ignored, nothing fails
      // Any live helper's token is the newest: the portal spent the previous one to make it. The other
      // ready helper (a replacement waiting to take over) gets it at once, or it would restore with
      // the spent one and meet a dialog.
      grantToken = message.token;
      for (const other of [current, replacement]) {
        if (other && other !== helper && other.ready && !other.gone) send(other, {op: "grant", token: message.token});
      }
      try { deps.onGrant?.(message.token); } catch { /* an observer must never break the reader */ }
      return;
    }
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
      if (grantToken !== null) send(helper, {op: "grant", token: grantToken});
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
    grant(token: string): void {
      if (!isPlausibleGrantToken(token)) return;
      grantToken = token;
      if (current?.ready) send(current, {op: "grant", token});
    },

    release(): void {
      if (current?.ready) send(current, {op: "release"});
    },

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
      // No process to ask. It reaches the loop as `failed` — which is right, the reader failed to
      // read — but WHICH failure it is is something only this side knows: the helper cannot report
      // that it was never there. `helperDown` is that report, and it is the one detail in the closed
      // set that never comes over the pipe.
      if (!helper) return {ok: false, reason: "failed", detail: "helperDown"};
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
      // `down` is every way a call ends without an answer from the helper itself: it exited, we
      // killed it, or it sent a line that could not be read (`onLine` settles the lot as `down`).
      // The same detail as the no-helper case above, because it is the same fact — this read was
      // never answered by a helper — and the three are not worth separating: all of them say
      // "look at the helper, not at the capture".
      if (answer === "down") return {ok: false, reason: "failed", detail: "helperDown"};
      helper.reads += 1;
      // Whatever the helper said about which stage failed goes through the port's closed set, like
      // everything else it sends. Nothing here reads it, and nothing here passes a string through.
      // The WIRE set specifically: a helper may not claim `helperDown` about itself — that is this
      // function's own word for the two returns above, and only this side can know it.
      const result = parseHelperReadResult(answer);
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
