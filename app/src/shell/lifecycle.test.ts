import {describe, expect, it, vi} from "vitest";
import {background, BACKGROUND_TASK_FAILED, startFailureCode, START_FAILURES} from "./lifecycle";

describe("background work", () => {
  it("says nothing when the work succeeds", async () => {
    const write = vi.fn();
    background(Promise.resolve("anything"), write);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes one fixed line and never the error itself", async () => {
    const write = vi.fn();
    background(Promise.reject(new Error("/Users/someone/Secret plan.txt could not be read")), write);
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(`${BACKGROUND_TASK_FAILED}\n`);
  });

  it("swallows the rejection instead of letting it escape", async () => {
    const rejection = Promise.reject(new Error("boom"));
    background(rejection, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(rejection).rejects.toThrow();   // still rejected, but nobody else had to handle it
  });
});

describe("the launch failure code", () => {
  it("passes through each of the three reasons launch can fail", () => {
    for (const code of START_FAILURES) expect(startFailureCode(new Error(code)), code).toBe(code);
  });

  it("reads a code property as well as a message", () => {
    expect(startFailureCode(Object.assign(new Error("stand-ins in a packaged build"), {code: "STANDIN_IN_PRODUCTION"}))).toBe("STANDIN_IN_PRODUCTION");
  });

  it("answers UNKNOWN for anything else, and never leaks the message", () => {
    for (const thrown of [new Error("ENOENT: /Users/someone/Documents/pay.pdf"), "NO_READER_YET_BUT_NOT_QUITE", 7, null, undefined, {message: "NO_READER_YET"}]) {
      expect(startFailureCode(thrown)).toBe("UNKNOWN");
    }
  });

  it("only ever answers one of the four allowed words", () => {
    expect([...START_FAILURES, "UNKNOWN"]).toContain(startFailureCode(new Error("whatever")));
  });
});
