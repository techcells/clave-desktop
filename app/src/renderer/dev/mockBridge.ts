import type {
  AppInfo, Blocker, ClaveBridge, DownloadState, EngineStatus, NothingReadWhy, Permission, ReviewView,
  SelfTestResult, SettingsProblem, SignInResult, UserSettings, UserSettingsPatch
} from "../../shared/ipc";

/**
 * A ClaveBridge that answers out of memory, for LOOKING AT the four screens in a browser. It exists
 * because a subagent cannot photograph an Electron window, and because walking the seven onboarding
 * steps and the ten blockers in the real app means arranging ten different machine states.
 *
 * It is dev-only in the strictest sense: nothing in src/renderer/main.tsx's module graph reaches
 * this file, `scripts/build.mjs` emits it only under --preview, and the production build's own
 * module-graph guard would fail if it ever did. It fakes only the PORT — the same twenty-three
 * methods, the same shapes — so what the preview shows is what the real bridge would drive.
 */

export type Scenario =
  | "onboarding-pitch" | "onboarding-signin" | "onboarding-model" | "onboarding-permission"
  | "onboarding-neverread" | "onboarding-reviewtime" | "onboarding-done"
  | "home-on" | "home-off" | "home-problem"
  | "home-nothing-notallowed" | "home-nothing-nowindow" | "home-nothing-other"
  | "review" | "review-empty" | "settings";

export const SCENARIOS: readonly Scenario[] = [
  "onboarding-pitch", "onboarding-signin", "onboarding-model", "onboarding-permission",
  "onboarding-neverread", "onboarding-reviewtime", "onboarding-done",
  "home-on", "home-off", "home-problem",
  "home-nothing-notallowed", "home-nothing-nowindow", "home-nothing-other",
  "review", "review-empty", "settings"
];

export const isScenario = (value: string | null): value is Scenario =>
  value !== null && (SCENARIOS as readonly string[]).includes(value);

const DAY = 86_400_000;
const now = Date.now();
/** The pinned model's size, so the preview's meter shows the number the real one would. */
const MODEL_BYTES = 2_740_937_888;
/** The same "HH:MM" shape main's settings store insists on. */
const REVIEW_TIME_SHAPE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const statement = (id: string, targetName: string, kind: "skill" | "competency", text: string, ago: number) => ({
  id, kind, targetId: `t-${id}`, targetName, statement: text, createdAt: now - ago,
  taxonomyVersion: "tax-2026-09-01", pipelineVersion: "1"
});

const PENDING = [
  statement("a", "PostgreSQL", "skill", "Rewrote the monthly invoice totals query, added a composite index on customer and month, and checked the query plan before and after.", 3 * 3600_000),
  statement("b", "Incident response", "competency", "Took the pager at 02:10, found the failing migration, rolled it back and wrote the timeline for the morning.", 9 * 3600_000),
  statement("c", "TypeScript", "skill", "Replaced a hand-written type guard with a discriminated union so the compiler refuses the case that caused the bug.", DAY),
  statement("d", "Technical writing", "competency", "Wrote the note explaining why the correlated subquery was slow and how to recognise the pattern again.", DAY + 7200_000)
];

const approved = (id: string, text: string, ago: number) => ({
  clientItemId: id, statement: text, kind: "skill" as const, targetId: `t-${id}`,
  createdAt: now - ago, taxonomyVersion: "tax-2026-09-01", pipelineVersion: "1"
});

const WAITING = [
  approved("w1", "Set up a staging database from a snapshot and verified the restore end to end.", 2 * DAY),
  approved("w2", "Paired on the retry logic for the upload queue and wrote the test for the dropped-connection case.", 2 * DAY)
];

const SENT = [
  {sentAt: now - 2 * DAY, ownerUserId: "u1", item: approved("s1", "Traced a memory leak in the worker to an unclosed cursor and fixed it.", 2 * DAY)},
  {sentAt: now - 3 * DAY, ownerUserId: "u1", item: approved("s2", "Documented the deployment steps for the reader process and had them reviewed.", 3 * DAY)}
];

interface Start { status: EngineStatus; settings: UserSettings; download: DownloadState; permission: Permission; review: ReviewView }

const status = (over: Partial<EngineStatus> = {}): EngineStatus =>
  ({capture: "off", resumeAt: null, blockers: [], extractionPaused: null, pending: 0, waitingUpload: 0, nothingRead: null, ...over});

const settings = (over: Partial<UserSettings> = {}): UserSettings => ({
  exclusions: ["1Password", "Messages", "Mail", "Calendar"],
  excludedSites: ["mail.google.com", "web.whatsapp.com", "bank.example"],
  // 7, not 6: onboarding is over once its LAST step has been read, and 6 is that step being on
  // screen. A default of 6 would open every "after onboarding" scenario on the Done step.
  reviewTime: "17:30", captureOn: false, onboardingStep: 7, ...over
});

