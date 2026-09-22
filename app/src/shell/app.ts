import {execFile, spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {pathToFileURL} from "node:url";
import {app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, Tray, utilityProcess} from "electron";
import {createEngine, type Engine, type EngineStatus} from "../main/engine";
import {createIpcRouter} from "../main/ipcRouter";
import {createModelClient} from "../main/model/client";
import {createDownloader, PINNED_MODEL, type Downloader} from "../main/model/download";
import {createNodeDownloadDisk, createNodeHttp} from "../main/model/nodeDownload";
import {parseTaxonomy, type ClaveApi} from "../main/ports/claveApi";
import {parseFrontWindow, type Reader} from "../main/ports/reader";
import {systemLocalTime} from "../main/review/scheduler";
import {createNodeFs} from "../main/storage/nodeFs";
import {dataPaths} from "../main/storage/paths";
import {COPY} from "../renderer/copy";
import {INVOKE_CHANNELS, eventName, invokeName} from "../shared/ipc";
import {createDevReader, windowsFromFixture} from "../standins/devReader";
import {createReadyDownloader} from "../standins/readyDownloader";
import {createSmokeCipher} from "../standins/smokeCipher";
import {createStubApi} from "../standins/stubApi";
import {createPowerSource, createSafeStorageCipher, createUtilityHostLink} from "./adapters";
import {watchBattery} from "./batteryLevel";
import {devEnv} from "./devEnv";
import {background, startFailureCode} from "./lifecycle";
import {chooseHelperPath, createRealReader} from "./realReader";
import {runSmoke} from "./smoke";
import {trayKey, trayState} from "./trayState";
import {samePage} from "./trust";

const APP_NAME = COPY.appName;                        // also a built-in exclusion of the core: the app never reads itself
const WINDOW = {width: 420, height: 600};
/** No `persist:` prefix, so the window's session lives in memory only and leaves nothing behind. */
const WINDOW_PARTITION = "clave-window";
const DEFAULT_MODEL_URL = "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const here = (file: string) => join(__dirname, file);
/** The one URL this app ever loads. Computed once, so an IPC sender can be compared against it exactly. */
const RENDERER_URL = pathToFileURL(here("renderer/index.html")).toString();

/**
 * Every environment switch is a development switch and `devEnv` hands back nothing at all once the
 * app is packaged, so a packaged build cannot be talked into stand-ins, a scripted model, a
 * different data folder or a different model URL by whoever started it.
 *
 * Until sub-projects C (native reader) and D (clave-back) exist the app can only run with the
 * stand-ins. `createEngine` refuses stand-ins when `production` as well.
 */
const DEV = !app.isPackaged;
const ENV = devEnv(process.env, !DEV);
const STANDINS = ENV.CLAVE_STANDINS === "1";
const SCRIPTED_MODEL = STANDINS && ENV.CLAVE_SCRIPTED_MODEL === "1";
const SMOKE = STANDINS && ENV.CLAVE_SMOKE === "1";
/** The native reader (sub-project C) beside the stand-in backend. Never in the unattended smoke run, which must not need a permission. */
const REAL_READER = STANDINS && !SMOKE && ENV.CLAVE_REAL_READER === "1";
const MODEL_URL = ENV.CLAVE_MODEL_URL ?? DEFAULT_MODEL_URL;

/** How long `before-quit` waits for the engine to save its pool before quitting anyway. */
const QUIT_HARD_MS = 10_000;

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let engine: Engine | null = null;
let quitting = false;
/**
 * True once `start()` has put the window up. Until then there is no window, no engine and no IPC
 * handler, so a second instance must not be given a page to load: it would come up against nothing
 * and every call from it would fail. It only records that somebody asked.
 */
let started = false;
let showRequested = false;
/** What the tray is currently showing, so a status emit that changed nothing does not rebuild a menu. */
let trayShowing: string | null = null;
/** Set up in `start()`, run once on quit: the battery poll and the router's subscription. */
const teardown: Array<() => void> = [];
/**
 * Notifications that macOS still has on screen. A `Notification` that is only a local variable can
 * be collected while it is still showing, and its click handler goes with it, so each one is held
 * until it is closed, clicked or refused.
 */
const liveNotifications = new Set<Notification>();

function runTeardown(): void {
  while (teardown.length > 0) {
    const stop = teardown.pop();
    try { stop?.(); } catch { /* quitting: there is nobody left to tell */ }
  }
}

function notify(body: string, options: {silent?: boolean; onClick?: () => void} = {}): void {
  const note = new Notification({title: APP_NAME, body, silent: options.silent ?? false});
  liveNotifications.add(note);
  const forget = () => { liveNotifications.delete(note); };
  note.on("close", forget);
  note.on("failed", forget);
  note.on("click", () => { forget(); options.onClick?.(); });
  note.show();
}

function standIns(dataDir: string): {reader: Reader; api: ClaveApi} {
  const fixturesDir = ENV.CLAVE_FIXTURES ?? join(app.getAppPath(), "..", "eval", "fixtures");
  const fixture = JSON.parse(readFileSync(join(fixturesDir, "01-work-english.json"), "utf8")) as unknown;
  const taxonomy = parseTaxonomy(JSON.parse(readFileSync(here("standins-taxonomy.json"), "utf8")));
  if (!taxonomy) throw new Error("STANDIN_TAXONOMY_INVALID");
  return {
    reader: createDevReader(windowsFromFixture(fixture), 1_500),
    api: createStubApi({fs: createNodeFs(), uploadsPath: join(dataDir, "stub-uploads.jsonl"), taxonomy, now: () => Date.now()})
  };
}

let sessionHardened = false;
/**
 * The window gets its own in-memory session, not the default one the rest of the process shares,
 * and every way out of it is shut on that session: nothing may be asked for (no camera, no
 * clipboard, no notifications, no USB or serial device), and no request may leave the machine. The
 * page's CSP says the same thing again from inside.
 */
function rendererSession(): Electron.Session {
  const ses = session.fromPartition(WINDOW_PARTITION);
  if (sessionHardened) return ses;
  sessionHardened = true;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, respond) => {
    respond({cancel: !(details.url.startsWith("file://") || details.url.startsWith("devtools://"))});
  });
  return ses;
}

function showWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  rendererSession();
  window = new BrowserWindow({
    ...WINDOW, resizable: false, fullscreenable: false, show: false, title: APP_NAME,
    webPreferences: {
      preload: here("preload.cjs"), partition: WINDOW_PARTITION, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: DEV
    }
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    // Hiding instead of closing is only right while there is still a tray and an engine to come back
    // to. Once we are quitting, or once the engine is gone, a close closes: an app that answers
    // every attempt to shut it by hiding a window is an app the user cannot get rid of.
    if (!quitting && engine !== null) { event.preventDefault(); window?.hide(); }
  });
  // loadURL, not loadFile, so the URL the frame reports is the exact string we compared against.
  background(window.loadURL(RENDERER_URL));
}

const TRAY_TITLE: Record<"on" | "off" | "problem", string> = {on: "●", off: "○", problem: "!"};

function refreshTray(status: EngineStatus): void {
  if (!tray || !engine) return;
  // Every status change arrives here; only some of them change anything the tray shows.
  const key = trayKey(status);
  if (key === trayShowing) return;
  trayShowing = key;
  const current = engine;
  tray.setTitle(TRAY_TITLE[trayState(status)] + (status.pending > 0 ? ` ${status.pending}` : ""));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: status.capture === "on" ? (status.nothingRead ? COPY.tray.onNothing : COPY.tray.on) : COPY.tray.off,
      type: "checkbox", checked: status.capture === "on",
      click: () => { background(current.setCapture(status.capture !== "on").then((result) => { if (!result.ok) showWindow(); })); }},
    {label: COPY.tray.review(status.pending), click: showWindow},
    {label: COPY.tray.pause, enabled: status.capture === "on", click: () => { background(current.pauseForAnHour()); }},
    {type: "separator"},
    {label: COPY.tray.settings, click: showWindow},
    {label: COPY.tray.quit, click: () => app.quit()}
  ]));
}

