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

/**
 * WHICH stage produced a `failed` read. A closed set of fixed identifiers, never a sentence and
 * never anything measured or read off a screen — the same rule the log's count keys live under,
 * because these end up as count keys.
 *
 * Why: `failed` is the one reason the loop counts against the reader, and five of them in ten
 * minutes switch reading off. That happened in real use — five failures in nine minutes, 129 good
 * reads around them, the helper alive throughout, no timeouts — and neither the log nor anything on
 * screen could say whether the grant had gone, macOS was refusing to capture, a capture was hanging
 * or the recogniser was erroring. One word for seven faults is not something anybody can act on.
 *
 * The first eight come from the helper (`FailDetail` in `native/reader/src/scheduler.rs`, same
 * camelCase words). `helperDown` is this side's own: the client answers `failed` when there is no
 * usable helper, when the helper went away under the call, or when it sent a line that could not be
 * read — none of which the helper can report about itself, and all of which look identical to a
 * broken capture until they are named.
 */
export type FailureDetail =
  | "noExpect" | "noGrant" | "captureRefused" | "captureTimeout" | "captureError" | "captureNoContent"
  | "captureNoImage" | "recogniseError"
  | "helperDown";

/** Every detail the app knows, whoever said it: what the loop tallies and what the log has keys for. */
export const FAILURE_DETAILS: readonly FailureDetail[] = [
  "noExpect", "noGrant", "captureRefused", "captureTimeout", "captureError", "captureNoContent",
  "captureNoImage", "recogniseError",
  "helperDown"
];

/**
 * The subset a HELPER is allowed to say — `FAILURE_DETAILS` without `helperDown`, and the set
 * `parseReadResult` checks against.
 *
 * Two sets rather than one because the two claims are different. `helperDown` means "this read was
 * never answered by a helper at all", and only the client can know that: it is the thing holding the
 * pipe. A helper saying it about itself is stale or lying, and believing it would put
 * `failedHelperDown` in the log and send whoever reads it to the supervisor while the fault is in
 * the capture. There is no privacy cost either way — it is a closed-set word — but a count that
 * names the wrong half of the system is exactly what this change exists to stop.
 */
export const WIRE_DETAILS: readonly FailureDetail[] = FAILURE_DETAILS.filter((detail) => detail !== "helperDown");

const DETAIL_SET: ReadonlySet<string> = new Set(FAILURE_DETAILS);
const WIRE_DETAIL_SET: ReadonlySet<string> = new Set(WIRE_DETAILS);

export type ReadResult =
  | {ok: true; window: FrontWindow; text: string; toolbarText?: string}
  /**
   * `detail` is present only on `failed`, only when it is one of the closed set, and only ever as
   * extra information: nothing decides anything on it. A reader that cannot say which stage failed
   * simply omits it, and the loop tallies that as `failedUnknown`.
   */
  | {ok: false; reason: ReadFailure; detail?: FailureDetail};

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

// `bandWithheld` must be a boolean when present: anything else fails the whole window, and no window
// is nothing captured.
const frontShape = z.object({app: z.string(), bundleId: z.string().optional(), title: z.string(), bandWithheld: z.boolean().optional()});
const readShape = z.union([
  z.object({ok: z.literal(true), window: frontShape, text: z.string(), toolbarText: z.string().optional()}),
  // `detail` is `unknown` here rather than an enum, and deliberately: an enum would make a helper
  // that sent an unknown detail fail the WHOLE parse, and a `black` answer with a strange detail
  // would then reach the loop as `failed` — a word the loop counts, arrived at by way of a key it
  // was supposed to ignore. Parsed loosely, checked against the closed set below, dropped otherwise.
  z.object({ok: z.literal(false), reason: z.enum(["locked", "black", "timeout", "failed", "windowGone"]), detail: z.unknown().optional()})
]);
const PERMISSIONS: readonly Permission[] = ["granted", "denied", "needsRestart", "unknown"];

/** The reader is another process: everything it sends is checked before use. */
export function parseFrontWindow(value: unknown): FrontWindow | null {
  const parsed = frontShape.safeParse(value);
  if (!parsed.success) return null;
  const {app, bundleId, title, bandWithheld} = parsed.data;
  const window: FrontWindow = bundleId === undefined ? {app, title} : {app, bundleId, title};
  return bandWithheld === true ? {...window, bandWithheld: true} : window;
}

/**
 * A malformed result counts as a failed read. `allowed` is the set of details this particular
 * speaker may claim — see the two exported wrappers below for why there are two of them.
 *
 * `detail` survives this boundary under three conditions, all of them checked here and none of them
 * assumed: the reason is `failed`, the value is a string, and that string is a member of `allowed`.
 * Anything else — an unknown word, a window title, a number, a detail on a `black` answer — is
 * DROPPED, and dropped rather than collapsed to a placeholder, so that a speaker we do not fully
 * trust can widen nothing. The caller then tallies the detail-less `failed` as `failedUnknown`,
 * which is the honest count: something failed and nobody could say what.
 *
 * That matters more than it looks. These details become count keys in `app.log`, and the log's whole
 * privacy argument is that its keys are fixed identifiers of this codebase rather than a pattern. A
 * string passed through from another process would break that argument at its one weak point, so it
 * is checked HERE, at the port, and not at the log — by the time it reaches the log it is already
 * one of ours. The returned object is REBUILT field by field, never the parsed value spread, so
 * nothing that travelled beside `detail` survives either.
 */
function parseResult(value: unknown, allowed: ReadonlySet<string>): ReadResult {
  const parsed = readShape.safeParse(value);
  if (!parsed.success) return {ok: false, reason: "failed"};
  const data = parsed.data;
  if (!data.ok) {
    const detail = data.reason === "failed" && typeof data.detail === "string" && allowed.has(data.detail)
      ? (data.detail as FailureDetail)
      : undefined;
    return detail === undefined ? {ok: false, reason: data.reason} : {ok: false, reason: data.reason, detail};
  }
  const window = parseFrontWindow(data.window) as FrontWindow;
  return data.toolbarText === undefined ? {ok: true, window, text: data.text} : {ok: true, window, text: data.text, toolbarText: data.toolbarText};
}

/**
 * What a `Reader` IMPLEMENTATION answered, checked before the capture loop acts on it.
 *
 * The full set, `helperDown` included: by this point the answer may legitimately be one the client
 * built itself, and the loop re-parses everything it is handed because `Reader` is an interface any
 * implementation could lie through. Narrowing here instead would silently delete the client's own
 * `helperDown` on the way past and make `failedHelperDown` a count that can never be reached.
 */
export function parseReadResult(value: unknown): ReadResult {
  return parseResult(value, DETAIL_SET);
}

/**
 * What the HELPER PROCESS sent over the pipe, checked before the client builds a `ReadResult` from
 * it. The wire set: everything except `helperDown`.
 *
 * This is the boundary that distinction exists at, and it is the only one that can enforce it —
 * downstream, a `helperDown` from a lying helper is indistinguishable from the client's own. Only
 * the client knows whether a read was answered by a helper at all, because it is the thing holding
 * the pipe; a helper claiming it about itself is stale or lying, and believing it would put
 * `failedHelperDown` in the log and send whoever reads it to the supervisor while the fault is in
 * the capture.
 */
export function parseHelperReadResult(value: unknown): ReadResult {
  return parseResult(value, WIRE_DETAIL_SET);
}

/** Anything that is not a known permission value is `unknown`, which blocks capture. */
export function parsePermission(value: unknown): Permission {
  return PERMISSIONS.includes(value as Permission) ? (value as Permission) : "unknown";
}
