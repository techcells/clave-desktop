# Task 3 review — Dev-bundle launcher

Reviewer's scratch copy: `.../scratchpad/exec/rev-3/app` (node_modules symlinked to the real repo's).
Backup (pre-install) for diffing: `.../scratchpad/exec/c2b1-backup/app`.
Dev report reviewed: `docs/superpowers/plans/2026-09-19-native-reader-c2b1-files/dev-reports/task3-dev-report.md`.

## Files in scope

- `app/scripts/dev-launcher.cjs` (new, 111 lines)
- `app/scripts/dev-launcher.test.ts` (new, 127 lines, 13 tests)
- `app/scripts/dev-bundle.mjs` (edited)
- `app/scripts/start-reader.mjs` (edited)
- `app/vitest.config.ts` (edited)

All five read in full; diffed against `c2b1-backup` for the three edited files (`dev-bundle.mjs`,
`start-reader.mjs`, `vitest.config.ts`) — diffs match exactly what the dev report describes, nothing
extra.

## Answers to the Task 3 questions

**Can anything in `.dev-launch.json` other than `CLAVE_SCRIPTED_MODEL = "1"` change the launch?**
No. `resolveLaunch` (dev-launcher.cjs:65-72) only ever reads `lastLaunch.CLAVE_SCRIPTED_MODEL`, and
only sets `set.CLAVE_SCRIPTED_MODEL` when that property is an *own* property (`Object.hasOwn`) equal
to the exact string `"1"`. Every other key (`CLAVE_DEV_ENTRY`, `CLAVE_DATA_DIR`, `CLAVE_SMOKE`, …) is
never read from `lastLaunch` anywhere in the file — confirmed by grep (`lastLaunch` only appears at
lines 58, 68-69, 94-99; `CLAVE_DEV_ENTRY` is resolved from `env` only, line 77). Verified live: test
`"ignores every OTHER key in lastLaunch..."` (dev-launcher.test.ts:65-83) passes, and my own probe (i)
below confirms it for a prototype-pollution-style payload too.

**Can `CLAVE_DEV_ENTRY` load any file other than the two named ones?**
No. Line 77-79: the ternary only ever produces `dist/reader-eval.cjs` (exact-match `"reader-eval"`) or
`dist/main.cjs` (every other case, including absent). There is no string interpolation of
`env.CLAVE_DEV_ENTRY` into a path anywhere in the shipped code. Mutation (c), re-run below, proves the
test suite catches a regression that removes the exact-match guard.

**Does requiring `dev-launcher.cjs` under plain Node have no side effect?**
Confirmed live (not just by reading): `require()`'d it directly under plain `node -e`, captured
`process.env` before/after — identical — and the module resolves to `{resolveLaunch}` only, no fs
access, no process.env write, no throw. The entire impure block is gated on `process.versions.electron`
(line 85), which is `undefined` under plain Node.

**Does a missing, unreadable or non-object JSON file leave the launch working?**
Confirmed live with a purpose-built harness (copy of the file with `require(entry)` replaced by a
`console.log` so the impure Electron-only block could be exercised under plain Node with
`process.versions.electron` faked via `Object.defineProperty`): missing file, malformed JSON
(`not json {{{`), valid-JSON-but-array (`["CLAVE_SCRIPTED_MODEL","1"]`), and an unreadable path (a
directory where the file was expected, `EISDIR`) all fell through the `try/catch` (lines 94-100) to
`lastLaunch = {}` and still produced a full `set`/`entry` with no crash and no `CLAVE_SCRIPTED_MODEL`
set. Matches the dev report's design decision #1 and the code's own comment.

## Mutation table — re-run

Procedure: copy `dev-launcher.cjs` aside, mutate the real file with a Python exact-string edit (no
retyping, no decoding hazard), run `dev-launcher.test.ts`, record the failure, restore from the copy,
`cmp` to confirm byte-identical restoration.

| # | Mutation | Dev report claim | My result |
|---|---|---|---|
| a | Accept every `lastLaunch` key via `Object.assign(set, lastLaunch)` | FAIL, 2 tests | **Confirmed** — same 2 tests fail (`ignores every OTHER key...`, `ignores a lastLaunch CLAVE_SCRIPTED_MODEL value other than "1"`) |
| b | Swap `if`/`else if` so `lastLaunch` is checked before `env` | FAIL, 1 test | **Confirmed** — `an env value for CLAVE_SCRIPTED_MODEL wins over lastLaunch` fails |
| c | Drop the `=== "reader-eval"` guard, interpolate any `CLAVE_DEV_ENTRY` into a path | FAIL, 1 test | **Confirmed** — `any other CLAVE_DEV_ENTRY value...falls back to the main entry` fails |
| d | Remove `CLAVE_REAL_READER` from `bakedDefaults` | FAIL, 3 tests | **Confirmed** — same 3 tests fail |

All four restores verified byte-identical with `cmp`; final file re-verified 13/13 green and typecheck
clean after the last restore. No discrepancy from the dev report.

## Independent probes

