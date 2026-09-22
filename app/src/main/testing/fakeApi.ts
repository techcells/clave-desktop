import {ApiError, type ApiErrorCode, type ApprovedStatement, type ClaveApi, type Session, type Taxonomy} from "../ports/claveApi";

export interface FakeApi extends ClaveApi {
  /** Set to make the next calls fail with this code; `null` to succeed again. */
  failWith: ApiErrorCode | null;
  /** Codes to fail with, one per call, before `failWith` applies. */
  failQueue: ApiErrorCode[];
  taxonomyValue: Taxonomy;
  names: string[];
  submitted: ApprovedStatement[][];
  calls: string[];
  tokenCounter: number;
}

export const TAXONOMY_V1: Taxonomy = {
  version: "tax-1",
  skills: [
    {id: "pg", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]},
    {id: "redis", displayName: "Redis", canonicalName: "redis", aliases: []}
  ],
  competencies: [{id: "cp1", name: "Problem Solving", description: "Breaks a problem down and resolves it"}]
};

export function createFakeApi(now: () => number): FakeApi {
  const fail = (api: FakeApi) => {
    const code = api.failQueue.shift() ?? api.failWith;
    if (code) throw new ApiError(code);
  };
  const session = (api: FakeApi, userId: string): Session => ({token: `token-${++api.tokenCounter}`, expiresAt: now() + 7 * 24 * 60 * 60_000, userId});
  const api: FakeApi = {
    failWith: null, failQueue: [], taxonomyValue: TAXONOMY_V1, names: ["Sardor Astanov"], submitted: [], calls: [], tokenCounter: 0,
    async signIn(identifier, password) {
      api.calls.push("signIn"); fail(api);
      if (password !== "correct") throw new ApiError("BAD_CREDENTIALS");
      return session(api, `user:${identifier}`);
    },
    async exchangeOAuthAttempt(attemptId) {
      api.calls.push("exchangeOAuthAttempt"); fail(api);
      if (attemptId !== "attempt-ok") throw new ApiError("UNAUTHORISED");
      return session(api, "user:google");
    },
    async refresh(old) { api.calls.push("refresh"); fail(api); return session(api, old.userId); },
    async profile() { api.calls.push("profile"); fail(api); return {names: api.names}; },
    async taxonomy(_session, knownVersion) {
      api.calls.push("taxonomy"); fail(api);
      return knownVersion === api.taxonomyValue.version ? "unchanged" : api.taxonomyValue;
    },
    async submitEvidence(_session, items) {
      api.calls.push("submitEvidence"); fail(api);
      api.submitted.push(items);
      return {accepted: items.map((item) => item.clientItemId)};
    }
  };
  return api;
}
