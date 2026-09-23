import type {AppInfo, Blocker, DownloadState, NothingReadWhy, SettingsProblem, SignInResult} from "../shared/ipc";
import {APP_NAME} from "../shared/flavour";

/**
 * Every sentence the user can read lives in this file, so the pitch is identical everywhere and
 * can be reviewed in one place. The five claims are verbatim from docs/implementation-plan.md
 * ("One pitch for every platform"); a test keeps them that way.
 */
export const CLAIMS: readonly string[] = [
  "You switch it on and off yourself. It never runs unless you started it.",
  "It reads the text on your screen. Anything it captures to do that is deleted within seconds. Nothing older than an hour exists anywhere, and nothing is stored on disk.",
  "It never reads the apps and sites you exclude, or private browser windows it can recognise.",
  "Nothing reaches your profile until you read it and say yes. It names no one else.",
  "It works with your Wi-Fi off. Only the short statements you approve ever leave."
];

/** Stated plainly in onboarding (spec section 7, step 5). */
export const KNOWN_LIMITS: readonly string[] = [
  "It cannot recognise a confidential fact that is phrased in ordinary words.",
  "It does not recognise a name written entirely in capital letters.",
  // Owner decision O8 (2026-09-21): the core does not keep a Chrome or Safari read whose toolbar
  // strip shows no address, because Safari was measured showing “Translation Available” in place of
  // the host for the first seconds after a page load, during which an excluded site could not be
  // recognised.
  "In Chrome and Safari it only reads a page while the address is visible.",
  "That is why nothing leaves until you have read it and said yes."
];

export interface BlockerCopy { sentence: string; action: string }
export const BLOCKERS: Record<Blocker, BlockerCopy> = {
  SIGNED_OUT: {sentence: "You are signed out.", action: "Sign in"},
  NO_TAXONOMY: {sentence: "The list of skills has not been downloaded yet.", action: "Try again"},
  MODEL_MISSING: {sentence: "The model has not been downloaded yet.", action: "Download the model"},
  SELF_TEST_NEEDED: {sentence: "The model has not been checked on this machine yet.", action: "Check it now"},
  NO_PERMISSION: {sentence: "Screen Recording is switched off for this app.", action: "Open System Settings"},
  PERMISSION_NEEDS_RESTART: {sentence: "Screen Recording is on. The app needs a restart to use it.", action: "Restart now"},
  SETTINGS_NEED_REVIEW: {sentence: "Your settings could not be read and were reset. Please check what is excluded.", action: "Open Settings"},
  MODEL_PROBLEM: {sentence: "The model stopped working several times in a row.", action: "Try again"},
  READER_PROBLEM: {sentence: "Reading the screen failed several times in a row.", action: "Try again"},
  STORAGE_PROBLEM: {sentence: "The disk refused a write, so reading is paused.", action: "Try again"},
  // Linux only (GNOME): the extension that tells the app which window is in front and where.
  EXTENSION_MISSING: {sentence: "The GNOME extension this app needs to see which window is in front is not installed, or is out of date.", action: "Install the GNOME extension"},
  EXTENSION_OFF: {sentence: "The GNOME extension this app needs is switched off.", action: "Switch it on"},
  // Ubuntu does not install GNOME's Extensions app, so the app offers GNOME's own switch itself, only
  // on this press (owner's decision, Task 7 review I3), and says what else that switch starts.
  EXTENSIONS_OFF_IN_GNOME: {sentence: "GNOME has all extensions switched off, and this app needs one. Switching them on also starts any other extensions you had installed.", action: "Switch extensions on"},
  EXTENSION_NEEDS_LOGIN: {sentence: "The GNOME extension is installed. It starts after you log out and back in.", action: "Log out now"},
  EXTENSION_UNSUPPORTED: {sentence: "This version of GNOME cannot run the extension this app needs.", action: "Check again"}
};

/**
 * Reading is on and healthy, and a long run of cycles read nothing at all. This is NOT a blocker and
 * must never be shown as one: `status.blockers` is empty, capture stays `"on"`, and there is nothing
 * for the user to fix — so there is one quiet sentence and no button. Every sentence starts by saying
 * reading is on, because that is the thing the user would otherwise doubt.
 *
 * A `Record` over `NothingReadWhy`, so a fourth reason added to the engine stops typecheck here
 * rather than showing the user a blank line.
 */
