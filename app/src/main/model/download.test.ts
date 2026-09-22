import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {DOWNLOAD_FREE_SPACE_MARGIN_BYTES, DOWNLOAD_PROGRESS_STEP_BYTES} from "../constants";
import {createDownloader, type DownloadDisk, type DownloadState, type Http, type ModelSpec} from "./download";

const CONTENT = new TextEncoder().encode("0123456789".repeat(10));   // 100 bytes standing in for 2.7 GB
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const SPEC: ModelSpec = {url: "https://models.example/q.gguf", fileName: "q.gguf", sha256: sha(CONTENT), sizeBytes: CONTENT.length};
const FINAL = "/m/q.gguf";
const PART = "/m/q.gguf.part";

function fakeDisk(free = 10 * DOWNLOAD_FREE_SPACE_MARGIN_BYTES) {
  const files = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let clock = 1_000;
  const touch = (path: string) => { clock += 1_000; mtimes.set(path, clock); };
  const disk: DownloadDisk = {
    async size(path) { return files.get(path)?.length ?? 0; },
    async mtimeMs(path) { return mtimes.get(path) ?? 0; },
    async append(path, chunk) { const old = files.get(path) ?? new Uint8Array(); const next = new Uint8Array(old.length + chunk.length); next.set(old); next.set(chunk, old.length); files.set(path, next); touch(path); },
    async remove(path) { files.delete(path); texts.delete(path); mtimes.delete(path); },
    async rename(from, to) { files.set(to, files.get(from) as Uint8Array); files.delete(from); mtimes.set(to, mtimes.get(from) ?? 0); mtimes.delete(from); },
    async sha256(path) { return sha(files.get(path) ?? new Uint8Array()); },
    async freeBytes() { return free; },
    async writeText(path, text) { texts.set(path, text); touch(path); },
    async readText(path) { return texts.get(path) ?? null; }
  };
  return {disk, files, texts, mtimes, touch};
}

/** Serves CONTENT in 10-byte chunks. `breakAfter` makes the connection die; `ignoreRange` answers 200 from byte 0. */
function fakeHttp(opts: {content?: Uint8Array; breakAfter?: number; ignoreRange?: boolean; status?: number; onChunk?: (n: number) => void} = {}) {
  const requests: number[] = [];
  const http: Http = {
    async get(_url, {rangeStart, signal}) {
      requests.push(rangeStart);
      const content = opts.content ?? CONTENT;
      const from = opts.ignoreRange ? 0 : rangeStart;
      async function* body() {
        let sent = 0;
        for (let i = from; i < content.length; i += 10) {
          if (signal.aborted) throw new Error("aborted");
          if (opts.breakAfter !== undefined && sent >= opts.breakAfter) throw new Error("connection reset");
          yield content.slice(i, i + 10);
          sent += 10;
          opts.onChunk?.(sent);
        }
      }
      return {status: opts.status ?? (from === 0 ? 200 : 206), body: body()};
    }
  };
  return {http, requests};
}

