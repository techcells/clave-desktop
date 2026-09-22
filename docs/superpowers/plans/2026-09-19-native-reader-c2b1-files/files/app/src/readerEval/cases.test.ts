import {describe, expect, it} from "vitest";
import {
  ACCURACY_CASES,
  BROWSER_WINDOW,
  OBSERVE_CASES,
  TERMINAL_NARROW,
  TERMINAL_WIDE,
  TOOLBAR_CASES,
  TOOLBAR_HOSTS,
  TOOLBAR_VARIANTS
} from "./cases";
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
    expect(BROWSER_WINDOW).toEqual({widthPt: 1268, heightPt: 708, xPt: 40, yPt: 60});
  });

  /** The narrow terminal is not optional: spec 10.1 item 15 names it. */
  it("include a wide terminal and a narrow one, at recorded sizes", () => {
    const terminals = ACCURACY_CASES.filter((entry) => entry.kind === "terminal");
    expect(terminals.map((entry) => entry.name)).toEqual(["terminal", "terminal-narrow"]);
    expect(terminals[0]).toMatchObject(TERMINAL_WIDE);
    expect(terminals[1]).toMatchObject(TERMINAL_NARROW);
    expect(TERMINAL_NARROW.columns).toBeLessThan(TERMINAL_WIDE.columns);
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
  it("are five normal and five private Safari stagings", () => {
    expect(OBSERVE_CASES).toHaveLength(10);
    expect(OBSERVE_CASES.filter((entry) => entry.expectPrivate)).toHaveLength(5);
    for (const entry of OBSERVE_CASES) expect(entry.app).toBe("Safari");
  });

  it("carry the expectation in the name, which is the name inside the staged title", () => {
    for (const entry of OBSERVE_CASES) {
      expect(entry.expectPrivate, entry.name).toBe(entry.name.startsWith("safari-private-"));
    }
  });
});
