/**
 * Everything `reader:eval` learns from its environment, checked in one place before anything is
 * staged.
 *
 * It is a module of its own, and pure, for the reason the whole harness is arranged this way: the
 * entry point runs inside a granted bundle and cannot be unit-tested, so anything in it that could be
 * got wrong has to live beside it. This is the part that was got wrong. The mode and the Chrome
 * variant used to be CAST rather than checked, three lines above two numeric variables that were
 * checked, under a comment explaining exactly why they had to be ("an environment variable is a
 * string from outside"). With an unrecognised mode, every `mode === …` test in `main.ts` was false,
 * so nothing was staged, nothing was read, and the summary of a run that measured nothing came back
 * `accepted: true` with exit code 0. The unchecked variant went into the results file verbatim.
 *
 * The CLI validates both (`scripts/reader-eval.mjs`), but the CLI is not the only caller: the bundle
 * is launched with `open --env`, and anything that can set an environment variable can start it.
 *
 * Two refusals and one default, and the difference between them is deliberate:
 *  - an unrecognised OR ABSENT mode is refused. Nobody said what to measure, and a harness must never
 *    invent a measurement it was not asked for — that is the whole finding.
 *  - an unrecognised variant is refused, because it is written into the results file as the record of
 *    what was staged.
 *  - an absent variant is `none`, the fresh default profile, which is the one phase 0's numbers were
 *    measured on and so the only sensible thing an unspecified run should be comparable with.
 */
import {DEFAULT_POSITION, type WindowPosition} from "./cases";
import type {EvalMode} from "./results";
import {CHROME_VARIANTS, type ChromeVariant} from "./stage";
import {DEFAULT_REPETITIONS, OBSERVE_SECONDS_DEFAULT} from "./thresholds";

/** The modes, as a value, so the cast that hid this bug cannot be written again. */
export const EVAL_MODES: readonly EvalMode[] = ["accuracy", "toolbar", "observe", "all", "coldstart"];

/**
 * Does this mode open a window?
 *
 * `coldstart` is the only one that does not: it spawns the helper, times its `ready`, asks about the
 * permission and stops. So it needs no page served, no scratch folder for a Chrome profile and
 * `.command` files, and no truth to score against — and `main.ts` builds none of those for it. The
 * predicate is here, as a value over the mode, so that "coldstart stages nothing" is a line a test
 * can hold rather than a shape somebody has to read `main.ts` to confirm.
 */
export function stagesWindows(mode: EvalMode): boolean {
  return mode !== "coldstart";
}

/**
 * Does this mode have a part `--limit` can cut?
 *
 * `accuracy`, `toolbar` and `all` stage a table of cases apiece. `observe` waits for windows the
 * OWNER opens and `coldstart` opens nothing, so a limit on either would print `LIMITED RUN: 0 of 0
 * cases` and block the acceptance of a run it never touched (review D, Minor 4). It is refused
 * instead, before anything opens.
 */
export function limitsCases(mode: EvalMode): boolean {
  return mode === "accuracy" || mode === "toolbar" || mode === "all";
}

export interface EvalSettings {
  mode: EvalMode;
  /** This run's identity, which is what keeps one run from reading another's windows. */
  nonce: string;
  variant: ChromeVariant;
  repetitions: number;
  seconds: number;
  /** Where every staged Chrome window's top-left corner goes (`--position`), in points. */
  position: WindowPosition;
  /**
   * Stage only the first `limit` cases of the part this mode runs, or all of them (`null`).
   *
   * Refused rather than defaulted when it is set and unreadable, like the variant and the position
   * and for the same reason: it decides WHAT was measured, and a run that silently measured
   * everything when the owner asked for four cases is a run whose provenance is wrong. Absent is
   * `null`, which is the full table.
   */
  limit: number | null;
}

/** Why the run was refused. A fixed code: it is written to the results file, where a message could carry a path. */
export type SettingsRefusal = "BAD_MODE" | "BAD_VARIANT" | "BAD_POSITION" | "BAD_LIMIT" | "LIMIT_NOT_APPLICABLE";

export type ReadSettings = {ok: true; settings: EvalSettings} | {ok: false; code: SettingsRefusal};

