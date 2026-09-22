# Task 3 review: the licence file (2026-09-22, independent reviewer)

Verdict: **approve with changes**. The generator, its tests and the real output match design section 10
and rulings R9-R12 for what the staged closure holds; the model refusal, the allow-list, determinism and
the no-path rule hold. Four things need fixing before a build is handed to anyone: one component class the
design overlooked (C1), one wrong licence text in today's file (I1), one latent silent gap (I2) and one wrong
standard text (I3). Nothing under app/out was touched; the repo was not edited apart from this file.

## Findings

### Critical

C1. Packages bundled INTO dist by esbuild are not named at all. react 19.2.0, react-dom 19.2.0 and
scheduler are inlined into dist/renderer/main.js; zod 4.6.5 into dist/main.cjs and dist/model-host.mjs.
They are not in the staged node_modules (app/package.json puts only node-llama-cpp in the staged closure),
so licences.mjs:175-190 never sees them, and rendererBuildOptions.mjs:27 `legalComments: "none"` strips
React's own `@license` header. The bundle therefore ships four MIT packages with no notice anywhere. The
design text ("every third-party component the bundle carries") is violated while the build passes.
Probe: `grep -nE "^(react|react-dom|zod|scheduler) " .../dist/THIRD-PARTY-LICENSES.txt` -> 0 lines;
`grep -c "Minified React error" dist/renderer/main.js` -> 1; `grep -c "ZodError\|zod" dist/main.cjs` -> 670.
Fix: build.mjs already requests `metafile: true` for the renderer (build.mjs:55); write the set of
node_modules packages in every bundle's metafile inputs into dist/build.json, and have generateLicences
read their package.json + LICENSE from appDir/node_modules and check them like the rest. Add a real-file
test needle for "react 19." and "zod 4.".

### Important

I1. rc 1.2.8 prints the wrong text. rc declares `(BSD-2-Clause OR MIT OR Apache-2.0)`, the header says
"distributed here under MIT", but licences.mjs:182 takes `licenceFilesIn(...)[0]`, which after sorting is
LICENSE.APACHE2, so the Apache-2.0 text follows a MIT claim (real file lines 1830-1842; rc also ships
LICENSE.BSD and LICENSE.MIT). Fix: when several licence files exist, prefer the one whose name contains the
chosen licence's id (case-insensitive), else print all of them; add a test with rc's three files.

