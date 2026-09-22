import {describe, expect, it} from "vitest";
import {samePage} from "./trust";

const PAGE = "file:///Applications/Clave.app/Contents/Resources/app/dist/renderer/index.html";

describe("the one page the IPC handlers answer", () => {
  it("is the same document with a route or a query on it", () => {
    expect(samePage(PAGE, PAGE)).toBe(true);
    expect(samePage(`${PAGE}#/settings`, PAGE)).toBe(true);
    expect(samePage(`${PAGE}#`, PAGE)).toBe(true);
    expect(samePage(`${PAGE}?x=1`, PAGE)).toBe(true);
    expect(samePage(`${PAGE}?x=1#/review`, PAGE)).toBe(true);
    expect(samePage(`${PAGE}#/review?x=1`, PAGE)).toBe(true);
  });

  it("is not any other file, however close the name", () => {
    expect(samePage(`${PAGE}.evil`, PAGE)).toBe(false);
    expect(samePage(`${PAGE}/`, PAGE)).toBe(false);
    expect(samePage("file:///Applications/Clave.app/Contents/Resources/app/dist/renderer/evil.html", PAGE)).toBe(false);
    expect(samePage("file:///tmp/index.html", PAGE)).toBe(false);
  });

  it("is never something off the machine, and never nothing at all", () => {
    expect(samePage("https://clave.example/index.html", PAGE)).toBe(false);
    expect(samePage("http://localhost:5173/index.html", PAGE)).toBe(false);
    expect(samePage("about:blank", PAGE)).toBe(false);
    expect(samePage("", PAGE)).toBe(false);
    expect(samePage("#/settings", PAGE)).toBe(false);
  });
});
