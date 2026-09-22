import {describe, expect, it} from "vitest";
import {
  ACCURACY_CASES,
  BROWSER_WINDOW,
  DEFAULT_POSITION,
  OBSERVE_CASES,
  TERMINAL_NARROW,
  TERMINAL_WIDE,
  TOOLBAR_CASES,
  TOOLBAR_HOSTS,
  TOOLBAR_VARIANTS,
  DISPLAY_TOO_SMALL,
  STAGED_TITLE_MAX,
  allStagedIds,
  stagedIdFor,
  stagedTitleOf,
  interleavedToolbarCases,
  limitedTo,
  POSITION_OFF_DISPLAY,
  displayRefusal,
  fitsWorkArea,
  positioned
} from "./cases";
import {stagedTitleFor} from "./stagedTitle";
import {TOOLBAR_CAPTURES_PER_MODE} from "./thresholds";

describe("the accuracy cases", () => {
  it("are phase 0's sixteen browser cases plus two terminals", () => {
    expect(ACCURACY_CASES).toHaveLength(18);
    expect(ACCURACY_CASES.filter((entry) => entry.kind === "browser")).toHaveLength(16);
  });

  it("cover four pages, both themes and both sizes", () => {
    const browser = ACCURACY_CASES.filter((entry) => entry.kind === "browser");
    expect([...new Set(browser.map((entry) => entry.page))].sort()).toEqual(["chat", "code", "pt", "ticket"]);
    expect([...new Set(browser.map((entry) => entry.theme))].sort()).toEqual(["dark", "light"]);
    expect([...new Set(browser.map((entry) => entry.sizePx))].sort()).toEqual([11, 14]);
  });

  /**
   * Spec 10.1 item 15: phase 0 did not record window sizes, and the one unexplained result of the
   * whole phase (terminal 0.8686 -> 0.9882) was traced to a different window STATE. Every staged
   * window now has one recorded size.
   */
  it("stage every browser window at one recorded size and position", () => {
    for (const entry of ACCURACY_CASES) {
      if (entry.kind !== "browser") continue;
      expect(entry.window).toBe(BROWSER_WINDOW);
    }
    expect(BROWSER_WINDOW).toEqual({widthPt: 1160, heightPt: 640, xPt: 40, yPt: 60});
  });

  /** The narrow terminal is not optional: spec 10.1 item 15 names it. */
  it("include a wide terminal and a narrow one, at recorded sizes", () => {
    const terminals = ACCURACY_CASES.filter((entry) => entry.kind === "terminal");
    expect(terminals.map((entry) => entry.name)).toEqual(["terminal", "terminal-narrow"]);
    expect(terminals[0]).toMatchObject(TERMINAL_WIDE);
    expect(terminals[1]).toMatchObject(TERMINAL_NARROW);
    expect(TERMINAL_NARROW.columns).toBeLessThan(TERMINAL_WIDE.columns);
  });

  /**
   * The numbers themselves, since shake-down #5: the narrow case's point is the COLUMN count, and
   * the rows are 30 because a staged 40 could not be had on the owner's built-in Retina panel — the
   * shell reported 72 x 37 there — while this harness cannot choose which display Terminal opens on.
   * 30 holds `terminal.txt`'s 12 lines and the two markers with room over.
   */
  it("stage both terminals at 30 rows, and differ only in columns", () => {
    expect(TERMINAL_WIDE).toEqual({columns: 140, rows: 30});
    expect(TERMINAL_NARROW).toEqual({columns: 72, rows: 30});
    expect(TERMINAL_WIDE.rows).toBe(TERMINAL_NARROW.rows);
  });

  it("name each case after what it stages, and never twice", () => {
    const names = ACCURACY_CASES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("chat-light-14");
    expect(names).toContain("pt-dark-11");
  });

  it("point each case at its own truth file", () => {
    for (const entry of ACCURACY_CASES) {
      expect(entry.truth, entry.name).toBe(entry.kind === "terminal" ? "terminal" : entry.page);
    }
  });
});

describe("the toolbar cases", () => {
  it("are four hosts by five page variants, normal and incognito", () => {
    expect(TOOLBAR_HOSTS).toHaveLength(4);
    expect(TOOLBAR_VARIANTS).toHaveLength(5);
    expect(TOOLBAR_CASES).toHaveLength(40);
    expect(TOOLBAR_CASES.filter((entry) => entry.mode === "normal")).toHaveLength(TOOLBAR_CAPTURES_PER_MODE);
    expect(TOOLBAR_CASES.filter((entry) => entry.mode === "incognito")).toHaveLength(TOOLBAR_CAPTURES_PER_MODE);
  });

  it("carry the expectation in the case name, so an observation cannot be filed wrongly", () => {
    for (const entry of TOOLBAR_CASES) {
      expect(entry.expectPrivate, entry.name).toBe(entry.name.startsWith("incognito-"));
    }
  });

  it("use hosts that look like places somebody would mind being read", () => {
    expect(TOOLBAR_HOSTS).toContain("mybank.example.localhost");
    expect(TOOLBAR_HOSTS).toContain("mail.corp.localhost");
    for (const host of TOOLBAR_HOSTS) expect(host.endsWith(".localhost"), host).toBe(true);
  });
});

