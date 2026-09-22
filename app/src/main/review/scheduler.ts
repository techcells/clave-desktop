/** Local calendar day and minutes since local midnight for an instant. Injected so tests control the time zone. */
export type LocalTime = (epochMs: number) => {day: string; minutes: number};

export const systemLocalTime: LocalTime = (epochMs) => {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, minutes: d.getHours() * 60 + d.getMinutes()};
};

const HOUR_MS = 60 * 60_000;
/** A generous ceiling on how far a calendar day can be stepped back looking for "yesterday". */
const MAX_HOURS_BACK = 48;

/**
 * The most recent review moment at or before `now`: today at `reviewTime` if that has passed,
 * otherwise yesterday's. Returns the local day it belongs to.
 *
 * "Yesterday" is found by walking the local calendar back hour by hour, not by subtracting a fixed
 * 24h: a clock-change day (23 or 25 real hours) would otherwise land on the wrong calendar day.
 */
export function lastReviewDay(now: number, reviewTime: string, local: LocalTime): string {
  const [hours, minutes] = reviewTime.split(":").map(Number) as [number, number];
  const today = local(now);
  if (today.minutes >= hours * 60 + minutes) return today.day;
  for (let steps = 1; steps <= MAX_HOURS_BACK; steps++) {
    const day = local(now - steps * HOUR_MS).day;
    if (day !== today.day) return day;
  }
  return today.day; // unreachable in practice: no real calendar has a 48h day
}

export interface ReviewScheduler {
  /**
   * Call every minute, on launch and on wake. Prompts at most once per review moment, and never
   * when there is nothing to review. A moment missed while the app was closed or asleep is caught up once.
   */
  check(): Promise<void>;
}

export function createReviewScheduler(deps: {
  now: () => number; local: LocalTime;
  reviewTime: () => string; lastPromptDay: () => string | null; setLastPromptDay: (day: string) => Promise<void>;
  pendingCount: () => number; notify: (count: number) => void;
}): ReviewScheduler {
  // The review day this process has already handled. The stored day is the one that survives a
  // restart, but it may never be written at all (a full disk, or a `setLastPromptDay` that resolves
  // without having saved). Without a memory of its own, `check()` would then prompt every minute for
  // the rest of the day, so the day is kept here too: at most one prompt per review day per process.
  let handled: string | null = null;
  return {
    async check() {
      const day = lastReviewDay(deps.now(), deps.reviewTime(), deps.local);
      const last = deps.lastPromptDay();
      if (last !== null && last >= day) return;
      if (handled !== null && handled >= day) return;
      handled = day;
      // A failure to persist today's prompt day must not swallow today's prompt: the user still needs it.
      try { await deps.setLastPromptDay(day); } catch { /* still notify below */ }
      const count = deps.pendingCount();
      if (count > 0) deps.notify(count);
    }
  };
}
