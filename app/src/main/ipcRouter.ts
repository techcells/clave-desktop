import {z} from "zod";
import {RULE_MAX_LENGTH} from "../core/constants";
import {EVENT_CHANNELS, EXTENSION_ACTIONS, INVOKE_CHANNELS, type AppInfo, type EventChannel, type ExtensionAction, type ExtensionState, type InvokeChannel, type OpenLicencesResult, type UserSettings} from "../shared/ipc";
import {IPC_MAX_ID_CHARS, IPC_MAX_IDENTIFIER_CHARS, IPC_MAX_ONBOARDING_STEP, IPC_MAX_PASSWORD_CHARS, IPC_MAX_RULES} from "./constants";
import type {Engine} from "./engine";
import type {Downloader} from "./model/download";
import type {Reader} from "./ports/reader";
import {REVIEW_TIME} from "./settings";

export type IpcErrorCode = "BAD_CHANNEL" | "BAD_ARGS";
/** A fixed code. The renderer is untrusted input: nothing it sends is echoed back in an error. */
export class IpcError extends Error { constructor(readonly code: IpcErrorCode) { super(code); this.name = "IpcError"; } }

export interface IpcRouterDeps {
  engine: Engine;
  downloader: Pick<Downloader, "state" | "start" | "pause" | "onChange">;
  reader: Pick<Reader, "requestPermission">;
  recentApp: () => string | null;
  appInfo: AppInfo;
  openWhatLeaves: () => Promise<void>;
  openLicences: () => Promise<OpenLicencesResult>;
  restartApp: () => void;
  /** Linux only: the GNOME extension's actions. Absent elsewhere, where the channel answers null. */
  extension?: (action: ExtensionAction) => Promise<ExtensionState | null>;
}

export interface IpcRouter {
  /** One request from the renderer. Rejects with an IpcError for an unknown channel or malformed arguments. */
  handle(channel: string, args: unknown[]): Promise<unknown>;
  /** Starts pushing status and download changes. Returns the function that stops it. */
  subscribe(send: (channel: EventChannel, payload: unknown) => void): () => void;
}

const none = z.tuple([]);
/** One exclusion or excluded site. The length limit is the core's, not a second opinion about it. */
const rules = z.array(z.string().max(RULE_MAX_LENGTH)).max(IPC_MAX_RULES);
const patch = z.object({
  exclusions: rules.optional(), excludedSites: rules.optional(),
  // Checked here with the store's own regex: "any five characters" would let a renderer push a value
  // the store then refuses, and answer BAD_VALUE instead of BAD_ARGS for a malformed argument.
  reviewTime: z.string().regex(REVIEW_TIME).optional(),
  onboardingStep: z.number().int().min(0).max(IPC_MAX_ONBOARDING_STEP).optional()
}).strict();

const ARGS = {
  status: none, review: none, pauseForAnHour: none, signInWithGoogle: none, cancelGoogleSignIn: none, signOut: none, settings: none, settingsOpened: none, selfTest: none,
  recheckPermission: none, requestPermission: none, downloadState: none, downloadStart: none, downloadPause: none,
  recentApp: none, appInfo: none, openWhatLeaves: none, openLicences: none, restartApp: none,
  approve: z.tuple([z.string().min(1).max(IPC_MAX_ID_CHARS)]), reject: z.tuple([z.string().min(1).max(IPC_MAX_ID_CHARS)]),
  setCapture: z.tuple([z.boolean()]),
  signIn: z.tuple([z.string().min(1).max(IPC_MAX_IDENTIFIER_CHARS), z.string().min(1).max(IPC_MAX_PASSWORD_CHARS)]),
  updateSettings: z.tuple([patch]),
  retry: z.tuple([z.enum(["model", "reader"])]),
  deleteAllData: z.tuple([z.object({removeModel: z.boolean()}).strict()]),
  extension: z.tuple([z.enum(EXTENSION_ACTIONS)])
} satisfies Record<InvokeChannel, z.ZodTypeAny>;

const isChannel = (value: string): value is InvokeChannel => (INVOKE_CHANNELS as readonly string[]).includes(value);

/**
 * Everything the renderer can ask for, checked before it reaches the engine. Pure: no Electron here,
 * so the whole contract is tested without a window. `shell/ipcMain.ts` connects it to `ipcMain`.
 */
export function createIpcRouter(deps: IpcRouterDeps): IpcRouter {
  const {engine, downloader} = deps;

  const userSettings = (): UserSettings => {
    const s = engine.settings();
    return {exclusions: s.exclusions, excludedSites: s.excludedSites, reviewTime: s.reviewTime, captureOn: s.captureOn, onboardingStep: s.onboardingStep};
  };

  async function run(channel: InvokeChannel, a: unknown[]): Promise<unknown> {
    switch (channel) {
      case "status": return engine.status();
      case "review": return engine.review();
      case "approve": return engine.approve(a[0] as string);
      case "reject": return engine.reject(a[0] as string);
      case "setCapture": return engine.setCapture(a[0] as boolean);
      case "pauseForAnHour": return engine.pauseForAnHour();
      case "signIn": return engine.signIn(a[0] as string, a[1] as string);
      case "signInWithGoogle": return engine.signInWithGoogle();
      case "cancelGoogleSignIn": engine.cancelGoogleSignIn(); return undefined;
      case "signOut": return engine.signOut();
      case "settings": return userSettings();
      case "settingsOpened": engine.settingsOpened(); return undefined;
      case "updateSettings": return engine.updateSettings(a[0] as Parameters<Engine["updateSettings"]>[0]);
      case "selfTest": return engine.selfTest();
      case "recheckPermission": return engine.recheckPermission();
      case "requestPermission": await deps.reader.requestPermission(); return undefined;
      case "retry": engine.retry(a[0] as "model" | "reader"); return undefined;
      case "deleteAllData": return engine.deleteAllData(a[0] as {removeModel: boolean});
      case "downloadState": return downloader.state();
      // Long-running: progress arrives as events, and the outcome as a download state. The rejection
      // is swallowed HERE, where the promise is dropped: a download that cannot even start (no
      // network, a refusing disk) must not reach the process as an unhandled rejection.
      case "downloadStart": void downloader.start().catch(() => undefined); return undefined;
      case "downloadPause": downloader.pause(); return undefined;
      case "recentApp": return deps.recentApp();
      case "appInfo": return deps.appInfo;
      case "openWhatLeaves": return deps.openWhatLeaves();
      case "openLicences": return deps.openLicences();
      case "restartApp": deps.restartApp(); return undefined;
      case "extension": return deps.extension ? deps.extension(a[0] as ExtensionAction) : null;
    }
  }

  return {
    async handle(channel, args) {
      if (typeof channel !== "string" || !isChannel(channel)) throw new IpcError("BAD_CHANNEL");
      const parsed = ARGS[channel].safeParse(Array.isArray(args) ? args : []);
      if (!parsed.success) throw new IpcError("BAD_ARGS");
      return run(channel, parsed.data as unknown[]);
    },
    subscribe(send) {
      const stops = [
        engine.onStatus((status) => send("status", status)),
        downloader.onChange((state) => send("download", state))
      ];
      return () => { for (const stop of stops) stop(); };
    }
  };
}

export {EVENT_CHANNELS};
