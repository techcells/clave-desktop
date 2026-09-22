# Sub-project D: clave-back API for the desktop app, and the app's real `ClaveApi`

Written 2026-09-22. Status: APPROVED by the owner 2026-09-22 ("approved"). Ledger of every owner
statement and every ruling taken on his behalf: `docs/superpowers/plans/2026-09-21-clave-back-api-files/ledger.md`.

## 0. Decisions already taken by the owner (not up for discussion here)

| # | Decision | Consequence |
|---|---|---|
| Q1 | Desktop evidence is **labelled** on the profile | new `CallEvidenceSource.DesktopAgent` |
| Q2 | v1 sign-in: **password, and Google only** | reuse `login` + the OAuth attempt exchange; LinkedIn/Microsoft out |
| Q3 | Usage counts **out of scope** | WHAT-LEAVES keeps "no usage data" |
| Q4 | Taxonomy version = **server content hash**, "unchanged" when known | no stored version field |
| Q5 | `submitEvidence` rules: unique `(accountId, clientItemId)`; statement 1–300 chars; target active in the current list or permanently rejected; 50 items/request; 200 accepted/account/day; 429 → app backoff | `rejected` list added to the answer |
| Q6 | **No delete** in v1 | no endpoint, no UI |
| Q7 | prod `https://api.clave.co`, dev `https://api.d.clave.co`; one dev switch `CLAVE_API_URL`, dead when packaged | local clave-back first |
| — | Evidence is not tied to a huddle; huddle rows untouched | rows keyed by `accountId`, `source = DesktopAgent` |

## 1. What exists today (verified 2026-09-21/22)

clave-back (branch `prod`, clean): `callEvidences` already holds rows without a huddle (`source`
Huddle=1 / PrivateRecording=2, `privateSourceKey`, nullable `huddleId`); `PUT
api/profile/account/{id}/private-extraction/{key}` writes them but needs the admin permission
`CanManageOtherTalents`, takes the account from the route and replaces by key. `POST
api/security/login` takes exactly one of `email`/`handle` + `password` and answers
`AuthResponse{accountId, email, accessToken{type, value}, …}` **with no expiry field** (the expiry is
only the JWT `exp` claim). `PUT api/security/refresh` is bearer-only and answers the same shape.
Google sign-in: `GET api/security/login/google?returnUrl=…` → Google → callback creates a
30-second, single-use OAuth attempt and redirects to `OAuthReturnUrl.Build(ReturnUrlBase, returnUrl,
id)` = `{target}?oAuthAttemptId={id}`, where `target` must be a path under the web app or one of
`clave://login`, `clave://signup`; `GET api/security/oAuthAttempt/{id}` (anonymous) exchanges it for
an `OAuthAttemptResponse{accountId, accessToken, isSuccessful, errorMessage, …}`. No endpoint
serves the whole skill list to an ordinary user (`normalizedSkill/all` needs `CanListSkills`, and
is paged). No rate limiting, no response compression, no HTTP-status error mapping: every action
answers HTTP 200 with the envelope `{successful, error{code:int, message}, data}`; `[Authorize]`
failures are bare 401/403. Indexes are created by idempotent `IHostedService` initializers in
`TeamEx.BackgroundProcessor`; `callEvidences` has none. Enums serialize as integers. Tests: xunit +
Moq with list-backed repository mocks; run with `dotnet test TeamEx.Test/TeamEx.Test.csproj`.

The app: the port `app/src/main/ports/claveApi.ts` (five methods, zod shapes); the stub in
`app/src/standins/stubApi.ts`; `app.ts` refuses to start without `CLAVE_STANDINS=1`
(`NO_READER_YET`); session store refreshes 24 h before `expiresAt` (ms epoch) and on one
`UNAUTHORISED`; taxonomy cache refreshes daily, retries after 15 min; uploader sends the whole
outbox in one call, retries anything not in `accepted` for ever with backoff 1/5/15/60 min; the
log takes fixed codes and counts only; **no HTTP timeout exists anywhere**; `createNodeHttp` is the
only `fetch` and is injectable for tests.

