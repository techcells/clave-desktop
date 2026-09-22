import {ApiError, type ClaveApi, type Session, type Taxonomy} from "../main/ports/claveApi";
import type {FileSystem, Now} from "../main/ports/system";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * STAND-IN for clave-back (sub-project D). Accepts any sign-in, serves a local taxonomy, and
 * appends every upload to a local file so it can be inspected. Never part of a production build.
 */
export function createStubApi(deps: {fs: FileSystem; uploadsPath: string; taxonomy: Taxonomy; now: Now}): ClaveApi & {readonly standIn: true} {
  const {fs, uploadsPath, taxonomy, now} = deps;
  const encoder = new TextEncoder();
  const session = (userId: string): Session => ({token: `stub-${userId}-${now()}`, expiresAt: now() + WEEK_MS, userId});
  return {
    standIn: true,
    async signIn(identifier, password) {
      if (!identifier.trim() || !password) throw new ApiError("BAD_CREDENTIALS");
      return session(`stub:${identifier.trim().toLowerCase()}`);
    },
    async exchangeOAuthAttempt(attemptId, codeVerifier) {
      if (!attemptId.trim() || !codeVerifier.trim()) throw new ApiError("UNAUTHORISED");
      return session("stub:google");
    },
    async refresh(old) { return session(old.userId); },
    async profile(s) { return {names: [s.userId.replace(/^stub:/, "")]}; },
    async taxonomy(_s, knownVersion) { return knownVersion === taxonomy.version ? "unchanged" : taxonomy; },
    async submitEvidence(s, items) {
      for (const item of items) await fs.append(uploadsPath, encoder.encode(`${JSON.stringify({receivedAt: now(), userId: s.userId, item})}\n`));
      return {accepted: items.map((item) => item.clientItemId)};
    }
  };
}