export const NOTHING_READ: Record<NothingReadWhy, string> = {
  notAllowed: "Reading is on. The windows in front are ones this app does not read.",
  noWindow: "Reading is on. There has been no window to read.",
  other: "Reading is on. Nothing has been readable for a while."
};

/** A sign-in that was refused, in the user's words. Keyed by the codes `signIn` can actually answer. */
type SignInProblem = Extract<SignInResult, {ok: false}>["code"];
/** The three ways a model download can stop for good. */
type DownloadProblem = Extract<DownloadState, {kind: "error"}>["code"];

export const SIGN_IN_PROBLEMS: Record<SignInProblem, string> = {
  BAD_CREDENTIALS: "That email and password did not match.",
  UNAUTHORISED: "Clave refused that sign-in.",
  OFFLINE: "There is no connection to Clave right now.",
  SERVER: "Clave did not answer. Try again in a moment.",
  BAD_RESPONSE: "Clave's answer could not be read.",
  RATE_LIMITED: "Clave asked the app to slow down. Try again in a few minutes.",
  OAUTH_TIMEOUT: "The browser sign-in did not finish. Try again.",
  OAUTH_BROWSER: "Your browser could not be opened for the sign-in.",
  STORAGE_UNAVAILABLE: "Your sign-in could not be saved on this machine.",
  STORAGE_WRITE_FAILED: "Your sign-in could not be saved on this machine."
};

export const DOWNLOAD_PROBLEMS: Record<DownloadProblem, string> = {
  DOWNLOAD_NO_SPACE: "There is not enough room on this disk for the model.",
  DOWNLOAD_FAILED: "The download stopped before it finished.",
  DOWNLOAD_BAD_HASH: "The file that arrived is not the model this app expects."
};

/**
 * The sentence for a download that stopped. `downloadView` reports the code as a plain string, so an
 * unrecognised one falls back to the general sentence rather than leaving the user with a blank line.
 */
export const downloadProblem = (code: string | null): string => {
  const known: Record<string, string> = DOWNLOAD_PROBLEMS;
  return (code === null ? undefined : known[code]) ?? DOWNLOAD_PROBLEMS.DOWNLOAD_FAILED;
};

export const SETTINGS_PROBLEMS: Record<SettingsProblem, string> = {
  BAD_REVIEW_TIME: "Use a time of day, like 17:30.",
  BAD_EXCLUSIONS: "That entry cannot be used.",
  BAD_VALUE: "That value cannot be used.",
  SAVE_FAILED: "That could not be saved on this machine."
};