describe("the observe cases", () => {
  it("are five normal and five private stagings in each of the two browsers", () => {
    expect(OBSERVE_CASES).toHaveLength(20);
    expect(OBSERVE_CASES.filter((entry) => entry.expectPrivate)).toHaveLength(10);
    for (const app of ["Safari", "Google Chrome"]) {
      const inApp = OBSERVE_CASES.filter((entry) => entry.app === app);
      expect(inApp, app).toHaveLength(10);
      expect(inApp.filter((entry) => entry.expectPrivate), app).toHaveLength(5);
    }
    expect([...new Set(OBSERVE_CASES.map((entry) => entry.app))]).toEqual(["Safari", "Google Chrome"]);
  });

  /**
   * Chrome is here because `observe` is the only way to reach carried item 30's toolbar layouts: four
   * of the five (extensions row, side panel, tab group, theme) cannot be staged from a command line
   * at all, so the automated `toolbar` mode will never see them.
   */
  it("cover the five page variants in each browser and each window kind", () => {
    for (const app of ["Safari", "Google Chrome"]) {
      for (const expectPrivate of [true, false]) {
        const names = OBSERVE_CASES
          .filter((entry) => entry.app === app && entry.expectPrivate === expectPrivate)
          .map((entry) => `${entry.page}-${entry.theme}-${entry.sizePx}`);
        expect(new Set(names).size, `${app} ${String(expectPrivate)}`).toBe(5);
      }
    }
  });

  /**
   * The name is what goes inside the staged title, and the staged title is what the guard matched
   * before anything was read — so an observation cannot be filed under the wrong expectation, or
   * under the wrong browser, afterwards.
   */
  it("carry the browser and the expectation in the name, which is the name inside the staged title", () => {
    for (const entry of OBSERVE_CASES) {
      const slug = entry.app === "Safari" ? "safari" : "chrome";
      expect(entry.name.startsWith(`${slug}-`), entry.name).toBe(true);
      expect(entry.expectPrivate, entry.name).toBe(entry.name.startsWith(`${slug}-private-`));
    }
    expect(OBSERVE_CASES.map((entry) => entry.name)).toContain("chrome-private-chat-light-14");
    expect(OBSERVE_CASES.map((entry) => entry.name)).toContain("chrome-normal-chat-light-14");
  });

  it("gives every case a name of its own", () => {
    expect(new Set(OBSERVE_CASES.map((entry) => entry.name)).size).toBe(OBSERVE_CASES.length);
  });
});

describe("moving a staged window", () => {
  it("keeps the case's size and takes only the corner", () => {
    expect(positioned(BROWSER_WINDOW, {xPt: 3000, yPt: 140}))
      .toEqual({widthPt: 1160, heightPt: 640, xPt: 3000, yPt: 140});
  });

  /** The default corner is the box's own, so a run without `--position` stages where it always did. */
  it("changes nothing when it is given the default position", () => {
    expect(positioned(BROWSER_WINDOW, DEFAULT_POSITION)).toEqual({...BROWSER_WINDOW});
    expect(DEFAULT_POSITION).toEqual({xPt: BROWSER_WINDOW.xPt, yPt: BROWSER_WINDOW.yPt});
  });
});
/**
 * The size the table asks for has to FIT, or the window manager picks another one and every number
 * the run produces belongs to a window nobody chose — which is the first run against a screen
 * (2026-09-20) exactly: sixteen captures at 1416 x 1768 px against a staged 1268 x 708 pt, all of
 * them reported as passes. 1280 x 800 pt is the smallest work area this is expected to run on.
 */
