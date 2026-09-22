# Core pipeline: design

Date: 2026-09-17. Status: approved 2026-09-17; amended the same day to match the verified implementation plan
(short/ambiguous skill names, stricter phone rule, person-name detection, English check,
`takeCounters`, evaluation set size). Every amendment is listed in the plan's "Deviations" section. Sub-project A of the asset-to-evidence app.
Context and decisions: `docs/implementation-plan.md`.

## 1. Purpose and boundary

The core pipeline is a TypeScript library that turns text read from the user's focused
window into a short daily list of evidence statements ready for the user to approve or
reject. Every privacy guarantee that can be enforced in code is enforced here.

It has **no Electron, no native code, no network and no disk access**. It can run and be
tested in plain Node.

### In scope

Exclusions, secret scrubbing, the rolling buffer, scenario grouping, candidate skill matching,
prompts and answer forms, two-pass extraction with validation, the safety guard, the daily
digest, counters.

### Out of scope (other sub-projects)

Capturing and recognising text, the Electron shell, login, fetching the taxonomy, persisting
the digest, upload, sending analytics, the review screen.

### Decisions this design rests on

| Decision | Value |
|---|---|
| Source of text | Screenshot of the focused window plus OS text recognition, done outside the core |
| What is extracted | Skills and competencies. Not expertises |
| Skill matching | Local name and alias matching, then the model verifies (no embeddings, no free-typed names) |
| Extraction | Two passes in one conversation: gate, then statements |
| Statement form | Starts with a past-tense verb, names no one, 15 to 25 words, always English |
| Review volume | Capped daily digest; overflow is dropped, never queued |
| Retention | In memory only; nothing raw older than 60 minutes; scenario text dropped when extraction ends |
| Model | Qwen3.5-4B via node-llama-cpp, thinking discouraged, reached only through a port |

## 2. Public interface

```ts
export interface Pipeline {
  /** Ask BEFORE capturing. Pure decision on app and window title. */
  mayCapture(front: FrontWindow): CaptureDecision;
  /** Hand in one recognised read. Returns what happened to it. */
  ingest(read: WindowRead): IngestOutcome;
  /** Drive time-based rules. Call about once a second; cheap when idle. */
  tick(): void;
  /** Screen locked/unlocked, user switched capture on/off. */
  signal(s: 'locked' | 'unlocked' | 'captureOn' | 'captureOff'): void;
  /** Today's pending statements, after de-duplication, ranking and caps. */
  digest(): PendingStatement[];
  /** The app calls this after the user decided; removes the item from the pool. */
  resolve(id: string, decision: 'approved' | 'rejected'): void;
  /** Numbers only. */
  counters(): Counters;
  /** Returns the counters and resets them. Called by the app when it sends its daily summary. */
  takeCounters(): Counters;
  /** Replace configuration (exclusions, taxonomy, user names) at runtime. */
  configure(config: PipelineConfig): ConfigResult;
  /** Finished statements only, for the app to persist encrypted. Import validates every item. */
  exportPool(): PendingStatement[];
  importPool(items: unknown): { accepted: number; rejected: number };
  /** Resolves when no extraction is running or queued. For tests and clean shutdown. */
  whenIdle(): Promise<void>;
}

export function createPipeline(config: PipelineConfig, ports: Ports): Pipeline;

export interface Ports {
  model: ModelPort;
  clock: { now(): number; dayKey(epochMs: number): string };  // epoch ms; dayKey is the user's local calendar day, e.g. '2026-09-17'
  newId(): string;
}

export interface ModelPort {
  /** One conversation. The core owns prompts, forms and validation; the app runs the model. */
  open(settings: ModelSettings): Promise<ModelConversation>;
}
export interface ModelConversation {
  ask(userText: string, form: JsonSchema, limits: { maxTokens: number; timeoutMs: number }): Promise<unknown>;
  close(): Promise<void>;
}
export interface ModelSettings {
  systemPrompt: string;
  thoughts: 'discourage';
  templateVariation: '3.5';
  temperature: number;                 // 0.2; 0.0 on retry
}

export interface FrontWindow { app: string; bundleId?: string; title: string }
export interface WindowRead extends FrontWindow {
  text: string;
  /** Browsers only: recognised text of the window's top toolbar strip (address bar and its neighbours). */
  toolbarText?: string;
  at: number;
}

export type CaptureDecision = { allow: true } | { allow: false; reason: SkipReason };
export type IngestOutcome = { kept: true } | { kept: false; reason: SkipReason };
export type SkipReason =
  | 'captureOff' | 'locked' | 'unknownWindow' | 'excludedApp' | 'excludedTitle'
  | 'privateWindow' | 'excludedSite' | 'rulesInvalid' | 'scrubFailed' | 'unchanged' | 'empty';

export interface PipelineConfig {
  exclusions: string[];                // 'App', 'App::Title', '::Title'
  excludedSites: string[];             // hostnames or bare labels
  taxonomyVersion: string;             // stamped onto every statement
  skills: Skill[];                     // active skills only
  competencies: Competency[];
  userNames: string[];                 // Clave display name plus any the user added
}
export interface Skill { id: string; displayName: string; canonicalName: string; aliases: string[] }
export interface Competency { id: string; name: string; description: string }

export interface PendingStatement {
  id: string;
  kind: 'skill' | 'competency';
  targetId: string;                    // skill or competency id that was OFFERED to the model
  statement: string;
  createdAt: number;
  taxonomyVersion: string;
  pipelineVersion: string;
}
```