export const COPY = {
  appName: APP_NAME,                                   // per build flavour: scripts/flavour.mjs, src/shared/flavour.ts
  nav: {label: "Sections", home: "Home", review: "Review", settings: "Settings"},
  common: {
    continue: "Continue", back: "Back", add: "Add", save: "Save", cancel: "Cancel", tryAgain: "Try again",
    whatLeaves: "Read what leaves this machine",
    remove: (entry: string) => `Remove ${entry}`,
    // The one sentence for "this window cannot reach the app": a rejected IPC call, or a component
    // that threw. One sentence for both, because the user's move is the same either way.
    noAnswer: "This window could not reach the app."
  },
  home: {
    reading: "Reading", pausedUntil: (time: string) => `Paused until ${time}.`,
    // When the run of cycles that read nothing began. It is a second sentence rather than a clause,
    // so the sentence above it stays the same one the tray uses.
    since: (time: string) => `Since ${time}.`,
    notReady: "Not quite ready. Try again in a moment.",
    // Not a blocker: nothing is known to be wrong yet, so it has no fix button (`checkingPermission`).
    // "Up to a minute" is the reader's measured cold start after a reboot.
    checkingPermission: "Checking Screen Recording. This can take up to a minute after the app starts.",
    pending: (n: number) => (n === 1 ? "1 statement is waiting for you." : `${n} statements are waiting for you.`),
    nothingPending: "Nothing is waiting for you.",
    lowBattery: "Writing statements is paused while the battery is low.",
    thermal: "Writing statements is paused while this machine is hot."
  },
  review: {title: "Today's evidence", empty: "Nothing to review today.", approve: "Approve", reject: "Reject",
    waiting: (n: number) => `Waiting to upload (${n})`, sent: "Sent",
    skill: "Skill", competency: "Competency",
    waitingEmpty: "Nothing is waiting to upload.", sentEmpty: "Nothing has been sent yet.",
    // A decision the engine answered `false` to. It says nothing about WHY — the engine does not
    // tell the window, and "that statement is no longer in the list" was a guess that is wrong as
    // often as it is right (a decision already in flight, a disk that refused the outbox).
    notSaved: "That did not go through. The list has been refreshed.",
    approved: "Approved.", rejected: "Rejected.",
    approveThis: (statement: string) => `Approve: ${statement}`,
    rejectThis: (statement: string) => `Reject: ${statement}`},
  // The tray menu lives in the shell, not the renderer, but its words are words the user reads, so
  // they are reviewed here with all the others.
  tray: {on: "Reading is on", off: "Reading is off",
    // Capture is on and healthy, but a long run of cycles read nothing at all. The switch beside this
    // label is still checked, because reading IS on — the sentence only stops the tray from implying
    // that something is coming through it.
    onNothing: "Reading is on. Nothing to read right now.",
    pause: "Pause for 1 hour",
    review: (n: number) => `Review (${n})`, settings: "Settings", quit: "Quit"},
  notify: {
    review: (n: number) => (n === 1 ? "1 statement to review" : `${n} statements to review`),
    resumed: "Reading is on, as you left it."
  },
  onboarding: {
    download: (gigabytes: string) => `Download the model (${gigabytes} GB)`,
    checking: "Checking it works on your machine",
    /**
     * What macOS is about to show, in the order the user meets it (measured with the owner on
     * macOS 27, 2026-09-18). Three things this copy exists to get right:
     *
     * · The dialog says the app wants to record “this computer's screen and audio”. It does not, and
     *   a user who reads that sentence cold has every reason to press Deny — so the lead says what
     *   the dialog will say and what is actually true, before it appears.
     * · The entry in System Settings is named after the .app FILE, not after the product, and the app
     *   is sometimes missing from the list altogether and has to be added with the + button. Hence
     *   `steps` taking the file name rather than spelling one out: see `APP_FILE` at the foot of this
     *   file for the one place it is derived.
     * · No restart is needed on the normal path — the app notices the grant by itself within seconds,
     *   and up to about a minute after a long spell of being refused. The sentence that used to stand
     *   here promised a restart after allowing; it was measured wrong on macOS 27 and is gone, and a
     *   test keeps it out of this file. `BLOCKERS.PERMISSION_NEEDS_RESTART` stays for the rare case it
     *   really describes: a fresh reader is refused too.
     */
    permission: {
      lead: "macOS will ask whether this app may record the screen. The dialog says “screen and audio”: this app reads the text of the window in front, and keeps no picture and no sound.",
      steps: (appFile: string): readonly string[] => [
        "Choose Open System Settings in the dialog, not Deny.",
        `Switch on “${appFile}”. If it is not in the list, add it with the + button.`,
        "Come back here. No restart is needed."
      ],
      aside: "macOS may offer Quit & Reopen. Later is fine."
    },
    /**
     * Shown INSTEAD of the permission step when the app is running from the temporary place macOS
     * gives a downloaded app that was opened where it landed (App Translocation; packaging design,
     * section 7). From there the Screen Recording grant was never measured and an app in an
     * unregistered place gets a grant nobody can see or revoke, so nothing is asked for until the
     * app has been moved. `steps` takes the .app file name for the same reason `permission.steps` does.
     */
    translocated: {
      title: "Move the app to Applications",
      lead: "This app is running from a temporary place macOS makes for an app that is opened straight from a download. Screen Recording cannot be set up from there.",
      steps: (appFile: string): readonly string[] => [
        "Quit this app from its menu bar icon.",
        `Move “${appFile}” into the Applications folder.`,
        "Open it from there. Onboarding continues where it stopped."
      ]
    },
    neverRead: "What is never read", privateWindows: "Chrome and Safari are read, except their private windows. Other browsers are not read yet.",
    reviewTime: "When should I show you today's evidence?", done: "All set. Reading stays off until you switch it on.",
    step: (n: number, of: number) => `Step ${n} of ${of}`,
    pitch: "How this works",
    signIn: "Sign in", identifier: "Email or handle", password: "Password",
    /** Under the heading when a finished user has been signed out: the window offers nothing else until they sign back in. */
    signedOut: "You are signed out. Clave only works for a signed-in account, because every statement it writes belongs to someone.",
    /** The browser path. The app never sees the Google password: the browser and Clave handle it, and the app gets a one-time code back. */
    signInWithGoogle: "Sign in with Google", or: "or",
    waitingForBrowser: "Finish signing in through your browser. This window will update by itself.",
    model: "The model",
    modelSize: (gigabytes: string) => `The model is ${gigabytes} GB. It is downloaded once and then runs on this machine, with or without a connection.`,
    progress: "Download progress", pause: "Pause", resume: "Resume", verifying: "Checking the file that arrived",
    selfTestFailed: "The model did not finish the check on this machine.",
    screenRecording: "Screen Recording",
    allowed: "I have allowed it", checkingPermission: "Waiting for Screen Recording",
    // Shown under the line above once the wait has run long (`stillWaiting` in model/views.ts). The
    // app usually notices within seconds; after a long spell of being refused it can take about a
    // minute, and a silent screen at that point reads as a broken one.
    stillWaitingPermission: "Still waiting. It can take up to a minute after you switch it on.",
    apps: "Apps", sites: "Sites", limits: "What it cannot do",
    reviewTimeTitle: "Review time", reviewTimeLabel: "Show me today's evidence at",
    doneTitle: "Ready", finish: "Open the app"
  },
  // How an excluded-app rule reads in the list. Rules are stored as `app::title words` (see
  // core/exclusions/rules.ts); an app-only rule reads as the app's name and needs no sentence. A
  // plain entry (what the user types) also covers window titles, and says so, so it never reads
  // like the app-only rule with the same name.
  exclusions: {
    either: (text: string) => `${text}, and windows with “${text}” in the title`,
    anyTitle: (words: string) => `Any window with “${words}” in its title`,
    appWithTitle: (app: string, words: string) => `${app} windows with “${words}” in their title`
  },
  settings: {addCurrent: (app: string) => `Exclude ${app}`, deleteAll: "Delete all local data", alsoModel: "Also remove the model", signOut: "Sign out",
    title: "Settings", apps: "Excluded apps", sites: "Excluded sites", addApp: "Name of an app", addSite: "A site, like example.com",
    reviewTime: "Review time", account: "Account", localData: "Local data", about: "About",
    name: "Name", handle: "Handle", email: "Email",
    /** Signed in with a session from an older build whose details have not been fetched yet (offline, most likely). */
    accountUnknown: "Signed in. Your name and email will show once the app reaches Clave.",
    version: "Version", modelHash: "Model",
    licences: "Third-party licences", licencesMissing: "The licence file is not part of this build.",
    /**
     * The internal flavour's one permanent line (packaging design, section 2). It used to promise that
     * nothing is uploaded, which was true of the stub backend it ran until 2026-09-23; it now signs in
     * to the real Clave and uploads what is approved, exactly as the release does, and says so.
     */
    internalBuild: "Internal build, for testing. It signs in to your Clave account and uploads the statements you approve, as the release does.",
    internalMark: "internal build",
    deleteWarning: "Every statement, the sent log and your sign-in are removed from this machine. This cannot be undone.",
    deleteConfirm: "Yes, delete everything", deleted: "Everything local was deleted."}
} as const;

