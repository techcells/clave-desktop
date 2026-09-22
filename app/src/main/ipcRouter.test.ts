import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {RULE_MAX_LENGTH} from "../core/constants";
import {INVOKE_CHANNELS} from "../shared/ipc";
import {IPC_MAX_ID_CHARS, IPC_MAX_IDENTIFIER_CHARS, IPC_MAX_ONBOARDING_STEP, IPC_MAX_PASSWORD_CHARS, IPC_MAX_RULES} from "./constants";
import {createIpcRouter, IpcError, type IpcRouter} from "./ipcRouter";
import {createHarness, type Harness} from "./testing/harness";

async function setup() {
  const h: Harness = createHarness();
  const engine = await h.launch();
  const calls: string[] = [];
  const router: IpcRouter = createIpcRouter({
    engine, reader: {requestPermission: async () => { calls.push("requestPermission"); }},
    downloader: {state: h.downloader.state, onChange: h.downloader.onChange, start: async () => { calls.push("start"); }, pause: () => { calls.push("pause"); }},
    recentApp: () => "Figma", appInfo: {version: "1.0.0", modelSha256: "sha", modelSizeBytes: 5, standIns: true},
    openWhatLeaves: async () => { calls.push("openWhatLeaves"); }, openLicences: async () => { calls.push("openLicences"); return "LICENCES_MISSING"; },
    restartApp: () => { calls.push("restartApp"); }
  });
  return {h, engine, router, calls};
}

