import {createPipeline} from "../core/index";
import {APP_NAME} from "../shared/flavour";
import type {PendingStatement, Pipeline, PipelineConfig} from "../core/types";
import type {GoogleSignIn} from "./account/googleSignIn";
import {createSessionStore, type SignInResult} from "./account/session";
import {createTaxonomyCache} from "./account/taxonomy";
import {createCaptureLoop, type BarrenCounts, type CycleOutcome, type FailureTallyKey} from "./capture/loop";
import {PAUSE_FOR_MS, PIPELINE_TICK_MS, QUIT_DRAIN_MS, SCHEDULER_CHECK_MS} from "./constants";
import {createLog, type LogCode, type LogCountKey} from "./log";
import type {ReaderClientEvent} from "./reader/readerClient";
import type {ModelClient} from "./model/client";
import type {Downloader} from "./model/download";
import {runSelfTest, selfTestKey, type SelfTestResult} from "./model/selfTest";
import type {ApprovedStatement, ClaveApi} from "./ports/claveApi";
import {parsePermission, type Permission, type Reader} from "./ports/reader";
import {isStandIn} from "./ports/standIn";
import type {Cipher, FileSystem, Now} from "./ports/system";
import {watchPower, type PauseReason, type PowerSource} from "./power";
import {createPoolStore} from "./review/pool";
import {createReviewScheduler, type LocalTime} from "./review/scheduler";
import {createSentLog, type SentEntry} from "./review/sentLog";
import {createUploader} from "./review/uploader";
import {defaultSettings, loadSettings, type Settings, type SettingsPatch, type SettingsProblem} from "./settings";
import type {StorageErrorCode} from "./storage/jsonFile";
import {dataPaths, deletablePaths} from "./storage/paths";

/** Why capture cannot run. Fixed codes; the renderer turns each into one sentence and one fix button. */
export type Blocker =
  | "SIGNED_OUT" | "NO_TAXONOMY" | "MODEL_MISSING" | "SELF_TEST_NEEDED" | "NO_PERMISSION" | "PERMISSION_NEEDS_RESTART"
  | "SETTINGS_NEED_REVIEW" | "MODEL_PROBLEM" | "READER_PROBLEM" | "STORAGE_PROBLEM";

/**
 * Which kind of "nothing is coming through" this is, in the three groups a user can act on:
 * `notAllowed` — the windows in front are ones the app is not allowed to read (an excluded app, an
 * unmeasured browser, a private window), so Settings is where to look; `noWindow` — there was nothing
 * to read (no front window, the window went, the screen locked); `other` — everything else.
 */
export type NothingReadWhy = "notAllowed" | "noWindow" | "other";
/** Reading is on and has produced nothing since `since`. Numbers and fixed codes only: never a title. */
export interface NothingRead { since: number; why: NothingReadWhy }

export interface EngineStatus {
  capture: "on" | "off" | "pausedByUser";
  /** When "Pause for 1 hour" ends. */
  resumeAt: number | null;
  blockers: Blocker[];
  /** Why extraction is waiting, if it is. Capture continues meanwhile. */
  extractionPaused: PauseReason | null;
  pending: number;
  waitingUpload: number;
  /**
   * Capture is on, but a long run of cycles read nothing at all. Deliberately NOT a blocker: nothing
   * is broken and nothing has to be switched off — the tray was simply saying "Reading is on" while
   * the truth was "and nothing has come through it for a quarter of an hour". `null` whenever reading
   * is producing something, and whenever the loop is not running.
   */
  nothingRead: NothingRead | null;
}

/**
 * Every outcome the capture loop can report, and every stage key it can tally a failure under, has a
 * count key of its own, so the tallies that reach the log keep their names. A new `CycleOutcome` or
 * `FailureTallyKey` without a `LOG_COUNT_KEYS` entry stops typecheck here rather than being silently
 * dropped by `log.event`'s closed-set check at runtime.
 *
 * Both directions matter, and the second one is why this is worth having twice over: `FailureTallyKey`
 * is derived from `FAILED_DETAIL_KEY`, which `satisfies Record<FailureDetail, string>` — so a failure
 * detail added to the port with no key stops typecheck in the loop, and a key with no entry in
 * `LOG_COUNT_KEYS` stops it here. Between the two, a new stage cannot reach the log as a count that
 * is quietly thrown away, and a key removed from `LOG_COUNT_KEYS` cannot leave the loop tallying into
 * nothing.
 */
type Expect<T extends true> = T;
export type AssertCycleOutcomesAreCountKeys = Expect<CycleOutcome extends LogCountKey ? true : false>;
export type AssertFailureStagesAreCountKeys = Expect<FailureTallyKey extends LogCountKey ? true : false>;

/**
 * The dominant group of a streak. Ties go to the group the user can do most about: being told
 * "the apps in front are ones you excluded" is actionable, "there was nothing in front" less so, and
 * "other" least of all — so an even split names the first of those rather than the vaguest.
 */
