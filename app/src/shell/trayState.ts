import type {Blocker, EngineStatus} from "../main/engine";

export type TrayState = "on" | "off" | "problem";

/**
 * What each blocker does to the tray icon. Written out one blocker at a time on purpose: a new
 * blocker added to the engine is a compile error here, so it can never silently fall into "off"
 * and leave a stopped app looking merely switched off.
 *
 * "problem" means something is wrong and needs the user; "off" means a step that is simply not
 * done yet (the onboarding order of spec section 7 walks the user through those).
 *
 * `PERMISSION_NEEDS_RESTART` and `SETTINGS_NEED_REVIEW` are problems, not unfinished steps: in both
 * cases the app WAS working and something took it apart (the permission was granted but needs a
 * relaunch to take; the exclusions file was lost and replaced by the defaults). Each has its own
 * sentence and fix button, so a tray that showed them as merely switched off would hide the one
 * thing the user has to do.
 */
export const BLOCKER_TRAY: Record<Blocker, "problem" | "off"> = {
  SIGNED_OUT: "problem",
  NO_PERMISSION: "problem",
  MODEL_PROBLEM: "problem",
  READER_PROBLEM: "problem",
  STORAGE_PROBLEM: "problem",
  PERMISSION_NEEDS_RESTART: "problem",
  SETTINGS_NEED_REVIEW: "problem",
  NO_TAXONOMY: "off",
  MODEL_MISSING: "off",
  SELF_TEST_NEEDED: "off",
  // Linux: each needs the user (install, a login, GNOME's own switch), so each is a problem.
  EXTENSION_MISSING: "problem",
  EXTENSION_OFF: "problem",
  EXTENSIONS_OFF_IN_GNOME: "problem",
  EXTENSION_NEEDS_LOGIN: "problem",
  EXTENSION_UNSUPPORTED: "problem"
};

/**
 * The tray icon state: reading, not reading, or not able to read.
 *
 * `onboarding` is true until the user has finished onboarding. Until then nothing is a "problem":
 * a new install is signed out and has no permission by definition, the window is already walking
 * the user through exactly those steps, and a "!" beside the clock would read as something broken.
 */
export function trayState(status: Pick<EngineStatus, "capture" | "blockers">, onboarding = false): TrayState {
  if (status.capture === "on") return "on";
  if (onboarding) return "off";
  return status.blockers.some((b) => BLOCKER_TRAY[b] === "problem") ? "problem" : "off";
}

/**
 * Everything the tray shows, as one string. The menu is rebuilt only when this changes, so a status
 * emit that moved nothing the user can see (a pause reason, an upload count) costs nothing.
 *
 * `nothingRead` is in here as a flag and not as its contents: the first menu item reads differently
 * while it is set, so the menu has to be rebuilt when it flips — but the sentence is the same one
 * whichever `why` it carries, and `since` does not move within a streak, so neither is worth a
 * rebuild. The tray TITLE is untouched: "nothing to read" is not a problem state, and turning the
 * glyph into "!" would send the user looking for something to fix.
 */
export const trayKey = (status: Pick<EngineStatus, "capture" | "blockers" | "pending" | "nothingRead">, onboarding = false): string =>
  `${trayState(status, onboarding)}|${status.capture}|${status.pending}|${status.nothingRead === null ? "reading" : "nothing"}`;
