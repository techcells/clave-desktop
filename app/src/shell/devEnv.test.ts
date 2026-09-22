import {describe, expect, it} from "vitest";
import {DEV_SWITCHES, devEnv} from "./devEnv";

const full = {
  CLAVE_STANDINS: "1", CLAVE_SCRIPTED_MODEL: "1", CLAVE_SMOKE: "1", CLAVE_REAL_READER: "1", CLAVE_REAL_API: "1",
  CLAVE_DATA_DIR: "/tmp/d", CLAVE_FIXTURES: "/tmp/f", CLAVE_MODEL_URL: "https://example.test/m.gguf", CLAVE_API_URL: "http://localhost:8080",
  PATH: "/usr/bin", HOME: "/Users/someone"
};

describe("dev switches", () => {
  it("reads exactly the listed switches out of the environment while unpackaged, every one of them", () => {
    const env = devEnv(full, false);
    expect(Object.keys(env).sort()).toEqual([...DEV_SWITCHES].sort());
    for (const name of DEV_SWITCHES) expect(env[name], name).toBe(full[name]);
    expect(env.CLAVE_STANDINS).toBe("1");
    expect(env.CLAVE_DATA_DIR).toBe("/tmp/d");
    expect(env.CLAVE_FIXTURES).toBe("/tmp/f");
    expect(env.CLAVE_MODEL_URL).toBe("https://example.test/m.gguf");
    expect(Object.keys(env)).not.toContain("PATH");
  });

  it("names the backend switches by their literal names, so dropping one from the list is caught here, not only by tsc", () => {
    expect(DEV_SWITCHES).toContain("CLAVE_API_URL");
    expect(DEV_SWITCHES).toContain("CLAVE_REAL_API");
    expect(DEV_SWITCHES).toContain("CLAVE_REAL_READER");
    expect(DEV_SWITCHES).toContain("CLAVE_STANDINS");
    // The fixture above must name every switch: this loop only pins values once tsc has pinned the keys.
    for (const name of DEV_SWITCHES) expect(Object.hasOwn(full, name), name).toBe(true);
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