`configure` returns `{ ok: true }` or `{ ok: false; problems: string[] }`. While a configuration
is invalid, `mayCapture` answers `rulesInvalid` for everything.

## 3. Stages

Order: exclusions, scrub, buffer, scenarios, candidates, extraction, guard, digest. Each is a
module with one job, no shared mutable state except what is passed in, and its own tests.

### 3.1 Exclusions

Called twice per read.

**Before capture** (`mayCapture`), on app and title only:
- Capture off or screen locked: deny.
- Empty or unknown app or title: deny (`unknownWindow`).
- Built-in, not user-editable: lock screen and login processes, system UI, our own app.
- User-editable defaults, seeded on first run:
  - Excluded: password managers and keychain tools; Telegram, WhatsApp, Messages, Signal;
    banking and payment keywords in titles.
  - Read by default because they are work tools: Slack, Microsoft Teams, Discord.
- Rule syntax: plain string, case-insensitive substring. `App` matches app OR title, `App::`
  matches the app only, `App::Title` requires both, `::Title` matches the title in any app.
  `::` splits once. A rule with both halves empty is dropped. Seeded defaults for apps use the
  `App::` form so that a title merely containing the word ("Direct messages") is not excluded.
- Built-in exclusions match the exact app name, so "Dock" never excludes "Docker Desktop".
- Private browsing: title contains a specific localised phrase (for example "Private Browsing",
  "(Incognito)", "InPrivate"). Never the bare word "private". A regression list of former
  false positives is part of the tests.
- The ignore list is absolute and evaluated first. There is no allowlist in version 1.

**After recognition** (`ingest`), browser windows only:
- A window is a browser window if its app is in a fixed browser list.
- Match `excludedSites` against the hostname parsed from `toolbarText`, and against the
  title. Hostname rules: exact host, or subdomain on a dot boundary; a bare label such as
  `chase` matches any domain label, so `online.chase.com` matches and `purchase.com` does not.
- Either signal matching drops the read (`excludedSite`).
- If `toolbarText` contains a private-mode phrase (for example "Incognito", "InPrivate",
  "Private Browsing"), drop (`privateWindow`). This is how Chromium private windows are caught
  on Mac, where the window title carries no marker.

A rule that fails to parse makes the whole configuration invalid. Unknown never means yes.

### 3.2 Secret scrubbing

Runs on every read before storage. Deterministic patterns only.

