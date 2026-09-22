/**
 * From per-read numbers to a verdict.
 *
 * Two rules decide everything here, and both are deliberate:
 *
 * 1. **A group is judged on its MINIMUM, never its median.** The median answers "how well does this
 *    usually go", which is not the question — the reader runs unattended on somebody's screen all
 *    day and a case that reads badly one time in five reads badly on somebody's morning. Phase 0
 *    measured exactly that: the terminal case scored 0.9882 in one run and 0.8686 in another, and a
 *    median over those two would have passed a group that contained a failing read. The median is
 *    reported beside the minimum because it says something useful about spread; it decides nothing.
 * 2. **An incomplete case can never pass.** A repetition that ended `notStaged`, `windowGone`,
 *    `black`, `timeout`, `failed`, `locked`, `down` or without the staged page's markers is reported
 *    and makes its case incomplete. It is not dropped and not averaged away: a case whose window was
 *    never staged has not been measured, and "not measured" must not read as "fine".
 */
import {
  INCOMPLETE_OUTCOMES,
  type AccuracyCaseResult,
  type AccuracyRepetition,
  type EvalMode,
  type EvalSummary,
  type GroupVerdict,
  type ObserveCaseResult,
  type ObserveVerdict,
  type ToolbarCaseResult,
  type ToolbarVerdict
} from "./results";
import {ACCURACY_THRESHOLDS, PT_ACCENTS_MIN, TOOLBAR_CAPTURES_PER_MODE, TOOLBAR_THRESHOLDS, type AccuracyGroup} from "./thresholds";

export function minimumOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((low, value) => (value < low ? value : low), values[0] as number);
}

/**
 * The median, defined so that it is always a number some read actually scored.
 *
 * For an odd count it is the middle value — the 3rd of five, as the brief asks. For an even count it
 * is the LOWER of the two middle values rather than their mean: an invented number that no read
 * produced would be the one figure in this report nobody could point at a read for, and the lower of
 * the pair keeps the reporting biased the same way every other rule here is.
 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

export function isIncomplete(repetitions: readonly AccuracyRepetition[]): boolean {
  return repetitions.length === 0 || repetitions.some((entry) => INCOMPLETE_OUTCOMES.includes(entry.outcome));
}

const scored = (repetitions: readonly AccuracyRepetition[]): AccuracyRepetition[] =>
  repetitions.filter((entry) => entry.outcome === "ok" && entry.accuracy !== null);

/** Fills a case's minimum, median and accents minimum from its repetitions. */
export function finishAccuracyCase(
  entry: Omit<AccuracyCaseResult, "minAccuracy" | "medianAccuracy" | "minAccents" | "incomplete">
): AccuracyCaseResult {
  const complete = scored(entry.repetitions);
  const accuracies = complete.map((repetition) => repetition.accuracy as number);
  const accents = complete.filter((repetition) => repetition.accents !== null).map((repetition) => repetition.accents as number);
  return {
    ...entry,
    minAccuracy: minimumOf(accuracies),
    medianAccuracy: medianOf(accuracies),
    minAccents: minimumOf(accents),
    incomplete: isIncomplete(entry.repetitions)
  };
}

/**
 * One verdict per group that the run actually covered.
 *
 * A group with no measured case at all fails: `min === null` is "nothing was measured", and the one
 * thing this file must never do is let that read as a pass.
 */
export function summariseGroups(cases: readonly AccuracyCaseResult[]): GroupVerdict[] {
  const groups = [...new Set(cases.map((entry) => entry.group))];
  return groups.map((group): GroupVerdict => {
    const inGroup = cases.filter((entry) => entry.group === group);
    const threshold = ACCURACY_THRESHOLDS[group];
    const min = minimumOf(inGroup.filter((entry) => entry.minAccuracy !== null).map((entry) => entry.minAccuracy as number));
    const median = medianOf(inGroup.filter((entry) => entry.medianAccuracy !== null).map((entry) => entry.medianAccuracy as number));
    const accentsMin = group === "pt"
      ? minimumOf(inGroup.filter((entry) => entry.minAccents !== null).map((entry) => entry.minAccents as number))
      : null;
    const incompleteCases = inGroup.filter((entry) => entry.incomplete).map((entry) => entry.case);
    const accentsThreshold = group === "pt" ? PT_ACCENTS_MIN : null;
    const accentsPassed = group !== "pt" || (accentsMin !== null && accentsMin >= PT_ACCENTS_MIN);
    return {
      group,
      threshold,
      min,
      median,
      accentsMin,
      accentsThreshold,
      incompleteCases,
      passed: min !== null && min >= threshold && accentsPassed && incompleteCases.length === 0
    };
  });
}

/**
 * The toolbar counts of spike P5, over the captures this run made.
 *
 * `passed` also demands the full 20 captures per mode, because 19/20 means nothing when the
 * denominator is 3: a partial run is reported, never accepted. Zero captures is the limiting case of
 * exactly that, so it is a FAILING verdict rather than no verdict — `ran` is what tells a toolbar run
 * that captured nothing apart from a run that had no toolbar mode at all, the same distinction
 * `summariseObserve` draws and for the same reason.
 */
