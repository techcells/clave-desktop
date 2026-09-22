import {SCENARIO_AWAY_MS, SCENARIO_IDLE_MS, SCENARIO_MAX_MS} from "../constants";

export type CloseReason = "idle" | "away" | "cap" | "off" | "locked";
export interface ClosedSpan { openedAt: number; closedAt: number; reason: CloseReason }

export interface Segmenter {
  activity(now: number): void;
  captureAllowed(now: number, allowed: boolean): void;
  kept(now: number): void;
  locked(now: number): void;
  unlocked(now: number): void;
  off(now: number): ClosedSpan | null;
  tick(now: number): ClosedSpan | null;
  isOpen(): boolean;
}

/** Tracks timestamps only. It never sees text. */
export function createSegmenter(): Segmenter {
  let openedAt: number | null = null;
  let lastActivityAt = 0;
  let awaySince: number | null = null;
  let lockedSince: number | null = null;

  const close = (closedAt: number, reason: CloseReason): ClosedSpan => {
    const span = {openedAt: openedAt as number, closedAt, reason};
    openedAt = null;
    awaySince = null;
    return span;
  };

  return {
    activity(now) { lastActivityAt = now; },
    captureAllowed(now, allowed) {
      if (allowed) awaySince = null;
      else if (awaySince === null) awaySince = now;
    },
    kept(now) { if (openedAt === null) { openedAt = now; lastActivityAt = now; awaySince = null; } },
    locked(now) { if (lockedSince === null) lockedSince = now; },
    unlocked() { lockedSince = null; },
    off(now) { return openedAt === null ? null : close(now, "off"); },
    tick(now) {
      if (openedAt === null) return null;
      if (lockedSince !== null && now - lockedSince > SCENARIO_IDLE_MS) return close(lockedSince, "locked");
      if (now - openedAt >= SCENARIO_MAX_MS) return close(now, "cap");
      if (awaySince !== null && now - awaySince >= SCENARIO_AWAY_MS) return close(awaySince, "away");
      if (lockedSince === null && now - lastActivityAt >= SCENARIO_IDLE_MS) return close(lastActivityAt, "idle");
      return null;
    },
    isOpen: () => openedAt !== null
  };
}
