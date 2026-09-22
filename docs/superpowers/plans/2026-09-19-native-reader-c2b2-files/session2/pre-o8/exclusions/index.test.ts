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
    expect(x.after({app: "Safari", title: "Pull requests"}, "")).toBeNull();          // an empty strip is still a strip
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

describe("invalid configuration", () => {
  it("denies everything until fixed", () => {
    const x = createExclusions({exclusions: [42], excludedSites: []});
    expect(x.valid).toBe(false);
    expect(x.problems.length).toBeGreaterThan(0);
    expect(x.before({app: "Code", title: "index.ts"})).toBe("rulesInvalid");
    expect(x.after({app: "Google Chrome", title: "x"}, "github.com")).toBe("rulesInvalid");
  });
});
