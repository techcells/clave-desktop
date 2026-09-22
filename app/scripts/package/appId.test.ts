// The Windows AppUserModelID (src/shell/appId.ts) against the macOS bundle ids this module and the dev
// bundle use. Lives beside bundle.mjs because tsc does not type-check scripts/, as for its other tests.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {APP_IDS} from "../../src/shell/appId";
import * as bundleScript from "./bundle.mjs";

const {BUNDLE_IDS} = bundleScript as {BUNDLE_IDS: Record<string, string>};

describe("the app's id", () => {
  it("is the macOS bundle id of the same flavour, so both systems know the app by one name", () => {
    expect(APP_IDS.internal).toBe(BUNDLE_IDS.internal);
    expect(APP_IDS.release).toBe(BUNDLE_IDS.release);
    const devBundle = readFileSync(new URL("../dev-bundle.mjs", import.meta.url), "utf8");
    expect(devBundle).toContain(`const BUNDLE_ID = "${APP_IDS.dev}";`);
  });

  it("is different for every flavour, so an internal build's notifications never land under the release app", () => {
    expect(new Set(Object.values(APP_IDS)).size).toBe(Object.keys(APP_IDS).length);
  });
});
