import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {TRAY_HOST_QUERY, TRAY_HOST_TIMEOUT_MS, askTrayHost, closeAction, trayHostFrom} from "./trayHost";

describe("tray host", () => {
  it("reads gdbus's answer to NameHasOwner", () => {
    expect(trayHostFrom("(true,)\n")).toBe(true);
    expect(trayHostFrom("(false,)\n")).toBe(false);
  });

  it("treats anything else as no tray, so the window is never hidden out of reach", () => {
    for (const output of ["", "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown", "(true)", "true", "(maybe,)"]) {
      expect(trayHostFrom(output), JSON.stringify(output)).toBe(false);
    }
  });

  it("hides a closed window only when a tray can bring it back, and quits otherwise", () => {
    // With no tray the only Quit (the tray menu) is not there, and a minimised window that every
    // close only minimises again is an app the user cannot get rid of (Task 5 review, I1).
    expect(closeAction(true)).toBe("hide");
    expect(closeAction(false)).toBe("quit");
  });
});

describe("asking for the tray host", () => {
  type Callback = (error: Error | null, stdout: string) => void;
  let calls: {file: string; args: readonly string[]; timeout: number; callback: Callback}[];
  const run = (file: string, args: readonly string[], options: {timeout: number}, callback: Callback) => {
    calls.push({file, args, timeout: options.timeout, callback});
  };
  const call = (index: number) => {
    const found = calls[index];
    if (!found) throw new Error(`no call ${index}`);
    return found;
  };

  beforeEach(() => { calls = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("asks gdbus with a timeout and answers from what it prints", async () => {
    const answer = askTrayHost(run);
    expect(calls).toHaveLength(1);
    expect([call(0).file, call(0).args]).toEqual(TRAY_HOST_QUERY);
    expect(call(0).timeout).toBe(TRAY_HOST_TIMEOUT_MS);
    call(0).callback(null, "(true,)\n");
    await expect(answer).resolves.toBe(true);
    const no = askTrayHost(run);
    call(1).callback(null, "(false,)\n");
    await expect(no).resolves.toBe(false);
  });

  it("answers no tray when gdbus fails, cannot be started, or never answers", async () => {
    const failed = askTrayHost(run);
    call(0).callback(new Error("exit 1"), "(true,)\n");
    await expect(failed).resolves.toBe(false);
    const thrown = askTrayHost(() => { throw new Error("ENOENT"); });
    await expect(thrown).resolves.toBe(false);
    const silent = askTrayHost(run);
    await vi.advanceTimersByTimeAsync(TRAY_HOST_TIMEOUT_MS);
    await expect(silent).resolves.toBe(false);
    call(1).callback(null, "(true,)\n");           // too late: the answer already given stands
    await expect(silent).resolves.toBe(false);
  });
});
