/**
 * After a decision on a row, which row (by position in the freshly rendered list) should receive
 * focus: the row that now stands where the answered one did — the NEXT statement, which is what a
 * keyboard user wants to answer next — the one before it if the list has shrunk to end exactly
 * there, or the first row if neither survives. `null` means the list is now empty: there is no row
 * left to focus, so the caller sends focus to the heading instead.
 */
export function focusRowAfterDecision(answeredIndex: number, rowCount: number): number | null {
  if (rowCount === 0) return null;
  if (answeredIndex < rowCount) return answeredIndex;
  if (answeredIndex - 1 >= 0 && answeredIndex - 1 < rowCount) return answeredIndex - 1;
  return 0;
}

/** What a pending focus move is scheduled against: the view and the refusal flag at the moment it
 * was scheduled, or at any later moment being checked against it. */
export interface FetchState { view: unknown; refused: boolean }

/**
 * Whether the ONE fetch a pending focus move was scheduled for has settled since — with a fresh
 * view (success) or a refusal (failure) — rather than still being in flight. `view` is compared by
 * identity: every answer this app's bridge produces is a freshly built object, so a fetch that has
 * actually resolved always hands back a different one, while a fetch still in flight leaves both
 * fields exactly as they were when the move was scheduled. This is what a decision's focus move must
 * be tied to: applied when its own re-read succeeds, dropped the moment that re-read settles at all
 * — success or failure — and never mistaken for some later, unrelated fetch.
 */
export const fetchSettled = (scheduledAgainst: FetchState, current: FetchState): boolean =>
  scheduledAgainst.view !== current.view || scheduledAgainst.refused !== current.refused;
