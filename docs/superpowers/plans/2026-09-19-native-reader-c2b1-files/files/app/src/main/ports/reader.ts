import {z} from "zod";
import type {FrontWindow} from "../../core/types";

export type Permission = "granted" | "denied" | "needsRestart" | "unknown";
/**
 * Why a read produced no text.
 *
 * `windowGone` means there was no front window to capture, or it vanished between steps — a normal
 * state while windows change, not a reader fault. It was measured in the first real run: 6 of 36
 * reads answered instantly that way, every one of them mid app-switch or under an overlay app, and
 * counting them as faults switched capture off after five in ten minutes of ordinary window
 * switching.
 */
export type ReadFailure = "locked" | "black" | "timeout" | "failed" | "windowGone";
export type ReadResult =
  | {ok: true; window: FrontWindow; text: string; toolbarText?: string}
  | {ok: false; reason: ReadFailure};

/**
 * The native reader (sub-project C). It decides nothing and never sees the exclusion rules:
 * main asks the core `mayCapture` first and calls `read` only when that allows it.
 *
 * `read` names the window main approved in `expect`, and that is a hard limit on what may be
 * captured, not a hint. An implementation MUST capture only a window whose app, bundle id and title
 * all equal `expect` — bundle id compared as it arrives, so "absent" and "present" are different
 * windows — and MUST answer `{ok:false, reason:"windowGone"}` for anything else, having captured
 * nothing and recognised nothing. The reason is the gap: main asks the core about the front window
 * and then asks for it to be read, and in between the user can bring anything to the front — a
 * password manager, a private browser window, a chat main excluded by title. Without `expect` the
 * reader captures and recognises that window and hands main the text, which main then throws away:
 * nothing is kept, but the text of an explicitly excluded window has already crossed the pipe.
 *
 * Main gives up on a call that takes too long and moves on to the next cycle, but it has no way to
 * cancel the call it gave up on. So an implementation MUST assume that `frontWindow()` and `read()`
 * can each be called again while an earlier call is still running inside the reader, and MUST:
 *  - serialise internally, or cancel the earlier call, so two captures never run at once; and
 *  - never answer a later call with an earlier one's frame. Every answer must describe the screen as
 *    it was for THAT call: main checks the window around a read to decide whether the text may be
 *    kept, and a frame from an earlier cycle would pass that check while showing a window the core
 *    never allowed.
 * A call main has given up on may be abandoned entirely; whatever it eventually returns is dropped.
 */
export interface Reader {
  permission(): Promise<Permission>;
  requestPermission(): Promise<void>;
  frontWindow(): Promise<FrontWindow | null>;
  read(opts: {budgetMs: number; expect: FrontWindow}): Promise<ReadResult>;
  /** Returns the function that unsubscribes. */
  onFocusChange(cb: () => void): () => void;
  dispose(): Promise<void>;
}

const frontShape = z.object({app: z.string(), bundleId: z.string().optional(), title: z.string()});
const readShape = z.union([
  z.object({ok: z.literal(true), window: frontShape, text: z.string(), toolbarText: z.string().optional()}),
  z.object({ok: z.literal(false), reason: z.enum(["locked", "black", "timeout", "failed", "windowGone"])})
]);
const PERMISSIONS: readonly Permission[] = ["granted", "denied", "needsRestart", "unknown"];

/** The reader is another process: everything it sends is checked before use. */
export function parseFrontWindow(value: unknown): FrontWindow | null {
  const parsed = frontShape.safeParse(value);
  if (!parsed.success) return null;
  const {app, bundleId, title} = parsed.data;
  return bundleId === undefined ? {app, title} : {app, bundleId, title};
}

/** A malformed result counts as a failed read. */
export function parseReadResult(value: unknown): ReadResult {
  const parsed = readShape.safeParse(value);
  if (!parsed.success) return {ok: false, reason: "failed"};
  const data = parsed.data;
  if (!data.ok) return {ok: false, reason: data.reason};
  const window = parseFrontWindow(data.window) as FrontWindow;
  return data.toolbarText === undefined ? {ok: true, window, text: data.text} : {ok: true, window, text: data.text, toolbarText: data.toolbarText};
}

/** Anything that is not a known permission value is `unknown`, which blocks capture. */
export function parsePermission(value: unknown): Permission {
  return PERMISSIONS.includes(value as Permission) ? (value as Permission) : "unknown";
}
