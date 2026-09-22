# Task 2 review: staging and pruning (2026-09-22)

Reviewed on a private copy of app/ (scratchpad/review-task2/app, no node_modules of its own, per-package
symlinks to the repo's packages, never pnpm'd). The repo's stage.mjs moved on DURING this review (Task 3
added `licences.mjs`/`walk.mjs` imports and a licence step); line numbers below are the Task 2 version
as captured at 13:03; in the current file add 2 after line 22, and `walk()` now lives in walk.mjs.

## Verdict: APPROVE WITH CHANGES

The staged tree matches design 4.1/4.2 on every asserted point: asar root = package.json + dist/ (9
allow-listed files) + node_modules/ (hoisted, 0 symlinks, 0 dotfiles, 0 .d.ts, 0 .map, no typescript,
no other-platform package); helper beside the root (Mach-O arm64, mode 755 preserved); reader-eval.cjs
and eval-gate.mjs absent; standins-taxonomy.json present (internal). Every refusal named in the brief
exists and is tested except as listed under Important. No Critical finding. The changes asked for are
test gaps (mutation survivors) and ledger corrections, not code behaviour.

## Findings

### Important

I1. `buildNumber` and `buildInfo` (scripts/flavour.mjs:58-72) have NO tests. scripts/flavour.test.ts
never imports them; every one of 7 mutations survived (UTC->local hours, month off by one, unpadded
day, separator, both refusals, constant appName). `buildInfo.flavour` is what DIST_FLAVOUR_MISMATCH
trusts and `appName` is what About will show. Probe: `grep -n "buildNumber\|buildInfo"
app/scripts/flavour.test.ts` -> 0 lines. Fix: add a describe over a fixed Date and the two throws.

I2. `pruneDecision` (stage.mjs:109): removing `parts.length >= 2 &&` survives. That mutation makes the
bare scope directory `@node-llama-cpp` (and `@reflink`) a `drop`, and since the prune walk is
parent-first (stage.mjs:285-287) the whole scope, mac-arm64-metal included, would go; only the
optional real-manifest test would notice. Probe: mutate, run the suite -> 23 passed. Fix: assert
`pruneDecision("@node-llama-cpp") === "keep"` and `pruneDecision("@reflink") === "keep"`.

I3. `manifest()` header (stage.mjs:155): dropping any of flavour/appName/version/buildNumber survives
(4 mutations); the test asserts only files/fileCount/totalBytes. Task 4+ will read these fields.

### Minor

M1. Ledger says mac-arm64-metal "also holds two .so files"; the real folder holds FIVE (libggml-blas,
libggml-cpu-apple_m1, _m2_m3, _m4, libggml-metal), all `Mach-O 64-bit bundle arm64`, plus 4 .dylib and
1 .node: 10 Mach-O files Task 5 must sign. Bins folder is complete and byte-identical to the repo's
.pnpm copy (11 files, sha256 equal). Correct the ledger.

M2. `forbidden` second line of defence is thinner than `pruneDecision` (stage.mjs:135-141): a
`.d.mts`/`.d.cts` under node_modules returns null (probe: `forbidden("node_modules/zod/index.d.mts")`
-> null); a NESTED `node_modules/x/node_modules/typescript/...` or nested `@node-llama-cpp/linux-x64`
passes both functions (both look only at parts[0]/parts[1]). Not reachable in the real run (the 9
nested node_modules hold 15 plain-JS packages), but the design's "every @node-llama-cpp/* other than
mac-arm64-metal" is stated without depth.

M3. Untested branches (mutation survivors, all real code): `.cer`/`.key` in FORBIDDEN_EXTENSIONS,
`.so`/`.dll`/`.metallib` in BINARY_EXTENSIONS, `toLowerCase()` (an uppercase `.P12`), the `.d.cts` drop,
`lockHas` exact-indent (a `trim()` mutant survives), `resolveOut` bare `~`, `resolve()` of a relative
`--out` (resolves against cwd, not appDir), and the `banned + "/"` slash. One assertion each.

M4. stage() on failure after line 247 leaves a half-built `<out>/<flavour>/staging/` with no
manifest.json and, when pnpm fails, the copied pnpm-lock.yaml/pnpm-workspace.yaml still in app/
(removed only on success, lines 273-274). The next run wipes it; the bundle step must require
manifest.json rather than the folder.

M5. stage.mjs:242 builds the runtime package.json from app/package.json's version, but the manifest's
version comes from dist/build.json (line 302). A version bump between build and stage ships two
versions silently. Cheap refusal: `info.version !== appPackage.version` -> DIST_NOT_BUILT.

M6. The lock check (stage.mjs:279-281) reads only package.json files whose path `pruneDecision` keeps
(so dropped packages are not read; nested node_modules ARE walked). It skips the 20 non-package
package.json files (signal-exit/dist/mjs, node-llama-cpp/llama, ...) only because they lack
name+version; a vendored one that has both would false-positive LOCK_MISMATCH. `lockHas` also matches
`snapshots:` lines (same shape as `packages:`), which is equivalent. Acceptable; note it in a comment.

