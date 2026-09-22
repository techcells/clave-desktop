# Ledger: sub-project D (clave-back API + the app's real ClaveApi client)

Started 2026-09-21. Kept under docs/ because scratchpad ledgers were lost to reboots twice.

## Owner statements (verbatim, dated)

- 2026-09-21 (session brief): "evidence from the desktop app is NOT tied to a huddle. clave-back needs a
  second evidence kind keyed by accountId only (no huddleId), written through the app's small API; the
  existing huddle-bound records stay untouched."
- 2026-09-21: "Do NOT use any `superpowers:*` skill"; "ONE action or ONE question per message; results
  first, the single question last."
- 2026-09-21: clave-back: "NEVER create branches, commit, push or open PRs unless he explicitly asks in
  that turn; stop at the working tree and report."

- 2026-09-21, Q1 (label or blend desktop evidence on the profile): "label it". Consequence: a third
  `CallEvidenceSource` value for the desktop app (working name `DesktopAgent`), exposed through the
  existing `ProfileEvidenceDto.Source`.

- 2026-09-21, Q2 (sign-in for v1): "password and only google oauth for v1". Consequence: the app keeps
  identifier/password AND gains a Google sign-in through the system browser and the existing OAuth
  attempt-id exchange; LinkedIn and Microsoft are out of v1. The port needs one new method (exchange an
  attempt id for a Session), the sign-in screen a second button, WHAT-LEAVES a new row. How the attempt
  id gets back to the app (loopback page vs custom link) is a design choice still to be proposed.

- 2026-09-21, Q3 (usage counts): "out of scope for D". Consequence: WHAT-LEAVES keeps "no usage data";
  adoption is read from evidence rows on the backend; no telemetry endpoint in D.

## Facts found while reading (2026-09-21)

- clave-back working tree is on branch `prod`, clean.
- The brief's picture of clave-back is out of date. Commit 5d8e639 (2026-09-17, "add private-recording
  evidence source with no playable call link") already made `CallEvidence.huddleId` optional and added
  `source` (enum CallEvidenceSource: Huddle = 1, PrivateRecording) and `privateSourceKey`; added
  `PUT api/profile/account/{accountId}/private-extraction/{sourceKey}` (permission
  CanManageOtherTalents, replace-by-key, rejects sayings, validates ids against normalizedSkills /
  expertises / competencies, ensures talent skills, notifies); `ProfileEvidenceDto` already exposes
  `Source` and a nullable `HuddleId`; tests in `ProfileServicePrivateExtractionTests.cs`.
  Consequence: D's storage half is "one more source value + a self-service endpoint", not a new collection.
- That endpoint cannot be used by the app as is: it needs an admin permission, takes accountId from the
  route, and REPLACES a key's rows; the app needs the signed-in user's own account from the JWT and
  append-with-idempotency by `clientItemId`.
- Login: `POST api/security/login` takes exactly one of `email` / `handle` plus `password`
  (`LoginRequest`), answers `AuthResponse {accountId, email, accessToken: TokenResponse, ...}`.
  Refresh is `PUT api/security/refresh` (the brief said POST) with the bearer token.
- No existing endpoint serves the whole taxonomy to an ordinary user: `normalizedSkill/all` and
  `by-ids` need `CanListSkills`; competencies have by-id / by-category / by-handle only.
  `NormalizedSkill` has canonicalName, displayName, aliases, status; `Competency` has name,
  description, aliases, status. The app's `taxonomyShape` maps onto these directly.
- The app's contract: `app/src/main/ports/claveApi.ts`; WHAT-LEAVES lists exactly five kinds of
  traffic to Clave and "no usage data".

## Rulings made on the owner's behalf (with cost if wrong)

(none yet)

## Open questions, in the order they will be asked

1. Label or blend on the profile (decides whether a new `source` value is added).
2. Sign-in: identifier/password only for v1, or OAuth attempt-id handoff now.
3. Usage counts: in or out of scope for D (WHAT-LEAVES says "no usage data").
4. Taxonomy serving and versioning.
5. submitEvidence limits and validation.
6. Deletion of uploaded evidence.
7. Dev environment and base URL.
