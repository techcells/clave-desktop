import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import {encode} from "../main/reader/protocol";
import {approve} from "./guard";
import {createEvalHelper, encodeRead, readWindow} from "./helper";
import {stagedTitleFor} from "./stagedTitle";
import {createFakeLink, createManualSchedule, respondTo} from "./testing/fakes";

const staged = stagedTitleFor("chat-light-14", "abc123");
const window: FrontWindow = {app: "Google Chrome", bundleId: "com.google.Chrome", title: staged};
const approval = approve(window, {app: "Google Chrome", stagedTitle: staged});
if (approval === null) throw new Error("the fixture window must be approvable");

describe("the read line", () => {
  /**
   * The harness encodes `read` itself, because it carries the evaluation-only `lines` switch that
   * the app's `ToHelper` has no member for and must never grow one. This is what keeps the two from
   * drifting: without `lines`, the byte string must be identical to what the product's own encoder
   * produces for the same call.
   */
  it("is byte for byte the product's own encoding when it does not ask for lines", () => {
    expect(encodeRead(7, 1_500, window, false)).toBe(encode({id: 7, op: "read", budgetMs: 1_500, expect: window}));
  });

  it("adds `lines` only when asked", () => {
    expect(JSON.parse(encodeRead(7, 1_500, window, true))).toEqual({
      id: 7, op: "read", budgetMs: 1_500, expect: window, lines: true
    });
    expect(encodeRead(7, 1_500, window, false)).not.toContain("lines");
  });

  it("always carries the approved window as `expect`", () => {
    expect(JSON.parse(encodeRead(1, 10, window, false)).expect).toEqual(window);
  });
});

describe("createEvalHelper", () => {
  it("answers `ready` with the protocol number the helper announced", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    const waiting = helper.waitReady();
    link.emit(JSON.stringify({event: "ready", protocol: 2}));
    expect(await waiting).toEqual({ok: true, body: {protocol: 2}});
  });

  it("settles every outstanding call when the helper goes away", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    const permission = helper.permission();
    const front = helper.frontWindow();
    link.exit();
    expect(await permission).toEqual({ok: false, why: "down"});
    expect(await front).toEqual({ok: false, why: "down"});
  });

  it("gives up on a call that is never answered", async () => {
    const link = createFakeLink();
    const timers = createManualSchedule();
    const helper = createEvalHelper({link, schedule: timers.schedule});
    const waiting = helper.permission();
    timers.fireAll();
    expect(await waiting).toEqual({ok: false, why: "timeout"});
  });

  it("ignores a focus event and an answer to a call it never made", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    respondTo(link, () => null);
    const waiting = helper.frontWindow();
    link.emit(JSON.stringify({event: "focus"}));
    link.emit(JSON.stringify({id: 99, window: null}));
    link.emit(JSON.stringify({id: 1, window}));
    expect(await waiting).toEqual({ok: true, body: {window}});
  });

  it("keeps `stats` and `lines`, which the product's own parser strips", async () => {
    const link = createFakeLink();
    const helper = createEvalHelper({link, schedule: createManualSchedule().schedule});
    respondTo(link, (request) => request.op === "read"
      ? {ok: true, window, text: "x", stats: {captureMs: 31, bandPx: 82}, lines: [{text: "x", topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}]}
      : null);
    const answer = await helper.readApproved(approval, {lines: true});
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.body.stats).toEqual({captureMs: 31, bandPx: 82});
    expect(answer.body.lines).toHaveLength(1);
  });

  it("sends shutdown and closes the helper's input rather than killing it", () => {
    const link = createFakeLink();
    createEvalHelper({link, schedule: createManualSchedule().schedule}).shutdown();
    expect(JSON.parse(link.sent[0] as string)).toEqual({op: "shutdown"});
    expect(link.inputClosed).toBe(true);
    expect(link.killed).toBe(false);
  });
});

describe("readWindow", () => {
  it("reads a window with and without a bundle id", () => {
    expect(readWindow({window})).toEqual(window);
    expect(readWindow({window: {app: "Terminal", title: staged}})).toEqual({app: "Terminal", title: staged});
  });

  it.each([
    ["nothing", {}],
    ["null", {window: null}],
    ["a string", {window: "Google Chrome"}],
    ["a window with no title", {window: {app: "Google Chrome"}}],
    ["a window whose app is a number", {window: {app: 7, title: "x"}}]
  ])("refuses %s", (_label, body) => {
    expect(readWindow(body as Record<string, unknown>)).toBeNull();
  });
});
