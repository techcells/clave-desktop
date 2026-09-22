/**
 * The guard: the harness may capture a window it staged, and nothing else, ever.
 *
 * Why this file exists at all. `reader:eval` runs inside the granted development bundle, on the
 * owner's own machine, beside the owner's own windows: mail, a bank, a private browser window, a
 * password manager. It is a program whose whole job is to photograph the screen and score what is
 * on it, and the only thing standing between that and the owner's morning is the rule below. So the
 * rule is not "prefer the staged window" — it is structural:
 *
 * 1. Before any read the harness asks the helper which window is in front.
 * 2. The answer is accepted ONLY when its `app` is exactly the app this case stages AND its `title`
 *    contains the staged title for THIS case and THIS run's nonce (`stagedTitle.ts`).
 * 3. An accepted answer becomes an [`Approval`], which is the only thing `helper.readApproved` will
 *    take — and an `Approval` cannot be built outside this file, because the brand on it is a symbol
 *    this module does not export. There is no code path that reads a window without one.
 * 4. The `read` the harness then sends carries `expect` = that window, so protocol 2's helper refuses
 *    to capture anything else even if the screen changed in the microseconds in between (spec
 *    section 3; the helper re-checks before capture, before recognition and before answering).
 * 5. If the staged window is not in front within the timeout, the repetition is recorded as
 *    `notStaged` and NOTHING is read.
 *
 * Steps 2 and 3 are this file. Step 4 is the helper's half of the same rule, and the reason the
 * protocol number moved to 2: a rule that only one side keeps is not a rule.
 */
import type {FrontWindow} from "../core/types";
import {STAGED_TITLE_PREFIX, isStagedTitle, readyMark} from "./stagedTitle";
import {GUARD_POLL_MS, GUARD_TIMEOUT_MS} from "./thresholds";

/**
 * The brand. Not exported, so `Approval` is a type nothing outside this module can produce: a caller
 * that wants to read a window has to come through `approve` or `awaitStagedWindow`.
 */
const APPROVED = Symbol("clave reader-eval approved staged window");

export interface Approval {
  readonly [APPROVED]: true;
  /** Exactly the window the helper reported, to be sent back to it as `expect`, field for field. */
  readonly window: FrontWindow;
}

export interface Expectation {
  /** The app name the window server must report, compared exactly. */
  app: string;
  /** `CLAVE-EVAL <case name> <run nonce>`; the window title must contain it. */
  stagedTitle: string;
  /**
   * Demand the READY token as well: `<staged title> READY`, which a staged window only prints once
   * it has finished printing its content (`stagedTitle.ts`).
   *
   * This is a NARROWING and never a widening. Rule 2 above is applied first and unchanged — exact
   * app, this case's name, this run's nonce — and this adds a second substring on top of it, so no
   * window that was refused before can be approved because of it. It exists because the first run
   * against a screen showed the two Terminal cases approved and read while the staged shell had set
   * its title but not yet printed a line: the guard was answering "is the right window in front",
   * which is not the same question as "is the text there yet", and both stagings came back
   * `noMarkers`. Absent or `false`, the rule is exactly what it was.
   */
  requireReady?: boolean;
}

/**
 * One window against one expectation.
 *
 * `app` is compared exactly and `title` by substring, because that is the shape of the two facts:
 * the window server reports one app name per window and it is either ours or somebody's, while a
 * window title is the page title plus whatever the browser appends to it (phase 0's Chrome reads
 * came back titled `Staged chat`, but a suffix such as " - Google Chrome" is a browser's business
 * and must not break the match). The staged title itself is checked for being one of ours first, so
 * an empty or malformed expectation cannot turn the substring test into "any title at all".
 */
