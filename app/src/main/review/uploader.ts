import {z} from "zod";
import type {SessionStore} from "../account/session";
import {UPLOAD_BACKOFF_MS} from "../constants";
import {ApiError, apiCodeOf, approvedShape, type ApiErrorCode, type ApprovedStatement, type ClaveApi} from "../ports/claveApi";
import type {Cipher, FileSystem, Now} from "../ports/system";
import {StorageError, createJsonFile, type StorageErrorCode} from "../storage/jsonFile";
import type {SentLog} from "./sentLog";

export type FlushResult = "sent" | "empty" | "signedOut" | "waiting" | ApiErrorCode | StorageErrorCode;

export interface Uploader {
  /**
   * The owner's approved statements not yet on the server. Never dropped silently: the review screen
   * shows this number. Empty while signed out, or while the live session is not the owner — the items
   * stay stored for their owner's return, but they are nobody else's to see.
   */
  waiting(): ApprovedStatement[];
  /** How many `waiting()` would return. Same visibility rule. */
  waitingCount(): number;
  load(): Promise<void>;
  /** Adds to the outbox (saved before returning) and tries to send. */
  enqueue(item: ApprovedStatement): Promise<void>;
  /** Sends the whole outbox in one request. Respects the backoff unless `force`. */
  flush(force?: boolean): Promise<FlushResult>;
  /** When the next automatic attempt is due; `null` when nothing is waiting. */
  nextAttemptAt(): number | null;
  /** Called after sign-in: another user's approved statements are discarded, never uploaded to the wrong profile. */
  /** Returns how many of another account's statements were discarded (0 when the owner is unchanged). */
  adoptOwner(userId: string): Promise<number>;
  /** Writes the outbox again as it is. The engine uses it to find out whether the disk takes writes again. */
  resave(): Promise<void>;
  clear(): Promise<void>;
}

interface Stored { ownerUserId: string | null; items: ApprovedStatement[] }
const parse = (value: unknown): Stored | null => {
  const parsed = z.object({ownerUserId: z.string().nullable(), items: z.array(approvedShape)}).safeParse(value);
  return parsed.success ? parsed.data : null;
};

