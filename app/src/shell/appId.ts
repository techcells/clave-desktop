import type {Flavour} from "../shared/flavour";

/**
 * The app's identity per flavour: the macOS bundle id (`scripts/package/bundle.mjs` BUNDLE_IDS, and
 * the dev bundle's id in `scripts/dev-bundle.mjs`), reused on Windows as the AppUserModelID.
 *
 * Windows groups a process's taskbar entry and its notifications under this id, and it shows a toast
 * only for an id it knows, i.e. one a Start menu shortcut carries. So the Windows installer must give
 * its shortcut exactly this id, or the daily review notification is dropped without an error.
 * `appId.test.ts` keeps it equal to the macOS ids.
 */
export const APP_IDS: Readonly<Record<Flavour, string>> = {
  dev: "dev.clave.agent.dev",
  internal: "dev.clave.agent.internal",
  release: "dev.clave.agent"
};