/** An environment variable is a string from outside: a whole number at least 1, or the default. */
export function counted(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * The largest coordinate `--position` will take, in points.
 *
 * No screen is 20 000 points across — the widest display Apple sells is under 7 000 points, and a
 * second monitor's origin sits at the width of the first. The bound is not about what is on this
 * machine; it is about a stray digit. `--position 400,600000` parses perfectly as two whole numbers
 * and stages every window far off every display, so the guard never sees one, all eighteen cases
 * come back `notStaged`, and a ten-minute session with windows opening on the owner's screen is
 * spent measuring nothing. It fails closed — the run is `incomplete`, never a false pass — but the
 * whole reason a malformed position is refused rather than defaulted (see below) is that this option
 * is the one whose typo the owner cannot see until the session is over. So it is refused here, before
 * the bundle opens, on both sides of the command line.
 */
/** The largest `--limit` this harness takes: more cases than any table it has. */
export const LIMIT_MAX = 1000;

export const POSITION_MAX_PT = 20_000;

/**
 * And the smallest. NEGATIVE coordinates are ordinary on a Mac with two displays: the primary's
 * top-left corner is the origin, so a display placed to the LEFT of it, or above it, has negative
 * coordinates for its whole width or height. The owner's machine is exactly that arrangement — an
 * external 2560 x 1440 as the main display with the built-in Retina panel beside it — and
 * `--position` exists to stage the run on the other display (spec 10.1 item 8, the Retina check),
 * which a digits-only rule made impossible to ask for.
 *
 * Symmetric with `POSITION_MAX_PT`, and for the same reason: it is not a fact about this machine, it
 * is the bound past which a coordinate is a typo rather than a display.
 */
export const POSITION_MIN_PT = -20_000;

/**
 * One coordinate of `--position`: an optional leading minus, then digits and nothing else.
 *
 * Deliberately not `Number(raw)`, which accepts `" 3 "`, `3.0`, `1e3`, `0x20` and `Infinity`, and
 * deliberately not a regular expression: every regex in this harness that held a character class has
 * been a place where the tooling turned an escape into a raw byte (`bytes.test.ts`), and a digit
 * check does not need one. A leading `+`, a dot, a space, a lone `-` and an empty string all fail,
 * which is the plan's refusal table with the one deliberate addition of a negative coordinate — see
 * `POSITION_MIN_PT`.
 */
export function wholePoint(raw: string): number | null {
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  if (digits.length === 0) return null;                            // "" and a lone "-"
  for (let index = 0; index < digits.length; index += 1) {
    const code = digits.charCodeAt(index);
    if (code < 48 || code > 57) return null;                       // not one of 0-9
  }
  const value = Number(digits) * (negative ? -1 : 1);
  return Number.isSafeInteger(value) && value <= POSITION_MAX_PT && value >= POSITION_MIN_PT ? value : null;
}

/** `x,y` in points, both whole and neither negative, or `null` for anything else at all. */
export function parsePosition(raw: string): WindowPosition | null {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;                             // `1` and `1,2,3` are both wrong
  const xPt = wholePoint(parts[0] as string);
  const yPt = wholePoint(parts[1] as string);
  return xPt === null || yPt === null ? null : {xPt, yPt};
}

/** `--limit`: a whole number of cases, at least one and at most `LIMIT_MAX`, or nothing at all. */
export function parseLimit(raw: string): number | null {
  if (raw.length === 0 || raw.length > 4) return null;
  // No leading zero: `04` is not how anybody writes four, and `boundedCount` in `stagedTitle.ts`
  // refuses one for the same reason (review D, Minor 5).
  if (raw.length > 1 && raw.charCodeAt(0) === 48) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return null;                       // not one of 0-9
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= LIMIT_MAX ? value : null;
}

export function readEvalSettings(
  env: Readonly<Record<string, string | undefined>>,
  newNonce: () => string
): ReadSettings {
  const mode = EVAL_MODES.find((candidate) => candidate === env.CLAVE_EVAL_MODE);
  if (mode === undefined) return {ok: false, code: "BAD_MODE"};
  const rawVariant = env.CLAVE_EVAL_VARIANT;
  const variant = rawVariant === undefined ? "none" : CHROME_VARIANTS.find((candidate) => candidate === rawVariant);
  if (variant === undefined) return {ok: false, code: "BAD_VARIANT"};
  // REFUSED, like the variant, and unlike the two counted numbers which fall back on their default.
  // A position decides which DISPLAY a run measures (spec 10.1 item 8, the Retina check): silently
  // falling back would file a run made on the built-in 2x display under the numbers of the external
  // one, which is the single thing this option exists to tell apart. An ABSENT variable is the
  // default position; a variable that was set and cannot be read is a different statement, and this
  // is where the two stop looking alike.
  const rawPosition = env.CLAVE_EVAL_POSITION;
  const position = rawPosition === undefined ? DEFAULT_POSITION : parsePosition(rawPosition);
  if (position === null) return {ok: false, code: "BAD_POSITION"};
  const rawLimit = env.CLAVE_EVAL_LIMIT;
  const limit = rawLimit === undefined ? null : parseLimit(rawLimit);
  if (rawLimit !== undefined && limit === null) return {ok: false, code: "BAD_LIMIT"};
  if (limit !== null && !limitsCases(mode)) return {ok: false, code: "LIMIT_NOT_APPLICABLE"};
  return {
    ok: true,
    settings: {
      mode,
      position,
      limit,
      // `||`, not `??`: an EMPTY nonce is no nonce. It would build staged titles of the form
      // `CLAVE-EVAL <case> `, which `isStagedTitle` accepts, leaving the run with no identity at all
      // and two concurrent runs able to accept each other's windows.
      nonce: env.CLAVE_EVAL_NONCE || newNonce(),
      variant,
      repetitions: counted(env.CLAVE_EVAL_REPETITIONS, DEFAULT_REPETITIONS),
      seconds: counted(env.CLAVE_EVAL_SECONDS, OBSERVE_SECONDS_DEFAULT)
    }
  };
}