/**
 * Our own window, showing our own page, and nothing else. A frame that has gone fails closed. The
 * page's own fragment and query do not change which document it is (`samePage`), so in-page routing
 * keeps working while any other file is still refused.
 */
function trustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  try {
    const frame = event.senderFrame;
    return frame !== null && samePage(frame.url, RENDERER_URL);
  } catch { return false; }
}

async function start(): Promise<void> {
  if (process.platform === "darwin") app.dock?.hide();
  const dataDir = ENV.CLAVE_DATA_DIR ?? app.getPath("userData");
  const paths = dataPaths(dataDir);
  if (!STANDINS) throw new Error("NO_READER_YET");      // sub-projects C and D replace the stand-ins; nothing else can run

  const stand = standIns(dataDir);
  const api = stand.api;
  // The helper is a plain child of this process, inside the same bundle: that is what lets the Screen
  // Recording grant given to the app reach it (phase 0, P1).
  const real = REAL_READER
    ? createRealReader({helperPath: chooseHelperPath([join(dirname(process.execPath), "clave-reader"), here("native/clave-reader")], existsSync), exists: existsSync, spawnChild: (path) => spawn(path, [], {stdio: ["pipe", "pipe", "pipe"]}), now: () => Date.now()})
    : null;
  if (real) void stand.reader.dispose();
  const reader: Reader = real ? real.reader : stand.reader;
  const downloader: Downloader = SCRIPTED_MODEL
    ? createReadyDownloader()
    : createDownloader({http: createNodeHttp(), disk: createNodeDownloadDisk(), dir: paths.modelDir, spec: {...PINNED_MODEL, url: MODEL_URL}});

  const model = createModelClient({
    now: () => Date.now(),
    // `filePath()` is read when the host is spawned, not now: the model is only ever loaded once the
    // download says `ready`, and the engine will not extract before that.
    spawn: () => createUtilityHostLink(() => utilityProcess.fork(here("model-host.mjs"), [SCRIPTED_MODEL ? "scripted" : downloader.filePath()], {serviceName: "Clave model"}))
  });

  const battery = watchBattery(() => new Promise((resolve, reject) => execFile("/usr/bin/pmset", ["-g", "batt"], (error, stdout) => (error ? reject(error) : resolve(stdout)))));
  teardown.push(() => battery.stop());
  /**
   * The last app in front that was not this one, for Settings' "Exclude <app>" button — the user
   * cannot name an app they have just switched away from unless somebody remembered it.
   *
   * It is deliberately independent of whether reading is on: reading being off does not mean the
   * helper is idle, and this subscription is what keeps that true. Only the app NAME is kept here,
   * never a window title and never any recognised text, and only until the next foreign app comes
   * forward; the helper for its part forgets a window's recognised text after 60 s with nothing
   * asked of it. The unsubscribe goes onto `teardown` so the callback cannot outlive the app and
   * hold a disposed reader alive.
   */
  let recentApp: string | null = null;
  const unwatchFocus = reader.onFocusChange(() => { background(reader.frontWindow().then((front) => { const w = parseFrontWindow(front); if (w && w.app !== APP_NAME) recentApp = w.app; })); });
  teardown.push(unwatchFocus);

  engine = await createEngine({
    reader, api, model, downloader, fs: createNodeFs(), cipher: SMOKE ? createSmokeCipher() : createSafeStorageCipher(safeStorage), dataDir,
    power: createPowerSource(powerMonitor, battery),
    // An unattended smoke run has nobody at the keyboard; without this the loop would (correctly) treat the user as away and read nothing.
    idleSeconds: () => (SMOKE ? 0 : powerMonitor.getSystemIdleTime()),
    now: () => Date.now(), local: systemLocalTime, newId: () => randomUUID(),
    appVersion: app.getVersion(), modelSha256: SCRIPTED_MODEL ? "scripted" : PINNED_MODEL.sha256, production: app.isPackaged,
    notifyReview: (count) => notify(COPY.notify.review(count), {onClick: showWindow}),
    notifyCaptureResumed: () => notify(COPY.notify.resumed, {silent: true})
  });
  const current = engine;
  real?.attach(current);

  const router = createIpcRouter({
    engine: current, downloader, reader, recentApp: () => recentApp,
    appInfo: {version: app.getVersion(), modelSha256: PINNED_MODEL.sha256, modelSizeBytes: PINNED_MODEL.sizeBytes, standIns: STANDINS},
    openWhatLeaves: async () => { await shell.openPath(here("WHAT-LEAVES.md")); },
    restartApp: () => { app.relaunch(); app.quit(); }
  });
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(invokeName(channel), (event, ...args: unknown[]) => {
      if (!trustedSender(event)) throw new Error("BAD_SENDER");
      return router.handle(channel, args);
    });
  }
  teardown.push(router.subscribe((channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send(eventName(channel), payload); }));

  powerMonitor.on("lock-screen", () => current.system("locked"));
  powerMonitor.on("unlock-screen", () => current.system("unlocked"));
  powerMonitor.on("suspend", () => current.system("suspend"));
  powerMonitor.on("resume", () => current.system("resume"));

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip(APP_NAME);
  current.onStatus(refreshTray);
  refreshTray(current.status());
  showWindow();
  started = true;
  // Somebody launched the app again while this was still going on. The window is up now, so give
  // them what they asked for; the flag existed so that the attempt did not create a window over a
  // process with no IPC handlers in it yet.
  if (showRequested) { showRequested = false; showWindow(); }

  // Looking at the model file can mean hashing 2.7 GB, so launch does not wait for it: the tray, the
  // window and the engine are all up first. Until it answers, the blocker is MODEL_MISSING, and the
  // engine is already listening to `downloader.onChange` for the answer.
  background(downloader.inspect());

  if (SMOKE) {
    const result = await runSmoke({engine: current, router, window: () => window, uploadsPath: join(dataDir, "stub-uploads.jsonl")});
    process.stdout.write(`${result}\n`);
    quitting = true;
    await current.quit();
    runTeardown();
    app.exit(result === "SMOKE OK" ? 0 : 1);
  }
}

