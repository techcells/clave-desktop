import {useCallback, useEffect, useRef, useState} from "react";
import type {AppInfo, ClaveBridge, DownloadState, EngineStatus, UserSettings} from "../shared/ipc";

declare global { interface Window { clave: ClaveBridge } }

/**
 * The only way out of this window. Every method reads `window.clave` at CALL time instead of
 * capturing it when this module is evaluated: the preload installs the bridge before the bundle
 * runs, but the dev preview installs a stand-in, and a captured reference would freeze whichever of
 * the two happened to exist first. Writing the twenty-three methods out by hand (rather than a
 * Proxy) keeps `ClaveBridge` checking both sides: a method that loses its channel stops typecheck.
 */
const to = (): ClaveBridge => window.clave;

export const clave: ClaveBridge = {
  status: () => to().status(),
  review: () => to().review(),
  approve: (id) => to().approve(id),
  reject: (id) => to().reject(id),
  setCapture: (on) => to().setCapture(on),
  pauseForAnHour: () => to().pauseForAnHour(),
  signIn: (identifier, password) => to().signIn(identifier, password),
  signInWithGoogle: () => to().signInWithGoogle(),
  cancelGoogleSignIn: () => to().cancelGoogleSignIn(),
  signOut: () => to().signOut(),
  settings: () => to().settings(),
  settingsOpened: () => to().settingsOpened(),
  updateSettings: (patch) => to().updateSettings(patch),
  selfTest: () => to().selfTest(),
  recheckPermission: () => to().recheckPermission(),
  requestPermission: () => to().requestPermission(),
  retry: (problem) => to().retry(problem),
  deleteAllData: (opts) => to().deleteAllData(opts),
  downloadState: () => to().downloadState(),
  downloadStart: () => to().downloadStart(),
  downloadPause: () => to().downloadPause(),
  recentApp: () => to().recentApp(),
  appInfo: () => to().appInfo(),
  openWhatLeaves: () => to().openWhatLeaves(),
  openLicences: () => to().openLicences(),
  restartApp: () => to().restartApp(),
  extension: (action) => to().extension(action),
  onStatus: (cb) => to().onStatus(cb),
  onDownload: (cb) => to().onDownload(cb)
};

/**
 * What a screen is handed for one thing main can answer: the value (`null` until the first answer),
 * a way to ask again, and whether the LAST attempt was refused. The third element is the difference
 * between "not yet" and "not going to happen": a rejected IPC call used to be swallowed here, which
 * left every screen waiting on a `null` forever and the window blank with nothing to press.
 */
export type Asked<T> = [T | null, () => void, boolean];

/**
 * One push channel plus one fetch, in one shape.
 *
 * The two are SEPARATE effects on purpose. The subscription is opened once and kept for the life of
 * the component; only the fetch re-runs when `refresh` is called. Doing both in one effect meant
 * every re-read tore the IPC listener down and added it back — a gap in which a pushed change is
 * lost, and (for a poll that re-reads on a timer) a channel that is unsubscribed and resubscribed
 * several times a second. React runs effects in declaration order, so the channel is still open
 * BEFORE the first fetch is sent, which is what stops a change landing in the gap between them.
 *
 * `pushed` is a ref rather than a local, because it has to be shared between the two effects; it is
 * reset at the start of each fetch, so it means "a push arrived after THIS fetch was sent" and a
 * late answer can never overwrite a newer pushed value. `live` drops everything that arrives after
 * unmount, because a resolved promise does not know the window moved on.
 */
function usePushed<T>(
  subscribe: (cb: (value: T) => void) => () => void,
  fetch: () => Promise<T>
): Asked<T> {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pushed = useRef(false);
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);

  useEffect(() => {
    let live = true;
    const off = subscribe((next) => {
      if (!live) return;
      pushed.current = true;
      setFailed(false);
      setValue(next);
    });
    return () => { live = false; off(); };
    // `subscribe` is the module-level bridge method above: stable for the page's lifetime, so this
    // effect runs exactly once and the listener outlives every refresh.
  }, [subscribe]);

  useEffect(() => {
    let live = true;
    pushed.current = false;
    void fetch().then(
      (next) => { if (live && !pushed.current) { setFailed(false); setValue(next); } },
      () => { if (live) setFailed(true); }
    );
    return () => { live = false; };
  }, [nonce, fetch]);

  return [value, refresh, failed];
}

/** The engine's status, pushed. `null` until the first answer arrives. */
export const useStatus = (): Asked<EngineStatus> => usePushed<EngineStatus>(clave.onStatus, clave.status);

/** The model download's state, pushed. `null` until the first answer arrives. */
export const useDownload = (): Asked<DownloadState> => usePushed<DownloadState>(clave.onDownload, clave.downloadState);

/** Something the main process only answers when asked: settings, `appInfo`, the review list. */
export function useAsked<T>(fetch: () => Promise<T>): Asked<T> {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);
  useEffect(() => {
    let live = true;
    void fetch().then(
      (next) => { if (live) { setFailed(false); setValue(next); } },
      () => { if (live) setFailed(true); }
    );
    return () => { live = false; };
  }, [nonce, fetch]);
  return [value, refresh, failed];
}

export const useSettings = (): Asked<UserSettings> => useAsked<UserSettings>(clave.settings);
export const useAppInfo = (): Asked<AppInfo> => useAsked<AppInfo>(clave.appInfo);
