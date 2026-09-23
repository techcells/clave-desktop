import {appendFile, mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import type {FileSystem} from "../ports/system";

const missing = (error: unknown) => (error as {code?: string}).code === "ENOENT";

let writeCounter = 0;

/**
 * Windows refuses a rename onto a file that another rename is replacing at that moment, or that a
 * virus scanner still has open, with EPERM/EACCES/EBUSY; both pass within milliseconds. POSIX rename
 * never fails that way, so only Windows retries, and only those three codes, for under a second.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160, 320];

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || delay === undefined || !RENAME_RETRY_CODES.has((error as {code?: string}).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** The real disk. Files are created readable by the user only. */
export function createNodeFs(): FileSystem {
  return {
    async read(path) {
      try { return new Uint8Array(await readFile(path)); }
      catch (error) { if (missing(error)) return null; throw error; }
    },
    async writeAtomic(path, data) {
      await mkdir(dirname(path), {recursive: true});
      // A name unique per call, not just per path: two overlapping writes to the same path must never
      // share (and so clobber, or race to delete) the same temporary file.
      const temporary = `${path}.${process.pid}.${writeCounter++}.tmp`;
      await writeFile(temporary, data, {mode: 0o600});
      try {
        await renameOver(temporary, path);
      } catch (error) {
        await rm(temporary, {force: true});
        throw error;
      }
    },
    async append(path, data) {
      await mkdir(dirname(path), {recursive: true});
      await appendFile(path, data, {mode: 0o600});
    },
    async size(path) {
      try { return (await stat(path)).size; }
      catch (error) { if (missing(error)) return 0; throw error; }
    },
    async remove(path) { await rm(path, {force: true}); }
  };
}
