# Desktop shell (plan B-2): execution and review record (2026-09-18)

Plan `docs/superpowers/plans/2026-09-17-desktop-shell.md` was executed with subagents. Tasks 1 to 7
were copied in byte for byte (595 tests, `SMOKE OK`), every area was then independently reviewed with
reproducing probes, and the findings were fixed test-first in waves E, F, G (main, shell, build) and
H, I (the UI). **Now: 768 tests / 57 files pass, typecheck clean for both configs, the app builds, the
in-app smoke run prints `SMOKE OK`, and the real model passes the release gate as safe.**
The code no longer matches the plan's code blocks; never re-extract them.

## What exists

- `pnpm --dir app start:scripted` runs the tray app with the stand-in reader, stand-in Clave API and
  a scripted model. `pnpm --dir app start` uses the real model (downloaded on first run, 2.7 GB,
  pinned hash). `pnpm --dir app smoke` is the automated end-to-end run. `pnpm --dir app build:preview`
  emits `app/dist-preview/` (the four screens with a mock bridge, `?scenario=...`) for design work.
- A packaged build refuses to start: the native reader (sub-project C) and the clave-back client
  (sub-project D) do not exist yet, and the engine refuses every stand-in in production.
- The UI ("The Ledger": a book-spine layout, serif statements, monospace for measured things, one
  verdigris accent) was built with the frontend-design skill. No font file is bundled: nothing openly
  licensed was on disk and nothing may be downloaded, so it uses the system serif and monospace stacks.

## Real-model gate (2026-09-18, M2)

Self-test PASS. Fixtures 01 to 07 PASS (5 to 18 s each). 08 NOTE: four statements where at most three
were expected. No safety problem. Result: `GATE SAFE, WITH QUALITY FINDINGS` (exit 2). Earlier runs
also once credited a skill outside the expected set. These are tuning notes for the prompt or the
fixture expectations, not blockers.

## Defects the reviews found (all fixed)

| Area | Found |
|---|---|
| Accounts | the "Sent" log was not owner-scoped; a pre-upgrade settings file handed another account the capture switch; the settings problem could not clear while signed out; `settings()` showed the previous account's exclusions while a reset was pending; one frame of a false "disk refused" on every sign-in |
| Storage | a pool problem could dead-end; a complete or oversized partial download 416'd forever; 2.7 GB was hashed on every launch (now a verified marker) and launch waited for it |
| IPC | a dropped rejection in `downloadStart`; bounds not from constants; the exact-URL sender check would have broken in-page routing |
| Model | the context could overflow silently for dense text (now 16,384 tokens, measured with the model's tokenizer, fails with a fixed code); unbounded grammar cache |
| Gate | skipped fixtures silently and could pass having run nothing; argument handling |
| Shell | no permission-deny handlers; request filter on the shared session; unquittable-app path; dev switches not all dev-gated; user-facing text outside `copy.ts`; production stand-in guard covered two of five ports |
| Build | React development bundle; build succeeded without `WHAT-LEAVES.md`; the renderer import boundary was a regex that kept being bypassed, now enforced on esbuild's own module graph in the build and in a test |
| Docs | `WHAT-LEAVES.md` omitted the profile and token-refresh requests, did not name huggingface.co, and omitted the stored display names |
| UI | **a rejected statement could still be uploaded** (Reject stayed enabled while Approve was in flight, and main enqueued before resolving): now one decision per statement, locked in main and in the row; blank window on a refused IPC call; the "Done" step never shown; stale refusal on Home; the permission step re-subscribing every 1.5 s; a site's problem filed under Apps and the draft lost; no focus management; inputs without a focus ring; control borders under 3:1 contrast; Settings not re-read after delete-all |

## Decisions taken on the owner's behalf

1. Adopting a settings file that has no owner keeps the exclusions but always switches capture off.
2. The model context is 16,384 tokens and an oversized scenario fails loudly instead of being truncated.
3. The verified-model marker is trusted when size, mtime and the pinned hash match (the model is a
   public file; a same-user local attacker can already rewrite everything else).
4. Quitting is capped at 10 s: the app always quits.
5. "Restart needed" and "settings need review" show as a problem in the tray.
6. The release gate treats "how many statements, for which targets" as quality notes, not blockers.
7. esbuild instead of Vite; the preview page for design work lives outside the production build.

## Open items

1. **Nobody has looked at the real Electron window yet.** The UI was driven in a browser preview (both
   appearances, keyboard, focus) and the real app passes the smoke run, but a human should run
   `pnpm --dir app start:scripted` once: fonts macOS picks, the 420 x 600 frame, the tray.
2. A font file, if wanted, is the owner's call (licence and download).
3. Packaging piece: strip the stand-ins at build time and fail the build if a marker survives; move the
   dev switches to build-time constants; `asarUnpack` node-llama-cpp; confirm node-llama-cpp's
   `getLlama()` never touches the network on first run; signing and notarisation.
4. Sub-project C must: answer `failed` (not `black`) when Screen Recording is revoked, tolerate
   `read()` being re-entered, support several `onFocusChange` subscribers.
5. A different account signing in while an upload is in flight leaves that statement in the previous
   owner's outbox until they return (correct, but untested end to end).
6. Tuning: the real model sometimes writes one statement too many or credits a neighbouring skill.
7. Minor items from the reviews are in `.superpowers/sdd/2026-09-17-desktop-shell/progress.md`.
