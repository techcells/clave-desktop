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
- Step 5: `CLAVE_API_URL=http://localhost:8080 pnpm --dir app start:api` with a throwaway
  `CLAVE_DATA_DIR`; built flavour dev; window up.
- Step 6 (owner pressed Sign in, 15:11): `POST /api/security/login` 200 (2.0 s), `GET /api/agent/profile`
  200 (0.8 s), `GET /api/agent/taxonomy` 200 in 16.5 s COLD (two concurrent requests, both built —
  the server's cache has no in-flight sharing and the app asked twice: sign-in's forced refresh and
  the tick's; note for a minor fix on both sides), then served from cache. Taxonomy on disk:
  version `d679b5ba5687eb94`, 2906 skills, 25 competencies. Server left out 52 unnamed Active skill
  rows (ruling R8) — FOR THE OWNER: 52 active skills have no display or canonical name in dev data.
- Step 7 (15:24): reading on (`SELF_TEST_PASSED`, `CAPTURE_ON`); the stand-in reader's fixture + the
  scripted model produced ONE pending statement against the REAL taxonomy (skill Redis, target
  `68d27a318890a66e6242d244`) within a minute — but the tray title showed no `● 1` for 9 minutes
  while Review listed it (OBSERVATION for sub-project B: tray count not visible on this machine; the
  Review tab badge was). Owner approved → `POST /api/agent/evidence` 200 in 2.8 s, 1 item; the app's
  sent log holds the entry (clientItemId `242a53a8-…`, taxonomyVersion `d679b5ba5687eb94`); no
  `UPLOAD_REJECTED`; outbox empty.
- Server-side check (local, new code): `GET /api/profile/tokhir_2` lists the Redis tag;
  `GET /api/profile/tokhir_2/evidence?kind=1&tagId=68d27a318890a66e6242d244` shows row
  `6ab257650465e1961c647967` with `source: 3`, `huddleId` null, `atSeconds` 0, no peer. PASS.
- INCIDENT (mine): that row, written to the DEV database by my local server, carries the four new
  fields; the dev deployment (old model, strict BSON) throws "Error getting profile" (code 2) on
  `app.d.clave.co/@tokhir_2` until the row is gone or the new code is deployed — exactly the
  CLAUDE.md warning about additive fields. The owner deletes the row himself (his decision, 15:35).
  Lesson recorded in the ledger: never point a write path at a database an older deployment reads.
- Steps 8–10 (Google over HTTP, cancel, rate limit) NOT run: Google needs the dev deployment (or a
  Google client that allows localhost); the local app and API were stopped at 15:36.

## Session 2 (2026-09-22, after the dev deployment of `f6989a3`)

- Owner deployed dev; PKCE (app + backend, uncommitted) is built but NOT yet on dev, so the app's
  `codeChallenge` / `codeVerifier` parameters are ignored by dev's older code — the handoff works
  without proof of possession for this run, and gets it once the PKCE commit is deployed.
- Step 8 setup: `pnpm --dir app start:api` against the default unpackaged base URL
  `https://api.d.clave.co`, fresh throwaway data folder; the owner presses "Sign in with Google".
- Step 8 PASS (dev deployment): first press cancelled by the owner on purpose (wrong Chrome profile)
  → `SIGN_IN_GOOGLE_FINISHED {failures: 1}`; second press signed in → `{failures: 0}`, session stored,
  taxonomy from dev (2906 / 25, `d679b5ba5687eb94`). Step 9 (cancel) thereby exercised: a cancelled
  browser sign-in ends with the failure count and leaves the app signed out; the owner then simply
  started again.
- Step 10 (rate limit over HTTP) NOT run: the cap is a server constant that cannot be lowered on
  dev; the path stays covered by unit tests on both sides (server refusal → RATE_LIMITED → backoff).