describe("fitting the display", () => {
  /** A 1280 x 800 pt panel with a menu bar: the work area a MacBook of that size reports. */
  const SMALL = {xPt: 0, yPt: 25, widthPt: 1280, heightPt: 775};

  it("stages the default window inside a 1280 x 800 pt panel's work area", () => {
    expect(fitsWorkArea(positioned(BROWSER_WINDOW, DEFAULT_POSITION), SMALL)).toBe(true);
    expect(displayRefusal(SMALL, DEFAULT_POSITION, [...TOOLBAR_CASES])).toBeNull();
  });

  /** With room to spare on both sides, so a Dock or a taller menu bar does not turn it into a refusal. */
  it("leaves margin at the right and the bottom", () => {
    expect(BROWSER_WINDOW.xPt + BROWSER_WINDOW.widthPt).toBeLessThanOrEqual(1280 - 80);
    expect(BROWSER_WINDOW.yPt + BROWSER_WINDOW.heightPt).toBeLessThanOrEqual(800 - 100);
  });

  it("refuses a display that cannot hold the staged window, with a fixed code", () => {
    const tiny = {xPt: 0, yPt: 25, widthPt: 1024, heightPt: 743};
    expect(fitsWorkArea(positioned(BROWSER_WINDOW, DEFAULT_POSITION), tiny)).toBe(false);
    expect(displayRefusal(tiny, DEFAULT_POSITION, [...TOOLBAR_CASES])).toBe(DISPLAY_TOO_SMALL);
    expect(DISPLAY_TOO_SMALL).toBe("DISPLAY_TOO_SMALL");
  });

  /**
   * A position moves the box, so it can push it off — and that is a DIFFERENT instruction to the
   * owner than "this display is too small": one says move it, the other says not here at any corner.
   */
  it("refuses a position that puts the window off the work area, with its own code", () => {
    expect(displayRefusal(SMALL, {xPt: 400, yPt: 60}, [...TOOLBAR_CASES])).toBe(POSITION_OFF_DISPLAY);
    expect(displayRefusal(SMALL, {xPt: 40, yPt: 300}, [...TOOLBAR_CASES])).toBe(POSITION_OFF_DISPLAY);
    expect(POSITION_OFF_DISPLAY).toBe("POSITION_OFF_DISPLAY");
    expect(POSITION_OFF_DISPLAY).not.toBe(DISPLAY_TOO_SMALL);
  });

  /**
   * The Retina check (spec 10.1 item 8) staged on a SECOND display: its coordinates lie outside the
   * primary's work area by definition, so the work area has to be that display's own. Asking the
   * primary refused the one run `--position` exists for (review B, Important 2).
   */
  it("accepts a second display's corner when the work area is that display's", () => {
    const second = {xPt: 1512, yPt: 0, widthPt: 1920, heightPt: 1080};
    expect(displayRefusal(second, {xPt: 1600, yPt: 100}, [...TOOLBAR_CASES])).toBeNull();
    // and the primary's work area is exactly what would have refused it
    expect(displayRefusal(SMALL, {xPt: 1600, yPt: 100}, [...TOOLBAR_CASES])).toBe(POSITION_OFF_DISPLAY);
  });

  /** A window that starts above the work area is under the menu bar, which is a clipped window. */
  it("refuses a corner above or left of the work area", () => {
    expect(fitsWorkArea({widthPt: 100, heightPt: 100, xPt: 0, yPt: 0}, SMALL)).toBe(false);
    expect(fitsWorkArea({widthPt: 100, heightPt: 100, xPt: 0, yPt: 25}, SMALL)).toBe(true);
  });

  /** Exactly filling the work area is still fitting: the rule is about clipping, not about margin. */
  it("accepts a window that exactly fills the work area", () => {
    expect(fitsWorkArea({widthPt: 1280, heightPt: 775, xPt: 0, yPt: 25}, SMALL)).toBe(true);
    expect(fitsWorkArea({widthPt: 1281, heightPt: 775, xPt: 0, yPt: 25}, SMALL)).toBe(false);
  });

  it("checks every browser case, not only the first", () => {
    const wide = {window: {widthPt: 5000, heightPt: 100, xPt: 40, yPt: 60}};
    const fine = {window: BROWSER_WINDOW};
    expect(displayRefusal(SMALL, DEFAULT_POSITION, [fine, fine, wide])).toBe(DISPLAY_TOO_SMALL);
    expect(displayRefusal(SMALL, DEFAULT_POSITION, [fine, fine])).toBeNull();
  });
});
/**
 * A short run: the option that exists because the toolbar path failed 40/40 on a screen and a full
 * failing run costs the owner 24 minutes.
 */
