import {describe, expect, it} from "vitest";
import {extractHosts, hostMatches, parseSites, siteExcluded} from "./sites";

describe("parseSites", () => {
  it("lowercases and accepts hostnames and bare labels", () => {
    expect(parseSites(["PayPal.com", " chase "])).toEqual({sites: ["paypal.com", "chase"], problems: []});
  });
  it("rejects anything that is not a hostname or label", () => {
    expect(parseSites(["https://paypal.com"]).problems.length).toBe(1);
    expect(parseSites(["pay pal"]).problems.length).toBe(1);
    expect(parseSites("paypal.com").problems.length).toBe(1);
  });
});

describe("extractHosts", () => {
  it("pulls hostnames out of recognised toolbar text", () => {
    expect(extractHosts("https://online.chase.com/accounts/summary")).toEqual(["online.chase.com"]);
    expect(extractHosts("github.com/acme/api   localhost:3000")).toEqual(["github.com"]);
  });
  it("returns nothing for text without a hostname", () => {
    expect(extractHosts("Search or enter address")).toEqual([]);
  });
});

describe("hostMatches", () => {
  it("matches a domain exactly or on a dot boundary", () => {
    expect(hostMatches("paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("www.paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("notpaypal.com", "paypal.com")).toBe(false);
  });
  it("matches a bare label against any domain label", () => {
    expect(hostMatches("online.chase.com", "chase")).toBe(true);
    expect(hostMatches("chase.co.uk", "chase")).toBe(true);
    expect(hostMatches("purchase.com", "chase")).toBe(false);
  });
});

describe("siteExcluded", () => {
  const sites = ["paypal.com", "chase"];
  it("drops on the toolbar host", () => {
    expect(siteExcluded(sites, "Summary", "https://www.paypal.com/myaccount")).toBe(true);
  });
  it("drops on the title when the toolbar gave nothing", () => {
    expect(siteExcluded(sites, "Chase Online - Accounts", undefined)).toBe(true);
    expect(siteExcluded(sites, "PayPal.com: Wallet", "")).toBe(true);
  });
  it("does not drop on a substring of another word", () => {
    expect(siteExcluded(sites, "Purchase order 12 - Docs", "docs.google.com/document/d/1")).toBe(false);
  });
});
