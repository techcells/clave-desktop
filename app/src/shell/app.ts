import {execFile, spawn} from "node:child_process";
import {randomBytes, randomUUID} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {pathToFileURL} from "node:url";
import {app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, Tray, utilityProcess} from "electron";
import {createGoogleSignIn} from "../main/account/googleSignIn";
import {createHttpApi} from "../main/api/httpApi";
import {OAUTH_TIMEOUT_MS} from "../main/constants";
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
import {FLAVOUR} from "../shared/flavour";
import {createDevReader, windowsFromFixture} from "../standins/devReader";
import {createReadyDownloader} from "../standins/readyDownloader";
import {createSmokeCipher} from "../standins/smokeCipher";
import {createStubApi} from "../standins/stubApi";
import {createPowerSource, createSafeStorageCipher, createUtilityHostLink} from "./adapters";
import {APP_IDS} from "./appId";
import {watchBattery} from "./batteryLevel";
import {devEnv} from "./devEnv";
import {resolveApiUrl} from "./apiUrl";
import {launchMode} from "./launchMode";
import {createLoopbackListener} from "./loopbackListener";
import {openLicences} from "./licences";
import {background, startFailureCode} from "./lifecycle";
import {isTranslocatedPath} from "./translocation";
import {chooseHelperPath, createRealReader} from "./realReader";
import {runSmoke} from "./smoke";
import {trayKey, trayState} from "./trayState";
import {samePage} from "./trust";

const APP_NAME = COPY.appName;                        // also a built-in exclusion of the core: the app never reads itself
/**
 * The size of the PAGE, not of the window frame: `.window` in styles.css is laid out at exactly
 * 420 x 600, and without `useContentSize` Electron takes these as the outer size, so the macOS
 * title bar came out of the page and the bottom 28px — the tab row — were cut off.
 */
const WINDOW = {width: 420, height: 600, useContentSize: true};
/** No `persist:` prefix, so the window's session lives in memory only and leaves nothing behind. */
const WINDOW_PARTITION = "clave-window";
const DEFAULT_MODEL_URL = "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const here = (file: string) => join(__dirname, file);
const HELPER_NAME = process.platform === "win32" ? "clave-reader.exe" : "clave-reader";
/** The one URL this app ever loads. Computed once, so an IPC sender can be compared against it exactly. */
const RENDERER_URL = pathToFileURL(here("renderer/index.html")).toString();

/**
 * Every environment switch is a development switch and `devEnv` hands back nothing at all once the
 * app is packaged, so a packaged build cannot be talked into stand-ins, a scripted model, a
 * different data folder or a different model URL by whoever started it. What a packaged build runs
 * with is decided by the flavour baked in at build time (`launchMode`): `internal` keeps the stub
 * backend beside the real reader and model; `release` runs the real clave-back client, reader and
 * model. `createEngine` refuses stand-ins when `production` as well.
 */
const DEV = !app.isPackaged;
const ENV = devEnv(process.env, !DEV);
const MODE = launchMode({packaged: app.isPackaged, flavour: FLAVOUR, env: ENV});
const STANDINS = MODE.standIns;
const SCRIPTED_MODEL = MODE.scriptedModel;
const SMOKE = MODE.smoke;
const REAL_READER = MODE.realReader;
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

function standInApi(dataDir: string): ClaveApi {
  const taxonomy = parseTaxonomy(JSON.parse(readFileSync(here("standins-taxonomy.json"), "utf8")));
  if (!taxonomy) throw new Error("STANDIN_TAXONOMY_INVALID");
  return createStubApi({fs: createNodeFs(), uploadsPath: join(dataDir, "stub-uploads.jsonl"), taxonomy, now: () => Date.now()});
}

