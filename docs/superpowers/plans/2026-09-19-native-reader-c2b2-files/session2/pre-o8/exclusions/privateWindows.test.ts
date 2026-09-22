import {describe, expect, it} from "vitest";
import {hasPrivateToolbarMarker, isPrivateTitle} from "./privateWindows";

describe("isPrivateTitle", () => {
  it.each([
    "New Tab - Google Chrome (Incognito)",
    "Example — Mozilla Firefox Private Browsing",
    "Start page - InPrivate - Microsoft Edge",
    "Nova aba — Navegação privativa",
    "Nueva pestaña - Navegación privada",
    "Neuer Tab – Privates Fenster"
  ])("flags %s", (title) => expect(isPrivateTitle(title)).toBe(true));

  // Regression list: every entry was once, or could plausibly be, a false positive.
  it.each([
    "Private API docs - Chrome",
    "My Private Repository · GitHub",
    "Secret Santa Planning - Google Sheets",
    "private.ts — checkout-api",
    "Incognito Marketing Agency - Home"
  ])("does not flag %s", (title) => expect(isPrivateTitle(title)).toBe(false));
});

describe("hasPrivateToolbarMarker", () => {
  it("flags the Chromium incognito label in the toolbar strip", () => {
    expect(hasPrivateToolbarMarker("example.com/pricing   Incognito")).toBe(true);
    expect(hasPrivateToolbarMarker("bing.com   InPrivate")).toBe(true);
  });

  // The renderings macOS text recognition produced for the real labels (phase 0, P5): the icon next
  // to the label comes out as a stray mark.
  it.each(["* Incognito", "- Incognito", "Incognito", "app.clave.localhost:8765/pt.html\n* Incognito"])(
    "flags Chrome's label as recognised: %s", (strip) => expect(hasPrivateToolbarMarker(strip, "Google Chrome")).toBe(true));

  it.each(["Private", "• Private", "¡• Private", "• Private\n@ 127.0.0.1", "PRIVATE"])(
    "flags Safari's badge as recognised: %s", (strip) => expect(hasPrivateToolbarMarker(strip, "Safari")).toBe(true));

  it("accepts the bare word for Safari only", () => {
    expect(hasPrivateToolbarMarker("• Private", "Google Chrome")).toBe(false);
    expect(hasPrivateToolbarMarker("github.com/acme/private-api/pulls", "Google Chrome")).toBe(false);
    expect(hasPrivateToolbarMarker("• Private")).toBe(false);
    expect(hasPrivateToolbarMarker("• Private", " safari ")).toBe(true);
  });

  // Regression list for Safari: the word must stand alone.
  it.each(["@ privately.example.com", "@ 127.0.0.1", "• privateer.io", "deprivate.example"])(
    "does not flag Safari's strip %s", (strip) => expect(hasPrivateToolbarMarker(strip, "Safari")).toBe(false));

  it("known cost, accepted by the owner: a Safari tab title with the word in the strip skips the read", () => {
    expect(hasPrivateToolbarMarker("Private API docs\n@ docs.example.com", "Safari")).toBe(true);
  });

  it("does not flag an ordinary toolbar", () => {
    expect(hasPrivateToolbarMarker("github.com/acme/checkout-api/pulls")).toBe(false);
    expect(hasPrivateToolbarMarker("")).toBe(false);
  });
});
