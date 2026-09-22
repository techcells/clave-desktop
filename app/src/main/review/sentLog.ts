import {z} from "zod";
import {approvedShape, type ApprovedStatement} from "../ports/claveApi";
import type {FileSystem} from "../ports/system";
import {createJsonFile} from "../storage/jsonFile";

/** One statement that left this machine, and whose account it left under. */
export interface SentEntry { sentAt: number; item: ApprovedStatement; ownerUserId: string }
export interface SentLog {
  /** What `userId` sent. Nobody else's entries, and nothing at all while nobody is signed in. */
  list(userId: string | null): SentEntry[];
  load(): Promise<void>;
  add(items: ApprovedStatement[], sentAt: number, ownerUserId: string): Promise<void>;
}

const entryShape = z.object({sentAt: z.number().finite(), item: approvedShape, ownerUserId: z.string().min(1)});
/**
 * Entry by entry, deliberately: a file written before entries carried an owner is not corrupt, but
 * its entries belong to nobody in particular. They are dropped rather than shown to whoever signs
 * in next, and the rest of the file is kept. Only a file that is not a list at all is unreadable.
 */
const parse = (value: unknown): SentEntry[] | null => {
  if (!Array.isArray(value)) return null;
  return value.flatMap((raw) => { const parsed = entryShape.safeParse(raw); return parsed.success ? [parsed.data] : []; });
};

/** Exactly what left this machine and when. Plain JSON: the user is meant to be able to read it. */
export function createSentLog(deps: {fs: FileSystem; path: string}): SentLog {
  const file = createJsonFile<SentEntry[]>({fs: deps.fs, path: deps.path, parse});
  let entries: SentEntry[] = [];
  return {
    list: (userId) => (userId === null ? [] : entries.filter((entry) => entry.ownerUserId === userId)),
    async load() { entries = (await file.load()) ?? []; },
    async add(items, sentAt, ownerUserId) {
      // Re-sending an item is safe and expected (`clientItemId` de-dupes on the server), so the same
      // item can reach here twice. It belongs in the log once: the log says what left this machine,
      // not how many attempts it took. De-duped per account, because the same item id sent under two
      // accounts is two separate facts about two separate profiles. And the file is written before
      // memory takes the new entries, so a refused write leaves the log exactly as it was.
      const known = new Set(entries.filter((entry) => entry.ownerUserId === ownerUserId).map((entry) => entry.item.clientItemId));
      const next = [...entries];
      for (const item of items) {
        if (known.has(item.clientItemId)) continue;
        known.add(item.clientItemId);
        next.push({sentAt, item, ownerUserId});
      }
      if (next.length === entries.length) return;
      await file.save(next);
      entries = next;
    }
  };
}
