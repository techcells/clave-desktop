import type {Cipher, FileSystem} from "../ports/system";

export interface MemFs extends FileSystem {
  files: Map<string, Uint8Array>;
  /** Text of a file, for assertions. */
  text(path: string): string | null;
  /** Every byte on the fake disk as one string, for leak tests. */
  everything(): string;
  failWrites: boolean;
  /** Makes `read` throw, as a real disk would on EACCES/EIO, instead of resolving. */
  failReads: boolean;
}

export function createMemFs(): MemFs {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  const fs: MemFs = {
    files, failWrites: false, failReads: false,
    async read(path) { if (fs.failReads) throw new Error("EACCES"); return files.get(path) ?? null; },
    async writeAtomic(path, data) { if (fs.failWrites) throw new Error("ENOSPC"); files.set(path, data.slice()); },
    async append(path, data) {
      if (fs.failWrites) throw new Error("ENOSPC");
      const before = files.get(path) ?? new Uint8Array();
      const joined = new Uint8Array(before.length + data.length);
      joined.set(before); joined.set(data, before.length);
      files.set(path, joined);
    },
    async size(path) { return files.get(path)?.length ?? 0; },
    async remove(path) { files.delete(path); },
    text(path) { const data = files.get(path); return data ? decoder.decode(data) : null; },
    everything() { return [...files.entries()].map(([path, data]) => `${path}\n${decoder.decode(data)}`).join("\n"); }
  };
  return fs;
}

/** Reversible and recognisable: the plain text never appears in the output. */
export function createFakeCipher(available = true): Cipher {
  const MARK = "enc1:";
  return {
    available: () => available,
    encrypt(plain) {
      const bytes = new TextEncoder().encode(plain).map((b) => b ^ 0x5a);
      return new TextEncoder().encode(MARK + Buffer.from(bytes).toString("hex"));
    },
    decrypt(data) {
      const text = new TextDecoder().decode(data);
      if (!text.startsWith(MARK)) throw new Error("not encrypted here");
      const bytes = Uint8Array.from(Buffer.from(text.slice(MARK.length), "hex")).map((b) => b ^ 0x5a);
      return new TextDecoder().decode(bytes);
    }
  };
}