export function summariseToolbar(cases: readonly ToolbarCaseResult[], ran: boolean): ToolbarVerdict | null {
  if (!ran) return null;
  const normal = cases.filter((entry) => entry.mode === "normal");
  const incognito = cases.filter((entry) => entry.mode === "incognito");
  const hostHits = normal.filter((entry) => entry.host === true).length;
  const privateHits = incognito.filter((entry) => entry.private === true).length;
  const falsePrivate = normal.filter((entry) => entry.private === true).length;
  const incompleteCases = cases.filter((entry) => entry.outcome !== "ok").map((entry) => entry.case);
  const full = normal.length === TOOLBAR_CAPTURES_PER_MODE && incognito.length === TOOLBAR_CAPTURES_PER_MODE;
  return {
    captures: cases.length,
    hostHits,
    hostHitsMin: TOOLBAR_THRESHOLDS.hostHitsMin,
    privateHits,
    privateHitsMin: TOOLBAR_THRESHOLDS.privateHitsMin,
    falsePrivate,
    falsePrivateMax: TOOLBAR_THRESHOLDS.falsePrivateMax,
    incompleteCases,
    passed:
      full &&
      incompleteCases.length === 0 &&
      hostHits >= TOOLBAR_THRESHOLDS.hostHitsMin &&
      privateHits >= TOOLBAR_THRESHOLDS.privateHitsMin &&
      falsePrivate <= TOOLBAR_THRESHOLDS.falsePrivateMax
  };
}

/**
 * The owner-staged observations, judged in BOTH directions.
 *
 * A row disagreeing with its own case name is a failure of the run, not a note for the reader. The
 * two directions are not symmetrical in what they cost, and both are refused:
 *
 * - A window staged PRIVATE whose read shows no private marker is a private window the product
 *   would have KEPT. `private !== true` is the test, not `private === false`: a `null` — the helper
 *   sent no toolbar strip at all — is a badge that was never delivered, and a badge that was never
 *   delivered never skipped anything. Treating `null` as "inconclusive" would let the worst outcome
 *   pass as an absence of evidence.
 * - A window staged NORMAL that was flagged private costs the user reads for ever. Phase 0 measured
 *   zero of those; anything above zero is a regression.
 *
 * And `read === 0` fails. An observe run in which the owner staged nothing, or in which every read
 * failed, has measured nothing — and this is the one mode where "nothing happened" would otherwise
 * look exactly like "everything was fine", because there is nobody to notice an empty table.
 *
 * `ran` is what tells an observe run with no rows apart from a run that had no observe mode at all.
 */
export function summariseObserve(cases: readonly ObserveCaseResult[], ran: boolean): ObserveVerdict | null {
  if (!ran) return null;
  const usable = cases.filter((entry) => entry.outcome === "ok");
  const privateMissed = usable.filter((entry) => entry.expectPrivate && entry.private !== true).length;
  const falsePrivate = usable.filter((entry) => !entry.expectPrivate && entry.private === true).length;
  const incompleteCases = cases.filter((entry) => entry.outcome !== "ok").map((entry) => entry.case);
  return {
    staged: cases.length,
    read: usable.length,
    privateMissed,
    falsePrivate,
    incompleteCases,
    passed: usable.length > 0 && privateMissed === 0 && falsePrivate === 0 && incompleteCases.length === 0
  };
}

/**
 * `accepted` is every verdict the run's MODE asked for, produced and passing.
 *
 * The mode is a parameter rather than something inferred from the rows, because inferring it is the
 * bug this signature exists to make impossible: a summary built from three empty lists used to come
 * back `groups: []`, `toolbar: null`, `observe: null` and `accepted: true` — `[].every(…)` is `true`
 * — and the terminal side turned that into exit code 0. A run that staged nothing, read nothing and
 * measured nothing reported ACCEPTED, and any unrecognised `CLAVE_EVAL_MODE` reached it.
 *
 * So each mode is asked what it promised and held to it: an accuracy run owes a verdict for every one
 * of `ALL_GROUPS` (a group whose cases all failed to stage is a group that was never measured, and
 * `missingGroups` says which by name); a toolbar run owes a toolbar verdict, which its own rule then
 * fails for anything short of the full 40 captures; an observe run owes an observe verdict, which
 * fails on nothing read. There is no mode left in which "nothing happened" can pass.
 */
export function summarise(
  mode: EvalMode,
  accuracy: readonly AccuracyCaseResult[],
  toolbar: readonly ToolbarCaseResult[],
  observe: readonly ObserveCaseResult[] = []
): EvalSummary {
  const accuracyRan = mode === "accuracy" || mode === "all";
  const toolbarRan = mode === "toolbar" || mode === "all";
  const observeRan = mode === "observe" || mode === "all";
  const groups = summariseGroups(accuracy);
  const missingGroups = accuracyRan
    ? ALL_GROUPS.filter((group) => !groups.some((verdict) => verdict.group === group))
    : [];
  const toolbarVerdict = summariseToolbar(toolbar, toolbarRan);
  const observeVerdict = summariseObserve(observe, observeRan);
  return {
    groups,
    missingGroups,
    toolbar: toolbarVerdict,
    observe: observeVerdict,
    accepted:
      missingGroups.length === 0 &&
      groups.every((group) => group.passed) &&
      (toolbarVerdict === null || toolbarVerdict.passed) &&
      (observeVerdict === null || observeVerdict.passed)
  };
}

/** The groups a full accuracy run must produce a verdict for, so a missing one is visible. */
export const ALL_GROUPS: readonly AccuracyGroup[] = Object.keys(ACCURACY_THRESHOLDS) as AccuracyGroup[];
