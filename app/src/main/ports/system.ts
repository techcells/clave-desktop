/** Small system ports, so that every module in `main/` is tested without Electron or a real disk. */

export interface FileSystem {
  /** `null` when the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes to a temporary sibling and renames it over `path`, so a crash never leaves half a file. */
  writeAtomic(path: string, data: Uint8Array): Promise<void>;
  append(path: string, data: Uint8Array): Promise<void>;
  /** 0 when the file does not exist. */
  size(path: string): Promise<number>;
  /** Does nothing when the file does not exist. */
  remove(path: string): Promise<void>;
}

/** Electron `safeStorage` in the app; a reversible fake in tests. */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  /** Throws when the data was not produced by `encrypt` on this machine. */
  decrypt(data: Uint8Array): string;
}

export type Now = () => number;
