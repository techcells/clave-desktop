import {createFakeModel, type FakeModel, type FakeScript} from "../../core/testing/fakeModel";
import {createEngine, type Engine, type EngineDeps} from "../engine";
import type {ModelClient} from "../model/client";
import type {DownloadState} from "../model/download";
import type {Cipher} from "../ports/system";
import type {PowerSource, ThermalState} from "../power";
import type {LocalTime} from "../review/scheduler";
import {createFakeApi, type FakeApi} from "./fakeApi";
import {createFakeReader, type FakeReader} from "./fakeReader";
import {createFakeCipher, createMemFs, type MemFs} from "./memFs";

export const utcLocal: LocalTime = (ms) => { const d = new Date(ms); return {day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes()}; };

export interface FakeClient extends ModelClient {
  /** Calls, and how many conversations were opened and closed. */
  fake: FakeModel;
  /** Answers still to give. Tests push onto this at any time. */
  script: unknown[];
  breakNow(): void;
}
const MANY = 500;
export function createFakeClient(initial: FakeScript): FakeClient {
  const script: unknown[] = [...initial];
  const next = () => { if (script.length === 0) throw new Error("fake model script exhausted"); return script.shift(); };
  const fake = createFakeModel(Array.from({length: MANY}, () => next));
  let broken = false;
  const listeners = new Set<() => void>();
  return {
    fake, script, open: (settings) => fake.open(settings), broken: () => broken, reset() { broken = false; }, shutdown() { /* nothing to kill */ },
    onBroken(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    breakNow() { broken = true; for (const cb of listeners) cb(); }
  };
}

export interface FakePower { source: PowerSource; set(patch: {onBattery?: boolean; level?: number | null; thermal?: ThermalState}): void }
export function createFakePower(): FakePower {
  const state = {onBattery: false, level: 1 as number | null, thermal: "nominal" as ThermalState};
  const listeners = new Set<() => void>();
  return {
    source: {onBattery: () => state.onBattery, batteryLevel: () => state.level, thermalState: () => state.thermal, subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }},
    set(patch) { Object.assign(state, patch); for (const cb of listeners) cb(); }
  };
}

export interface FakeDownloader { state(): DownloadState; onChange(cb: (s: DownloadState) => void): () => void; removeAll(): Promise<void>; set(state: DownloadState): void }
export function createFakeDownloader(initial: DownloadState = {kind: "ready"}): FakeDownloader {
  let state = initial;
  const listeners = new Set<(s: DownloadState) => void>();
  return {
    state: () => state, onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async removeAll() { state = {kind: "missing"}; for (const cb of listeners) cb(state); },
    set(next) { state = next; for (const cb of listeners) cb(state); }
  };
}

export interface Harness {
  fs: MemFs; api: FakeApi; reader: FakeReader; client: FakeClient; power: FakePower; downloader: FakeDownloader;
  /** The same cipher every launch uses, so a test can write an encrypted file the engine will read. */
  cipher: Cipher;
  reviewPrompts: number[]; resumedNotices: number;
  /** Seconds since the last input, as the engine's `idleSeconds` sees it. Tests set it at will. */
  idleSeconds: number;
  /** Writes an encrypted `session.bin` for `userId`, as if that user had signed in on this machine. */
  writeSession(userId: string, names?: string[]): void;
  /** Builds an engine on the SAME disk, as a relaunch would. */
  launch(overrides?: Partial<EngineDeps>): Promise<Engine>;
}

/** Everything around the engine, faked. Time comes from vitest's fake timers (`Date.now`). */
export function createHarness(script: FakeScript = []): Harness {
  const fs = createMemFs();
  const api = createFakeApi(() => Date.now());
  const reader = createFakeReader();
  const client = createFakeClient(script);
  const power = createFakePower();
  const downloader = createFakeDownloader();
  const cipher = createFakeCipher();
  let ids = 0;
  const harness: Harness = {
    fs, api, reader, client, power, downloader, cipher, reviewPrompts: [], resumedNotices: 0, idleSeconds: 0,
    writeSession(userId, names = ["Someone Else"]) {
      const stored = {session: {token: `token-${userId}`, expiresAt: Date.now() + 7 * 24 * 60 * 60_000, userId}, names};
      fs.files.set("/data/session.bin", cipher.encrypt(JSON.stringify(stored)));
    },
    launch: (overrides = {}) => createEngine({
      reader, api, model: client, downloader, fs, cipher, dataDir: "/data",
      power: power.source, idleSeconds: () => harness.idleSeconds, now: () => Date.now(), local: utcLocal, newId: () => `id${++ids}`,
      appVersion: "1.0.0", modelSha256: "sha", production: false,
      notifyReview: (count) => { harness.reviewPrompts.push(count); }, notifyCaptureResumed: () => { harness.resumedNotices += 1; },
      ...overrides
    })
  };
  return harness;
}
