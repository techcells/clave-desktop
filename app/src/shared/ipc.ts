/**
 * The whole surface between the renderer and the main process. The preload exposes exactly this
 * and nothing else. Only `import type` from `main/` is allowed here: types vanish at build time,
 * so no main-process code can reach the renderer bundle through this file.
 */
import type {SignInResult} from "../main/account/session";
import type {Blocker, EngineStatus, NothingRead, NothingReadWhy, ReviewView, UserSettingsPatch} from "../main/engine";
import type {DownloadState} from "../main/model/download";
import type {SelfTestResult} from "../main/model/selfTest";
import type {Permission} from "../main/ports/reader";
import type {SettingsProblem} from "../main/settings";

export type {Blocker, DownloadState, EngineStatus, NothingRead, NothingReadWhy, Permission, ReviewView, SelfTestResult, SettingsProblem, SignInResult, UserSettingsPatch};

/**
 * Every reason `EngineStatus.nothingRead` can give, as a value the renderer can hold — nothing else
 * crosses here at runtime, so the closed list has to live on this side of the line (a value imported
 * from `main/` would pull main-process code into the renderer bundle, which is the one thing this
 * file exists to prevent). `AssertNothingReadWhyIsClosed` below keeps it equal to the engine's type,
 * in both directions, at compile time.
 */
export const NOTHING_READ_WHY = ["notAllowed", "noWindow", "other"] as const;

/** What the renderer may know about the settings. Internal bookkeeping (owner, self-test key, prompt day) stays in main. */
export interface UserSettings { exclusions: string[]; excludedSites: string[]; reviewTime: string; captureOn: boolean; onboardingStep: number }
/** `translocated`: macOS is running the app from its quarantine copy; the window shows "move to Applications" and nothing asks for Screen Recording. Optional so a build without the check reads as not translocated. */
export type OpenLicencesResult = "opened" | "LICENCES_MISSING";
/** `platform`: whose words the window uses for the system's own parts (capture, browsers). Absent reads as macOS, the first platform. */
export interface AppInfo { version: string; modelSha256: string; modelSizeBytes: number; standIns: boolean; translocated?: boolean; googleSignIn?: boolean; platform?: "mac" | "windows" }

export interface ClaveBridge {
  status(): Promise<EngineStatus>;
  review(): Promise<ReviewView>;
  approve(id: string): Promise<boolean>;
  reject(id: string): Promise<boolean>;
  setCapture(on: boolean): Promise<{ok: true} | {ok: false; blockers: Blocker[]}>;
  pauseForAnHour(): Promise<void>;
  signIn(identifier: string, password: string): Promise<SignInResult>;
  /** Opens the user's browser for a Google sign-in and answers when it is over, one way or the other. */
  signInWithGoogle(): Promise<SignInResult>;
  cancelGoogleSignIn(): Promise<void>;
  signOut(): Promise<void>;
  settings(): Promise<UserSettings>;
  settingsOpened(): Promise<void>;
  updateSettings(patch: UserSettingsPatch): Promise<{ok: true} | {ok: false; problem: SettingsProblem}>;
  selfTest(): Promise<SelfTestResult>;
  recheckPermission(): Promise<Permission>;
  requestPermission(): Promise<void>;
  retry(problem: "model" | "reader"): Promise<void>;
  deleteAllData(opts: {removeModel: boolean}): Promise<void>;
  downloadState(): Promise<DownloadState>;
  downloadStart(): Promise<void>;
  downloadPause(): Promise<void>;
  /** The last app in front that was not this one: "add the app I'm using now". `null` when unknown. */
  recentApp(): Promise<string | null>;
  appInfo(): Promise<AppInfo>;
  openWhatLeaves(): Promise<void>;
  /** Opens the bundled THIRD-PARTY-LICENSES.txt. The file exists only in packaged builds: a fixed code, never a path, says when it is not there. */
  openLicences(): Promise<OpenLicencesResult>;
  restartApp(): Promise<void>;
  onStatus(cb: (status: EngineStatus) => void): () => void;
  onDownload(cb: (state: DownloadState) => void): () => void;
}

/** Every request channel, in one list. The router refuses anything else. */
export const INVOKE_CHANNELS = [
  "status", "review", "approve", "reject", "setCapture", "pauseForAnHour", "signIn", "signInWithGoogle", "cancelGoogleSignIn", "signOut", "settings", "settingsOpened",
  "updateSettings", "selfTest", "recheckPermission", "requestPermission", "retry", "deleteAllData", "downloadState",
  "downloadStart", "downloadPause", "recentApp", "appInfo", "openWhatLeaves", "openLicences", "restartApp"
] as const;
export type InvokeChannel = typeof INVOKE_CHANNELS[number];

/** Every push channel from main to the renderer. */
export const EVENT_CHANNELS = ["status", "download"] as const;
export type EventChannel = typeof EVENT_CHANNELS[number];

/** The bridge method that delivers each push channel: `status` arrives on `onStatus`. */
export type EventMethod = `on${Capitalize<EventChannel>}`;
export const eventMethod = (channel: EventChannel): EventMethod =>
  `on${channel.charAt(0).toUpperCase()}${channel.slice(1)}` as EventMethod;

/** Electron channel names: one prefix, so nothing else in the process can collide. */
export const invokeName = (channel: InvokeChannel): string => `clave:invoke:${channel}`;
export const eventName = (channel: EventChannel): string => `clave:event:${channel}`;

/**
 * Compile-time only, no runtime value: the channel lists and `ClaveBridge` are the same surface,
 * checked in both directions. A method added to the bridge without a channel would be exposed by
 * the preload as `undefined`; a channel added without a method would be a handler the renderer has
 * no way to call and no types for. Either way this stops typecheck rather than the app.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
export type AssertRequestChannelsMatchBridge = Expect<Equals<InvokeChannel, Exclude<keyof ClaveBridge, EventMethod>>>;
export type AssertEventMethodsMatchBridge = Expect<Equals<EventMethod, Extract<keyof ClaveBridge, EventMethod>>>;
/** A reason added to the engine and not to the list above, or the other way round, stops typecheck. */
export type AssertNothingReadWhyIsClosed = Expect<Equals<typeof NOTHING_READ_WHY[number], NothingReadWhy>>;
/** And the field the renderer reads is exactly the engine's shape: numbers and one of those codes. */
export type AssertNothingReadShape = Expect<Equals<EngineStatus["nothingRead"], NothingRead | null>>;