export function nothingReadWhy(counts: BarrenCounts): NothingReadWhy {
  const sum = (...keys: Array<keyof BarrenCounts>): number => keys.reduce((total, key) => total + (counts[key] ?? 0), 0);
  const total = Object.values(counts).reduce((a: number, b: number) => a + b, 0);
  const notAllowed = sum("denied", "notKept");
  const noWindow = sum("noWindow", "windowGone", "locked");
  // "other" is the remainder rather than a list, so a barren outcome added later lands there by
  // itself instead of being counted into a group it does not belong to.
  const groups: Array<[NothingReadWhy, number]> = [
    ["notAllowed", notAllowed], ["noWindow", noWindow], ["other", total - notAllowed - noWindow]
  ];
  return groups.reduce((best, group) => (group[1] > best[1] ? group : best))[0];
}

export interface ReviewItem extends PendingStatement { targetName: string }
export interface ReviewView { pending: ReviewItem[]; waitingUpload: ApprovedStatement[]; sent: SentEntry[] }

/**
 * The only settings a user may change. The gates are deliberately absent: `captureOn` moves through
 * `setCapture` alone, and `selfTestPassedFor` and `lastPromptDay` belong to the self-test and the
 * scheduler. The caller is the renderer, so the keys are filtered again at runtime — a patch reached
 * through IPC cannot forge a gate by claiming a wider type than this one.
 */
export type UserSettingsPatch = Partial<Pick<Settings, "exclusions" | "excludedSites" | "reviewTime" | "onboardingStep">>;
const USER_SETTINGS_KEYS = ["exclusions", "excludedSites", "reviewTime", "onboardingStep"] as const;

/** The `uploader.flush()` outcomes that mean the DISK refused, as opposed to the network. */
const STORAGE_FLUSH_CODES: ReadonlySet<string> = new Set<StorageErrorCode>(["STORAGE_UNAVAILABLE", "STORAGE_WRITE_FAILED"]);

export type EngineErrorCode = "STANDIN_IN_PRODUCTION";
export class EngineError extends Error { constructor(readonly code: EngineErrorCode) { super(code); this.name = "EngineError"; } }

export interface EngineDeps {
  reader: Reader; api: ClaveApi; model: ModelClient;
  downloader: Pick<Downloader, "state" | "onChange" | "removeAll">;
  fs: FileSystem; cipher: Cipher; dataDir: string;
  power: PowerSource; idleSeconds: () => number; now: Now; local: LocalTime; newId: () => string;
  appVersion: string; modelSha256: string; production: boolean;
  /** The daily "n statements to review" notification. */
  notifyReview: (count: number) => void;
  /** Shown once at launch when capture resumed by itself. */
  notifyCaptureResumed: () => void;
  /** A browser sign-in, when the build has one; without it `signInWithGoogle` answers OAUTH_BROWSER. */
  googleSignIn?: GoogleSignIn;
}

export interface Engine {
  status(): EngineStatus;
  onStatus(cb: (status: EngineStatus) => void): () => void;
  setCapture(on: boolean): Promise<{ok: true} | {ok: false; blockers: Blocker[]}>;
  pauseForAnHour(): Promise<void>;
  signIn(identifier: string, password: string): Promise<SignInResult>;
  /** Sends the user's browser to Google through clave-back and signs in with what comes back. */
  signInWithGoogle(): Promise<SignInResult>;
  cancelGoogleSignIn(): void;
  signOut(): Promise<void>;
  review(): ReviewView;
  approve(id: string): Promise<boolean>;
  reject(id: string): Promise<boolean>;
  settings(): Settings;
  /** The user opened Settings: a recovered settings file counts as reviewed from now on. */
  settingsOpened(): void;
  updateSettings(patch: UserSettingsPatch): Promise<{ok: true} | {ok: false; problem: SettingsProblem}>;
  selfTest(): Promise<SelfTestResult>;
  /** Asks the reader for the permission state again (after the user visited System Settings). */
  recheckPermission(): Promise<Permission>;
  retry(problem: "model" | "reader"): void;
  system(event: "locked" | "unlocked" | "suspend" | "resume"): void;
  /** The core's counters, emptied. Fixed keys, numbers only: what the later daily summary sends. */
  takeCounters(): Record<string, number>;
  deleteAllData(opts: {removeModel: boolean}): Promise<void>;
  /** What the native reader's supervisor reports. A code goes to the log; nothing else happens here. */
  noteReaderEvent(event: ReaderClientEvent): void;
  quit(): Promise<void>;
}

/** A closed mapping: an event outside it is not logged at all. */
const READER_EVENT_CODES: Readonly<Record<ReaderClientEvent, LogCode>> = {
  HELPER_EXIT: "READER_HELPER_EXIT", HELPER_START_TIMEOUT: "READER_HELPER_START_TIMEOUT", HELPER_WEDGED: "READER_HELPER_WEDGED",
  HELPER_PROTOCOL_MISMATCH: "READER_PROTOCOL_MISMATCH", HELPER_GAVE_UP: "READER_HELPER_GAVE_UP", HELPER_REPLACED: "READER_HELPER_REPLACED"
};

