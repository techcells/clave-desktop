import {describe, expect, it} from "vitest";
import {mayAnswer, othersCover, parseReaderPath, readerPathFileIsSafe, shapeAnswer, shellCoversWindows, statusAnswer} from "./logic.js";

const READER = "/opt/Clave Agent/clave-reader";

const snapshot = (over: Record<string, unknown> = {}) => ({
  id: 42, title: "admin@ubuntu: ~", appName: "Terminal", appId: "org.gnome.Terminal.desktop",
  wmClass: "gnome-terminal-server", x11: false, frame: {x: 66, y: 32, width: 914, height: 577},
  monitor: 0, monitorFrame: {x: 0, y: 0, width: 1440, height: 900}, scale: 1, pid: 2143, ...over
});

describe("parseReaderPath", () => {
  it("takes one absolute path, with or without a final newline", () => {
    expect(parseReaderPath(`${READER}\n`)).toBe(READER);
    expect(parseReaderPath(READER)).toBe(READER);
  });

  it("refuses anything that is not exactly one absolute path", () => {
    for (const bad of ["", "\n", "clave-reader", "./clave-reader", `${READER}\n/other`, `${READER}\n\n`, `/a\0b`, "/"]) {
      expect(parseReaderPath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseReaderPath(undefined)).toBeNull();
    expect(parseReaderPath(null)).toBeNull();
  });
});

describe("mayAnswer", () => {
  it("answers the installed reader", () => {
    expect(mayAnswer(READER, READER)).toBe(true);
  });

  it("refuses every other caller", () => {
    expect(mayAnswer("/usr/bin/python3.12", READER)).toBe(false);
    expect(mayAnswer(`${READER} (deleted)`, READER)).toBe(false);
    expect(mayAnswer(`${READER}x`, READER)).toBe(false);
    expect(mayAnswer("/opt/Clave Agent/Clave-Reader", READER)).toBe(false);
  });

  it("refuses when either side is unknown", () => {
    expect(mayAnswer(null, READER)).toBe(false);
    expect(mayAnswer(READER, null)).toBe(false);
    expect(mayAnswer(null, null)).toBe(false);
    expect(mayAnswer("", "")).toBe(false);
  });
});

describe("shapeAnswer", () => {
  it("answers null when no window is focused", () => {
    expect(JSON.parse(shapeAnswer(null))).toBeNull();
    expect(JSON.parse(shapeAnswer(undefined))).toBeNull();
  });

  it("carries exactly the fields the reader reads", () => {
    expect(JSON.parse(shapeAnswer(snapshot()))).toEqual({
      id: 42, title: "admin@ubuntu: ~", appName: "Terminal", appId: "org.gnome.Terminal.desktop",
      wmClass: "gnome-terminal-server", x11: false, frame: [66, 32, 914, 577], monitor: 0,
      monitorFrame: [0, 0, 1440, 900], scale: 1, pid: 2143
    });
  });

  it("carries the owning process only as a positive whole number, else null (the window is still located)", () => {
    for (const pid of [0, -1, 1.5, "2143", null, undefined, Number.MAX_SAFE_INTEGER + 1, 2 ** 32]) {
      const answer = JSON.parse(shapeAnswer(snapshot({pid})));
      expect(answer, String(pid)).not.toBeNull();
      expect(answer.pid, String(pid)).toBeNull();
    }
    expect(JSON.parse(shapeAnswer(snapshot({pid: 1}))).pid).toBe(1);
  });

  it("keeps a missing title as an empty string and missing names as null", () => {
    const answer = JSON.parse(shapeAnswer(snapshot({title: null, appName: undefined, appId: 7, wmClass: ""})));
    expect(answer.title).toBe("");
    expect(JSON.parse(shapeAnswer(snapshot({title: 7}))).title).toBe("");
    expect(answer.appName).toBeNull();
    expect(answer.appId).toBeNull();
    expect(answer.wmClass).toBeNull();
  });

  it("keeps a fractional scale and negative origins (a window partly off the left of a monitor)", () => {
    const answer = JSON.parse(shapeAnswer(snapshot({scale: 1.25, frame: {x: -40, y: 0, width: 800, height: 600}})));
    expect(answer.scale).toBe(1.25);
    expect(answer.frame).toEqual([-40, 0, 800, 600]);
  });

  it("answers null when the window cannot be located, because unknown means do not capture", () => {
    const unusable = [
      {id: 0}, {id: -1}, {id: 1.5}, {id: "42"}, {id: Number.MAX_SAFE_INTEGER + 1},
      {frame: null}, {frame: {x: 0, y: 0, width: 0, height: 10}}, {frame: {x: 0, y: 0, width: 10, height: -1}},
      {frame: {x: 0, y: 0, width: 10, height: 0}},
      {frame: {x: 0, y: 0, width: 10.5, height: 10}}, {frame: {x: 0, y: 0, width: "10", height: 10}},
      {frame: {x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10}}, {frame: {x: 0, y: 0, width: 10, height: "10"}},
      {frame: {x: 0, y: 0, width: 10, height: 10.5}},
      {monitorFrame: null}, {monitorFrame: {x: 0, y: 0, width: 0, height: 900}},
      {monitorFrame: {x: 0, y: 0, width: 1440, height: -900}}, {monitorFrame: {x: 0.5, y: 0, width: 1440, height: 900}},
      {monitorFrame: {x: 0, y: "0", width: 1440, height: 900}},
      {frame: {x: 0.5, y: 0, width: 10, height: 10}}, {frame: {x: 0, y: Number.NaN, width: 10, height: 10}},
      {monitor: -1}, {monitor: 0.5}, {monitor: null},
      {scale: 0}, {scale: -1}, {scale: Number.POSITIVE_INFINITY}, {scale: "1"}
    ];
    for (const over of unusable) expect(JSON.parse(shapeAnswer(snapshot(over))), JSON.stringify(over)).toBeNull();
  });

  it("says whether the window is an X11 one only when told so", () => {
    expect(JSON.parse(shapeAnswer(snapshot({x11: true}))).x11).toBe(true);
    expect(JSON.parse(shapeAnswer(snapshot({x11: "yes"}))).x11).toBe(false);
  });
});

describe("shellCoversWindows", () => {
  const clear = {overviewVisible: false, modalCount: 0, bannerShowing: false};

  it("is false only when the overview is hidden, GNOME Shell holds no modal and no banner shows", () => {
    expect(shellCoversWindows(clear)).toBe(false);
  });

  it("is true with the overview shown, or any modal (a system dialog, a top-bar menu, the window switcher)", () => {
    expect(shellCoversWindows({...clear, overviewVisible: true})).toBe(true);
    expect(shellCoversWindows({...clear, overviewVisible: true, modalCount: 1})).toBe(true);
    expect(shellCoversWindows({...clear, modalCount: 1})).toBe(true);
    expect(shellCoversWindows({...clear, modalCount: 3})).toBe(true);
  });

  it("is true while a notification banner shows: it is drawn over windows without a modal (Task 6 review)", () => {
    expect(shellCoversWindows({...clear, bannerShowing: true})).toBe(true);
  });

  it("is true when the shell's state cannot be read, because unknown means do not capture", () => {
    for (const state of [null, undefined, {}, {overviewVisible: false, modalCount: 0},
      {...clear, overviewVisible: "no"}, {...clear, modalCount: -1}, {...clear, modalCount: 0.5},
      {...clear, modalCount: "0"}, {...clear, bannerShowing: undefined}, {...clear, bannerShowing: 0}]) {
      expect(shellCoversWindows(state), JSON.stringify(state)).toBe(true);
    }
  });
});

describe("othersCover", () => {
  const focused = {frame: {x: 100, y: 100, width: 800, height: 600}, pid: 2143};
  const above = (x: number, y: number, width: number, height: number, pid: unknown = 3000) => ({frame: {x, y, width, height}, pid});

  it("is false with nothing above, or only windows that do not overlap it", () => {
    expect(othersCover(focused, [])).toBe(false);
    expect(othersCover(focused, [above(0, 0, 100, 100), above(900, 100, 200, 200), above(100, 700, 800, 50)])).toBe(false);
  });

  it("is true when another program's window above it overlaps it at all (picture-in-picture, always on top)", () => {
    expect(othersCover(focused, [above(850, 650, 300, 200)])).toBe(true);
    expect(othersCover(focused, [above(0, 0, 101, 101)])).toBe(true);
    expect(othersCover(focused, [above(0, 0, 2000, 2000)])).toBe(true);
  });

  it("lets the focused program's own windows above it (its menus and popups) pass", () => {
    expect(othersCover(focused, [above(150, 150, 200, 300, 2143)])).toBe(false);
  });

  it("is true when either program is unknown or a frame cannot be read", () => {
    expect(othersCover(focused, [above(150, 150, 200, 300, null)])).toBe(true);
    expect(othersCover({...focused, pid: null}, [above(150, 150, 200, 300, 2143)])).toBe(true);
    expect(othersCover(focused, [{frame: null, pid: 3000}])).toBe(true);
    expect(othersCover(focused, [above(150, 150, Number.NaN, 300)])).toBe(true);
    expect(othersCover({frame: null, pid: 2143}, [])).toBe(true);
    // Mutter says -1 for a pid it does not know: two unknowns are not the same program.
    expect(othersCover({...focused, pid: -1}, [above(150, 150, 200, 300, -1)])).toBe(true);
    // A focused window with no size cannot be shown to be uncovered.
    expect(othersCover({frame: {x: 100, y: 100, width: 0, height: 600}, pid: 2143}, [])).toBe(true);
    expect(othersCover(focused, null)).toBe(true);
  });
});

describe("statusAnswer", () => {
  it("says which version is running and which reader path it loaded, and nothing else", () => {
    expect(JSON.parse(statusAnswer(3, READER))).toEqual({version: 3, readerPath: READER});
  });

  it("says null for what it does not have, so the app sees a login is needed", () => {
    expect(JSON.parse(statusAnswer(undefined, null))).toEqual({version: null, readerPath: null});
    expect(JSON.parse(statusAnswer("3", ""))).toEqual({version: null, readerPath: null});
    expect(JSON.parse(statusAnswer(1.5, 7))).toEqual({version: null, readerPath: null});
  });
});

describe("readerPathFileIsSafe", () => {
  const me = 1000;
  it("trusts a regular file owned by the user that only the user can write", () => {
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: 0o644}, me)).toBe(true);
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: 0o600}, me)).toBe(true);
  });

  it("refuses a file someone else owns or may write, or that is not a regular file", () => {
    expect(readerPathFileIsSafe({regular: true, ownerUid: 1001, mode: 0o644}, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: 0o664}, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: 0o646}, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: false, ownerUid: me, mode: 0o644}, me)).toBe(false);
  });

  it("refuses when anything about the file is unknown", () => {
    expect(readerPathFileIsSafe(null, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: 0o644}, null)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: undefined, mode: 0o644}, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: me, mode: undefined}, me)).toBe(false);
    expect(readerPathFileIsSafe({regular: true, ownerUid: undefined, mode: 0o644}, undefined)).toBe(false);
  });
});
