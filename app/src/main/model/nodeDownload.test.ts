import {createHash} from "node:crypto";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {createDownloader} from "./download";
import {createNodeDownloadDisk, createNodeHttp} from "./nodeDownload";

const CONTENT = Buffer.from("clave-model-bytes-".repeat(5000));          // ~90 KB standing in for 2.7 GB
const SHA = createHash("sha256").update(CONTENT).digest("hex");
const ranges: (string | undefined)[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/moved") { response.writeHead(302, {Location: "/model.gguf"}).end(); return; }
    // A body on purpose: a refused response's body must be closed, not handed on as model bytes.
    if (request.url === "/gone") { response.writeHead(404, {"Content-Type": "text/plain"}).end("no such model here"); return; }
    ranges.push(request.headers.range);
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const from = match ? Number(match[1]) : 0;
    response.writeHead(match ? 206 : 200, {"Content-Length": CONTENT.length - from});
    response.end(CONTENT.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe("node download adapters (a real local server and a real temp folder)", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "clave-dl-")); ranges.length = 0; });
  afterEach(async () => { await rm(dir, {recursive: true, force: true}); });
  const make = (path: string) => createDownloader({
    http: createNodeHttp(), disk: createNodeDownloadDisk(), dir: join(dir, "models"),
    spec: {url: base + path, fileName: "m.gguf", sha256: SHA, sizeBytes: CONTENT.length}
  });

  // Adapted for E7(d) on purpose: a verified file is left with the marker that vouches for it.
  it("downloads through a redirect, verifies, and leaves only the final file and its marker", async () => {
    const downloader = make("/moved");
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "ready"});
    expect((await readdir(join(dir, "models"))).sort()).toEqual(["m.gguf", "m.gguf.verified"]);
    expect((await readFile(downloader.filePath())).equals(CONTENT)).toBe(true);
  });

  it("hashes the file once and trusts the marker at the next launch", async () => {
    await make("/model.gguf").start();
    const again = make("/model.gguf");
    expect(await again.inspect()).toEqual({kind: "ready"});
    const marker = JSON.parse(await readFile(join(dir, "models", "m.gguf.verified"), "utf8")) as {sizeBytes: number; mtimeMs: number; sha256: string};
    expect(marker).toMatchObject({sizeBytes: CONTENT.length, sha256: SHA});
    expect(marker.mtimeMs).toBeGreaterThan(0);

    // Touched since: the marker no longer describes this file, so it is hashed again — and a file
    // that is no longer the model is removed with its marker.
    await writeFile(join(dir, "models", "m.gguf"), Buffer.concat([CONTENT, Buffer.from("x")]));
    expect(await make("/model.gguf").inspect()).toEqual({kind: "missing"});
    expect(await readdir(join(dir, "models"))).toEqual([]);
  });

  it("reads and writes the small marker file, and says nothing is there rather than throwing", async () => {
    const disk = createNodeDownloadDisk();
    const path = join(dir, "marker.json");
    expect(await disk.readText(path)).toBeNull();
    expect(await disk.mtimeMs(path)).toBe(0);
    await disk.writeText(path, "{\"a\":1}");
    expect(await disk.readText(path)).toBe("{\"a\":1}");
    expect(await disk.mtimeMs(path)).toBeGreaterThan(0);
  });

  it("serves nothing from a refused response, and closes its body", async () => {
    const response = await createNodeHttp().get(`${base}/gone`, {rangeStart: 0, signal: new AbortController().signal});
    expect(response.status).toBe(404);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });

  it("resumes with a Range request from the bytes already on disk", async () => {
    const disk = createNodeDownloadDisk();
    await disk.append(join(dir, "models", "m.gguf.part"), CONTENT.subarray(0, 40_000));
    const downloader = make("/model.gguf");
    await downloader.start();
    expect(ranges).toEqual(["bytes=40000-"]);
    expect(downloader.state()).toEqual({kind: "ready"});
  });

  it("reports a missing file as a failure, with nothing left under the final name", async () => {
    const downloader = make("/gone");
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_FAILED"});
    expect(await readdir(join(dir, "models")).catch(() => [])).not.toContain("m.gguf");
  });

  it("hashes by streaming and measures free space", async () => {
    const disk = createNodeDownloadDisk();
    const path = join(dir, "blob");
    await writeFile(path, CONTENT);
    expect(await disk.sha256(path)).toBe(SHA);
    expect(await disk.size(path)).toBe(CONTENT.length);
    expect(await disk.size(join(dir, "nope"))).toBe(0);
    expect(await disk.freeBytes(join(dir, "new-folder"))).toBeGreaterThan(1_000_000);
  });
});