describe("model download", () => {
  it("downloads, verifies, and only then gives the file its real name", async () => {
    const {disk, files} = fakeDisk();
    const states: DownloadState["kind"][] = [];
    const downloader = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
    downloader.onChange((s) => { if (states.at(-1) !== s.kind) states.push(s.kind); });
    await downloader.start();
    expect(states).toEqual(["downloading", "verifying", "ready"]);
    expect(files.has(FINAL)).toBe(true);
    expect(files.has(PART)).toBe(false);
    expect(downloader.filePath()).toBe(FINAL);
  });

  it("deletes a file whose hash does not match, and never exposes it", async () => {
    const {disk, files} = fakeDisk();
    const tampered = CONTENT.slice(); tampered[5] = 120;
    const downloader = createDownloader({http: fakeHttp({content: tampered}).http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_BAD_HASH"});
    expect(files.size).toBe(0);
  });

  it("resumes from where a broken connection stopped", async () => {
    const {disk} = fakeDisk();
    const broken = createDownloader({http: fakeHttp({breakAfter: 40}).http, disk, dir: "/m", spec: SPEC});
    await broken.start();
    expect(broken.state()).toEqual({kind: "error", code: "DOWNLOAD_FAILED"});

    const {http, requests} = fakeHttp();
    const resumed = createDownloader({http, disk, dir: "/m", spec: SPEC});
    expect(await resumed.inspect()).toEqual({kind: "partial", receivedBytes: 40});
    await resumed.start();
    expect(requests).toEqual([40]);
    expect(resumed.state()).toEqual({kind: "ready"});
  });

  it("starts over when the server ignores the range", async () => {
    const {disk, files} = fakeDisk();
    files.set(PART, CONTENT.slice(0, 30));
    const downloader = createDownloader({http: fakeHttp({ignoreRange: true}).http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "ready"});
  });

  it("pauses and keeps the partial file", async () => {
    const {disk} = fakeDisk();
    let downloader: ReturnType<typeof createDownloader>;
    const {http} = fakeHttp({onChunk: (sent) => { if (sent === 30) downloader.pause(); }});
    downloader = createDownloader({http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "partial", receivedBytes: 30});
  });

  it("refuses to start without enough free space, and treats a bad status as a failure", async () => {
    const small = createDownloader({http: fakeHttp().http, disk: fakeDisk(1000).disk, dir: "/m", spec: SPEC});
    await small.start();
    expect(small.state()).toEqual({kind: "error", code: "DOWNLOAD_NO_SPACE"});

    const forbidden = createDownloader({http: fakeHttp({status: 403}).http, disk: fakeDisk().disk, dir: "/m", spec: SPEC});
    await forbidden.start();
    expect(forbidden.state()).toEqual({kind: "error", code: "DOWNLOAD_FAILED"});
  });

  it("inspect re-verifies an existing file and removes a corrupted one", async () => {
    const good = fakeDisk(); good.files.set(FINAL, CONTENT);
    expect(await createDownloader({http: fakeHttp().http, disk: good.disk, dir: "/m", spec: SPEC}).inspect()).toEqual({kind: "ready"});

    const bad = fakeDisk(); bad.files.set(FINAL, CONTENT.slice(0, 50));
    expect(await createDownloader({http: fakeHttp().http, disk: bad.disk, dir: "/m", spec: SPEC}).inspect()).toEqual({kind: "missing"});
    expect(bad.files.size).toBe(0);
  });

  it("starting twice without awaiting only makes one HTTP request", async () => {
    const {disk, files} = fakeDisk();
    const {http, requests} = fakeHttp();
    const downloader = createDownloader({http, disk, dir: "/m", spec: SPEC});
    const p1 = downloader.start();
    const p2 = downloader.start();
    await Promise.all([p1, p2]);
    expect(requests).toEqual([0]);
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(files.has(FINAL)).toBe(true);
  });

  it("never starts a download while the file already on disk is still being looked at", async () => {
    const {disk, files} = fakeDisk();
    files.set(FINAL, CONTENT);
    const {http, requests} = fakeHttp();
    const downloader = createDownloader({http, disk, dir: "/m", spec: SPEC});
    let release = () => { /* replaced below */ };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realSize = disk.size.bind(disk);
    vi.spyOn(disk, "size").mockImplementation(async (path) => { await gate; return realSize(path); });

    const inspecting = downloader.inspect();          // hashing 2.7 GB takes minutes; this stands in for it
    const started = downloader.start();               // a downloadStart lands in the middle of it
    release();
    await Promise.all([inspecting, started]);
    expect(requests).toEqual([]);                     // the server was never asked for a file we already have
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(files.has(PART)).toBe(false);
  });

  it("fails fast on a size mismatch without hashing", async () => {
    const {disk, files} = fakeDisk();
    const short = CONTENT.slice(0, 50);   // less than SPEC.sizeBytes, but the connection just ends cleanly
    const shaSpy = vi.spyOn(disk, "sha256");
    const downloader = createDownloader({http: fakeHttp({content: short}).http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_BAD_HASH"});
    expect(shaSpy).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("start resolves, never rejects, when a disk call throws", async () => {
    // Every disk call run() makes, one at a time: each one must end as a state, not as a rejection
    // out of an unawaited background start().
    for (const call of ["size", "freeBytes", "append", "sha256", "rename"] as const) {
      const {disk} = fakeDisk();
      vi.spyOn(disk, call).mockRejectedValue(new Error("EIO"));
      const downloader = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
      await expect(downloader.start()).resolves.toBeUndefined();
      expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_FAILED"});
    }
  });

  it("removeAll deletes both files and the marker", async () => {
    const {disk, files, texts} = fakeDisk();
    const downloader = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(texts.size).toBe(1);                         // the verified marker, written after the hash matched
    await downloader.removeAll();
    expect(files.size).toBe(0);
    expect(texts.size).toBe(0);
    expect(downloader.state()).toEqual({kind: "missing"});
  });

  it("asks the server for nothing when the part file already holds the whole file", async () => {
    const {disk, files} = fakeDisk();
    files.set(PART, CONTENT);                           // died between the last chunk and the rename
    const {http, requests} = fakeHttp();
    const downloader = createDownloader({http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(requests).toEqual([]);
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(files.has(FINAL)).toBe(true);
    expect(files.has(PART)).toBe(false);
  });

  it("throws away an oversized part file and starts again from zero, once", async () => {
    const tooLong = new Uint8Array(CONTENT.length * 2);
    tooLong.set(CONTENT); tooLong.set(CONTENT, CONTENT.length);

    const good = fakeDisk();
    good.files.set(PART, tooLong);
    const first = fakeHttp();
    const restarting = createDownloader({http: first.http, disk: good.disk, dir: "/m", spec: SPEC});
    await restarting.start();
    expect(first.requests).toEqual([0]);                // from zero, not a resume from byte 200
    expect(restarting.state()).toEqual({kind: "ready"});

    // A server that keeps serving too many bytes must settle, not restart for ever.
    const bad = fakeDisk();
    bad.files.set(PART, tooLong);
    const second = fakeHttp({content: tooLong});
    const giving = createDownloader({http: second.http, disk: bad.disk, dir: "/m", spec: SPEC});
    await giving.start();
    expect(second.requests).toEqual([0]);
    expect(giving.state()).toEqual({kind: "error", code: "DOWNLOAD_BAD_HASH"});
    expect(bad.files.size).toBe(0);
  });

  it("treats a refused range like a finished part file: checked, and removed when it is not the model", async () => {
    const {disk, files} = fakeDisk();
    files.set(PART, CONTENT.slice(0, 40));
    const {http, requests} = fakeHttp({status: 416});
    const downloader = createDownloader({http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    expect(requests).toEqual([40]);
    expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_BAD_HASH"});
    expect(files.size).toBe(0);                         // gone, so the next attempt cannot ask for the same range again
  });

  it("reports progress at most once per step, plus the last chunk", async () => {
    const chunk = new Uint8Array(DOWNLOAD_PROGRESS_STEP_BYTES / 4);
    const chunks = 13;                                  // 3.25 steps
    const total = chunk.length * chunks;
    let size = 0;
    const disk: DownloadDisk = {
      async size(path) { return path.endsWith(".part") ? size : 0; },
      async mtimeMs() { return 1; },
      async append(_path, data) { size += data.length; },
      async remove() { size = 0; },
      async rename() { /* nothing is really moved: only the reported progress matters here */ },
      async sha256() { return SPEC.sha256; },
      async freeBytes() { return Number.MAX_SAFE_INTEGER; },
      async writeText() { /* the marker is E7(d)'s business, not this test's */ },
      async readText() { return null; }
    };
    const http: Http = {
      async get(_url, _opts) {
        async function* body(): AsyncGenerator<Uint8Array> { for (let i = 0; i < chunks; i++) yield chunk; }
        return {status: 200, body: body()};
      }
    };
    const progress: number[] = [];
    const downloader = createDownloader({http, disk, dir: "/m", spec: {...SPEC, sizeBytes: total}});
    downloader.onChange((s) => { if (s.kind === "downloading") progress.push(s.receivedBytes); });
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "ready"});
    // The first one is the start, then one per whole step, then the tail: never one per chunk.
    expect(progress).toEqual([0, chunk.length * 4, chunk.length * 8, chunk.length * 12, total]);
  });

  it("trusts a file its own marker vouches for, and hashes it again when anything has moved", async () => {
    const {disk, files, mtimes, touch} = fakeDisk();
    await createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC}).start();

    const again = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
    const shaSpy = vi.spyOn(disk, "sha256");
    expect(await again.inspect()).toEqual({kind: "ready"});
    expect(shaSpy).not.toHaveBeenCalled();               // 2.7 GB is not re-hashed on every launch

    // The file was touched since it was verified: the marker says nothing about it any more.
    touch(FINAL);
    expect(await again.inspect()).toEqual({kind: "ready"});
    expect(shaSpy).toHaveBeenCalledTimes(1);

    // And a marker that vouches for another hash than the one pinned now is no help either.
    const other = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: {...SPEC, sha256: "0".repeat(64)}});
    expect(await other.inspect()).toEqual({kind: "missing"});
    expect(files.size).toBe(0);
    expect(mtimes.has(FINAL)).toBe(false);
  });

  it("re-verifies when the marker is missing or unreadable, and writes it again", async () => {
    const {disk, files, texts} = fakeDisk();
    files.set(FINAL, CONTENT);
    texts.set(`${FINAL}.verified`, "{not json");
    const downloader = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
    const shaSpy = vi.spyOn(disk, "sha256");
    expect(await downloader.inspect()).toEqual({kind: "ready"});
    expect(shaSpy).toHaveBeenCalledTimes(1);
    const marker = JSON.parse(texts.get(`${FINAL}.verified`) as string) as {sizeBytes: number; sha256: string};
    expect(marker).toMatchObject({sizeBytes: CONTENT.length, sha256: SPEC.sha256});

    // Written once and trusted from then on.
    expect(await createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC}).inspect()).toEqual({kind: "ready"});
    expect(shaSpy).toHaveBeenCalledTimes(1);
  });

  it("stays ready when the marker cannot be written", async () => {
    const {disk, files} = fakeDisk();
    vi.spyOn(disk, "writeText").mockRejectedValue(new Error("EROFS"));
    const downloader = createDownloader({http: fakeHttp().http, disk, dir: "/m", spec: SPEC});
    await downloader.start();
    // The marker is a cache, not the file: losing it costs one hash at the next launch, nothing more.
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(files.has(FINAL)).toBe(true);
  });
});
