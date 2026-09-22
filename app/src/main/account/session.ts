import {SESSION_REFRESH_BEFORE_MS} from "../constants";
import {ApiError, apiCodeOf, parseSession, type ApiErrorCode, type ClaveApi, type Session} from "../ports/claveApi";
import type {Cipher, FileSystem, Now} from "../ports/system";
import {createJsonFile, StorageError} from "../storage/jsonFile";

export type SignInResult = {ok: true} | {ok: false; code: ApiErrorCode | "STORAGE_UNAVAILABLE" | "STORAGE_WRITE_FAILED"};

export interface SessionStore {
  current(): Session | null;
  userId(): string | null;
  /** The user's own names, which the guard forbids in statements. Empty until known. */
  names(): string[];
  signIn(identifier: string, password: string): Promise<SignInResult>;
  /** On launch: loads the stored token, refreshes it when it is near expiry. A refused refresh signs out. */
  restore(): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Runs an API call with the session. On UNAUTHORISED it refreshes once and tries again; if that is
   * refused too, the user is signed out and the error is rethrown.
   */
  withSession<T>(call: (session: Session) => Promise<T>): Promise<T>;
  onChange(cb: (signedIn: boolean) => void): () => void;
}

interface Stored { session: Session; names: string[] }
const parseStored = (value: unknown): Stored | null => {
  const v = value as {session?: unknown; names?: unknown} | null;
  const session = parseSession(v?.session);
  if (!session || !Array.isArray(v?.names) || !v.names.every((n) => typeof n === "string")) return null;
  return {session, names: v.names as string[]};
};