export async function createEngine(deps: EngineDeps): Promise<Engine> {
  // Every injected port, not just the two that happened to have stand-ins first: a packaged build
  // that read the screen through a replayed fixture, signed in against a stub, "encrypted" with a
  // scrambler, extracted with a scripted answer or believed a model it never downloaded would be
  // wrong about a real user's statements without anybody noticing. One marker, checked on all of them.
  if (deps.production && [deps.reader, deps.api, deps.cipher, deps.model, deps.downloader].some(isStandIn)) {
    throw new EngineError("STANDIN_IN_PRODUCTION");
  }
  const {reader, api, model, fs, cipher, now} = deps;
  const paths = dataPaths(deps.dataDir);
  const log = createLog({fs, path: paths.log, now});

  /**
   * Every promise the engine starts without waiting for it goes through here. Nothing the app does in
   * the background may reach the process as an unhandled rejection; the failure is recorded as one
   * fixed code instead. The log call is guarded in turn, so a refusing disk cannot reject from here either.
   */
  function background(work: Promise<unknown>): void {
    void work.catch(() => { void log.event("BACKGROUND_TASK_FAILED").catch(() => undefined); });
  }
  const unreadable = (code: LogCode) => () => { background(log.event(code)); };

  const settings = await loadSettings({fs, path: paths.settings});
  // The user's own exclusions are gone: worth a line, and the blocker keeps capture off until they look.
  if (settings.needsReview()) background(log.event("SETTINGS_FILE_UNREADABLE"));
  const session = createSessionStore({api, fs, cipher, path: paths.session, now, onUnreadable: unreadable("SESSION_FILE_UNREADABLE")});
  const taxonomy = createTaxonomyCache({api, session, fs, path: paths.taxonomy, now});
  const sentLog = createSentLog({fs, path: paths.sentLog});
  const uploader = createUploader({
    api, session, sentLog, fs, cipher, path: paths.outbox, now, onUnreadable: unreadable("OUTBOX_FILE_UNREADABLE"),
    // A count and nothing else: which statements were refused is not a thing the log may hold.
    onRejected: (count) => { background(log.event("UPLOAD_REJECTED", {count})); }
  });
  const pool = createPoolStore({fs, cipher, path: paths.pool, onUnreadable: unreadable("POOL_FILE_UNREADABLE")});

  let permission: Permission = "unknown";
  /** The one permission read in flight, if any: a tick waits for it rather than starting another. */
  let permissionRead: Promise<void> | null = null;
  let readerProblem = false;
  /** Which files the disk is refusing. One flag per file: a write that works again clears only its own. */
  const storageProblems = new Set<"pool" | "outbox" | "settings">();
  /**
   * The statements a decision is being made about right now. One statement, one decision: while an
   * approve is in flight (the encrypted outbox write can take as long as the disk takes), any other
   * decision on the SAME id is answered `false` at once rather than racing it — two approves would
   * upload the same statement twice, and an approve plus a reject would upload it and then try to
   * throw it away. The lock lives here and not in the window because the renderer is untrusted
   * input: a double click, a stuck keyboard or a hostile page must all hit the same wall.
   */
  const deciding = new Set<string>();
  let resumeAt: number | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let extractionPaused: PauseReason | null = null;
  /** Raised and cleared by the capture loop alone (see its `onNothingRead`/`onReadingAgain`). */
  let nothingRead: NothingRead | null = null;
  let savedPool = "";
  let saving: Promise<void> = Promise.resolve();
  let stopped = false;
  /** Whose the pending statements are. They are shown to nobody else, and to nobody while signed out. */
  let poolOwner: string | null = null;
  /**
   * True until capture has come back by itself once (which is worth a notice) or the user touched the
   * switch. The stored switch state decides it here, before anything can start the loop: a
   * precondition that arrives during start-up already counts as capture resuming by itself.
   */
  let resumeNoticeDue = settings.get().captureOn;
  const listeners = new Set<(status: EngineStatus) => void>();

  const config = (): PipelineConfig => {
    const t = taxonomy.current();
    const s = settings.get();
    return {exclusions: s.exclusions, excludedSites: s.excludedSites, selfApp: APP_NAME, taxonomyVersion: t?.version ?? "none", skills: t?.skills ?? [], competencies: t?.competencies ?? [], userNames: session.names()};
  };
  const newPipeline = (): Pipeline => createPipeline(config(), {model, clock: {now, dayKey: (ms) => deps.local(ms).day}, newId: deps.newId});
  let pipeline = newPipeline();

  const loop = createCaptureLoop({
    reader, idleSeconds: deps.idleSeconds, now,
    pipeline: {mayCapture: (front) => pipeline.mayCapture(front), ingest: (read) => pipeline.ingest(read)},
    onReaderProblem: () => {
      readerProblem = true;
      background(log.event("READER_PROBLEM"));
      // A reader that keeps failing may simply have lost its permission: ask, rather than blame the reader.
      background(refreshPermission());
      background(evaluate());
    },
    // Nothing is wrong, so nothing is switched off and no blocker is raised: capture goes on running,
    // and the one thing that changes is that the app stops claiming to be reading. The counts carry
    // only outcome names and numbers, which is all `log.event` will write anyway.
    onNothingRead: (counts, since) => {
      // Only ever while the loop is running. The loop cannot report a barren cycle after `stop()`
      // today, and this is the one place where a future slip would be unrecoverable: the notice
      // would be raised after `stop()` had already retracted it, and nothing would clear it again —
      // the tray and the Home line would claim "reading is on, nothing to read" with capture off.
      if (!loop.running()) return;
      nothingRead = {since, why: nothingReadWhy(counts)};
      background(log.event("READER_NOTHING_TO_READ", counts));
      emit();
    },
    onReadingAgain: () => { nothingRead = null; emit(); }
  });

  /**
   * The ONE way a running loop is ever stopped, and the one place the run's tallies are written out:
   * how many cycles kept something, how many found nothing to read, and why. `stats()` is per run
   * (the loop clears it in `start()`), so each line is that run alone and consecutive lines never
   * double-count — which is how anyone reading `app.log` takes them anyway.
   *
   * It has to be every site and not just `evaluate`: the commonest way a run ends is tray → Quit,
   * and a session nobody switched off by hand used to leave no tally at all, so "a run that read
   * nothing for hours leaves no trace" stayed true for exactly the runs that matter most.
   *
   * Numbers and closed count keys only (the loop's outcome names), so there is no privacy cost to
   * writing one more of these. Returns the write so a caller that must not lose it can await it.
   */
  function stopLoop(): Promise<void> {
    if (!loop.running()) return Promise.resolve();
    loop.stop();
    return log.event("CAPTURE_OFF", {blockers: blockers().length, ...loop.stats()});
  }

  function blockers(): Blocker[] {
    const found: Blocker[] = [];
    if (!session.current()) found.push("SIGNED_OUT");
    if (!taxonomy.current()) found.push("NO_TAXONOMY");
    if (deps.downloader.state().kind !== "ready") found.push("MODEL_MISSING");
    else if (settings.get().selfTestPassedFor !== selfTestKey(deps.appVersion, deps.modelSha256)) found.push("SELF_TEST_NEEDED");
    if (permission === "needsRestart") found.push("PERMISSION_NEEDS_RESTART");
    else if (permission !== "granted") found.push("NO_PERMISSION");
    if (settings.needsReview()) found.push("SETTINGS_NEED_REVIEW");
    if (model.broken()) found.push("MODEL_PROBLEM");
    if (readerProblem) found.push("READER_PROBLEM");
    // Only a disk that is actually refusing. `storageProblems` holds one flag per file, and the
    // "settings" flag is raised exactly when a stamp or a reset was WRITTEN and refused — which is
    // the case where the user has something to fix. The ordinary one-turn gap between a sign-in and
    // `ensureSettingsOwner` is not a problem with anybody's disk, so it is not reported as one; it
    // keeps capture off through `wouldRun` instead.
    if (storageProblems.size > 0) found.push("STORAGE_PROBLEM");
    return found;
  }

  /**
   * Would capture be running if the user had not paused it? The owner-pending condition is here and
   * not in `blockers()`: nothing may be read under choices that are not the signed-in account's, but
   * that is a reason not to run, not something wrong the user is told about. This is the ONE gate
   * every path to `loop.start()` passes through (`evaluate` is the only caller), which is what keeps
   * the turn between a sign-in and its stamp at zero reads.
   */
  const wouldRun = (): boolean => settings.get().captureOn && !settingsOwnerPending() && blockers().length === 0 && !stopped;
  /** Pending statements belong to one user: with nobody signed in there is nothing anyone may see. */
  const visiblePending = (): PendingStatement[] => (session.current() ? pipeline.digest() : []);

  function status(): EngineStatus {
    // "Paused by the user" only while that pause is the reason: with a blocker on top, what the user
    // needs to see is the blocker and an off switch, not a countdown that would change nothing.
    const paused = resumeAt !== null && wouldRun();
    return {
      capture: loop.running() ? "on" : paused ? "pausedByUser" : "off",
      resumeAt, blockers: blockers(), extractionPaused,
      pending: visiblePending().length, waitingUpload: uploader.waitingCount(),
      // Only ever set while the loop is running: the loop retracts it on its way out, so there is no
      // second place that has to remember to.
      nothingRead
    };
  }
  const emit = () => {
    const s = status();
    // One listener that throws must not cost the others their update, nor escape into the timer that
    // happens to be running this emit.
    for (const cb of listeners) { try { cb(s); } catch { /* the renderer's problem, not the engine's */ } }
  };

  /** The one place that turns capture on or off. Capture runs only while the switch is on AND nothing blocks it. */
  async function evaluate(): Promise<void> {
    const wanted = resumeAt === null && wouldRun();
    if (wanted && !loop.running()) {
      pipeline.signal("captureOn");
      loop.start();
      // The loop refuses to run under a reader it could not subscribe to, and has already raised the
      // reader problem (synchronously, through `onReaderProblem`) on its way out. Capture is NOT on:
      // undo the signal, claim nothing about starting, and let the blocker speak. Never a rejection
      // out of the caller — `setCapture` and `retry` both reach this line — and never silence.
      if (!loop.running()) { pipeline.signal("captureOff"); emit(); return; }
      background(log.event("CAPTURE_ON"));
      // Capture that comes back by itself — the switch was on at launch and whatever was missing has
      // arrived since — is not obvious from the outside. Say so once, whenever that moment comes.
      if (resumeNoticeDue) {
        resumeNoticeDue = false;
        try { deps.notifyCaptureResumed(); } catch { /* a notice that cannot be shown must not stop capture */ }
      }
    }
    // The ordinary end of a run: the switch went off, or something started blocking capture.
    if (!wanted && loop.running()) { background(stopLoop()); pipeline.signal("captureOff"); }
    emit();
  }

  /** One place for "the disk refused": the blocker, one log line, capture off. */
  async function raiseStorageProblem(source: "pool" | "outbox" | "settings"): Promise<void> {
    if (storageProblems.has(source)) return;
    const first = storageProblems.size === 0;
    storageProblems.add(source);
    if (first) background(log.event("STORAGE_PROBLEM"));
    await evaluate();
  }

  /** And one place for "the disk took a write again": the blocker goes and capture may resume. */
  async function clearStorageProblem(source: "pool" | "outbox" | "settings"): Promise<void> {
    if (!storageProblems.delete(source)) return;
    await evaluate();
  }

  /** The file names an account, and it is not the one signed in: its contents are nobody's to see. */
  const settingsBelongToSomeoneElse = (): boolean => {
    const userId = session.userId();
    const owner = settings.get().ownerUserId;
    return userId !== null && owner !== null && owner !== userId;
  };
  /** Somebody is signed in and the file is not stamped with them yet (never stamped, or someone else's). */
  const settingsOwnerPending = (): boolean => {
    const userId = session.userId();
    return userId !== null && settings.get().ownerUserId !== userId;
  };

  /**
   * Exclusions, excluded sites, the review time and the capture switch belong to one account. The
   * first account to sign in adopts settings that have no owner yet; any other account gets the
   * defaults with capture off. Nobody's screen is read because somebody else once agreed to it.
   * `onboardingStep` and `selfTestPassedFor` are facts about this install, so they stay.
   * An ADOPTED file keeps the choices (exclusions, sites, review time: at worst they read less than
   * the defaults would) but never the switch or the prompt day. Nobody can say which account turned
   * capture on in a file that names no owner, so the switch starts off and the user turns it on.
   * The reset is durable: until it is on disk the mismatch itself blocks capture (see `blockers`),
   * and the tick calls this again.
   */
  async function ensureSettingsOwner(): Promise<void> {
    const userId = session.userId();
    // Signed out, nothing is read under anybody's settings, so an unfinished reset has nothing left
    // to protect: the blocker must not outlive the account that raised it. The reset itself still
    // happens, on the next sign-in, which calls this again.
    if (userId === null) { await clearStorageProblem("settings"); return; }
    const owner = settings.get().ownerUserId;
    if (owner === userId) { await clearStorageProblem("settings"); return; }
    const fresh = defaultSettings();
    const result = await settings.update(owner === null
      ? {ownerUserId: userId, captureOn: false, lastPromptDay: null}
      : {exclusions: fresh.exclusions, excludedSites: fresh.excludedSites, reviewTime: fresh.reviewTime, captureOn: false, lastPromptDay: null, ownerUserId: userId});
    if (!result.ok) { await raiseStorageProblem("settings"); return; }
    if (owner !== null) background(log.event("SETTINGS_RESET_FOR_NEW_OWNER"));
    pipeline.configure(config());
    await clearStorageProblem("settings");
  }

  /**
   * Takes over the outbox for the signed-in account. Another account's unsent statements are
   * discarded (never uploaded to the wrong profile) and that is logged with the count. A disk that
   * refuses the write is a storage problem, not a failed sign-in; the tick tries again.
   */
  async function adoptOutbox(): Promise<void> {
    const userId = session.userId();
    try {
      if (userId === null) await uploader.resave();
      else {
        const discarded = await uploader.adoptOwner(userId);
        if (discarded > 0) background(log.event("OUTBOX_DISCARDED", {count: discarded}));
      }
      await clearStorageProblem("outbox");
    } catch { await raiseStorageProblem("outbox"); }
  }

  /** The owner is part of the snapshot: a pool that changed hands must be written again. */
  const poolSnapshot = (): string => JSON.stringify([poolOwner, pipeline.exportPool()]);

  function savePool(): Promise<void> {
    saving = saving.then(async () => {
      const snapshot = poolSnapshot();
      // A standing pool problem is re-probed even when there is nothing new to write. Otherwise a
      // pool that came back to exactly what the file already holds — a statement captured while the
      // disk refused and then rejected — would leave the blocker standing for the rest of the
      // session with no write left to clear it.
      if (snapshot === savedPool && !storageProblems.has("pool")) return;
      try { await pool.save(pipeline, poolOwner); savedPool = snapshot; await clearStorageProblem("pool"); }
      catch { await raiseStorageProblem("pool"); }
    });
    return saving;
  }

  /** Whatever signed the user in, the same things follow: the pool, the outbox and the settings become this account's, and the skill list is fetched. */
  async function signedInBy(attempt: () => Promise<SignInResult>): Promise<SignInResult> {
    if (stopped) return {ok: false, code: "UNAUTHORISED"};
    const result = await attempt();
    // A sign-in that lands after quit (a browser wait can take minutes) is stored, but nothing else
    // may run on a stopped engine: the pool and the outbox are quit's to save.
    if (stopped) return result;
    if (result.ok) {
      const userId = session.userId() as string;
      if (poolOwner !== null && poolOwner !== userId) await startFreshFor(userId);
      poolOwner = userId;
      await adoptOutbox();
      await ensureSettingsOwner();
      await taxonomy.refresh(true);
      pipeline.configure(config());
      background(savePool());
      background(flushUploads(true));
    }
    await evaluate();
    return result;
  }

  /**
   * Every automatic upload attempt (the tick's and the one after a sign-in). A flush that failed on
   * the DISK — the outbox or the sent log would not be written — is the same problem a failed pool
   * save raises: said out loud, with capture off, rather than a silent backoff behind an app that
   * looks healthy. A network code is ordinary and only ever means "later".
   */
  async function flushUploads(force = false): Promise<void> {
    const result = await uploader.flush(force);
    if (STORAGE_FLUSH_CODES.has(result)) await raiseStorageProblem("outbox");
    // "sent" is the one answer that can only come from writes that all went through, so it is also
    // the only one allowed to retire a standing storage problem: "waiting" is the backoff's answer
    // as well as a partial send's, and "empty"/"signedOut" are decided before any write is tried.
    else if (result === "sent") await clearStorageProblem("outbox");
    emit();
  }

  /**
   * Asks the reader for the permission state again and acts on the answer. Only one read is ever in
   * flight: a tick that lands while the previous read is still out waits for that one.
   */
  function refreshPermission(): Promise<void> {
    if (permissionRead) return permissionRead;
    const run = (async () => {
      const answer = parsePermission(await reader.permission().catch(() => "unknown"));
      if (stopped) return;
      // "unknown" is the absence of an answer, not an answer: a reader that is busy, restarting or
      // dying says nothing about the permission, and the last thing it did say still stands. Letting
      // it through would make capture flap off and on with every missed read, and would log a
      // revocation that never happened. Only "granted"/"denied"/"needsRestart" change anything.
      // (At launch the state starts out "unknown" on its own, so a reader that cannot answer then
      // still blocks capture — nothing better is known yet. A reader that is permanently broken is
      // the capture loop's READER_PROBLEM supervision's business, not this function's.)
      if (answer !== "unknown") {
        const lost = permission === "granted" && answer !== "granted";
        permission = answer;
        // Screen Recording switched off under a running app is its own fixed code, not a reader problem.
        if (lost) background(log.event("PERMISSION_LOST"));
      }
      await evaluate();
    })();
    permissionRead = run.finally(() => { permissionRead = null; });
    return permissionRead;
  }

  const scheduler = createReviewScheduler({
    now, local: deps.local, reviewTime: () => settings.get().reviewTime,
    lastPromptDay: () => settings.get().lastPromptDay,
    setLastPromptDay: async (day) => { await settings.update({lastPromptDay: day}); },
    // What the review screen would actually list: a count nobody can act on is not worth a prompt.
    pendingCount: () => visiblePending().length, notify: deps.notifyReview
  });

  /**
   * The daily prompt belongs to a signed-in user. With nobody signed in the check is skipped
   * ENTIRELY rather than answered with a count of zero: answering would mark the day as handled and
   * silently swallow that day's prompt, so a user who signs in later the same evening would never
   * hear about the statements waiting for them. Skipped, the moment is still there to be caught up on.
   */
  const checkReview = (): Promise<void> => (session.current() ? scheduler.check() : Promise.resolve());

  // ---- start-up ----
  permission = parsePermission(await reader.permission().catch(() => "unknown"));
  await session.restore();
  await taxonomy.load();
  await sentLog.load();
  await uploader.load();
  if (session.userId()) await adoptOutbox();
  // Before anything can be read: settings left by another account are reset, ownerless ones adopted.
  await ensureSettingsOwner();
  background(taxonomy.refresh().then(() => { pipeline.configure(config()); return evaluate(); }));
  pipeline.configure(config());
  // Signed in: only this user's pool is restored, and another user's is discarded. Signed out: the
  // pool is restored but stays hidden until its owner is back (`visiblePending`).
  poolOwner = (await pool.restore(pipeline, session.userId())).ownerUserId;
  savedPool = poolSnapshot();

  function applyPowerReason(reason: PauseReason | null): void {
    extractionPaused = reason;
    pipeline.signal(reason ? "modelPaused" : "modelResumed");
    background(log.event(reason ? "EXTRACTION_PAUSED" : "EXTRACTION_RESUMED"));
    emit();
  }
  const stopPower = watchPower(deps.power, applyPowerReason);
  // watchPower never calls the callback during construction: apply a pause already in force at start once, here.
  if (stopPower.paused()) applyPowerReason(stopPower.paused());
  const stopBroken = model.onBroken(() => { background(log.event("MODEL_PROBLEM")); background(evaluate()); });
  const stopDownload = deps.downloader.onChange(() => { background(evaluate()); });
  const stopSession = session.onChange(() => { pipeline.configure(config()); background(evaluate()); });
  const stopTaxonomy = taxonomy.onChange(() => { pipeline.configure(config()); background(evaluate()); });
  const stopSettings = settings.onChange(() => { pipeline.configure(config()); });

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  function startTimers(): void {
    if (stopped || tickTimer !== null) return;
    tickTimer = setInterval(() => {
      pipeline.tick();
      background(savePool());
      background(flushUploads());
      background(taxonomy.refresh());
      // Whatever the disk refused is tried again, file by file, so no storage problem can outlive its cause.
      if (storageProblems.has("outbox")) background(adoptOutbox());
      if (storageProblems.has("settings") || settingsOwnerPending()) background(ensureSettingsOwner());
      // The permission can be taken away while the app runs; nothing tells us, so ask every tick.
      background(refreshPermission());
      emit();
    }, PIPELINE_TICK_MS);
    schedulerTimer = setInterval(() => { background(checkReview()); background(session.refreshIfDue()); }, SCHEDULER_CHECK_MS);
  }
  function stopTimers(): void {
    if (tickTimer !== null) clearInterval(tickTimer);
    if (schedulerTimer !== null) clearInterval(schedulerTimer);
    tickTimer = null;
    schedulerTimer = null;
  }
  startTimers();

  await evaluate();
  await checkReview();

  /** A different user signed in: nothing of the previous owner's may be shown, uploaded or left behind. */
  async function startFreshFor(nextOwner: string): Promise<void> {
    await stopLoop();                         // the previous owner's run ends here, tallies and all
    const previous = pipeline;
    previous.signal("captureOff");            // closes the open scenario of the pipeline being dropped
    pipeline = newPipeline();                 // the old buffer, queue and pool are unreachable from here on
    await saving;                             // no queued save may write anything as the new owner's
    poolOwner = nextOwner;
    savedPool = poolSnapshot();               // the file below and an empty pool agree: nothing to write
    // A disk that refuses is a storage problem, not a failed sign-in: the items are already out of
    // memory, and the file is discarded on the next launch anyway because it is not this user's.
    // A refused removal is retried by the next pool save: the empty snapshot below no longer matches.
    try { await pool.clear(); } catch { savedPool = ""; await raiseStorageProblem("pool"); }
    // The previous account's settings are dealt with by `ensureSettingsOwner`, which does not depend
    // on a pool file being there to notice that the account changed.
  }

  return {
    status,
    noteReaderEvent(event) {
      if (stopped || !Object.hasOwn(READER_EVENT_CODES, event)) return;
      background(log.event(READER_EVENT_CODES[event]));
    },
    onStatus(cb) {
      if (stopped) return () => undefined;
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    takeCounters() {
      const safe: Record<string, number> = {};
      for (const [key, value] of Object.entries(pipeline.takeCounters())) {
        if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
      }
      return safe;
    },
    async setCapture(on) {
      if (stopped) return {ok: false, blockers: blockers()};
      // Switching on while something is missing changes nothing, so it must not quietly end a pause
      // the user started: the refusal leaves the pause exactly as it was. The settings not being
      // stamped with this account yet refuses the switch as well — writing `captureOn: true` into a
      // file `ensureSettingsOwner` is about to reset would lose the user's click, and reporting it
      // as on while `wouldRun` holds it off would be a lie.
      if (on && (blockers().length > 0 || settingsOwnerPending())) { emit(); return {ok: false, blockers: blockers()}; }
      resumeNoticeDue = false;                // from here on the switch is the user's doing, not a resume
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      resumeAt = null;
      await settings.update({captureOn: on});
      await evaluate();
      return {ok: true};
    },
    async pauseForAnHour() {
      if (stopped) return;
      if (!settings.get().captureOn) return;
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeAt = now() + PAUSE_FOR_MS;
      resumeTimer = setTimeout(() => { resumeAt = null; resumeTimer = null; background(evaluate()); }, PAUSE_FOR_MS);
      await evaluate();
    },
    signIn: (identifier, password) => signedInBy(() => session.signIn(identifier, password)),
    async signInWithGoogle() {
      if (stopped) return {ok: false, code: "UNAUTHORISED"};
      if (!deps.googleSignIn) return {ok: false, code: "OAUTH_BROWSER"};
      const browser = deps.googleSignIn;
      background(log.event("SIGN_IN_GOOGLE_STARTED"));
      const result = await signedInBy(() => browser.start((attemptId) => session.signInWith(() => api.exchangeOAuthAttempt(attemptId))));
      background(log.event("SIGN_IN_GOOGLE_FINISHED", {failures: result.ok ? 0 : 1}));
      return result;
    },
    cancelGoogleSignIn() { deps.googleSignIn?.cancel(); },
    async signOut() { await session.signOut(); await evaluate(); },
    review() {
      const t = taxonomy.current();
      const names = new Map<string, string>([...(t?.skills ?? []).map((s) => [s.id, s.displayName] as const), ...(t?.competencies ?? []).map((c) => [c.id, c.name] as const)]);
      return {
        pending: visiblePending().map((p) => ({...p, targetName: names.get(p.targetId) ?? ""})),
        // Same rule as the pool and the outbox: one account's record, shown to nobody else and to
        // nobody at all while signed out.
        waitingUpload: uploader.waiting(), sent: sentLog.list(session.userId())
      };
    },
    async approve(id) {
      if (stopped) return false;
      if (deciding.has(id)) return false;        // a decision on this statement is already in flight
      deciding.add(id);
      try {
        const item = visiblePending().find((p) => p.id === id);
        if (!item) return false;
        // Into the encrypted outbox first, out of the pool second: a crash in between shows the item again, never loses it.
        try {
          await uploader.enqueue({clientItemId: item.id, statement: item.statement, kind: item.kind, targetId: item.targetId, createdAt: item.createdAt, taxonomyVersion: item.taxonomyVersion, pipelineVersion: item.pipelineVersion});
        } catch {
          // The outbox could not be written. The statement stays pending and the user is told why.
          await raiseStorageProblem("outbox");
          emit();
          return false;
        }
        await clearStorageProblem("outbox");     // the outbox just took a write
        pipeline.resolve(id, "approved");
        await savePool();
        emit();
        return true;
      } finally {
        // Released however this ended — the answer, a refusal, or a disk that said no — so a
        // statement is never left undecidable by a call that failed.
        deciding.delete(id);
      }
    },
    async reject(id) {
      if (stopped) return false;
      if (deciding.has(id)) return false;
      deciding.add(id);
      try {
        if (!visiblePending().some((p) => p.id === id)) return false;
        pipeline.resolve(id, "rejected");
        await savePool();
        emit();
        return true;
      } finally {
        deciding.delete(id);
      }
    },
    /**
     * What the screen may show. Two different maskings, because two different things are wrong.
     * While the file still belongs to ANOTHER ACCOUNT (a reset the disk has not taken yet), the
     * user-owned fields are answered with the DEFAULTS: the settings screen and the IPC `settings`
     * channel must never display one person's exclusions, sites or review time to another. While the
     * file is merely NOT STAMPED with this account yet (an ownerless legacy file, or the turn before
     * `ensureSettingsOwner` finishes), the choices in it are nobody's secret and are shown as they
     * are — but `captureOn` is answered false, because `wouldRun` is holding capture off and a
     * screen that says "on" while nothing is read would be the wrong way round. The install's own
     * facts (the onboarding step, the self-test key) are nobody's private data and stay as they are.
     */
    settings() {
      const current = settings.get();
      if (!settingsOwnerPending()) return current;
      if (!settingsBelongToSomeoneElse()) return {...current, captureOn: false};
      const fresh = defaultSettings();
      return {...current, exclusions: fresh.exclusions, excludedSites: fresh.excludedSites, reviewTime: fresh.reviewTime, captureOn: false};
    },
    settingsOpened() { settings.acknowledgeRecovery(); background(evaluate()); },
    async updateSettings(patch) {
      if (stopped) return {ok: false, problem: "SAVE_FAILED"};
      const safe: Record<string, unknown> = {};
      const raw = (patch ?? {}) as Record<string, unknown>;
      for (const key of USER_SETTINGS_KEYS) if (raw[key] !== undefined) safe[key] = raw[key];
      const result = await settings.update(safe as SettingsPatch);
      await evaluate();
      return result;
    },
    async selfTest() {
      if (deps.downloader.state().kind !== "ready") return {ok: false, code: "MODEL_FAILED"};
      const result = await runSelfTest(model);
      background(log.event(result.ok ? "SELF_TEST_PASSED" : "SELF_TEST_FAILED"));
      if (result.ok) await settings.update({selfTestPassedFor: selfTestKey(deps.appVersion, deps.modelSha256)});
      await evaluate();
      return result;
    },
    async recheckPermission() {
      if (stopped) return permission;
      await refreshPermission();
      return permission;
    },
    retry(problem) {
      if (stopped) return;
      if (problem === "model") model.reset(); else readerProblem = false;
      background(evaluate());
    },
    system(event) {
      if (stopped) return;
      pipeline.signal(event === "locked" || event === "suspend" ? "locked" : "unlocked");
      if (event === "unlocked" || event === "resume") background(checkReview());
    },
    async deleteAllData({removeModel}) {
      // Quiesce first: no tick, no scheduler, no capture, so nothing writes a file back while the
      // files are being deleted.
      stopTimers();
      // Awaited HERE, at the top, and never after the deletion below: the run's tallies belong to
      // the data the user has just asked to be erased, so they are written before the files go and
      // are deleted with them. A line written afterwards would re-create `app.log` — the one file
      // this call empties last — with a record of that run.
      //
      // At the top for a second reason, too: it is what keeps `session.signOut()` below from
      // stopping the loop itself, through the `onChange` listener's UNAWAITED `background(evaluate())`
      // — a write that would then race the removal loop, and be stamped with the blockers of a
      // session that has just ended rather than with the state the run actually ran in.
      await stopLoop();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      resumeAt = null;
      model.shutdown();
      const previous = pipeline;
      previous.signal("captureOff");
      pipeline = newPipeline();                   // the old buffer, queue and pool are unreachable from here on
      await saving;
      poolOwner = null;
      await session.signOut();
      await taxonomy.clear();
      await uploader.clear();
      await pool.clear();
      await settings.reset();
      readerProblem = false;
      storageProblems.clear();
      savedPool = poolSnapshot();
      // The last event before the files go. `app.log` is the last one deleted, so nothing written
      // here survives, and nothing is written after the folder is empty.
      await log.event("DATA_DELETED");
      for (const path of deletablePaths(paths)) await fs.remove(path);
      await sentLog.load();
      if (removeModel) await deps.downloader.removeAll();
      pipeline.configure(config());
      startTimers();
      await evaluate();
    },
    async quit() {
      deps.googleSignIn?.cancel();                          // a browser wait must not outlive the app
      if (stopped) return;
      stopped = true;
      stopTimers();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      for (const stop of [stopBroken, stopDownload, stopSession, stopTaxonomy, stopSettings]) stop();
      stopPower.stop();
      // Awaited, not backgrounded: quitting is the commonest way a run ends, and an unawaited write
      // here would lose the run's tallies to the process exiting. It goes in the drain the quit
      // already does for the pool, so it costs the same wait rather than a new one.
      const written = stopLoop();
      pipeline.signal("captureOff");
      let drain: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([pipeline.whenIdle(), new Promise<void>((resolve) => { drain = setTimeout(resolve, QUIT_DRAIN_MS); })]);
      if (drain) clearTimeout(drain);             // whenIdle won: the drain must not hold the process open
      await written;
      await savePool();
      listeners.clear();
      model.shutdown();
      await reader.dispose().catch(() => undefined);
    }
  };
}
