import type {SignInResult} from "./session";

/**
 * A browser sign-in, RFC 8252 style. The app listens once on 127.0.0.1 at a random port, sends the
 * user's own browser to clave-back's Google sign-in with that address as the return URL, and waits
 * for the browser to come back with a one-time attempt id, which the caller's `exchange` turns into
 * a session. Everything that touches the machine (the socket, the browser) is injected, so the whole
 * dance is tested with fakes, and the shell provides the real pieces.
 *
 * What can go wrong is answered with a code and nothing else. The state nonce, the port and the
 * attempt id never appear in a result.
 */
export interface LoopbackListener {
  port: number;
  /** Resolves once, with the attempt id of the first request whose state matched. Never rejects; never resolves for anything else. */
  callback(): Promise<{attemptId: string}>;
  close(): void;
}

export interface GoogleSignInDeps {
  /** clave-back's origin, no trailing slash. */
  baseUrl: string;
  listen: (expectedState: string) => Promise<LoopbackListener>;
  openExternal: (url: string) => Promise<void>;
  randomState: () => string;
  timeoutMs: number;
}

export interface GoogleSignIn {
  /** Starts a sign-in; a sign-in already in flight is cancelled first. `exchange` is the caller's own way of turning the attempt id into a signed-in session. */
  start(exchange: (attemptId: string) => Promise<SignInResult>): Promise<SignInResult>;
  cancel(): void;
}

/** The address the browser is sent to. Exported so the URL shape is pinned by a test, not by reading the code. */
export function googleLoginUrl(baseUrl: string, port: number, state: string): string {
  const returnUrl = `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}`;
  return `${baseUrl}/api/security/login/google?returnUrl=${encodeURIComponent(returnUrl)}`;
}

export function createGoogleSignIn(deps: GoogleSignInDeps): GoogleSignIn {
  let cancelCurrent: (() => void) | null = null;

  return {
    async start(exchange) {
      cancelCurrent?.();
      // Registered before the first await, so a cancel (or a second start) reaches this run even while its port is still being bound.
      const run: {cancelled: boolean; wake: (() => void) | null} = {cancelled: false, wake: null};
      const mine = () => { run.cancelled = true; run.wake?.(); };
      cancelCurrent = mine;
      const state = deps.randomState();
      let listener: LoopbackListener;
      // A loopback port that cannot be bound is answered as a code, like everything else here: the socket error names an address.
      try { listener = await deps.listen(state); } catch { if (cancelCurrent === mine) cancelCurrent = null; return {ok: false, code: "OAUTH_BROWSER"}; }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const gaveUp = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deps.timeoutMs);
        run.wake = () => resolve("timeout");
        if (run.cancelled) resolve("timeout");
      });
      try {
        if (run.cancelled) return {ok: false, code: "OAUTH_TIMEOUT"};   // cancelled while the port was being bound: no browser
        try { await deps.openExternal(googleLoginUrl(deps.baseUrl, listener.port, state)); }
        catch { return {ok: false, code: "OAUTH_BROWSER"}; }
        const outcome = await Promise.race([listener.callback(), gaveUp]);
        if (outcome === "timeout" || run.cancelled) return {ok: false, code: "OAUTH_TIMEOUT"};
        return await exchange(outcome.attemptId);
      } finally {
        if (timer) clearTimeout(timer);
        // Only this run's own handle is cleared: a run started after this one has registered its own by now.
        if (cancelCurrent === mine) cancelCurrent = null;
        listener.close();
      }
    },
    cancel() { cancelCurrent?.(); }
  };
}
