import type {Blocker, DownloadState, EngineStatus, ReviewView, UserSettings} from "../../shared/ipc";
import {COPY, NOTHING_READ} from "../copy";

/** The onboarding steps of spec section 7, in order. */
export const STEPS = ["pitch", "signIn", "model", "permission", "neverRead", "reviewTime", "done"] as const;
export type Step = typeof STEPS[number];

/**
 * Which onboarding step to show. Steps that the machine can verify (signed in, model ready and
 * checked, permission) are decided by the real state, not by a stored number, so onboarding
 * resumes correctly after a restart or after something was undone. Steps that are only "seen"
 * (pitch, never-read, review time, done) use `onboardingStep`: the COUNT of steps the user has
 * finished, in the order of `STEPS`. So it is 1 once the pitch has been read, 5 once "what is never
 * read" has been read, 6 once the review time has been chosen — which is what puts the LAST step,
 * "done", on the screen — and 7 once that step's own button has been pressed. Onboarding is over at
 * 7 and not at 6: a 6 that meant "over" would show the last step to nobody. A user who stored 6
 * before this rule existed simply sees "done" once.
 *
 * The problem blockers (MODEL_PROBLEM, READER_PROBLEM, STORAGE_PROBLEM, SETTINGS_NEED_REVIEW) have
 * no branch here on purpose: they are not onboarding steps but a working app that broke, and each
 * has its own sentence and fix button on the home screen (`firstBlocker`). Sending a user who
 * finished onboarding back into it because a disk write failed would hide the actual fix.
 */
export function onboardingStep(status: EngineStatus, settings: UserSettings): Step {
  const seen = settings.onboardingStep;
  const has = (b: Blocker) => status.blockers.includes(b);
  if (seen < 1) return "pitch";
  if (has("SIGNED_OUT")) return "signIn";
  if (has("MODEL_MISSING") || has("SELF_TEST_NEEDED")) return "model";
  if (has("NO_PERMISSION") || has("PERMISSION_NEEDS_RESTART")) return "permission";
  if (seen < 5) return "neverRead";
  if (seen < 6) return "reviewTime";
  return "done";
}

export type Screen = "onboarding" | "home" | "review" | "settings";
/**
 * Onboarding owns the window until every step has been finished — all `STEPS.length` of them,
 * the last one included — and after that the tabs are free.
 */
export const startScreen = (status: EngineStatus, settings: UserSettings): Screen =>
  (settings.onboardingStep < STEPS.length ? "onboarding" : status.pending > 0 ? "review" : "home");

/** The one problem shown on the home screen: the first blocker, in the engine's order. `null` when capture may run. */
export const firstBlocker = (status: EngineStatus): Blocker | null => status.blockers[0] ?? null;

export interface DownloadView { phase: "idle" | "running" | "paused" | "verifying" | "ready" | "error"; percent: number; errorCode: string | null }
export function downloadView(state: DownloadState, sizeBytes: number): DownloadView {
  const percent = (bytes: number) => (sizeBytes > 0 ? Math.min(100, Math.floor((bytes / sizeBytes) * 100)) : 0);
  switch (state.kind) {
    case "missing": return {phase: "idle", percent: 0, errorCode: null};
    case "partial": return {phase: "paused", percent: percent(state.receivedBytes), errorCode: null};
    case "downloading": return {phase: "running", percent: percent(state.receivedBytes), errorCode: null};
    case "verifying": return {phase: "verifying", percent: 100, errorCode: null};
    case "ready": return {phase: "ready", percent: 100, errorCode: null};
    case "error": return {phase: "error", percent: 0, errorCode: state.code};
  }
}

export interface ReviewRow { id: string; statement: string; target: string; kind: "skill" | "competency"; day: string }
/** Rows in the engine's order. `day` is the local calendar day the statement was captured. */
export function reviewRows(view: ReviewView, localDay: (epochMs: number) => string): ReviewRow[] {
  return view.pending.map((p) => ({id: p.id, statement: p.statement, target: p.targetName, kind: p.kind, day: localDay(p.createdAt)}));
}

export const gigabytes = (bytes: number): string => (bytes / 1_000_000_000).toFixed(1);

/**
 * The one quiet line for "reading is on and nothing has come through it for a long while", or `null`
 * when there is nothing to say. Both conditions are checked here and nowhere else:
 *
 * · `capture` must be `"on"`. The engine already clears `nothingRead` when the loop stops, so this is
 *   belt and braces — but a sentence that says "Reading is on" while the switch says otherwise is the
 *   one way this line could actively mislead, so it is refused rather than trusted.
 * · `nothingRead` must be set. It is not a blocker and has no fix button: `firstBlocker` never sees
 *   it, and the screen must not route it through the blocker path.
 *
 * `at` formats the epoch-ms `since` — injected, exactly as `reviewRows` takes `localDay`, so the time
 * zone and the locale belong to the screen and this stays a pure function.
 */
export function nothingReadLine(status: EngineStatus, at: (epochMs: number) => string): string | null {
  if (status.capture !== "on" || status.nothingRead === null) return null;
  // `EngineStatus` crosses IPC as unvalidated JSON (no zod schema): `why` is typed as the closed
  // `NothingReadWhy` union but nothing stops a stale renderer talking to a newer main process from
  // handing this a value outside it at runtime. `NOTHING_READ` is a plain object index, so that case
  // would otherwise produce `undefined`, which the template literal below would stringify into the
  // literal word "undefined" — worse than saying nothing, because it reads as a bug rather than as
  // the working app it still is. Refused here rather than trusted.
  const sentence = NOTHING_READ[status.nothingRead.why];
  if (sentence === undefined) return null;
  return `${sentence} ${COPY.home.since(at(status.nothingRead.since))}`;
}

/**
 * How long the permission step waits before it admits, in one extra line, that a long wait is normal.
 * Twenty seconds: long enough that the ordinary grant (noticed within a few seconds) never sees it,
 * short enough to arrive well before the user decides the app is broken.
 */
export const LONG_WAIT_MS = 20_000;

/**
 * Whether the permission step has been waiting long enough to say so. A pure function over two
 * timestamps rather than a timer of its own: the step already polls the grant every 1.5 s, and that
 * tick is what asks this question. `startedAt` is when the step appeared.
 */
export const stillWaiting = (startedAt: number, now: number): boolean => now - startedAt >= LONG_WAIT_MS;