const full: ReviewView = {pending: PENDING, waitingUpload: WAITING, sent: SENT};
const nothing: ReviewView = {pending: [], waitingUpload: [], sent: []};

const onboarding = (step: number, blockers: Blocker[]): Pick<Start, "status" | "settings"> =>
  ({status: status({blockers}), settings: settings({onboardingStep: step})});

/** Capture on, no blockers, and nothing read since 23 minutes ago. Not a problem: `blockers` stays empty. */
const nothingRead = (why: NothingReadWhy): EngineStatus =>
  status({capture: "on", nothingRead: {since: now - 23 * 60_000, why}});

/** The starting state each scenario name stands for. */
export function scenarioStart(scenario: Scenario): Start {
  const base = {download: {kind: "ready"} as DownloadState, permission: "granted" as Permission, review: nothing};
  switch (scenario) {
    case "onboarding-pitch":
      return {...base, ...onboarding(0, ["SIGNED_OUT", "MODEL_MISSING", "NO_PERMISSION"]), download: {kind: "missing"}, permission: "denied"};
    case "onboarding-signin":
      return {...base, ...onboarding(1, ["SIGNED_OUT", "MODEL_MISSING", "NO_PERMISSION"]), download: {kind: "missing"}, permission: "denied"};
    case "onboarding-model":
      // 42% of the pinned model size below, so the meter shows a real number.
      return {...base, ...onboarding(1, ["MODEL_MISSING", "NO_PERMISSION"]), download: {kind: "downloading", receivedBytes: Math.round(MODEL_BYTES * 0.42)}, permission: "denied"};
    case "onboarding-permission":
      return {...base, ...onboarding(1, ["NO_PERMISSION"]), permission: "denied"};
    case "onboarding-neverread":
      return {...base, ...onboarding(1, [])};
    case "onboarding-reviewtime":
      return {...base, ...onboarding(5, [])};
    case "onboarding-done":
      return {...base, ...onboarding(6, [])};
    case "home-on":
      return {...base, status: status({capture: "on", pending: 4, waitingUpload: 2}), settings: settings({captureOn: true}), review: full};
    case "home-off":
      return {...base, status: status(), settings: settings()};
    case "home-problem":
      return {...base, status: status({blockers: ["NO_PERMISSION"]}), settings: settings(), permission: "denied"};
    // Reading is on, healthy and producing nothing — one scenario per reason, because the sentence is
    // the only thing that differs between them and the three have to be readable side by side. The
    // `since` is 23 minutes back: past the engine's ten-minute threshold, and a wall-clock time that
    // is obviously not "just now".
    case "home-nothing-notallowed":
      return {...base, status: nothingRead("notAllowed"), settings: settings({captureOn: true})};
    case "home-nothing-nowindow":
      return {...base, status: nothingRead("noWindow"), settings: settings({captureOn: true})};
    case "home-nothing-other":
      return {...base, status: nothingRead("other"), settings: settings({captureOn: true})};
    case "review":
      return {...base, status: status({capture: "on", pending: PENDING.length, waitingUpload: WAITING.length}), settings: settings(), review: full};
    case "review-empty":
      return {...base, status: status({capture: "on"}), settings: settings(), review: nothing};
    case "settings":
      return {...base, status: status(), settings: settings()};
  }
}

const APP_INFO: AppInfo = {
  version: "0.1.0",
  modelSha256: "9f2c1ab4e7d30558c6be41f0a8d27b5e3c94106fd82a7be15c30d9f4ab77e621",
  modelSizeBytes: MODEL_BYTES,
  standIns: true
};

/**
 * Builds the bridge. Every mutating call changes the in-memory state and pushes it down the same
 * `onStatus` / `onDownload` channels the real preload uses, so the preview exercises the renderer's
 * subscriptions rather than just its first render.
 */