export function approve(window: FrontWindow | null, expectation: Expectation): Approval | null {
  if (window === null) return null;
  if (!isStagedTitle(expectation.stagedTitle)) return null;
  if (window.app !== expectation.app) return null;
  if (!window.title.includes(expectation.stagedTitle)) return null;
  // Only ever after the four tests above, and only ever as one more thing to satisfy: the ready
  // token is part of THIS case's title (`<staged title> READY`), so a window carrying another
  // case's ready title, or another run's, has already failed the test above it.
  if (expectation.requireReady === true && !window.title.includes(readyMark(expectation.stagedTitle))) return null;
  return {[APPROVED]: true, window};
}

/**
 * What the wait ended with — and, when it ended badly, the two booleans that say WHY.
 *
 * `notStaged` is one word for four different situations, and the first real toolbar run
 * (2026-09-21, 40 rows of it) could not be told apart from the results file: no window in front at
 * all, somebody else's window, OUR app showing a page that is not ours (a connection error carries
 * the host as its title), or our app carrying a staged title belonging to another case. Two
 * booleans separate them:
 *
 * - `sawApp` — at some poll, the front window belonged to the app this case stages.
 * - `sawStagedTitle` — at some poll, the front window's title carried this harness's own prefix,
 *   whatever case or run it belonged to.
 *
 * They are OBSERVATIONS, not a relaxation: `approve` is unchanged and is still the only thing that
 * can produce an `Approval`. No title is kept — `sawStagedTitle` is the result of one `includes`
 * against a constant this harness owns.
 */
export type GuardOutcome =
  | {kind: "staged"; approval: Approval}
  | {kind: "notStaged"; sawApp: boolean; sawStagedTitle: boolean; refusedTitleLength: number | null};

/** No title is ever longer than this as far as this harness is concerned; see `refusedTitleLength`. */
export const REFUSED_TITLE_LENGTH_MAX = 10_000;

export interface GuardDeps {
  frontWindow(): Promise<FrontWindow | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Wait for the staged window to come to the front, polling. Gives up with `notStaged` rather than
 * reading whatever else is there — the owner's screen is not a fallback.
 */
export async function awaitStagedWindow(expectation: Expectation, deps: GuardDeps): Promise<GuardOutcome> {
  const timeoutMs = deps.timeoutMs ?? GUARD_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? GUARD_POLL_MS;
  const until = deps.now() + timeoutMs;
  let sawApp = false;
  let sawStagedTitle = false;
  /**
   * How long the longest REFUSED title of ours was, when one of our own windows carried our own
   * prefix and `approve` still said no.
   *
   * It is the evidence for the measurement of 2026-09-21: `frontAppSeen` and `stagedTitleSeen` both
   * true with the page fetched and answered 200 says the front window was ours and its title began
   * as ours, and only a title that does not CONTAIN the whole staged title can be refused after
   * that. One number says whether it had been shortened, and by how much. Bounded, so a pathological
   * title cannot put an arbitrary magnitude in the file, and `null` when it never happened.
   */
  let refusedTitleLength: number | null = null;
  for (;;) {
    const window = await deps.frontWindow();
    const approval = approve(window, expectation);
    if (window !== null) {
      // Booleans and one bounded length about the window that was refused. Nothing else is kept.
      const ours = window.app === expectation.app;
      if (ours) sawApp = true;
      // Gated on the app as well (review D, Minor 1): a title merely CONTAINING our prefix in
      // somebody's editor or terminal is not "our browser showing the wrong page", which is what
      // this field is read as, and `sawApp` already carries the other half.
      if (ours && window.title.includes(STAGED_TITLE_PREFIX)) {
        sawStagedTitle = true;
        if (approval === null) {
          const length = Math.min(window.title.length, REFUSED_TITLE_LENGTH_MAX);
          refusedTitleLength = refusedTitleLength === null ? length : Math.max(refusedTitleLength, length);
        }
      }
    }
    if (approval) return {kind: "staged", approval};
    if (deps.now() >= until) return {kind: "notStaged", sawApp, sawStagedTitle, refusedTitleLength};
    await deps.sleep(pollMs);
  }
}
