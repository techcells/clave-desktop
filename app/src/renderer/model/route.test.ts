import {describe, expect, it} from "vitest";
import {parseRoute, routeHash} from "./route";

describe("the window's hash", () => {
  it("reads the four screens", () => {
    expect(parseRoute("#/home")).toEqual({screen: "home", step: null});
    expect(parseRoute("#/review")).toEqual({screen: "review", step: null});
    expect(parseRoute("#/settings")).toEqual({screen: "settings", step: null});
    expect(parseRoute("#/onboarding")).toEqual({screen: "onboarding", step: null});
  });

  it("carries one onboarding step, so a home blocker can send the user to exactly that step", () => {
    expect(parseRoute("#/onboarding/permission")).toEqual({screen: "onboarding", step: "permission"});
    expect(parseRoute("#/onboarding/signIn")).toEqual({screen: "onboarding", step: "signIn"});
    expect(routeHash("onboarding", "permission")).toBe("#/onboarding/permission");
    expect(routeHash("review")).toBe("#/review");
    expect(routeHash("onboarding")).toBe("#/onboarding");
  });

  it("forgets a step that is not a step, and a screen that is not a screen", () => {
    expect(parseRoute("#/onboarding/nonsense")).toEqual({screen: "onboarding", step: null});
    expect(parseRoute("#/review/permission")).toEqual({screen: "review", step: null});
    expect(parseRoute("#/nonsense")).toBeNull();
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#/")).toBeNull();
  });

  it("does not care how the hash is punctuated, because the tray and the tabs both write it", () => {
    expect(parseRoute("home")).toEqual({screen: "home", step: null});
    expect(parseRoute("#home")).toEqual({screen: "home", step: null});
    expect(parseRoute("#/home/")).toEqual({screen: "home", step: null});
  });
});
