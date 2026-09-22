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

- 2026-09-22, Q4 (taxonomy versioning): "let's go with your recommendation" = server-derived content hash
  over active skills + competencies (ids, names, aliases, descriptions), cached server-side ~1 h; matching
  `knownVersion` answers "unchanged" with no body; one response, no paging; targets validated against the
  CURRENT list, the version on an upload is recorded only.

- 2026-09-22, Q5 (submitEvidence rules): "these rules are fine" = unique index (accountId, clientItemId),
  repeat answered as accepted; statement 1-300 chars trimmed; kind skill|competency; target must exist and
  be active in the CURRENT list, else permanently rejected in a separate `rejected` list the app drops
  from the outbox with a fixed log code; max 50 items/request, 200 accepted/account/day, 429 -> app backoff.
  Note: the port's `{accepted: string[]}` answer gains an optional `rejected: string[]`.

- 2026-09-22, Q6 (deletion): "no delete in v1" = no app delete, no backend delete endpoint in D; the
  Sent list stays a read-only record; withdrawal is a later web-profile feature.

- 2026-09-22, Q7 (environment/base URL): "agreed, dev is https://api.d.clave.co and prod
  https://api.clave.co". = prod URL a compile-time constant; one dev switch `CLAVE_API_URL` (dead when
  packaged; https or loopback http only); development first against a local clave-back, then the dev
  deployment.

- 2026-09-22, design: "approved" (as written, all seven rulings in §5 stand).

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

- 2026-09-22 12:15 local: a `.git` folder with ONE commit (e97e2d1) appeared in asset-to-evidence,
  working tree 1 file changed. Not made by this session (which only read and edited docs). The rule
  on file is "no git here"; reported to the owner, nothing done about it.

## Task 0 findings (2026-09-22, clave-back read-only)

1. Guest gate (`RedisPermissionMiddleware`): only GUEST-GRADE accounts (no password, no OAuth
   provider, email not verified — i.e. made by a room create/claim) are blocked, and only on
   non-GET requests outside an allowlist. GET `api/agent/*` passes for everyone; POST
   `api/agent/evidence` 403s for a guest-grade account, which cannot sign in to the app anyway
   (no password, no Google). No exemption needed.
2. Wrong password at login → `ErrorCode.BadRequest` (3) with a generic message. `BAD_CREDENTIALS`
   maps BadRequest on the login route (design §4.2 already lists it).
3. The profile page builds its skill/competency tags FROM THE EVIDENCE ROWS (`BuildSkillTagsAsync`),
   not from `talentSkills`. Desktop evidence is visible without any talent-skill upsert.
   → Ruling R3 AMENDED: the desktop path runs NO follow-ups (no `EnsureTalentSkills`, whose only
   label would be the wrong `TalentSkillSource.Call`; no "skill added" notification after the user's
   own approval; no credibility check). Cost if wrong: the talent's skill list used elsewhere
   (matching/search) does not gain the skill; adding a `TalentSkillSource.DesktopAgent` later is one
   enum value and one call.
4. JWT lifetime (`Jwt-ExpirationMinutes`) is a deployment secret (infra manifest), not in the repo;
   the app's rule (refresh when < 24 h left, and on one UNAUTHORISED) works for any value. Ask the
   owner for the dev/prod value at Task 5 only if refreshes look odd.
5. Dev deployment gets the routes only once clave-back is deployed there; local server first.

## Interlude 2026-09-22: packaging's change request (before Task 1)