I2. Dangling appendix references are silent. render() line 145 writes "(standard X text: see the
appendix)" for any entry without its own text, but line 155 drops X from the appendix when
licences.fixed.json has no text for it. texts holds MIT, ISC, Zlib, Unlicense, Apache-2.0 only; ALLOWED also
has MIT-0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, and an `A AND B` result (e.g. "MIT AND
ISC") can never have a text. Today every no-file package is MIT (the five named in the ledger), so the real
file is whole, but a future BSD-licensed package without a LICENSE file would pass the build with a promise
the file does not keep. Probe: mutation RN8 survives (see list); `render({... packages: [{name:"a",
version:"1", licence:"BSD-2-Clause", text:null}] ...})` yields the reference and no appendix entry.
Fix: generateLicences fails with `STANDARD_TEXT_MISSING <licence>` when a needed text is absent; add the
remaining standard texts (or accept the failure as the signal to add one).

I3. The Unlicense text in licences.fixed.json:29 is truncated: it lacks the second paragraph ("In
jurisdictions that recognize copyright laws ... under copyright law.") and the whole warranty paragraph,
and says https://unlicense.org where the canonical text says http://unlicense.org/. Word-level diff against
~/.cargo/registry/src/*/memchr-2.8.3/UNLICENSE: fixed 52 words, reference 197. Unused today (memchr is
"Unlicense OR MIT", resolved to MIT), so the real file is unaffected. MIT (vs electron/dist/LICENSE, 162
words) and ISC (vs staged ini/LICENSE, 111 words) match word for word; the Apache-2.0 notice matches the
appendix of cfg-if's LICENSE-APACHE (78 words). Zlib: no reference copy exists on this machine (the objc2
crates ship no licence files in the registry cache); the text reads as the standard SPDX Zlib wording but I
could not verify it locally.

### Minor

M1. Duplicates: ansi-regex 5.0.1 and strip-ansi 6.0.1 each appear three times (nested copies under cliui,
string-width, wrap-ansi). Correct but noisy; dedupe on name+version+text (146 "Licence:" lines = 1 Electron
+ 2 components + 27 crates + 115 package roots + 1 model, so nothing is missing).

M2. The llama.cpp/ggml copyright line "Copyright (c) 2023-2024 The ggml authors" cannot be verified on this
machine: node-llama-cpp's llama/ tree has no LICENSE, and gitRelease.bundle is a packed (compressed) git
bundle (`grep -a -c "ggml authors"` -> 0). It matches the upstream LICENSE as I know it; state "unverified
locally" in the ledger or copy the line from the llama.cpp release the binaries were built from.

M3. Source lines are raw repository strings: "git@github.com:kwsites/file-exists.git", "git://...",
"git+https://..." (10 lines). Not paths, but ugly; normalise `git+https://` and `git@github.com:` to https.
The 20 distinct e-mail addresses are all inside copied licence texts (copyright lines): intended.

M4. cleanText (licences.mjs:93) refuses only C0 controls; DEL (127) and C1 (128-159) pass. Real file has
none of either (checked byte by byte), but the "no control characters" claim is narrower than it says.

M5. modelSection refuses only `flavour === "release"`; any other string is treated as internal. Safe
because stage.mjs validates FLAVOURS first, but `flavour !== "internal"` would fail closed.

M6. A package root whose package.json lacks name or version is skipped silently (licences.mjs:181). None
today (checked all 115 roots), and stage's installedIds() skips the same way, so the lock check would not
catch it either. A root with code but no name is rare; a counted warning or a fixed failure code is cheaper
than a silent omission.

M7. The crate list comes from the checkout's Cargo.lock at staging time, not from the helper binary
staged in staging/helper (built earlier; here 13:15 vs the licence file's 13:08). If the lock moves
between build-native and stage, the list drifts. Recording `cargo metadata` output beside the helper at
build-native time would also remove cargo from staging's needs. Cargo at staging is otherwise consistent:
same default path and CLAVE_CARGO override as build-native.mjs:14, same PATH prefix (build-native.mjs:21);
`cargo metadata --offline --filter-platform aarch64-apple-darwin` fetched nothing and gave 27 crates + root
(Cargo.lock has 34 packages; the 6 others are other-platform, correctly excluded).

M8. A non-UTF-8 LICENSE (readFileSync yields U+FFFD, cleanText refuses) fails the whole run with
LICENCE_TEXT_UNREADABLE. Strict but consistent with "byte-checked, UTF-8"; today all 110 files pass. Note
only: the escape hatch would be re-encoding by hand. `generateLicences({env: undefined})` would throw at
`env.PATH` instead of returning a code; stage.mjs always passes env.

M9. Crates and the five no-file packages carry no copyright line (MIT asks for "the above copyright
notice"). Design 10 says name/version/licence for crates, so this is within design; cargo metadata's
`authors` field could stand in.

## "A OR B": is picking one option defensible?

Yes, as a reading, not legal advice. An SPDX `OR` is a disjunctive choice offered to the licensee; the Rust
convention (`MIT OR Apache-2.0`, "at your option") says so explicitly. Stating the full expression, the
option taken, and that option's text (R10) is what most SBOM/notice generators do. Two conditions: the
printed text must be the chosen option's (I1 breaks this for rc), and where the package ships its own
LICENSE for that option, that file (with its copyright line) beats the generic appendix text.

## Design match

Named with licence: Electron 44.4.1 (from electron/dist/version), llama.cpp, ggml, 27 crates, 115 package
roots, the model: yes, except C1. Missing licence fails: LICENCE_MISSING; non-permissive fails:
LICENCE_NOT_ALLOWED (both proven by mutation). Model unconfirmed: release refuses MODEL_LICENCE_UNCONFIRMED,
internal prints "Licence: not yet confirmed by the publisher of this build." (real file line 2611). No
"Licence: null" line; every entry has a text or an appendix reference (34 references = 27 + 2 + 5; the
appendix holds MIT only). Deterministic: sorted by name, ties in packageRoots order (stable). No /Users,
/private, /tmp, node_modules/ path in the file. Electron's LICENSE (1,096 B) and LICENSES.chromium.html
(20,111,209 B) are in staging/electron/.

## Surviving mutations (24 of 62; all applied by exact string in the copy, tests re-run each time)

LF4 object `type` may be blank; LF5 licenses[] blanks not filtered; LF6 licenses[] entries not trimmed;
CL3 blank expression not refused explicitly (regex catches it); CL4 WITH not refused explicitly (regex
catches it); CL7 AND returns the cleaned string instead of joined parts; CL8 option-token regex removed
(PREFERENCE membership still refuses); PR1 backslash paths not normalised; PR3 `nm < 0` guard removed;
PR5 a lone "@scope" folder allowed as a root; LI1 packageDir not normalised; LI5 licence-name regex
unanchored; LI6 licence files not sorted; CT3 codes 28-31 allowed; MS1 model.name type unchecked; MS2
`licence: undefined` not treated as unconfirmed; MS3 refuse unless internal; RN2 chosen without `??`
fallback; RN3 "distributed here under" always printed; RN6 source line printed unconditionally
("undefined"); RN8 appendix not filtered by available text (see I2); RN9 appendix unsorted; RN12 no
trailing newline; RN13 appendix header printed when empty. Worth a test each: LF4, MS2, RN3, RN6, RN8,
CT3; the rest are equivalent or harmless mutants.

## Commands run (copy at scratchpad/review-task3/app, node_modules = per-package symlinks; no pnpm)

- `node .../vitest.mjs run --root <copy> scripts/package` -> Test Files 2 passed, Tests 39 passed.
- mutate.mjs (62 mutations, each `vitest run scripts/package/licences.test.ts`) -> 38 killed, 24 survived,
  0 not applied.
- `cargo metadata --offline --format-version 1 --filter-platform aarch64-apple-darwin --manifest-path
  app/native/reader/Cargo.toml` -> exit 0, 28 packages, 27 in resolve besides root; licences: MIT 5,
  MIT OR Apache-2.0 5, Zlib OR Apache-2.0 OR MIT 16, Unlicense OR MIT 1.
- packageRoots over manifest.json's 1431 paths -> 115 roots, 0 skipped, 0 absent from the file, 5 without
  a licence file, 1 with several (rc), 2 name+version pairs at 3 paths each, 20 non-root package.json.
- Real file: 2624 lines, 135,822 bytes, 146 "Licence:" lines, 34 appendix references, 23 "distributed here
  under", 1 appendix section ([MIT]); 0 DEL/C1 bytes, 8 non-ASCII characters, 0 path strings, 0 GPL.
- Word diffs of fixed texts: MIT 0/0, ISC 0/0, Apache notice 0/0, Unlicense 1 only-in-fixed / 145 only-in-
  reference words; Zlib no reference on this machine.
