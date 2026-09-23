import {isPlausibleGrantToken} from "../main/reader/protocol";
import type {JsonFile} from "../main/storage/jsonFile";

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
}

export function parseScreenGrant(value: unknown): {token: string} | null {
  if (typeof value !== "object" || value === null) return null;
  const token = (value as Record<string, unknown>).token;
  return isPlausibleGrantToken(token) ? {token} : null;
}

export function createScreenGrant(deps: {
  file: JsonFile<{token: string}>;
  reader: {grant(token: string): void; release(): void};
}): ScreenGrant {
  let token: string | null = null;
  let on = false;
  return {
    async load() {
      const kept = await deps.file.load().catch(() => null);
      if (kept) {
        token = kept.token;
        deps.reader.grant(kept.token);
      }
    },
    saveToken(fresh) {
      token = fresh;
      // Kept for the next launch if the disk and the keyring allow; this run has it either way.
      void deps.file.save({token: fresh}).catch(() => undefined);
    },
    capture(now) {
      if (now === on) return;
      on = now;
      if (now) {
        if (token !== null) deps.reader.grant(token);
      } else {
        deps.reader.release();
      }
    }
  };
}