export function createSessionStore(deps: {api: ClaveApi; fs: FileSystem; cipher: Cipher; path: string; now: Now; onUnreadable?: () => void}): SessionStore {
  const {api, now} = deps;
  const file = createJsonFile<Stored>({fs: deps.fs, path: deps.path, parse: parseStored, cipher: deps.cipher, ...(deps.onUnreadable ? {onUnreadable: deps.onUnreadable} : {})});
  let stored: Stored | null = null;
  const listeners = new Set<(signedIn: boolean) => void>();
  const emit = () => { for (const cb of listeners) cb(stored !== null); };

  // Bumped by signIn/signOut only. Identifies "which signed-in identity is this". A refresh that was
  // started against one identity must never be applied once the identity has moved on (signed out,
  // or signed back in as someone else) while it was in flight.
  let generation = 0;

  // True while a stored file still needs deleting after a sign-out whose deletion the disk refused.
  // While it is set, that file is dead: it must never be loaded back as a session in this process.
  let removalPending = false;

  /** Deletes the stored file after a sign-out. Never throws: a sign-out that already took effect in
   *  memory is not a failure. A refusal is remembered and retried by restore/signIn/signOut. */
  async function removeStored(): Promise<void> {
    // Nothing to delete, or there is a live session again whose file this now is.
    if (!removalPending || stored !== null) return;
    try { await file.remove(); removalPending = false; }
    catch { /* still pending: the next restore/signIn/signOut tries again */ }
  }

  async function set(next: Stored | null): Promise<void> {
    const was = stored !== null;
    if (next) {
      // Persist first: memory only changes once the disk agrees, so a failed write leaves both in
      // sync and tells no listener anything happened.
      await file.save(next);
      stored = next;
      removalPending = false;          // the file on disk is this session's again
      if (!was) emit();
      return;
    }
    // The other direction is not symmetrical: a sign-out must always sign out. Memory and the
    // listeners change first, and the deletion of the file is only best-effort after that.
    stored = null;
    removalPending = true;
    if (was) emit();
    await removeStored();
  }

  /** Marker used only inside `refreshShared`: the completed refresh belongs to a generation that has
   * since moved on. It must never be persisted or used to answer a caller as if it succeeded. */
  class StaleRefresh extends Error {}

  async function refresh(onStale?: () => boolean): Promise<Session> {
    const current = stored as Stored;
    const session = await api.refresh(current.session);
    if (onStale?.()) throw new StaleRefresh();
    await set({session, names: current.names});
    return session;
  }

  let inFlightRefresh: Promise<Session> | null = null;
  /** Concurrent UNAUTHORISED retries share one `api.refresh` call instead of each starting their own. */
  function refreshShared(): Promise<Session> {
    if (inFlightRefresh) return inFlightRefresh;
    const gen = generation;
    const p = refresh(() => generation !== gen);
    inFlightRefresh = p.finally(() => { inFlightRefresh = null; });
    return inFlightRefresh;
  }

  const store: SessionStore = {
    current: () => stored?.session ?? null,
    userId: () => stored?.session.userId ?? null,
    names: () => stored?.names ?? [],
    async signIn(identifier, password) {
      // FIRST, before any await: from here on, a refresh that was already in flight belongs to an
      // identity this store has left behind, even if it resolves inside signIn's own save window.
      generation += 1;
      if (!deps.cipher.available()) return {ok: false, code: "STORAGE_UNAVAILABLE"};
      await removeStored();
      try {
        const session = await api.signIn(identifier, password);
        const {names} = await api.profile(session);
        await set({session, names});
        return {ok: true};
      } catch (error) {
        if (error instanceof StorageError) return {ok: false, code: error.code};
        return {ok: false, code: apiCodeOf(error)};
      }
    },
    async restore() {
      const gen = generation;
      await removeStored();
      // A file this process already signed out of is dead, whatever the disk still says.
      if (removalPending) return;
      const loaded = await file.load();
      // A sign-in or sign-out that landed while the file was being read has already decided who is
      // signed in. Bytes read before that decision must never overwrite it.
      if (generation !== gen) return;
      stored = loaded;
      if (!stored) return;
      if (stored.session.expiresAt - now() > SESSION_REFRESH_BEFORE_MS) { emit(); return; }
      // The same shared refresh withSession uses: a restore and a call racing at launch must not
      // each ask the server for a new token.
      try { await refreshShared(); emit(); }
      catch (error) {
        // A refresh belonging to an identity this store has since left behind says nothing about
        // the current one: whoever bumped the generation already decided what is signed in. `emit`
        // reads that decision, so saying it again is always the truth and never a stale value.
        if (error instanceof StaleRefresh) { emit(); return; }
        // Offline, a server hiccup, or a failed local save of the refreshed token: the previous
        // session stays in memory regardless of its own expiry. Only a firm refusal from the server
        // (UNAUTHORISED/BAD_CREDENTIALS) signs the user out.
        const code = apiCodeOf(error);
        if (code === "OFFLINE" || code === "SERVER") emit();
        else await set(null);
      }
    },
    async signOut() { generation += 1; await removeStored(); await set(null); },
    async withSession(call) {
      if (!stored) throw new ApiError("UNAUTHORISED");
      // Captured BEFORE the call, never in the catch: the identity this call was made for. A sign-in
      // or sign-out that lands while the call is in flight means the refusal below belongs to an
      // identity this store has left behind, and neither the refresh nor the retry are this call's
      // to make — a retry under the new identity would run the old user's work on the new user's
      // account. That is why the generation cannot be read after `call` has already failed.
      const gen = generation;
      try { return await call(stored.session); }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== "UNAUTHORISED") throw error;
        // Somebody else is signed in now. Their token is not this call's to refresh and their
        // account is not this call's to write to, so the caller is told to give up. Nobody is
        // signed out over it either: the refusal says nothing about the identity that is live now.
        if (generation !== gen) throw new ApiError("UNAUTHORISED");
        let session: Session;
        try {
          session = await refreshShared();
        } catch (refreshError) {
          if (refreshError instanceof StaleRefresh) throw new ApiError("UNAUTHORISED");
          if (refreshError instanceof ApiError && refreshError.code === "UNAUTHORISED" && generation === gen) await set(null);
          throw refreshError;
        }
        // The refresh itself was not stale, but the identity can still have moved on while its own
        // save was in flight — the one window `StaleRefresh` cannot see. Same rule, checked again.
        if (generation !== gen) throw new ApiError("UNAUTHORISED");
        try { return await call(session); }
        catch (second) {
          if (second instanceof ApiError && second.code === "UNAUTHORISED" && generation === gen) await set(null);
          throw second;
        }
      }
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
  return store;
}
