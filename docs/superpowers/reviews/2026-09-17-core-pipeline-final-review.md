# Core pipeline: final review findings (2026-09-17)

Plan A was executed exactly as written: 164 tests / 16 files pass, typecheck clean, on the pinned
toolchain (typescript 7.0.2, vitest 5.0.1, zod 4.6.5, @types/node 22.20.3). Every file is
byte-identical to the plan's code blocks. **Update, same day: C1, C2, I1 to I5 and the `model.open()` wedge are FIXED (owner-approved); see the last sections. The Minor items are still open**: each one changes
behaviour or adds to the verified plan, so each needs the owner's decision. The reviewer reproduced
every Critical and Important item with a throwaway probe.

## Critical
- **C1. Window titles are never scrubbed.** `app/src/core/index.ts:131-135` scrubs `read.text` only;
  `compact.ts:17` puts `[app — title]` into the scenario text, so a secret or email in a title reaches
  the model prompt. Spec 3.2 says unscrubbed text never moves forward. Fix: scrub `title` (and
  `toolbarText` before use).
- **C2. A `conversation.close()` that never settles wedges the pipeline for good** and keeps the
  running scenario's raw text past 60 minutes. `extraction/extract.ts:43-45` awaits `close()` with no
  timeout; `tick()` only prunes queued scenarios. Likely failure mode of the native model binding in
  sub-project B. Fix: time-box or do not await `close()`.

## Important
- **I1. Recognition-garbled figures leak.** `guard/numbers.ts:31` needs a non-letter before a digit
  run, so `l8420.50` yields no forbidden number, and then both `l8420.50` and the cleaned `8420.50`
  pass the guard. Robust fix: discard any statement that itself contains a figure above ten, a
  decimal, or a number with a unit, whatever was on screen.
- **I2. A person's name made of common words is not forbidden** (`Mark Read`, `Will Page`):
  `guard/forbidden.ts:45-49` applies `COMMON_WORDS` to confirmed people and never adds the full name
  as a phrase. A colleague called `Ruby` also passes when Ruby is an offered skill.
- **I3. Domain labels and repo/folder names are not forbidden as single words**
  (`acme-industries.com` does not forbid `acme`; title `acme-web` forbids only the pair).
  `guard/forbidden.ts:71,78-85`. The @mention path already splits on `[._-]`; reuse that.
- **I4. `+15551234567` survives scrubbing**: `scrub/patterns.ts:39` requires an inner separator,
  although spec 3.2 says a country code is enough.
- **I5. No test covers curly quotes (check 2) or a U+2019 apostrophe in a speaker/labelled name.**
  This gap let a real transcription corruption in Task 9 stay green; it was caught only by a
  byte-diff against the plan. Pure test addition, no behaviour change.

## Minor
- `candidates/ambiguous.ts:26,32`: `HINTS` is a plain object, so a skill normalising to
  `constructor` makes `hintPresent` throw and the scenario is silently dropped.
- `exclusions/sites.ts:2`: host lookahead omits `?`, `#`, `,`, `)`; `online.chase.com?tab=1` is not excluded.
- `exclusions/index.ts:29`: `mayCapture({app: undefined})` throws instead of returning `unknownWindow`.
- `guard/checks.ts:7`: only the double-quote family counts as quotation marks.
- `guard/numbers.ts:55`: `5 ms` on screen, "five milliseconds" passes (units not expanded).
- `guard/forbidden.ts:52`: two-letter proper nouns never forbidden from running text.
- `digest.ts`: over-cap items stay in the pool (visible to `exportPool()`) until day rollover;
  carried items never merge with fresh ones; `importPool` has no count cap and does not re-run the guard.
- `errors.ts`: `CONFIG_INVALID`, `SCRUB_FAILED`, `POOL_IMPORT_INVALID` are never constructed.
- `types.ts`: `WindowRead.at` is never read; `ScrubbedRead.toolbarText` never populated.
- `scenarios/compact.ts:46-49`: oversized-window branch untested; `Math.max(0, room)` missing.
- `imports.test.ts`: list omits `tls`, `worker_threads`, `os`, `process`; dynamic `import()` not caught.
- `testing/fakeModel.ts` ships inside `core/`.
- `extract.test.ts`: the timeout-then-retry path is never exercised.
- `index.ts:64`: an `excludedSite` read resets the away streak (gate runs before `after`).
- Thresholds outside `constants.ts`: `ambiguous.ts` (`<= 3`), `candidates/index.ts` (bonus `2`),
  `forbidden.ts:47,52,63`, `digest.ts:16,19`, `patterns.ts:44` (24-char lookback).
