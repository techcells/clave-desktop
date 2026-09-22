import {describe, expect, it, vi} from "vitest";
import {SESSION_REFRESH_BEFORE_MS} from "../constants";
import {ApiError, type Session} from "../ports/claveApi";
import {createFakeApi} from "../testing/fakeApi";
import {createFakeCipher, createMemFs} from "../testing/memFs";
import {createSessionStore} from "./session";

const PATH = "/d/session.bin";
/** Drains the microtask queue, so every promise that can make progress without a timer has. */
const tick = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(cipherAvailable = true) {
  let now = 1_000_000;
  const fs = createMemFs();
  const api = createFakeApi(() => now);
  const make = () => createSessionStore({api, fs, cipher: createFakeCipher(cipherAvailable), path: PATH, now: () => now});
  return {fs, api, make, advance: (ms: number) => { now += ms; }};
}

describe("session", () => {
  it("signs in, fetches the user's names, and stores the token encrypted, never the password", async () => {
    const {fs, make} = setup();
    const store = make();
    const seen = vi.fn();
    store.onChange(seen);
    expect(await store.signIn("sardor", "correct")).toEqual({ok: true});
    expect(store.userId()).toBe("user:sardor");
    expect(store.names()).toEqual(["Sardor Astanov"]);
    expect(seen).toHaveBeenCalledWith(true);
    expect(fs.everything()).not.toContain("token-1");
    expect(fs.everything()).not.toContain("correct");
  });

  it("reports bad credentials and being offline with fixed codes", async () => {
    const {api, make} = setup();
    const store = make();
    expect(await store.signIn("sardor", "wrong")).toEqual({ok: false, code: "BAD_CREDENTIALS"});
    api.failWith = "OFFLINE";
    expect(await store.signIn("sardor", "correct")).toEqual({ok: false, code: "OFFLINE"});
    expect(store.current()).toBeNull();
  });

  it("refuses to sign in when the token could not be stored safely", async () => {
    const {api, make} = setup(false);
    expect(await make().signIn("sardor", "correct")).toEqual({ok: false, code: "STORAGE_UNAVAILABLE"});
    expect(api.calls).toEqual([]);
  });

  it("restores a stored session on launch without calling the server while it is fresh", async () => {
    const {api, make} = setup();
    await make().signIn("sardor", "correct");
    api.calls.length = 0;
    const next = make();
    await next.restore();
    expect(next.userId()).toBe("user:sardor");
    expect(api.calls).toEqual([]);
  });

  it("refreshes a token that is close to expiry", async () => {
    const {api, make, advance} = setup();
    await make().signIn("sardor", "correct");
    advance(7 * 24 * 60 * 60_000 - SESSION_REFRESH_BEFORE_MS + 1);
    const next = make();
    await next.restore();
    expect(api.calls.at(-1)).toBe("refresh");
    expect(next.current()?.token).toBe("token-2");
  });

  it("signs out when the refresh is refused, but keeps a still-valid token while offline", async () => {
    const {fs, api, make, advance} = setup();
    await make().signIn("sardor", "correct");
    advance(7 * 24 * 60 * 60_000 - SESSION_REFRESH_BEFORE_MS + 1);
    api.failWith = "OFFLINE";
    const offline = make();
    await offline.restore();
    expect(offline.userId()).toBe("user:sardor");

    api.failWith = "UNAUTHORISED";
    const refused = make();
    await refused.restore();
    expect(refused.current()).toBeNull();
    expect(fs.files.has(PATH)).toBe(false);
  });

  it("withSession refreshes once on UNAUTHORISED and signs out when that is refused too", async () => {
    const {api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    api.failQueue = ["UNAUTHORISED"];
    const names = await store.withSession((s) => api.profile(s));
    expect(names).toEqual({names: ["Sardor Astanov"]});
    expect(store.current()?.token).toBe("token-2");

    const seen = vi.fn();
    store.onChange(seen);
    api.failWith = "UNAUTHORISED";
    await expect(store.withSession((s) => api.profile(s))).rejects.toBeInstanceOf(ApiError);
    expect(store.current()).toBeNull();
    expect(seen).toHaveBeenCalledWith(false);
  });

  it("withSession passes other errors through and stays signed in", async () => {
    const {api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");
    api.failWith = "OFFLINE";
    await expect(store.withSession((s) => api.profile(s))).rejects.toMatchObject({code: "OFFLINE"});
    expect(store.userId()).toBe("user:sardor");
  });

  it("deletes an unreadable session file and stays signed out", async () => {
    const {fs, make} = setup();
    fs.files.set(PATH, new TextEncoder().encode("garbage"));
    const store = make();
    await store.restore();
    expect(store.current()).toBeNull();
    expect(fs.files.has(PATH)).toBe(false);
  });

  it("signIn reports STORAGE_WRITE_FAILED and stays signed out when the token cannot be written", async () => {
    const {fs, api, make} = setup();
    fs.failWrites = true;
    const store = make();
    expect(await store.signIn("sardor", "correct")).toEqual({ok: false, code: "STORAGE_WRITE_FAILED"});
    expect(store.current()).toBeNull();
    expect(api.calls).toEqual(["signIn", "profile"]);
  });

  it("keeps a signed-in session past full expiry when the refresh is refused with OFFLINE or SERVER", async () => {
    const {api, make, advance} = setup();
    await make().signIn("sardor", "correct");
    advance(7 * 24 * 60 * 60_000 + 1);   // fully expired, not just near expiry
    api.failWith = "SERVER";
    const store = make();
    await store.restore();
    expect(store.userId()).toBe("user:sardor");
    expect(store.current()).not.toBeNull();
  });

  it("restore keeps the previous token in memory when saving a refreshed session fails", async () => {
    const {fs, make, advance} = setup();
    await make().signIn("sardor", "correct");
    advance(7 * 24 * 60 * 60_000 - SESSION_REFRESH_BEFORE_MS + 1);
    fs.failWrites = true;
    const store = make();
    await store.restore();
    expect(store.userId()).toBe("user:sardor");
    expect(store.current()?.token).toBe("token-1");
    expect(fs.text(PATH)).not.toBeNull();
  });

  it("withSession shares a single refresh call across concurrent UNAUTHORISED retries", async () => {
    const {api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    let resolveRefresh!: (s: {token: string; expiresAt: number; userId: string}) => void;
    let refreshCalls = 0;
    api.refresh = () => { refreshCalls += 1; return new Promise((resolve) => { resolveRefresh = resolve; }); };
    api.failQueue = ["UNAUTHORISED", "UNAUTHORISED"];

    const callA = store.withSession((s) => api.profile(s));
    const callB = store.withSession((s) => api.profile(s));
    // Let both calls' rejection handlers run and reach the shared refresh before it settles.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    resolveRefresh({token: "token-fresh", expiresAt: 9_999_999_999, userId: "user:sardor"});

    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toEqual({names: ["Sardor Astanov"]});
    expect(b).toEqual({names: ["Sardor Astanov"]});
    expect(refreshCalls).toBe(1);
    expect(store.current()?.token).toBe("token-fresh");
  });

  it("discards a refresh that resolves after a concurrent sign-out, and does not resurrect the session", async () => {
    const {api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    let resolveRefresh!: (s: {token: string; expiresAt: number; userId: string}) => void;
    api.refresh = () => new Promise((resolve) => { resolveRefresh = resolve; });
    api.failQueue = ["UNAUTHORISED"];

    const call = store.withSession((s) => api.profile(s));
    // Let the rejection reach the catch handler and start the (shared) refresh, captured against the
    // current generation, before the sign-out bumps it.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await store.signOut();
    resolveRefresh({token: "resurrected", expiresAt: 9_999_999_999, userId: "user:sardor"});

    await expect(call).rejects.toBeInstanceOf(ApiError);
    expect(store.current()).toBeNull();
  });

  it("signing in as another user while a refresh is in flight installs the NEW user, never the old one", async () => {
    const {fs, api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    // A refresh for sardor, held open.
    let resolveRefresh!: (s: Session) => void;
    api.refresh = () => new Promise((resolve) => { resolveRefresh = resolve; });
    api.failQueue = ["UNAUTHORISED"];
    const call = store.withSession((s) => api.taxonomy(s));
    await tick();                                     // the shared refresh is now in flight

    // Hold every write, so the interleaving happens inside signIn's own save window: exactly where
    // a refresh that resolves there used to be counted as fresh and land last.
    const realWrite = fs.writeAtomic;
    let holding = true;
    const held: Array<() => void> = [];
    fs.writeAtomic = async (path, data) => {
      if (holding) await new Promise<void>((resolve) => { held.push(resolve); });
      return realWrite(path, data);
    };
    let resolveProfile!: (p: {names: string[]}) => void;
    api.profile = () => new Promise((resolve) => { resolveProfile = resolve; });

    const signingIn = store.signIn("someone-else", "correct");
    await tick();                                     // parked inside profile()
    resolveProfile({names: ["Someone Else"]});
    await tick();                                     // signIn is now inside its own file.save
    resolveRefresh({token: "stale-sardor", expiresAt: 9_999_999_999_999, userId: "user:sardor"});
    await tick();
    holding = false;
    for (const release of held.splice(0)) release();

    expect(await signingIn).toEqual({ok: true});
    await tick();                                     // let every queued write and its follow-up land
    expect(store.userId()).toBe("user:someone-else");
    expect(store.current()?.token).not.toBe("stale-sardor");
    await expect(call).rejects.toBeInstanceOf(ApiError);

    const next = make();                              // and the file holds the new user too
    await next.restore();
    expect(next.userId()).toBe("user:someone-else");
  });

  it("restore shares its refresh with a concurrent withSession: one refresh call for both", async () => {
    const {api, make, advance} = setup();
    await make().signIn("sardor", "correct");
    advance(7 * 24 * 60 * 60_000 - SESSION_REFRESH_BEFORE_MS + 1);

    const store = make();
    let resolveRefresh!: (s: Session) => void;
    let refreshCalls = 0;
    api.refresh = () => { refreshCalls += 1; return new Promise((resolve) => { resolveRefresh = resolve; }); };

    const restoring = store.restore();
    await tick();                                     // restore has loaded and started its refresh
    api.failQueue = ["UNAUTHORISED"];
    const call = store.withSession((s) => api.taxonomy(s));
    await tick();                                     // and withSession has joined it
    resolveRefresh({token: "token-shared", expiresAt: 9_999_999_999_999, userId: "user:sardor"});

    await restoring;
    await call;
    expect(refreshCalls).toBe(1);
    expect(store.current()?.token).toBe("token-shared");
  });

  it("never retries a call under a user who signed in while that call was in flight", async () => {
    const {api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    // A's call, parked: it is refused only once B is signed in. On the second invocation — the one
    // that must never happen — it simply answers with whoever's session it was handed.
    const seen: string[] = [];
    let refuseFirst!: (error: unknown) => void;
    const call = store.withSession(async (s) => {
      seen.push(s.userId);
      if (seen.length === 1) await new Promise<never>((_, reject) => { refuseFirst = reject; });
      return s.userId;
    });
    await tick();
    expect(seen).toEqual(["user:sardor"]);

    let refreshCalls = 0;
    const realRefresh = api.refresh;
    api.refresh = (old) => { refreshCalls += 1; return realRefresh(old); };

    expect(await store.signIn("someone-else", "correct")).toEqual({ok: true});
    refuseFirst(new ApiError("UNAUTHORISED"));

    await expect(call).rejects.toMatchObject({code: "UNAUTHORISED"});
    expect(seen).toEqual(["user:sardor"]);              // never run again, and never under B
    expect(refreshCalls).toBe(0);                       // B's token was never refreshed for A's call
    expect(store.userId()).toBe("user:someone-else");   // and nobody was signed out over it
  });

  it("does not retry a call whose refresh succeeded while another user was signing in", async () => {
    const {fs, api, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");

    let resolveRefresh!: (s: Session) => void;
    api.refresh = () => new Promise((resolve) => { resolveRefresh = resolve; });
    api.failQueue = ["UNAUTHORISED"];
    const seen: string[] = [];
    const call = store.withSession(async (s) => { seen.push(s.userId); return api.profile(s); });
    await tick();                                       // the shared refresh is in flight, at A's generation

    // Hold every write, so the refresh's own save is still in flight when B signs in: the refresh
    // itself was never stale (the generation only moved after its staleness was checked), so this is
    // the one window a stale-refresh guard cannot see.
    const realWrite = fs.writeAtomic;
    let holding = true;
    const held: Array<() => void> = [];
    fs.writeAtomic = async (path, data) => {
      if (holding) await new Promise<void>((resolve) => { held.push(resolve); });
      return realWrite(path, data);
    };

    resolveRefresh({token: "token-refreshed", expiresAt: 9_999_999_999_999, userId: "user:sardor"});
    await tick();                                       // parked inside the refreshed session's save
    const signingIn = store.signIn("someone-else", "correct");
    await tick();
    holding = false;
    for (const release of held.splice(0)) release();
    expect(await signingIn).toEqual({ok: true});
    await tick();

    await expect(call).rejects.toMatchObject({code: "UNAUTHORISED"});
    expect(seen).toEqual(["user:sardor"]);              // the retry never ran
    expect(store.userId()).toBe("user:someone-else");
  });

  it("signs out even when the stored file cannot be deleted, and the leftover never resurrects the session", async () => {
    const {fs, make} = setup();
    const store = make();
    await store.signIn("sardor", "correct");
    const seen = vi.fn();
    store.onChange(seen);

    const realRemove = fs.remove;
    fs.remove = async () => { throw new Error("EPERM"); };
    await store.signOut();                            // resolves: a sign-out always signs out
    expect(store.current()).toBeNull();
    expect(store.userId()).toBeNull();
    expect(seen).toHaveBeenCalledWith(false);
    expect(fs.files.has(PATH)).toBe(true);            // the disk refused; the file is still there

    await store.restore();                            // and it must never come back as a session
    expect(store.current()).toBeNull();

    fs.remove = realRemove;                           // the disk comes back: the removal is retried
    await store.signOut();
    expect(fs.files.has(PATH)).toBe(false);
  });
});
