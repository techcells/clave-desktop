import {describe, expect, it} from "vitest";
import {EVENT_CHANNELS, INVOKE_CHANNELS, NOTHING_READ_WHY, eventMethod, eventName, invokeName, type EngineStatus} from "./ipc";

const status = (over: Partial<EngineStatus> = {}): EngineStatus =>
  ({capture: "on", resumeAt: null, blockers: [], extractionPaused: null, pending: 0, waitingUpload: 0, nothingRead: null, checkingPermission: false, ...over});

describe("the renderer's surface", () => {
  it("names one bridge method per push channel, by name and not by position", () => {
    expect(EVENT_CHANNELS.map(eventMethod)).toEqual(["onStatus", "onDownload"]);
    // The preload builds the bridge with this, so reordering EVENT_CHANNELS can no longer wire
    // download states into onStatus. That the two names are all of them, and that every request
    // channel is a bridge method, is asserted at compile time in ipc.ts.
    expect(eventMethod("download")).toBe("onDownload");
  });

  it("prefixes every Electron channel, so nothing else in the process can collide", () => {
    for (const channel of INVOKE_CHANNELS) expect(invokeName(channel)).toBe(`clave:invoke:${channel}`);
    for (const channel of EVENT_CHANNELS) expect(eventName(channel)).toBe(`clave:event:${channel}`);
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
  });

  /**
   * `nothingRead` is the one status field derived from what was on the user's screen, so what it is
   * ALLOWED to be is pinned here rather than left to whoever fills it in: a number and one of three
   * fixed codes. There is no runtime schema on this channel — main is the sender and the compile-time
   * assertions in `ipc.ts` are the contract — so what a test can do is hold the closed set closed and
   * show that a status carrying the field survives the trip unchanged.
   */
  it("offers exactly three reasons for nothing being read, and no fourth", () => {
    expect([...NOTHING_READ_WHY]).toEqual(["notAllowed", "noWindow", "other"]);
    expect(new Set(NOTHING_READ_WHY).size).toBe(NOTHING_READ_WHY.length);
    // Every one of them a bare identifier of this codebase — no spaces, no punctuation, no digits.
    // A reason added later has to be one too, and cannot be a sentence about what was on the screen.
    expect(NOTHING_READ_WHY.every((why) => /^[a-zA-Z]+$/.test(why))).toBe(true);
  });

  it("carries nothingRead across the channel as a number and a fixed code, and nothing else", () => {
    const allowed: ReadonlySet<string> = new Set(NOTHING_READ_WHY);
    for (const why of NOTHING_READ_WHY) {
      const sent = status({nothingRead: {since: Date.UTC(2026, 8, 19, 10, 30), why}});
      // What Electron does to a status on its way to the renderer: serialise, deliver, read back.
      const received = JSON.parse(JSON.stringify(sent)) as EngineStatus;
      expect(received.nothingRead).toEqual({since: Date.UTC(2026, 8, 19, 10, 30), why});
      expect(typeof received.nothingRead!.since).toBe("number");
      expect(allowed.has(received.nothingRead!.why)).toBe(true);
      expect(Object.keys(received.nothingRead!).sort()).toEqual(["since", "why"]);
    }
    // And the field is present, as null, whenever reading is producing something: a renderer that
    // reads it can rely on it existing rather than having to tell "absent" from "nothing to report".
    const quiet = JSON.parse(JSON.stringify(status())) as EngineStatus;
    expect("nothingRead" in quiet).toBe(true);
    expect(quiet.nothingRead).toBeNull();
  });
});