/**
 * The name the user will look for in System Settings → Privacy & Security → Screen & System Audio
 * Recording. macOS names that entry after the .app FILE, and the window is told only the product
 * name — `AppInfo` carries the version, the model and the stand-in flag, and nothing about the
 * bundle — so this is derived rather than asked for, and no IPC was added to fetch it.
 *
 * KNOWN GAP, and it is deliberate: a DEV build's file is "Clave Agent Dev.app", so a developer sees a
 * name one word short of what is in their list. Shipping builds are "Clave Agent.app" and read right.
 * Curing it properly means the bundle telling the window its own file name (one more field on
 * `AppInfo`), which is a main-process change and belongs with whoever next opens that surface.
 */
export const APP_FILE = `${COPY.appName}.app`;

/** The permission step's three steps, with the name above already in them. The screen holds no words. */
export const PERMISSION_STEPS: readonly string[] = COPY.onboarding.permission.steps(APP_FILE);

/**
 * The words for the system's own parts on Windows. Everything above is macOS's, and stays the
 * default: a window that is not told its platform reads as macOS.
 *
 * Windows has no Screen Recording grant for desktop apps — the reader may capture any window — so
 * the permission step is skipped there by the engine, and these sentences only appear in the two
 * states Windows can actually reach: the reader's first answer not in yet (a moment after launch),
 * and Windows.Graphics.Capture missing altogether (a Windows older than 10 version 1903, or an
 * edition without it), which nothing in Settings can fix.
 */
