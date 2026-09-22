import {describe, expect, it} from "vitest";
import {DEV_SWITCHES, devEnv} from "./devEnv";

const full = {
  CLAVE_STANDINS: "1", CLAVE_SCRIPTED_MODEL: "1", CLAVE_SMOKE: "1",
  CLAVE_DATA_DIR: "/tmp/d", CLAVE_FIXTURES: "/tmp/f", CLAVE_MODEL_URL: "https://example.test/m.gguf",
  PATH: "/usr/bin", HOME: "/Users/someone"
};

describe("dev switches", () => {
  it("reads exactly the six switches out of the environment while unpackaged", () => {
    const env = devEnv(full, false);
    expect(Object.keys(env).sort()).toEqual([...DEV_SWITCHES].sort());
    expect(env.CLAVE_STANDINS).toBe("1");
    expect(env.CLAVE_DATA_DIR).toBe("/tmp/d");
    expect(env.CLAVE_FIXTURES).toBe("/tmp/f");
    expect(env.CLAVE_MODEL_URL).toBe("https://example.test/m.gguf");
    expect(Object.keys(env)).not.toContain("PATH");
  });

  it("answers undefined for every switch once the app is packaged, however the environment is set", () => {
    const env = devEnv(full, true);
    for (const name of DEV_SWITCHES) expect(env[name], name).toBeUndefined();
  });

  it("answers undefined for a switch that was not set", () => {
    const env = devEnv({}, false);
    for (const name of DEV_SWITCHES) expect(env[name], name).toBeUndefined();
  });

  it("does not read anything through the prototype chain", () => {
    const env = devEnv(Object.create({CLAVE_SMOKE: "1"}) as Record<string, string | undefined>, false);
    expect(env.CLAVE_SMOKE).toBeUndefined();
  });
});
