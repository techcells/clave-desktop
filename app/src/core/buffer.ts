import {BUFFER_MAX_AGE_MS, MIN_READ_CHARS} from "./constants";
import type {ScrubbedRead} from "./types";

export interface ReadBuffer {
  accept(read: ScrubbedRead): "kept" | "unchanged" | "empty";
  expire(now: number): number;
  range(from: number, to: number): ScrubbedRead[];
  dropRange(from: number, to: number): void;
  clear(): void;
  size(): number;
  oldestAt(): number | null;
}

const keyOf = (read: ScrubbedRead) => JSON.stringify([read.app, read.title]);

/** The single owner of raw screen text. In memory only. */
export function createBuffer(): ReadBuffer {
  let reads: ScrubbedRead[] = [];
  let lastKey: string | null = null;
  let lastText: string | null = null;

  return {
    accept(read) {
      if (read.text.trim().length < MIN_READ_CHARS) return "empty";
      const key = keyOf(read);
      // The fingerprint belongs to the window in focus. Moving away forgets it, so the first read
      // of a window we come back to is never suppressed by a stale fingerprint.
      if (key === lastKey && read.text === lastText) return "unchanged";
      lastKey = key;
      lastText = read.text;
      reads.push(read);
      return "kept";
    },
    expire(now) {
      const before = reads.length;
      reads = reads.filter((r) => now - r.at <= BUFFER_MAX_AGE_MS);
      return before - reads.length;
    },
    range: (from, to) => reads.filter((r) => r.at >= from && r.at <= to),
    dropRange(from, to) { reads = reads.filter((r) => r.at < from || r.at > to); },
    clear() { reads = []; lastKey = null; lastText = null; },
    size: () => reads.length,
    oldestAt: () => (reads.length ? Math.min(...reads.map((r) => r.at)) : null)
  };
}
