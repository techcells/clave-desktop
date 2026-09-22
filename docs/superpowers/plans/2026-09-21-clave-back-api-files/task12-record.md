# Task 12 record (2026-09-22)

Codes, counts and ids only. Never a statement's text beyond the fixture sentence, never a token.

- Step 1 (agent, not the owner — he asked to be kept out of server starts): local clave-back started
  from the working tree of `prod` with D's changes, `ASPNETCORE_URLS=http://localhost:8080`,
  default settings → Key Vault `clave-back-secrets-dev`, `Environment: dev`; up after ~15 s;
  `/api/security/ping` Healthy; swagger lists `/api/agent/profile`, `/api/agent/taxonomy`,
  `/api/agent/evidence`. Logs in the session scratchpad only.
- Steps 2–4 (curl with a token) SKIPPED: obtaining a token needs a password typed by the owner; the
  app run (steps 5–7) exercises the same routes over HTTP, and the server-side checks use the
  anonymous profile-evidence route. The 51-item and bad-item paths stay covered by unit tests.
