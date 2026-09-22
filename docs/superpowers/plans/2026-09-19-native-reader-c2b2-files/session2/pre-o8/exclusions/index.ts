import type {FrontWindow, SkipReason} from "../types";
import {BROWSERS, BUILT_IN_EXCLUSIONS, MEASURED_BROWSERS} from "./defaults";
import {hasPrivateToolbarMarker, isPrivateTitle} from "./privateWindows";
import {matchRule, parseRules} from "./rules";
import {parseSites, siteExcluded} from "./sites";

export interface Exclusions {
  valid: boolean;
  problems: string[];
  before(front: FrontWindow): SkipReason | null;
  after(front: FrontWindow, toolbarText: string | undefined): SkipReason | null;
}

/**
 * A browser is a name that IS a known browser or that begins with one followed by a space.
 * Exact equality used to be enough, and it let every channel variant through unchecked: "Google
 * Chrome Canary", "Brave Browser Beta" and "Firefox Developer Edition" were not browsers, so their
 * private windows were read in full with no strip and no private-window check. The space is a word
 * boundary, so "Archive Utility" is not "arc", "Operator" is not "opera" and "Minecraft" is not "min".
 */
const isBrowser = (app: string) => {
  const name = app.trim().toLowerCase();
  return BROWSERS.some((browser) => name === browser || name.startsWith(`${browser} `));
};
/** Exact, and deliberately not a prefix: a variant is a browser, but its strip height is not measured. */
const isMeasuredBrowser = (app: string) => MEASURED_BROWSERS.includes(app.trim().toLowerCase());
/** The reader is another process, so a front window is checked like any other outside input. */
const wellFormed = (front: unknown): front is FrontWindow =>
  typeof front === "object" && front !== null
  && typeof (front as FrontWindow).app === "string" && typeof (front as FrontWindow).title === "string";

export function createExclusions(input: {exclusions: unknown; excludedSites: unknown}): Exclusions {
  // Exact app-name match: a substring rule for "Dock" would wrongly exclude "Docker Desktop".
  const builtIn = new Set(BUILT_IN_EXCLUSIONS.map((name) => name.toLowerCase()));
  const user = parseRules(input.exclusions);
  const sites = parseSites(input.excludedSites);
  const problems = [...user.problems, ...sites.problems];
  const valid = problems.length === 0;

  return {
    valid,
    problems,
    before(front) {
      if (!valid) return "rulesInvalid";
      if (!wellFormed(front) || !front.app.trim() || !front.title.trim()) return "unknownWindow";
      if (builtIn.has(front.app.trim().toLowerCase())) return "excludedApp";
      // Decided before anything is captured: a browser whose toolbar strip the reader cannot find is not read.
      if (isBrowser(front.app) && !isMeasuredBrowser(front.app)) return "excludedApp";
      const hit = matchRule(user.rules, front);
      if (hit === "app") return "excludedApp";
      if (hit === "title") return "excludedTitle";
      if (isPrivateTitle(front.title)) return "privateWindow";
      return null;
    },
    after(front, toolbarText) {
      if (!valid) return "rulesInvalid";
      if (!wellFormed(front)) return "unknownWindow";
      if (!isBrowser(front.app)) return null;
      // The safety net behind `before`: a browser read that arrives without its strip cannot be checked
      // for a private window or an excluded site, so it is never kept.
      if (toolbarText === undefined) return "unknownWindow";
      if (toolbarText && hasPrivateToolbarMarker(toolbarText, front.app)) return "privateWindow";
      if (siteExcluded(sites.sites, front.title, toolbarText)) return "excludedSite";
      return null;
    }
  };
}