app.setName(APP_NAME);                                // before the lock, so both instances agree on who they are
if (!app.requestSingleInstanceLock()) app.quit();     // two instances would mean two sixty-minute buffers
else {
  app.on("second-instance", () => { if (started) showWindow(); else showRequested = true; });
  app.on("window-all-closed", () => { /* the tray keeps the app alive */ });
  // Every webContents this process ever makes, ours included: no new window, no navigation away
  // from the page it was given, no webview.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({action: "deny"}));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;                                  // set on every path, so nothing can hold the app open twice
    const current = engine;
    if (!current) { runTeardown(); return; }
    event.preventDefault();                           // the pool is saved first; the second before-quit goes straight through
    // The pool is worth waiting for, but not for ever: an engine stuck inside `quit()` would leave
    // an app the user cannot get rid of, which is the worse failure. QUIT_HARD_MS is the cap, and
    // the timer is cleared the moment `quit()` wins so it cannot hold the process open by itself.
    let hard: ReturnType<typeof setTimeout> | null = null;
    const capped = Promise.race([current.quit(), new Promise<void>((resolve) => { hard = setTimeout(resolve, QUIT_HARD_MS); })]);
    background(capped.finally(() => { if (hard) clearTimeout(hard); runTeardown(); app.quit(); }));
  });
  background(app.whenReady().then(start).catch((error: unknown) => {
    process.stderr.write(`START_FAILED ${startFailureCode(error)}\n`);
    app.exit(1);
  }));
}
