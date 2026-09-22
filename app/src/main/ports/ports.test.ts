import {describe, expect, it} from "vitest";
import {ApiError, apiCodeOf, parseSession, parseTaxonomy} from "./claveApi";
import {FAILURE_DETAILS, parseFrontWindow, parseHelperReadResult, parsePermission, parseReadResult, WIRE_DETAILS} from "./reader";

/** One string holding a name, an address and a password: what must never become a log key. */
const SENTENCE = "Priya Raman recovery codes at acme.io, and her password is hunter2, seriously";

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

  /**
   * `detail` says which stage of the helper produced a `failed` read, and it ends up as a count key
   * in `app.log`. The log's privacy argument is that its keys are fixed identifiers of this codebase
   * rather than a pattern, so this boundary is where a word from another process either becomes one
   * of ours or stops. Three rules, one test each.
   */
  it.each(FAILURE_DETAILS)("keeps the known detail %s on a failed read", (detail) => {
    expect(parseReadResult({ok: false, reason: "failed", detail})).toEqual({ok: false, reason: "failed", detail});
  });

  /**
   * `helperDown` is a member of the union but NOT of the wire set, and the two parsers are where
   * that distinction lives. Only the client can know that a read was never answered by a helper —
   * it is the thing holding the pipe — so a helper claiming it about itself is either stale or
   * lying, and believing it would send whoever reads `failedHelperDown` in the log to the
   * supervisor when the fault is in the capture. No privacy cost either way (it is a closed-set
   * word); this is purely about the count meaning what it says.
   *
   * It cannot be one parser with the narrow set, and that is the interesting half: the capture loop
   * re-parses whatever the `Reader` port hands it, so narrowing there too would delete the client's
   * own `helperDown` on the way past and make `failedHelperDown` unreachable.
   */
  it("refuses `helperDown` from the wire, while still letting the client say it", () => {
    expect(parseHelperReadResult({ok: false, reason: "failed", detail: "helperDown"}))
      .toEqual({ok: false, reason: "failed"});
    expect(parseReadResult({ok: false, reason: "failed", detail: "helperDown"}))
      .toEqual({ok: false, reason: "failed", detail: "helperDown"});
    expect(WIRE_DETAILS as readonly string[]).not.toContain("helperDown");
    expect(FAILURE_DETAILS as readonly string[]).toContain("helperDown");
  });

  // Every other detail travels over the wire exactly as it does inside the app: the one word that is
  // ours alone is the only difference between the two sets.
  it.each(WIRE_DETAILS)("lets the helper say %s over the wire", (detail) => {
    expect(parseHelperReadResult({ok: false, reason: "failed", detail}))
      .toEqual({ok: false, reason: "failed", detail});
  });

  it("holds the wire set to exactly the app's set minus the one word only the client may say", () => {
    expect([...WIRE_DETAILS, "helperDown"].sort()).toEqual([...FAILURE_DETAILS].sort());
  });

  // Dropped, not passed through and not collapsed into a placeholder that would then be miscounted.
  // The `failed` itself survives — something did fail — and the loop tallies it as `failedUnknown`.
  it.each([
    "captureExploded", "Priya Raman \u2014 recovery codes", "", "noexpect", "NOGRANT", "helperDown ", 7, null, {},
    ["helperDown"], true
  ])("drops the detail %j, keeping the failed read itself", (detail) => {
    expect(parseReadResult({ok: false, reason: "failed", detail})).toEqual({ok: false, reason: "failed"});
  });

  // A detail belongs to `failed` and to nothing else. `black`, `locked`, `windowGone` and `timeout`
  // are states of the screen or of the clock: a helper that attached a stage to one of them is
  // saying something the app has no meaning for, so the reason survives alone.
  it.each(["locked", "black", "timeout", "windowGone"])("drops a detail on a %s answer", (reason) => {
    expect(parseReadResult({ok: false, reason, detail: "captureTimeout"})).toEqual({ok: false, reason});
  });

  // And an unknown detail next to an unknown reason cannot widen anything either: the whole thing is
  // a malformed result, which is a failed read with no detail at all.
  it("never lets a detail survive a reason it does not recognise", () => {
    expect(parseReadResult({ok: false, reason: "exploded", detail: "captureTimeout"})).toEqual({ok: false, reason: "failed"});
  });

  it("never carries a detail on a read that worked", () => {
    expect(parseReadResult({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello", detail: "captureTimeout"}))
      .toEqual({ok: true, window: {app: "Code", title: "a.ts"}, text: "hello"});
  });

  // The set is closed and each member is its own word: no duplicates, nothing empty, nothing that
  // could be produced by concatenating a string that arrived over a pipe.
  it("holds a closed set of distinct, non-empty details", () => {
    expect(new Set(FAILURE_DETAILS).size).toBe(FAILURE_DETAILS.length);
    for (const detail of FAILURE_DETAILS) expect(detail.length).toBeGreaterThan(0);
  });

  /**
   * The hostile shapes, from review A's probes. `detail` is the one value that crosses from another
   * process and ends up as a count KEY in `app.log`, so what matters is not only that junk is
   * rejected but that the rejection is by SET MEMBERSHIP — a `Set`, not an object index, so
   * `"__proto__"` and friends are ordinary non-members rather than inherited truthy lookups.
   */
  it.each([
    ["a sentence with a name, an address and a password", SENTENCE],
    ["an object", {noGrant: 1}],
    ["an object pretending to stringify", {toString: "noGrant"}],
    ["an array", ["noGrant"]],
    ["a prototype key", "__proto__"],
    ["a constructor key", "constructor"],
    ["an inherited method name", "toString"],
    ["another inherited method name", "hasOwnProperty"]
  ])("refuses %s as a detail", (_what, detail) => {
    expect(parseReadResult({ok: false, reason: "failed", detail})).toEqual({ok: false, reason: "failed"});
    expect(parseHelperReadResult({ok: false, reason: "failed", detail})).toEqual({ok: false, reason: "failed"});
  });

  // A known detail survives; NOTHING that travelled beside it does. The result is rebuilt field by
  // field rather than spread, which is what makes this true of keys nobody has thought of yet.
  it("keeps a known detail and drops everything that came with it", () => {
    const parsed = parseReadResult({
      ok: false, reason: "failed", detail: "noGrant",
      stats: {captureMs: 31, width: 2560, height: 1440, note: SENTENCE},
      window: {app: "Slack", title: SENTENCE}, text: SENTENCE, extra: SENTENCE
    });
    expect(parsed).toEqual({ok: false, reason: "failed", detail: "noGrant"});
    expect(Object.keys(parsed).sort()).toEqual(["detail", "ok", "reason"]);
    expect(JSON.stringify(parsed)).not.toContain("Priya");
  });

  // `stats` is not in the schema at all, so a `stats` carrying strings cannot reach main by either
  // door — the one place a framework message or a window title could otherwise have ridden along.
  it("strips a stats object of strings from a failed answer and from an ok one", () => {
    const failed = parseReadResult({ok: false, reason: "failed", stats: {captureMs: "31", title: SENTENCE}});
    expect(failed).toEqual({ok: false, reason: "failed"});
    const good = parseReadResult({
      ok: true, window: {app: "Code", title: "a.ts"}, text: "hi", stats: {captureMs: 1, leak: SENTENCE}
    });
    expect(good).toEqual({ok: true, window: {app: "Code", title: "a.ts"}, text: "hi"});
    expect(JSON.stringify([failed, good])).not.toContain("Priya");
  });

  /**
   * The reason the schema parses `detail` as `z.unknown()` and not `z.enum`. A strange detail beside
   * a `black` must not fail the WHOLE parse, because a failed parse *is* a `failed` read — and the
   * loop counts those against the reader. A black screen with a junk key would otherwise help switch
   * capture off, by way of a field that was supposed to be ignorable.
   */
  it.each([{a: 1}, 7, null, ["x"], true, "captureExploded", SENTENCE])(
    "keeps a junk detail %j from turning a black answer into a failed one", (detail) => {
      expect(parseReadResult({ok: false, reason: "black", detail})).toEqual({ok: false, reason: "black"});
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
