import type {Blocker, EngineStatus} from "../../shared/ipc";
import {COPY} from "../copy";

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
 * How one excluded-app rule reads on screen. Rules are stored as `app::title words`, split at the
 * first "::" exactly as `parseRules` (core/exclusions/rules.ts) splits them, so "1Password::" reads
 * "1Password" and "::online banking" reads as a sentence about window titles. A plain entry (no
 * "::") matches the app OR the title, and says so: it must never read like the app-only rule with
 * the same name, because `addEntry` refuses a duplicate by what it reads. One that matches nothing
 * ("::") is shown as stored, so it can still be seen and removed. Only the display changes: the
 * list stores, saves and removes the rule itself.
 */
export function ruleLabel(entry: string): string {
  const cut = entry.indexOf("::");
  if (cut === -1) return COPY.exclusions.either(entry.trim());
  const app = entry.slice(0, cut).trim();
  const words = entry.slice(cut + 2).trim();
  if (app && words) return COPY.exclusions.appWithTitle(app, words);
  if (app) return app;
  if (words) return COPY.exclusions.anyTitle(words);
  return entry;
}

/**
 * Whether the list already keeps `app` out entirely: an app-only rule or a plain entry with exactly
 * its name, in any case. Settings asks this before offering "Exclude <app>". A rule on the app's
 * titles only ("Slack::general", "::Slack") does not count: the app is still read.
 */
export function excludesApp(list: readonly string[], app: string): boolean {
  const name = app.trim().toLowerCase();
  return list.some((entry) => {
    const cut = entry.indexOf("::");
    if (cut === -1) return entry.trim().toLowerCase() === name;
    return entry.slice(cut + 2).trim() === "" && entry.slice(0, cut).trim().toLowerCase() === name;
  });
}

/**
 * Adding one entry to a list of excluded apps or sites. Trims it, refuses an empty one, and refuses
 * one that would READ the same as an entry already listed, whatever its case, because "Slack" and
 * "slack" would both be shown and only confuse someone checking what is excluded. `label` is how the
 * list shows an entry: `ruleLabel` for apps, whose readings differ whenever the engine would treat
 * two typed rules differently, so a rule that covers more ("WhatsApp" beside "WhatsApp::") is not
 * refused (only text built to look like a reading, or a "::" that matches nothing, can blur this);
 * sites are shown as typed. `null` means "nothing to save": the caller leaves the list as
 * it is, so an accidental Return never writes settings.
 */
export function addEntry(list: readonly string[], raw: string, label: (entry: string) => string = (entry) => entry): string[] | null {
  const entry = raw.trim();
  if (entry.length === 0) return null;
  const shown = label(entry).toLowerCase();
  if (list.some((existing) => label(existing).toLowerCase() === shown)) return null;
  return [...list, entry];
}

/** Removing one entry. Exact stored text: the row the user pressed, whatever it reads as. */
export const removeEntry = (list: readonly string[], entry: string): string[] => list.filter((e) => e !== entry);

/** One row of an exclusion list: keyed and removed by the stored entry, shown by its reading. */
export interface EntryRow {key: string; text: string; removeLabel: string; without: string[]}

export const entryRows = (list: readonly string[], label: (entry: string) => string = (entry) => entry): EntryRow[] =>
  list.map((entry) => ({key: entry, text: label(entry), removeLabel: COPY.common.remove(label(entry)), without: removeEntry(list, entry)}));