M7. Ships but is not needed at run time (no design rule broken; size and surface only, 1430 files):
@huggingface/jinja/src/*.ts (7 plain .ts sources), 2 tsconfig.tsbuildinfo, sleep-promise/yarn.lock,
retry/Makefile + equation.gif, test/ and example/ folders (minimist 15, retry 7, rc 3, isexe 1,
url-join 1, @kwsites 2, node-api-headers 1), node-llama-cpp/templates (3), bins/*.moved.txt (12),
cmake-js .cc/.cs, node-addon-api .gyp/.gypi/.c. 21 files carry the executable bit (cli entry
scripts). node-llama-cpp/dist/cli/ (45 files) CANNOT be dropped: 5 library files import from it
(LlamaModel.js, GgufInsights.js, resolveModelFile.js, withProgressLog.js, commands.js); the design's
"bin CLI entry" is satisfied by dropping `.bin`. gitRelease.bundle: 34,969,437 bytes = 59% of the
59,283,615 total; Task 5's decision.

M8. The import gate `process.argv[1].endsWith("stage.mjs")` (line 308) also fires for any entry
script whose name ends in `stage.mjs`. Compare to `fileURLToPath(import.meta.url)` instead.

M9. stage.test.ts is type-checked by nobody (tsconfig includes src/** only; same as flavour.test.ts,
which says so). Running tsc on it directly gives TS7016 on the .mjs import; the `as {...}` cast hides
it. Informational.

## What was verified (and holds)

- Nothing runs at import: dynamic import of the copy's stage.mjs lists 16 exports, creates no out/.
- `env`: `{...env, CI: undefined}` really unsets CI for the child (probe under CI=1 -> `CI=[]`).
- cpSync is only ever called on files; mode preserved (helper 755 in staging).
- Prune walk is parent-first; a dropped parent's children are rmSync'd with force (no-op). Symlinks
  are recorded as their own kind and never descended; SYMLINK_IN_DIST and SYMLINK_IN_STAGING both
  fire before any manifest is written.
- A second run wipes only `<out>/<flavour>/staging`; another flavour's staging survives.
- Real run reproduced in the copy from the dev dist: STAGE_OK, 1430 files, same path set as the
  repo's internal run; only the 6 flavour-bearing files differ by hash (dist/*.cjs|mjs|js,
  build.json, package.json). 1.4 s wall time.
- node-llama-cpp `files` (dist, templates/packed, llama, bins, package.json, README, LICENSE): staging
  listing equals the repo's, 368 = 368 files after excluding .d.ts/.map/dotfiles (only
  llama/.clang-format dropped). @node-llama-cpp/mac-arm64-metal: listing and hashes identical.

## Surviving mutations (31 of 107; 76 killed; 0 unmatched)

Equivalent or harmless (7): S6 native/ refusal removed (line 56 catches it), P1 empty path -> drop,
P14 llama rule ignores package name, F1 empty path -> null, F24 `.bin` check (dead: dotfile rule
first), F32 DIST_NEVER at any depth (stricter), O10 `banned` without slash (stricter).
Real gaps (24): R3 dependency regex loses `$` ("3.21.1-beta" accepted); L3 lockHas trims; P7 bare
scope dir dropped (I2); P11 .d.cts; F3 .cer; F3 .key; F14 toLowerCase; F15 .so; F15 .dll; F15
.metallib; F33 package.json allowed at any depth; M4-M7 manifest header fields (I3); O3 bare `~`;
O5 resolve() removed; B1-B7 buildNumber/buildInfo (I1).

## Commands run (copy = scratchpad/review-task2/app)

- `node app/node_modules/vitest/vitest.mjs run --root <copy> scripts/package` -> 1 file, 23 passed
  (the real-manifest case is absent in the copy; 24 in the repo).
- `node app/node_modules/typescript/bin/tsc --noEmit --strict ... <copy>/scripts/package/stage.test.ts`
  -> 1 error (TS7016, see M9); with --allowJs --checkJs -> 20 errors, all implicit any in stage.mjs.
- `node --input-type=module -e "import('<copy>/scripts/package/stage.mjs')"` -> 16 exports, no out/.
- `node <copy>/scripts/package/stage.mjs --out <scratch>/out` (dev dist) -> STAGE_OK dev files 1430
  bytes 59283173; 0 symlinks, 0 dotfiles.
- `node scratchpad/mutate.mjs` -> 107 mutations, 76 killed, 31 survived, 0 unmatched (list above).
- Manifest probes over app/out/internal/staging: 1430 files, 59,283,615 bytes, 33 extensions;
  find -type l -> 0; find -name '.*' -> 0; find -type f -perm +111 -> 22 (21 in node_modules + helper);
  package.json census 135, 20 without name+version; metal bins sha256 diff -> identical (11 files).
