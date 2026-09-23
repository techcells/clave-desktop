import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {createReaderClient, type ReaderClient, type ReaderClientEvent} from "../main/reader/readerClient";
import {createChildHelperLink} from "./readerLink";

/** Events that happen before the engine exists (a helper that cannot even start) are kept, up to this many. */
const EARLY_EVENTS_MAX = 50;

export interface RealReader {
  reader: ReaderClient;
  /** Hands the supervisor's events to the engine's log: first the ones kept so far, then every later one. */
  attach(sink: {noteReaderEvent(event: ReaderClientEvent): void}): void;
}

/**
 * Where the helper is looked for, in order. Next to the app's own executable comes first: inside the
 * bundle's `Contents/MacOS` is the layout in which the Screen Recording grant was measured to reach
 * the helper (phase 0, P1), and it is where a packaged build and the dev bundle put it. `dist/native`
 * is for a plain `electron .` run from the checkout. With neither present the first is reported.
 */
export function chooseHelperPath(candidates: readonly [string, ...string[]], exists: (path: string) => boolean): string {
  return candidates.find((path) => exists(path)) ?? candidates[0];
}

/**
 * The native reader (sub-project C) as the app uses it: the supervised client over the `clave-reader`
 * helper started as a plain child process. A missing helper is a start failure with a fixed code,
 * not a reader that fails forever: the build is incomplete and no amount of restarting cures it.
 */
export function createRealReader(deps: {
  helperPath: string;
  exists: (path: string) => boolean;
  spawnChild: (path: string) => ChildProcessWithoutNullStreams;
  now: () => number;
  /** Protocol 3: a fresh screen-share grant from the helper, to be kept in place of the spent one. */
  onGrant?: (token: string) => void;
  /** Protocol 4 (Linux): the GNOME extension started or stopped refusing the helper. */
  onExtension?: (refused: boolean) => void;
}): RealReader {
  if (!deps.exists(deps.helperPath)) throw new Error("READER_HELPER_MISSING");
  let sink: {noteReaderEvent(event: ReaderClientEvent): void} | null = null;
  const early: ReaderClientEvent[] = [];
  const reader = createReaderClient({
    spawn: () => createChildHelperLink(() => deps.spawnChild(deps.helperPath)),
    now: deps.now,
    ...(deps.onGrant ? {onGrant: deps.onGrant} : {}),
    ...(deps.onExtension ? {onExtension: deps.onExtension} : {}),
    onEvent: (event) => {
      if (sink) sink.noteReaderEvent(event);
      else if (early.length < EARLY_EVENTS_MAX) early.push(event);
    }
  });
  return {
    reader,
    attach(next) {
      sink = next;
      for (const event of early.splice(0)) next.noteReaderEvent(event);
    }
  };
}
