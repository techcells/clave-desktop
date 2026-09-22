import {describe, expect, it} from "vitest";
import {APP_NAME, appNameFrom, FLAVOUR, FLAVOURS, flavourFrom} from "./flavour";

describe("flavourFrom: a build-time value becomes one of three flavours, never anything else", () => {
  it("keeps the three names", () => {
    for (const name of FLAVOURS) expect(flavourFrom(name)).toBe(name);
  });

  it("is dev for anything that is not exactly one of them", () => {
    for (const value of [undefined, null, "", "Release", "internal ", 1, {}, ["release"]]) expect(flavourFrom(value)).toBe("dev");
  });
});

describe("appNameFrom", () => {
  it("takes a non-empty string and nothing else", () => {
    expect(appNameFrom("Clave Agent Internal")).toBe("Clave Agent Internal");
    for (const value of [undefined, null, "", 3, {}]) expect(appNameFrom(value)).toBe("Clave Agent");
  });
});

describe("under the test runner, where nothing is defined", () => {
  it("the flavour is dev and the name is Clave Agent", () => {
    expect(FLAVOUR).toBe("dev");
    expect(APP_NAME).toBe("Clave Agent");
  });
});
