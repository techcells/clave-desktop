import {describe, expect, it} from "vitest";
import {GATE_USAGE_EXIT, parseGateArgs, type PathKinds} from "./gateArgs";

const kinds: PathKinds = {
  isFile: (path) => path === "/m/q.gguf",
  isDirectory: (path) => path === "/f"
};

describe("gate command line", () => {
  it("takes a model file and a fixtures folder, with or without the npm-style separator", () => {
    expect(parseGateArgs(["/m/q.gguf", "/f"], kinds)).toEqual({ok: true, modelPath: "/m/q.gguf", fixturesDir: "/f"});
    expect(parseGateArgs(["--", "/m/q.gguf", "/f"], kinds)).toEqual({ok: true, modelPath: "/m/q.gguf", fixturesDir: "/f"});
  });

  it("refuses anything else, and says so with the usage exit code", () => {
    for (const argv of [[], ["/m/q.gguf"], ["--"], ["--", "/m/q.gguf"], ["/f", "/m/q.gguf"], ["/m/q.gguf", "/nope"],
      ["/nope", "/f"], ["/m/q.gguf", "/f", "extra"], ["", ""]]) {
      expect(parseGateArgs(argv, kinds), JSON.stringify(argv)).toEqual({ok: false});
    }
    expect(GATE_USAGE_EXIT).toBe(64);
  });
});