export const WINDOWS_COPY = {
  noPermission: {sentence: "Windows cannot capture windows on this machine.", action: "Check again"},
  checkingHome: "Checking window capture. This can take a moment after the app starts.",
  permission: {
    title: "Window capture",
    lead: "This app reads the window in front with Windows' own window capture, which needs Windows 10 version 1903 or later. Windows says it is not available here. It keeps no picture."
  },
  checkingOnboarding: "Waiting for window capture",
  // Measured on Windows: Edge's and Chrome's toolbar strips (reader: toolbar.rs). Chrome only in
  // English, because its incognito badge is matched as an English word (reader: win/chrome.rs).
  privateWindows: "Microsoft Edge and Google Chrome are read, except their InPrivate and Incognito windows. Chrome is read only when its language is English. Other browsers are not read yet.",
  addressLimit: "In Microsoft Edge and Google Chrome it only reads a page while the address is visible."
} as const;

/**
 * The words for the system's own parts on Linux (GNOME on Wayland or Xorg). Nothing on Linux is a
 * permission in a settings app: the screen is shared through GNOME's own Share dialog (the ScreenCast
 * portal), once, and GNOME shows a sharing icon in its top bar while a session is open. The sharing
 * stops when the user chooses Stop there, which is also when NO_PERMISSION comes back.
 *
 * Measured there (L7, 2026-09-23): Google Chrome, only in English (its incognito badge is an English
 * word, reader: linux/chrome.rs), and Firefox, whose private windows are told apart by their title
 * and which is not read at all when set to never remember history (reader: linux/firefox.rs).
 */
export const LINUX_COPY = {
  noPermission: {sentence: "Screen sharing is off for this app.", action: "Share the screen"},
  // The rare case the reader client cures with a fresh helper and cannot: a kept share that the
  // system still refuses. A restart starts the share again from nothing.
  needsRestart: {sentence: "Screen sharing is on, but this app cannot use it until it restarts.", action: "Restart now"},
  checkingHome: "Checking screen sharing. This can take a moment after the app starts.",
  permission: {
    title: "Screen sharing",
    lead: "GNOME will ask which screen to share with this app. Choose your screen, then Share. The app reads the text of the window in front and keeps no picture. While reading is on, GNOME shows a sharing icon in the top bar."
  },
  checkingOnboarding: "Waiting for screen sharing",
  privateWindows: "Google Chrome and Firefox are read, except their private windows. Chrome is read only when its language is English, and Firefox is not read when it is set to never remember history. Other browsers are not read yet.",
  addressLimit: "In Google Chrome and Firefox it only reads a page while the address is visible.",
  // `basic_text`: Electron found no system keyring (decision 5 of the Linux design), so a sign-in
  // cannot be kept encrypted and is refused rather than stored in the clear.
  storageUnavailable: "Your sign-in could not be saved, because this machine has no keyring to keep it in safely.",
  // Under the sign-in form. With automatic login GNOME's keyring is still locked, and the first app
  // that stores a secret makes GNOME ask for the password: a dialog that would otherwise come from
  // nowhere, in the middle of signing in.
  keyringNote: "GNOME may ask for your password to unlock its keyring. That is where your sign-in is kept.",
  /**
   * The screen-sharing step on Linux, in two stages, the extension first. The extension's own
   * problems are the blockers' sentences (`BLOCKERS.EXTENSION_*`); these are the words around them.
   */
  setup: {
    lead: "On GNOME this takes two things, each done once: an extension that tells the app which window is in front, and a screen share.",
    stages: {extension: "The GNOME extension", share: "Share the screen"},
    marks: {done: "Done", now: "Now", next: "Next"},
    extensionLead: "Only GNOME knows which window is in front and where it is. This small extension tells this app's reader, and answers nobody else.",
    loginNote: "Save your work in other apps first: GNOME asks before it logs out. This step picks up where it stopped when you are back.",
    installFailed: "The GNOME extension could not be installed. Try again in a moment."
  },
  settings: {
    label: "GNOME extension",
    lead: "It tells this app which window is in front. Without it nothing is read.",
    remove: "Remove the GNOME extension",
    removed: "Removed. Nothing is read until it is installed again from Home.",
    removeFailed: "The GNOME extension could not be removed. Try again in a moment."
  }
} as const;

