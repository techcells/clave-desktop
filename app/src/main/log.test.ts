import {describe, expect, it} from "vitest";
import {LOG_MAX_BYTES} from "./constants";
import {FAILED_DETAIL_KEY} from "./capture/loop";
import {createLog, LOG_CODES, LOG_COUNT_KEYS} from "./log";
import {createMemFs} from "./testing/memFs";

describe("log", () => {
  it("writes one JSON line per event with a code and numbers", async () => {
    const fs = createMemFs();
    const log = createLog({fs, path: "/d/app.log", now: () => 42});
    await log.event("CAPTURE_ON", {failures: 2});
    expect(fs.text("/d/app.log")).toBe('{"at":42,"code":"CAPTURE_ON","counts":{"failures":2}}\n');
  });

  it("cannot be made to carry a sentence: free-text codes and keys are rejected by construction, not by pattern", async () => {
    const fs = createMemFs();
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    // A code that merely looks like a fixed code (all caps, dots) is not one: only exact members of LOG_CODES pass.
    await log.event("PRIYA.SAID.X" as never);
    await log.event("CAPTURE_ON", {"Priya.said.the.password": 1} as never);
    await log.event("CAPTURE_ON", {"Priya": 1} as never);
    const written = fs.text("/d/app.log") as string;
    expect(written).not.toContain("Priya");
    expect(written).not.toContain("password");
    expect(written).toContain("LOG_BAD_CODE");
  });

  it("accepts every code in LOG_CODES, and only those", async () => {
    for (const code of LOG_CODES) {
      const fs = createMemFs();
      const log = createLog({fs, path: "/d/app.log", now: () => 1});
      await log.event(code);
      expect(fs.text("/d/app.log")).toContain(`"code":"${code}"`);
    }
  });

  /**
   * The capture loop's outcome tallies are the first counts whose SHAPE comes from what was on the
   * user's screen (which windows, how often). The keys are still fixed identifiers of this codebase,
   * and the set is still closed — that is what this pins, one outcome name at a time.
   */
  it("takes every capture-loop outcome as a count key, and still refuses anything else", async () => {
    const fs = createMemFs();
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    await log.event("READER_NOTHING_TO_READ", {
      kept: 1, unchanged: 2, noWindow: 3, windowGone: 4, black: 5, windowChanged: 6, denied: 7,
      notKept: 8, locked: 9, userAway: 10, stopped: 11, timeout: 12, failed: 13, empty: 14
    });
    const written = fs.text("/d/app.log") as string;
    expect(written).toContain('"code":"READER_NOTHING_TO_READ"');
    for (const key of ["kept", "unchanged", "noWindow", "windowGone", "black", "windowChanged", "denied", "notKept", "locked", "userAway", "stopped", "timeout", "failed", "empty"]) {
      expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
    }
    expect(JSON.parse(written.trim()) as {counts: Record<string, number>}).toMatchObject({
      counts: {kept: 1, unchanged: 2, noWindow: 3, windowGone: 4, black: 5, windowChanged: 6, denied: 7, notKept: 8, locked: 9, userAway: 10, stopped: 11, timeout: 12, failed: 13, empty: 14}
    });
    // A window title next to them is still dropped, and a count that is not a number with it.
    await log.event("READER_NOTHING_TO_READ", {noWindow: 1, "Priya Raman — recovery codes": 2, denied: "Vault"} as never);
    const second = (fs.text("/d/app.log") as string).split("\n").filter(Boolean)[1] as string;
    expect(second).not.toContain("Priya");
    expect(second).not.toContain("Vault");
    expect(JSON.parse(second) as {counts: unknown}).toMatchObject({counts: {noWindow: 1}});
    expect(Object.keys((JSON.parse(second) as {counts: object}).counts)).toEqual(["noWindow"]);
  });

  /**
   * The same claim for the stage keys, which are the counts that say WHICH step of the reader
   * failed. They matter more than the outcome names for this test: an outcome name is chosen inside
   * the loop, whereas a stage name starts life as a word sent by another process. It is turned into
   * one of these fixed keys at the port and by a written-out table — and this is the end of that
   * path, where the set is closed one last time regardless of what any of it believed.
   */
  it("takes every failure-stage key as a count key, and still refuses anything else", async () => {
    const fs = createMemFs();
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    const stages = {
      failedNoExpect: 1, failedNoGrant: 2, failedCaptureRefused: 3, failedCaptureTimeout: 4,
      failedCaptureError: 5, failedCaptureNoContent: 6, failedCaptureNoImage: 7, failedRecognise: 8,
      failedHelperDown: 9, failedUnknown: 10, failedFrontWindow: 11, failedReadCall: 12,
      timeoutFrontWindow: 13, timeoutRead: 14
    };
    await log.event("CAPTURE_OFF", {failed: 45, timeout: 25, ...stages});
    const written = fs.text("/d/app.log") as string;
    for (const key of Object.keys(stages)) expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
    expect((JSON.parse(written.trim()) as {counts: unknown}).counts).toEqual({failed: 45, timeout: 25, ...stages});

    // A key that merely LOOKS like one of them is not one: only exact members pass, so nothing can
    // be assembled at run time out of a word that arrived over the pipe.
    await log.event("CAPTURE_OFF", {
      failedNoGrant: 1, failedCaptureExploded: 2, "failed Priya Raman": 3, failedcapturetimeout: 4
    } as never);
    const second = (fs.text("/d/app.log") as string).split("\n").filter(Boolean)[1] as string;
    expect(second).not.toContain("Priya");
    expect(second).not.toContain("Exploded");
    expect(Object.keys((JSON.parse(second) as {counts: object}).counts)).toEqual(["failedNoGrant"]);
  });

  /**
   * The type system already asserts this in `main/engine.ts` (`FailureTallyKey extends LogCountKey`),
   * and this asserts it again at run time, from the other end: the values the loop actually tallies
   * under are members of the list the log actually checks against. A type assertion is only as good
   * as the types agreeing with the values, and these keys are the one place in the log's closed set
   * whose *shape* is decided by a word from another process.
   */
  it("every key the loop can tally under is a member of the closed set", () => {
    for (const key of Object.values(FAILED_DETAIL_KEY)) {
      expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
    }
    for (const key of ["failedUnknown", "failedFrontWindow", "failedReadCall", "timeoutFrontWindow", "timeoutRead"]) {
      expect(LOG_COUNT_KEYS as readonly string[], key).toContain(key);
    }
  });

  it("drops a count key that is not one of LOG_COUNT_KEYS, and keeps a valid one", async () => {
    const fs = createMemFs();
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    await log.event("CAPTURE_OFF", {blockers: 3, "Priya Raman": 1} as never);
    const written = fs.text("/d/app.log") as string;
    expect(written).toContain('"blockers":3');
    expect(written).not.toContain("Priya");
  });

  it("starts over when the file grows past the cap", async () => {
    const fs = createMemFs();
    fs.files.set("/d/app.log", new Uint8Array(LOG_MAX_BYTES + 1));
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    await log.event("CAPTURE_ON");
    expect((fs.text("/d/app.log") as string).length).toBeLessThan(100);
  });

  it("never throws when the disk fails", async () => {
    const fs = createMemFs();
    fs.failWrites = true;
    const log = createLog({fs, path: "/d/app.log", now: () => 1});
    await expect(log.event("CAPTURE_ON")).resolves.toBeUndefined();
  });
});
