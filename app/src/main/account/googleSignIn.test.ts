import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {createGoogleSignIn, googleLoginUrl, pkcePair, type LoopbackListener} from "./googleSignIn";
import type {SignInResult} from "./session";

interface FakeListener extends LoopbackListener { deliver(attemptId: string): void; closed: number; state: string }

function fakeListener(state: string, port = 49152): FakeListener {
  let resolve: ((v: {attemptId: string}) => void) | null = null;
  const promise = new Promise<{attemptId: string}>((r) => { resolve = r; });
  const listener: FakeListener = {
    port, state, closed: 0,
    callback: () => promise,
    close() { listener.closed += 1; },
    deliver(attemptId) { resolve?.({attemptId}); }
  };
  return listener;
}

function setup(opts: {openFails?: boolean} = {}) {
  const listeners: FakeListener[] = [];
  const opened: string[] = [];
  let states = 0;
  const google = createGoogleSignIn({
    baseUrl: "https://api.test",
    listen: async (state) => { const l = fakeListener(state, 49152 + listeners.length); listeners.push(l); return l; },
    openExternal: async (url) => { if (opts.openFails) throw new Error("no browser at /Applications/Secret.app"); opened.push(url); },
    randomState: () => `st4te-${++states}`,
    timeoutMs: 5 * 60_000
  });
  const exchanged: string[] = [];
  const verifiers: string[] = [];
  const exchange = async (attemptId: string, codeVerifier: string): Promise<SignInResult> => { exchanged.push(attemptId); verifiers.push(codeVerifier); return attemptId === "att-ok" ? {ok: true} : {ok: false, code: "UNAUTHORISED"}; };
  return {google, listeners, opened, exchanged, verifiers, exchange};
}

describe("browser sign-in through Google", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("pins the address the browser is sent to: clave-back's Google login with the loopback return URL, the state inside it, and the PKCE challenge", () => {
    expect(googleLoginUrl("https://api.test", 49152, "st4te-1", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"))
      .toBe("https://api.test/api/security/login/google?returnUrl=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback%3Fstate%3Dst4te-1&codeChallenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(googleLoginUrl("https://api.test", 1, "a b&c", "c")).toContain(encodeURIComponent("state=a%20b%26c"));
  });

  it("derives the PKCE pair the way RFC 7636 does (S256, appendix B vector), fresh each time", () => {
    const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const pair = pkcePair(() => Buffer.from(rfcVerifier, "base64url"));
    expect(pair).toEqual({verifier: rfcVerifier, challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"});
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier, "ascii").digest("base64url"));
  });

  it("listens, opens the browser, exchanges what comes back, and closes the listener", async () => {
    const {google, listeners, opened, exchanged, verifiers, exchange} = setup();
    const done = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.state).toBe("st4te-1");
    // The challenge in the URL is the hash of the verifier later handed to the exchange, and nothing else ever sees the verifier.
    const challenge = new URL(opened[0]!).searchParams.get("codeChallenge")!;
    expect(opened).toEqual([googleLoginUrl("https://api.test", 49152, "st4te-1", challenge)]);
    listeners[0]!.deliver("att-ok");
    expect(await done).toEqual({ok: true});
    expect(exchanged).toEqual(["att-ok"]);
    expect(verifiers).toHaveLength(1);
    expect(createHash("sha256").update(verifiers[0]!, "ascii").digest("base64url")).toBe(challenge);
    expect(opened[0]).not.toContain(verifiers[0]!);
    expect(listeners[0]!.closed).toBe(1);
  });

  it("hands a refused exchange back unchanged", async () => {
    const {google, listeners, exchange} = setup();
    const done = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    listeners[0]!.deliver("att-bad");
    expect(await done).toEqual({ok: false, code: "UNAUTHORISED"});
    expect(listeners[0]!.closed).toBe(1);
  });

  it("gives up after the timeout with OAUTH_TIMEOUT, closes the listener and exchanges nothing", async () => {
    const {google, listeners, exchanged, exchange} = setup();
    const done = google.start(exchange);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await done).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    expect(exchanged).toEqual([]);
    expect(listeners[0]!.closed).toBe(1);
    // A late callback is ignored: the listener is gone and nothing is exchanged.
    listeners[0]!.deliver("att-ok");
    await vi.advanceTimersByTimeAsync(0);
    expect(exchanged).toEqual([]);
  });

  it("cancel ends the wait the same way", async () => {
    const {google, listeners, exchanged, exchange} = setup();
    const done = google.start(exchange);
    await vi.advanceTimersByTimeAsync(1_000);
    google.cancel();
    expect(await done).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    expect(exchanged).toEqual([]);
    expect(listeners[0]!.closed).toBe(1);
    google.cancel();                                       // nothing in flight: harmless
  });

  it("a browser that cannot be opened answers OAUTH_BROWSER without leaking why, and closes the listener", async () => {
    const {google, listeners, exchange} = setup({openFails: true});
    const result = await google.start(exchange);
    expect(result).toEqual({ok: false, code: "OAUTH_BROWSER"});
    expect(JSON.stringify(result)).not.toContain("Secret");
    expect(listeners[0]!.closed).toBe(1);
  });

  it("starting again cancels the sign-in in flight and uses a fresh state and port", async () => {
    const {google, listeners, opened, exchange} = setup();
    const first = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    const second = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    expect(listeners).toHaveLength(2);
    expect(listeners[1]!.state).toBe("st4te-2");
    expect(opened[1]).toContain("49153");
    // A fresh PKCE pair per start: the second URL carries a different challenge.
    expect(new URL(opened[1]!).searchParams.get("codeChallenge")).not.toBe(new URL(opened[0]!).searchParams.get("codeChallenge"));
    listeners[1]!.deliver("att-ok");
    expect(await second).toEqual({ok: true});
    expect(listeners[0]!.closed).toBe(1);
    expect(listeners[1]!.closed).toBe(1);
  });

  it("a loopback port that cannot be bound answers OAUTH_BROWSER and carries no address", async () => {
    const google = createGoogleSignIn({baseUrl: "https://api.test", listen: async () => { throw new Error("listen EADDRNOTAVAIL 127.0.0.1:0"); }, openExternal: async () => undefined, randomState: () => "s", timeoutMs: 1000});
    const result = await google.start(async () => ({ok: true}));
    expect(result).toEqual({ok: false, code: "OAUTH_BROWSER"});
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("two starts in the same tick: the first is cancelled while still binding, and cancel still reaches the second", async () => {
    const {google, listeners, exchanged, exchange} = setup();
    const first = google.start(exchange);
    const second = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    expect(listeners[0]!.closed).toBe(1);
    google.cancel();
    expect(await second).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    listeners[1]!.deliver("att-ok");
    await vi.advanceTimersByTimeAsync(0);
    expect(exchanged).toEqual([]);
    expect(listeners[1]!.closed).toBe(1);
  });

  it("a cancel that arrives while the port is still being bound ends the run without opening a browser", async () => {
    const {google, opened, exchange} = setup();
    const done = google.start(exchange);
    google.cancel();
    expect(await done).toEqual({ok: false, code: "OAUTH_TIMEOUT"});
    expect(opened).toEqual([]);
  });

  it("every result is a code: no state, port or attempt id in any of them", async () => {
    const {google, listeners, exchange} = setup();
    const done = google.start(exchange);
    await vi.advanceTimersByTimeAsync(0);
    listeners[0]!.deliver("att-bad");
    const dump = JSON.stringify(await done);
    for (const secret of ["st4te", "49152", "att-bad"]) expect(dump).not.toContain(secret);
  });
});
