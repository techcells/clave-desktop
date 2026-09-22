import {describe, expect, it} from "vitest";
import type {Blocker, EngineStatus} from "../main/engine";
import {BLOCKER_TRAY, trayKey, trayState} from "./trayState";

const ALL_BLOCKERS: Blocker[] = [
  "SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "SELF_TEST_NEEDED", "NO_PERMISSION",
  "PERMISSION_NEEDS_RESTART", "SETTINGS_NEED_REVIEW", "MODEL_PROBLEM", "READER_PROBLEM", "STORAGE_PROBLEM"
];

const status = (capture: EngineStatus["capture"], blockers: Blocker[], pending = 0): EngineStatus =>
  ({capture, resumeAt: null, blockers, extractionPaused: null, pending, waitingUpload: 0, nothingRead: null, checkingPermission: false});

describe("tray state", () => {
  it("has an explicit answer for every blocker the engine can report", () => {
    expect(Object.keys(BLOCKER_TRAY).sort()).toEqual([...ALL_BLOCKERS].sort());
    for (const blocker of ALL_BLOCKERS) expect(BLOCKER_TRAY[blocker], blocker).toMatch(/^(problem|off)$/);
  });

  it("maps each of the ten blockers to the icon it was given", () => {
    for (const blocker of ALL_BLOCKERS) expect(trayState(status("off", [blocker])), blocker).toBe(BLOCKER_TRAY[blocker]);
    // A permission that needs a restart and a lost exclusions file are both a working app that
    // broke, each with its own fix button: the tray says so rather than looking merely switched off.
    expect(ALL_BLOCKERS.filter((b) => BLOCKER_TRAY[b] === "problem"))
      .toEqual(["SIGNED_OUT", "NO_PERMISSION", "PERMISSION_NEEDS_RESTART", "SETTINGS_NEED_REVIEW", "MODEL_PROBLEM", "READER_PROBLEM", "STORAGE_PROBLEM"]);
    expect(ALL_BLOCKERS.filter((b) => BLOCKER_TRAY[b] === "off")).toEqual(["NO_TAXONOMY", "MODEL_MISSING", "SELF_TEST_NEEDED"]);
  });

  it("is on whenever reading is on, and problem whenever any blocker is a problem", () => {
    expect(trayState(status("on", []))).toBe("on");
    expect(trayState(status("on", ["MODEL_PROBLEM"]))).toBe("on");
    expect(trayState(status("off", []))).toBe("off");
    expect(trayState(status("pausedByUser", []))).toBe("off");
    expect(trayState(status("off", ["MODEL_MISSING", "STORAGE_PROBLEM"]))).toBe("problem");
    expect(trayState(status("off", ["MODEL_MISSING", "SELF_TEST_NEEDED"]))).toBe("off");
    // The first seconds after launch: nothing is known to be wrong, so no "!" beside the clock.
    const checking: EngineStatus = {...status("off", []), checkingPermission: true};
    expect(trayState(checking)).toBe("off");
  });

  it("changes its key only for what the tray actually shows", () => {
    const base = status("off", ["MODEL_MISSING"], 2);
    const noisier: EngineStatus = {...base, waitingUpload: 9, extractionPaused: "lowBattery", resumeAt: 5};
    expect(trayKey(base)).toBe(trayKey(noisier));
    expect(trayKey(base)).not.toBe(trayKey({...base, pending: 3}));
    expect(trayKey(base)).not.toBe(trayKey({...base, capture: "on"}));
    expect(trayKey(base)).not.toBe(trayKey({...base, blockers: ["SIGNED_OUT"]}));
  });

  /**
   * The first menu item reads differently while nothing is being read, so the menu HAS to be rebuilt
   * when that flips — it is the whole point of the field. Its contents are not in the key: the
   * sentence is the same one whichever reason it carries.
   */
  it("rebuilds the menu when nothing-to-read flips, and not for what it says", () => {
    const reading = status("on", []);
    const nothing: EngineStatus = {...reading, nothingRead: {since: 1_000, why: "noWindow"}};
    expect(trayKey(reading)).not.toBe(trayKey(nothing));
    expect(trayKey(nothing)).toBe(trayKey({...nothing, nothingRead: {since: 9_999, why: "notAllowed"}}));
    // And it is not a problem: the icon stays "on", so the glyph beside the clock does not change.
    expect(trayState(nothing)).toBe("on");
  });
});
