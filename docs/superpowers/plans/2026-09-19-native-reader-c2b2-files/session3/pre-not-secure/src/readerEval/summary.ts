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
import {noToolbarStrip, type ObserveExpectation} from "./observe";
import {
  INCOMPLETE_OUTCOMES,
  type AccuracyCaseResult,
  type AccuracyRepetition,
  type ColdstartVerdict,
  type EvalMode,
  type EvalPermission,
  type EvalSummary,
  type GroupVerdict,
  type LimitedRun,
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

/**
 * A case is incomplete when a repetition ended badly — OR when a repetition read a window that was
 * not the size it was staged at.
 *
 * The second half is new on 2026-09-20 and it is an acceptance rule, not a scoring one: such a
 * repetition still has its outcome, its accuracy and its confusion pairs, and they are all still
 * reported. What it must not do is COUNT. Spec 10.1 item 15 asks for staged windows at recorded
 * sizes precisely because phase 0's terminal case moved 0.8686 -> 0.9882 between two runs and the
 * window state was not written down; the first run against a screen then read sixteen Chrome windows
 * at a size nobody asked for and reported every group as a pass. A number measured on a window the
 * harness did not shape is a number about an unknown window, and "unknown" must not read as "fine" —
 * which is the rule the whole of this file already lives under.
 *
 * `null` does not fail: a repetition that never read has no size to judge, and a Terminal window
 * whose shell could not say what size it got is reported as unknown rather than as wrong.
 */
export function isIncomplete(repetitions: readonly AccuracyRepetition[]): boolean {
  return (
    repetitions.length === 0 ||
    repetitions.some((entry) => INCOMPLETE_OUTCOMES.includes(entry.outcome) || entry.sizeAsStaged === false)
  );
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
  /**
   * INFORMATION ONLY, and the one number in this file that is not allowed near a verdict.
   *
   * Owner decision O8 made the core drop a Chrome or Safari read whose strip shows no address line,
   * and whether real strips satisfy that rule can only be measured on a screen. This counts the
   * captures whose strip the core's own `showsAddress` accepts, so a toolbar run reports it — and
   * it is deliberately NOT in `passed` below and has no threshold beside it. The thresholds are the
   * spike's pass marks (`thresholds.ts`) and are never added to here; a low count is a finding about
   * the core to take to the owner, not a harness run that failed.
   */
  const addressLines = cases.filter((entry) => entry.addressLine === true).length;
  // Not as staged is incomplete here too, and for a sharper reason than in the accuracy run: the
  // band this mode measures is a number of PIXELS down from the top of a capture, so a window of an
  // unknown size makes `privateBottomPx` against `bandPx` a comparison about an unknown window.
  const incompleteCases = cases
    .filter((entry) => entry.outcome !== "ok" || entry.sizeAsStaged === false)
    .map((entry) => entry.case);
  const full = normal.length === TOOLBAR_CAPTURES_PER_MODE && incognito.length === TOOLBAR_CAPTURES_PER_MODE;
  return {
    captures: cases.length,
    hostHits,
    hostHitsMin: TOOLBAR_THRESHOLDS.hostHitsMin,
    addressLines,
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
 * The owner-staged observations, judged against what the run SAID IT WANTED and in both directions.
 *
 * **What it wanted comes first** (finding O1). Run #1 of 2026-09-21 printed twenty URLs, read one
 * normal Safari page, and reported `READER_EVAL ACCEPTED`: every rule below was satisfied, because
 * every rule below is a rule about the rows that arrived, and one correct row is a table with nothing
 * wrong in it. A mode whose windows the OWNER opens by hand cannot be judged on what arrived. So a
 * run names its cases (`--expect`, `observe.ts`) and is held to all of them — every one read, and
 * every one agreeing with its own name — and a run that named nothing is `EXPLORATORY`: reported in
 * full, never accepted, whatever it read.
 *
 * The two directions of disagreement are not symmetrical in what they cost, and both are refused:
 *
 * - A window staged PRIVATE whose read shows no private marker is a private window the product
 *   would have KEPT. `private !== true` is the test, not `private === false`: a `null` — the helper
 *   sent no toolbar strip at all — is a badge that was never delivered, and a badge that was never
 *   delivered never skipped anything. Treating `null` as "inconclusive" would let the worst outcome
 *   pass as an absence of evidence.
 * - A window staged NORMAL that was flagged private costs the user reads for ever. Phase 0 measured
 *   zero of those; anything above zero is a regression.
 *
 * **Both are counted over reads that SUCCEEDED, and only those** (finding O4). A row whose read
 * failed showed nothing: `windowGone` means the helper's own comparisons refused before it captured
 * anything, so no marker was missing from it — there was no read for a marker to be missing from.
 * Such a row is `incomplete` (and, if it was expected, `missing`), which already fails the run; what
 * it must not be is `privateMissed`, which is this harness's word for a privacy failure that was
 * actually observed.
 *
 * And `read === 0` fails, as it always did — now as the limiting case of the expected set going
 * unread. `ran` is what tells an observe run with no rows apart from a run that had no observe mode.
 */
export function summariseObserve(
  cases: readonly ObserveCaseResult[],
  ran: boolean,
  /**
   * The sets the run was asked for and the cases they name, or `null` for an exploratory run.
   * Resolved from the case table by `expectationOf`, never parsed here.
   */
  expect: ObserveExpectation | null = null
): ObserveVerdict | null {
  if (!ran) return null;
  const usable = cases.filter((entry) => entry.outcome === "ok");
  const privateMissed = usable.filter((entry) => entry.expectPrivate && entry.private !== true).length;
  const falsePrivate = usable.filter((entry) => !entry.expectPrivate && entry.private === true).length;
  const incompleteCases = cases.filter((entry) => entry.outcome !== "ok").map((entry) => entry.case);
  /**
   * NORMAL windows that were read and carried no toolbar strip at all: the rule was never applied to
   * anything, so there is nothing to call a pass (review, Minor 5). A PRIVATE window with no strip is
   * deliberately NOT here — it is a `privateMissed`, which is the stronger statement of the same
   * fact: no badge was delivered, so in the product that window would have been kept.
   */
  const notCheckedCases = usable
    .filter((entry) => !entry.expectPrivate && noToolbarStrip(entry))
    .map((entry) => entry.case);
  // An expected case with no successful read: never staged, staged and never seen in front, or read
  // and failed. All three are the same thing to a verdict — it was asked for and it is not there.
  const missingCases = (expect?.cases ?? []).filter(
    (name) => !usable.some((entry) => entry.case === name)
  );
  const disagreed = privateMissed > 0 || falsePrivate > 0;
  /**
   * The order matters, and so does what is NOT in it. A row outside the expected set that failed to
   * read is listed in `incompleteCases` and printed, but it does not fail the run: the owner asked
   * for five private Safari windows, got five, and a sixth window he happened to open and whose read
   * came back `windowGone` says nothing about the five. `privateMissed` and `falsePrivate` DO fail
   * the run wherever they occur, because those are measurements of a real read: a normal window
   * flagged private is a regression whether or not anybody asked about that window.
   *
   * `expected === 0` is the guard against the hole this whole mechanism would otherwise have: an
   * expectation naming no case at all would have nothing missing from it and would pass on an empty
   * table, which is finding O1 with an extra step.
   */
  /** An EXPECTED normal case that was read with no strip: incomplete, not a pass and not a failure. */
  const expectedNotChecked = (expect?.cases ?? []).filter((name) => notCheckedCases.includes(name));
  const reason: ObserveVerdict["reason"] =
    expect === null ? "EXPLORATORY"
      : expect.cases.length === 0 || missingCases.length > 0 || expectedNotChecked.length > 0 ? "INCOMPLETE"
        : disagreed ? "NOT_AS_EXPECTED"
          : null;
  return {
    staged: cases.length,
    read: usable.length,
    expect: expect === null ? null : [...expect.sets],
    expected: expect === null ? 0 : expect.cases.length,
    missingCases,
    notCheckedCases,
    privateMissed,
    falsePrivate,
    incompleteCases,
    reason,
    passed: reason === null
  };
}

/** What the helper run produced, as the two figures `coldstart` is judged on. */
export interface HelperFacts {
  readyMs: number;
  permission: EvalPermission;
}

/**
 * What a caller that passed no helper figures is taken to have measured: nothing.
 *
 * `NaN` is not a finite number and `unknown` is not `granted`, so a `coldstart` summary built
 * without them is a SHORTFALL — never a pass. It is a default only so that the four modes which do
 * not judge the helper need not pass a pair of figures they have no use for; it is fail-closed for
 * exactly the reason the whole of this file is, and `summary.test.ts` holds it there.
 */
const NOTHING_MEASURED: HelperFacts = {readyMs: NaN, permission: "unknown"};

/**
 * `coldstart`'s verdict: both facts, or nothing was measured.
 *
 * `readyMs` must be a finite number AND NOT NEGATIVE. A clock that gave `NaN`, or a `ready` that
 * never came and left the subtraction meaningless, is not a measurement of a helper start, and a
 * results file carrying `readyMs: null` beside `passed: true` would be this harness reporting a
 * number it does not have. A duration that ran BACKWARDS is the same thing wearing a plausible face:
 * `-500` would print as a start time and pass every check that only asks whether it is finite. The
 * entry point reads a monotonic clock so it should be unreachable, and this is the other half of
 * that — the rule holds whatever clock the caller used.
 * And `permission` must be `granted`: every other mode refuses outright on anything else
 * (`NO_GRANT`), and `coldstart` is the mode that reports it instead — reporting it is not the same
 * as accepting it, and `denied` here is the finding that blocks the whole measurement plan.
 */
export function summariseColdstart(helper: HelperFacts, ran: boolean): ColdstartVerdict | null {
  if (!ran) return null;
  const readyMs = Number.isFinite(helper.readyMs) && helper.readyMs >= 0 ? helper.readyMs : null;
  return {
    readyMs,
    permission: helper.permission,
    passed: readyMs !== null && helper.permission === "granted"
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
 * fails on nothing read; a coldstart run owes both helper figures. There is no mode left in which
 * "nothing happened" can pass — and `coldstart`, whose three lists are ALWAYS empty because it reads
 * nothing, would be exactly that case without a verdict of its own.
 */
export function summarise(
  mode: EvalMode,
  accuracy: readonly AccuracyCaseResult[],
  toolbar: readonly ToolbarCaseResult[],
  observe: readonly ObserveCaseResult[] = [],
  helper: HelperFacts = NOTHING_MEASURED,
  /**
   * What `--limit` cut, or nothing. A run that staged four of forty cases measured four of forty
   * cases: every verdict in it is about those four, and none of them is the acceptance the spec
   * asks for. So its presence alone fails `accepted`, however perfect the rows are — the option
   * exists to diagnose a failing run in two minutes, never to shorten the run that accepts the
   * sub-project.
   */
  limited: LimitedRun | null = null,
  /**
   * What the `observe` part was asked for, or `null` — in which case its verdict is `EXPLORATORY`
   * and `accepted` is false however well it read. The default is deliberately the strict one: a
   * caller that forgets to pass this gets a run that cannot be accepted, never one that is accepted
   * for having been asked nothing (finding O1).
   */
  observeExpect: ObserveExpectation | null = null
): EvalSummary {
  const accuracyRan = mode === "accuracy" || mode === "all";
  const toolbarRan = mode === "toolbar" || mode === "all";
  const observeRan = mode === "observe" || mode === "all";
  // Never part of `all`: see `EvalMode`.
  const coldstartRan = mode === "coldstart";
  const groups = summariseGroups(accuracy);
  const missingGroups = accuracyRan
    ? ALL_GROUPS.filter((group) => !groups.some((verdict) => verdict.group === group))
    : [];
  const toolbarVerdict = summariseToolbar(toolbar, toolbarRan);
  const observeVerdict = summariseObserve(observe, observeRan, observeExpect);
  const coldstartVerdict = summariseColdstart(helper, coldstartRan);
  return {
    groups,
    missingGroups,
    toolbar: toolbarVerdict,
    observe: observeVerdict,
    coldstart: coldstartVerdict,
    limited,
    accepted:
      limited === null &&
      missingGroups.length === 0 &&
      groups.every((group) => group.passed) &&
      (toolbarVerdict === null || toolbarVerdict.passed) &&
      (observeVerdict === null || observeVerdict.passed) &&
      (coldstartVerdict === null || coldstartVerdict.passed)
  };
}

/** The groups a full accuracy run must produce a verdict for, so a missing one is visible. */
export const ALL_GROUPS: readonly AccuracyGroup[] = Object.keys(ACCURACY_THRESHOLDS) as AccuracyGroup[];
