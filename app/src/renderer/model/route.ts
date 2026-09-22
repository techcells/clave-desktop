import type {Screen, Step} from "./views";
import {STEPS} from "./views";

/**
 * Where the window is. The renderer is one page: the tray, the blocker buttons and the tabs all move
 * the location HASH and nothing else, because navigating to another file would tear down the page
 * that holds the open IPC subscriptions. `step` is only ever set for the onboarding screen, and only
 * when something outside onboarding asked for one particular step ("Screen Recording was switched
 * off" sends a finished user back to step 4 and nowhere else).
 */
export interface Route { screen: Screen; step: Step | null }

const SCREENS = new Set<string>(["onboarding", "home", "review", "settings"]);
const IS_STEP = (value: string): value is Step => (STEPS as readonly string[]).includes(value);

/**
 * Reads a hash into a route. `null` means "the hash says nothing": the caller then decides with
 * `startScreen`, which is the only place that decision is made. Anything unrecognised is also
 * `null` rather than a guess — a hash is user-writable text, and a typo must not strand the window
 * on a screen the state does not support.
 */
export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p.length > 0);
  const [screen, step] = parts;
  if (screen === undefined || !SCREENS.has(screen)) return null;
  if (screen !== "onboarding") return {screen: screen as Screen, step: null};
  return {screen: "onboarding", step: step !== undefined && IS_STEP(step) ? step : null};
}

/** The hash for a route: what a tab or a fix button writes to `location.hash`. */
export const routeHash = (screen: Screen, step: Step | null = null): string =>
  screen === "onboarding" && step !== null ? `#/onboarding/${step}` : `#/${screen}`;
