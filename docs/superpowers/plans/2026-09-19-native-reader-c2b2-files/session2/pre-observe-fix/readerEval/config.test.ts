import {describe, expect, it} from "vitest";
import {DEFAULT_POSITION} from "./cases";
import {EVAL_MODES, LIMIT_MAX, limitsCases, POSITION_MAX_PT, POSITION_MIN_PT, counted, parseLimit, parsePosition, readEvalSettings, stagesWindows, wholePoint} from "./config";

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

describe("the modes that open a window", () => {
  /**
   * `coldstart` is the one mode that stages nothing, so `main.ts` serves no page, writes no scratch
   * folder and reads no truth for it. That is a structural claim about the entry point, which cannot
   * be unit-tested; this is the value it is built on.
   */
  it("is every mode but coldstart", () => {
    expect(EVAL_MODES.filter((mode) => !stagesWindows(mode))).toEqual(["coldstart"]);
    for (const mode of EVAL_MODES) expect(stagesWindows(mode), mode).toBe(mode !== "coldstart");
  });
});

describe("the staged window position", () => {
  it.each([
    ["the pair the plan names", "120,80", {xPt: 120, yPt: 80}],
    ["a corner at the origin", "0,0", {xPt: 0, yPt: 0}],
    ["a position on a second display", "3000,140", {xPt: 3000, yPt: 140}]
  ])("takes %s", (_label, raw, expected) => {
    expect(parsePosition(raw)).toEqual(expected);
    const read = readEvalSettings({...full, CLAVE_EVAL_POSITION: raw}, NONCE);
    expect(read.ok && read.settings.position).toEqual(expected);
  });

  /**
   * The refusal table of the plan's Task 1, in full. Every one of these is something `Number()`
   * alone would have taken: a word that is `NaN` is the only one it refuses.
   */
  it.each([
    ["two words", "a,b"],
    ["one number", "1"],
    ["a lone minus", "-,3"],
    ["a fractional coordinate", "3.2,4"],
    ["three numbers", "1,2,3"],
    ["nothing at all", ""],
    ["a missing coordinate", "40,"],
    ["a signed coordinate", "+40,60"],
    ["spaces around a number", " 40,60"],
    ["exponent notation", "1e3,60"],
    ["hexadecimal", "0x20,60"],
    ["a coordinate past the safe integer range", "9007199254740993,60"],
    // No screen is this large. A typo here stages every window off every display, so the guard
    // never sees one, every case comes back `notStaged` and the owner loses a whole session to a
    // stray digit -- fail-closed, but a wasted run. Refused before the bundle is even opened.
    ["an x past any screen", "20001,60"],
    ["a y past any screen", "40,20001"],
    ["a stray extra digit", "400,600000"]
  ])("refuses %s", (_label, raw) => {
    expect(parsePosition(raw)).toBeNull();
    expect(readEvalSettings({...full, CLAVE_EVAL_POSITION: raw}, NONCE)).toEqual({ok: false, code: "BAD_POSITION"});
  });

  /**
   * A display placed left of or above the primary one has NEGATIVE coordinates for its whole width
   * or height, and `--position` exists to stage the run on the other display. The owner's machine is
   * that arrangement, so a digits-only rule made the Retina check impossible to ask for.
   */
  it.each([
    ["a display to the left", "-2560,100", {xPt: -2560, yPt: 100}],
    ["a display above", "40,-900", {xPt: 40, yPt: -900}],
    ["both", "-2560,-900", {xPt: -2560, yPt: -900}],
    ["the bound itself", "-20000,-20000", {xPt: -20_000, yPt: -20_000}]
  ])("takes %s", (_label, raw, expected) => {
    expect(parsePosition(raw)).toEqual(expected);
    const read = readEvalSettings({...full, CLAVE_EVAL_POSITION: raw}, NONCE);
    expect(read.ok && read.settings.position).toEqual(expected);
  });

  it("refuses a negative coordinate past the bound", () => {
    expect(POSITION_MIN_PT).toBe(-20_000);
    expect(wholePoint(String(POSITION_MIN_PT))).toBe(POSITION_MIN_PT);
    expect(wholePoint(String(POSITION_MIN_PT - 1))).toBeNull();
    expect(parsePosition("-20001,60")).toBeNull();
  });

  /** A position decides which DISPLAY a run measured, so it is refused rather than quietly defaulted. */
  it("defaults to the corner every window has been staged at when it is not set at all", () => {
    const read = readEvalSettings(full, NONCE);
    expect(read.ok && read.settings.position).toEqual(DEFAULT_POSITION);
    expect(DEFAULT_POSITION).toEqual({xPt: 40, yPt: 60});
  });

  it("reads one coordinate as digits and nothing else", () => {
    expect(wholePoint("0")).toBe(0);
    expect(wholePoint("007")).toBe(7);
    expect(wholePoint("")).toBeNull();
    expect(wholePoint("-1")).toBe(-1);
    expect(wholePoint("-")).toBeNull();
    expect(wholePoint("1.0")).toBeNull();
  });

  /** The bound itself, so it is a number somebody chose rather than one that drifted. */
  it("takes a coordinate up to the bound and refuses the first one past it", () => {
    expect(POSITION_MAX_PT).toBe(20_000);
    expect(wholePoint(String(POSITION_MAX_PT))).toBe(POSITION_MAX_PT);
    expect(wholePoint(String(POSITION_MAX_PT + 1))).toBeNull();
    expect(parsePosition(`${POSITION_MAX_PT},${POSITION_MAX_PT}`)).toEqual({xPt: 20_000, yPt: 20_000});
  });
});

