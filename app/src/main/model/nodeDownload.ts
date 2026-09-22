import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {appendFile, mkdir, readFile, rename, rm, stat, statfs, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import type {DownloadDisk, Http} from "./download";

/**
 * The real network and disk behind `createDownloader`. `fetch` follows redirects (model hosts
 * redirect to a CDN) and the body is consumed as a stream, so 2.7 GB never sits in memory.
 */
export function createNodeHttp(fetchImpl: typeof fetch = fetch): Http {
  return {
    async get(url, {rangeStart, signal}) {
      const response = await fetchImpl(url, {signal, redirect: "follow", headers: rangeStart > 0 ? {Range: `bytes=${rangeStart}-`} : {}});
      // A status the caller cannot use (a 404 page, a 403 from a CDN, a 416): its body is not model
      // bytes and nobody will read it, so the connection is released here instead of being left open
      // until the socket times out. The caller gets the status and an empty body.
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        async function* nothing(): AsyncGenerator<Uint8Array> { /* the body is gone */ }
        return {status: response.status, body: nothing()};
      }
      const body = response.body;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (!body) return;
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) yield chunk;
      }
      return {status: response.status, body: chunks()};
    }
  };
}

const missing = (error: unknown) => (error as {code?: string}).code === "ENOENT";

export function createNodeDownloadDisk(): DownloadDisk {
  return {
    async size(path) {
      try { return (await stat(path)).size; }
      catch (error) { if (missing(error)) return 0; throw error; }
    },
    async mtimeMs(path) {
      try { return (await stat(path)).mtimeMs; }
      catch (error) { if (missing(error)) return 0; throw error; }
    },
    async append(path, chunk) { await mkdir(dirname(path), {recursive: true}); await appendFile(path, chunk); },
    async remove(path) { await rm(path, {force: true}); },
    rename: (from, to) => rename(from, to),
    sha256(path) {
      return new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
      });
    },
    async freeBytes(dir) {
      await mkdir(dir, {recursive: true});
      const info = await statfs(dir);
      return info.bavail * info.bsize;
    },
    async writeText(path, text) { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text, "utf8"); },
    async readText(path) {
      try { return await readFile(path, "utf8"); }
      catch (error) { if (missing(error)) return null; throw error; }
    }
  };
}