describe("the cases a limited run stages", () => {
  it("takes the toolbar cases interleaved, so a short run measures both halves", () => {
    const order = interleavedToolbarCases();
    expect(order).toHaveLength(TOOLBAR_CASES.length);
    expect(order.slice(0, 4).map((entry) => entry.mode)).toEqual(["normal", "incognito", "normal", "incognito"]);
    // the same forty cases, each exactly once
    expect(new Set(order.map((entry) => entry.name)).size).toBe(TOOLBAR_CASES.length);
    expect(order.filter((entry) => entry.mode === "incognito")).toHaveLength(TOOLBAR_CAPTURES_PER_MODE);
  });

  it("gives an even limit as many private windows as normal ones", () => {
    const four = limitedTo(interleavedToolbarCases(), 4);
    expect(four.filter((entry) => entry.mode === "normal")).toHaveLength(2);
    expect(four.filter((entry) => entry.mode === "incognito")).toHaveLength(2);
  });

  it("is a PREFIX of the full run, so a short run stages what a long one would have staged first", () => {
    const full = interleavedToolbarCases();
    expect(limitedTo(full, 6)).toEqual(full.slice(0, 6));
  });

  it("takes the accuracy cases in table order", () => {
    expect(limitedTo(ACCURACY_CASES, 3)).toEqual(ACCURACY_CASES.slice(0, 3));
  });

  it("is the whole table when nobody asked for a limit, or asked for more than it holds", () => {
    expect(limitedTo(ACCURACY_CASES, null)).toEqual(ACCURACY_CASES);
    expect(limitedTo(ACCURACY_CASES, 1_000)).toHaveLength(ACCURACY_CASES.length);
  });
});
/**
 * The short ids (2026-09-21). A staged window's title carries `CLAVE-EVAL a07 <nonce>`, never the
 * case's name: a toolbar title was 73 characters and the guard was refusing windows whose reported
 * title did not contain it, with the page fetched and answered 200.
 */
describe("the id a staged title carries", () => {
  const tables = [
    ["accuracy", ACCURACY_CASES, "a"],
    ["toolbar", TOOLBAR_CASES, "t"],
    ["observe", OBSERVE_CASES, "o"]
  ] as const;

  it.each(tables)("gives every %s case an id of its own", (_name, table, letter) => {
    const ids = table.map((entry) => stagedIdFor(entry.name));
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(table.length);
    expect(ids.every((id) => (id as string).startsWith(letter))).toBe(true);
  });

  it("gives the three tables ids that cannot be confused with each other", () => {
    expect(new Set(allStagedIds()).size).toBe(ACCURACY_CASES.length + TOOLBAR_CASES.length + OBSERVE_CASES.length);
  });

  it("is fixed width, so no id can be a prefix of another", () => {
    const ids = allStagedIds();
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
    for (const id of ids) {
      const others = ids.filter((other) => other !== id);
      expect(others.some((other) => other.startsWith(id))).toBe(false);
    }
    // and the title puts a space and the nonce after it, so even a ragged scheme could not nest
    expect(stagedTitleFor("t1", "abc123def456").includes(stagedTitleFor("t13", "abc123def456"))).toBe(false);
    expect(stagedTitleOf(TOOLBAR_CASES[13]?.name ?? "", "abc123def456")).toContain(" t13 ");
  });

  it("keeps every table inside the two digits it has", () => {
    for (const [, table] of tables) expect(table.length).toBeLessThanOrEqual(99);
  });

  /** Minor 4: the cap is a literal a test pins and a rule the minting enforces, not a decoration. */
  it("caps a staged title at forty characters, and refuses to mint a longer one", () => {
    expect(STAGED_TITLE_MAX).toBe(40);
    // a nonce long enough to push the title past the cap is refused rather than staged
    expect(() => stagedTitleOf("chat-light-14", "n".repeat(30))).toThrow("EVAL_TITLE_TOO_LONG");
    expect(stagedTitleOf("chat-light-14", "n".repeat(25)).length).toBeLessThanOrEqual(STAGED_TITLE_MAX);
  });

  it("makes every staged title short enough for a window title to carry whole", () => {
    for (const name of [...ACCURACY_CASES, ...TOOLBAR_CASES, ...OBSERVE_CASES].map((entry) => entry.name)) {
      const title = stagedTitleOf(name, "38f0f465d288");
      expect(title.length, title).toBeLessThanOrEqual(STAGED_TITLE_MAX);
      // the measurement that forced this: the old form was 73 characters
      expect(title.length).toBeLessThan(`CLAVE-EVAL ${name} 38f0f465d288`.length + 1);
      expect(title).not.toContain(name);
    }
  });

  it("refuses to title a case that is in no table", () => {
    expect(stagedIdFor("chat-light-99")).toBeNull();
    expect(() => stagedTitleOf("chat-light-99", "abc123")).toThrow("EVAL_UNKNOWN_CASE");
  });

  /** The observe URLs the owner opens by hand carry the same ids; the table is what recovers the case. */
  it("lets an observe case be recovered from its id, never from free text", () => {
    const observed = OBSERVE_CASES[3] as (typeof OBSERVE_CASES)[number];
    const id = stagedIdFor(observed.name) as string;
    const back = OBSERVE_CASES.filter((entry) => stagedIdFor(entry.name) === id);
    expect(back).toHaveLength(1);
    expect(back[0]?.expectPrivate).toBe(observed.expectPrivate);
    expect(back[0]?.app).toBe(observed.app);
  });
});
