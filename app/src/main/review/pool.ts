import {z} from "zod";
import type {Pipeline} from "../../core/types";
import type {Cipher, FileSystem} from "../ports/system";
import {createJsonFile} from "../storage/jsonFile";

export interface PoolRestored {
  accepted: number;
  rejected: number;
  /** Whose the restored pool is. `currentUserId` when nothing was restored. */
  ownerUserId: string | null;
}

export interface PoolStore {
  /**
   * Restores the saved pool into the pipeline, but only when it belongs to `currentUserId` — or when
   * nobody is signed in yet, in which case the caller learns whose it is and keeps it hidden until
   * that user is back. Another user's pool is discarded. The core validates every item again.
   */
  restore(pipeline: Pipeline, currentUserId: string | null): Promise<PoolRestored>;
  /** Saves the pipeline's pool as `ownerUserId`'s. Throws a StorageError when the disk or the keychain refuses. */
  save(pipeline: Pipeline, ownerUserId: string | null): Promise<void>;
  clear(): Promise<void>;
}

/** The owner is stored with the items: pending statements are one user's, never the machine's. */
interface Stored { ownerUserId: string | null; items: unknown[] }
const parse = (value: unknown): Stored | null => {
  // A file from a version that stored a bare array has no owner, so it cannot be shown to anyone
  // safely: it fails to parse here, which makes `createJsonFile` delete it.
  const parsed = z.object({ownerUserId: z.string().nullable(), items: z.array(z.unknown())}).safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The pending statements are the only pipeline state that survives a restart. They are already guarded. */
export function createPoolStore(deps: {fs: FileSystem; cipher: Cipher; path: string; onUnreadable?: () => void}): PoolStore {
  const file = createJsonFile<Stored>({
    fs: deps.fs, path: deps.path, cipher: deps.cipher, parse,
    ...(deps.onUnreadable ? {onUnreadable: deps.onUnreadable} : {})
  });
  return {
    async restore(pipeline, currentUserId) {
      const stored = await file.load();
      if (!stored) return {accepted: 0, rejected: 0, ownerUserId: currentUserId};
      if (currentUserId !== null && stored.ownerUserId !== currentUserId) {
        // Someone else is signed in: these statements must not be shown, uploaded, or left behind.
        await file.remove();
        return {accepted: 0, rejected: 0, ownerUserId: currentUserId};
      }
      return {...pipeline.importPool(stored.items), ownerUserId: stored.ownerUserId};
    },
    save: (pipeline, ownerUserId) => file.save({ownerUserId, items: pipeline.exportPool()}),
    clear: () => file.remove()
  };
}
