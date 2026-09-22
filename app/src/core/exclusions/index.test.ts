import {describe, expect, it} from "vitest";
import {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./defaults";
import {createExclusions} from "./index";

const defaults = () => createExclusions({exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES});

describe("before capture", () => {
  it("denies unknown windows", () => {
    const x = defaults();
    expect(x.before({app: "", title: "x"})).toBe("unknownWindow");
    expect(x.before({app: "Code", title: "  "})).toBe("unknownWindow");
  });

  it("denies built-in system surfaces and our own app, which the user cannot re-enable", () => {
    const x = createExclusions({exclusions: [], excludedSites: []});
    expect(x.before({app: "loginwindow", title: "Login"})).toBe("excludedApp");
    expect(x.before({app: "Clave Agent", title: "Review"})).toBe("excludedApp");
  });

  it("denies the app's own name for THIS build, whatever it is called, and keeps the release name too", () => {
    const x = createExclusions({exclusions: [], excludedSites: [], selfApp: "Clave Agent Internal"});
    expect(x.before({app: "Clave Agent Internal", title: "Review"})).toBe("excludedApp");
    expect(x.before({app: "  clave agent internal ", title: "Review"})).toBe("excludedApp");
    expect(x.before({app: "Clave Agent", title: "Review"})).toBe("excludedApp");
    expect(x.before({app: "Clave Agent Internals", title: "Doc"})).toBeNull();
  });

  it("without selfApp, or with a malformed one, only the built-in release name is denied", () => {
    expect(createExclusions({exclusions: [], excludedSites: []}).before({app: "Clave Agent Internal", title: "Review"})).toBeNull();
    for (const selfApp of ["", "   ", 7, null, [7, "", null], {name: "Clave Agent Internal"}]) {
      const x = createExclusions({exclusions: [], excludedSites: [], selfApp});
      expect(x.before({app: "Clave Agent Internal", title: "Review"}), String(selfApp)).toBeNull();
      expect(x.before({app: "Clave Agent", title: "Review"})).toBe("excludedApp");
    }
  });

  it("reads a browser only where its band was measured: by name AND by the bundle id the reader gives", () => {
    const x = createExclusions({exclusions: [], excludedSites: []});
    // Measured: Chrome and Safari on macOS, Edge on Windows.
    expect(x.before({app: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs"})).toBeNull();
    expect(x.before({app: "Safari", bundleId: "com.apple.Safari", title: "Docs"})).toBeNull();
    expect(x.before({app: "Microsoft Edge", bundleId: "msedge.exe", title: "Docs"})).toBeNull();
    // The same names elsewhere are not measured, and are refused before anything is captured.
    expect(x.before({app: "Google Chrome", bundleId: "chrome.exe", title: "Docs"})).toBe("excludedApp");
    expect(x.before({app: "Microsoft Edge", bundleId: "com.microsoft.edgemac", title: "Docs"})).toBe("excludedApp");
    // Unmeasured browsers stay refused.
    expect(x.before({app: "Brave Browser", bundleId: "brave.exe", title: "Docs"})).toBe("excludedApp");
    // After the read, an unmeasured Windows Chrome has no strip and is never kept either.
    expect(x.after({app: "Google Chrome", bundleId: "chrome.exe", title: "Docs"}, undefined)).toBe("unknownWindow");
  });

  it("denies every name in a selfApp list, such as an unpackaged run's \"Electron\", and only those", () => {
    const x = createExclusions({exclusions: [], excludedSites: [], selfApp: ["Clave Agent Dev", "Electron", 7]});
    expect(x.before({app: "Clave Agent Dev", title: "Review"})).toBe("excludedApp");
    expect(x.before({app: "Electron", title: "Clave Agent Dev"})).toBe("excludedApp");
    expect(x.before({app: "Clave Agent", title: "Review"})).toBe("excludedApp");
    expect(x.before({app: "Electron Fiddle", title: "Sketch"})).toBeNull();
  });

  it("excludes personal messengers and password managers by default", () => {
    const x = defaults();
    for (const app of ["Telegram", "WhatsApp", "Messages", "Signal", "1Password", "Bitwarden", "Keychain Access"]) {
      expect(x.before({app, title: "Main"})).toBe("excludedApp");
    }
  });

  it("reads work chat by default", () => {
    const x = defaults();
    for (const app of ["Slack", "Microsoft Teams", "Discord"]) expect(x.before({app, title: "#general"})).toBeNull();
  });

  it("does not exclude a window just because its title contains an excluded app's name", () => {
    const x = defaults();
    expect(x.before({app: "Slack", title: "Direct messages - Acme"})).toBeNull();
    expect(x.before({app: "Docker Desktop", title: "Containers"})).toBeNull();
    expect(x.before({app: "Code", title: "docker-compose.yml — checkout-api"})).toBeNull();
    expect(x.before({app: "Google Chrome", title: "Telegram Bot API docs"})).toBeNull();
  });

  it("reports title matches and private windows separately", () => {
    const x = defaults();
    expect(x.before({app: "Safari", title: "Online Banking - Accounts"})).toBe("excludedTitle");
    expect(x.before({app: "Google Chrome", title: "New Tab - Google Chrome (Incognito)"})).toBe("privateWindow");
  });

  // Private windows and excluded sites are recognised from the toolbar strip, and the reader can only
  // find the strip of a browser whose strip height was measured. Unknown means no.
  it.each(["Firefox", "Microsoft Edge", "Brave Browser", "Arc", "Opera", "Vivaldi", "Zen", "Chromium", "chrome"])(
    "does not read %s: no measured toolbar strip", (app) => {
      expect(defaults().before({app, title: "Pull requests · acme/api"})).toBe("excludedApp");
    });

  it.each(["Google Chrome", "Safari", " safari "])("reads %s, whose strip is measured", (app) => {
    expect(defaults().before({app, title: "Pull requests · acme/api"})).toBeNull();
  });

  // A channel variant is a browser. Its strip height was never measured, so it is not read — the
  // same answer the unmeasured browsers above get, reached through the name prefix.
  it.each([
    "Google Chrome Canary", "Safari Technology Preview", "Brave Browser Beta", "Microsoft Edge Dev",
    "Opera GX", "Firefox Developer Edition", "Orion", "Tor Browser", "LibreWolf", "Min"
  ])("does not read %s: a browser variant with no measured strip", (app) => {
    expect(defaults().before({app, title: "Pull requests · acme/api"})).toBe("excludedApp");
  });

  // The prefix match stops at a word boundary, so a name that merely starts with a browser's
  // letters is not a browser.
  it.each(["Archive Utility", "Operator", "Zenith", "Code", "Minecraft"])(
    "%s is not a browser and is read like any other app", (app) => {
      expect(defaults().before({app, title: "Pull requests · acme/api"})).toBeNull();
    });
});

describe("after recognition", () => {
  it("never keeps a browser read that arrives without its toolbar strip", () => {
    const x = defaults();
    expect(x.after({app: "Google Chrome", title: "Pull requests"}, undefined)).toBe("unknownWindow");
    expect(x.after({app: "Safari", title: "Pull requests"}, undefined)).toBe("unknownWindow");
    expect(x.after({app: "Code", title: "query.sql"}, undefined)).toBeNull();          // not a browser: nothing to check
  });

  // The safety net has to reach the variants too, or a read that slipped past `before` would be kept.
  it.each(["Google Chrome Canary", "Safari Technology Preview", "Brave Browser Beta", "Opera GX", "Orion"])(
    "never keeps a read from %s that arrives without its toolbar strip", (app) => {
      expect(defaults().after({app, title: "Pull requests"}, undefined)).toBe("unknownWindow");
    });

  it("recognises Safari's private badge, which is the bare word, in Safari only", () => {
    const x = defaults();
    expect(x.after({app: "Safari", title: "Example Domain"}, "• Private\n@ example.com")).toBe("privateWindow");
    expect(x.after({app: "Google Chrome", title: "acme/private-api"}, "github.com/acme/private-api")).toBeNull();
  });

  it("only inspects browsers", () => {
    const x = defaults();
    expect(x.after({app: "Code", title: "paypal.com notes.md"}, "paypal.com")).toBeNull();
  });
  it("drops excluded sites and Chromium private windows", () => {
    const x = defaults();
    expect(x.after({app: "Google Chrome", title: "Log in"}, "https://www.paypal.com/signin")).toBe("excludedSite");
    expect(x.after({app: "Google Chrome", title: "Example Domain"}, "example.com   Incognito")).toBe("privateWindow");
    expect(x.after({app: "Google Chrome", title: "Pull requests"}, "github.com/acme/api/pulls")).toBeNull();
  });
});

/**
 * Owner decision O8 (2026-09-21): a measured browser whose strip shows no address is not kept.
 * Measured the same day: on a page Safari offers to translate, the address field shows the message
 * "Translation Available" IN PLACE OF the host for the first seconds after the load, and the whole
 * recognised strip for that read was `Translation Available` plus a glyph. An excluded site is
 * recognised by its host on that strip, so in that window an excluded site would have been kept.
 */
describe("a measured browser whose strip shows no address (O8)", () => {
  it("does not keep the read Safari's translation banner produced", () => {
    expect(defaults().after({app: "Safari", title: "Como fazer pão"}, "Translation Available")).toBe("unknownWindow");
  });

  it("does not keep a read whose strip came back with nothing on it", () => {
    const x = defaults();
    expect(x.after({app: "Safari", title: "Pull requests"}, "")).toBe("unknownWindow");
    expect(x.after({app: "Google Chrome", title: "New Tab"}, "")).toBe("unknownWindow");
    expect(x.after({app: "Google Chrome", title: "Settings"}, "chrome://settings")).toBe("unknownWindow");
  });

  /**
   * The review of 2026-09-21, finding C1. The strip is the whole toolbar BAND, and in Chrome that
   * band is the tab strip plus the omnibox; in Safari the compact tab bar draws the other tabs'
   * titles in the same row as the address field (the same channel `privateWindows.ts` already
   * documents as a known cost of the neighbouring rule). So a real strip essentially always carries
   * tab titles, and every probe below was KEPT by the first version of this rule — including the
   * exact measured O8 scenario with one ordinary tab open beside it.
   */
  it.each([
    ["Safari", "Some page", "Translation Available\nNode.js docs"],
    ["Google Chrome", "Untitled", "chrome://settings\nNode.js docs"],
    ["Google Chrome", "Untitled", "Release 10.0.0.1 notes"],
    ["Google Chrome", "Untitled", "localhost setup guide"],
    ["Google Chrome", "Untitled", "[09:12:33] build ok"],
    ["Safari", "Some page", "Translation Available\nREADME.md - GitHub"]
  ])("does not keep %s with a tab title beside the banner: %s / %s", (app, title, strip) => {
    expect(defaults().after({app, title}, strip)).toBe("unknownWindow");
  });

  it("still keeps the read when one line of that band IS the address", () => {
    const x = defaults();
    expect(x.after({app: "Safari", title: "Pull requests"}, "Node.js docs\n@ github.com")).toBeNull();
    expect(x.after({app: "Google Chrome", title: "Dashboard"}, "Grafana\nlocalhost:3000/d/abc")).toBeNull();
  });

  /**
   * The re-review's N1: a trailing token was measured but never letter-checked, so an address-like
   * token plus up to three SHORT WORDS was an address line — and that re-opened the exact defect O8
   * was decided on. `"Translation Available\nNode.js API"` returned null (KEPT) until this was fixed.
   */
  it.each([
    "Translation Available\nNode.js API",
    "Translation Available\nREADME.md doc",
    "Translation Available\nmain.py fix",
    "Translation Available\ngithub.com PR",
    "Translation Available\nsite.com a b c"
  ])("does not keep a banner beside a tab title with a short word: %s", (strip) => {
    expect(defaults().after({app: "Safari", title: "Accounts"}, strip)).toBe("unknownWindow");
  });

  /**
   * N2: the 16-line cap kept the FIRST 16 lines, and in Chrome the omnibox is the BOTTOM row of the
   * band. A window with enough tabs silently and permanently stopped being read. There is no line cap.
   */
  it.each([14, 16, 20, 40])("keeps a Chrome read under %i lines of tab titles", (tabs) => {
    const band = "Some tab title\n".repeat(tabs) + "app.clave.localhost:8765/chat.html?theme=light";
    expect(defaults().after({app: "Google Chrome", title: "Chat"}, band)).toBeNull();
  });

  /**
   * N3: Chrome keeps a "Not secure" label on the address row of every http origin for as long as the
   * page is open, so this class was not a lost read but a permanently unreadable page — and it was
   * exactly the LAN and intranet population the single-label rule had just been added to serve.
   */
  it.each(["Not secure 192.168.1.20", "Not secure wiki/", "Not Secure example.test/login"])(
    "keeps an http LAN or intranet page behind Chrome's security label: %s", (strip) => {
      expect(defaults().after({app: "Google Chrome", title: "Router"}, strip)).toBeNull();
    });

  it("but the label alone is still a strip with no address", () => {
    expect(defaults().after({app: "Google Chrome", title: "Router"}, "Not secure")).toBe("unknownWindow");
  });

  // The target users spend the day on localhost and on a LAN address, neither of which is a host
  // `extractHosts` can see. Defining "no address" as "no host" would stop reading their own work.
  it.each([
    "github.com/acme/repo",
    "@ 127.0.0.1",
    "localhost:3000/dashboard",
    "app.clave.localhost:8765/chat.html?th",
    "192.168.1.20:8080",
    "[::1]:8080",
    "intranet:8080",
    "wiki/"
  ])("keeps a read whose strip shows %s", (strip) => {
    expect(defaults().after({app: "Google Chrome", title: "Dashboard"}, strip)).toBeNull();
  });

  // The new rule is last of the three. All three deny, so the order decides only which reason is
  // reported, and the most specific one should win. (It is NOT about the segmenter: `AWAY_REASONS`
  // is consulted on `before()`'s reason inside `gate()`, never on `after()`'s.)
  it("never masks the private-window answer, whose strip has no address of its own", () => {
    const x = defaults();
    expect(x.after({app: "Safari", title: "Example Domain"}, "• Private")).toBe("privateWindow");
    expect(x.after({app: "Google Chrome", title: "New Tab"}, "* Incognito")).toBe("privateWindow");
  });

  it("never masks the excluded-site answer, which the title alone can still give", () => {
    const x = defaults();
    expect(x.after({app: "Safari", title: "Sign in"}, "@ paypal.com")).toBe("excludedSite");
    expect(x.after({app: "Google Chrome", title: "Chase Online - Accounts"}, "Translation Available")).toBe("excludedSite");
  });

  it("leaves everything that is not a measured browser exactly as it was", () => {
    const x = defaults();
    expect(x.after({app: "Code", title: "query.sql"}, "")).toBeNull();
    expect(x.after({app: "Slack", title: "#general"}, "Translation Available")).toBeNull();
    // A browser with no measured strip never gets past `before`, so `after` judges no strip of its
    // own: the shape of its toolbar was never measured and there is nothing to read an address out of.
    expect(x.after({app: "Opera GX", title: "Docs"}, "Translation Available")).toBeNull();
  });
});

describe("invalid configuration", () => {
  it("denies everything until fixed", () => {
    const x = createExclusions({exclusions: [42], excludedSites: []});
    expect(x.valid).toBe(false);
    expect(x.problems.length).toBeGreaterThan(0);
    expect(x.before({app: "Code", title: "index.ts"})).toBe("rulesInvalid");
    expect(x.after({app: "Google Chrome", title: "x"}, "github.com")).toBe("rulesInvalid");
  });
});
