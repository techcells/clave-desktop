import {TAXONOMY_REFRESH_MS, TAXONOMY_RETRY_MS} from "../constants";
import {parseTaxonomy, type ClaveApi, type Taxonomy} from "../ports/claveApi";
import type {FileSystem, Now} from "../ports/system";
import {createJsonFile} from "../storage/jsonFile";
import type {SessionStore} from "./session";

export interface TaxonomyCache {
  current(): Taxonomy | null;
  /** Reads the cached copy from disk. */
  load(): Promise<void>;
  /** Asks the server when the last successful check is older than a day (or `force`). Failure keeps the cache. */
  refresh(force?: boolean): Promise<"updated" | "unchanged" | "skipped" | "failed">;
  clear(): Promise<void>;
  onChange(cb: (taxonomy: Taxonomy) => void): () => void;
}

interface Stored { taxonomy: Taxonomy; checkedAt: number }
const parseStored = (value: unknown): Stored | null => {
  const v = value as {taxonomy?: unknown; checkedAt?: unknown} | null;
  const taxonomy = parseTaxonomy(v?.taxonomy);
  return taxonomy && typeof v?.checkedAt === "number" ? {taxonomy, checkedAt: v.checkedAt} : null;
};

/** The skills list is public data, so it is cached in plain JSON. */
export function createTaxonomyCache(deps: {api: ClaveApi; session: SessionStore; fs: FileSystem; path: string; now: Now}): TaxonomyCache {
  const {api, session, now} = deps;
  const file = createJsonFile<Stored>({fs: deps.fs, path: deps.path, parse: parseStored});
  let stored: Stored | null = null;
  // Kept in memory only: a failed attempt must not be retried on every tick while the server (or the
  // network) stays down, but it must also never persist across a restart as if it were real data.
  let lastFailedAt: number | null = null;
  const listeners = new Set<(taxonomy: Taxonomy) => void>();
  // A refresh already on its way answers every caller that arrives meanwhile: the sign-in's forced
  // refresh and the tick's ordinary one used to go out as two requests for the same list.
  let inFlight: Promise<"updated" | "unchanged" | "failed"> | null = null;

  async function fetchNow(): Promise<"updated" | "unchanged" | "failed"> {
    if (inFlight) return inFlight;
    inFlight = fetchOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function fetchOnce(): Promise<"updated" | "unchanged" | "failed"> {
      try {
        const answer = await session.withSession((s) => api.taxonomy(s, stored?.taxonomy.version));
        if (answer === "unchanged") {
          // Nothing cached means there is nothing for "unchanged" to be relative to: treat it as a failure.
          if (!stored) { lastFailedAt = now(); return "failed"; }
          stored = {taxonomy: stored.taxonomy, checkedAt: now()};
          await file.save(stored);
          lastFailedAt = null;
          return "unchanged";
        }
        const taxonomy = parseTaxonomy(answer);
        if (!taxonomy) { lastFailedAt = now(); return "failed"; }
        stored = {taxonomy, checkedAt: now()};
        await file.save(stored);
        lastFailedAt = null;
        for (const cb of listeners) cb(taxonomy);
        return "updated";
      } catch {
        lastFailedAt = now();
        return "failed";
      }
  }

  return {
    current: () => stored?.taxonomy ?? null,
    async load() {
      stored = await file.load();
      if (stored) for (const cb of listeners) cb(stored.taxonomy);
    },
    async refresh(force = false) {
      if (!session.current()) return "skipped";
      if (!force && stored && now() - stored.checkedAt < TAXONOMY_REFRESH_MS) return "skipped";
      if (!force && lastFailedAt !== null && now() - lastFailedAt < TAXONOMY_RETRY_MS) return "failed";
      return fetchNow();
    },
    async clear() { stored = null; await file.remove(); },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}
