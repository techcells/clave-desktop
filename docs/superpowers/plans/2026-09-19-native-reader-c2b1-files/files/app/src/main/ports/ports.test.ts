import {describe, expect, it} from "vitest";
import {ApiError, apiCodeOf, parseSession, parseTaxonomy} from "./claveApi";
import {parseFrontWindow, parsePermission, parseReadResult} from "./reader";

describe("reader port: everything from the reader is checked", () => {
  it("accepts a well-formed front window and drops unknown fields", () => {
    expect(parseFrontWindow({app: "Code", title: "a.ts", pid: 4})).toEqual({app: "Code", title: "a.ts"});
    expect(parseFrontWindow({app: "Code", bundleId: "com.ms", title: "a.ts"})).toEqual({app: "Code", bundleId: "com.ms", title: "a.ts"});
  });
  it.each([null, undefined, "Code", {app: 7, title: "x"}, {app: "Code"}, {title: "x"}])("rejects %j", (value) => {
    expect(parseFrontWindow(value)).toBeNull();
  });
  it("passes a good read through", () => {
    expect(parseReadResult({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello"}))
      .toEqual({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello"});
    expect(parseReadResult({ok: true, window: {app: "Chrome", title: "t"}, text: "x", toolbarText: "acme.com"}))
      .toEqual({ok: true, window: {app: "Chrome", title: "t"}, text: "x", toolbarText: "acme.com"});
    expect(parseReadResult({ok: false, reason: "locked"})).toEqual({ok: false, reason: "locked"});
  });
  // `windowGone` is a normal state, not a reader fault, so it has to survive the boundary as
  // itself: collapsed to `failed` it would count towards switching capture off.
  it.each(["locked", "black", "timeout", "failed", "windowGone"])("passes the reason %s through", (reason) => {
    expect(parseReadResult({ok: false, reason})).toEqual({ok: false, reason});
  });
  // Protocol 2 answers carry a `stats` object of numbers for the evaluation harness. It stops here:
  // what leaves the port is the port's own shape, so nothing downstream can come to depend on it.
  it("strips the helper's measurements, leaving only the port's own fields", () => {
    const stats = {captureMs: 31, recogniseMs: 198, cacheHit: false, width: 2560, height: 1440};
    expect(parseReadResult({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello", stats}))
      .toEqual({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello"});
    expect(parseReadResult({ok: false, reason: "black", stats})).toEqual({ok: false, reason: "black"});
  });
  it.each([null, {ok: true}, {ok: true, window: {app: "Code", title: "t"}, text: 5}, {ok: false, reason: "bored"}, "ok"])(
    "turns a malformed result into a failed read: %j", (value) => {
      expect(parseReadResult(value)).toEqual({ok: false, reason: "failed"});
    });
  it("treats an unknown permission value as unknown", () => {
    expect(parsePermission("granted")).toBe("granted");
    expect(parsePermission("yes")).toBe("unknown");
    expect(parsePermission(undefined)).toBe("unknown");
  });
});

describe("api port", () => {
  it("an ApiError carries a code and nothing else", () => {
    const error = new ApiError("OFFLINE");
    expect(error.message).toBe("OFFLINE");
    expect(apiCodeOf(error)).toBe("OFFLINE");
    expect(apiCodeOf(new Error("the server said: secret text"))).toBe("SERVER");
  });
  it("validates sessions and taxonomies", () => {
    expect(parseSession({token: "t", expiresAt: 5, userId: "u"})).toEqual({token: "t", expiresAt: 5, userId: "u"});
    expect(parseSession({token: "", expiresAt: 5, userId: "u"})).toBeNull();
    expect(parseTaxonomy({version: "v1", skills: [], competencies: []})).toEqual({version: "v1", skills: [], competencies: []});
    expect(parseTaxonomy({version: "v1", skills: [{id: "a"}], competencies: []})).toBeNull();
  });
});
