import {z} from "zod";
import {API_TAXONOMY_TIMEOUT_MS, API_TIMEOUT_MS} from "../constants";
import {ApiError, parseNames, parseSession, parseSubmit, parseTaxonomy, type ApiErrorCode, type ApprovedStatement, type ClaveApi, type Session, type SubmitResult, type Taxonomy} from "../ports/claveApi";

/**
 * clave-back over HTTP. Every answer is checked against the port's shapes before it is believed,
 * every call has a deadline, and nothing the server or the user wrote ever leaves this module inside
 * an error: a failure is one of the fixed `ApiErrorCode`s and nothing else.
 *
 * clave-back answers HTTP 200 with an envelope `{successful, error{code}, data}` for almost
 * everything, and bare 401/403 only when the token itself is refused; the mapping below reads both.
 */
export interface HttpApiDeps {
  /** Origin only, no trailing slash: `https://api.clave.co`. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeouts?: {callMs: number; taxonomyMs: number};
}

/** clave-back refuses a larger upload whole; the outbox is sent in pieces of this size and the answers merged. */
export const SUBMIT_CHUNK = 50;

/** clave-back's `ErrorCode` values the client tells apart; everything else is `SERVER`. */
const ENVELOPE = {badRequest: 3, notFound: 5, unauthorized: 6, invalidToken: 8, tooManyRequests: 11} as const;

const envelopeShape = z.object({
  successful: z.boolean(),
  error: z.object({code: z.number().optional().nullable()}).nullable().optional(),
  data: z.unknown().optional()
});
const authShape = z.object({accountId: z.string().min(1), accessToken: z.object({value: z.string().min(1)})});
const attemptShape = z.object({isSuccessful: z.boolean(), accountId: z.string().optional().nullable(), accessToken: z.object({value: z.string().min(1)}).optional().nullable()});
const taxonomyAnswerShape = z.object({version: z.string().min(1), unchanged: z.boolean(), skills: z.unknown().optional(), competencies: z.unknown().optional()});

/** The `exp` claim of a JWT, in ms, read without verifying anything: the app only schedules its refresh from it. */
export function jwtExpiresAtMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const exp = (payload as {exp?: unknown} | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
}

/** A Session from clave-back's auth answer, or null when any part of it is not what a session needs. */
export function sessionFrom(data: unknown): Session | null {
  const auth = authShape.safeParse(data);
  if (!auth.success) return null;
  const expiresAt = jwtExpiresAtMs(auth.data.accessToken.value);
  if (expiresAt === null) return null;
  return parseSession({token: auth.data.accessToken.value, expiresAt, userId: auth.data.accountId});
}

/** The wire form of an approved statement: clave-back's names, the time it was written as an ISO UTC instant. */
export function wireItem(item: ApprovedStatement): Record<string, unknown> {
  const approved = new Date(item.createdAt);
  // A time the server's parser would refuse (outside years 1–9999) is sent as null: the server then refuses that
  // one item for good instead of refusing the whole request, which the app would retry for ever.
  const year = Number.isNaN(approved.getTime()) ? 0 : approved.getUTCFullYear();
  return {
    clientItemId: item.clientItemId, statement: item.statement, kind: item.kind, targetId: item.targetId,
    datetimeWritten: year >= 1 && year <= 9999 ? approved.toISOString() : null,
    taxonomyVersion: item.taxonomyVersion, pipelineVersion: item.pipelineVersion
  };
}

type Route = "login" | "other";

export function createHttpApi(deps: HttpApiDeps): ClaveApi {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeouts = deps.timeouts ?? {callMs: API_TIMEOUT_MS, taxonomyMs: API_TAXONOMY_TIMEOUT_MS};
  const url = (path: string) => `${deps.baseUrl}${path}`;

  /**
   * One request, answered as the envelope's `data` or thrown as an ApiError. `route` is the only
   * context the mapping needs: a refused password arrives as an envelope error on the login route.
   */
  async function call(method: "GET" | "POST" | "PUT", path: string, opts: {session?: Session; body?: unknown; timeoutMs?: number; route?: Route} = {}): Promise<unknown> {
    const headers: Record<string, string> = {Accept: "application/json"};
    if (opts.session) headers.Authorization = `Bearer ${opts.session.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method, headers, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? timeouts.callMs),
        ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {})
      });
    } catch { throw new ApiError("OFFLINE"); }               // no connection, a timeout, a redirect: nothing was answered
    if (response.status === 401 || response.status === 403) throw new ApiError("UNAUTHORISED");
    // A login the server could not even parse (an identifier that is not an email) reads as a mismatch, not an outage.
    if (response.status === 400 && opts.route === "login") throw new ApiError("BAD_CREDENTIALS");
    if (response.status < 200 || response.status >= 300) throw new ApiError("SERVER");
    let text: string;
    try { text = await response.text(); } catch { throw new ApiError("OFFLINE"); }
    let json: unknown;
    try { json = JSON.parse(text) as unknown; } catch { throw new ApiError("BAD_RESPONSE"); }
    const envelope = envelopeShape.safeParse(json);
    if (!envelope.success) throw new ApiError("BAD_RESPONSE");
    if (!envelope.data.successful) throw new ApiError(codeOf(envelope.data.error?.code ?? null, opts.route ?? "other"));
    return envelope.data.data;
  }

  function codeOf(code: number | null, route: Route): ApiErrorCode {
    if (code === ENVELOPE.tooManyRequests) return "RATE_LIMITED";
    if (code === ENVELOPE.invalidToken) return "UNAUTHORISED";
    if (route === "login" && (code === ENVELOPE.badRequest || code === ENVELOPE.notFound || code === ENVELOPE.unauthorized)) return "BAD_CREDENTIALS";
    if (code === ENVELOPE.unauthorized) return "UNAUTHORISED";
    return "SERVER";
  }

  /** Never throws anything but an ApiError: a string the URL cannot carry (a lone surrogate) is refused as the given code. */
  const encoded = (value: string, code: ApiErrorCode): string => {
    try { return encodeURIComponent(value); } catch { throw new ApiError(code); }
  };

  const sessionOrBad = (data: unknown): Session => {
    const session = sessionFrom(data);
    if (!session) throw new ApiError("BAD_RESPONSE");
    return session;
  };

  return {
    async signIn(identifier, password) {
      const who = identifier.trim();
      const body = who.includes("@") ? {email: who, password} : {handle: who, password};
      return sessionOrBad(await call("POST", "/api/security/login", {body, route: "login"}));
    },
    async exchangeOAuthAttempt(attemptId, codeVerifier) {
      const data = await call("GET", `/api/security/oAuthAttempt/${encoded(attemptId, "UNAUTHORISED")}?codeVerifier=${encoded(codeVerifier, "UNAUTHORISED")}`);
      const attempt = attemptShape.safeParse(data);
      if (!attempt.success) throw new ApiError("BAD_RESPONSE");
      // The server records a refused attempt (no account for that Google email, wrong provider) as a successful lookup of an unsuccessful attempt.
      if (!attempt.data.isSuccessful || !attempt.data.accessToken || !attempt.data.accountId) throw new ApiError("UNAUTHORISED");
      return sessionOrBad({accountId: attempt.data.accountId, accessToken: attempt.data.accessToken});
    },
    async refresh(session) {
      return sessionOrBad(await call("PUT", "/api/security/refresh", {session}));
    },
    async profile(session) {
      const names = parseNames(await call("GET", "/api/agent/profile", {session}));
      if (!names) throw new ApiError("BAD_RESPONSE");
      return names;
    },
    async taxonomy(session, knownVersion) {
      const query = knownVersion ? `?knownVersion=${encoded(knownVersion, "BAD_RESPONSE")}` : "";
      const data = await call("GET", `/api/agent/taxonomy${query}`, {session, timeoutMs: timeouts.taxonomyMs});
      const answer = taxonomyAnswerShape.safeParse(data);
      if (!answer.success) throw new ApiError("BAD_RESPONSE");
      if (answer.data.unchanged) return "unchanged";
      const taxonomy: Taxonomy | null = parseTaxonomy({version: answer.data.version, skills: answer.data.skills, competencies: answer.data.competencies});
      if (!taxonomy) throw new ApiError("BAD_RESPONSE");
      return taxonomy;
    },
    async submitEvidence(session, items) {
      const merged: SubmitResult = {accepted: [], rejected: []};
      for (let start = 0; start < items.length; start += SUBMIT_CHUNK) {
        const chunk = items.slice(start, start + SUBMIT_CHUNK);
        let result: SubmitResult | null;
        try {
          result = parseSubmit(await call("POST", "/api/agent/evidence", {session, body: {items: chunk.map(wireItem)}}));
        } catch (error) {
          // The first piece failing is the request failing. A later piece failing keeps what the earlier
          // ones achieved: those statements are on the server and belong in the sent log now, not after
          // a backoff that would only be answered "accepted" again.
          if (start === 0) throw error;
          return merged;
        }
        if (!result) { if (start === 0) throw new ApiError("BAD_RESPONSE"); return merged; }
        merged.accepted.push(...result.accepted);
        merged.rejected!.push(...(result.rejected ?? []));
      }
      return merged;
    }
  };
}
