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
import {isStagedTitle} from "./stagedTitle";
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
  return {[APPROVED]: true, window};
}

export type GuardOutcome = {kind: "staged"; approval: Approval} | {kind: "notStaged"};

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
  for (;;) {
    const approval = approve(await deps.frontWindow(), expectation);
    if (approval) return {kind: "staged", approval};
    if (deps.now() >= until) return {kind: "notStaged"};
    await deps.sleep(pollMs);
  }
}