Owner forwarded packaging's five-item request for app.ts (its ledger: `docs/superpowers/plans/2026-09-22-packaging-files/ledger.md`).
Done: (1) FLAVOUR read from `shared/flavour`; (2) start guard via new pure `shell/launchMode.ts`
(7 tests, 5 mutations caught) — internal = stub API + real reader + real model, release refused
NO_READER_YET until D, unpackaged unchanged, `production = MODE.production`; (3) fixture read only
when the dev reader is the reader (`standInReader()`); (4) `shell/translocation.ts` (3 tests, 1
mutation caught) + `AppInfo.translocated?` + the router's requestPermission is a no-op when
translocated. Suite 3018/94, typecheck clean, SMOKE OK. (5) `openLicences` IPC done after the
owner's "go ahead and add the two renderer lines" (bridge.ts, mockBridge.ts); pure `shell/licences.ts`.
Review (independent): approve with reservations; 46 mutations, 8 survived, all in test gaps; the two
gaps closed ("1" vs "0" switches; /var/folders negative) and re-proved by mutation. Final: suite
3050/96, typecheck clean, SMOKE OK. Packaging ledger appended.
Ruling: `AppInfo.translocated` is OPTIONAL so packaging's renderer mock keeps compiling; cost: a
renderer that forgets to read it shows onboarding as before (packaging's Task 9 owns that screen).

## Task 1 (clave-back model, mapping, cleanup, index) — 2026-09-22

Baseline: build 0 errors, tests 1264 passed / 5 skipped (`dotnet test TeamEx.Test/TeamEx.Test.csproj`;
SDK 10.0.401 builds the net8.0 targets). Changed: `CallEvidenceSource`/`Dto` + `DesktopAgent = 3`;
`CallEvidence` + clientItemId, datetimeApproved, taxonomyVersion, pipelineVersion (BsonIgnoreIfNull);
`ProfileService.ToEvidenceDtosAsync` (DesktopAgent maps like private, own label, null source still
Huddle); `TalentContentCleanupService` deletes desktop rows on account cleanup; new
`CallEvidenceIndexInitializer` (unique partial `accountId_clientItemId_unique` on $type string;
`accountId_source_datetimeInserted`) registered in the BackgroundProcessor bootstrapper. Tests: 5 new
+ 1 extended; each proved by reverting its fix (5 mutations, all caught). Suite 1269 / 5 skipped.
Working tree only; no git action. Review (independent, 18 mutations): approve with reservations —
5 survivors, all test gaps or equivalent: enum-value parity (M8/M9), legacy null-source rows keeping
their call link (M10), band index Background (M13), one equivalent (M16). Closed M8/M9/M10/M13 with
three test additions, each re-proved by mutation; stale comments updated; design index name aligned.
Carried: FRONT-END follow-up (clave-front shows a non-private row as a call with an empty peer —
recorded in design §3.2); Task 3 note: `DeleteManyAsync` is a soft delete, so a soft-deleted desktop
row keeps its clientItemId in the unique index — the existence pre-check must include soft-deleted
rows or rely on DuplicateKey (design rule 5 already treats DuplicateKey as accepted).
INCIDENT: the reviewer subagent read the DEV MongoDB through the connector (counts and index names of
`callEvidences`, 412 docs) without the owner having asked; read-only, nothing written, prod refused
auth. Reported to the owner; future review briefs will say "no database access".

## Task 2 (clave-back taxonomy + profile names service) — 2026-09-22

New: `TeamEx.Dto/Agent/Response/*` (4 DTOs), `IAgentService`, `AgentService` (registered scoped),
tests `AgentServiceTaxonomyTests` (6) + `AgentServiceProfileTests` (3). Version = first 16 hex of
SHA-256 over sorted skills (id, displayName, canonicalName, aliases) + competencies (id, name,
description); cached 60 min in IMemoryCache under one key. Rulings: R8 rows with an empty
displayName/canonicalName/name are LEFT OUT (logged as a count) because the app's zod shape would
refuse the whole list otherwise — cost: such a skill is unmatchable until named; R9 `knownVersion`
null/empty never counts as known. A test caught a real defect before review (full name composed from
untrimmed parts → double space) — fixed. 8 mutations, all caught. Suite 1279 / 5 skipped. Review (independent, 41 mutations, no DB access): approve with
reservations — 11 survivors: 7 real test gaps (version blind to displayName/canonicalName/ids,
competency sort, composite name masked by fixture, profile catch → success, blank aliases), 4
equivalent. All 7 closed with tests. Ruling R10: filter on `Status == Active` only (CLAUDE.md), not
`IsActive` — design amended. Unauthorized for a vanished account kept, with a WHY comment.

## Task 3 (clave-back SubmitEvidenceAsync) — 2026-09-22

New: `TeamEx.Dto/Agent/Request/{AgentEvidenceRequest,AgentEvidenceItemRequest}`,
`Response/AgentEvidenceResponse {accepted, rejected}`, `AgentService.SubmitEvidenceAsync` (+ evidence
repository injected), tests `AgentServiceEvidenceTests` (13 facts/theories, 26 cases). Rules as
designed: 1–50 items else ValidationError; per-item rejects (statement empty/>300 trimmed, kind not
exactly "skill"/"competency", targetId not an ObjectId or not Active for that kind, missing
datetimeApproved/taxonomyVersion/pipelineVersion, clientItemId empty/>128 → dropped unnamed);
same id twice in a batch = first wins; held ids (INCLUDING soft-deleted, via
FindManyIncludeDeletedAsync) answered accepted without insert; daily cap = this account's
DesktopAgent rows in the last rolling 24 h + fresh > 200 → TooManyRequests, whole request refused;
rows inserted via the repository; on any MongoException during insert the held set is re-read and
only ids now held are answered accepted (the rest in neither list → app resends). Ruling R11: no
[Required]/model-binding attributes on the item DTO so one malformed item can never 400 the batch;
R12: DatetimeApproved stored as UTC. Review (independent, 44 mutations, no DB; rendered the filters
through the real driver in a scratch project): approve with reservations — 8 survivors: 3 real test
gaps around production-critical guards the mock cannot see (empty-insert early return, ObjectId
guard, competency Status), 1 minor (padding), 4 equivalent. Closed: those 4 with tests; plus null
items skipped, an id never in both lists (`Finish`), WHY comment on DatetimeInserted, constants moved
to the top. Reviewer's notes carried: DatetimeApproved not sanity-checked (nothing reads it);
`ToUniversalTime` on an offset-less string shifts by server TZ — the app MUST send `Z` (Task 7 test);
cap is check-then-insert, not atomic (fine at 10/day); model-binding failures (Task 4) would fail a
whole batch — the app's client must never send an unparsable date.

## Task 4 (clave-back controller + OAuth loopback) — 2026-09-22

New: `TeamEx.Api/Controllers/AgentController.cs` (`api/agent/profile` GET, `taxonomy` GET
`?knownVersion=`, `evidence` POST; all `[Authorize]`, no permission gate, logs carry no user data —
the evidence line logs the item count only); `TeamEx.Test/Controllers/AgentControllerTests.cs`
(reflection over routes/verbs/auth, only three actions, pass-through of knownVersion/request/error
code). `OAuthReturnUrl.Build`: a returnUrl that is plain `http://127.0.0.1[:port]/…` (no userinfo, no
fragment) is used as the redirect target; `oAuthAttemptId` is appended with `&` when the target
already has a query. Tests: 3 loopback shapes accepted, 9 look-alikes refused (https, localhost,
127.0.0.2, `127.0.0.1.evil.com`, path-embedded, userinfo, fragment, `[::1]`, scheme-less). Ruling
R13: `localhost` is NOT accepted (can resolve elsewhere; RFC 8252 §7.3 names 127.0.0.1). Review
(independent, 39 mutations, the real `Build` probed against WHATWG parsing side by side): approve with
reservations — every string .NET accepts as loopback is loopback for a browser and vice versa;
survivors closed: the two controller error paths (test), raw returnUrl emitted (now
`GetLeftPart(UriPartial.Query)`, so octal/decimal/padded/uppercase spellings reach the browser
canonicalised), a returnUrl already carrying `oAuthAttemptId` (now refused), uppercase scheme and
trailing-`?` (tests). Contract facts for the client, all encoded in httpApi.ts: service errors = HTTP
200 + envelope; malformed body = HTTP 400 ProblemDetails; bad JWT = HTTP 401 empty; guest-grade write =
HTTP 403 + envelope; refused Google login = 200 / successful true / data.isSuccessful false.
Pre-existing, NOT in D's diff, for the owner: `SecurityController.cs` ~233 logs the OAuth attempt id at
Information; `SecurityService.cs` ~786 serialises the whole account into the log.

## Task 6 (app: port, config, switches) — 2026-09-22

Done: `ApiErrorCode` + RATE_LIMITED; `SubmitResult {accepted, rejected?}`; `exchangeOAuthAttempt` on
the port, stub (`stub:google`) and fake (`attempt-ok`); `namesShape`/`submitShape` + parsers;
`API_TIMEOUT_MS` 15 s, `API_TAXONOMY_TIMEOUT_MS` 60 s; `shell/apiUrl.ts` (+5 tests, 5 mutations
caught): packaged → prod always, unpackaged → dev unless `CLAVE_API_URL` = https origin or plain http
on 127.0.0.1/localhost/[::1] (bare origin only), else `BAD_API_URL` start failure (added to
START_FAILURES); `DEV_SWITCHES` + CLAVE_API_URL, CLAVE_REAL_API (devEnv test now checks every switch
— closes the stale "six switches" gap the packaging review noted); one copy line RATE_LIMITED.
Suite 3132 / 102 files, typecheck clean, smoke not rerun (no shell change). Review (independent, 46
mutations): approve with reservations — I1: `session.restore()` signs out on any code but
OFFLINE/SERVER, so RATE_LIMITED (and BAD_RESPONSE) at launch would sign the user out, against its own
comment → FIX PENDING in session.ts (sign out only on UNAUTHORISED/BAD_CREDENTIALS) once the Task 8
review releases the file; I2: three "pinned" claims were not (BAD_API_URL in START_FAILURES, the two
switches, the prod/dev literals) → closed with literal assertions; minors closed: names/rejected
element types, stub `exchangeOAuthAttempt` test, test title. Kept: `[::1]` accepted (loopback by
definition) and `localhost` for the dev switch (design §4.3) while the backend's OAuth loopback
refuses both (R13) — different purposes, recorded here. Copy for RATE_LIMITED on the sign-in screen
says "Try again in a few minutes" (nothing retries there); design §4.7 wording superseded.

## Task 7 (app: `main/api/httpApi.ts`) — 2026-09-22

The real client: six calls, deadlines (`AbortSignal.timeout`), `redirect: "error"`, code-only errors.
Mapping: fetch throw/timeout/redirect → OFFLINE; HTTP 401/403 → UNAUTHORISED; other non-2xx → SERVER;
non-JSON/non-envelope → BAD_RESPONSE; envelope error 11 → RATE_LIMITED, 8 → UNAUTHORISED, 6 →
UNAUTHORISED (BAD_CREDENTIALS on the login route, as are 3 and 5), else SERVER. Session: token =
accessToken.value, userId = accountId, expiresAt = JWT `exp`×1000 (unverified, schedule only; no exp
→ BAD_RESPONSE). Wire item: clave-back names, `datetimeApproved` ISO UTC with Z; an unrepresentable
createdAt is sent as null so the server rejects that item for good (R14). OAuth attempt: isSuccessful
false or no token → UNAUTHORISED. 15 tests incl. a real silent server (deadline) and a real 302
(not followed), and a leak test over thrown errors. Review (independent, 51 mutations, the C# side
probed with the real STJ and JWT packages): approve with reservations — C1: an outbox over 50 items
would be refused whole by the server for ever (the uploader sends everything in one request) → FIXED:
`submitEvidence` sends pieces of 50 and merges the answers; a later piece's failure returns what the
earlier ones achieved (R17); I1: the app refreshed its token only at launch, so a token expiring while
the app runs could not be refreshed (PUT refresh needs a valid bearer) → FIX in session/engine: a
`refreshIfDue()` on the minute tick (due when < 24 h left and < half the known lifetime; one failed
attempt per 15 min at most) — pending the Task 9 review's release of those files; I2/M1/M3/M4/M5/M6
closed: literal competency wire test, `encodeURIComponent` guarded, ISO guard years 1–9999, HTTP 400
on the login route = BAD_CREDENTIALS (a malformed email reads as a mismatch), empty list sends nothing,
six more tests. Kept as designed: 403 → UNAUTHORISED (a WAF's 403 page would sign the user out; rare).
Owner question carried to Task 12: `Jwt-ExpirationMinutes` on dev and prod.

## Task 8 (app: uploader `rejected`, log code, session `signInWith`) — 2026-09-22

Uploader: held = accepted; refused = rejected minus held (held wins); both leave the outbox; only held
go to the sent log; `onRejected(count)` dep → engine logs `UPLOAD_REJECTED {count}`. Session:
`signInWith(getSession)`; `signIn` delegates. Tests +4 (uploader 2, session 1, engine 1: the log line
holds the count and never the statement). 4 mutations caught. Suite 3154 passed; the ONE red test is
`scripts/package/sign.test.ts` over packaging's real bundle in `app/out/internal/` (their in-progress
work, not D). Review (independent, in-place probes on uploader/session/engine): approve with
reservations, no defect; closed: `onRejected` now guarded (a throwing listener cannot fail a send) and
called only after the outbox save (test: a failed save counts nothing, the retry counts once); count > 1
exercised; a test pins that a refresh landing during a password sign-in is never persisted.

## Task 9 (app: Google sign-in handoff) — 2026-09-22

New: `main/account/googleSignIn.ts` (pure orchestration: listen on a random loopback port with a
state nonce → open `${baseUrl}/api/security/login/google?returnUrl=http://127.0.0.1:{port}/callback?state=…`
→ wait for the callback / 5 min timeout / cancel → `exchange(attemptId)`; results are codes only);
`shell/loopbackListener.ts` (real one-shot http server: one matching GET `/callback` → fixed
script-free page; everything else 404; bound to 127.0.0.1); engine `signInWithGoogle` /
`cancelGoogleSignIn` + optional dep `googleSignIn` (absent → OAUTH_BROWSER); the post-sign-in steps
factored into `signedInBy` shared with password sign-in; IPC channels `signInWithGoogle`,
`cancelGoogleSignIn` (+ renderer bridge/mock one-liners); `SignInResult` codes OAUTH_TIMEOUT,
OAUTH_BROWSER (+ copy); log codes SIGN_IN_GOOGLE_STARTED/FINISHED{failures}; `OAUTH_TIMEOUT_MS`.
Rulings: R15 a second start cancels the first (the user clicked again); R16 OAUTH_BROWSER is its own
code (a browser that cannot open is not a timeout). Tests: 8 orchestration, 3 listener (real
sockets), 4 engine. app.ts wiring is Task 11's. Review (independent, 52 mutations, incl. Task 11):
approve with reservations — closed: a failing loopback bind now answers OAUTH_BROWSER (was a raw
socket error with an address, crossing IPC); the cancel handle is registered before the first await
and a run's `finally` clears only its own handle (two-starts-in-one-tick and cancel-during-bind
tests); `quit()` cancels a browser wait and a sign-in landing after quit runs none of the
after-steps; the base-URL check now precedes the NO_READER_YET throw; stale header comment fixed.
OPEN FOR THE OWNER (server-side design, not this diff): I1 — the loopback return URL carries no
proof of possession: a malicious LOCAL process that binds a loopback port and makes the browser
open `…/login/google?returnUrl=http://127.0.0.1:<its port>/callback` receives a valid attempt id
(single use, 30 s) if Google auto-consents. RFC 8252's answer is PKCE (the app sends a code
challenge with the login URL, the server stores it on the attempt, the exchange requires the
verifier). Cost to add in clave-back: OAuthAttempt gets one field, GoogleLogin/callback pass one
parameter through, the exchange checks a hash — about half a day with tests. Recommendation: do it
before the release flavour ships; not needed for the internal flavour (stub API).
ALSO: the engine now renews the token while running (`session.refreshIfDue()` on the minute tick;
Task 7 I1) — 3 tests, 5 mutations caught.