/** The scripted screens of the dev reader. Only ever read when the dev reader is the reader: no fake screen text is opened, let alone shipped, beside the real one. */
function standInReader(): Reader {
  const fixturesDir = ENV.CLAVE_FIXTURES ?? join(app.getAppPath(), "..", "eval", "fixtures");
  const fixture = JSON.parse(readFileSync(join(fixturesDir, "01-work-english.json"), "utf8")) as unknown;
  return createDevReader(windowsFromFixture(fixture), 1_500);
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
  // macOS keeps the application menu in the menu bar; everywhere else Electron's default File/Edit/
  // View/Window menu is drawn inside the window, above a page laid out at exactly 420 x 600.
  if (process.platform !== "darwin") window.setMenu(null);
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
  const title = TRAY_TITLE[trayState(status)] + (status.pending > 0 ? ` ${status.pending}` : "");
  // Only macOS draws a tray title; elsewhere the same few characters go into the hover text.
  if (process.platform === "darwin") tray.setTitle(title);
  else tray.setToolTip(`${APP_NAME} ${title}`);
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
  // Which clave-back, decided before anything is built: a switch that is set but wrong refuses the launch rather than picking a server.
  const apiUrl = resolveApiUrl({packaged: app.isPackaged, switchValue: ENV.CLAVE_API_URL});
  if (!apiUrl.ok) throw new Error(apiUrl.code);
  if (MODE.refuse) throw new Error(MODE.refuse);         // the reader sub-project decides when a build without stand-ins may run
  const api: ClaveApi = MODE.realApi ? createHttpApi({baseUrl: apiUrl.url}) : standInApi(dataDir);
  // The browser sign-in exists only where there is a real backend to send the browser to.
  const googleSignIn = MODE.realApi
    ? createGoogleSignIn({baseUrl: apiUrl.url, listen: createLoopbackListener, openExternal: (url) => shell.openExternal(url), randomState: () => randomBytes(32).toString("base64url"), timeoutMs: OAUTH_TIMEOUT_MS})
    : undefined;
  // The helper is a plain child of this process, inside the same bundle: that is what lets the Screen
  // Recording grant given to the app reach it (phase 0, P1).
  const real = REAL_READER
    ? createRealReader({helperPath: chooseHelperPath([join(dirname(process.execPath), HELPER_NAME), here(`native/${HELPER_NAME}`)], existsSync), exists: existsSync, spawnChild: (path) => spawn(path, [], {stdio: ["pipe", "pipe", "pipe"]}), now: () => Date.now()})
    : null;
  const reader: Reader = real ? real.reader : standInReader();
  // Running from macOS's quarantine copy: a grant given here would belong to a path nobody can find
  // again, so the window says "move to Applications" and the permission request is a no-op until
  // the app has been moved and reopened. The engine keeps its reader; only the renderer's ask is cut.
  const translocated = isTranslocatedPath(process.execPath);
  const downloader: Downloader = SCRIPTED_MODEL
    ? createReadyDownloader()
    : createDownloader({http: createNodeHttp(), disk: createNodeDownloadDisk(), dir: paths.modelDir, spec: {...PINNED_MODEL, url: MODEL_URL}});

  const model = createModelClient({
    now: () => Date.now(),
    // `filePath()` is read when the host is spawned, not now: the model is only ever loaded once the
    // download says `ready`, and the engine will not extract before that.
    spawn: () => createUtilityHostLink(() => utilityProcess.fork(here("model-host.mjs"), [SCRIPTED_MODEL ? "scripted" : downloader.filePath()], {serviceName: "Clave model"}))
  });

  // Windows has no pmset; WMI's charge figure is printed as "NN%" so the same parser reads it. A
  // desktop with no battery prints a bare "%", which parses as no battery.
  const batteryCommand: [string, string[]] = process.platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[string](Get-CimInstance Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining + [char]37"]]
    : ["/usr/bin/pmset", ["-g", "batt"]];
  const battery = watchBattery(() => new Promise((resolve, reject) => execFile(batteryCommand[0], batteryCommand[1], {windowsHide: true}, (error, stdout) => (error ? reject(error) : resolve(stdout)))));
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
    appVersion: app.getVersion(), modelSha256: SCRIPTED_MODEL ? "scripted" : PINNED_MODEL.sha256, production: MODE.production,
    // Unpackaged, this process is Electron's own executable, and the window list names it "Electron"
    // (on Windows from its version resource). A packaged build carries the flavour's name instead.
    otherSelfNames: app.isPackaged ? [] : ["Electron"],
    notifyReview: (count) => notify(COPY.notify.review(count), {onClick: showWindow}),
    notifyCaptureResumed: () => notify(COPY.notify.resumed, {silent: true}),
    ...(googleSignIn ? {googleSignIn} : {})
  });
  const current = engine;
  real?.attach(current);

  const router = createIpcRouter({
    engine: current, downloader, reader: translocated ? {requestPermission: async () => undefined} : reader, recentApp: () => recentApp,
    appInfo: {version: app.getVersion(), modelSha256: PINNED_MODEL.sha256, modelSizeBytes: PINNED_MODEL.sizeBytes, standIns: STANDINS, translocated, googleSignIn: MODE.realApi, platform: process.platform === "win32" ? "windows" : "mac"},
    openWhatLeaves: async () => { await shell.openPath(here("WHAT-LEAVES.md")); },
    openLicences: () => openLicences({path: here("THIRD-PARTY-LICENSES.txt"), exists: existsSync, open: async (path) => { await shell.openPath(path); }}),
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

  // macOS shows the tray as its title alone; Windows shows only an image, so it gets the app icon.
  tray = new Tray(process.platform === "darwin" ? nativeImage.createEmpty() : nativeImage.createFromPath(here("tray.png")).resize({width: 32, height: 32}));
  tray.setToolTip(APP_NAME);
  // A Windows tray icon is clicked, not opened like a menu-bar item: a left click brings the window up.
  if (process.platform !== "darwin") tray.on("click", showWindow);
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
// Windows files the taskbar entry and every notification under this id; without it the review
// notification is shown under a generic Electron id, or not at all (see appId.ts).
if (process.platform === "win32") app.setAppUserModelId(APP_IDS[FLAVOUR]);
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