type CopyPlatform = AppInfo["platform"];

/** One platform's words for the parts of the system the app talks about. */
interface SystemWords {
  noPermission: BlockerCopy;
  needsRestart: BlockerCopy;
  checkingHome: string;
  privateWindows: string;
  /** The address-row limit in this platform's browsers, or null for macOS's own line. */
  addressLimit: string | null;
  storageUnavailable: string;
}

/**
 * The words per platform. macOS's are the objects above themselves, so its output is exactly what it
 * was (the tests compare by identity), and a window told no platform reads as macOS.
 */
const SYSTEM_WORDS: Record<NonNullable<CopyPlatform>, SystemWords> = {
  mac: {
    noPermission: BLOCKERS.NO_PERMISSION, needsRestart: BLOCKERS.PERMISSION_NEEDS_RESTART,
    checkingHome: COPY.home.checkingPermission, privateWindows: COPY.onboarding.privateWindows, addressLimit: null,
    storageUnavailable: SIGN_IN_PROBLEMS.STORAGE_UNAVAILABLE
  },
  windows: {
    noPermission: WINDOWS_COPY.noPermission, needsRestart: BLOCKERS.PERMISSION_NEEDS_RESTART,
    checkingHome: WINDOWS_COPY.checkingHome, privateWindows: WINDOWS_COPY.privateWindows, addressLimit: WINDOWS_COPY.addressLimit,
    storageUnavailable: SIGN_IN_PROBLEMS.STORAGE_UNAVAILABLE
  },
  linux: {
    noPermission: LINUX_COPY.noPermission, needsRestart: LINUX_COPY.needsRestart,
    checkingHome: LINUX_COPY.checkingHome, privateWindows: LINUX_COPY.privateWindows, addressLimit: LINUX_COPY.addressLimit,
    storageUnavailable: LINUX_COPY.storageUnavailable
  }
};
const wordsFor = (platform: CopyPlatform): SystemWords => SYSTEM_WORDS[platform ?? "mac"];

/** A blocker's sentence and button, in this platform's words. */
export const blockerCopy = (blocker: Blocker, platform: CopyPlatform): BlockerCopy =>
  blocker === "NO_PERMISSION" ? wordsFor(platform).noPermission
    : blocker === "PERMISSION_NEEDS_RESTART" ? wordsFor(platform).needsRestart
    : BLOCKERS[blocker];

/** A refused sign-in's sentence, in this platform's words. */
export const signInProblem = (code: SignInProblem, platform: CopyPlatform): string =>
  code === "STORAGE_UNAVAILABLE" ? wordsFor(platform).storageUnavailable : SIGN_IN_PROBLEMS[code];

/** Which browsers are read, for onboarding and Settings. */
export const privateWindowsLine = (platform: CopyPlatform): string => wordsFor(platform).privateWindows;

/** Home's quiet line while the reader's first permission answer is not in yet. */
export const checkingPermissionLine = (platform: CopyPlatform): string => wordsFor(platform).checkingHome;

/** The known limits, with the one line that names browsers in this platform's browsers. */
export const knownLimits = (platform: CopyPlatform): readonly string[] => {
  const line = wordsFor(platform).addressLimit;
  return line === null ? KNOWN_LIMITS : KNOWN_LIMITS.map((limit) => (limit.startsWith("In Chrome and Safari") ? line : limit));
};
