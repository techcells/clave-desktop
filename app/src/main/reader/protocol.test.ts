import {describe, expect, it} from "vitest";
import {HELPER_MAX_LINE_CHARS} from "./constants";
import {encode, parseHelperPermission, parseLine} from "./protocol";

describe("reader protocol: what main sends", () => {
  it("encodes each message as one line of JSON", () => {
    expect(encode({id: 3, op: "read", budgetMs: 1500, expect: {app: "Code", title: "query.sql"}}))
      .toBe('{"id":3,"op":"read","budgetMs":1500,"expect":{"app":"Code","title":"query.sql"}}');
    expect(encode({op: "cancel", target: 2})).toBe('{"op":"cancel","target":2}');
    expect(encode({op: "shutdown"})).not.toContain("\n");
  });

  it("a read carries the window main approved, bundle id and all", () => {
    const expected = {app: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs"};
    expect(encode({id: 3, op: "read", budgetMs: 1500, expect: expected}))
      .toBe('{"id":3,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Docs"}}');
  });
});

describe("reader protocol: what the helper may send", () => {
  it("reads the two events", () => {
    expect(parseLine('{"event":"ready","protocol":2}')).toEqual({kind: "ready", protocol: 2});
    expect(parseLine('{"event":"focus"}')).toEqual({kind: "focus"});
  });

  it("splits an answer into its id and everything else", () => {
    expect(parseLine('{"id":7,"permission":"granted"}')).toEqual({kind: "answer", id: 7, body: {permission: "granted"}});
    expect(parseLine('{"id":0,"window":null}')).toEqual({kind: "answer", id: 0, body: {window: null}});
  });

  it.each([
    ["not JSON", "ready"],
    ["an array", "[1]"],
    ["a bare string", '"focus"'],
    ["null", "null"],
    ["an unknown event", '{"event":"moved"}'],
    ["ready without a protocol number", '{"event":"ready"}'],
    ["ready with a fractional protocol", '{"event":"ready","protocol":1.5}'],
    ["an answer without an id", '{"permission":"granted"}'],
    ["a negative id", '{"id":-1}'],
    ["a string id", '{"id":"7"}'],
    ["an id too large to be exact", '{"id":9007199254740993}']
  ])("refuses %s", (_name, line) => {
    expect(parseLine(line)).toBeNull();
  });

  it("an event wins over an id, so an event can never be mistaken for an answer", () => {
    expect(parseLine('{"event":"focus","id":1}')).toEqual({kind: "focus"});
  });

  it("does not even parse a line that is too long", () => {
    const line = `{"id":1,"text":"${"a".repeat(HELPER_MAX_LINE_CHARS)}"}`;
    expect(parseLine(line)).toBeNull();
  });
});

describe("reader protocol: the helper's permission answer", () => {
  it("knows three values and nothing else", () => {
    expect(parseHelperPermission({permission: "granted"})).toBe("granted");
    expect(parseHelperPermission({permission: "denied"})).toBe("denied");
    expect(parseHelperPermission({permission: "refused"})).toBe("refused");
    expect(parseHelperPermission({permission: "needsRestart"})).toBeNull();
    expect(parseHelperPermission({permission: 1})).toBeNull();
    expect(parseHelperPermission({})).toBeNull();
  });
});
