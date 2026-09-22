/**
 * Every number the staged-window evaluation judges against, in one file.
 *
 * **These thresholds are never lowered by an agent.** They are the spike's own pass marks, copied
 * from the design spec verbatim; a run that falls short goes to the owner WITH THE NUMBERS and the
 * owner decides. Lowering one here to make a run pass would silently retire the only measurement
 * that stands between the reader and shipping a recogniser that cannot read. `thresholds.test.ts`
 * pins each value exactly, so any change to this file is a visible, failing change in a review.
 *
 * Sources, all quoted rather than recalled:
 * - `docs/superpowers/specs/2026-09-18-native-reader-design.md` section 6, row P4: "Character
 *   accuracy: at least 97% chat and tickets, 95% terminal, 95% Portuguese with accents kept, 90%
 *   code", and row P5: "Address host recognised in at least 19 of 20 staged captures;
 *   'Incognito'/'Private' in 20 of 20".
 * - The same spec, section 10.1 item 15: every case is read several times ("five is a reasonable
 *   default") and the MINIMUM and median are reported, at fixed, recorded window sizes.
 * - `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`, P5 "Counts": the
 *   false-private count (the opposite error) must be zero.
 */

/** Per accuracy group: the lowest per-case minimum the group may show and still pass. */
export const ACCURACY_THRESHOLDS = {
  chat: 0.97,
  ticket: 0.97,
  terminal: 0.95,
  pt: 0.95,
  code: 0.9
} as const;

export type AccuracyGroup = keyof typeof ACCURACY_THRESHOLDS;

/**
 * Portuguese carries a second, harder bar: not one accented character may be lost. Spec section 6
 * writes it as "95% Portuguese with accents kept", and phase 0 measured `accents` 1.0 on every one
 * of the four `pt` reads, so anything below 1.0 is a regression against a measured result, not a
 * tight threshold.
 */
export const PT_ACCENTS_MIN = 1;

/** Toolbar strip (spike P5), counted over the 20 normal and the 20 incognito Chrome stagings. */
export const TOOLBAR_THRESHOLDS = {
  /** Normal captures whose address host was recognised, out of `TOOLBAR_CAPTURES_PER_MODE`. */
  hostHitsMin: 19,
  /** Incognito captures whose private badge was recognised. All of them, or the rule cannot be trusted. */
  privateHitsMin: 20,
  /**
   * Normal captures that looked private. Zero. This is the error that costs the user reads for
   * ever rather than costing privacy, and phase 0 measured 0/20, so any hit is a regression.
   */
  falsePrivateMax: 0
} as const;

/** 4 hosts x 5 page variants, per mode (P5's shape, kept so the counts above stay comparable). */
export const TOOLBAR_CAPTURES_PER_MODE = 20;

/**
 * How many times each accuracy case is staged and read. Spec 10.1 item 15: phase 0 read each case
 * once and the terminal case moved 0.8686 -> 0.9882 between two runs, so a single sample is not a
 * measurement. Five, and both the minimum and the median are reported.
 */
export const DEFAULT_REPETITIONS = 5;

/**
 * How long the guard waits for the window it staged to come to the front, and how often it looks.
 * Generous: Chrome's first window in a fresh profile and a Terminal window opened through
 * LaunchServices both take seconds, and a repetition that gives up is recorded as `notStaged` and
 * makes its case incomplete — never silently dropped, and never counted as a pass.
 */
export const GUARD_TIMEOUT_MS = 15_000;
export const GUARD_POLL_MS = 500;

/** The read budget the harness gives the helper. The app's own loop uses 1 500 ms; this is looser. */
export const EVAL_READ_BUDGET_MS = 5_000;

/** How long `observe` mode watches the front window for owner-staged windows, and how often. */
export const OBSERVE_SECONDS_DEFAULT = 120;
export const OBSERVE_POLL_MS = 2_000;

/**
 * The confusion list is only computed for cases that fell SHORT, because it is the one part of the
 * results derived from the recognised text (single characters, in pairs) and it exists to tell the
 * owner what went wrong when something did. Max five pairs, as the spike brief asked.
 */
export const CONFUSIONS_MAX = 5;
