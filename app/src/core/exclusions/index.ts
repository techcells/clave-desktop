import type {FrontWindow, SkipReason} from "../types";
import {BROWSERS, BUILT_IN_EXCLUSIONS, MEASURED_BROWSERS} from "./defaults";
import {hasPrivateToolbarMarker, isPrivateTitle} from "./privateWindows";
import {matchRule, parseRules} from "./rules";
import {parseSites, showsAddress, siteExcluded} from "./sites";

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
/**
 * Exact, and deliberately not a prefix: a variant is a browser, but its strip height is not measured.
 * The bundle id must be one the band was measured for; a window with none matches only a `null`
 * entry (see `MEASURED_BROWSERS`).
 */
const isMeasuredBrowser = (front: FrontWindow) => {
  const name = front.app.trim().toLowerCase();
  const ids = Object.hasOwn(MEASURED_BROWSERS, name) ? MEASURED_BROWSERS[name] : undefined;
  return ids !== undefined && ids.includes(front.bundleId ?? null);
};
/** The reader is another process, so a front window is checked like any other outside input. */
const wellFormed = (front: unknown): front is FrontWindow =>
  typeof front === "object" && front !== null
  && typeof (front as FrontWindow).app === "string" && typeof (front as FrontWindow).title === "string";

export function createExclusions(input: {exclusions: unknown; excludedSites: unknown; selfApp?: unknown}): Exclusions {
  // Exact app-name match: a substring rule for "Dock" would wrongly exclude "Docker Desktop".
  const builtIn = new Set(BUILT_IN_EXCLUSIONS.map((name) => name.toLowerCase()));
  // The app's own name in this build joins the built-ins (packaging: an internal build is "Clave Agent
  // Internal"). Anything but a non-blank string is ignored: the built-in release name still stands.
  for (const name of Array.isArray(input.selfApp) ? input.selfApp : [input.selfApp]) {
    if (typeof name === "string" && name.trim().length > 0) builtIn.add(name.trim().toLowerCase());
  }
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
      if (isBrowser(front.app) && !isMeasuredBrowser(front)) return "excludedApp";
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
      // Owner decision O8 (2026-09-21): a measured browser whose strip shows NO address is not kept.
      // Measured that day: on a page Safari offers to translate, the address field shows the message
      // "Translation Available" IN PLACE OF the host for the first seconds after the load, and the
      // whole recognised strip was that message plus a glyph. An excluded site is recognised by its
      // host on that strip (`siteExcluded` → `extractHosts`), so in that window an excluded site
      // would have been KEPT. Fail closed: no address, no read. For a banner that comes and goes the
      // cost is one lost read, because the capture loop reads again 5 s later when the host is back;
      // for a label the browser keeps on the row for as long as the page is open that consolation is
      // false, which is why `BROWSER_ADDRESS_LABELS` exists. `showsAddress` asks the question PER
      // LINE of the band and is broader than `extractHosts`; its own doc comment has the whole
      // grammar, the reason for the line scope, and the residual hole it does not close.
      //
      // LAST of the three, and that order is a deliberate choice about WHICH REASON IS REPORTED.
      // All three deny the read, so nothing is kept whichever fires; the reason lands in the
      // counters (`reads.skipped.<reason>`) and the most specific, privacy-meaningful one should win:
      // · after the private marker, because a private window's strip has no address of its own
      //   ("• Private", "* Incognito"), and "this was a private window" says more than "this strip
      //   had no address on it".
      // · after the excluded site, because the title alone can still name one when the strip does
      //   not (`siteExcluded` falls back to `titleMentions`), and that is the more precise answer.
      // NOT about the segmenter: `AWAY_REASONS` (`core/index.ts`) is consulted only in `gate()`, on
      // the reason `before()` gave, and `gate()` has already called `segmenter.captureAllowed(now,
      // true)` by the time `after()` runs. In `after()` every reason is equally inert toward the
      // segmenter — an earlier version of this comment claimed otherwise and was wrong.
      //
      // Measured browsers only. An unmeasured browser is refused before anything is captured
      // (`before`), so `after` is only its safety net; the position of the address field inside the
      // strip was measured for these two and for no others, so there is no strip of a known shape
      // to judge. Non-browsers never reach here at all.
      if (isMeasuredBrowser(front) && !showsAddress(toolbarText)) return "unknownWindow";
      return null;
    }
  };
}