| Class | Rule |
|---|---|
| Private key blocks | `-----BEGIN … PRIVATE KEY-----` style markers through the end marker |
| Connection strings | scheme://user:password@host for database and queue schemes; generic `user:pass@host` |
| Authorization headers | `Authorization: Bearer|Basic …` |
| Provider keys | Known prefixes with minimum lengths (OpenAI, Anthropic, Stripe, GitHub, Slack, AWS access key id, Google, Hugging Face) |
| Tokens | JWT shape (three base64url segments starting `eyJ`) |
| Generic assignments | `password|secret|token|api_key = value` with a value of 8+ non-space characters |
| Emails | standard shape |
| Cards | 13 to 19 digits with optional separators AND a passing Luhn check |
| Phones | require a country code, parentheses, or a label such as "phone:" just before. Separators alone are not enough: `4821-0412-7788` is a reference number |

Rules: bare digit runs are never touched; when matches overlap, the secret class wins; each
match becomes a fixed label (`[SECRET]`, `[EMAIL]`, `[CARD]`, `[PHONE]`). If scrubbing throws,
the read is dropped (`scrubFailed`). Unscrubbed text never moves forward.

### 3.3 Rolling buffer

In memory only. Holds scrubbed reads for at most 60 minutes (`BUFFER_MAX_AGE_MS`).
- Per window key (`app` + `title`), a read is kept only if its text hash differs from the last
  kept read for that key (`unchanged` otherwise). The remembered hash for a key is cleared when
  focus moves to a different key.
- Text under `MIN_READ_CHARS` (40) after scrubbing is dropped (`empty`).
- `locked` or `captureOff` stops ingestion at once. Expiry keeps running.
- `captureOff` additionally closes the open scenario.

### 3.4 Scenarios

A scenario is a continuous stretch of work across any number of windows.

A scenario is time-contiguous: every kept read joins the open scenario, whatever window it came
from. "Activity" means any `mayCapture` or `ingest` call that was not denied for `locked` or
`captureOff`, including reads skipped as `unchanged`. A user reading a static page is active.

Closes when any of these is true:
- `SCENARIO_IDLE_MS` (5 min) without activity.
- `SCENARIO_AWAY_MS` (2 min) during which every `mayCapture` call was denied for an exclusion
  reason (`excludedApp`, `excludedTitle`, `privateWindow`). The user moved to something we do
  not look at, so the stretch of work has ended.
- `SCENARIO_MAX_MS` (10 min) since the scenario opened: hard cap.
- `captureOff`, or `locked` lasting longer than `SCENARIO_IDLE_MS`.

On close:
- Drop it if total distinct text is under `SCENARIO_MIN_CHARS` (400).
- Compact: per window keep the latest read plus up to `SNAPSHOTS_PER_WINDOW` (3) earlier reads
  whose line-level overlap with every kept read is below 60%. Order by time. Label each block
  `[App — Title]`.
- Trim oldest blocks first until the whole scenario is under `SCENARIO_MAX_CHARS` (24,000,
  roughly six thousand tokens).
- Queue it for extraction. Queue length is `EXTRACTION_QUEUE_MAX` (3); when full, the oldest
  waiting scenario is dropped and counted.

All constants live in one file.

### 3.5 Candidate skills

Pure code, no model.
- Build once per configuration: a map from normalised phrase to skill id, from display name,
  canonical name and aliases. Normalisation: lowercase, collapse whitespace, keep `+ # .` inside
  tokens so `C++`, `C#`, `Node.js` survive.
- Scan the scenario with whole-word matching; multi-word names match as phrases; longest match
  wins at a position.
