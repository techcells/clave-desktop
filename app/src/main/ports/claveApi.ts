import {z} from "zod";
import type {Competency, Skill} from "../../core/types";

export interface Session { token: string; expiresAt: number; userId: string }
export interface Taxonomy { version: string; skills: Skill[]; competencies: Competency[] }
export interface ApprovedStatement {
  clientItemId: string; statement: string; kind: "skill" | "competency"; targetId: string;
  createdAt: number; taxonomyVersion: string; pipelineVersion: string;
}

export type ApiErrorCode = "BAD_CREDENTIALS" | "UNAUTHORISED" | "OFFLINE" | "SERVER" | "BAD_RESPONSE";

/** A fixed code and nothing else: no server message, no request body, ever. */
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) { super(code); this.name = "ApiError"; }
}
export const apiCodeOf = (error: unknown): ApiErrorCode => (error instanceof ApiError ? error.code : "SERVER");

/** clave-back (sub-project D). `stubApi` stands in until it exists. */
export interface ClaveApi {
  signIn(identifier: string, password: string): Promise<Session>;
  refresh(session: Session): Promise<Session>;
  profile(session: Session): Promise<{names: string[]}>;
  taxonomy(session: Session, knownVersion?: string): Promise<Taxonomy | "unchanged">;
  /** `clientItemId` makes a repeated upload safe. Returns the ids the server now holds. */
  submitEvidence(session: Session, items: ApprovedStatement[]): Promise<{accepted: string[]}>;
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

export const parseSession = (value: unknown): Session | null => { const p = sessionShape.safeParse(value); return p.success ? p.data : null; };
export const parseTaxonomy = (value: unknown): Taxonomy | null => { const p = taxonomyShape.safeParse(value); return p.success ? p.data : null; };