export function createMockBridge(scenario: Scenario): ClaveBridge {
  const start = scenarioStart(scenario);
  let engine = start.status;
  let stored = start.settings;
  let download = start.download;
  let permission = start.permission;
  let review = start.review;
  let downloading: ReturnType<typeof setInterval> | null = null;
  const statusListeners = new Set<(s: EngineStatus) => void>();
  const downloadListeners = new Set<(s: DownloadState) => void>();

  const pushStatus = (over: Partial<EngineStatus>) => {
    engine = {...engine, ...over};
    for (const cb of statusListeners) cb(engine);
  };
  const pushDownload = (next: DownloadState) => {
    download = next;
    for (const cb of downloadListeners) cb(download);
  };
  const without = (...gone: Blocker[]): Blocker[] => engine.blockers.filter((b) => !gone.includes(b));
  const counts = () => ({pending: review.pending.length, waitingUpload: review.waitingUpload.length});

  const stopDownload = () => {
    if (downloading !== null) clearInterval(downloading);
    downloading = null;
  };

  return {
    status: async () => engine,
    review: async () => review,
    approve: async (id) => {
      const item = review.pending.find((p) => p.id === id);
      if (item === undefined) return false;
      review = {
        pending: review.pending.filter((p) => p.id !== id),
        waitingUpload: [...review.waitingUpload, {
          clientItemId: item.id, statement: item.statement, kind: item.kind, targetId: item.targetId,
          createdAt: item.createdAt, taxonomyVersion: item.taxonomyVersion, pipelineVersion: item.pipelineVersion
        }],
        sent: review.sent
      };
      pushStatus(counts());
      return true;
    },
    reject: async (id) => {
      if (!review.pending.some((p) => p.id === id)) return false;
      review = {...review, pending: review.pending.filter((p) => p.id !== id)};
      pushStatus(counts());
      return true;
    },
    setCapture: async (on) => {
      if (on && engine.blockers.length > 0) return {ok: false, blockers: engine.blockers};
      pushStatus({capture: on ? "on" : "off", resumeAt: null});
      stored = {...stored, captureOn: on};
      return {ok: true};
    },
    pauseForAnHour: async () => { pushStatus({capture: "pausedByUser", resumeAt: Date.now() + 3600_000}); },
    signIn: async (identifier, password): Promise<SignInResult> => {
      if (identifier.length === 0 || password.length === 0) return {ok: false, code: "BAD_CREDENTIALS"};
      pushStatus({blockers: without("SIGNED_OUT")});
      return {ok: true};
    },
    signOut: async () => { pushStatus({capture: "off", blockers: [...engine.blockers, "SIGNED_OUT"]}); },
    settings: async () => stored,
    settingsOpened: async () => { pushStatus({blockers: without("SETTINGS_NEED_REVIEW")}); },
    updateSettings: async (patch: UserSettingsPatch) => {
      const problem = refuse(patch);
      if (problem !== null) return {ok: false, problem};
      stored = {...stored, ...patch};
      return {ok: true};
    },
    selfTest: async (): Promise<SelfTestResult> => {
      await wait(900);
      pushStatus({blockers: without("SELF_TEST_NEEDED")});
      return {ok: true};
    },
    recheckPermission: async () => {
      if (permission === "denied") return permission;
      pushStatus({blockers: without("NO_PERMISSION", "PERMISSION_NEEDS_RESTART")});
      return permission;
    },
    requestPermission: async () => {
      permission = "needsRestart";
      pushStatus({blockers: [...without("NO_PERMISSION"), "PERMISSION_NEEDS_RESTART"]});
    },
    retry: async () => { pushStatus({blockers: without("MODEL_PROBLEM", "READER_PROBLEM", "STORAGE_PROBLEM")}); },
    deleteAllData: async () => {
      await wait(400);
      review = nothing;
      pushStatus({capture: "off", ...counts()});
    },
    downloadState: async () => download,
    downloadStart: async () => {
      stopDownload();
      let received = download.kind === "partial" || download.kind === "downloading" ? download.receivedBytes : 0;
      pushDownload({kind: "downloading", receivedBytes: received});
      await new Promise<void>((resolve) => {
        downloading = setInterval(() => {
          received = Math.min(MODEL_BYTES, received + MODEL_BYTES / 18);
          if (received < MODEL_BYTES) { pushDownload({kind: "downloading", receivedBytes: received}); return; }
          stopDownload();
          pushDownload({kind: "verifying"});
          void wait(700).then(() => {
            pushDownload({kind: "ready"});
            pushStatus({blockers: [...without("MODEL_MISSING"), "SELF_TEST_NEEDED"]});
            resolve();
          });
        }, 400);
      });
    },
    downloadPause: async () => {
      stopDownload();
      const received = download.kind === "downloading" ? download.receivedBytes : 0;
      pushDownload({kind: "partial", receivedBytes: received});
    },
    recentApp: async () => "Figma",
    appInfo: async () => APP_INFO,
    openWhatLeaves: async () => undefined,
    restartApp: async () => {
      permission = "granted";
      pushStatus({blockers: without("NO_PERMISSION", "PERMISSION_NEEDS_RESTART")});
    },
    onStatus: (cb) => { statusListeners.add(cb); return () => { statusListeners.delete(cb); }; },
    onDownload: (cb) => { downloadListeners.add(cb); return () => { downloadListeners.delete(cb); }; }
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The same three refusals the real settings store makes, so validation can be seen on screen. */
function refuse(patch: UserSettingsPatch): SettingsProblem | null {
  if (patch.reviewTime !== undefined && !REVIEW_TIME_SHAPE.test(patch.reviewTime)) return "BAD_REVIEW_TIME";
  const entries = [...(patch.exclusions ?? []), ...(patch.excludedSites ?? [])];
  if (entries.some((entry) => entry.length > 120)) return "BAD_EXCLUSIONS";
  return null;
}