/** `--limit`, read from the environment: refused when it is set and unreadable, like its neighbours. */
describe("how many cases to stage", () => {
  it("is the whole table when nobody asked", () => {
    const read = readEvalSettings(full, NONCE);
    expect(read.ok && read.settings.limit).toBeNull();
  });

  it.each(["1", "4", "18", String(LIMIT_MAX)])("takes %s", (raw) => {
    const read = readEvalSettings({...full, CLAVE_EVAL_LIMIT: raw}, NONCE);
    expect(read.ok && read.settings.limit).toBe(Number(raw));
    expect(parseLimit(raw)).toBe(Number(raw));
  });

  it.each([
    ["nought", "0"],
    ["a negative", "-4"],
    ["a fraction", "2.5"],
    ["a word", "four"],
    ["an empty value", ""],
    ["spaces", " 4"],
    ["exponent notation", "1e2"],
    ["hexadecimal", "0x4"],
    ["past the bound", String(LIMIT_MAX + 1)]
  ])("refuses %s, rather than staging the whole table", (_label, raw) => {
    expect(parseLimit(raw)).toBeNull();
    expect(readEvalSettings({...full, CLAVE_EVAL_LIMIT: raw}, NONCE)).toEqual({ok: false, code: "BAD_LIMIT"});
  });
});

/** Review D, Minors 4 and 5. */
describe("where a limit means something", () => {
  it.each(["accuracy", "toolbar", "all"])("takes one in %s", (mode) => {
    expect(limitsCases(mode as never)).toBe(true);
    expect(readEvalSettings({...full, CLAVE_EVAL_MODE: mode, CLAVE_EVAL_LIMIT: "4"}, NONCE))
      .toMatchObject({ok: true});
  });

  it.each(["observe", "coldstart"])("refuses one in %s, rather than printing 0 of 0", (mode) => {
    expect(limitsCases(mode as never)).toBe(false);
    expect(readEvalSettings({...full, CLAVE_EVAL_MODE: mode, CLAVE_EVAL_LIMIT: "4"}, NONCE))
      .toEqual({ok: false, code: "LIMIT_NOT_APPLICABLE"});
    // and the same mode without a limit is fine
    expect(readEvalSettings({...full, CLAVE_EVAL_MODE: mode}, NONCE)).toMatchObject({ok: true});
  });

  it.each(["04", "0004", "01"])("refuses a zero-padded %s", (raw) => {
    expect(parseLimit(raw)).toBeNull();
    expect(readEvalSettings({...full, CLAVE_EVAL_LIMIT: raw}, NONCE)).toEqual({ok: false, code: "BAD_LIMIT"});
  });
});
