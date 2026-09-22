import {describe, expect, it, vi} from "vitest";
import {createReviewScheduler, lastReviewDay, type LocalTime} from "./scheduler";

/** UTC as the "local" zone keeps the arithmetic readable. */
const utc: LocalTime = (ms) => { const d = new Date(ms); return {day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes()}; };
const at = (day: number, hours: number, minutes = 0) => Date.UTC(2026, 8, day, hours, minutes);

function setup(pending: number) {
  let now = at(17, 9);
  let last: string | null = null;
  let count = pending;
  const notify = vi.fn();
  const scheduler = createReviewScheduler({
    now: () => now, local: utc, reviewTime: () => "17:30",
    lastPromptDay: () => last, setLastPromptDay: async (day) => { last = day; },
    pendingCount: () => count, notify
  });
  return {scheduler, notify, setNow: (ms: number) => { now = ms; }, setPending: (n: number) => { count = n; }, last: () => last};
}

describe("review scheduler", () => {
  it("finds the most recent review moment", () => {
    expect(lastReviewDay(at(17, 17, 29), "17:30", utc)).toBe("2026-09-16");
    expect(lastReviewDay(at(17, 17, 30), "17:30", utc)).toBe("2026-09-17");
  });

  it("finds yesterday from the local calendar, not a fixed 24h, when the local day is shorter (DST-like)", () => {
    const HOUR = 3_600_000;
    const dayLenMs = 23 * HOUR; // a "day" here is 23 real hours long
    const base = Date.UTC(2026, 8, 1);
    const dayLabel = (index: number) => new Date(base + index * 24 * HOUR).toISOString().slice(0, 10);
    const shortDay: LocalTime = (ms) => {
      const index = Math.floor(ms / dayLenMs);
      const minutes = Math.floor((ms - index * dayLenMs) / 60_000);
      return {day: dayLabel(index), minutes};
    };
    // 00:30 into day index 5: the review time (17:30) has not been reached yet today.
    const now = 5 * dayLenMs + 30 * 60_000;
    // A fixed `now - 24h` would land in day index 3 (skipping a whole calendar day); stepping back
    // hour by hour must land on the immediately preceding calendar day, index 4.
    expect(lastReviewDay(now, "17:30", shortDay)).toBe(dayLabel(4));
  });

  it("prompts once at the review time, with the count", async () => {
    const {scheduler, notify, setNow} = setup(7);
    await scheduler.check();                       // 09:00, first launch: yesterday's moment, caught up once
    expect(notify).toHaveBeenCalledTimes(1);
    setNow(at(17, 17, 29)); await scheduler.check();
    expect(notify).toHaveBeenCalledTimes(1);
    setNow(at(17, 17, 30)); await scheduler.check();
    setNow(at(17, 17, 31)); await scheduler.check();
    setNow(at(17, 23, 0)); await scheduler.check();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(7);
  });

  it("stays silent when there is nothing to review, and does not prompt later that day", async () => {
    const {scheduler, notify, setNow, setPending} = setup(0);
    setNow(at(17, 17, 30)); await scheduler.check();
    setPending(4);
    setNow(at(17, 18, 0)); await scheduler.check();
    expect(notify).not.toHaveBeenCalled();
    setNow(at(18, 17, 30)); await scheduler.check();
    expect(notify).toHaveBeenCalledWith(4);
  });

  it("catches up once after the app was closed or asleep over the review time", async () => {
    const {scheduler, notify, setNow} = setup(3);
    setNow(at(17, 17, 30)); await scheduler.check();
    setNow(at(19, 8, 0)); await scheduler.check();   // closed for a day and a half
    setNow(at(19, 8, 1)); await scheduler.check();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("still notifies, and does not reject, when setLastPromptDay rejects", async () => {
    const notify = vi.fn();
    const scheduler = createReviewScheduler({
      now: () => at(17, 17, 30), local: utc, reviewTime: () => "17:30",
      lastPromptDay: () => null, setLastPromptDay: async () => { throw new Error("disk full"); },
      pendingCount: () => 5, notify
    });
    await expect(scheduler.check()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(5);
  });

  it("notifies once per review day, not every minute, when setLastPromptDay rejects", async () => {
    const notify = vi.fn();
    let now = at(17, 17, 30);
    const scheduler = createReviewScheduler({
      now: () => now, local: utc, reviewTime: () => "17:30",
      lastPromptDay: () => null, setLastPromptDay: async () => { throw new Error("disk full"); },
      pendingCount: () => 5, notify
    });
    for (let minute = 0; minute < 120; minute++) { now = at(17, 17, 30 + minute); await scheduler.check(); }
    expect(notify).toHaveBeenCalledTimes(1);
    now = at(18, 17, 30);                                    // the next review moment prompts again
    await scheduler.check();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies once per review day when setLastPromptDay resolves without having saved", async () => {
    // The engine's `settings.update` answers `{ok: false}` on a failed write: nothing was persisted
    // and nothing threw. Indistinguishable from a real save from here, so the in-memory day must hold.
    const notify = vi.fn();
    let now = at(17, 17, 30);
    const scheduler = createReviewScheduler({
      now: () => now, local: utc, reviewTime: () => "17:30",
      lastPromptDay: () => null, setLastPromptDay: async () => { /* resolves, saved nothing */ },
      pendingCount: () => 5, notify
    });
    for (let minute = 0; minute < 120; minute++) { now = at(17, 17, 30 + minute); await scheduler.check(); }
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify (but still does not reject) when setLastPromptDay rejects and there is nothing pending", async () => {
    const notify = vi.fn();
    const scheduler = createReviewScheduler({
      now: () => at(17, 17, 30), local: utc, reviewTime: () => "17:30",
      lastPromptDay: () => null, setLastPromptDay: async () => { throw new Error("disk full"); },
      pendingCount: () => 0, notify
    });
    await expect(scheduler.check()).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
