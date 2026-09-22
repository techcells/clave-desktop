import type {FrontWindow} from "../../core/types";
import type {Permission, Reader, ReadResult} from "../ports/reader";

export interface FakeReader extends Reader {
  /** What is in front right now. Tests change this at will. `null` = nothing identifiable. */
  front: FrontWindow | null;
  text: string;
  toolbarText: string | undefined;
  permissionValue: Permission;
  /** When set, `read()` returns this instead of a good read. May be malformed on purpose. */
  nextRead: unknown;
  /** When set, `read()` does not resolve until `releaseRead()` is called. */
  holdReads: boolean;
  releaseRead(): void;
  /** Runs while a read is in progress, before it returns: the place to change `front` mid-read. */
  duringRead: (() => void) | null;
  reads: number;
  frontCalls: number;
  /** The window each `read()` was told main had approved, in order. */
  expects: FrontWindow[];
  focusChanged(): void;
  disposed: boolean;
}

/** The port's rule: same app, same title, same bundle id — "absent" and "present" are different windows. */
function sameWindow(a: FrontWindow, b: FrontWindow): boolean {
  return a.app === b.app && a.title === b.title && a.bundleId === b.bundleId;
}

export function createFakeReader(front: FrontWindow | null = {app: "Code", title: "query.sql"}): FakeReader {
  const listeners = new Set<() => void>();
  let release: (() => void) | null = null;
  const reader: FakeReader = {
    front, text: "", toolbarText: undefined, permissionValue: "granted", nextRead: undefined, holdReads: false, duringRead: null,
    reads: 0, frontCalls: 0, expects: [], disposed: false,
    releaseRead() { const r = release; release = null; r?.(); },
    focusChanged() { for (const cb of listeners) cb(); },
    async permission() { return reader.permissionValue; },
    async requestPermission() { /* the OS dialog; nothing to do in a fake */ },
    async frontWindow() { reader.frontCalls += 1; return reader.front; },
    async read(opts: {budgetMs: number; expect: FrontWindow}) {
      reader.reads += 1;
      reader.expects.push(opts.expect);
      // The window is taken here, at the start, exactly as the real helper resolves it before it
      // captures — so `duringRead` still models "the user switched while the picture was taken",
      // which the reader cannot see and main's own after-check is there to catch.
      const window = reader.front;
      if (reader.holdReads) await new Promise<void>((resolve) => { release = resolve; });
      reader.duringRead?.();
      if (reader.nextRead !== undefined) { const value = reader.nextRead; reader.nextRead = undefined; return value as ReadResult; }
      // Nothing in front, or something main never approved: a state of the screen, not a fault,
      // so `windowGone` and never `failed` — the port's rule, kept by the fake as well.
      if (!window || !sameWindow(window, opts.expect)) return {ok: false, reason: "windowGone"};
      return reader.toolbarText === undefined ? {ok: true, window, text: reader.text} : {ok: true, window, text: reader.text, toolbarText: reader.toolbarText};
    },
    onFocusChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async dispose() { reader.disposed = true; }
  };
  return reader;
}
