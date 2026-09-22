import type {FrontWindow} from "../core/types";
import type {Reader} from "../main/ports/reader";

export interface DevWindow { app: string; title: string; text: string; toolbarText?: string }

/** Turns an `eval/fixtures/*.json` document into windows to replay. Anything malformed is skipped. */
export function windowsFromFixture(fixture: unknown): DevWindow[] {
  const reads = (fixture as {reads?: unknown} | null)?.reads;
  if (!Array.isArray(reads)) return [];
  return reads.flatMap((r: unknown): DevWindow[] => {
    const read = r as Partial<DevWindow> | null;
    if (typeof read?.app !== "string" || typeof read.title !== "string" || typeof read.text !== "string") return [];
    return [typeof read.toolbarText === "string"
      ? {app: read.app, title: read.title, text: read.text, toolbarText: read.toolbarText}
      : {app: read.app, title: read.title, text: read.text}];
  });
}

/**
 * STAND-IN for the native reader (sub-project C). Replays a list of windows, moving to the next
 * one every `dwellMs`, as if the user switched windows. Never part of a production build.
 */
export function createDevReader(windows: DevWindow[], dwellMs: number): Reader & {readonly standIn: true} {
  let index = 0;
  const listeners = new Set<() => void>();
  const timer = windows.length > 1
    ? setInterval(() => { index = (index + 1) % windows.length; for (const cb of listeners) cb(); }, dwellMs)
    : null;
  const current = () => windows[index];
  return {
    standIn: true,
    async permission() { return "granted"; },
    async requestPermission() { /* nothing to ask for */ },
    async frontWindow() { const w = current(); return w ? {app: w.app, title: w.title} : null; },
    async read(opts: {budgetMs: number; expect: FrontWindow}) {
      const w = current();
      // No window to replay, or the dwell timer moved on to another one since main approved this
      // read. Both are `windowGone` — a state of the screen — and never `failed`, which the loop
      // counts against the reader. A stand-in that lies about which of the two it is would train
      // the app on behaviour the real reader does not have.
      if (!w) return {ok: false, reason: "windowGone"};
      const window = {app: w.app, title: w.title};
      if (window.app !== opts.expect.app || window.title !== opts.expect.title || opts.expect.bundleId !== undefined) {
        return {ok: false, reason: "windowGone"};
      }
      return w.toolbarText === undefined ? {ok: true, window, text: w.text} : {ok: true, window, text: w.text, toolbarText: w.toolbarText};
    },
    onFocusChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async dispose() { if (timer) clearInterval(timer); listeners.clear(); }
  };
}
