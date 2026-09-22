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
import type {EvalMode} from "./results";
import {CHROME_VARIANTS, type ChromeVariant} from "./stage";
import {DEFAULT_REPETITIONS, OBSERVE_SECONDS_DEFAULT} from "./thresholds";

/** The four modes, as a value, so the cast that hid this bug cannot be written again. */
export const EVAL_MODES: readonly EvalMode[] = ["accuracy", "toolbar", "observe", "all"];

export interface EvalSettings {
  mode: EvalMode;
  /** This run's identity, which is what keeps one run from reading another's windows. */
  nonce: string;
  variant: ChromeVariant;
  repetitions: number;
  seconds: number;
}

/** Why the run was refused. A fixed code: it is written to the results file, where a message could carry a path. */
export type SettingsRefusal = "BAD_MODE" | "BAD_VARIANT";

export type ReadSettings = {ok: true; settings: EvalSettings} | {ok: false; code: SettingsRefusal};

/** An environment variable is a string from outside: a whole number at least 1, or the default. */
export function counted(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
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
  return {
    ok: true,
    settings: {
      mode,
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
