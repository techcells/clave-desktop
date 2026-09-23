import type {Flavour} from "../shared/flavour";
import type {DevEnv} from "./devEnv";

/**
 * What a launch runs with, decided from the build flavour and the development switches, in one pure
 * function so the rule is tested without Electron.
 *
 * Packaged builds: `devEnv` has already blanked every switch, and every packaged build runs the same
 * way: the real clave-back client (production, `apiUrl.ts`) with real and Google sign-in, the real
 * reader, the real model, never a stand-in and never the smoke run. `internal` used to keep the stub
 * backend, so its sign-in accepted any password and nothing reached Clave; since 2026-09-23 (owner
 * decision) it differs from `release` only in its name, bundle id and signing rules, so an internal
 * build can be signed in with a real account on either platform. `dev` packaged is not a thing (the
 * build script refuses it); it gets the same answer, so a garbled define can never run stand-ins in a
 * packaged app.
 *
 * Unpackaged: the switches as before, plus `CLAVE_REAL_API=1`, which swaps the real client in beside
 * the stand-in reader and model (`start:api`) so the backend can be exercised without a screen. No
 * `CLAVE_STANDINS` at all still means "the real reader", which the reader sub-project has not yet
 * declared ready: refused with `NO_READER_YET` until it does.
 */
export interface LaunchMode {
  standIns: boolean;
  scriptedModel: boolean;
  smoke: boolean;
  realReader: boolean;
  /** The HTTP clave-back client instead of the stub. */
  realApi: boolean;
  /** `createEngine` refuses stand-ins when this is true. */
  production: boolean;
  /** The start-failure code to throw before anything is built, or `null` to go ahead. */
  refuse: "NO_READER_YET" | null;
}

export function launchMode(input: {packaged: boolean; flavour: Flavour; env: DevEnv}): LaunchMode {
  const {packaged, env} = input;
  if (packaged) {
    return {standIns: false, scriptedModel: false, smoke: false, realReader: true, realApi: true, production: true, refuse: null};
  }
  const standIns = env.CLAVE_STANDINS === "1";
  const smoke = standIns && env.CLAVE_SMOKE === "1";
  return {
    standIns,
    scriptedModel: standIns && env.CLAVE_SCRIPTED_MODEL === "1",
    smoke,
    // Never in the unattended smoke run, which must not need a permission — nor the real backend, which it must not reach.
    realReader: standIns && !smoke && env.CLAVE_REAL_READER === "1",
    realApi: standIns && !smoke && env.CLAVE_REAL_API === "1",
    production: false,
    refuse: standIns ? null : "NO_READER_YET"
  };
}
