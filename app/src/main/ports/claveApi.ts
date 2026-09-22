import {z} from "zod";
import type {Competency, Skill} from "../../core/types";

export interface Session { token: string; expiresAt: number; userId: string }
export interface Taxonomy { version: string; skills: Skill[]; competencies: Competency[] }
export interface ApprovedStatement {
  clientItemId: string; statement: string; kind: "skill" | "competency"; targetId: string;
  createdAt: number; taxonomyVersion: string; pipelineVersion: string;
}

/**
 * Who is signed in, as the settings screen shows it. Each part is `null` when the account has none —
 * and all three are for a server from before it answered them, which the app must still work with.
 */
export interface Account { fullName: string | null; handle: string | null; email: string | null }
/** `names` is what the guard keeps out of statements; the rest is `Account`, optional for an older server. */
export interface Profile { names: string[]; fullName?: string | null; handle?: string | null; email?: string | null }

/** `RATE_LIMITED`: the server asked the app to slow down; the uploader's ordinary backoff applies. */
export type ApiErrorCode = "BAD_CREDENTIALS" | "UNAUTHORISED" | "OFFLINE" | "SERVER" | "BAD_RESPONSE" | "RATE_LIMITED";

/** A fixed code and nothing else: no server message, no request body, ever. */
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) { super(code); this.name = "ApiError"; }
}
export const apiCodeOf = (error: unknown): ApiErrorCode => (error instanceof ApiError ? error.code : "SERVER");

/** What the server says about one upload: ids it now holds, and ids it refused for good. An id in neither may be sent again. */
export interface SubmitResult { accepted: string[]; rejected?: string[] }

/** clave-back (sub-project D): `main/api/httpApi` in real builds, `stubApi` in stand-in modes. */
export interface ClaveApi {
  signIn(identifier: string, password: string): Promise<Session>;
  /** The second half of a browser sign-in: the one-time attempt id the server handed the app's listener, and the PKCE verifier whose challenge started it. */
  exchangeOAuthAttempt(attemptId: string, codeVerifier: string): Promise<Session>;
  refresh(session: Session): Promise<Session>;
  profile(session: Session): Promise<Profile>;
  taxonomy(session: Session, knownVersion?: string): Promise<Taxonomy | "unchanged">;
  /** `clientItemId` makes a repeated upload safe. Returns the ids the server now holds. */
  submitEvidence(session: Session, items: ApprovedStatement[]): Promise<SubmitResult>;
}

export const sessionShape = z.object({token: z.string().min(1), expiresAt: z.number().finite(), userId: z.string().min(1)});
export const taxonomyShape = z.object({
  version: z.string().min(1),
  skills: z.array(z.object({id: z.string().min(1), displayName: z.string().min(1), canonicalName: z.string().min(1), aliases: z.array(z.string())})),
  competencies: z.array(z.object({id: z.string().min(1), name: z.string().min(1), description: z.string()}))
});
export const approvedShape = z.object({
  clientItemId: z.string().min(1), statement: z.string().min(1), kind: z.enum(["skill", "competency"]), targetId: z.string().min(1),
  createdAt: z.number().finite(), taxonomyVersion: z.string().min(1), pipelineVersion: z.string().min(1)
});

export const namesShape = z.object({
  names: z.array(z.string()),
  fullName: z.string().nullable().optional(), handle: z.string().nullable().optional(), email: z.string().nullable().optional()
});
export const submitShape = z.object({accepted: z.array(z.string()), rejected: z.array(z.string()).optional()});

export const parseSession = (value: unknown): Session | null => { const p = sessionShape.safeParse(value); return p.success ? p.data : null; };
export const parseTaxonomy = (value: unknown): Taxonomy | null => { const p = taxonomyShape.safeParse(value); return p.success ? p.data : null; };
export const parseNames = (value: unknown): Profile | null => { const p = namesShape.safeParse(value); return p.success ? p.data : null; };
export const parseSubmit = (value: unknown): SubmitResult | null => { const p = submitShape.safeParse(value); return p.success ? p.data : null; };
/** The `Account` a profile answer describes: a blank part is no part, and a missing one is `null`. */
export const accountOf = (profile: Profile): Account => {
  const part = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null);
  return {fullName: part(profile.fullName), handle: part(profile.handle), email: part(profile.email)};
};
