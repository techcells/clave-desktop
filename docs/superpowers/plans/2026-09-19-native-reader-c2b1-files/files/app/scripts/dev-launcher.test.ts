// Tests resolveLaunch (app/scripts/dev-launcher.cjs) in isolation, in plain Node: the module's own
// "apply to process.env and require(entry)" tail is gated on `process.versions.electron` (see that
// file's header comment), so importing it here for its pure function never touches the real
// filesystem, the real process.env, or tries to require a dist file that may not exist in this
// checkout yet.
//
// This is a .test.ts file importing a .cjs module: vitest transpiles with esbuild and does not
// type-check test files itself, so the interop below (a namespace import, since dev-launcher.cjs sets
// `module.exports = {resolveLaunch}` rather than a default export) runs fine even though the project's
// own `tsc -p tsconfig.json` never sees this file at all -- that config's `include` is `src/**/*.ts`
// only, so app/scripts/**/*.ts is out of its scope already, same as the other .mjs scripts in this
// folder.
import {describe, expect, it} from "vitest";
// eslint-disable-next-line -- CommonJS interop; see header comment.
import * as launcher from "./dev-launcher.cjs";

const {resolveLaunch} = launcher as {resolveLaunch: (args: {
  env: Record<string, string | undefined>;
  lastLaunch: unknown;
  appDir: string;
  home: string;
}) => {set: Record<string, string>; entry: string}};

const appDir = "/tmp/checkout/app";
const home = "/tmp/home";
const dataDir = "/tmp/home/Library/Application Support/Clave Agent Dev";
const fixtures = "/tmp/checkout/eval/fixtures";
const mainEntry = "/tmp/checkout/app/dist/main.cjs";
const evalEntry = "/tmp/checkout/app/dist/reader-eval.cjs";

describe("resolveLaunch", () => {
  it("bakes in all four defaults and the main entry when nothing else is set", () => {
    const {set, entry} = resolveLaunch({env: {}, lastLaunch: {}, appDir, home});
    expect(set).toEqual({
      CLAVE_STANDINS: "1", CLAVE_REAL_READER: "1", CLAVE_DATA_DIR: dataDir, CLAVE_FIXTURES: fixtures
    });
    expect(entry).toBe(mainEntry);
  });

  it("an env value already set wins over the baked default, for each of the four keys", () => {
    const env = {
      CLAVE_STANDINS: "0", CLAVE_REAL_READER: "0", CLAVE_DATA_DIR: "/explicit/data", CLAVE_FIXTURES: "/explicit/fixtures"
    };
    const {set} = resolveLaunch({env, lastLaunch: {}, appDir, home});
    expect(set).toEqual(env);
  });

  it("honours CLAVE_SCRIPTED_MODEL=1 from lastLaunch when env does not set it", () => {
    const {set} = resolveLaunch({env: {}, lastLaunch: {CLAVE_SCRIPTED_MODEL: "1"}, appDir, home});
    expect(set.CLAVE_SCRIPTED_MODEL).toBe("1");
  });

  it("leaves CLAVE_SCRIPTED_MODEL out of `set` entirely when neither env nor a valid lastLaunch supplies it", () => {
    const {set} = resolveLaunch({env: {}, lastLaunch: {}, appDir, home});
    expect(Object.hasOwn(set, "CLAVE_SCRIPTED_MODEL")).toBe(false);
  });

  it("an env value for CLAVE_SCRIPTED_MODEL wins over lastLaunch", () => {
    const {set} = resolveLaunch({
      env: {CLAVE_SCRIPTED_MODEL: "0"}, lastLaunch: {CLAVE_SCRIPTED_MODEL: "1"}, appDir, home
    });
    expect(set.CLAVE_SCRIPTED_MODEL).toBe("0");
  });

  it("ignores every OTHER key in lastLaunch, even ones that share a name with a real switch", () => {
    const {set, entry} = resolveLaunch({
      env: {},
      lastLaunch: {
        CLAVE_SCRIPTED_MODEL: "1",
        CLAVE_SMOKE: "1",
        CLAVE_DATA_DIR: "/attacker-controlled",
        CLAVE_DEV_ENTRY: "reader-eval"
      },
      appDir, home
    });
    // Only CLAVE_SCRIPTED_MODEL was accepted; CLAVE_DATA_DIR kept its baked default and the entry
    // stayed the main one, even though lastLaunch also named "reader-eval".
    expect(set).toEqual({
      CLAVE_STANDINS: "1", CLAVE_REAL_READER: "1", CLAVE_DATA_DIR: dataDir, CLAVE_FIXTURES: fixtures,
      CLAVE_SCRIPTED_MODEL: "1"
    });
    expect(entry).toBe(mainEntry);
  });

  it("ignores a lastLaunch CLAVE_SCRIPTED_MODEL value other than the exact string \"1\"", () => {
    for (const bad of ["true", "yes", 1, true, "01", " 1", ""]) {
      const {set} = resolveLaunch({env: {}, lastLaunch: {CLAVE_SCRIPTED_MODEL: bad}, appDir, home});
      expect(Object.hasOwn(set, "CLAVE_SCRIPTED_MODEL"), `value ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("routes to the reader-eval entry only for the exact env value CLAVE_DEV_ENTRY=reader-eval", () => {
    const {entry} = resolveLaunch({env: {CLAVE_DEV_ENTRY: "reader-eval"}, lastLaunch: {}, appDir, home});
    expect(entry).toBe(evalEntry);
  });

  it("any other CLAVE_DEV_ENTRY value, from env, falls back to the main entry", () => {
    for (const value of ["reader-eval2", "", "main", "READER-EVAL"]) {
      const {entry} = resolveLaunch({env: {CLAVE_DEV_ENTRY: value}, lastLaunch: {}, appDir, home});
      expect(entry, `value ${JSON.stringify(value)}`).toBe(mainEntry);
    }
  });

  it("never takes CLAVE_DEV_ENTRY from lastLaunch", () => {
    const {entry} = resolveLaunch({env: {}, lastLaunch: {CLAVE_DEV_ENTRY: "reader-eval"}, appDir, home});
    expect(entry).toBe(mainEntry);
  });

  it("treats a non-object lastLaunch (array, string, null, number) the same as no last launch", () => {
    for (const bad of [null, "not-json-shaped", 42, ["CLAVE_SCRIPTED_MODEL", "1"]]) {
      const {set} = resolveLaunch({env: {}, lastLaunch: bad, appDir, home});
      expect(Object.hasOwn(set, "CLAVE_SCRIPTED_MODEL"), `lastLaunch ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("does not read an inherited (prototype) property of env as if it were set", () => {
    const env = Object.create({CLAVE_DATA_DIR: "/inherited"}) as Record<string, string | undefined>;
    const {set} = resolveLaunch({env, lastLaunch: {}, appDir, home});
    expect(set.CLAVE_DATA_DIR).toBe(dataDir);
  });

  it("does not read an inherited (prototype) property of lastLaunch as if it were set", () => {
    const lastLaunch = Object.create({CLAVE_SCRIPTED_MODEL: "1"});
    const {set} = resolveLaunch({env: {}, lastLaunch, appDir, home});
    expect(Object.hasOwn(set, "CLAVE_SCRIPTED_MODEL")).toBe(false);
  });
});