## 2. Scope of D

In: three new clave-back endpoints under `api/agent/`, one new `source` value with its DTO twin and
profile mapping, four additive fields on `CallEvidence`, one index initializer, one allowlist change
in `OAuthReturnUrl`; on the app side a real HTTP `ClaveApi`, the Google sign-in handoff, the base-URL
rule, two dev switches, new copy and WHAT-LEAVES rows, and the start guard's backend half. Out: the
reader half of the start guard (C), the web profile's rendering of the label (front-end repo — it
regenerates types from swagger), delete, telemetry, LinkedIn/Microsoft, packaging.

## 3. clave-back

### 3.1 Endpoints (all `[Authorize]`, the account comes from the JWT's `NameIdentifier` claim via `CurrentAccountId`; camelCase JSON; envelope as everywhere)

**`GET api/agent/profile`** → `AgentProfileResponse { names: string[] }`
The distinct, non-empty values of the account's `firstName`, `lastName`, `preferredName`,
`displayName`, `handle` and `"{firstName} {lastName}"`. Nothing else: the app only needs the
names its guard must keep out of statements.

**`GET api/agent/taxonomy?knownVersion={v}`** → `AgentTaxonomyResponse`
```
{ version: string, unchanged: boolean, skills?: [{id, displayName, canonicalName, aliases: string[]}], competencies?: [{id, name, description}] }
```
`unchanged: true` (and no lists) when `knownVersion` equals the current version. Content: every
`NormalizedSkill` with `Status == Active` (the repository's dead-data filter already excludes deleted
and test rows, per CLAUDE.md; `IsActive` is never false on a non-deleted row today — amended after
Task 2's review) with `aliases` null → `[]`, and every `Competency` with `Status == Active`
(`description` null → `""`), each list sorted by id; rows without a display/canonical name or a
competency name are left out (ruling R8). Version: the first 16 hex chars of SHA-256 over a
separator-joined canonical text of the two sorted lists (id, names, aliases, description).
The whole response is computed once and held in `IMemoryCache` for 60 minutes (deterministic, so
several API instances agree). Expected size 400–600 KB, one response, no paging.

**`POST api/agent/evidence`** → `AgentEvidenceResponse { accepted: string[], rejected: string[] }`
Request `AgentEvidenceRequest { items: AgentEvidenceItemRequest[] }` with
```
{ clientItemId: string, statement: string, kind: "skill" | "competency", targetId: string,
  datetimeWritten: string (ISO 8601 UTC), taxonomyVersion: string, pipelineVersion: string }
```
Rules, in order:
1. `items` empty or more than 50 → `ValidationError` (whole request).
2. Daily cap: rows of this account with `source = DesktopAgent` inserted in the last 24 h + new
   items > 200 → `ErrorCode.TooManyRequests` (whole request; nothing stored).
3. Per item, **permanently rejected** (listed in `rejected`, nothing stored) when: `statement`
   trimmed is empty or over 300 chars; `kind` not one of the two words; `targetId` is not a valid
   ObjectId, or is not an Active skill (for `skill`) / Active competency (for `competency`) in the
   CURRENT data; `clientItemId` empty or over 128 chars.
4. Per item, **idempotent**: a `clientItemId` this account already holds is answered in `accepted`
   without a second row. A duplicate inside the same request is collapsed to one.
5. The rest are inserted as `CallEvidence { AccountId, Source = DesktopAgent, Kind, SkillId |
   CompetencyId, Snippet = statement.Trim(), AtSeconds = 0, ClientItemId, DatetimeWritten,
   TaxonomyVersion, PipelineVersion, DatetimeInserted = now }` and answered in `accepted`.
   `DuplicateKey` from the unique index (a race between two identical requests) counts as accepted.
6. No follow-ups (amended 2026-09-22 after Task 0, ruling R3): the profile page builds its tags
   from the evidence rows themselves, so a desktop row is visible on its own; no talent-skill upsert
   (its only label would be the wrong `TalentSkillSource.Call`), no notification after the user's
   own approval, no credibility check.
`taxonomyVersion` is recorded, never used to validate: the target is checked against today's list.

### 3.2 Model and data
- `CallEvidenceSource.DesktopAgent = 3` and `CallEvidenceSourceDto.DesktopAgent = 3`.
- `CallEvidence` gains four `[BsonIgnoreIfNull]` fields: `clientItemId` (string),
  `datetimeWritten` (DateTime?), `taxonomyVersion` (string), `pipelineVersion` (string). Additive,
  read-safe; per CLAUDE.md the model change lands on the parent branches before anything writes it.
- `ToEvidenceDtosAsync`: a `DesktopAgent` row maps like a private one — `Source = DesktopAgent`,
  `HuddleId = null`, `AtSeconds = 0`, no `WithHandle`/`WithName`. `GetEvidenceAsync` keeps not
  filtering by source, so desktop rows show under their tag; the label is the front-end's to render.
  **Front-end follow-up (found in Task 1's review):** `clave-front` computes `isPrivate` as
  `source === PrivateRecording` and renders any other row as "recorded · in a call with {name}", so
  until it is changed a desktop row shows as a call with an empty peer. Owner's call when to do it.
- New `CallEvidenceIndexInitializer` (BackgroundProcessor, same pattern as `HuddleIndexInitializer`):
  unique partial index `accountId_clientItemId_unique` on `{accountId, clientItemId}` where
  `clientItemId` is a string, plus `accountId_source_datetimeInserted` for the daily cap. The service's pre-check (rule 4)
  keeps idempotency correct even before the initializer has run.
- `TalentContentCleanupService` already deletes evidence by huddle; desktop rows are deleted by
  `accountId` on account cleanup (one added line, tested).
- No migration script: nothing existing is renamed or removed.

### 3.3 Google sign-in support
`OAuthReturnUrl.Build` additionally accepts a loopback target `http://127.0.0.1:{port}/…` (any
port, no other host) and appends `oAuthAttemptId` with `&` when the target already carries a query
(today it always uses `?`). Everything else in the OAuth path is unchanged: the attempt stays
30-second and single-use, the exchange stays anonymous.

### 3.4 Tests (TeamEx.Test, xunit + Moq, list-backed mocks like `ProfileServicePrivateExtractionTests`)
`AgentServiceEvidenceTests`: accepts a valid batch and writes the exact row; rejects each rule-3
case one at a time; idempotent repeat answers accepted without insert; duplicate in one batch;
51 items → ValidationError; cap at 200 in the window; DuplicateKey → accepted; follow-ups called
with the right ids; another account's `clientItemId` does not collide. `AgentServiceTaxonomyTests`:
only Active rows; version stable across calls and across list order; version changes when a name,
alias or description changes; `knownVersion` match → `unchanged` without lists; cache hit does not
hit the repository. `AgentServiceProfileTests`: distinct, non-empty names. `OAuthReturnUrlTests`:
loopback accepted with any port, `&` vs `?`, non-loopback http still refused, `http://127.0.0.1`
without a path. `AgentControllerTests` (reflection, like `HandlesControllerTests`): route, verbs,
`[Authorize]` on all three, no `[AllowAnonymous]`. `ProfileService` mapping test for `DesktopAgent`.

## 4. The app

### 4.1 Port changes (`app/src/main/ports/claveApi.ts`)
- `submitEvidence` answers `{accepted: string[]; rejected: string[]}` (`rejected` optional in the zod
  shape so the stub and fakes keep working).
- New method `exchangeOAuthAttempt(attemptId: string): Promise<Session>`.
- `ApiErrorCode` gains `"RATE_LIMITED"`.
The shapes stay: `Session{token, expiresAt (ms), userId}`, `Taxonomy`, `ApprovedStatement`.

### 4.2 The HTTP client — `app/src/main/api/httpApi.ts` (main layer, ports-and-adapters like `nodeDownload.ts`)
`createHttpApi({baseUrl, fetchImpl, now})`. Every call: `AbortSignal.timeout(API_TIMEOUT_MS = 15_000)`
(taxonomy: `API_TAXONOMY_TIMEOUT_MS = 60_000`), `redirect: "error"`, `Accept: application/json`,
`Authorization: Bearer <token>` where a session is given, JSON body. Mapping:

| Port call | Request | Answer handling |
|---|---|---|
| `signIn(identifier, password)` | `POST api/security/login` body `{email}` if the identifier contains `@`, else `{handle}`, plus `password` | envelope `successful` → Session; envelope error `Unauthorized`/`NotFound`/`BadRequest` → `BAD_CREDENTIALS` |
| `refresh(session)` | `PUT api/security/refresh`, bearer | → Session |
| `exchangeOAuthAttempt(id)` | `GET api/security/oAuthAttempt/{id}` | `isSuccessful && accessToken` → Session; otherwise `UNAUTHORISED` |
| `profile(session)` | `GET api/agent/profile` | zod `{names: string[]}` |
| `taxonomy(session, knownVersion?)` | `GET api/agent/taxonomy?knownVersion=` | `unchanged: true` → `"unchanged"`; else `parseTaxonomy` or `BAD_RESPONSE` |
| `submitEvidence(session, items)` | `POST api/agent/evidence` with `createdAt` → `datetimeWritten` ISO | zod `{accepted, rejected}`; envelope `TooManyRequests` → `RATE_LIMITED` |

Session from an `AuthResponse`/`OAuthAttemptResponse`: `token = accessToken.value`, `userId =
accountId`, `expiresAt = exp * 1000` read from the JWT payload (base64url-decoded, unverified — the
app only schedules its refresh from it; the server verifies signatures). No `exp` → `BAD_RESPONSE`.
Ruling R1.

Error mapping, everywhere: fetch throws or times out → `OFFLINE`; HTTP 401/403 → `UNAUTHORISED`;
HTTP ≥ 500 or envelope `InternalServerError`/`ServiceUnreachable`/`Unknown` → `SERVER`; non-JSON,
non-envelope or zod failure → `BAD_RESPONSE`; other envelope errors → `SERVER`. Nothing from the
response (message, body, URL) is ever placed in an error or a log — `ApiError` carries the code only,
as today. Tests use an injected `fetchImpl`; one test runs a real `node:http` server on 127.0.0.1:0
to prove the timeout and the redirect refusal.

### 4.3 Base URL — `app/src/shell/apiUrl.ts` (pure, tested)
`resolveApiUrl({packaged, switchValue})`: packaged → `https://api.clave.co`, always. Unpackaged:
no switch → `https://api.d.clave.co`; switch set → accepted only if `https://…` or
`http://127.0.0.1[:port]` / `http://localhost[:port]`, else the app refuses to start with
`START_FAILED BAD_API_URL` (a bad switch must never fall through to production). `CLAVE_API_URL` and
`CLAVE_REAL_API` join `DEV_SWITCHES` (so `devEnv` kills them when packaged; the key-set test pins
them).

### 4.4 Wiring and the start guard (`app/src/shell/app.ts`)
- `CLAVE_STANDINS=1` (unchanged): stub API + dev reader. New: `CLAVE_STANDINS=1 CLAVE_REAL_API=1`
  swaps in the HTTP client while the reader and model stay stand-ins — script `start:api`
  (scripted model) for end-to-end backend runs without a screen. Never in the smoke run, which must
  work offline and keeps `stub-uploads.jsonl`.
- No `CLAVE_STANDINS`: the API is the HTTP client, unconditionally — that is the backend half of
  the guard. The reader half stays as C leaves it (today `NO_READER_YET` is thrown before the
  stand-ins are built; D moves the API choice above that throw and leaves the reader line to C).
- `createEngine`'s `STANDIN_IN_PRODUCTION` check keeps working: the HTTP client has no `standIn`.

### 4.5 Uploader: `rejected`
Items named in `rejected` leave the outbox with the accepted ones but are NOT written to the sent
log; the engine logs `UPLOAD_REJECTED {count}` (new fixed code). `RATE_LIMITED` goes through the
existing backoff like any `ApiErrorCode`. Ruling R2.

### 4.6 Google sign-in — `app/src/main/account/googleSignIn.ts` + shell adapters
Flow (RFC 8252 loopback):
1. Main starts an `http.Server` on `127.0.0.1:0` (random port), one path `/callback`, alive for at
   most 5 minutes, and generates a 32-byte random `state`.
2. `shell.openExternal(`${baseUrl}/api/security/login/google?returnUrl=${encodeURIComponent(
   `http://127.0.0.1:${port}/callback?state=${state}`)}`)` — the user signs in in their own browser.
3. The backend redirects the browser to `http://127.0.0.1:{port}/callback?state=…&oAuthAttemptId=…`.
   The listener answers a fixed, script-free HTML page ("You are signed in — you can close this
   tab", or the failure sentence), then closes. A request with the wrong `state`, another path, or
   after the first hit is answered 404 and ignored.
4. Main calls `api.exchangeOAuthAttempt(id)` (well inside the 30-second window), then `profile()`,
   and stores the session exactly as password sign-in does (`session.signInWith(getSession)`).
Results: `SignInResult` gains `"OAUTH_TIMEOUT"` (no callback within 5 min or the user cancelled);
a refused attempt is `UNAUTHORISED`. IPC: new channel `signInWithGoogle` (no arguments) and
`cancelGoogleSignIn`. UI: a second button "Sign in with Google" on the onboarding sign-in step, a
"Waiting for your browser…" state with Cancel. The attempt id, state and port are never logged;
`SIGN_IN_GOOGLE_STARTED` / `_FINISHED {ok}` are the only log codes. The renderer session's network
block is untouched (the listener lives in main).

### 4.7 Copy, WHAT-LEAVES
`SIGN_IN_PROBLEMS` gains `RATE_LIMITED` ("Clave is asking the app to slow down. It will retry.")
and `OAUTH_TIMEOUT` ("The browser sign-in did not finish. Try again."). `docs/WHAT-LEAVES.md`
"What is sent" gains one row: *"If you choose Sign in with Google: your browser goes to Clave's
Google sign-in page, and Clave then hands this app a one-time code on this machine, which the app
exchanges for your sign-in token"* → Google, Clave. The rejected-statement rule is added under
"What is kept": a statement Clave refuses is removed from the waiting list and is not in Sent.
Nothing else changes; "no usage data" stays.

### 4.8 App tests
`httpApi.test.ts` (every row of the table above, every error mapping, the JWT `exp` rule, headers,
no token or statement in any thrown error, timeout via real server); `apiUrl.test.ts`; `devEnv`
key-set update; `googleSignIn.test.ts` with an injected listener and browser opener (state
mismatch, second hit, timeout, cancel, happy path, exchange refused); uploader `rejected` +
`UPLOAD_REJECTED`; session `signInWith`; ipcRouter new channels; renderer views for the new state;
`standins.test.ts` unchanged; `app.ts` wiring proven by `start:api` against a local clave-back
(manual, recorded in the plan's ledger) and by the smoke run staying `SMOKE OK`.

## 4.9 Dated amendments from execution (2026-09-22)

- §3.1 evidence: the answer's `rejected` never names an id also in `accepted`; null items in the list
  are ignored; a MongoException during insert re-reads what is held and answers only that.
- §4.2: `submitEvidence` sends the outbox in pieces of 50 (the server's limit) and merges the answers;
  a later piece's failure returns what the earlier ones achieved (R17). HTTP 400 on the login route
  maps to BAD_CREDENTIALS. Session expiry is the JWT `exp`; `datetimeWritten` is sent as null when
  outside years 1–9999.
- §4.5 → NEW: the session store renews the token on the engine's minute tick (`refreshIfDue`: due when
  under a day is left and under half the known lifetime; one failed attempt per 15 min); `restore`
  signs out only on UNAUTHORISED/BAD_CREDENTIALS.
- §4.6: `SignInResult` also has OAUTH_BROWSER; a second start cancels the first; `quit()` cancels a
  browser wait; the listener answers a bare 404 to everything but the one matching callback (no
  failure page). OPEN: PKCE on the loopback handoff (server side) — see the ledger, Task 9.
- §4.4: packaged release now runs the real client (no longer refused); `CLAVE_REAL_API=1` beside
  `CLAVE_STANDINS=1` is the `start:api` mode; the base URL is resolved before the reader guard.
- §3.2: `CallEvidenceSource.DesktopAgent = 3`; index names `accountId_clientItemId_unique` and
  `accountId_source_datetimeInserted`; the front-end follow-up for the label stands.

## 5. Rulings taken on the owner's behalf (cost if wrong)
- **R1** Session expiry is read from the JWT `exp` claim in the app rather than adding an expiry
  field to `AuthResponse`. Cost if wrong: one additive DTO field later; the client change is local.
- **R2** Rejected items leave the outbox and are logged as a count, not shown in the UI. Cost: a
  user cannot see which statement Clave refused (only that one was). Reversible with a UI list later.
- **R3** (amended after Task 0) Desktop evidence runs none of the private-recording follow-ups.
  Cost: the talent's skill list used by matching/search does not gain the skill; one enum value and
  one call add it later.
- **R4** The wire uses clave-back's naming (`datetimeWritten`, ISO string) and the client maps
  `createdAt` (ms) to it, so the app's port stays untouched and clave-back's naming rule holds.
- **R5** Daily cap is a rolling 24-hour window, not a calendar day. Cost: none visible at 10
  statements/day; the number is a constant.
- **R6** Loopback redirect (RFC 8252) rather than the allowlisted `clave://` scheme, which belongs to
  another Clave client and can be claimed by any app on the machine. Cost: one small backend change
  in `OAuthReturnUrl` and a listener in the app.
- **R7** Unpackaged builds default to the dev deployment; only `CLAVE_API_URL` points elsewhere;
  packaged builds cannot be pointed anywhere.

## 6. Risks to verify in the first task, before code
1. `RedisPermissionMiddleware` answers 403 "Finish your call to unlock the rest of Clave" for some
   accounts — confirm which routes it covers; `api/agent/*` must not be behind a first-call gate for
   testers who never had a call, or the routes are exempted.
2. What `login` answers for a wrong password (which `ErrorCode`), to pin `BAD_CREDENTIALS`.
3. Whether the profile page lists tags from `talentSkills`/`talentCompetencies` (decides whether
   rule 6's upserts are needed for the evidence to be visible).
4. `Jwt-ExpirationMinutes` on dev/prod: if the token lives under 24 h + a margin, the app's
   "refresh 24 h before expiry" rule means it refreshes on every launch — fine, but worth knowing.
5. That an unpackaged dev app can reach `https://api.d.clave.co` with the new routes only after the
   clave-back change is deployed there; until then `CLAVE_API_URL=http://localhost:8080`.

## 7. Definition of done
- clave-back: builds; `dotnet test` green including the new tests; working tree only (no branch,
  commit or push unless asked); the four verifications of §6 recorded in the ledger.
- app: `pnpm --dir app test` green with the new tests, `typecheck` clean, `smoke` prints `SMOKE OK`,
  `start:api` against a local clave-back signs in (password and Google), loads the taxonomy, uploads
  one approved statement that then shows on the profile with `source = 3`, and a repeated upload
  creates no second row; a packaged-style check (`devEnv(…, true)`) proves both new switches dead.
- Every task independently reviewed by a fresh subagent with reproducing probes and a mutation
  list; every new test proven by reverting its fix on a backup copy.
- HANDOFF.md status row for D updated; WHAT-LEAVES updated; ledger complete.
