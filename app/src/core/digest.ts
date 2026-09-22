import {z} from "zod";
import {tokenize} from "./candidates/normalise";
import {DIGEST_ITEM_TTL_DAYS, DIGEST_MERGE_OVERLAP, DIGEST_PER_DAY, DIGEST_PER_TARGET, PIPELINE_VERSION, STATEMENT_MAX_CHARS} from "./constants";
import type {CountersApi} from "./counters";
import type {DraftStatement, PendingStatement, Ports} from "./types";

export interface Digest {
  add(draft: DraftStatement): "added" | "merged";
  list(): PendingStatement[];
  resolve(id: string): boolean;
  tick(): void;
  exportPool(): PendingStatement[];
  importPool(items: unknown): {accepted: number; rejected: number};
}

const DAY_MS = 86_400_000;
const FILLER = new Set(["the", "and", "for", "with", "that", "from", "into", "was", "were", "its", "their", "while", "where", "which", "without"]);

const contentWords = (statement: string) => new Set(tokenize(statement).map((t) => t.norm).filter((w) => w.length >= 3 && !FILLER.has(w)));

function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / smaller;
}

const stored = z.object({
  id: z.string().min(1), kind: z.enum(["skill", "competency"]), targetId: z.string().min(1),
  statement: z.string().min(1).max(STATEMENT_MAX_CHARS), createdAt: z.number().finite(),
  taxonomyVersion: z.string(), pipelineVersion: z.string()
});

export function createDigest(deps: {clock: Ports["clock"]; newId: Ports["newId"]; counters: CountersApi; taxonomyVersion: () => string}): Digest {
  const {clock, counters} = deps;
  let pool: PendingStatement[] = [];
  let today = clock.dayKey(clock.now());
  let resolvedToday = 0;

  const isCarried = (item: PendingStatement) => clock.dayKey(item.createdAt) !== today;
  const expired = (item: PendingStatement, now: number) => now - item.createdAt >= DIGEST_ITEM_TTL_DAYS * DAY_MS;

  function view(): PendingStatement[] {
    const room = Math.max(0, DIGEST_PER_DAY - resolvedToday);
    const perTarget = new Map<string, number>();
    const chosen: PendingStatement[] = [];
    const take = (item: PendingStatement) => { chosen.push(item); perTarget.set(item.targetId, (perTarget.get(item.targetId) ?? 0) + 1); };

    // Carried items were already shown to the user; they keep their place, oldest first.
    for (const item of pool.filter(isCarried).sort((a, b) => a.createdAt - b.createdAt)) {
      if (chosen.length < room && (perTarget.get(item.targetId) ?? 0) < DIGEST_PER_TARGET) take(item);
    }
    // Today's items: most specific first, one per target before anyone gets a second.
    const fresh = pool.filter((i) => !isCarried(i))
      .sort((a, b) => contentWords(b.statement).size - contentWords(a.statement).size || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (let round = 1; round <= DIGEST_PER_TARGET; round++) {
      for (const item of fresh) {
        if (chosen.length >= room) break;
        if (chosen.includes(item)) continue;
        if ((perTarget.get(item.targetId) ?? 0) < round) take(item);
      }
    }
    return chosen;
  }

  return {
    add(draft) {
      const words = contentWords(draft.statement);
      const twin = pool.find((i) => !isCarried(i) && i.targetId === draft.targetId && overlap(words, contentWords(i.statement)) >= DIGEST_MERGE_OVERLAP);
      if (twin) {
        if (words.size > contentWords(twin.statement).size) twin.statement = draft.statement;
        counters.inc("digest.merged");
        return "merged";
      }
      pool.push({
        id: deps.newId(), kind: draft.kind, targetId: draft.targetId, statement: draft.statement,
        createdAt: clock.now(), taxonomyVersion: deps.taxonomyVersion(), pipelineVersion: PIPELINE_VERSION
      });
      counters.inc("digest.added");
      return "added";
    },
    list: () => view().map((item) => ({...item})),
    resolve(id) {
      const before = pool.length;
      pool = pool.filter((i) => i.id !== id);
      if (pool.length === before) return false;
      resolvedToday += 1;
      return true;
    },
    tick() {
      const now = clock.now();
      const day = clock.dayKey(now);
      if (day !== today) {
        const shown = new Set(view().map((i) => i.id));
        counters.inc("digest.capped", pool.length - shown.size);
        pool = pool.filter((i) => shown.has(i.id));
        today = day;
        resolvedToday = 0;
      }
      const alive = pool.filter((i) => !expired(i, now));
      counters.inc("digest.expired", pool.length - alive.length);
      pool = alive;
    },
    exportPool: () => pool.map((item) => ({...item})),
    importPool(items) {
      if (!Array.isArray(items)) return {accepted: 0, rejected: 0};
      const now = clock.now();
      let accepted = 0;
      let rejected = 0;
      for (const raw of items) {
        const parsed = stored.safeParse(raw);
        if (!parsed.success || expired(parsed.data, now) || pool.some((i) => i.id === parsed.data.id)) { rejected++; continue; }
        pool.push(parsed.data);
        accepted++;
      }
      return {accepted, rejected};
    }
  };
}
