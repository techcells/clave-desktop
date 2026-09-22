import {describe, expect, it} from "vitest";
import {EVAL_MODES, counted, readEvalSettings} from "./config";

const NONCE = () => "generated-nonce";
const full = {
  CLAVE_EVAL_MODE: "accuracy",
  CLAVE_EVAL_NONCE: "abc123",
  CLAVE_EVAL_VARIANT: "none",
  CLAVE_EVAL_REPETITIONS: "5",
  CLAVE_EVAL_SECONDS: "120"
};

describe("the mode", () => {
  it.each(EVAL_MODES)("takes %s", (mode) => {
    const read = readEvalSettings({...full, CLAVE_EVAL_MODE: mode}, NONCE);
    expect(read.ok && read.settings.mode).toBe(mode);
  });

  /**
   * The finding this exists for. An unrecognised mode used to be cast, not checked: every `mode ===`
   * test in `main.ts` then failed, nothing was staged, nothing was read — and the summary of a run
   * that measured nothing came back `accepted: true` with exit code 0.
   */
  it.each([
    ["a mode it does not have", "everything"],
    ["a mode differing only in case", "Accuracy"],
    ["an empty mode", ""],
    ["a mode with the CLI's own spacing", " accuracy"]
  ])("refuses %s", (_label, mode) => {
    expect(readEvalSettings({...full, CLAVE_EVAL_MODE: mode}, NONCE)).toEqual({ok: false, code: "BAD_MODE"});
  });

  /** Absent is refused too: nobody said what to measure, so there is nothing to report on. */
  it("refuses a mode that is not set at all", () => {
    const {CLAVE_EVAL_MODE: _ignored, ...rest} = full;
    expect(readEvalSettings(rest, NONCE)).toEqual({ok: false, code: "BAD_MODE"});
  });
});

describe("the Chrome variant", () => {
  it.each(["none", "bookmarks-bar"])("takes %s", (variant) => {
    const read = readEvalSettings({...full, CLAVE_EVAL_VARIANT: variant}, NONCE);
    expect(read.ok && read.settings.variant).toBe(variant);
  });

  /** It reaches the results file verbatim as `chromeVariant`, so an arbitrary string may not. */
  it.each([["one it does not have", "dark-theme"], ["an empty one", ""]])("refuses %s", (_label, variant) => {
    expect(readEvalSettings({...full, CLAVE_EVAL_VARIANT: variant}, NONCE)).toEqual({ok: false, code: "BAD_VARIANT"});
  });

  /** Unset is the phase-0 default profile, which is what an ordinary run should be comparable with. */
  it("defaults to none when it is not set at all", () => {
    const {CLAVE_EVAL_VARIANT: _ignored, ...rest} = full;
    const read = readEvalSettings(rest, NONCE);
    expect(read.ok && read.settings.variant).toBe("none");
  });
});

describe("the run nonce", () => {
  it("is taken when one was given", () => {
    const read = readEvalSettings(full, NONCE);
    expect(read.ok && read.settings.nonce).toBe("abc123");
  });

  /**
   * An EMPTY nonce is generated, not taken. `??` used to accept it, which made every staged title
   * `CLAVE-EVAL <case> ` — accepted by `isStagedTitle`, so the run would have had no run-identity at
   * all and two concurrent runs could have read each other's windows.
   */
  it("is generated when the variable is empty", () => {
    const read = readEvalSettings({...full, CLAVE_EVAL_NONCE: ""}, NONCE);
    expect(read.ok && read.settings.nonce).toBe("generated-nonce");
  });

  it("is generated when the variable is not set at all", () => {
    const {CLAVE_EVAL_NONCE: _ignored, ...rest} = full;
    const read = readEvalSettings(rest, NONCE);
    expect(read.ok && read.settings.nonce).toBe("generated-nonce");
  });
});

describe("the counted variables", () => {
  it("takes a whole number of at least one", () => {
    const read = readEvalSettings({...full, CLAVE_EVAL_REPETITIONS: "3", CLAVE_EVAL_SECONDS: "30"}, NONCE);
    expect(read.ok && read.settings.repetitions).toBe(3);
    expect(read.ok && read.settings.seconds).toBe(30);
  });

  it.each([["nought", "0"], ["a fraction", "2.5"], ["words", "lots"], ["nothing", ""], ["unset", undefined]])(
    "falls back on %s",
    (_label, raw) => {
      expect(counted(raw, 5)).toBe(5);
    }
  );

  it("uses the defaults when neither is set", () => {
    const {CLAVE_EVAL_REPETITIONS: _r, CLAVE_EVAL_SECONDS: _s, ...rest} = full;
    const read = readEvalSettings(rest, NONCE);
    expect(read.ok && read.settings.repetitions).toBe(5);
    expect(read.ok && read.settings.seconds).toBe(120);
  });
});
