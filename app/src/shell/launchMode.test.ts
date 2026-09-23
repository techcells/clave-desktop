import {describe, expect, it} from "vitest";
import {FLAVOURS} from "../shared/flavour";
import {devEnv, DEV_SWITCHES} from "./devEnv";
import {launchMode} from "./launchMode";

const all = Object.fromEntries(DEV_SWITCHES.map((name) => [name, "1"]));
const env = (values: Record<string, string> = {}, packaged = false) => devEnv(values, packaged);

describe("launch mode", () => {
  it("packaged internal: the real client (so real and Google sign-in), the real reader, the real model, production", () => {
    expect(launchMode({packaged: true, flavour: "internal", env: env(all, true)}))
      .toEqual({standIns: false, scriptedModel: false, smoke: false, realReader: true, realApi: true, production: true, refuse: null});
  });

  it("packaged release: the real client, the real reader, the real model, production", () => {
    expect(launchMode({packaged: true, flavour: "release", env: env(all, true)}))
      .toEqual({standIns: false, scriptedModel: false, smoke: false, realReader: true, realApi: true, production: true, refuse: null});
  });

  it("every packaged flavour runs the same way: no packaged build ever runs a stand-in", () => {
    for (const flavour of FLAVOURS) {
      expect(launchMode({packaged: true, flavour, env: env(all, true)}), flavour).toEqual(launchMode({packaged: true, flavour: "release", env: env(all, true)}));
    }
  });

  it("unpackaged: the real client beside the stand-in reader and model, never in the smoke run", () => {
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "1", CLAVE_REAL_API: "1", CLAVE_SCRIPTED_MODEL: "1"})}))
      .toMatchObject({standIns: true, realApi: true, realReader: false, scriptedModel: true, refuse: null});
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "1", CLAVE_REAL_API: "1", CLAVE_SMOKE: "1"})}))
      .toMatchObject({smoke: true, realApi: false});
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_REAL_API: "1"})}))
      .toMatchObject({standIns: false, realApi: false, refuse: "NO_READER_YET"});
  });

  it("packaged: the switches have no say even when the environment carries them", () => {
    // devEnv already blanks them when packaged; this pins that launchMode does not read anything else.
    const withSwitches = {...all} as unknown as ReturnType<typeof devEnv>;
    expect(launchMode({packaged: true, flavour: "internal", env: withSwitches}).scriptedModel).toBe(false);
    expect(launchMode({packaged: true, flavour: "internal", env: withSwitches}).smoke).toBe(false);
    expect(launchMode({packaged: true, flavour: "release", env: withSwitches}).standIns).toBe(false);
  });

  it("unpackaged with no switches is refused", () => {
    for (const flavour of FLAVOURS) expect(launchMode({packaged: false, flavour, env: env()}).refuse, flavour).toBe("NO_READER_YET");
  });

  it("unpackaged: exactly today's switches", () => {
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "1"})}))
      .toEqual({standIns: true, scriptedModel: false, smoke: false, realReader: false, realApi: false, production: false, refuse: null});
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "1", CLAVE_SCRIPTED_MODEL: "1", CLAVE_REAL_READER: "1"})}))
      .toMatchObject({scriptedModel: true, realReader: true});
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "1", CLAVE_SMOKE: "1", CLAVE_REAL_READER: "1"})}))
      .toMatchObject({smoke: true, realReader: false});
    // Without stand-ins the other switches are inert.
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_SCRIPTED_MODEL: "1", CLAVE_SMOKE: "1", CLAVE_REAL_READER: "1"})}))
      .toEqual({standIns: false, scriptedModel: false, smoke: false, realReader: false, realApi: false, production: false, refuse: "NO_READER_YET"});
  });

  it("a switch means on only when it is exactly \"1\": the dev launcher writes \"0\" for off", () => {
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "0"})}).standIns).toBe(false);
    expect(launchMode({packaged: false, flavour: "dev", env: env({CLAVE_STANDINS: "true"})}).standIns).toBe(false);
    const on = {CLAVE_STANDINS: "1"};
    expect(launchMode({packaged: false, flavour: "dev", env: env({...on, CLAVE_SCRIPTED_MODEL: "0", CLAVE_SMOKE: "0", CLAVE_REAL_READER: "0", CLAVE_REAL_API: "0"})}))
      .toMatchObject({standIns: true, scriptedModel: false, smoke: false, realReader: false, realApi: false});
  });

  it("unpackaged is never production, whatever the flavour define says", () => {
    for (const flavour of FLAVOURS) expect(launchMode({packaged: false, flavour, env: env(all)}).production, flavour).toBe(false);
  });
});