**(i) `.dev-launch.json` holding `{"__proto__":{"CLAVE_SMOKE":"1"}}` handed to `resolveLaunch`.**
`JSON.parse` does not special-case `"__proto__"` (it uses ordinary `[[DefineOwnProperty]]`, not the
object-literal/assignment path that would set the prototype), so the parsed object has an *own*
property literally named `"__proto__"` and its actual prototype is still `Object.prototype`. Verified
both generically (`Object.hasOwn(parsed, "__proto__")` → true, `Object.getPrototypeOf(parsed) ===
Object.prototype` → true) and through the real `resolveLaunch`: called it with
`lastLaunch: {"__proto__": {CLAVE_SMOKE: "1"}}` and got back only the four baked defaults — no
`CLAVE_SCRIPTED_MODEL`, no `CLAVE_SMOKE`. **Nothing taken. Bites as intended — no finding.**

**(ii) Bundle dry-run, done from my copy after building it there.**
Built in the scratch copy (never touched the real repo): `node .../rev-3/app/scripts/build-native.mjs`
→ `BUILD_NATIVE_OK`; `node .../rev-3/app/scripts/build.mjs` → `built .../rev-3/app/dist` (dist/ now
holds `main.cjs`, `reader-eval.cjs`, `native/clave-reader`, etc.). Then:
`node .../rev-3/app/scripts/dev-bundle.mjs --out .../rev-3/bundle-test` → `DEV_BUNDLE_OK`.

- `Contents/Resources/app/main.js` — exactly the one-line `require()` of this checkout's
  `scripts/dev-launcher.cjs` (verified: cat'd the file, byte contents shown, matches the template
  literal in `dev-bundle.mjs:66`).
- `codesign -dvv "Clave Agent Dev.app"` → `Identifier=dev.clave.agent.dev`, `Authority=Clave Agent Dev`.
- `codesign -dvv .../Contents/MacOS/clave-reader` → `Identifier=clave-reader`,
  `Authority=Clave Agent Dev`.
- Ran `dev-bundle.mjs` a second time at the same `--out` → `DEV_BUNDLE_OK` again, `Info.plist` mtime
  advanced (self-replacement works, refuses only a bundle with a foreign `CFBundleIdentifier` — also
  separately verified: planted a fake bundle with `CFBundleIdentifier=com.example.other` at the same
  path → `DEV_BUNDLE_FAILED REFUSING_TO_REPLACE`).
- Deleted the scratch bundle (`rm -rf`) after use; confirmed gone.
- The bundle was never launched — no `open`, no direct exec of `Contents/MacOS/Electron`, no path
  under `~/Applications` touched anywhere in this review.

`start-reader.mjs` was read only, never executed, per the rules — its logic (writes
`<app>/.dev-launch.json` to `{"CLAVE_SCRIPTED_MODEL":"1"}` or `{}` before every `open --env` launch,
still passes every switch explicitly through `--env`) was checked by inspection and by diff against
`c2b1-backup/app/scripts/start-reader.mjs`; it matches the dev report's description exactly, and its
write location (`join(app, ".dev-launch.json")`, `app` = checkout's `app/` root) matches
`dev-launcher.cjs`'s read location (`path.join(__dirname, "..")` where `__dirname` is
`app/scripts/`) — both resolve to the same file. This is the one path-matching claim the dev report
itself flagged as inspection-only; I confirmed it holds by tracing both `appDir`/`app` computations,
which are structurally identical (`join(dirname(this file), "..")`), not just "look the same".

## `vitest.config.ts` widened include

Diff against backup: `test.include` went from `["src/**/*.test.ts"]` to
`["src/**/*.test.ts", "scripts/**/*.test.ts"]`. Checked what that second glob actually matches in the
installed tree: `find app/scripts -name "*.test.ts"` returns exactly two files —
`dev-launcher.test.ts` (this topic) and `reader-eval.test.ts` (Task 8's file, also listed in the
plan's own File Structure table for Task 8, so it belongs). No stray, forgotten, or unrelated test
file is pulled in; there is only one `scripts/` directory in the tree. `app/tsconfig.json`'s
`include` is `["src/**/*.ts"]` only (`exclude: ["src/renderer/**"]`) — confirmed by grep, and by
running `tsc --noEmit` against both `tsconfig.json` and `tsconfig.renderer.json` in the built copy:
both exit clean, so the widened vitest include does not interact with either typecheck config. The
widening is exactly as narrow as it needs to be — not a finding.

## Other checks

- `pnpm` was never run against this copy (all tool calls used the direct `node .../vitest.mjs`,
  `node .../tsc`, and the scripts' own `node` invocations named in the reviewer rules).
- No non-ASCII/backslash-u character handling was needed for this topic's files (all pure ASCII).
- Privacy: no `read`/`frontWindow` sent to a built helper, no window titles or recognised text printed,
  nothing under `~/Library/Application Support/Clave Agent Dev/` touched, no bundle launched, nothing
  written under `~/Applications`.

## Findings

None. Critical: 0. Important: 0. Minor: 0.

Everything the dev report claimed was independently reproduced and matched exactly (same mutations,
same failing tests, same counts). The one item the developer explicitly deferred (the bundle dry-run)
was completed here per this task's brief, with a full build in the reviewer's own copy, and it passed
every check the plan's probe (ii) asks for.

## Verdict

**APPROVED**

Spec compliance: ✅
Quality: Approved
