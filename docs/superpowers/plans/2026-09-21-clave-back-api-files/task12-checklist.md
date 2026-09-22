# Task 12: end-to-end with the owner (one action per message)

Written 2026-09-22. Prerequisites: a local clave-back from the working tree of `prod` (with D's
uncommitted changes), reachable at `http://localhost:8080` (or another port — then set `CLAVE_API_URL`
to that origin), talking to the DEV database; the owner's own Clave account (email + password).
Records go into this folder as `task12-record.md`: codes, counts, ids only — never a statement's text
beyond the one fixture sentence, never a token.

| # | Who | Action | Pass when |
|---|---|---|---|
| 1 | owner | Start clave-back locally the usual way; note the port | `GET http://localhost:8080/api/security/ping` answers |
| 2 | agent | `curl -s -X POST …/api/security/login -H 'Content-Type: application/json' -d '{"email":"…","password":"…"}'` — the owner types the password into the terminal himself, the agent never sees it; then `GET …/api/agent/profile`, `GET …/api/agent/taxonomy` with the bearer | profile names correct; taxonomy `version` 16 hex, counts ≈ 3–4k skills / ~25 competencies; second GET with `knownVersion` → `unchanged: true` |
| 3 | agent | curl `POST …/api/agent/evidence` with one hand-written item (a real skill id from step 2) twice | first: `accepted: [id]`; second: same, and `GET …/api/profile/{handle}/evidence?kind=1&tagId=<skillId>` shows ONE row with `source: 3` |
| 4 | agent | curl a bad item (kind "expertise") beside a good one; 51 items; a wrong password | `rejected` names the bad one; 51 → `error.code 4`; wrong password → `error.code 3` |
| 5 | owner | Quit any running dev app; `CLAVE_API_URL=http://localhost:8080 pnpm --dir app start:api` | window opens at the sign-in step with "or Sign in with Google" visible |
| 6 | owner | Password sign-in | step advances; `app.log` has no error code; names + taxonomy loaded (Settings shows the version) |
| 7 | owner | Let the scripted model produce a statement (capture on for a minute), approve it | Review → Sent lists it; server row `source: 3`; `UPLOAD_REJECTED` absent from the log |
| 8 | owner | Google sign-in (sign out first). Needs the dev Google OAuth client to allow `http://localhost:8080/signin-google` — if it does not, defer this step to the dev deployment | browser round trip lands on the "close this tab" page; app signed in; log has SIGN_IN_GOOGLE_STARTED/FINISHED{failures:0} |
| 9 | owner | Cancel a Google sign-in mid-way | no sentence shown; app still signed out |
| 10 | agent | Lower `AgentService.MaxAcceptedPerDay` to 1 on the local server, restart it, approve two statements | second upload backs off with RATE_LIMITED in the log; restore the constant |
| 11 | both | Decide: PKCE now/later; `Jwt-ExpirationMinutes`; front-end label | recorded in the ledger |
| 12 | agent | HANDOFF row: D DONE; ledger closed | — |
