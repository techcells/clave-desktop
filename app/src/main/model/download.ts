import {DOWNLOAD_FREE_SPACE_MARGIN_BYTES, DOWNLOAD_PROGRESS_STEP_BYTES} from "../constants";

export interface ModelSpec { url: string; fileName: string; sha256: string; sizeBytes: number }

/**
 * The pinned model: unsloth's Qwen3.5-4B Q4_K_M, the file spike S1 ran (hash and size measured from
 * that file on 2026-09-17). The URL is configuration; the hash and size are not.
 */
export const PINNED_MODEL: Omit<ModelSpec, "url"> = {
  fileName: "Qwen3.5-4B-Q4_K_M.gguf",
  sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
  sizeBytes: 2_740_937_888
};

export interface HttpResponse {
  /** 200 = whole file from the start, 206 = the requested range, anything else is a failure. */
  status: number;
  body: AsyncIterable<Uint8Array>;
}
export interface Http { get(url: string, opts: {rangeStart: number; signal: AbortSignal}): Promise<HttpResponse> }

export interface DownloadDisk {
  size(path: string): Promise<number>;
  /** Last-modified time in ms, `0` when there is no such file. Part of the verified marker. */
  mtimeMs(path: string): Promise<number>;
  append(path: string, chunk: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  sha256(path: string): Promise<string>;
  freeBytes(dir: string): Promise<number>;
  /** For the verified marker only. Tiny files; never the model itself. */
  writeText(path: string, text: string): Promise<void>;
  /** `null` when there is no such file. Never throws for a missing one. */
  readText(path: string): Promise<string | null>;
}

export type DownloadErrorCode = "DOWNLOAD_NO_SPACE" | "DOWNLOAD_FAILED" | "DOWNLOAD_BAD_HASH";
export type DownloadState =
  | {kind: "missing"} | {kind: "partial"; receivedBytes: number} | {kind: "downloading"; receivedBytes: number}
  | {kind: "verifying"} | {kind: "ready"} | {kind: "error"; code: DownloadErrorCode};

export interface Downloader {
  state(): DownloadState;
  /**
   * Looks at the disk: a verified file is `ready`, a `.part` file is `partial`. An existing file is
   * hashed unless its own marker still vouches for it (same size, same mtime, the pinned hash).
   * Mutually exclusive with `start()`: whichever is called first holds the other off.
   */
  inspect(): Promise<DownloadState>;
  /**
   * Starts or resumes. Resolves when the download stops for any reason; read `state()` for the
   * outcome. A call that lands while `inspect()` is still looking at the disk does nothing.
   */
  start(): Promise<void>;
  pause(): void;
  /** Path of the verified file. Only meaningful in state `ready`. */
  filePath(): string;
  removeAll(): Promise<void>;
  onChange(cb: (state: DownloadState) => void): () => void;
}

/**
 * Resumable download with a pinned hash. A file that has not been verified is never exposed:
 * bytes go to `<name>.part` and the file only gets its real name after the hash matched.
 */
export function createDownloader(deps: {http: Http; disk: DownloadDisk; dir: string; spec: ModelSpec}): Downloader {
  const {http, disk, dir, spec} = deps;
  const finalPath = `${dir}/${spec.fileName}`;
  const partPath = `${finalPath}.part`;
  const markerPath = `${finalPath}.verified`;
  let state: DownloadState = {kind: "missing"};
  let abort: AbortController | null = null;
  let starting: Promise<void> | null = null;
  const listeners = new Set<(state: DownloadState) => void>();
  const set = (next: DownloadState) => { state = next; for (const cb of listeners) cb(next); };

  async function verify(path: string): Promise<boolean> {
    set({kind: "verifying"});
    return (await disk.sha256(path)) === spec.sha256;
  }

  /**
   * What a passed verification is remembered by, so that hashing 2.7 GB is a one-off and not part of
   * every launch. It is trusted only for the exact size and mtime that were hashed and only against
   * the hash pinned in THIS build, so a re-pinned model, a half-overwritten file, a re-download or a
   * disk repair all lead back to the hash.
   *
   * What it does NOT do is notice a file that was changed and then had its size and mtime put back:
   * anybody able to do that can write this marker too (it sits next to the model, in the app's own
   * folder), so the marker is a cache against accidents, not a defence against tampering. That is
   * acceptable because it is not the only check: the model is loaded in a separate process with no
   * access to the account or the pool, the file only ever arrives over the pinned URL, and the hash
   * is checked in full for every file the app itself downloads before it is given its real name.
   *
   * Writing the marker is best-effort — one that cannot be written costs one hash at the next launch
   * and nothing else, so it must not fail a good download.
   */
  async function writeMarker(): Promise<void> {
    try { await disk.writeText(markerPath, JSON.stringify({sizeBytes: await disk.size(finalPath), mtimeMs: await disk.mtimeMs(finalPath), sha256: spec.sha256})); }
    catch { /* a cache, not the file */ }
  }

  async function markerVouchesFor(sizeBytes: number): Promise<boolean> {
    try {
      const text = await disk.readText(markerPath);
      if (text === null) return false;
      const marker = JSON.parse(text) as {sizeBytes?: unknown; mtimeMs?: unknown; sha256?: unknown};
      return marker.sha256 === spec.sha256 && marker.sizeBytes === sizeBytes && marker.mtimeMs === await disk.mtimeMs(finalPath);
    } catch { return false; }        // unreadable or not JSON: no worse than having no marker at all
  }

  /**
   * The part file is as long as the model should be: check it and, if it is the model, hand it over.
   * A part file that is LONGER than the model is a resume that went wrong (a server that answered a
   * range from the wrong offset, an interrupted retry): it is thrown away and the download starts
   * again from zero — once, so a server that keeps over-serving settles on a failure instead of looping.
   */
  async function finishPart(mayRestart: boolean): Promise<void> {
    // Cheap check first: a size mismatch is a settled failure without paying for a hash of the whole file.
    const size = await disk.size(partPath);
    if (size !== spec.sizeBytes) {
      await disk.remove(partPath);
      if (size > spec.sizeBytes && mayRestart) { await download(false); return; }
      set({kind: "error", code: "DOWNLOAD_BAD_HASH"});
      return;
    }
    if (!(await verify(partPath))) { await disk.remove(partPath); set({kind: "error", code: "DOWNLOAD_BAD_HASH"}); return; }
    await disk.rename(partPath, finalPath);
    await writeMarker();
    set({kind: "ready"});
  }

  /** `start()` is called without being awaited (a background download), so a rejection here would
   *  have nowhere to go. Every outcome, including a disk that throws outside the download loop's own
   *  guard, becomes a state instead. */
  async function run(): Promise<void> {
    try { await download(); }
    catch { abort = null; set({kind: "error", code: "DOWNLOAD_FAILED"}); }
  }

  /**
   * The disk look behind `inspect()`, without the lock, so that `inspect()` itself is nothing but
   * the lock plus this.
   */
  async function inspectDisk(): Promise<void> {
    const size = await disk.size(finalPath);
    if (size > 0) {
      // The marker is only ever a shortcut past the hash, never a substitute for a file that does
      // not match it: anything unexpected about it (missing, stale, another hash) means hashing.
      if (await markerVouchesFor(size)) { set({kind: "ready"}); return; }
      if (await verify(finalPath)) { await writeMarker(); set({kind: "ready"}); }
      else { await disk.remove(finalPath); await disk.remove(markerPath); set({kind: "missing"}); }
      return;
    }
    const received = await disk.size(partPath);
    set(received > 0 ? {kind: "partial", receivedBytes: received} : {kind: "missing"});
  }

  async function download(mayRestart = true): Promise<void> {
    let received = await disk.size(partPath);
    // Nothing to ask for: the bytes are all here (the app died between the last chunk and the
    // rename, or a previous run was killed during the hash). Asking would mean a range at or past
    // the end of the file, which is what the 416 below is about.
    if (received >= spec.sizeBytes) { await finishPart(mayRestart); return; }
    if (await disk.freeBytes(dir) < spec.sizeBytes - received + DOWNLOAD_FREE_SPACE_MARGIN_BYTES) { set({kind: "error", code: "DOWNLOAD_NO_SPACE"}); return; }
    abort = new AbortController();
    set({kind: "downloading", receivedBytes: received});
    // How much had been received when the last notification went out. The renderer gets one per step
    // of new bytes plus the last one, not one per chunk: 2.7 GB in 64 KiB chunks would otherwise be
    // ~44,000 IPC messages and a re-render for each.
    let notified = received;
    try {
      const response = await http.get(spec.url, {rangeStart: received, signal: abort.signal});
      if (response.status === 200 && received > 0) { await disk.remove(partPath); received = 0; notified = 0; }
      // "Range not satisfiable": the server says there is nothing beyond what we already hold, so
      // there is nothing to stream. Same treatment as a part file that is already long enough.
      else if (response.status === 416) { abort = null; await finishPart(mayRestart); return; }
      else if (response.status !== 200 && response.status !== 206) throw new Error("status");
      for await (const chunk of response.body) {
        await disk.append(partPath, chunk);
        received += chunk.length;
        if (received - notified >= DOWNLOAD_PROGRESS_STEP_BYTES) { notified = received; set({kind: "downloading", receivedBytes: received}); }
      }
      if (received !== notified) set({kind: "downloading", receivedBytes: received});
    } catch {
      const paused = abort?.signal.aborted ?? false;
      abort = null;
      set(paused ? {kind: "partial", receivedBytes: await disk.size(partPath)} : {kind: "error", code: "DOWNLOAD_FAILED"});
      return;
    }
    abort = null;
    await finishPart(mayRestart);
  }

  return {
    state: () => state,
    filePath: () => finalPath,
    async inspect() {
      // `inspect()` and `start()` are mutually exclusive: they take the SAME lock, and this one
      // takes it synchronously (before the first await), so a `downloadStart` that lands while the
      // file already on disk is being looked at — or hashed, which for 2.7 GB is minutes — cannot
      // begin downloading a file that is about to turn out to be the right one. Such a start gets
      // this look's promise back and does nothing, exactly as a second `start()` would; by the time
      // it resolves the state says whether there is anything left to download.
      if (starting) { await starting.catch(() => undefined); return state; }
      starting = inspectDisk();
      try { await starting; } finally { starting = null; }
      return state;
    },
    start() {
      // Taken synchronously: a second start() call, even one made during the first's own awaits,
      // must see the lock and get back the SAME in-flight promise rather than starting another request.
      if (starting) return starting;
      if (state.kind === "downloading" || state.kind === "verifying" || state.kind === "ready") return Promise.resolve();
      starting = run().finally(() => { starting = null; });
      return starting;
    },
    pause() { abort?.abort(); },
    async removeAll() { abort?.abort(); await disk.remove(partPath); await disk.remove(finalPath); await disk.remove(markerPath); set({kind: "missing"}); },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}
