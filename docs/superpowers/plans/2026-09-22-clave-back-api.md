# Plan D: clave-back API + the app's real ClaveApi

Design (approved 2026-09-22): `docs/superpowers/specs/2026-09-22-clave-back-api-design.md`.
Ledger: `docs/superpowers/plans/2026-09-21-clave-back-api-files/ledger.md`.
Rules: no git in asset-to-evidence; clave-back working tree only (no branch/commit/push unless asked);
test first, each new test proven by reverting its fix on a backup copy; every task independently
reviewed by a fresh subagent with reproducing probes and a mutation list; ledger kept current.
Checkpoints replace commits.

| # | Task | Repo | Delivers | Done when |
|---|---|---|---|---|
| 0 | Verify the five §6 risks (permission middleware coverage, wrong-password ErrorCode, profile tag source, JWT lifetime on dev/prod config keys, dev deployment reach) | clave-back (read-only) | ledger entries; design amended if a finding changes it | owner has read the findings |
| 1 | `CallEvidenceSource.DesktopAgent` + DTO twin; four additive `CallEvidence` fields; `ToEvidenceDtosAsync` mapping; cleanup-service line; `CallEvidenceIndexInitializer` registered | clave-back | model + mapping + index | tests: mapping, cleanup, initializer index names; `dotnet build` and `dotnet test` green |
| 2 | `IAgentService`/`AgentService`: `GetProfileNamesAsync`, `GetTaxonomyAsync(knownVersion)` with hash + `IMemoryCache` | clave-back | taxonomy + profile | `AgentServiceTaxonomyTests`, `AgentServiceProfileTests` |
| 3 | `AgentService.SubmitEvidenceAsync` with rules 1–6 | clave-back | evidence write path | `AgentServiceEvidenceTests` (every rule, idempotency, DuplicateKey, cap) |
| 4 | `AgentController` (`api/agent/profile`, `taxonomy`, `evidence`), DTOs under `TeamEx.Dto/Agent`, DI registration; `OAuthReturnUrl` loopback + `&` | clave-back | HTTP surface | `AgentControllerTests` (reflection), `OAuthReturnUrlTests`; swagger shows the routes |
| 5 | Local run: `dotnet run` against dev Mongo (owner starts it), curl the three routes with a real token; record answers (codes only) in the ledger | clave-back | proof the surface works | three routes answer as designed; wrong-password code pinned |
| 6 | App port changes (`rejected`, `exchangeOAuthAttempt`, `RATE_LIMITED`), stub/fake updates, `apiUrl.ts`, `devEnv` switches, `API_TIMEOUT_MS` constants | app | contract + config | `apiUrl.test.ts`, `devEnv` key-set, `ports.test.ts`, suite green, typecheck |
| 7 | `httpApi.ts` — all six calls, error mapping, JWT `exp`, timeouts, redirect refusal | app | the real client | `httpApi.test.ts` incl. real-server timeout test; leak test: no token/statement in errors |
| 8 | Uploader `rejected` + `UPLOAD_REJECTED` log code; session `signInWith` | app | engine changes | uploader/session/log tests |
| 9 | `googleSignIn.ts` (listener, state, timeout, cancel) + shell adapters + IPC channels + engine `signInWithGoogle` | app | Google handoff | `googleSignIn.test.ts`, ipcRouter tests |
| 10 | Renderer: Google button, waiting state, Cancel, new copy; WHAT-LEAVES rows | app | UI + promise | renderer view tests; build copies WHAT-LEAVES |
| 11 | `app.ts` wiring: API chosen above the reader guard; `CLAVE_REAL_API`; `start:api` script; smoke unchanged | app | start guard's backend half | `smoke` prints `SMOKE OK`; `start:api` boots against local clave-back |
| 12 | End-to-end with the owner (one action at a time): password sign-in, Google sign-in, taxonomy load, approve one statement, see `source = 3` on the profile, repeat upload adds no row, rate-limit path with a lowered constant on the local server | both | acceptance | ledger records each step; HANDOFF row for D updated |

Independent review after each of tasks 1–4, 6–11; a final whole-plan review before task 12.