- Short names (two or three characters, such as AWS) count only with the exact casing of one of
  the skill's own name forms. Names on a fixed list of common English words (Go, Swift, Rust,
  React, Spring, Express, Flask and similar) and single-letter names (R, C) need that exact casing
  AND a supporting hint elsewhere in the scenario, from a built-in table of file extensions,
  commands and identifiers per name. (The configuration carries no skill categories, so "another
  skill from the same category" is not available as a signal.)
- Score = occurrences, plus a bonus for appearing in more than one window. Keep the top
  `MAX_CANDIDATE_SKILLS` (20).
- All competencies are always offered, with descriptions.
- Zero skill matches is fine: the scenario proceeds with competencies only.

### 3.6 Extraction

One scenario at a time. One conversation, two asks.

**Pass 1, the gate.** Form, in this field order:
```json
{ "activity_summary": "string, max 500",
  "is_professional": "boolean",
  "user_demonstrated_something": "boolean" }
```
The summary comes first so the model reasons before deciding. It is discarded after pass 2 and
never leaves the machine. If either boolean is false, stop. Limits: 300 tokens, 30 s.

**Pass 2, statements.** Only if both booleans are true.
```json
{ "evidence": { "minItems": 1, "maxItems": 5,
    "items": { "target_id": "enum of offered skill and competency ids",
               "statement": "string, max 260" } } }
```
Limits: 700 tokens, 60 s.

**System prompt content**, owned by the core: who the user is (`userNames`, and that everyone
else in a chat is someone else); the text is recognised from screenshots and may contain small
errors; the evidence test (could someone who never did this say the same?); demonstration versus
mention; colleagues' work is never the user's; private or non-professional activity yields
nothing; the statement form (past-tense verb first, no names of people, companies, clients,
products or projects, no quotes, no identifying figures, 15 to 25 words, English regardless of
the language on screen); one item per skill or competency actually shown; the offered list with
ids.

**Validation.** Every answer is validated in TypeScript against the same form (zod), independent
of the runtime's enforcement. `target_id` must be in the offered set. On an invalid answer, an
error or a timeout: retry once with temperature 0. Second failure discards the scenario.

The scenario's text is released as soon as extraction ends, success or not.

### 3.7 Safety guard

Runs on every draft statement. All checks must pass; any failure discards. The guard never
rewrites.

**Forbidden terms, built from that scenario's text and window titles:**
- Person names: the speaker at the start of a chat line (`Name Surname 10:42`); names after
  labels such as Assignee, Reporter, Author, Owner, Reviewer, Cc; `@mentions`.
- Proper nouns: a capitalised word in the middle of a line that is not a common English word, not
  an offered skill or competency name, and never appears in plain lowercase prose in the same
  scenario. (Forbidding every run of capitalised words would discard ordinary headings such as
  "Root Cause".) All-caps acronyms are not treated as names; this is a stated limit.
- Organisation, project and product names: capitalised tokens from window titles, workspace
  names, repository and folder names, domain labels.
- Emails, URLs, file paths, ticket identifiers (`[A-Z]{2,}-\d+`).
- Numbers: every number in the scenario of two or more digits, or carrying a unit, in digit
  form and in spelled-out English form ("eight million", "thirty-second"). Single digits and
  the words one to ten are allowed.
- The user's own names.

**Allowlist, subtracted from the above:** display names, canonical names and aliases of the
offered skills and competencies; a fixed list of common English words.

**Checks on the statement:**
1. Contains no forbidden term (case-insensitive, whole word).
2. Contains no quotation marks of any kind.
3. 8 to 40 words.
4. First word is not a pronoun, not a forbidden term, and ends like a past-tense verb or is on
   a short list of irregular past forms.
5. At least two common English function words are present (a cheap English check).
6. `target_id` was offered for this scenario.

Bias: when unsure, discard. Every discard is counted by check number.

**Known limit, stated in the review screen:** the guard catches names and identifiers that
appeared on screen. It cannot recognise a confidential fact expressed in generic words. That is
what the user's approval is for.

### 3.8 Daily digest

Pool of guarded statements for the current local day (`clock.dayKey`).
- Near-duplicates: within the same `target_id`, two statements whose content-word sets overlap
  60% or more are merged; keep the one with more distinct content words.
- Rank: more specific first (content-word count within the length bounds), then prefer targets
  not yet represented.
- Caps: `DIGEST_PER_TARGET` (2), `DIGEST_PER_DAY` (10). Overflow is dropped and counted, never
  queued.
- Unresolved items expire after `DIGEST_ITEM_TTL_DAYS` (3).
- `digest()` returns the current list; `resolve()` removes an item.

The core stamps `taxonomyVersion` and `pipelineVersion`; the app adds the model file version at
upload, since the core does not know which model ran.

The pool holds finished statements only. Persisting it (encrypted) is the app's job; the core
exposes `exportPool()` / `importPool()` for that and validates on import.

## 4. Failure behaviour

| Failure | Behaviour |
|---|---|
| Invalid configuration | `mayCapture` denies everything with `rulesInvalid` until fixed |
| Scrubber throws | Read dropped |
| Scenario too thin | Dropped, model not called |
| Model error, timeout, invalid answer | One retry at temperature 0, then scenario discarded |
| Model slow | Queue of 3, oldest dropped; capture never waits |
| Guard unsure | Statement discarded |
| Lock or capture off | Ingestion stops at once; in-flight extraction finishes; buffer keeps expiring |

Errors are fixed codes (`CoreErrorCode`). No error object, message or counter ever contains
captured text.

## 5. Counters

Plain numbers, exposed by `counters()`. They are reset by `takeCounters()`, which the app calls
when it sends its daily summary (a silent midnight reset would lose the day's numbers):
reads kept; reads skipped by `SkipReason`; scenarios closed, dropped thin, dropped from queue;
gate passes run; gate said not professional; gate said nothing demonstrated; statement passes
run; retries; scenarios failed; statements drafted; statements discarded by guard check;
digest kept, merged, capped, expired; statements approved, rejected.

## 6. Testing

1. **Unit tests per stage** with an injected clock and a scripted fake model. No model file.
2. **Privacy tests that fail the build:**
   - Leak fixture: a scenario full of names, a company, emails, a ticket id, secrets and
     figures, run with a fake model that deliberately returns leaky statements. Nothing forbidden
     may reach `digest()`.
   - Scrubber must-match list (real key shapes) and must-not-match list (order numbers,
     coordinates, timestamps, version strings, hashes).
   - Private-browsing phrase list with its false-positive regression list.
   - A test over the import graph that fails if any core module imports `fs`, `net`, `http`,
     `child_process` or `electron`, or calls `console`.
3. **Evaluation set** in `eval/`: one fixture per category to start (eight), growing toward
   about twenty by adding a regression fixture for every wrong outcome found while tuning. Real work in
   English and in Portuguese, private activity, mixed sessions, a colleague's achievement, names
   everywhere, a secret on screen, recognition noise. Runs against the fake model on every
   change; against the real pinned model as a release gate. Doubles as a fine-tuning dataset.
4. **Property checks:** digest never exceeds its caps; nothing in the buffer is older than 60
   minutes after any `tick`; every digest item's `targetId` was offered; `mayCapture` is `false`
   for every input while configuration is invalid.

## 7. Layout

```
app/src/core/
  index.ts            createPipeline, public types
  constants.ts
  exclusions/         rules.ts, sites.ts, privateWindows.ts, defaults.ts
  scrub/              patterns.ts, scrub.ts, luhn.ts
  buffer.ts
  scenarios/          segmenter.ts, compact.ts
  candidates/         index.ts, normalise.ts, ambiguous.ts
  extraction/         prompts.ts, forms.ts, extract.ts
  guard/              forbidden.ts, numbers.ts, checks.ts
  digest.ts
  counters.ts
  errors.ts
eval/
  fixtures/*.json
  run.ts
```

## 8. Open points to settle during the build

- The exact ambiguous-name list and the common-English allowlist: start small, grow from the
  evaluation set.
- Thresholds in `constants.ts` are first guesses to be tuned from real usage.
- Whether the gate should also return a coarse activity category for counters (no content).
