import type {Cipher, FileSystem} from "../ports/system";

export type StorageErrorCode = "STORAGE_UNAVAILABLE" | "STORAGE_WRITE_FAILED";
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode) { super(code); this.name = "StorageError"; }
}

export interface JsonFile<T> {
  /** `null` when there is no file, or when it could not be read (it is then deleted and `onUnreadable` is called). */
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  remove(): Promise<void>;
}

export interface JsonFileOptions<T> {
  fs: FileSystem;
  path: string;
  /** Returns `null` for anything that is not a valid `T`. */
  parse(value: unknown): T | null;
  /** When given, the file is encrypted. Without an available cipher nothing is stored at all. */
  cipher?: Cipher;
  onUnreadable?(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One JSON document per file. An unreadable file is deleted, never half-trusted. */
export function createJsonFile<T>(options: JsonFileOptions<T>): JsonFile<T> {
  const {fs, path, parse, cipher, onUnreadable} = options;

  // A promise chain per file: save/remove queue behind one another so two overlapping calls always
  // land in the order they were made, never in whichever order the underlying disk write settles.
  let queue: Promise<void> = Promise.resolve();
  function enqueue<R>(task: () => Promise<R>): Promise<R> {
    const result = queue.then(task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async load() {
      let data: Uint8Array | null;
      try {
        data = await fs.read(path);
      } catch {
        // EACCES/EIO and the like: the file cannot be trusted going forward either. Best-effort remove;
        // a failing remove must not turn "unreadable" into a crash.
        try { await fs.remove(path); } catch { /* nothing more we can do */ }
        onUnreadable?.();
        return null;
      }
      if (data === null) return null;
      // The keychain being merely locked is not the same as the file being corrupt: leave it alone.
      if (cipher && !cipher.available()) return null;
      try {
        const text = cipher ? cipher.decrypt(data) : decoder.decode(data);
        const value = parse(JSON.parse(text));
        if (value !== null) return value;
      } catch { /* falls through to the unreadable path */ }
      await fs.remove(path);
      onUnreadable?.();
      return null;
    },
    save: (value) => enqueue(async () => {
      if (cipher && !cipher.available()) throw new StorageError("STORAGE_UNAVAILABLE");
      const text = JSON.stringify(value);
      try { await fs.writeAtomic(path, cipher ? cipher.encrypt(text) : encoder.encode(text)); }
      catch { throw new StorageError("STORAGE_WRITE_FAILED"); }
    }),
    remove: () => enqueue(async () => {
      // Same fixed code as a failed write: to a caller, "the disk would not take this change" is one
      // situation whether the change was a write or a deletion.
      try { await fs.remove(path); }
      catch { throw new StorageError("STORAGE_WRITE_FAILED"); }
    })
  };
}