## Task 10 (app: renderer button + WHAT-LEAVES) and Task 11 (app.ts wiring) — 2026-09-22

Task 10: `AppInfo.googleSignIn?` (true only with the real client); onboarding sign-in step gains "or
Sign in with Google" (shown only then), a waiting sentence with Cancel while the browser is open;
copy keys `signInWithGoogle`, `or`, `waitingForBrowser`; WHAT-LEAVES: one row for the browser
sign-in, one sentence about refused statements under "What is kept". No renderer component tests
exist in the repo; the screen is looked at in Task 12. Review (independent): approve with
reservations — two WHAT-LEAVES sentences were untrue on the wire ("nothing from this app" — the app
itself sends the one-time code to Clave; "it never left" — a refused statement WAS sent, just not
kept) → both rewritten; a user's own Cancel showed "Try again" → suppressed (renderer remembers the
cancel; main still answers OAUTH_TIMEOUT); the waiting sentence now lands in an always-mounted live
region and a failed wait focuses the heading; "signing in in" → "through"; the "or" no longer sits
below the button's centre. Carried to Task 12: Google-path failures render under the Password field.
Task 11: `launchMode` gains `realApi` (packaged release = real API + real reader + real model,
production, NOT refused any more; packaged internal = stub API + real reader; unpackaged
`CLAVE_STANDINS=1 CLAVE_REAL_API=1` = real API beside stand-in reader/model, never in smoke; no
STANDINS at all still `NO_READER_YET` — the reader sub-project's call); app.ts resolves the base URL
first (`BAD_API_URL` refuses the launch), builds `createHttpApi` or the stub, passes `googleSignIn`
only with the real client, `appInfo.googleSignIn`; `start:api` script.

## Rulings made on the owner's behalf (with cost if wrong)

See design §5: R1 JWT exp read client-side; R2 rejected items dropped + counted; R3 (amended after
Task 0) desktop rows run NO follow-ups; R4 wire uses clave-back naming (`datetimeWritten`, renamed
from `datetimeApproved` after the final review: it carries the statement's writing time); R5 rolling
24 h cap; R6 loopback redirect not clave:// scheme; R7 unpackaged default = dev deployment;
R8–R17 are recorded in the task entries above.
Design written 2026-09-22: docs/superpowers/specs/2026-09-22-clave-back-api-design.md (DRAFT).

- 2026-09-22, PKCE question answered "continue": ruling R18 — PKCE stays a recorded follow-up (after
  Task 12, before the release flavour ships); cost if wrong: half a day of backend work moved later,
  no exposure for the internal flavour, which has no real backend.
- Task 12 checklist written: `task12-checklist.md` in this folder.

## Open questions

The seven design questions (label/blend, sign-in, usage counts, taxonomy versioning, upload rules,
deletion, environment) were answered 2026-09-21/22 — see the owner statements at the top. Still open
for the owner, in this order: (1) PKCE on the loopback handoff (Task 9 review); (2) `Jwt-ExpirationMinutes`
on dev and prod (decides renewals and whether a laptop asleep past expiry is signed out); (3) the
clave-front label for `source = 3`.

## Final whole-plan review (2026-09-22)

Ready for the owner's session; no critical defect. Closed from it: three WHAT-LEAVES sentences
("Sent shows every statement that left"; "at most once a day"; the per-statement id), the wire field
renamed `datetimeWritten` (it was never the approval time), the identifier input now accepts a handle
(it was `type="email"`, so the handle path was unreachable), ledger staleness. Recorded, not closed:
Task 5 (curl against a local server) was never run — Task 12 is the first HTTP exercise; a local
Google sign-in needs the dev OAuth client to allow `http://localhost:8080/signin-google` and the Key
Vault credential; without the BackgroundProcessor the unique index does not exist and idempotency
rests on the pre-check; to try the daily cap locally lower `AgentService.MaxAcceptedPerDay`.

## Task 12 (partial, 2026-09-22) — record in `task12-record.md`

PASSED over HTTP against a local clave-back on the dev database: password sign-in, profile names,
taxonomy (2906 skills / 25 competencies, 16 s cold, hash version), one statement produced against the
real taxonomy, approved, uploaded (200), shown on the profile with `source = 3`. NOT run: Google
sign-in (needs the dev deployment), cancel, the rate-limit path; the HTTP repeat-upload check (unit
tests cover it). INCIDENT: my test row broke the old dev deployment's profile read (strict BSON on the
four new fields) — the owner deletes the row; lesson: never let a new write path reach a database an
older deployment still reads. Observations for other sub-projects: tray count not visible (B);
Google-path failure text under the Password field (B). Follow-ups found: server single-flight for the
taxonomy build (three concurrent 16 s builds); the app asks for the taxonomy twice at sign-in.

- 2026-09-22, owner: "Check it for yourself. You have access to Azure CLI." `Jwt-ExpirationMinutes`
  = 43200 (30 days) on BOTH dev and prod (read via `az keyvault secret show`, value only).
  Consequence: a token lives 30 days; the app renews it a day before expiry (the half-life rule never
  fires earlier than that); only a machine asleep or offline for over 30 days is signed out. The
  refresh-on-a-tick fix stands as the right shape. Question closed.
