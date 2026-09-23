import {describe, expect, it, vi} from "vitest";
import {DEFAULT_EXCLUSIONS} from "../core/index";
import {DEFAULT_REVIEW_TIME} from "./constants";
import {defaultSettings, loadSettings} from "./settings";
import {createMemFs} from "./testing/memFs";

const PATH = "/d/settings.json";

describe("settings", () => {
  it("starts from the defaults: capture off, default exclusions, 17:30", async () => {
    const store = await loadSettings({fs: createMemFs(), path: PATH});
    expect(store.get()).toEqual(defaultSettings());
    expect(store.get().captureOn).toBe(false);
    expect(store.get().exclusions).toEqual(DEFAULT_EXCLUSIONS);
    expect(store.get().reviewTime).toBe("17:30");
    expect(store.needsReview()).toBe(false);
  });

  it("keeps the machine factor a self-test measured, reads an older file without one as none, and refuses one out of range", async () => {
    const fs = createMemFs();
    const store = await loadSettings({fs, path: PATH});
    expect(store.get().modelTimeScale).toBeNull();
    expect(await store.update({modelTimeScale: 2.4})).toEqual({ok: true});
    expect((await loadSettings({fs, path: PATH})).get().modelTimeScale).toBe(2.4);
    for (const bad of [0.5, 4.5, Number.NaN]) expect(await store.update({modelTimeScale: bad}), String(bad)).toEqual({ok: false, problem: "BAD_VALUE"});
    // A file written before the factor existed.
    const {modelTimeScale: _dropped, ...older} = defaultSettings();
    await fs.writeAtomic(PATH, new TextEncoder().encode(JSON.stringify(older)));
    expect((await loadSettings({fs, path: PATH})).get().modelTimeScale).toBeNull();
  });

  it("saves a change, tells listeners, and finds it again after a restart", async () => {
    const fs = createMemFs();
    const store = await loadSettings({fs, path: PATH});
    const seen = vi.fn();
    store.onChange(seen);
    expect(await store.update({reviewTime: "09:05", exclusions: ["Figma"]})).toEqual({ok: true});
    expect(seen).toHaveBeenCalledTimes(1);
    const again = await loadSettings({fs, path: PATH});
    expect(again.get().reviewTime).toBe("09:05");
    expect(again.get().exclusions).toEqual(["Figma"]);
  });

  it("rejects a bad review time and bad exclusion rules without saving", async () => {
    const fs = createMemFs();
    const store = await loadSettings({fs, path: PATH});
    expect(await store.update({reviewTime: "25:00"})).toEqual({ok: false, problem: "BAD_REVIEW_TIME"});
    expect(await store.update({reviewTime: "9:5"})).toEqual({ok: false, problem: "BAD_REVIEW_TIME"});
    expect(await store.update({exclusions: ["x".repeat(500)]})).toEqual({ok: false, problem: "BAD_EXCLUSIONS"});
    expect(await store.update({onboardingStep: -1})).toEqual({ok: false, problem: "BAD_VALUE"});
    expect(fs.files.size).toBe(0);
    expect(store.get()).toEqual(defaultSettings());
  });

  it("falls back to the defaults with needsReview() true when reading the file throws (a real disk error, not just bad JSON)", async () => {
    const fs = createMemFs();
    fs.files.set(PATH, new TextEncoder().encode(JSON.stringify({...defaultSettings(), captureOn: true})));
    fs.failReads = true;
    const store = await loadSettings({fs, path: PATH});
    expect(store.get()).toEqual(defaultSettings());
    expect(store.needsReview()).toBe(true);
  });

  it("get() returns a defensive copy: mutating it, or its arrays, does not change the stored settings", async () => {
    const store = await loadSettings({fs: createMemFs(), path: PATH});
    const first = store.get();
    first.captureOn = true;
    first.exclusions.push("hack");
    first.excludedSites.push("hack.example");
    expect(store.get()).toEqual(defaultSettings());
  });

  it("resolves SAVE_FAILED, leaving memory unchanged, when the write fails", async () => {
    const fs = createMemFs();
    const store = await loadSettings({fs, path: PATH});
    fs.failWrites = true;
    expect(await store.update({reviewTime: "09:05"})).toEqual({ok: false, problem: "SAVE_FAILED"});
    expect(store.get().reviewTime).toBe(DEFAULT_REVIEW_TIME);
  });

  it("falls back to the DEFAULT exclusions, never to none, when the file is unreadable, and asks for a review", async () => {
    const fs = createMemFs();
    fs.files.set(PATH, new TextEncoder().encode('{"exclusions": "everything", "captureOn": true'));
    const store = await loadSettings({fs, path: PATH});
    expect(store.get().exclusions).toEqual(DEFAULT_EXCLUSIONS);
    expect(store.get().captureOn).toBe(false);
    expect(store.needsReview()).toBe(true);
    store.acknowledgeRecovery();
    expect(store.needsReview()).toBe(false);
  });

  it("treats a stored file with invalid rules as unreadable", async () => {
    const fs = createMemFs();
    fs.files.set(PATH, new TextEncoder().encode(JSON.stringify({...defaultSettings(), exclusions: ["x".repeat(500)], captureOn: true})));
    const store = await loadSettings({fs, path: PATH});
    expect(store.needsReview()).toBe(true);
    expect(store.get().captureOn).toBe(false);
  });

  it("reset removes the file and returns to the defaults", async () => {
    const fs = createMemFs();
    const store = await loadSettings({fs, path: PATH});
    await store.update({captureOn: true, onboardingStep: 7});
    await store.reset();
    expect(fs.files.has(PATH)).toBe(false);
    expect(store.get()).toEqual(defaultSettings());
  });
});