describe("ipc router", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("answers every channel in the list, and nothing outside it", async () => {
    const {engine, router} = await setup();
    const sample: Record<string, unknown[]> = {
      approve: ["x"], reject: ["x"], setCapture: [false], signIn: ["sardor", "correct"], updateSettings: [{reviewTime: "09:00"}],
      retry: ["model"], deleteAllData: [{removeModel: false}]
    };
    for (const channel of INVOKE_CHANNELS) await expect(router.handle(channel, sample[channel] ?? []), channel).resolves.not.toThrow();
    for (const channel of ["quit", "takeCounters", "system", "__proto__", "constructor", "toString", ""]) {
      await expect(router.handle(channel, [])).rejects.toMatchObject({code: "BAD_CHANNEL"});
    }
    await engine.quit();
  });

  it("rejects malformed arguments with a fixed code and never echoes them", async () => {
    const {engine, router} = await setup();
    const bad: [string, unknown[]][] = [
      ["approve", []], ["approve", [7]], ["approve", ["x", "extra"]], ["setCapture", ["yes"]], ["signIn", ["sardor"]],
      ["signIn", ["sardor", "x".repeat(2000)]], ["retry", ["disk"]], ["deleteAllData", [{removeModel: "no"}]],
      ["deleteAllData", [{removeModel: true, also: "this"}]], ["status", ["unexpected"]],
      ["updateSettings", [{captureOn: true}]], ["updateSettings", [{selfTestPassedFor: "1.0.0:sha"}]], ["updateSettings", [{ownerUserId: "user:x"}]],
      ["updateSettings", ["Priya said hunter2"]]
    ];
    for (const [channel, args] of bad) {
      const error = await router.handle(channel, args).catch((e: unknown) => e);
      expect(error, channel).toBeInstanceOf(IpcError);
      expect((error as IpcError).message).toBe("BAD_ARGS");
    }
    await engine.quit();
  });

  it("never hands the renderer the settings' internal bookkeeping", async () => {
    const {engine, router} = await setup();
    await router.handle("signIn", ["sardor", "correct"]);
    const settings = await router.handle("settings", []);
    expect(Object.keys(settings as object).sort()).toEqual(["captureOn", "excludedSites", "exclusions", "onboardingStep", "reviewTime"]);
    await engine.quit();
  });

  it("routes to the engine and the other dependencies", async () => {
    const {engine, router, calls} = await setup();
    expect(await router.handle("signIn", ["sardor", "correct"])).toEqual({ok: true});
    expect(await router.handle("updateSettings", [{reviewTime: "08:30"}])).toEqual({ok: true});
    expect(await router.handle("settings", [])).toMatchObject({reviewTime: "08:30"});
    expect(await router.handle("approve", ["no-such-id"])).toBe(false);
    expect(await router.handle("recentApp", [])).toBe("Figma");
    expect(await router.handle("appInfo", [])).toMatchObject({version: "1.0.0", standIns: true});
    await router.handle("requestPermission", []); await router.handle("downloadStart", []); await router.handle("downloadPause", []);
    await router.handle("openWhatLeaves", []); expect(await router.handle("openLicences", [])).toBe("LICENCES_MISSING"); await router.handle("restartApp", []);
    expect(calls).toEqual(["requestPermission", "start", "pause", "openWhatLeaves", "openLicences", "restartApp"]);
    await engine.quit();
  });

  it("holds the renderer to the same bounds the engine and the core use", async () => {
    const {engine, router} = await setup();
    const rule = "x".repeat(RULE_MAX_LENGTH);
    expect(await router.handle("updateSettings", [{exclusions: [rule]}])).toEqual({ok: true});
    const bad: [string, unknown[]][] = [
      ["updateSettings", [{exclusions: ["x".repeat(RULE_MAX_LENGTH + 1)]}]],
      ["updateSettings", [{excludedSites: ["x".repeat(RULE_MAX_LENGTH + 1)]}]],
      ["updateSettings", [{exclusions: Array.from({length: IPC_MAX_RULES + 1}, () => "x")}]],
      ["updateSettings", [{onboardingStep: IPC_MAX_ONBOARDING_STEP + 1}]],
      ["approve", ["x".repeat(IPC_MAX_ID_CHARS + 1)]],
      ["signIn", ["x".repeat(IPC_MAX_IDENTIFIER_CHARS + 1), "correct"]],
      ["signIn", ["sardor", "x".repeat(IPC_MAX_PASSWORD_CHARS + 1)]],
      // A review time is a local clock time, not any five characters: the same shape the store enforces.
      ...["9:00", "25:00", "08:60", "0800", "08:0", "", "eight"].map((reviewTime): [string, unknown[]] => ["updateSettings", [{reviewTime}]])
    ];
    for (const [channel, args] of bad) {
      const error = await router.handle(channel, args).catch((e: unknown) => e);
      expect(error, JSON.stringify(args)).toBeInstanceOf(IpcError);
      expect((error as IpcError).message).toBe("BAD_ARGS");
    }
    expect(await router.handle("updateSettings", [{reviewTime: "23:59"}])).toEqual({ok: true});
    expect(await router.handle("updateSettings", [{reviewTime: "00:00"}])).toEqual({ok: true});
    await engine.quit();
  });

  it("a download that cannot start never reaches the process as an unhandled rejection", async () => {
    const h: Harness = createHarness();
    const engine = await h.launch();
    const router: IpcRouter = createIpcRouter({
      engine, reader: {requestPermission: async () => undefined},
      downloader: {state: h.downloader.state, onChange: h.downloader.onChange, start: () => Promise.reject(new Error("no network")), pause: () => undefined},
      recentApp: () => null, appInfo: {version: "1.0.0", modelSha256: "sha", modelSizeBytes: 5, standIns: true},
      openWhatLeaves: async () => undefined, openLicences: async () => "opened", restartApp: () => undefined
    });
    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", watch);
    try {
      expect(await router.handle("downloadStart", [])).toBeUndefined();
      await Promise.resolve();
      await new Promise<void>((resolve) => { void Promise.resolve().then(resolve); });
    } finally { process.off("unhandledRejection", watch); }
    expect(unhandled).toEqual([]);
    await engine.quit();
  });

  it("answers nothing at all on the two channels that end the session", async () => {
    const {engine, router, calls} = await setup();
    expect(await router.handle("deleteAllData", [{removeModel: false}])).toBeUndefined();
    expect(await router.handle("restartApp", [])).toBeUndefined();
    expect(calls).toEqual(["restartApp"]);
    await engine.quit();
  });

  it("pushes status and download changes until unsubscribed", async () => {
    const {h, engine, router} = await setup();
    const seen: string[] = [];
    const stop = router.subscribe((channel) => seen.push(channel));
    h.downloader.set({kind: "missing"});
    expect(seen).toContain("download");
    expect(seen).toContain("status");
    stop();
    const before = seen.length;
    h.downloader.set({kind: "ready"});
    expect(seen.length).toBe(before);
    await engine.quit();
  });
});