- Eval fixtures: 6 of 8 pass `mustNotAppear` by construction (scripted model never emits the
  forbidden terms); only fixture 06 makes the guard reject. `expectReal` is unread until sub-project B.
- `app/README.md` holds a one-line note that is not needed; delete or reword.

## Verdict
Ready for sub-project B **with fixes**: C1, C2, I5 and a decision on I1 first; I2 to I4 before the
first real-model run.

## Fixes applied 2026-09-17 (owner-approved): C1, C2, I5
Now 170 tests / 16 files, typecheck clean. Six files intentionally differ from the plan's code blocks.
- **C1:** `index.ts` `ingest` scrubs the title as well as the text before storing; exclusions still see the raw title. New test in `pipeline.test.ts`.
- **C2:** `constants.ts` adds `MODEL_CLOSE_TIMEOUT_MS = 5_000`; `extract.ts` time-boxes `conversation.close()`. New test in `extract.test.ts`.
- **I5:** four tests in `guard.test.ts` (curly double quotes, guillemets, U+2019 in a chat speaker and in a labelled name), written with `\u` escapes. Proven to fail when the guard regexes are corrupted to ASCII.
- **Same class as C2, also fixed:** `model.open()` is time-boxed with `MODEL_OPEN_TIMEOUT_MS = 30_000`; a conversation that arrives after the timeout is closed. Two tests in `extract.test.ts`. Suite is now 172 tests. The 30 s assumes the app loads the model before `open()`; raise it if `open()` does the cold load.

## Fixes applied 2026-09-17 (owner-approved): I1 to I4
Now 257 tests / 16 files, typecheck clean. Each fix was reviewed independently and the review findings fixed in turn.
- **I1 (figures):** the guard now judges the statement itself, whatever was recognised on screen (`hasFigure` in `guard/numbers.ts`, called from check 1). Discarded: a number above ten, any decimal (also `.95`), a number with a unit, spelled forms (also ordinals, "hundreds", "dozens"), a spelled one to ten followed by a magnitude, sub-second, data, rate, money or percent unit, mixed letter-digit tokens with more than `GUARD_MIXED_TOKEN_MAX_DIGITS` (2) digits (`l8420.50`, `ES2015`), runs of non-ASCII digits. Allowed: bare 0 to 10 ("two pull requests"), spelled small durations ("one week"), short tokens (`k8s`, `S3`, `p95`, `i18n`), a fixed list of standard identifiers (`SPEC_FIGURE_TERMS`: SHA-256, TLS 1.3, C++17, 24/7, ES20xx ...), and figures inside an offered skill name (`Forbidden.allowedFigures`, anchored so "Python 3" cannot excuse "Python 3000").
  Known costs: product versions ("Java 17", "Python 3.11") are discarded unless the taxonomy offers them with the version; two-digit garbles (`l42`) and small ranges (`5-8`) pass by design; "3 days" in digits is discarded, "three days" is not.
- **I2 (names made of common words):** new `Forbidden.capitalised` set. Common-word tokens of a confirmed person's name (chat speaker, labelled name) are forbidden when capitalised mid-statement, or as the first word when followed by a past-tense verb ("Read confirmed ..."). Lowercase verb uses pass. A full name with at least one uncommon token is also a forbidden phrase, which beats the skill allowlist ("Ruby Chen").
  Known cost: a model that writes such a name in lowercase slips through; a colleague called Ruby can be named by first name when Ruby is an offered skill.
- **I3 (domain labels, repo and folder names):** `addParts` forbids single parts (at least `GUARD_MIN_PART_CHARS`, 3) of title compounds, file stems, URL host labels (TLD, `www`, port and userinfo handled; the URL username is forbidden too), URL path segments and path segments. Exempt: common words, offered skill names, words also used in lowercase prose on screen (the spec's amended rule), and generic technical vocabulary in the new `guard/genericParts.ts` (api, src, github, node, com, etc ...).
  Known cost: parts of a hyphenated document title (`engineering-onboarding-checklist`) become forbidden words for that scenario; a company literally named after a generic part is not caught by this route.
- **I4 (phones):** `+15551234567` is scrubbed. Side effect accepted: a signed figure such as `+1234567890` is also labelled `[PHONE]`.
- Rulings behind each choice: `.superpowers/sdd/2026-09-17-core-pipeline/progress.md`.
