import type {Cipher, FileSystem} from "../main/ports/system";
import {isPlausibleGrantToken} from "../main/reader/protocol";
import {createJsonFile, type JsonFile} from "../main/storage/jsonFile";

/**
 * The screen-share grant (Linux: the ScreenCast portal's restore token), kept for the reader.
 *
 * The token is kept encrypted, like the app's other secrets, in a file the app reads at start and
 * hands to the reader, so a new launch shares the screen without asking again. Every session start
 * spends it and the reader sends a fresh one, which replaces it here. When capture stops the reader
 * is told to `release` (GNOME's sharing indicator goes off, and no session reopens quietly), and
 * when capture starts again it is given the newest token back (`grant`), which is what lets it open
 * a session again. On macOS and Windows no token is ever sent, so this only ever sends `release`,
 * which those readers ignore.
 */
export interface ScreenGrant {
  /** Read the kept token and hand it to the reader. */
  load(): Promise<void>;
  /** A fresh token from the reader: keep it in place of the spent one. */
  saveToken(token: string): void;
  /** Whether capture is on now; acts only on a change. */
  capture(on: boolean): void;
  /** Follow capture from the engine's status, starting with the status it has now. Returns the unsubscribe. */
  follow(engine: {status(): {capture: string}; onStatus(cb: (status: {capture: string}) => void): () => void}): () => void;
  /**
   * "Delete all local data": the token is forgotten here and by the reader at once, and the file is
   * removed once any save still in flight has landed, so that save cannot write it back.
   */
  forget(): Promise<void>;
}

export function parseScreenGrant(value: unknown): {token: string} | null {
  if (typeof value !== "object" || value === null) return null;
  const token = (value as Record<string, unknown>).token;
  return isPlausibleGrantToken(token) ? {token} : null;
}

/**
 * The file the grant is kept in. The cipher is required here, where `createJsonFile` leaves it
 * optional: the token lets the reader share the screen without asking, so it is never stored in
 * the clear, and without an available cipher it is not stored at all.
 */
export function screenGrantFile(deps: {fs: FileSystem; path: string; cipher: Cipher}): JsonFile<{token: string}> {
  return createJsonFile({fs: deps.fs, path: deps.path, parse: parseScreenGrant, cipher: deps.cipher});
}

export function createScreenGrant(deps: {
  file: JsonFile<{token: string}>;
  reader: {grant(token: string): void; release(): void; forgetGrant(): void};
}): ScreenGrant {
  let token: string | null = null;
  // Unknown until the first call, which always acts: capture off at launch sends `release` too.
  let on: boolean | null = null;
  // The saves in order, so `forget` can wait for the last of them.
  let saving: Promise<void> = Promise.resolve();
  const grant: ScreenGrant = {
    async load() {
      const kept = await deps.file.load().catch(() => null);
      // A fresh token from the reader while the file was being read is newer than the file's.
      if (kept && token === null) {
        token = kept.token;
        deps.reader.grant(kept.token);
      }
    },
    saveToken(fresh) {
      token = fresh;
      // Kept for the next launch if the disk and the keyring allow; this run has it either way.
      saving = saving.then(() => deps.file.save({token: fresh})).catch(() => undefined);
    },
    capture(now) {
      if (now === on) return;
      on = now;
      if (now) {
        if (token !== null) deps.reader.grant(token);
      } else {
        deps.reader.release();
      }
    },
    follow(engine) {
      const stop = engine.onStatus((status) => grant.capture(status.capture === "on"));
      grant.capture(engine.status().capture === "on");
      return stop;
    },
    async forget() {
      token = null;
      deps.reader.forgetGrant();
      await saving;
      await deps.file.remove();
    }
  };
  return grant;
}
