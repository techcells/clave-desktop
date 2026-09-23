import type {Blocker, EngineStatus} from "../../shared/ipc";

/**
 * Everything a status SAYS, as one string. A notice raised against one status (the blocker the
 * engine refused the switch with, "not quite ready") must disappear the moment a NEW status arrives,
 * and the arrival of a new status is a change in what it says — not the identity of the object a
 * re-fetch happened to build. Comparing the objects would clear the notice in the same turn it was
 * raised, because raising it is followed by a re-read that usually answers the very same thing.
 */
export const statusSignature = (status: EngineStatus): string => JSON.stringify([
  status.capture, status.resumeAt, status.extractionPaused, status.pending, status.waitingUpload, status.blockers,
  // The refusal while the permission is being checked has no blocker to change, so the check ending
  // is the one thing that says "not quite ready" no longer holds.
  status.checkingPermission
]);

/**
 * What the one fix button on the home screen actually does. The sentence and the label come from
 * `BLOCKERS` in copy.ts; this is the other half — which call to make — kept out of the component so
 * that "every blocker has exactly one button, and the button does the matching thing" is a thing a
 * test can check rather than something a reader has to trace through JSX.
 *
 * `reread` is not doing nothing: for a disk that refused a write and for a skills list that has not
 * arrived, the app is already retrying by itself, so the honest button asks the engine where it
 * stands again instead of pretending the user can force either one.
 */
export type FixAction =
  | "signIn" | "download" | "selfTest" | "permission" | "restart" | "settings" | "retryModel" | "retryReader" | "reread"
  // Linux: the GNOME extension. Installing again also switches it back on; GNOME's own switch for all
  // extensions is switched on only on the user's press (owner, Task 7 review I3); an unsupported GNOME
  // is the user's to change, so its button looks again.
  | "installExtension" | "logOut" | "enableExtensions" | "checkExtension";

export const FIX_ACTIONS: Record<Blocker, FixAction> = {
  SIGNED_OUT: "signIn",
  NO_TAXONOMY: "reread",
  MODEL_MISSING: "download",
  SELF_TEST_NEEDED: "selfTest",
  NO_PERMISSION: "permission",
  PERMISSION_NEEDS_RESTART: "restart",
  SETTINGS_NEED_REVIEW: "settings",
  MODEL_PROBLEM: "retryModel",
  READER_PROBLEM: "retryReader",
  STORAGE_PROBLEM: "reread",
  EXTENSION_MISSING: "installExtension",
  EXTENSION_OFF: "installExtension",
  EXTENSIONS_OFF_IN_GNOME: "enableExtensions",
  EXTENSION_NEEDS_LOGIN: "logOut",
  EXTENSION_UNSUPPORTED: "checkExtension"
};

export const fixAction = (blocker: Blocker): FixAction => FIX_ACTIONS[blocker];

/**
 * Adding one entry to a list of excluded apps or sites. Trims it, refuses an empty one, and refuses
 * a duplicate whatever its case, because "Slack" and "slack" would both be shown and only confuse
 * someone checking what is excluded. `null` means "nothing to save": the caller leaves the list as
 * it is, so an accidental Return never writes settings.
 */
export function addEntry(list: readonly string[], raw: string): string[] | null {
  const entry = raw.trim();
  if (entry.length === 0) return null;
  if (list.some((existing) => existing.toLowerCase() === entry.toLowerCase())) return null;
  return [...list, entry];
}

/** Removing one entry. Exact text, because that is what the list showed the user. */
export const removeEntry = (list: readonly string[], entry: string): string[] => list.filter((e) => e !== entry);
