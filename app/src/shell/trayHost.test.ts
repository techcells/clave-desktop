import {describe, expect, it} from "vitest";
import {closeAction, trayHostFrom} from "./trayHost";

describe("tray host", () => {
  it("reads gdbus's answer to NameHasOwner", () => {
    expect(trayHostFrom("(true,)\n")).toBe(true);
    expect(trayHostFrom("(false,)\n")).toBe(false);
  });

  it("treats anything else as no tray, so the window is never hidden out of reach", () => {
    for (const output of ["", "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown", "(true)", "true", "(maybe,)"]) {
      expect(trayHostFrom(output), JSON.stringify(output)).toBe(false);
    }
  });

  it("hides a closed window only when a tray can bring it back, and minimises it otherwise", () => {
    expect(closeAction(true)).toBe("hide");
    expect(closeAction(false)).toBe("minimize");
  });
});