export function createUploader(deps: {
  api: ClaveApi; session: SessionStore; sentLog: SentLog; fs: FileSystem; cipher: Cipher; path: string; now: Now; onUnreadable?: () => void;
}): Uploader {
  const {api, session, sentLog, now} = deps;
  const file = createJsonFile<Stored>({fs: deps.fs, path: deps.path, parse, cipher: deps.cipher, ...(deps.onUnreadable ? {onUnreadable: deps.onUnreadable} : {})});
  let stored: Stored = {ownerUserId: null, items: []};
  let failures = 0;
  let notBefore = 0;
  let sending: Promise<FlushResult> | null = null;

  /** Everything that can fail on the way out lives inside one guard, so `flush` only ever returns a
   *  code: a rejection here would escape into `enqueue`, or into an unawaited background flush. */
  async function send(userId: string): Promise<FlushResult> {
    try {
      // An outbox built up while signed out (owner still null) is only ever sent once it is known
      // whose it is: adopt the live session's user first, so it is never sent under an ambiguous
      // owner. Inside the guard, because saving that adoption can fail like any other write.
      if (stored.ownerUserId === null) {
        const adopted = {...stored, ownerUserId: userId};
        await file.save(adopted);
        stored = adopted;
      }
      // Whose this batch is, decided before anything is sent. Statements are one person's career
      // record: they may only ever be submitted to, and marked as sent from, that person's account.
      // The session store already refuses to retry a call under a user who signed in mid-flight;
      // this is the belt on top of that brace, checked on the way out and again on the way back,
      // because a sign-in can land at either await.
      const owner = stored.ownerUserId ?? userId;
      const batch = [...stored.items];
      const {accepted} = await session.withSession((s) => {
        if (session.userId() !== owner) throw new ApiError("UNAUTHORISED");
        return api.submitEvidence(s, batch);
      });
      // Somebody else is signed in now: whatever the server said, these are not theirs to have sent.
      // The items stay in the outbox for their owner — re-sending is safe, `clientItemId` de-dupes.
      if (session.userId() !== owner) throw new ApiError("UNAUTHORISED");
      const done = new Set(accepted);
      const sent = batch.filter((item) => done.has(item.clientItemId));
      // The sent log is the record that these left the machine. Write it FIRST: if it fails, the
      // items stay in the outbox (re-sending is safe, `clientItemId` de-dupes on the server) instead
      // of being dropped from the outbox while never having been logged as sent.
      // Logged under the batch's own owner, never under whoever happens to be signed in: the sent
      // log is a record of one account's career, and it is read back per account.
      if (sent.length > 0) await sentLog.add(sent, now(), owner);
      const next = {...stored, items: stored.items.filter((item) => !done.has(item.clientItemId))};
      await file.save(next);
      stored = next;
      failures = 0; notBefore = 0;
      return stored.items.length === 0 ? "sent" : "waiting";
    } catch (error) {
      const delay = UPLOAD_BACKOFF_MS[Math.min(failures, UPLOAD_BACKOFF_MS.length - 1)] as number;
      failures += 1;
      notBefore = now() + delay;
      return error instanceof StorageError ? error.code : apiCodeOf(error);
    }
  }

  function flush(force = false): Promise<FlushResult> {
    if (sending) return sending;
    if (stored.items.length === 0) return Promise.resolve("empty");
    const userId = session.userId();
    // One check, not two: a live session always has a user id, and `send` needs one to stamp the
    // batch's owner with. Nothing is ever sent, or logged as sent, under an unknown account.
    if (!session.current() || userId === null) return Promise.resolve("signedOut");
    if (stored.ownerUserId !== null && stored.ownerUserId !== userId) return Promise.resolve("signedOut");
    if (!force && now() < notBefore) return Promise.resolve("waiting");
    sending = send(userId).finally(() => { sending = null; });
    return sending;
  }

  /** The items this uploader is allowed to show to whoever is signed in right now. */
  function visible(): ApprovedStatement[] {
    const userId = session.userId();
    if (userId === null) return [];
    if (stored.ownerUserId !== null && stored.ownerUserId !== userId) return [];
    return stored.items;
  }

  return {
    waiting: () => [...visible()],
    waitingCount: () => visible().length,
    async load() { stored = (await file.load()) ?? {ownerUserId: null, items: []}; },
    async enqueue(item) {
      if (stored.items.some((existing) => existing.clientItemId === item.clientItemId)) return;
      // Build the next state and save it before touching memory: on a failed save, nothing here
      // changes and the caller sees the storage error.
      const next = {ownerUserId: stored.ownerUserId ?? session.userId(), items: [...stored.items, item]};
      await file.save(next);
      stored = next;
      // A flush already in flight was built without this item, and `flush()` would just hand that
      // same promise back. Wait for it, then run one more round so the new item is tried at once
      // instead of sitting until the next poll. Neither call can reject: `send` returns codes.
      const joining = sending !== null;
      await flush();
      if (joining) await flush();
    },
    flush,
    nextAttemptAt: () => (stored.items.length === 0 ? null : notBefore),
    async adoptOwner(userId) {
      const clearing = stored.ownerUserId !== null && stored.ownerUserId !== userId;
      const next = clearing ? {ownerUserId: userId, items: []} : {...stored, ownerUserId: userId};
      const discarded = clearing ? stored.items.length : 0;
      await file.save(next);
      stored = next;
      if (clearing) { failures = 0; notBefore = 0; }
      return discarded;
    },
    resave: () => file.save(stored),
    async clear() { stored = {ownerUserId: null, items: []}; failures = 0; notBefore = 0; await file.remove(); }
  };
}
