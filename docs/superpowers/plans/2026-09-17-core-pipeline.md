# Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-TypeScript library that turns recognised window text into a capped daily list of guarded evidence statements ready for the user to approve or reject.

**Architecture:** Eight small stages (exclusions, scrub, buffer, scenarios, candidates, extraction, guard, digest) wired together by `createPipeline`. The library has no Electron, native, network or disk access; the model and the clock are injected as ports, so every rule is tested with a fake model and a fake clock. The app asks `mayCapture` before any screenshot and hands recognised text to `ingest`.

**Tech Stack:** TypeScript 7, Vitest 5, Zod 4, pnpm 11, Node 24. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-core-pipeline-design.md` (read it first; this plan argues from it).

## Global Constraints

- **No git operations.** The folder is not a git repository and the owner's standing rule forbids init, commit, branch or push unless he asks. Where a normal plan says "commit", this plan says **Checkpoint**: run the full test suite and typecheck, and stop if either fails.
- Core code lives in `app/src/core/`. It must never import `fs`, `node:fs`, `net`, `http`, `https`, `child_process`, `electron`, or any logger. Test files (`*.test.ts`) are exempt. Task 1 adds a test that enforces this.
- No captured text may appear in any `Error` message, error code, counter, or `console.*` call. Errors are fixed codes from `errors.ts`.
- Nothing raw survives longer than 60 minutes (`BUFFER_MAX_AGE_MS`). A scenario's text is released as soon as extraction ends.
- Statements: start with a past-tense verb, name no one, 15 to 25 words asked of the model (8 to 40 accepted by the guard), always English.
- v1 extracts skills and competencies only. No expertises.
- All thresholds are named constants in `app/src/core/constants.ts`. No magic numbers elsewhere.
- Tests are colocated: `foo.ts` is tested by `foo.test.ts` in the same folder.
- Run every command from the repository root: `/Users/sardorastanov/techcells/asset-to-evidence`. Use `pnpm --dir app <script>`; do not `cd`.
- Package versions to pin: `typescript@7.0.2`, `vitest@5.0.1`, `zod@4.6.5`, `@types/node@22.20.3`.

## File Structure

```
app/
  package.json              scripts: test, typecheck
  tsconfig.json
  vitest.config.ts
  src/core/
    index.ts                createPipeline: wires every stage; the only public entry
    types.ts                every public and shared type
    constants.ts            every threshold
    errors.ts               CoreErrorCode, CoreError
    counters.ts             plain-number counters
    imports.test.ts         fails if core imports a forbidden module
    exclusions/
      rules.ts              parse and match 'App', 'App::Title', '::Title'
      privateWindows.ts     private-browsing phrases for titles and toolbar text
      sites.ts              hosts from toolbar text; domain-boundary matching
      defaults.ts           built-in and seeded default lists
      index.ts              createExclusions: mayCapture + afterRecognition
    scrub/
      luhn.ts
      patterns.ts           the deterministic pattern table
      scrub.ts              scrub(text) -> { text, counts }
    buffer.ts               60-minute in-memory store with per-window de-duplication
    scenarios/
      segmenter.ts          decides when a scenario closes (timestamps only)
      compact.ts            turns buffered reads into one bounded scenario text
    candidates/
      normalise.ts          tokenising shared by candidates and guard
      ambiguous.ts          rules for short and ambiguous skill names
      index.ts              buildSkillIndex, findCandidates
    extraction/
      forms.ts              JSON forms for the model + zod validators
      prompts.ts            system prompt and the two questions
      extract.ts            two-pass extraction with validation and one retry
    guard/
      commonWords.ts        common English words that are never treated as names
      numbers.ts            numbers in digit and spelled-out form
      forbidden.ts          forbidden terms built from one scenario
      checks.ts             the six checks; discard, never rewrite
    digest.ts               daily pool: merge, rank, cap, expire, export/import
    pipeline.test.ts        integration, leak fixture, property checks
eval/
  fixtures/*.json           realistic activity with expected outcomes
  README.md
app/src/core/eval.test.ts   runs every fixture against the scripted fake model
```

---

### Task 1: Project scaffold, shared types, constants, errors, counters

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vitest.config.ts`
- Create: `app/src/core/types.ts`, `app/src/core/constants.ts`, `app/src/core/errors.ts`, `app/src/core/counters.ts`
- Test: `app/src/core/imports.test.ts`, `app/src/core/counters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `types.ts` (used by all later tasks, exact names below), every constant in `constants.ts`, `CoreError` / `CoreErrorCode`, `createCounters(): CountersApi`.

- [ ] **Step 1: Create the package files**

`app/package.json`:
```json
{
  "name": "clave-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "22.20.3",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

`app/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "preserve",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

`app/vitest.config.ts`:
```ts
import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {include: ["src/**/*.test.ts"], environment: "node"}
});
```

- [ ] **Step 2: Install**

Run: `pnpm --dir app install`
Expected: finishes without errors and creates `app/node_modules` and `app/pnpm-lock.yaml`.
If pnpm asks to approve build scripts, none are needed for these packages; answer no.

- [ ] **Step 3: Write `types.ts`**

`app/src/core/types.ts`:
```ts
export interface FrontWindow { app: string; bundleId?: string; title: string }

export interface WindowRead extends FrontWindow {
  text: string;
  /** Browsers only: recognised text of the window's top toolbar strip. */
  toolbarText?: string;
  at: number;
}

export type SkipReason =
  | "captureOff" | "locked" | "unknownWindow" | "excludedApp" | "excludedTitle"
  | "privateWindow" | "excludedSite" | "rulesInvalid" | "scrubFailed" | "unchanged" | "empty";

export type CaptureDecision = {allow: true} | {allow: false; reason: SkipReason};
export type IngestOutcome = {kept: true} | {kept: false; reason: SkipReason};

export interface Skill { id: string; displayName: string; canonicalName: string; aliases: string[] }
export interface Competency { id: string; name: string; description: string }

export interface PipelineConfig {
  exclusions: string[];
  excludedSites: string[];
  taxonomyVersion: string;
  skills: Skill[];
  competencies: Competency[];
  userNames: string[];
}
export type ConfigResult = {ok: true} | {ok: false; problems: string[]};

export type JsonSchema = Record<string, unknown>;

export interface ModelSettings {
  systemPrompt: string;
  thoughts: "discourage";
  templateVariation: "3.5";
  temperature: number;
}
export interface ModelConversation {
  ask(userText: string, form: JsonSchema, limits: {maxTokens: number; timeoutMs: number}): Promise<unknown>;
  close(): Promise<void>;
}
export interface ModelPort { open(settings: ModelSettings): Promise<ModelConversation> }

export interface Ports {
  model: ModelPort;
  clock: {now(): number; dayKey(epochMs: number): string};
  newId(): string;
}

export interface PendingStatement {
  id: string;
  kind: "skill" | "competency";
  targetId: string;
  statement: string;
  createdAt: number;
  taxonomyVersion: string;
  pipelineVersion: string;
}

/** A read after scrubbing. The only form in which screen text is ever stored. */
export interface ScrubbedRead { app: string; title: string; text: string; toolbarText?: string; at: number }

export interface ScenarioBlock { app: string; title: string; text: string; at: number }
export interface Scenario { id: string; openedAt: number; closedAt: number; blocks: ScenarioBlock[]; text: string }

/** Something the model may choose. `name` is shown to the model; `id` is what it must return. */
export interface Offered { id: string; kind: "skill" | "competency"; name: string; description?: string }

export interface DraftStatement { targetId: string; kind: "skill" | "competency"; statement: string }

export type Counters = Record<string, number>;

export interface Pipeline {
  mayCapture(front: FrontWindow): CaptureDecision;
  ingest(read: WindowRead): IngestOutcome;
  tick(): void;
  signal(s: "locked" | "unlocked" | "captureOn" | "captureOff"): void;
  digest(): PendingStatement[];
  resolve(id: string, decision: "approved" | "rejected"): void;
  counters(): Counters;
  /** Returns the counters and resets them. The app calls this when it sends its daily summary, so no numbers are lost at midnight. */
  takeCounters(): Counters;
  configure(config: PipelineConfig): ConfigResult;
  exportPool(): PendingStatement[];
  importPool(items: unknown): {accepted: number; rejected: number};
  whenIdle(): Promise<void>;
}
```

- [ ] **Step 4: Write `constants.ts` and `errors.ts`**

`app/src/core/constants.ts`:
```ts
export const PIPELINE_VERSION = "1";

export const BUFFER_MAX_AGE_MS = 60 * 60_000;
export const MIN_READ_CHARS = 40;

export const SCENARIO_IDLE_MS = 5 * 60_000;
export const SCENARIO_AWAY_MS = 2 * 60_000;
export const SCENARIO_MAX_MS = 10 * 60_000;
export const SCENARIO_MIN_CHARS = 400;
export const SCENARIO_MAX_CHARS = 24_000;
export const SNAPSHOTS_PER_WINDOW = 3;
export const SNAPSHOT_MAX_LINE_OVERLAP = 0.6;
export const EXTRACTION_QUEUE_MAX = 3;

export const MAX_CANDIDATE_SKILLS = 20;
export const MAX_PHRASE_TOKENS = 5;

export const GATE_LIMITS = {maxTokens: 300, timeoutMs: 30_000} as const;
export const STATEMENT_LIMITS = {maxTokens: 700, timeoutMs: 60_000} as const;
export const SUMMARY_MAX_CHARS = 500;
export const STATEMENT_MAX_CHARS = 260;
export const STATEMENTS_MIN = 1;
export const STATEMENTS_MAX = 5;
export const TEMPERATURE = 0.2;
export const RETRY_TEMPERATURE = 0;

export const GUARD_MIN_WORDS = 8;
export const GUARD_MAX_WORDS = 40;

export const DIGEST_PER_TARGET = 2;
export const DIGEST_PER_DAY = 10;
export const DIGEST_ITEM_TTL_DAYS = 3;
export const DIGEST_MERGE_OVERLAP = 0.6;

export const RULE_MAX_LENGTH = 200;
```

`app/src/core/errors.ts`:
```ts
/** Fixed codes only. A CoreError never carries captured text. */
export type CoreErrorCode =
  | "CONFIG_INVALID" | "SCRUB_FAILED" | "MODEL_FAILED" | "MODEL_TIMEOUT"
  | "MODEL_ANSWER_INVALID" | "POOL_IMPORT_INVALID";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "CoreError";
    this.code = code;
  }
}
```

- [ ] **Step 5: Write the failing tests**

`app/src/core/counters.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {createCounters} from "./counters";

describe("counters", () => {
  it("starts empty and counts by name", () => {
    const c = createCounters();
    c.inc("reads.kept");
    c.inc("reads.kept");
    c.inc("reads.skipped.unchanged", 3);
    expect(c.snapshot()).toEqual({"reads.kept": 2, "reads.skipped.unchanged": 3});
  });

  it("returns a copy, not the live object", () => {
    const c = createCounters();
    c.inc("x");
    const snap = c.snapshot();
    snap.x = 99;
    expect(c.snapshot().x).toBe(1);
  });

  it("resets", () => {
    const c = createCounters();
    c.inc("x");
    c.reset();
    expect(c.snapshot()).toEqual({});
  });
});
```

`app/src/core/imports.test.ts`:
```ts
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = new URL(".", import.meta.url).pathname;
const FORBIDDEN = [
  "fs", "node:fs", "fs/promises", "node:fs/promises", "net", "node:net", "http", "node:http",
  "https", "node:https", "child_process", "node:child_process", "electron", "dgram", "node:dgram"
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("core stays pure", () => {
  it("never imports disk, network, process or Electron modules", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g)) {
        const mod = match[1] ?? match[2] ?? "";
        if (FORBIDDEN.includes(mod)) offenders.push(`${file.replace(ROOT, "")} imports ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never calls console", () => {
    const offenders = sourceFiles(ROOT).filter((file) => /\bconsole\.(log|info|warn|error|debug)\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `pnpm --dir app test`
Expected: `counters.test.ts` FAILS with "Cannot find module './counters'" (or equivalent). `imports.test.ts` passes.

- [ ] **Step 7: Write `counters.ts`**

`app/src/core/counters.ts`:
```ts
import type {Counters} from "./types";

export interface CountersApi {
  inc(name: string, by?: number): void;
  snapshot(): Counters;
  reset(): void;
}

export function createCounters(): CountersApi {
  let values: Counters = {};
  return {
    inc(name, by = 1) { values[name] = (values[name] ?? 0) + by; },
    snapshot() { return {...values}; },
    reset() { values = {}; }
  };
}
```

- [ ] **Step 8: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests PASS.
Run: `pnpm --dir app typecheck` — Expected: no errors.

If TypeScript 7 rejects a `tsconfig.json` option, remove that one option and re-run; record the change in a comment at the top of `app/tsconfig.json`'s sibling `app/README.md` (create it with one line describing the change).

---

### Task 2: Exclusion rules and private-window phrases

**Files:**
- Create: `app/src/core/exclusions/rules.ts`, `app/src/core/exclusions/privateWindows.ts`
- Test: `app/src/core/exclusions/rules.test.ts`, `app/src/core/exclusions/privateWindows.test.ts`

**Interfaces:**
- Consumes: `FrontWindow` from `../types`; `RULE_MAX_LENGTH` from `../constants`.
- Produces:
  - `parseRules(raw: unknown): {rules: Rule[]; problems: string[]}`
  - `matchRule(rules: Rule[], front: FrontWindow): "app" | "title" | null` — `"app"` when the match involved the app name; `"title"` when it matched on the title alone.
  - Rule forms: `App` matches app OR title; `App::` matches the app only; `App::Title` requires both; `::Title` matches the title in any app.
  - `isPrivateTitle(title: string): boolean`
  - `hasPrivateToolbarMarker(toolbarText: string): boolean`

- [ ] **Step 1: Write the failing tests**

`app/src/core/exclusions/rules.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {matchRule, parseRules} from "./rules";

const front = (app: string, title: string) => ({app, title});

describe("parseRules", () => {
  it("parses plain, scoped and title-only rules", () => {
    const {rules, problems} = parseRules(["Telegram", "Slack::#hr", "::Confidential"]);
    expect(problems).toEqual([]);
    expect(rules).toEqual([
      {app: "telegram", title: "telegram", either: true},
      {app: "slack", title: "#hr", either: false},
      {app: null, title: "confidential", either: false}
    ]);
  });

  it("splits only once, trims, and drops empty rules silently", () => {
    const {rules, problems} = parseRules(["  Notes :: a::b ", "::", "", "   "]);
    expect(problems).toEqual([]);
    expect(rules).toEqual([{app: "notes", title: "a::b", either: false}]);
  });

  it("treats 'App::' as app-only, so a title that merely contains the word is not excluded", () => {
    const {rules} = parseRules(["Messages::"]);
    expect(rules).toEqual([{app: "messages", title: null, either: false}]);
    expect(matchRule(rules, front("Messages", "Mom"))).toBe("app");
    expect(matchRule(rules, front("Slack", "Direct messages - Acme"))).toBeNull();
  });

  it("reports problems instead of guessing", () => {
    expect(parseRules("Slack").problems.length).toBe(1);
    expect(parseRules([42]).problems.length).toBe(1);
    expect(parseRules(["a" + String.fromCharCode(10) + "b"]).problems.length).toBe(1);
    expect(parseRules(["x".repeat(201)]).problems.length).toBe(1);
  });
});

describe("matchRule", () => {
  const {rules} = parseRules(["Telegram", "Slack::#hr", "::Confidential"]);

  it("matches a plain rule on app or on title, case-insensitively", () => {
    expect(matchRule(rules, front("TELEGRAM", "Chats"))).toBe("app");
    expect(matchRule(rules, front("Chrome", "Telegram Web"))).toBe("title");
  });

  it("requires both halves of a scoped rule", () => {
    expect(matchRule(rules, front("Slack", "#hr - Acme"))).toBe("app");
    expect(matchRule(rules, front("Slack", "#general - Acme"))).toBeNull();
    expect(matchRule(rules, front("Discord", "#hr"))).toBeNull();
  });

  it("matches a title-only rule in any app", () => {
    expect(matchRule(rules, front("Preview", "Confidential offer.pdf"))).toBe("title");
  });

  it("returns null when nothing matches", () => {
    expect(matchRule(rules, front("Code", "index.ts"))).toBeNull();
  });
});
```

`app/src/core/exclusions/privateWindows.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {hasPrivateToolbarMarker, isPrivateTitle} from "./privateWindows";

describe("isPrivateTitle", () => {
  it.each([
    "New Tab - Google Chrome (Incognito)",
    "Example — Mozilla Firefox Private Browsing",
    "Start page - InPrivate - Microsoft Edge",
    "Nova aba — Navegação privativa",
    "Nueva pestaña - Navegación privada",
    "Neuer Tab – Privates Fenster"
  ])("flags %s", (title) => expect(isPrivateTitle(title)).toBe(true));

  // Regression list: every entry was once, or could plausibly be, a false positive.
  it.each([
    "Private API docs - Chrome",
    "My Private Repository · GitHub",
    "Secret Santa Planning - Google Sheets",
    "private.ts — checkout-api",
    "Incognito Marketing Agency - Home"
  ])("does not flag %s", (title) => expect(isPrivateTitle(title)).toBe(false));
});

describe("hasPrivateToolbarMarker", () => {
  it("flags the Chromium incognito label in the toolbar strip", () => {
    expect(hasPrivateToolbarMarker("example.com/pricing   Incognito")).toBe(true);
    expect(hasPrivateToolbarMarker("bing.com   InPrivate")).toBe(true);
  });

  it("does not flag an ordinary toolbar", () => {
    expect(hasPrivateToolbarMarker("github.com/acme/checkout-api/pulls")).toBe(false);
    expect(hasPrivateToolbarMarker("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app test src/core/exclusions`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/exclusions/rules.ts`:
```ts
import {RULE_MAX_LENGTH} from "../constants";
import type {FrontWindow} from "../types";

/** `either` = plain rule: matches when the app OR the title contains the text. */
export interface Rule { app: string | null; title: string | null; either: boolean }

/** Any ASCII control character, including tab and newline. */
const CONTROL = /[\x00-\x1f]/;

export function parseRules(raw: unknown): {rules: Rule[]; problems: string[]} {
  if (!Array.isArray(raw)) return {rules: [], problems: ["exclusions must be a list"]};
  const rules: Rule[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") { problems.push(`rule ${index + 1} is not text`); return; }
    if (entry.length > RULE_MAX_LENGTH) { problems.push(`rule ${index + 1} is too long`); return; }
    if (CONTROL.test(entry)) { problems.push(`rule ${index + 1} contains a control character`); return; }
    const text = entry.trim().toLowerCase();
    if (!text) return;
    const cut = text.indexOf("::");
    if (cut === -1) { rules.push({app: text, title: text, either: true}); return; }
    const app = text.slice(0, cut).trim();
    const title = text.slice(cut + 2).trim();
    if (!app && !title) return;
    rules.push({app: app || null, title: title || null, either: false});
  });
  return {rules, problems};
}

export function matchRule(rules: Rule[], front: FrontWindow): "app" | "title" | null {
  const app = front.app.toLowerCase();
  const title = front.title.toLowerCase();
  for (const rule of rules) {
    if (rule.either) {
      if (rule.app !== null && app.includes(rule.app)) return "app";
      if (rule.title !== null && title.includes(rule.title)) return "title";
      continue;
    }
    const appOk = rule.app === null || app.includes(rule.app);
    const titleOk = rule.title === null || title.includes(rule.title);
    if (appOk && titleOk) return rule.app === null ? "title" : "app";
  }
  return null;
}
```

`app/src/core/exclusions/privateWindows.ts`:
```ts
/**
 * Specific phrases only. The bare words "private" and "incognito" are deliberately absent:
 * they flag ordinary pages ("Private API docs", "Incognito Marketing Agency").
 * Biased toward skipping: a false positive skips one read; a false negative reads private browsing.
 */
const TITLE_PHRASES = [
  "(incognito)", "- incognito", "— incognito",
  "private browsing", "(private)", "— private", "- private window", "inprivate",
  "navegação privativa", "navegação privada", "navegação anônima", "janela anônima", "(anônima)",
  "navegación privada", "(incógnito)", "modo incógnito",
  "privates fenster", "privater modus", "(inkognito)",
  "navigation privée"
];

/** Words that appear as a standalone label in a private window's toolbar strip. */
const TOOLBAR_MARKERS = /(^|[^a-zà-ÿ])(incognito|inprivate|inkognito|incógnito|anônima|private browsing)([^a-zà-ÿ]|$)/i;

export function isPrivateTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return TITLE_PHRASES.some((phrase) => lower.includes(phrase));
}

export function hasPrivateToolbarMarker(toolbarText: string): boolean {
  return TOOLBAR_MARKERS.test(toolbarText);
}
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` — Expected: PASS.
Run: `pnpm --dir app typecheck` — Expected: no errors.

Note for the implementer: "Incognito Marketing Agency - Home" must stay unflagged by `isPrivateTitle` (the title list has no bare "incognito"). `hasPrivateToolbarMarker` is intentionally broader because the toolbar strip is short and a miss there reads private browsing.

---

### Task 3: Site matching, defaults, and the exclusions facade

**Files:**
- Create: `app/src/core/exclusions/sites.ts`, `app/src/core/exclusions/defaults.ts`, `app/src/core/exclusions/index.ts`
- Test: `app/src/core/exclusions/sites.test.ts`, `app/src/core/exclusions/index.test.ts`

**Interfaces:**
- Consumes: `parseRules`, `matchRule` from `./rules`; `isPrivateTitle`, `hasPrivateToolbarMarker` from `./privateWindows`; `FrontWindow`, `SkipReason` from `../types`.
- Produces:
  - `parseSites(raw: unknown): {sites: string[]; problems: string[]}`
  - `extractHosts(toolbarText: string): string[]`
  - `hostMatches(host: string, pattern: string): boolean`
  - `siteExcluded(sites: string[], title: string, toolbarText: string | undefined): boolean`
  - `BUILT_IN_EXCLUSIONS`, `DEFAULT_EXCLUSIONS`, `DEFAULT_EXCLUDED_SITES`, `BROWSERS` (all `string[]`)
  - `createExclusions(input: {exclusions: unknown; excludedSites: unknown}): Exclusions` where
    ```ts
    interface Exclusions {
      valid: boolean;
      problems: string[];
      before(front: FrontWindow): SkipReason | null;
      after(front: FrontWindow, toolbarText: string | undefined): SkipReason | null;
    }
    ```

- [ ] **Step 1: Write the failing tests**

`app/src/core/exclusions/sites.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {extractHosts, hostMatches, parseSites, siteExcluded} from "./sites";

describe("parseSites", () => {
  it("lowercases and accepts hostnames and bare labels", () => {
    expect(parseSites(["PayPal.com", " chase "])).toEqual({sites: ["paypal.com", "chase"], problems: []});
  });
  it("rejects anything that is not a hostname or label", () => {
    expect(parseSites(["https://paypal.com"]).problems.length).toBe(1);
    expect(parseSites(["pay pal"]).problems.length).toBe(1);
    expect(parseSites("paypal.com").problems.length).toBe(1);
  });
});

describe("extractHosts", () => {
  it("pulls hostnames out of recognised toolbar text", () => {
    expect(extractHosts("https://online.chase.com/accounts/summary")).toEqual(["online.chase.com"]);
    expect(extractHosts("github.com/acme/api   localhost:3000")).toEqual(["github.com"]);
  });
  it("returns nothing for text without a hostname", () => {
    expect(extractHosts("Search or enter address")).toEqual([]);
  });
});

describe("hostMatches", () => {
  it("matches a domain exactly or on a dot boundary", () => {
    expect(hostMatches("paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("www.paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("notpaypal.com", "paypal.com")).toBe(false);
  });
  it("matches a bare label against any domain label", () => {
    expect(hostMatches("online.chase.com", "chase")).toBe(true);
    expect(hostMatches("chase.co.uk", "chase")).toBe(true);
    expect(hostMatches("purchase.com", "chase")).toBe(false);
  });
});

describe("siteExcluded", () => {
  const sites = ["paypal.com", "chase"];
  it("drops on the toolbar host", () => {
    expect(siteExcluded(sites, "Summary", "https://www.paypal.com/myaccount")).toBe(true);
  });
  it("drops on the title when the toolbar gave nothing", () => {
    expect(siteExcluded(sites, "Chase Online - Accounts", undefined)).toBe(true);
    expect(siteExcluded(sites, "PayPal.com: Wallet", "")).toBe(true);
  });
  it("does not drop on a substring of another word", () => {
    expect(siteExcluded(sites, "Purchase order 12 - Docs", "docs.google.com/document/d/1")).toBe(false);
  });
});
```

`app/src/core/exclusions/index.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./defaults";
import {createExclusions} from "./index";

const defaults = () => createExclusions({exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES});

describe("before capture", () => {
  it("denies unknown windows", () => {
    const x = defaults();
    expect(x.before({app: "", title: "x"})).toBe("unknownWindow");
    expect(x.before({app: "Code", title: "  "})).toBe("unknownWindow");
  });

  it("denies built-in system surfaces and our own app, which the user cannot re-enable", () => {
    const x = createExclusions({exclusions: [], excludedSites: []});
    expect(x.before({app: "loginwindow", title: "Login"})).toBe("excludedApp");
    expect(x.before({app: "Clave Agent", title: "Review"})).toBe("excludedApp");
  });

  it("excludes personal messengers and password managers by default", () => {
    const x = defaults();
    for (const app of ["Telegram", "WhatsApp", "Messages", "Signal", "1Password", "Bitwarden", "Keychain Access"]) {
      expect(x.before({app, title: "Main"})).toBe("excludedApp");
    }
  });

  it("reads work chat by default", () => {
    const x = defaults();
    for (const app of ["Slack", "Microsoft Teams", "Discord"]) expect(x.before({app, title: "#general"})).toBeNull();
  });

  it("does not exclude a window just because its title contains an excluded app's name", () => {
    const x = defaults();
    expect(x.before({app: "Slack", title: "Direct messages - Acme"})).toBeNull();
    expect(x.before({app: "Docker Desktop", title: "Containers"})).toBeNull();
    expect(x.before({app: "Code", title: "docker-compose.yml — checkout-api"})).toBeNull();
    expect(x.before({app: "Google Chrome", title: "Telegram Bot API docs"})).toBeNull();
  });

  it("reports title matches and private windows separately", () => {
    const x = defaults();
    expect(x.before({app: "Safari", title: "Online Banking - Accounts"})).toBe("excludedTitle");
    expect(x.before({app: "Firefox", title: "Example — Private Browsing"})).toBe("privateWindow");
  });
});

describe("after recognition", () => {
  it("only inspects browsers", () => {
    const x = defaults();
    expect(x.after({app: "Code", title: "paypal.com notes.md"}, "paypal.com")).toBeNull();
  });
  it("drops excluded sites and Chromium private windows", () => {
    const x = defaults();
    expect(x.after({app: "Google Chrome", title: "Log in"}, "https://www.paypal.com/signin")).toBe("excludedSite");
    expect(x.after({app: "Google Chrome", title: "Example Domain"}, "example.com   Incognito")).toBe("privateWindow");
    expect(x.after({app: "Google Chrome", title: "Pull requests"}, "github.com/acme/api/pulls")).toBeNull();
  });
});

describe("invalid configuration", () => {
  it("denies everything until fixed", () => {
    const x = createExclusions({exclusions: [42], excludedSites: []});
    expect(x.valid).toBe(false);
    expect(x.problems.length).toBeGreaterThan(0);
    expect(x.before({app: "Code", title: "index.ts"})).toBe("rulesInvalid");
    expect(x.after({app: "Google Chrome", title: "x"}, "github.com")).toBe("rulesInvalid");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app test src/core/exclusions`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/exclusions/sites.ts`:
```ts
const SITE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const HOST = /(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[:/\s]|$)/g;

export function parseSites(raw: unknown): {sites: string[]; problems: string[]} {
  if (!Array.isArray(raw)) return {sites: [], problems: ["excluded sites must be a list"]};
  const sites: string[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") { problems.push(`site ${index + 1} is not text`); return; }
    const site = entry.trim().toLowerCase();
    if (!site) return;
    if (!SITE.test(site)) { problems.push(`site ${index + 1} is not a hostname`); return; }
    sites.push(site);
  });
  return {sites, problems};
}

export function extractHosts(toolbarText: string): string[] {
  const hosts = new Set<string>();
  for (const match of toolbarText.toLowerCase().matchAll(HOST)) if (match[1]) hosts.add(match[1]);
  return [...hosts];
}

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.includes(".")) return host === pattern || host.endsWith("." + pattern);
  return host.split(".").includes(pattern);
}

function titleMentions(title: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(title);
}

/** Either signal is enough. Without an exact address we stay cautious. */
export function siteExcluded(sites: string[], title: string, toolbarText: string | undefined): boolean {
  const hosts = extractHosts(toolbarText ?? "");
  return sites.some((site) => hosts.some((host) => hostMatches(host, site)) || titleMentions(title, site));
}
```

`app/src/core/exclusions/defaults.ts`:
```ts
/** Always applied, matched on the EXACT app name. Not shown to the user and not removable. */
export const BUILT_IN_EXCLUSIONS = [
  "loginwindow", "ScreenSaverEngine", "LockApp", "LogonUI",
  "Dock", "SystemUIServer", "Control Center", "Notification Center", "Spotlight", "WindowManager",
  "Clave Agent"
];

/** Seeded on first run. The user can edit this list. Slack, Teams and Discord are work tools and are read. */
export const DEFAULT_EXCLUSIONS = [
  "1Password::", "Bitwarden::", "LastPass::", "Dashlane::", "KeePassXC::", "Keychain Access::", "Passwords::",
  "Telegram::", "WhatsApp::", "Messages::", "Signal::",
  "::online banking", "::internet banking", "::bank account", "::net banking"
];

export const DEFAULT_EXCLUDED_SITES = [
  "paypal.com", "wise.com", "revolut.com", "chase", "wellsfargo", "bankofamerica", "citi.com",
  "nubank.com.br", "itau.com.br", "bradesco", "santander", "accounts.google.com", "appleid.apple.com"
];

export const BROWSERS = [
  "google chrome", "chrome", "chromium", "safari", "firefox", "microsoft edge", "brave browser",
  "arc", "opera", "vivaldi", "zen"
];
```

`app/src/core/exclusions/index.ts`:
```ts
import type {FrontWindow, SkipReason} from "../types";
import {BROWSERS, BUILT_IN_EXCLUSIONS} from "./defaults";
import {hasPrivateToolbarMarker, isPrivateTitle} from "./privateWindows";
import {matchRule, parseRules} from "./rules";
import {parseSites, siteExcluded} from "./sites";

export interface Exclusions {
  valid: boolean;
  problems: string[];
  before(front: FrontWindow): SkipReason | null;
  after(front: FrontWindow, toolbarText: string | undefined): SkipReason | null;
}

const isBrowser = (app: string) => BROWSERS.includes(app.trim().toLowerCase());

export function createExclusions(input: {exclusions: unknown; excludedSites: unknown}): Exclusions {
  // Exact app-name match: a substring rule for "Dock" would wrongly exclude "Docker Desktop".
  const builtIn = new Set(BUILT_IN_EXCLUSIONS.map((name) => name.toLowerCase()));
  const user = parseRules(input.exclusions);
  const sites = parseSites(input.excludedSites);
  const problems = [...user.problems, ...sites.problems];
  const valid = problems.length === 0;

  return {
    valid,
    problems,
    before(front) {
      if (!valid) return "rulesInvalid";
      if (!front.app.trim() || !front.title.trim()) return "unknownWindow";
      if (builtIn.has(front.app.trim().toLowerCase())) return "excludedApp";
      const hit = matchRule(user.rules, front);
      if (hit === "app") return "excludedApp";
      if (hit === "title") return "excludedTitle";
      if (isPrivateTitle(front.title)) return "privateWindow";
      return null;
    },
    after(front, toolbarText) {
      if (!valid) return "rulesInvalid";
      if (!isBrowser(front.app)) return null;
      if (toolbarText && hasPrivateToolbarMarker(toolbarText)) return "privateWindow";
      if (siteExcluded(sites.sites, front.title, toolbarText)) return "excludedSite";
      return null;
    }
  };
}
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` — Expected: PASS.
Run: `pnpm --dir app typecheck` — Expected: no errors.

---

### Task 4: Secret scrubbing

**Files:**
- Create: `app/src/core/scrub/luhn.ts`, `app/src/core/scrub/patterns.ts`, `app/src/core/scrub/scrub.ts`
- Test: `app/src/core/scrub/scrub.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `luhnValid(digits: string): boolean`
  - `PATTERNS: ScrubPattern[]` where `interface ScrubPattern { label: ScrubLabel; secret: boolean; re: RegExp; accept?(match: string, text: string, index: number): boolean }`
  - `type ScrubLabel = "[SECRET]" | "[EMAIL]" | "[CARD]" | "[PHONE]"`
  - `scrub(text: string): {text: string; counts: Record<ScrubLabel, number>}` — throws nothing on ordinary input; the caller treats any throw as "drop the read".

- [ ] **Step 1: Write the failing test**

`app/src/core/scrub/scrub.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {luhnValid} from "./luhn";
import {scrub} from "./scrub";

describe("luhnValid", () => {
  it("accepts a valid test card and rejects a near miss", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
  });
});

describe("scrub: must match", () => {
  const cases: [string, string][] = [
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
    ["database connection string", "DATABASE_URL=postgres://app:s3cr3tpass@db.internal:5432/orders"],
    ["generic user:pass url", "https://deploy:hunter2hunter2@git.example.com/repo.git"],
    ["authorization header", "Authorization: Bearer abcdEFGH1234ijklMNOP5678"],
    ["openai-style key", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12345678"],
    ["stripe key", "sk_live_51AbCdEfGhIjKlMnOpQrStUv"],
    ["github token", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["slack token", "xoxb-123456789012-abcdefghijkl"],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["assignment", "password = correct-horse-battery"]
  ];
  it.each(cases)("%s becomes [SECRET]", (_name, input) => {
    const out = scrub(`before ${input} after`);
    expect(out.text).toContain("[SECRET]");
    expect(out.counts["[SECRET]"]).toBeGreaterThan(0);
  });

  it("labels emails, valid cards and clearly formatted phones", () => {
    expect(scrub("mail priya.raman@acme.io now").text).toBe("mail [EMAIL] now");
    expect(scrub("card 4242 4242 4242 4242 ok").text).toBe("card [CARD] ok");
    expect(scrub("call +1 (415) 555-0132 today").text).toBe("call [PHONE] today");
    expect(scrub("phone: 415-555-0132").text).toBe("phone: [PHONE]");
  });

  it("lets the secret win when a key looks like an email", () => {
    const out = scrub("dsn https://4f2a9c1b7d3e4f60a1b2c3d4e5f60718:secretpart99@o123.ingest.example.io/42");
    expect(out.text).toContain("[SECRET]");
    expect(out.text).not.toContain("secretpart99");
    expect(out.text).not.toContain("[EMAIL]");
  });
});

describe("scrub: must NOT match", () => {
  it.each([
    "order 48210412 shipped",
    "left: 47692, top: 1180, width: 1440",
    "2026-09-17T09:36:45.277Z",
    "version 2026.09.2 released",
    "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    "p95 rose from 310 ms to 2400 ms over 50,000 requests",
    "ticket PROJ-4821 and migration 0412",
    "192.168.10.24 responded in 12 ms",
    "4111 1111 1111 1112 is not a valid card number",
    "reference 4821-0412-7788 for the shipment"
  ])("leaves %s untouched", (input) => {
    expect(scrub(input).text).toBe(input);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/scrub`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/scrub/luhn.ts`:
```ts
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
```

`app/src/core/scrub/patterns.ts`:
```ts
import {luhnValid} from "./luhn";

export type ScrubLabel = "[SECRET]" | "[EMAIL]" | "[CARD]" | "[PHONE]";

export interface ScrubPattern {
  label: ScrubLabel;
  /** Secrets win every overlap, so a credential is never lost to a weaker class. */
  secret: boolean;
  re: RegExp;
  accept?(match: string, text: string, index: number): boolean;
}

const secret = (re: RegExp): ScrubPattern => ({label: "[SECRET]", secret: true, re});

const PHONE_WORDS = /(tel|phone|mobile|cell|whatsapp|fone|telefone|celular)\W{0,4}$/i;

export const PATTERNS: ScrubPattern[] = [
  secret(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g),
  secret(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@[^\s]+/gi),
  secret(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi),
  secret(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g),
  secret(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  secret(/\bgh[pousr]_[A-Za-z0-9]{30,}/g),
  secret(/\bgithub_pat_[A-Za-z0-9_]{30,}/g),
  secret(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g),
  secret(/\bAKIA[0-9A-Z]{16}\b/g),
  secret(/\bAIza[0-9A-Za-z_-]{30,}/g),
  secret(/\bhf_[A-Za-z0-9]{30,}/g),
  secret(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  secret(/\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?[^\s"']{8,}/gi),
  {label: "[EMAIL]", secret: false, re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g},
  {
    label: "[CARD]", secret: false, re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (match) => luhnValid(match.replace(/[ -]/g, ""))
  },
  {
    // A phone needs proof that it is a phone: a country code, parentheses, or a label just before it.
    // Separators alone are not enough: "4821-0412-7788" is a reference number.
    label: "[PHONE]", secret: false, re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{3,4})?\b/g,
    accept: (match, text, index) => {
      const digits = match.replace(/\D/g, "").length;
      if (digits < 9 || digits > 15) return false;
      if (match.startsWith("+") || match.includes("(")) return true;
      return PHONE_WORDS.test(text.slice(Math.max(0, index - 24), index));
    }
  }
];
```

`app/src/core/scrub/scrub.ts`:
```ts
import {PATTERNS, type ScrubLabel} from "./patterns";

interface Hit { start: number; end: number; label: ScrubLabel; secret: boolean }

export function scrub(text: string): {text: string; counts: Record<ScrubLabel, number>} {
  const hits: Hit[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const start = match.index ?? 0;
      if (pattern.accept && !pattern.accept(match[0], text, start)) continue;
      hits.push({start, end: start + match[0].length, label: pattern.label, secret: pattern.secret});
    }
  }
  // Secrets first, then longer matches, then earlier ones. A hit that overlaps an accepted hit is dropped.
  hits.sort((a, b) => Number(b.secret) - Number(a.secret) || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const accepted: Hit[] = [];
  for (const hit of hits) if (!accepted.some((a) => hit.start < a.end && a.start < hit.end)) accepted.push(hit);
  accepted.sort((a, b) => b.start - a.start);

  const counts: Record<ScrubLabel, number> = {"[SECRET]": 0, "[EMAIL]": 0, "[CARD]": 0, "[PHONE]": 0};
  let out = text;
  for (const hit of accepted) {
    out = out.slice(0, hit.start) + hit.label + out.slice(hit.end);
    counts[hit.label] += 1;
  }
  return {text: out, counts};
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app test src/core/scrub`
Expected: PASS. If a must-not-match case fails, tighten that pattern's `accept`; never delete the failing case.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 5: Rolling buffer

**Files:**
- Create: `app/src/core/buffer.ts`
- Test: `app/src/core/buffer.test.ts`

**Interfaces:**
- Consumes: `ScrubbedRead` from `./types`; `BUFFER_MAX_AGE_MS`, `MIN_READ_CHARS` from `./constants`.
- Produces: `createBuffer(): ReadBuffer` where
  ```ts
  interface ReadBuffer {
    accept(read: ScrubbedRead): "kept" | "unchanged" | "empty";
    /** Removes reads older than BUFFER_MAX_AGE_MS. Returns how many were removed. */
    expire(now: number): number;
    /** Reads with from <= at <= to, oldest first. */
    range(from: number, to: number): ScrubbedRead[];
    dropRange(from: number, to: number): void;
    clear(): void;
    size(): number;
    oldestAt(): number | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

`app/src/core/buffer.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {createBuffer} from "./buffer";
import {BUFFER_MAX_AGE_MS} from "./constants";

const long = (seed: string) => `${seed} `.repeat(20);
const read = (app: string, title: string, text: string, at: number) => ({app, title, text, at});

describe("buffer", () => {
  it("keeps a read and rejects text that is too short", () => {
    const b = createBuffer();
    expect(b.accept(read("Code", "a.ts", long("alpha"), 1))).toBe("kept");
    expect(b.accept(read("Code", "a.ts", "tiny", 2))).toBe("empty");
    expect(b.size()).toBe(1);
  });

  it("skips an identical consecutive read of the same window", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1));
    expect(b.accept(read("Code", "a.ts", long("alpha"), 2))).toBe("unchanged");
    expect(b.accept(read("Code", "a.ts", long("beta"), 3))).toBe("kept");
  });

  it("forgets the fingerprint when focus moves to another window", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1));
    b.accept(read("Slack", "#general", long("hello"), 2));
    expect(b.accept(read("Code", "a.ts", long("alpha"), 3))).toBe("kept");
  });

  it("expires reads older than sixty minutes", () => {
    const b = createBuffer();
    b.accept(read("Code", "a.ts", long("alpha"), 1_000));
    b.accept(read("Code", "b.ts", long("beta"), 2_000_000));
    expect(b.expire(1_000 + BUFFER_MAX_AGE_MS + 1)).toBe(1);
    expect(b.oldestAt()).toBe(2_000_000);
  });

  it("returns and drops a time range", () => {
    const b = createBuffer();
    b.accept(read("A", "1", long("one"), 10));
    b.accept(read("B", "2", long("two"), 20));
    b.accept(read("C", "3", long("three"), 30));
    expect(b.range(10, 20).map((r) => r.app)).toEqual(["A", "B"]);
    b.dropRange(10, 20);
    expect(b.size()).toBe(1);
    b.clear();
    expect(b.size()).toBe(0);
    expect(b.oldestAt()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/buffer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`app/src/core/buffer.ts`:
```ts
import {BUFFER_MAX_AGE_MS, MIN_READ_CHARS} from "./constants";
import type {ScrubbedRead} from "./types";

export interface ReadBuffer {
  accept(read: ScrubbedRead): "kept" | "unchanged" | "empty";
  expire(now: number): number;
  range(from: number, to: number): ScrubbedRead[];
  dropRange(from: number, to: number): void;
  clear(): void;
  size(): number;
  oldestAt(): number | null;
}

const keyOf = (read: ScrubbedRead) => JSON.stringify([read.app, read.title]);

/** The single owner of raw screen text. In memory only. */
export function createBuffer(): ReadBuffer {
  let reads: ScrubbedRead[] = [];
  let lastKey: string | null = null;
  let lastText: string | null = null;

  return {
    accept(read) {
      if (read.text.trim().length < MIN_READ_CHARS) return "empty";
      const key = keyOf(read);
      // The fingerprint belongs to the window in focus. Moving away forgets it, so the first read
      // of a window we come back to is never suppressed by a stale fingerprint.
      if (key === lastKey && read.text === lastText) return "unchanged";
      lastKey = key;
      lastText = read.text;
      reads.push(read);
      return "kept";
    },
    expire(now) {
      const before = reads.length;
      reads = reads.filter((r) => now - r.at <= BUFFER_MAX_AGE_MS);
      return before - reads.length;
    },
    range: (from, to) => reads.filter((r) => r.at >= from && r.at <= to),
    dropRange(from, to) { reads = reads.filter((r) => r.at < from || r.at > to); },
    clear() { reads = []; lastKey = null; lastText = null; },
    size: () => reads.length,
    oldestAt: () => (reads.length ? Math.min(...reads.map((r) => r.at)) : null)
  };
}
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 6: Scenarios: when a stretch of work ends, and what it looks like

**Files:**
- Create: `app/src/core/scenarios/segmenter.ts`, `app/src/core/scenarios/compact.ts`
- Test: `app/src/core/scenarios/segmenter.test.ts`, `app/src/core/scenarios/compact.test.ts`

**Interfaces:**
- Consumes: `ScrubbedRead`, `Scenario`, `ScenarioBlock` from `../types`; the `SCENARIO_*` and `SNAPSHOT*` constants.
- Produces:
  - `createSegmenter(): Segmenter` where
    ```ts
    type CloseReason = "idle" | "away" | "cap" | "off" | "locked";
    interface ClosedSpan { openedAt: number; closedAt: number; reason: CloseReason }
    interface Segmenter {
      /** Any mayCapture/ingest call that was not denied for lock or capture-off. */
      activity(now: number): void;
      /** A mayCapture call was allowed (true) or denied for an exclusion reason (false). */
      captureAllowed(now: number, allowed: boolean): void;
      /** A read was kept. Opens a scenario if none is open. */
      kept(now: number): void;
      locked(now: number): void;
      unlocked(now: number): void;
      /** Capture switched off: closes the open scenario immediately. */
      off(now: number): ClosedSpan | null;
      /** Call regularly. Returns a span when the open scenario has just closed. */
      tick(now: number): ClosedSpan | null;
      isOpen(): boolean;
    }
    ```
  - `compact(reads: ScrubbedRead[], meta: {id: string; openedAt: number; closedAt: number}): Scenario | null`
  - `lineOverlap(a: string, b: string): number`

- [ ] **Step 1: Write the failing tests**

`app/src/core/scenarios/segmenter.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {SCENARIO_AWAY_MS, SCENARIO_IDLE_MS, SCENARIO_MAX_MS} from "../constants";
import {createSegmenter} from "./segmenter";

const MIN = 60_000;

describe("segmenter", () => {
  it("opens on the first kept read and stays open while there is activity", () => {
    const s = createSegmenter();
    expect(s.isOpen()).toBe(false);
    s.activity(0); s.kept(0);
    expect(s.isOpen()).toBe(true);
    s.activity(4 * MIN);               // a read skipped as unchanged still counts as activity
    expect(s.tick(4 * MIN + 1)).toBeNull();
  });

  it("closes after five idle minutes, ending at the last activity", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN);
    expect(s.tick(1 * MIN + SCENARIO_IDLE_MS - 1)).toBeNull();
    expect(s.tick(1 * MIN + SCENARIO_IDLE_MS)).toEqual({openedAt: 0, closedAt: 1 * MIN, reason: "idle"});
    expect(s.isOpen()).toBe(false);
  });

  it("closes after two minutes spent only in excluded windows", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN); s.captureAllowed(1 * MIN, false);
    s.activity(2 * MIN); s.captureAllowed(2 * MIN, false);
    expect(s.tick(1 * MIN + SCENARIO_AWAY_MS)).toEqual({openedAt: 0, closedAt: 1 * MIN, reason: "away"});
  });

  it("an allowed capture ends the away streak", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.activity(1 * MIN); s.captureAllowed(1 * MIN, false);
    s.activity(2 * MIN); s.captureAllowed(2 * MIN, true);
    expect(s.tick(1 * MIN + SCENARIO_AWAY_MS)).toBeNull();
  });

  it("closes at the ten minute cap even under constant activity", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    for (let t = MIN; t < SCENARIO_MAX_MS; t += MIN) { s.activity(t); s.captureAllowed(t, true); }
    expect(s.tick(SCENARIO_MAX_MS)).toEqual({openedAt: 0, closedAt: SCENARIO_MAX_MS, reason: "cap"});
  });

  it("closes immediately when capture is switched off", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    expect(s.off(90_000)).toEqual({openedAt: 0, closedAt: 90_000, reason: "off"});
    expect(s.off(91_000)).toBeNull();
  });

  it("closes when the screen stays locked longer than the idle limit", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.locked(30_000);
    expect(s.tick(30_000 + SCENARIO_IDLE_MS)).toBeNull();
    expect(s.tick(30_000 + SCENARIO_IDLE_MS + 1)).toEqual({openedAt: 0, closedAt: 30_000, reason: "locked"});
  });

  it("a short lock does not close the scenario", () => {
    const s = createSegmenter();
    s.activity(0); s.kept(0);
    s.locked(30_000); s.unlocked(60_000); s.activity(60_000);
    expect(s.tick(61_000)).toBeNull();
    expect(s.isOpen()).toBe(true);
  });
});
```

`app/src/core/scenarios/compact.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {SCENARIO_MAX_CHARS} from "../constants";
import {compact, lineOverlap} from "./compact";

const lines = (prefix: string, n: number) => Array.from({length: n}, (_, i) => `${prefix} line ${i} with some words`).join("\n");
const read = (app: string, title: string, text: string, at: number) => ({app, title, text, at});
const meta = {id: "s1", openedAt: 0, closedAt: 600_000};

describe("lineOverlap", () => {
  it("is 1 for identical text and 0 for disjoint text", () => {
    expect(lineOverlap("a\nb\nc", "a\nb\nc")).toBe(1);
    expect(lineOverlap("a\nb", "c\nd")).toBe(0);
  });
  it("is measured against the smaller side", () => {
    expect(lineOverlap("a\nb", "a\nb\nc\nd")).toBe(1);
  });
});

describe("compact", () => {
  it("drops a scenario with too little text", () => {
    expect(compact([read("Code", "a.ts", "x".repeat(120), 1)], meta)).toBeNull();
  });

  it("labels blocks, orders them by time, and keeps the latest read of each window", () => {
    const scenario = compact([
      read("Slack", "#backend", lines("slack", 20), 10),
      read("Code", "order.ts", lines("code-v1", 20), 20),
      read("Code", "order.ts", lines("code-v2", 20), 30)
    ], meta)!;
    expect(scenario.blocks.map((b) => `${b.app}@${b.at}`)).toEqual(["Slack@10", "Code@20", "Code@30"]);
    expect(scenario.text).toContain("[Slack — #backend]");
    expect(scenario.text).toContain("[Code — order.ts]");
    expect(scenario.id).toBe("s1");
  });

  it("drops earlier snapshots that mostly repeat a kept one", () => {
    const base = lines("same", 20);
    const scenario = compact([
      read("Code", "a.ts", base, 10),
      read("Code", "a.ts", base + "\nplus one new line here", 20)
    ], meta)!;
    expect(scenario.blocks.length).toBe(1);
    expect(scenario.blocks[0]!.at).toBe(20);
  });

  it("keeps at most three earlier snapshots per window", () => {
    const reads = Array.from({length: 8}, (_, i) => read("Code", "a.ts", lines(`v${i}`, 20), i + 1));
    expect(compact(reads, meta)!.blocks.length).toBe(4);
  });

  it("trims the oldest blocks to stay under the size cap", () => {
    const big = (tag: string) => lines(tag, 400);
    const scenario = compact([
      read("A", "1", big("a"), 1), read("B", "2", big("b"), 2), read("C", "3", big("c"), 3)
    ], meta)!;
    expect(scenario.text.length).toBeLessThanOrEqual(SCENARIO_MAX_CHARS);
    expect(scenario.blocks.at(-1)!.app).toBe("C");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app test src/core/scenarios`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/scenarios/segmenter.ts`:
```ts
import {SCENARIO_AWAY_MS, SCENARIO_IDLE_MS, SCENARIO_MAX_MS} from "../constants";

export type CloseReason = "idle" | "away" | "cap" | "off" | "locked";
export interface ClosedSpan { openedAt: number; closedAt: number; reason: CloseReason }

export interface Segmenter {
  activity(now: number): void;
  captureAllowed(now: number, allowed: boolean): void;
  kept(now: number): void;
  locked(now: number): void;
  unlocked(now: number): void;
  off(now: number): ClosedSpan | null;
  tick(now: number): ClosedSpan | null;
  isOpen(): boolean;
}

/** Tracks timestamps only. It never sees text. */
export function createSegmenter(): Segmenter {
  let openedAt: number | null = null;
  let lastActivityAt = 0;
  let awaySince: number | null = null;
  let lockedSince: number | null = null;

  const close = (closedAt: number, reason: CloseReason): ClosedSpan => {
    const span = {openedAt: openedAt as number, closedAt, reason};
    openedAt = null;
    awaySince = null;
    return span;
  };

  return {
    activity(now) { lastActivityAt = now; },
    captureAllowed(now, allowed) {
      if (allowed) awaySince = null;
      else if (awaySince === null) awaySince = now;
    },
    kept(now) { if (openedAt === null) { openedAt = now; lastActivityAt = now; awaySince = null; } },
    locked(now) { if (lockedSince === null) lockedSince = now; },
    unlocked() { lockedSince = null; },
    off(now) { return openedAt === null ? null : close(now, "off"); },
    tick(now) {
      if (openedAt === null) return null;
      if (lockedSince !== null && now - lockedSince > SCENARIO_IDLE_MS) return close(lockedSince, "locked");
      if (now - openedAt >= SCENARIO_MAX_MS) return close(now, "cap");
      if (awaySince !== null && now - awaySince >= SCENARIO_AWAY_MS) return close(awaySince, "away");
      if (lockedSince === null && now - lastActivityAt >= SCENARIO_IDLE_MS) return close(lastActivityAt, "idle");
      return null;
    },
    isOpen: () => openedAt !== null
  };
}
```

`app/src/core/scenarios/compact.ts`:
```ts
import {SCENARIO_MAX_CHARS, SCENARIO_MIN_CHARS, SNAPSHOT_MAX_LINE_OVERLAP, SNAPSHOTS_PER_WINDOW} from "../constants";
import type {Scenario, ScenarioBlock, ScrubbedRead} from "../types";

const lineSet = (text: string) => new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));

/** Share of the smaller side's lines that also appear on the other side. */
export function lineOverlap(a: string, b: string): number {
  const left = lineSet(a);
  const right = lineSet(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return 1;
  let shared = 0;
  for (const line of left) if (right.has(line)) shared++;
  return shared / smaller;
}

const render = (blocks: ScenarioBlock[]) => blocks.map((b) => `[${b.app} — ${b.title}]\n${b.text}`).join("\n\n");

export function compact(reads: ScrubbedRead[], meta: {id: string; openedAt: number; closedAt: number}): Scenario | null {
  const byWindow = new Map<string, ScrubbedRead[]>();
  for (const read of reads) {
    const key = JSON.stringify([read.app, read.title]);
    byWindow.set(key, [...(byWindow.get(key) ?? []), read]);
  }

  let blocks: ScenarioBlock[] = [];
  for (const group of byWindow.values()) {
    const newestFirst = [...group].sort((a, b) => b.at - a.at);
    const kept: ScrubbedRead[] = [];
    for (const read of newestFirst) {
      if (kept.length === 0) { kept.push(read); continue; }
      if (kept.length > SNAPSHOTS_PER_WINDOW) break;
      if (kept.every((k) => lineOverlap(read.text, k.text) < SNAPSHOT_MAX_LINE_OVERLAP)) kept.push(read);
    }
    blocks.push(...kept.map(({app, title, text, at}) => ({app, title, text, at})));
  }
  blocks.sort((a, b) => a.at - b.at);

  const distinctChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (distinctChars < SCENARIO_MIN_CHARS) return null;

  while (blocks.length > 1 && render(blocks).length > SCENARIO_MAX_CHARS) blocks = blocks.slice(1);
  let text = render(blocks);
  if (text.length > SCENARIO_MAX_CHARS) {
    // One enormous window: keep its most recent part.
    const only = blocks[0] as ScenarioBlock;
    const room = SCENARIO_MAX_CHARS - (`[${only.app} — ${only.title}]\n`).length;
    blocks = [{...only, text: only.text.slice(-room)}];
    text = render(blocks);
  }
  return {...meta, blocks, text};
}
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 7: Candidate skills

**Files:**
- Create: `app/src/core/candidates/normalise.ts`, `app/src/core/candidates/ambiguous.ts`, `app/src/core/candidates/index.ts`
- Test: `app/src/core/candidates/candidates.test.ts`

**Interfaces:**
- Consumes: `Skill`, `Competency`, `Scenario`, `Offered` from `../types`; `MAX_CANDIDATE_SKILLS`, `MAX_PHRASE_TOKENS` from `../constants`.
- Produces:
  - `tokenize(text: string): Token[]` with `interface Token { raw: string; norm: string }` (also used by the guard in Task 9)
  - `normalisePhrase(name: string): string`
  - `buildSkillIndex(skills: Skill[]): SkillIndex` (opaque; build once per configuration)
  - `findCandidates(index: SkillIndex, scenario: Scenario): Offered[]` — at most `MAX_CANDIDATE_SKILLS`, best first
  - `offeredFor(index: SkillIndex, competencies: Competency[], scenario: Scenario): Offered[]` — candidate skills followed by every competency

Matching rules, in one place:
- Ordinary names match case-insensitively on whole tokens; multi-word names match as phrases; the longest match at a position wins.
- A **short** name (three characters or fewer, more than one character) matches only when the text has exactly the casing of one of the skill's own name forms.
- A **listed ambiguous** name (Go, Swift, Rust, React, Spring, Express, Flask, Dart, Make, Excel, Word, Access, Unity, Sketch, Notion, Linear) or any **single-letter** name (R, C) needs that exact casing AND a supporting hint elsewhere in the scenario. No hint entry means no match.

- [ ] **Step 1: Write the failing test**

`app/src/core/candidates/candidates.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import type {Scenario, Skill} from "../types";
import {buildSkillIndex, findCandidates, offeredFor} from "./index";
import {normalisePhrase, tokenize} from "./normalise";

const skill = (id: string, displayName: string, aliases: string[] = []): Skill =>
  ({id, displayName, canonicalName: displayName.toLowerCase(), aliases});

const SKILLS = [
  skill("pg", "PostgreSQL", ["Postgres", "psql"]), skill("redis", "Redis"), skill("node", "Node.js", ["NodeJS"]),
  skill("cpp", "C++"), skill("cs", "C#"), skill("ml", "Machine Learning"), skill("go", "Go", ["Golang"]),
  skill("react", "React", ["React.js"]), skill("aws", "AWS"), skill("r", "R"), skill("k8s", "Kubernetes")
];
const index = buildSkillIndex(SKILLS);

const scenario = (...texts: string[]): Scenario => ({
  id: "s", openedAt: 0, closedAt: 1,
  blocks: texts.map((text, i) => ({app: `App${i}`, title: `T${i}`, text, at: i})),
  text: texts.join("\n\n")
});
const ids = (s: Scenario) => findCandidates(index, s).map((o) => o.id);

describe("tokenize", () => {
  it("keeps + # and inner dots, drops trailing punctuation, splits on hyphens", () => {
    expect(tokenize("Use C++, C# and Node.js. Postgres-backed!").map((t) => t.raw))
      .toEqual(["Use", "C++", "C#", "and", "Node.js", "Postgres", "backed"]);
  });
  it("normalises a phrase the same way as text", () => {
    expect(normalisePhrase("  Machine   Learning ")).toBe("machine learning");
  });
});

describe("findCandidates", () => {
  it("matches names and aliases case-insensitively", () => {
    expect(ids(scenario("postgres falls back to a sequential scan; cached in REDIS"))).toEqual(expect.arrayContaining(["pg", "redis"]));
  });

  it("matches symbols and multi-word names", () => {
    expect(ids(scenario("ported the C++ solver, some C# glue, a machine learning model on Node.js")))
      .toEqual(expect.arrayContaining(["cpp", "cs", "ml", "node"]));
  });

  it("does not match inside another word", () => {
    expect(ids(scenario("a redistribution of predispositions"))).toEqual([]);
  });

  it("needs a hint for ambiguous names", () => {
    expect(ids(scenario("I will Go home and React to the news"))).toEqual([]);
    expect(ids(scenario("Rewrote the worker in Go. Ran go build and go test ./..."))).toContain("go");
    expect(ids(scenario("Moved the form to React with useState and useEffect hooks"))).toContain("react");
  });

  it("needs exact casing for short names and a hint for single letters", () => {
    expect(ids(scenario("deployed to AWS last night"))).toContain("aws");
    expect(ids(scenario("the paws and jaws of it"))).toEqual([]);
    expect(ids(scenario("plotted it in R with ggplot and dplyr"))).toContain("r");
    expect(ids(scenario("Section R of the contract"))).toEqual([]);
  });

  it("ranks by occurrences, with a bonus for appearing in more than one window", () => {
    const s = scenario("Kubernetes Kubernetes Kubernetes", "Redis", "Redis again");
    expect(ids(s).slice(0, 2)).toEqual(["redis", "k8s"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(findCandidates(index, scenario("lunch plans and a birthday cake"))).toEqual([]);
  });
});

describe("offeredFor", () => {
  it("offers candidate skills and then every competency", () => {
    const offered = offeredFor(index, [{id: "cp1", name: "Problem Solving", description: "Breaks problems down"}], scenario("tuned Redis"));
    expect(offered).toEqual([
      {id: "redis", kind: "skill", name: "Redis"},
      {id: "cp1", kind: "competency", name: "Problem Solving", description: "Breaks problems down"}
    ]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/candidates`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/candidates/normalise.ts`:
```ts
export interface Token { raw: string; norm: string }

/** Letters and digits, plus + # and inner dots, so C++, C# and Node.js survive. Hyphens split. */
const TOKEN = /(?<![\p{L}\p{N}])\.?[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0].replace(/\.+$/, "");
    if (raw && raw !== ".") tokens.push({raw, norm: raw.toLowerCase()});
  }
  return tokens;
}

export function normalisePhrase(name: string): string {
  return tokenize(name).map((t) => t.norm).join(" ");
}
```

`app/src/core/candidates/ambiguous.ts`:
```ts
/** Names that are also ordinary words. Each needs exact casing AND its hint somewhere in the scenario. */
const HINTS: Record<string, RegExp> = {
  go: /\.go\b|\bgo (build|run|mod|test|get|vet)\b|\bgolang\b|\bgoroutine/i,
  swift: /\.swift\b|\bswiftui\b|\bxcode\b|\buikit\b/i,
  rust: /\.rs\b|\bcargo (build|run|test|add)\b|\brustc\b|\bcrate\b/i,
  react: /\.(jsx|tsx)\b|\buse(State|Effect|Memo|Ref|Callback)\b|\breact-dom\b|\bjsx\b/,
  spring: /\bspring boot\b|springframework|@SpringBootApplication|@RestController/i,
  express: /express\(\)|require\(['"]express['"]\)|from ['"]express['"]|\bapp\.(get|post|use)\(/,
  flask: /from flask\b|\bflask run\b|@app\.route/i,
  dart: /\.dart\b|\bflutter\b|\bpubspec\b/i,
  make: /\bmakefile\b|\bmake (install|build|clean|test)\b/i,
  excel: /\.xlsx?\b|\bspreadsheet|\bworkbook\b|\bpivot table|\bvlookup\b/i,
  word: /\.docx?\b/i,
  access: /\.accdb\b|\bms access\b/i,
  unity: /\.unity\b|\bgameobject\b|\bmonobehaviour\b/i,
  sketch: /\.sketch\b|\bartboard/i,
  notion: /notion\.so\b|\bnotion (page|database|workspace)\b/i,
  linear: /linear\.app\b|\blinear (issue|ticket|cycle)\b/i,
  r: /\.(R|Rmd)\b|\brstudio\b|\bggplot|\bdplyr\b|\btidyverse\b|\bcran\b/i,
  c: /\.(c|h)\b|\bgcc\b|\bclang\b|\bmalloc\b|\bprintf\(/
};

export type Strictness = "plain" | "exactCase" | "exactCaseAndHint";

export function strictnessOf(normName: string): Strictness {
  if (normName in HINTS || [...normName].length === 1) return "exactCaseAndHint";
  if (!normName.includes(" ") && [...normName].length <= 3) return "exactCase";
  return "plain";
}

export function hintPresent(normName: string, scenarioText: string): boolean {
  const hint = HINTS[normName];
  return hint ? hint.test(scenarioText) : false;
}
```

`app/src/core/candidates/index.ts`:
```ts
import {MAX_CANDIDATE_SKILLS, MAX_PHRASE_TOKENS} from "../constants";
import type {Competency, Offered, Scenario, Skill} from "../types";
import {hintPresent, strictnessOf} from "./ambiguous";
import {normalisePhrase, tokenize} from "./normalise";

interface Entry { skill: Skill; /** The skill's own spellings for this phrase, for exact-case checks. */ forms: Set<string> }
export interface SkillIndex { byPhrase: Map<string, Entry[]> }

export function buildSkillIndex(skills: Skill[]): SkillIndex {
  const byPhrase = new Map<string, Entry[]>();
  for (const skill of skills) {
    for (const name of new Set([skill.displayName, skill.canonicalName, ...skill.aliases])) {
      const tokens = tokenize(name);
      if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS) continue;
      const phrase = tokens.map((t) => t.norm).join(" ");
      const spelling = tokens.map((t) => t.raw).join(" ");
      const entries = byPhrase.get(phrase) ?? [];
      const existing = entries.find((e) => e.skill.id === skill.id);
      if (existing) existing.forms.add(spelling);
      else entries.push({skill, forms: new Set([spelling])});
      byPhrase.set(phrase, entries);
    }
  }
  return {byPhrase};
}

export function findCandidates(index: SkillIndex, scenario: Scenario): Offered[] {
  const hits = new Map<string, {skill: Skill; count: number; windows: Set<number>}>();

  scenario.blocks.forEach((block, windowIndex) => {
    const tokens = tokenize(block.text);
    let i = 0;
    while (i < tokens.length) {
      let advanced = 1;
      for (let len = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); len >= 1; len--) {
        const slice = tokens.slice(i, i + len);
        const phrase = slice.map((t) => t.norm).join(" ");
        const entries = index.byPhrase.get(phrase);
        if (!entries) continue;
        const spelling = slice.map((t) => t.raw).join(" ");
        const accepted = entries.filter((entry) => {
          const strictness = strictnessOf(phrase);
          if (strictness === "plain") return true;
          if (!entry.forms.has(spelling)) return false;
          return strictness === "exactCase" || hintPresent(phrase, scenario.text);
        });
        if (accepted.length === 0) continue;
        for (const entry of accepted) {
          const hit = hits.get(entry.skill.id) ?? {skill: entry.skill, count: 0, windows: new Set<number>()};
          hit.count += 1;
          hit.windows.add(windowIndex);
          hits.set(entry.skill.id, hit);
        }
        advanced = len;
        break;
      }
      i += advanced;
    }
  });

  return [...hits.values()]
    .map((hit) => ({hit, score: hit.count + (hit.windows.size > 1 ? 2 : 0)}))
    .sort((a, b) => b.score - a.score || a.hit.skill.displayName.localeCompare(b.hit.skill.displayName))
    .slice(0, MAX_CANDIDATE_SKILLS)
    .map(({hit}) => ({id: hit.skill.id, kind: "skill" as const, name: hit.skill.displayName}));
}

export function offeredFor(index: SkillIndex, competencies: Competency[], scenario: Scenario): Offered[] {
  return [
    ...findCandidates(index, scenario),
    ...competencies.map((c) => ({id: c.id, kind: "competency" as const, name: c.name, description: c.description}))
  ];
}

export {normalisePhrase};
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 8: Two-pass extraction

**Files:**
- Create: `app/src/core/extraction/forms.ts`, `app/src/core/extraction/prompts.ts`, `app/src/core/extraction/extract.ts`
- Create: `app/src/core/testing/fakeModel.ts` (a scripted `ModelPort` used by this task, Task 11 and Task 12)
- Test: `app/src/core/extraction/extract.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `Offered`, `DraftStatement`, `ModelPort`, `ModelSettings`, `JsonSchema` from `../types`; `CoreError`, `CoreErrorCode` from `../errors`; `CountersApi` from `../counters`; the `GATE_LIMITS`, `STATEMENT_LIMITS`, `SUMMARY_MAX_CHARS`, `STATEMENT_MAX_CHARS`, `STATEMENTS_MIN`, `STATEMENTS_MAX`, `TEMPERATURE`, `RETRY_TEMPERATURE` constants.
- Produces:
  - `gateForm(): JsonSchema`, `statementsForm(offeredIds: string[]): JsonSchema`
  - `parseGate(answer: unknown): GateAnswer | null`, `parseStatements(answer: unknown, offeredIds: string[]): StatementsAnswer | null`
  - `buildSystemPrompt(input: {userNames: string[]; offered: Offered[]}): string`
  - `gateQuestion(scenarioText: string): string`, `STATEMENTS_QUESTION: string`
  - `extract(input: {scenario: Scenario; offered: Offered[]; userNames: string[]; model: ModelPort; counters: CountersApi}): Promise<ExtractOutcome>` where
    ```ts
    type ExtractOutcome =
      | {kind: "notProfessional"} | {kind: "nothingDemonstrated"}
      | {kind: "statements"; drafts: DraftStatement[]}
      | {kind: "failed"; code: CoreErrorCode};
    ```
  - `createFakeModel(script: FakeScript): FakeModel` (see Step 1)

Why two passes (from spike S1): with one form the model always closed the evidence list empty, because an empty list is the cheapest continuation under forced structure. With the yes/no field first it misjudged real work; a summary written first fixed that. The summary never leaves this function.

- [ ] **Step 1: Write the fake model**

`app/src/core/testing/fakeModel.ts`:
```ts
import type {JsonSchema, ModelConversation, ModelPort, ModelSettings} from "../types";

export interface FakeCall { settings: ModelSettings; userText: string; form: JsonSchema }
/** Each `ask` takes the next entry. A function entry is called with the call; an Error entry is thrown. */
export type FakeScript = Array<unknown | Error | ((call: FakeCall) => unknown | Promise<unknown>)>;

export interface FakeModel extends ModelPort { calls: FakeCall[]; opened: number; closed: number }

export function createFakeModel(script: FakeScript): FakeModel {
  const queue = [...script];
  const fake: FakeModel = {
    calls: [], opened: 0, closed: 0,
    async open(settings: ModelSettings): Promise<ModelConversation> {
      fake.opened += 1;
      return {
        async ask(userText, form) {
          const call = {settings, userText, form};
          fake.calls.push(call);
          if (queue.length === 0) throw new Error("fake model script exhausted");
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return typeof next === "function" ? await (next as (c: FakeCall) => unknown)(call) : next;
        },
        async close() { fake.closed += 1; }
      };
    }
  };
  return fake;
}
```

- [ ] **Step 2: Write the failing test**

`app/src/core/extraction/extract.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {RETRY_TEMPERATURE, TEMPERATURE} from "../constants";
import {createCounters} from "../counters";
import {createFakeModel} from "../testing/fakeModel";
import type {Offered, Scenario} from "../types";
import {extract} from "./extract";
import {gateForm, statementsForm} from "./forms";
import {buildSystemPrompt} from "./prompts";

const scenario: Scenario = {id: "s1", openedAt: 0, closedAt: 1, blocks: [], text: "[Slack — #backend]\nSECRET-SCREEN-TEXT traced the slow query"};
const offered: Offered[] = [
  {id: "pg", kind: "skill", name: "PostgreSQL"},
  {id: "cp1", kind: "competency", name: "Problem Solving", description: "Breaks problems down"}
];
const gateYes = {activity_summary: "Debugged a slow query.", is_professional: true, user_demonstrated_something: true};
const good = {evidence: [
  {target_id: "pg", statement: "Traced a latency regression to a missing index and fixed it without locking writes."},
  {target_id: "cp1", statement: "Weighed stale data against load and chose a cache bypass for support tooling."}
]};
const run = (model: ReturnType<typeof createFakeModel>, counters = createCounters()) =>
  extract({scenario, offered, userNames: ["Sardor Astanov"], model, counters}).then((outcome) => ({outcome, counters: counters.snapshot()}));

describe("forms", () => {
  it("puts the summary before the decisions", () => {
    expect(Object.keys((gateForm() as {properties: object}).properties)).toEqual(["activity_summary", "is_professional", "user_demonstrated_something"]);
  });
  it("restricts target_id to the offered ids and requires at least one item", () => {
    const form = statementsForm(["pg", "cp1"]) as any;
    expect(form.properties.evidence.minItems).toBe(1);
    expect(form.properties.evidence.items.properties.target_id.enum).toEqual(["pg", "cp1"]);
  });
});

describe("system prompt", () => {
  it("names the user, lists what is offered, and states the statement rules", () => {
    const prompt = buildSystemPrompt({userNames: ["Sardor Astanov", "sardor"], offered});
    for (const needle of ["Sardor Astanov", "sardor", "pg", "PostgreSQL", "cp1", "Breaks problems down", "past-tense verb", "English"]) {
      expect(prompt).toContain(needle);
    }
  });
});

describe("extract", () => {
  it("stops after the gate for private activity", async () => {
    const model = createFakeModel([{activity_summary: "Chatting about dinner.", is_professional: false, user_demonstrated_something: false}]);
    const {outcome, counters} = await run(model);
    expect(outcome).toEqual({kind: "notProfessional"});
    expect(model.calls.length).toBe(1);
    expect(model.closed).toBe(1);
    expect(counters["extract.gate.notProfessional"]).toBe(1);
  });

  it("stops when the user demonstrated nothing", async () => {
    const model = createFakeModel([{...gateYes, user_demonstrated_something: false}]);
    expect((await run(model)).outcome).toEqual({kind: "nothingDemonstrated"});
  });

  it("returns drafts with the kind taken from what was offered", async () => {
    const model = createFakeModel([gateYes, good]);
    const {outcome, counters} = await run(model);
    expect(outcome).toEqual({kind: "statements", drafts: [
      {targetId: "pg", kind: "skill", statement: good.evidence[0]!.statement},
      {targetId: "cp1", kind: "competency", statement: good.evidence[1]!.statement}
    ]});
    expect(model.calls[0]!.settings).toMatchObject({thoughts: "discourage", templateVariation: "3.5", temperature: TEMPERATURE});
    expect(model.calls[0]!.userText).toContain("SECRET-SCREEN-TEXT");
    expect(counters["extract.drafts"]).toBe(2);
  });

  it("retries once at temperature zero, in a fresh conversation", async () => {
    const model = createFakeModel([gateYes, {evidence: [{target_id: "not-offered", statement: "x"}]}, gateYes, good]);
    const {outcome, counters} = await run(model);
    expect(outcome.kind).toBe("statements");
    expect(model.opened).toBe(2);
    expect(model.closed).toBe(2);
    expect(model.calls[2]!.settings.temperature).toBe(RETRY_TEMPERATURE);
    expect(counters["extract.retries"]).toBe(1);
  });

  it("fails with a code, never with screen text, after the second bad attempt", async () => {
    const model = createFakeModel([new Error("boom SECRET-SCREEN-TEXT"), new Error("boom again")]);
    const {outcome, counters} = await run(model);
    expect(outcome).toEqual({kind: "failed", code: "MODEL_FAILED"});
    expect(JSON.stringify(outcome)).not.toContain("SECRET-SCREEN-TEXT");
    expect(counters["extract.failed"]).toBe(1);
    expect(model.closed).toBe(2);
  });

  it("reports an invalid answer distinctly", async () => {
    const model = createFakeModel([{nonsense: true}, {nonsense: true}]);
    expect((await run(model)).outcome).toEqual({kind: "failed", code: "MODEL_ANSWER_INVALID"});
  });

  it("does not call the model when nothing can be offered", async () => {
    const model = createFakeModel([]);
    const outcome = await extract({scenario, offered: [], userNames: [], model, counters: createCounters()});
    expect(outcome).toEqual({kind: "nothingDemonstrated"});
    expect(model.opened).toBe(0);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm --dir app test src/core/extraction`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`app/src/core/extraction/forms.ts`:
```ts
import {z} from "zod";
import {STATEMENT_MAX_CHARS, STATEMENTS_MAX, STATEMENTS_MIN, SUMMARY_MAX_CHARS} from "../constants";
import type {JsonSchema} from "../types";

/** Field order matters: the model must summarise before it decides. */
export function gateForm(): JsonSchema {
  return {
    type: "object",
    properties: {
      activity_summary: {type: "string", maxLength: SUMMARY_MAX_CHARS},
      is_professional: {type: "boolean"},
      user_demonstrated_something: {type: "boolean"}
    }
  };
}

export function statementsForm(offeredIds: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      evidence: {
        type: "array", minItems: STATEMENTS_MIN, maxItems: STATEMENTS_MAX,
        items: {
          type: "object",
          properties: {
            target_id: {enum: offeredIds},
            statement: {type: "string", maxLength: STATEMENT_MAX_CHARS}
          }
        }
      }
    }
  };
}

const gateAnswer = z.object({
  activity_summary: z.string().max(SUMMARY_MAX_CHARS),
  is_professional: z.boolean(),
  user_demonstrated_something: z.boolean()
});
export type GateAnswer = z.infer<typeof gateAnswer>;

export interface StatementsAnswer { evidence: {target_id: string; statement: string}[] }

/** Our own check. It does not depend on the runtime having enforced the form. */
export function parseGate(answer: unknown): GateAnswer | null {
  const result = gateAnswer.safeParse(answer);
  return result.success ? result.data : null;
}

export function parseStatements(answer: unknown, offeredIds: string[]): StatementsAnswer | null {
  const allowed = new Set(offeredIds);
  const shape = z.object({
    evidence: z.array(z.object({
      target_id: z.string().refine((id) => allowed.has(id)),
      statement: z.string().trim().min(1).max(STATEMENT_MAX_CHARS)
    })).min(STATEMENTS_MIN).max(STATEMENTS_MAX)
  });
  const result = shape.safeParse(answer);
  return result.success ? result.data : null;
}
```

`app/src/core/extraction/prompts.ts`:
```ts
import type {Offered} from "../types";

export function buildSystemPrompt(input: {userNames: string[]; offered: Offered[]}): string {
  const names = input.userNames.length ? input.userNames.map((n) => `"${n}"`).join(" or ") : "the owner of this computer";
  const list = input.offered
    .map((o) => `  ${o.id} = ${o.name}${o.kind === "competency" && o.description ? `: ${o.description}` : ""}`)
    .join("\n");
  return `You turn a record of what a professional did on their computer into evidence statements for their public profile.

The user is ${names}. In chats and tickets, every other person is someone else. Work done by anyone else is never the user's.

The record is text recognised from screenshots of the user's focused windows over about ten minutes, in time order, with the app and window before each block. It may contain small recognition errors and may be in any language.

You work in two steps.
Step 1: summarise what the user was doing, then decide whether it is professional work and whether the user personally demonstrated something.
Step 2, only when asked: write the evidence items.

Rules for evidence:
- The test: could a person who has never done this say the same thing? If yes, it is a mention, not evidence.
- Include an item only when the user DEMONSTRATED it through their own actions or reasoning: diagnosed, built, decided, explained, fixed. Merely mentioning a technology is not evidence. A colleague doing something is not evidence.
- Personal, entertainment, shopping or otherwise non-professional activity yields nothing.
- One item per skill or competency actually shown, usually two to four items.

Rules for each statement:
- Start with a past-tense verb. Do not name the user.
- Never include another person's name, a company, client, product or project name, quoted text, ticket ids, URLs, file paths, or exact figures that would identify an incident. Write "a colleague", "a client", "a production database" instead.
- 15 to 25 words. Always in English, whatever language was on screen.

Choose target_id only from this list:
${list}`;
}

export const gateQuestion = (scenarioText: string) => `ACTIVITY RECORD:\n\n${scenarioText}\n\nStep 1. Summarise the activity and decide.`;

export const STATEMENTS_QUESTION = "Step 2. Write the evidence items for what the user demonstrated, following every rule.";
```

`app/src/core/extraction/extract.ts`:
```ts
import {GATE_LIMITS, RETRY_TEMPERATURE, STATEMENT_LIMITS, TEMPERATURE} from "../constants";
import type {CountersApi} from "../counters";
import {CoreError, type CoreErrorCode} from "../errors";
import type {DraftStatement, ModelPort, Offered, Scenario} from "../types";
import {gateForm, parseGate, parseStatements, statementsForm} from "./forms";
import {buildSystemPrompt, gateQuestion, STATEMENTS_QUESTION} from "./prompts";

export type ExtractOutcome =
  | {kind: "notProfessional"} | {kind: "nothingDemonstrated"}
  | {kind: "statements"; drafts: DraftStatement[]}
  | {kind: "failed"; code: CoreErrorCode};

export interface ExtractInput { scenario: Scenario; offered: Offered[]; userNames: string[]; model: ModelPort; counters: CountersApi }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CoreError("MODEL_TIMEOUT")), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function attempt(input: ExtractInput, temperature: number): Promise<ExtractOutcome> {
  const {scenario, offered, userNames, model, counters} = input;
  const ids = offered.map((o) => o.id);
  const conversation = await model.open({
    systemPrompt: buildSystemPrompt({userNames, offered}), thoughts: "discourage", templateVariation: "3.5", temperature
  });
  try {
    counters.inc("extract.gate.runs");
    const gate = parseGate(await withTimeout(conversation.ask(gateQuestion(scenario.text), gateForm(), GATE_LIMITS), GATE_LIMITS.timeoutMs));
    if (!gate) throw new CoreError("MODEL_ANSWER_INVALID");
    if (!gate.is_professional) { counters.inc("extract.gate.notProfessional"); return {kind: "notProfessional"}; }
    if (!gate.user_demonstrated_something) { counters.inc("extract.gate.nothingDemonstrated"); return {kind: "nothingDemonstrated"}; }

    counters.inc("extract.statements.runs");
    const answer = parseStatements(
      await withTimeout(conversation.ask(STATEMENTS_QUESTION, statementsForm(ids), STATEMENT_LIMITS), STATEMENT_LIMITS.timeoutMs), ids);
    if (!answer) throw new CoreError("MODEL_ANSWER_INVALID");

    const kindOf = new Map(offered.map((o) => [o.id, o.kind]));
    const drafts = answer.evidence.map((e) => ({targetId: e.target_id, kind: kindOf.get(e.target_id) as DraftStatement["kind"], statement: e.statement.trim()}));
    counters.inc("extract.drafts", drafts.length);
    return {kind: "statements", drafts};
  } finally {
    await conversation.close().catch(() => undefined);
  }
}

/** Only our own fixed codes survive. A foreign error's message may contain screen text, so it is dropped. */
const codeOf = (error: unknown): CoreErrorCode => (error instanceof CoreError ? error.code : "MODEL_FAILED");

export async function extract(input: ExtractInput): Promise<ExtractOutcome> {
  if (input.offered.length === 0) return {kind: "nothingDemonstrated"};
  try {
    return await attempt(input, TEMPERATURE);
  } catch {
    input.counters.inc("extract.retries");
    try {
      return await attempt(input, RETRY_TEMPERATURE);
    } catch (second) {
      input.counters.inc("extract.failed");
      return {kind: "failed", code: codeOf(second)};
    }
  }
}
```

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.
If Zod 4 rejects `.refine` without a message or `safeParse` typing differs, keep the behaviour and adjust only the call shape; the tests define the contract.

---

### Task 9: Safety guard

**Files:**
- Create: `app/src/core/guard/commonWords.ts`, `app/src/core/guard/numbers.ts`, `app/src/core/guard/forbidden.ts`, `app/src/core/guard/checks.ts`
- Test: `app/src/core/guard/guard.test.ts`

**Interfaces:**
- Consumes: `tokenize` from `../candidates/normalise`; `Scenario` from `../types`; `GUARD_MIN_WORDS`, `GUARD_MAX_WORDS` from `../constants`.
- Produces:
  - `COMMON_WORDS: Set<string>`
  - `toWords(n: number): string`, `numberTerms(text: string): string[]`
  - `buildForbidden(input: {scenario: Scenario; userNames: string[]; allowTerms: string[]}): Forbidden` where `interface Forbidden { words: Set<string>; phrases: string[][]; substrings: string[] }`
  - `checkStatement(input: {statement: string; targetId: string; offeredIds: string[]; forbidden: Forbidden}): {ok: true} | {ok: false; check: 1 | 2 | 3 | 4 | 5 | 6}`

The guard **discards and never rewrites**. When unsure, it discards: a false discard costs one statement, a false pass publishes someone's name. What it treats as forbidden, all taken from that one scenario:
- People: the speaker at the start of a chat line (`Name Surname 10:42`), names after `Assignee`, `Reporter`, `Author`, `Owner`, `Reviewer`, `Cc`, and `@mentions`.
- Proper nouns: a capitalised word in the middle of a line that is not a common English word and not one of the offered skill or competency names.
- From window titles: capitalised words, and hyphenated or dotted compounds as a whole (`checkout-api`, `#backend-team`). A plain lowercase word in a title (`checkout`) is not forbidden on its own.
- File names (and their stems), paths, URLs, ticket ids.
- Numbers of two or more digits, or any number carrying a unit, in digit form and spelled out. `1` to `10` without a unit are allowed.
- The user's own names.

- [ ] **Step 1: Write the failing test**

`app/src/core/guard/guard.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import type {Scenario} from "../types";
import {checkStatement} from "./checks";
import {buildForbidden} from "./forbidden";
import {numberTerms, toWords} from "./numbers";

const block = (app: string, title: string, text: string, at: number) => ({app, title, text, at});
const blocks = [
  block("Slack", "#backend-team — Acme Workspace", [
    "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy.",
    "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
    "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable? cc @marina.k"
  ].join("\n"), 1),
  block("Code", "orderService.ts — checkout-api", "const row = await db.query(sql); // see https://wiki.acme.io/runbooks/orders and /Users/sardor/dev/checkout-api/src", 2),
  block("Jira", "PROJ-4821 Checkout latency regression", "Assignee Sardor Astanov  Reporter Priya Raman  Status In Review\nRoot Cause: migration 0412 added a join. p95 rose to 2400 ms.", 3)
];
const scenario: Scenario = {id: "s", openedAt: 0, closedAt: 1, blocks, text: blocks.map((b) => `[${b.app} — ${b.title}]\n${b.text}`).join("\n\n")};
const forbidden = buildForbidden({scenario, userNames: ["Sardor Astanov"], allowTerms: ["PostgreSQL", "Postgres", "Redis", "Problem Solving"]});
const check = (statement: string, targetId = "pg") => checkStatement({statement, targetId, offeredIds: ["pg", "redis", "cp1"], forbidden});

describe("numbers", () => {
  it("spells numbers out", () => {
    expect(toWords(30)).toBe("thirty");
    expect(toWords(2400)).toBe("two thousand four hundred");
    expect(toWords(8_000_000)).toBe("eight million");
    expect(toWords(21)).toBe("twenty one");
  });
  it("collects digit and spelled-out forms, keeps small bare numbers allowed", () => {
    const terms = numberTerms("spiked to 2.4 seconds on 8 million rows with a 30 second TTL, 3 retries, 2400 ms, 50,000 requests");
    for (const t of ["2.4", "two point four", "8 million", "eight million", "30", "thirty", "2400", "two thousand four hundred", "50000", "50,000", "fifty thousand"]) expect(terms).toContain(t);
    expect(terms).not.toContain("3");
    expect(terms).not.toContain("three");
  });
});

describe("guard passes good statements", () => {
  it.each([
    "Traced a latency regression to a missing index and rebuilt it without blocking writes on a production database.",
    "Diagnosed a slow PostgreSQL query as a sequential scan and resolved it by adding a supporting index.",
    "Introduced a short-lived Redis cache for a rarely changing value and bypassed it where stale data was unacceptable.",
    "Weighed stale reads against database load and chose different strategies for customer and support views."
  ])("%s", (statement) => expect(check(statement)).toEqual({ok: true}));
});

describe("guard discards", () => {
  it.each([
    ["a colleague's first name", "Explained the root cause of a slow query to Priya and proposed adding a supporting index."],
    ["a colleague's surname", "Answered a question from Lindqvist about cache staleness and proposed a bypass for support tooling."],
    ["an @mention", "Looped in marina.k after tracing a latency regression to a missing database index on a hot path."],
    ["the company", "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."],
    ["the workspace channel", "Led the backend-team discussion on fixing a latency regression caused by a missing database index."],
    ["the repository name", "Fixed a latency regression in checkout-api by adding an index and caching a rarely changing value."],
    ["a file name", "Rewrote orderService.ts to cache a rarely changing value and avoid an expensive join on hot paths."],
    ["a ticket id", "Closed PROJ-4821 by adding a supporting index and a cache for a rarely changing database value."],
    ["a digit figure", "Cut response time from 2400 ms back to normal by adding a supporting index to a production database."],
    ["a spelled-out figure", "Identified a sequential scan over eight million rows and fixed it by adding a supporting index."],
    ["a hyphenated spelled-out figure", "Added a thirty-second cache for a rarely changing value to remove a join from hot request paths."],
    ["the user's own name", "Sardor traced a latency regression to a missing index and fixed it without blocking database writes."]
  ])("%s", (_why, statement) => expect(check(statement)).toEqual({ok: false, check: 1}));

  it("quotes", () => expect(check("Told a colleague to \"create it concurrently\" when rebuilding a missing index on a production database.")).toEqual({ok: false, check: 2}));
  it("too short", () => expect(check("Fixed a slow query.")).toEqual({ok: false, check: 3}));
  it("not starting with a past-tense verb", () => {
    expect(check("He traced a latency regression to a missing index and fixed it without blocking database writes.")).toEqual({ok: false, check: 4});
    expect(check("Fix for a latency regression caused by a missing index on a busy production database table.")).toEqual({ok: false, check: 4});
  });
  it("accepts irregular past forms", () => expect(check("Built a short-lived cache in front of a rarely changing value to remove an expensive join.")).toEqual({ok: true}));
  it("not English", () => {
    // Starts with an English past-tense verb so that check 4 passes and check 5 is what catches it.
    expect(check("Fixed uma regressão de latência adicionando um índice ao banco de dados de produção sem bloquear escritas.")).toEqual({ok: false, check: 5});
    // A fully Portuguese statement is discarded too (check 4 happens to catch it first).
    expect(check("Corrigiu uma regressão de latência adicionando um índice ao banco de dados de produção sem bloquear escritas.").ok).toBe(false);
  });
  it("a target that was never offered", () => expect(check("Traced a latency regression to a missing index and rebuilt it without blocking database writes.", "k8s")).toEqual({ok: false, check: 6}));
});

describe("guard does not over-block", () => {
  it("allows offered skill names even though they are capitalised mid-sentence on screen", () => {
    expect(forbidden.words.has("postgres")).toBe(false);
    expect(forbidden.words.has("redis")).toBe(false);
  });
  it("does not forbid common words that happen to be capitalised in headings", () => {
    for (const w of ["root", "cause", "status", "review", "checkout", "latency"]) expect(forbidden.words.has(w)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/guard`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`app/src/core/guard/commonWords.ts`:
```ts
/**
 * Ordinary English words that are often capitalised on screen (sentence starts, headings, buttons,
 * field labels). A capitalised word NOT in this list is treated as a proper noun.
 * Grow this list from the evaluation set's false discards. Never add a name, brand or product.
 */
export const COMMON_WORDS = new Set(`
a about above accept access account action actions active activity add added after again against all also always am an and another answer any anyone app apps are area as ask assigned at attach available away
back backlog bad base based be because been before begin being below best better between big board both bottom branch break bug build built business but button by
call can cancel card case cause change changed changes channel chat check choose clear click close closed code collapse column come comment comments commit common complete completed config confirm connect contact content continue copy cost could count create created current custom customer
daily dashboard data database date day days deadline debug default delete deploy deployed description design details dev did different direct do docs document does doing done down draft due during
each early edit edited either else email empty enable end enter environment error even event every everyone example expand export external
failed false fast feature feedback few field file files filter find first fix fixed focus folder follow for form forward found from full
general get give given go goal going good got great group guide
had has have he header hello help her here hi high him his history home hot how however
i idea if import important in inbox include info inside install internal into is issue issues it item items its
job join just keep key kind know
label last later latest latency launch left less let level like limit line link list live load local log login long look low
made main make manage many mark may me meeting member members menu merge merged message messages might minute minutes mode more most move much must my
name need never new next no none normal not note notes nothing notification notifications now number
of off ok old on once one only open opened option options or order orders other our out over own
page pages panel part pass password path pending people per person phone pick place plan play please point post preview previous primary priority private problem process product production profile progress project public pull push put
question queue quick
ran rate read ready real reason recent record reference refresh regression release remove removed reopen replica reply report reporter request requests required reset resolve resolved response rest result results retry return review reviewer right role root row rows rule run running
same save saved say scan scheduled score screen search second section see select selected send sent server service session set settings share shared she should show side sign simple since site size skip slow small so some someone something sort source space sprint staging start started state status step still stop story subject submit success summary support sure switch sync system
tab table tag take task tasks team template test tests text than thank thanks that the their them then there these they thing this those thread through ticket time title to today together too tool top total track true try turn two type
under until up update updated upload url us use used user users using
value version very via view views
wait want warning was way we week welcome were what when where which while who why will window with without work worked working workspace would write
yes yesterday yet you your
`.split(/\s+/).filter(Boolean));
```

`app/src/core/guard/numbers.ts`:
```ts
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"]];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] as string, "hundred"); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] as string); n %= 10; if (n) parts.push(ONES[n] as string); }
  else if (n > 0) parts.push(ONES[n] as string);
  return parts.join(" ");
}

/** Whole numbers from 0 up to 999,999,999,999, spelled with spaces only: 21 is "twenty one". */
export function toWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) { parts.push(under1000(Math.floor(n / size) % 1000), name); n %= size; }
  }
  if (n > 0) parts.push(under1000(n));
  return parts.join(" ");
}

const MAGNITUDES = new Set(["thousand", "million", "billion", "k", "m", "bn"]);
const UNITS = new Set([...MAGNITUDES, "%", "percent", "x", "ms", "s", "sec", "secs", "second", "seconds", "min", "mins",
  "minute", "minutes", "hour", "hours", "hr", "hrs", "day", "days", "week", "weeks", "month", "months", "year", "years",
  "kb", "mb", "gb", "tb", "rps", "qps", "usd", "eur", "brl"]);

const NUMBER = /(?<![\p{L}\d.])(\d[\d,]*(?:\.\d+)?)(?:\s*(%|[A-Za-z]+))?/gu;

/**
 * Every figure in the text that could identify an incident, in digit form and spelled out.
 * Forbidden: anything above ten, any decimal, and any number carrying a unit ("8 million", "5 ms").
 * Allowed: a bare whole number from 0 to 10.
 */
export function numberTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(NUMBER)) {
    const shown = match[1] as string;
    const plain = shown.replace(/,/g, "");
    const value = Number(plain);
    if (!Number.isFinite(value)) continue;
    const unit = match[2] && UNITS.has(match[2].toLowerCase()) ? match[2].toLowerCase() : null;
    const decimal = plain.includes(".");
    if (!unit && !decimal && value <= 10) continue;

    const [whole, fraction] = plain.split(".") as [string, string | undefined];
    const words = fraction === undefined
      ? toWords(Number(whole))
      : `${toWords(Number(whole))} point ${[...fraction].map((d) => ONES[Number(d)]).join(" ")}`;

    if (decimal || value > 10) { terms.add(plain); terms.add(shown); terms.add(words); }
    if (unit) { terms.add(`${plain} ${unit}`); terms.add(`${words} ${unit}`); }
  }
  return [...terms];
}
```

`app/src/core/guard/forbidden.ts`:
```ts
import {tokenize} from "../candidates/normalise";
import type {Scenario} from "../types";
import {COMMON_WORDS} from "./commonWords";
import {numberTerms} from "./numbers";

/** `words` match one token, `phrases` match consecutive tokens, `substrings` match raw lowercase text. */
export interface Forbidden { words: Set<string>; phrases: string[][]; substrings: string[] }

const URL = /https?:\/\/\S+/gi;
const PATH = /(?:~|\/)[\w.-]+(?:\/[\w.-]+)+/g;
const FILE = /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|cs|rb|php|sql|json|ya?ml|md|html|css|scss|sh|toml|lock|csv|xlsx?|docx?|pdf)\b/gi;
const TICKET = /\b[A-Z]{2,}-\d+\b/g;
const MENTION = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;
/** "Priya Raman 10:42" at the start of a chat line. */
const SPEAKER = /^\s*(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){0,2})\s+\d{1,2}:\d{2}\b/gmu;
const LABELLED = /\b(?:Assignee|Reporter|Author|Owner|Reviewer|Cc|Assigned to|Reported by|Created by)[:\s]+(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){0,2})/gu;
/** A capitalised word in the middle of a line: the classic proper-noun signal. */
const MID_LINE_CAPITAL = /(?<=[\p{Ll}\d,;] )(\p{Lu}\p{Ll}[\p{L}]*)/gu;
const TITLE_COMPOUND = /[#@]?[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+/gu;
const CAPITALISED = /\b\p{Lu}\p{Ll}[\p{L}]*\b/gu;

export function buildForbidden(input: {scenario: Scenario; userNames: string[]; allowTerms: string[]}): Forbidden {
  const {scenario, userNames} = input;
  const words = new Set<string>();
  const phrases: string[][] = [];
  const substrings: string[] = [];

  const allowed = new Set<string>();
  for (const term of input.allowTerms) for (const token of tokenize(term)) allowed.add(token.norm);

  const texts = scenario.blocks.map((b) => b.text);
  const titles = scenario.blocks.map((b) => b.title);
  const body = texts.join("\n");

  // A word that also appears in plain lowercase prose is an ordinary word, not a proper noun.
  // URLs, paths and file names are removed first, so "acme" inside a path does not excuse "Acme".
  const prose = body.replace(URL, " ").replace(PATH, " ").replace(FILE, " ");
  const seenLowercase = new Set(tokenize(prose).filter((t) => t.raw === t.norm).map((t) => t.norm));

  const addTerm = (term: string) => {
    const tokens = tokenize(term).map((t) => t.norm);
    if (tokens.length === 1) words.add(tokens[0] as string);
    else if (tokens.length > 1) phrases.push(tokens);
  };
  const addName = (name: string) => {
    for (const token of tokenize(name)) {
      if (token.norm.length >= 2 && !COMMON_WORDS.has(token.norm) && !allowed.has(token.norm)) words.add(token.norm);
    }
  };
  const addProperNoun = (word: string) => {
    const norm = word.toLowerCase();
    if (norm.length < 3 || COMMON_WORDS.has(norm) || allowed.has(norm) || seenLowercase.has(norm)) return;
    words.add(norm);
  };

  // People.
  for (const match of body.matchAll(SPEAKER)) addName(match[1] as string);
  for (const match of body.matchAll(LABELLED)) addName(match[1] as string);
  for (const name of userNames) for (const token of tokenize(name)) if (token.norm.length >= 2) words.add(token.norm);
  for (const match of body.matchAll(MENTION)) {
    const handle = match[1] as string;
    addTerm(handle);
    for (const part of handle.split(/[._-]/)) if (part.length >= 3) words.add(part.toLowerCase());
  }

  // Proper nouns in running text. All-caps acronyms (API, TTL) are deliberately not treated as names.
  for (const line of body.split("\n")) for (const match of line.matchAll(MID_LINE_CAPITAL)) addProperNoun(match[1] as string);

  // Window titles and app names.
  for (const title of titles) {
    for (const match of title.matchAll(TITLE_COMPOUND)) addTerm(match[0].replace(/^[#@]/, ""));
    for (const match of title.replace(TITLE_COMPOUND, " ").matchAll(CAPITALISED)) addProperNoun(match[0]);
  }
  for (const block of scenario.blocks) for (const match of block.app.matchAll(CAPITALISED)) addProperNoun(match[0]);

  // Addresses, paths, files, tickets.
  const everything = [body, ...titles].join("\n");
  for (const match of everything.matchAll(URL)) substrings.push(match[0].toLowerCase());
  for (const match of everything.matchAll(PATH)) substrings.push(match[0].toLowerCase());
  for (const match of everything.matchAll(FILE)) {
    const file = match[0];
    addTerm(file);
    const stem = file.slice(0, file.lastIndexOf("."));
    if (stem.length >= 3 && !COMMON_WORDS.has(stem.toLowerCase())) addTerm(stem);
  }
  for (const match of everything.matchAll(TICKET)) addTerm(match[0]);

  // Figures, in digit form and spelled out.
  for (const term of numberTerms(everything)) addTerm(term.replace(/(\d),(?=\d{3})/g, "$1"));

  return {words, phrases, substrings};
}
```

`app/src/core/guard/checks.ts`:
```ts
import {tokenize} from "../candidates/normalise";
import {GUARD_MAX_WORDS, GUARD_MIN_WORDS} from "../constants";
import type {Forbidden} from "./forbidden";

export type CheckResult = {ok: true} | {ok: false; check: 1 | 2 | 3 | 4 | 5 | 6};

const QUOTES = /["“”«»]/;
const PRONOUNS = new Set(["i", "he", "she", "they", "we", "you", "it", "my", "his", "her", "their", "our", "the", "a", "an", "this", "that"]);
const IRREGULAR_PAST = new Set(["built", "wrote", "rewrote", "led", "ran", "made", "found", "drove", "set", "cut", "took", "gave",
  "taught", "kept", "held", "got", "won", "began", "chose", "drew", "grew", "knew", "saw", "sent", "spent", "spoke", "thought",
  "understood", "rebuilt", "brought", "caught", "dealt", "put", "split", "shut", "broke", "fed", "met", "paid", "sold", "told",
  "stood", "withdrew", "oversaw", "undertook", "laid", "left", "lent", "lost", "meant", "read", "rode", "rose", "sought", "shook", "stuck", "swept", "threw", "wove", "wound"]);
const ENGLISH_MARKERS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "in", "on", "by", "it", "that", "from", "as",
  "at", "was", "were", "without", "where", "which", "into", "between", "across", "after", "before", "while", "when", "its", "their"]);

function containsPhrase(tokens: string[], phrase: string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** Discards. Never rewrites. The first failing check is reported, in the order of the spec. */
export function checkStatement(input: {statement: string; targetId: string; offeredIds: string[]; forbidden: Forbidden}): CheckResult {
  const {forbidden} = input;
  const cleaned = input.statement.replace(/(\d),(?=\d{3})/g, "$1");
  const lower = cleaned.toLowerCase();
  const tokens = tokenize(cleaned).map((t) => t.norm);

  // 1. No forbidden term.
  if (tokens.some((t) => forbidden.words.has(t))) return {ok: false, check: 1};
  if (forbidden.phrases.some((p) => containsPhrase(tokens, p))) return {ok: false, check: 1};
  if (forbidden.substrings.some((s) => lower.includes(s))) return {ok: false, check: 1};

  // 2. No quoted text.
  if (QUOTES.test(cleaned)) return {ok: false, check: 2};

  // 3. Length.
  const wordCount = cleaned.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < GUARD_MIN_WORDS || wordCount > GUARD_MAX_WORDS) return {ok: false, check: 3};

  // 4. Starts with a past-tense verb, not a name or pronoun.
  const first = tokens[0] ?? "";
  if (PRONOUNS.has(first) || !(first.endsWith("ed") || IRREGULAR_PAST.has(first))) return {ok: false, check: 4};

  // 5. English.
  if (tokens.filter((t) => ENGLISH_MARKERS.has(t)).length < 2) return {ok: false, check: 5};

  // 6. The target was actually offered.
  if (!input.offeredIds.includes(input.targetId)) return {ok: false, check: 6};

  return {ok: true};
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app test src/core/guard`
Expected: PASS. If a "guard passes good statements" case fails, the fix belongs in `commonWords.ts` or in the lowercase-evidence rule, never in loosening a discard rule.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

Known limits, to be stated in the review screen and in `docs/WHAT-LEAVES.md`: all-caps names ("ACME") are not recognised as proper nouns; a confidential fact phrased in generic words cannot be detected by any code check. The user's approval covers both.

---

### Task 10: Daily digest

**Files:**
- Create: `app/src/core/digest.ts`
- Test: `app/src/core/digest.test.ts`

**Interfaces:**
- Consumes: `DraftStatement`, `PendingStatement`, `Ports` from `./types`; `CountersApi` from `./counters`; `tokenize` from `./candidates/normalise`; `DIGEST_PER_TARGET`, `DIGEST_PER_DAY`, `DIGEST_ITEM_TTL_DAYS`, `DIGEST_MERGE_OVERLAP`, `PIPELINE_VERSION`, `STATEMENT_MAX_CHARS` from `./constants`.
- Produces: `createDigest(deps: {clock: Ports["clock"]; newId: Ports["newId"]; counters: CountersApi; taxonomyVersion: () => string}): Digest` where
  ```ts
  interface Digest {
    add(draft: DraftStatement): "added" | "merged";
    /** What the user is shown right now. Never more than the caps allow. */
    list(): PendingStatement[];
    resolve(id: string): boolean;
    /** Day rollover and expiry. Cheap; call from the pipeline's tick. */
    tick(): void;
    exportPool(): PendingStatement[];
    importPool(items: unknown): {accepted: number; rejected: number};
  }
  ```

The cap rule, stated once: on any day, *items shown now* plus *items the user already resolved today* never exceeds `DIGEST_PER_DAY`. At the day's end, whatever was being shown is carried into the next day; everything else in the pool is **dropped**, never queued. Carried items expire `DIGEST_ITEM_TTL_DAYS` after they were created.

- [ ] **Step 1: Write the failing test**

`app/src/core/digest.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {DIGEST_ITEM_TTL_DAYS, DIGEST_PER_DAY, DIGEST_PER_TARGET} from "./constants";
import {createCounters} from "./counters";
import {createDigest} from "./digest";

const DAY = 86_400_000;
function setup(start = Date.UTC(2026, 8, 17, 9)) {
  let now = start;
  let n = 0;
  const counters = createCounters();
  const digest = createDigest({
    clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)},
    newId: () => `id${++n}`, counters, taxonomyVersion: () => "tax-7"
  });
  return {digest, counters, advance: (ms: number) => { now += ms; }};
}
const skill = (targetId: string, statement: string) => ({targetId, kind: "skill" as const, statement});
const distinct = (i: number) => `Resolved problem number${i} using technique${i} on system${i} while coordinating rollout${i} safely`;

describe("digest", () => {
  it("stamps every item", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Traced a latency regression to a missing index and rebuilt it without blocking writes."));
    expect(digest.list()).toEqual([{
      id: "id1", kind: "skill", targetId: "pg", createdAt: Date.UTC(2026, 8, 17, 9),
      statement: "Traced a latency regression to a missing index and rebuilt it without blocking writes.",
      taxonomyVersion: "tax-7", pipelineVersion: "1"
    }]);
  });

  it("merges near-duplicates for the same target and keeps the more specific one", () => {
    const {digest, counters} = setup();
    expect(digest.add(skill("pg", "Traced a latency regression to a missing index."))).toBe("added");
    expect(digest.add(skill("pg", "Traced a latency regression to a missing index and rebuilt it without blocking production writes."))).toBe("merged");
    expect(digest.list().map((i) => i.statement)).toEqual(["Traced a latency regression to a missing index and rebuilt it without blocking production writes."]);
    expect(counters.snapshot()["digest.merged"]).toBe(1);
  });

  it("does not merge across different targets", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Traced a latency regression to a missing index."));
    digest.add(skill("redis", "Traced a latency regression to a missing index."));
    expect(digest.list().length).toBe(2);
  });

  it("shows at most two per target, preferring the most specific", () => {
    const {digest} = setup();
    digest.add(skill("pg", "Tuned a query planner setting."));
    digest.add(skill("pg", distinct(1)));
    digest.add(skill("pg", distinct(2)));
    const shown = digest.list();
    expect(shown.length).toBe(DIGEST_PER_TARGET);
    expect(shown.map((i) => i.statement)).not.toContain("Tuned a query planner setting.");
  });

  it("caps the day and spreads across targets before doubling up", () => {
    const {digest} = setup();
    for (let i = 0; i < 8; i++) { digest.add(skill(`t${i}`, distinct(i))); digest.add(skill(`t${i}`, distinct(100 + i))); }
    const shown = digest.list();
    expect(shown.length).toBe(DIGEST_PER_DAY);
    expect(new Set(shown.map((i) => i.targetId)).size).toBe(8);
  });

  it("counts resolved items against the day's cap", () => {
    const {digest} = setup();
    for (let i = 0; i < 14; i++) digest.add(skill(`t${i}`, distinct(i)));
    const first = digest.list();
    expect(first.length).toBe(10);
    for (const item of first.slice(0, 4)) expect(digest.resolve(item.id)).toBe(true);
    expect(digest.list().length).toBe(6);
    expect(digest.resolve("nope")).toBe(false);
  });

  it("at day rollover carries what was shown and drops the rest", () => {
    const {digest, counters, advance} = setup();
    for (let i = 0; i < 14; i++) digest.add(skill(`t${i}`, distinct(i)));
    const shown = digest.list().map((i) => i.id);
    advance(DAY); digest.tick();
    expect(digest.list().map((i) => i.id).sort()).toEqual([...shown].sort());
    expect(counters.snapshot()["digest.capped"]).toBe(4);
  });

  it("expires carried items after the time-to-live", () => {
    const {digest, counters, advance} = setup();
    digest.add(skill("pg", distinct(1)));
    advance(DAY); digest.tick();
    expect(digest.list().length).toBe(1);
    advance(DIGEST_ITEM_TTL_DAYS * DAY); digest.tick();
    expect(digest.list()).toEqual([]);
    expect(counters.snapshot()["digest.expired"]).toBe(1);
  });

  it("never exceeds its caps whatever is added (property check)", () => {
    const {digest} = setup();
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 300; i++) {
      digest.add(skill(`t${rand(12)}`, distinct(rand(1000))));
      const shown = digest.list();
      expect(shown.length).toBeLessThanOrEqual(DIGEST_PER_DAY);
      const perTarget = new Map<string, number>();
      for (const item of shown) perTarget.set(item.targetId, (perTarget.get(item.targetId) ?? 0) + 1);
      expect(Math.max(0, ...perTarget.values())).toBeLessThanOrEqual(DIGEST_PER_TARGET);
    }
  });

  it("round-trips through export and import, rejecting anything malformed or expired", () => {
    const a = setup();
    a.digest.add(skill("pg", distinct(1)));
    const exported = a.digest.exportPool();
    const b = setup();
    const stale = {...exported[0]!, id: "old", createdAt: Date.UTC(2026, 8, 1)};
    expect(b.digest.importPool([...exported, {id: 1}, "junk", stale])).toEqual({accepted: 1, rejected: 3});
    expect(b.digest.list().map((i) => i.statement)).toEqual([distinct(1)]);
    expect(b.digest.importPool("not a list")).toEqual({accepted: 0, rejected: 0});
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/digest.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`app/src/core/digest.ts`:
```ts
import {z} from "zod";
import {tokenize} from "./candidates/normalise";
import {DIGEST_ITEM_TTL_DAYS, DIGEST_MERGE_OVERLAP, DIGEST_PER_DAY, DIGEST_PER_TARGET, PIPELINE_VERSION, STATEMENT_MAX_CHARS} from "./constants";
import type {CountersApi} from "./counters";
import type {DraftStatement, PendingStatement, Ports} from "./types";

export interface Digest {
  add(draft: DraftStatement): "added" | "merged";
  list(): PendingStatement[];
  resolve(id: string): boolean;
  tick(): void;
  exportPool(): PendingStatement[];
  importPool(items: unknown): {accepted: number; rejected: number};
}

const DAY_MS = 86_400_000;
const FILLER = new Set(["the", "and", "for", "with", "that", "from", "into", "was", "were", "its", "their", "while", "where", "which", "without"]);

const contentWords = (statement: string) => new Set(tokenize(statement).map((t) => t.norm).filter((w) => w.length >= 3 && !FILLER.has(w)));

function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / smaller;
}

const stored = z.object({
  id: z.string().min(1), kind: z.enum(["skill", "competency"]), targetId: z.string().min(1),
  statement: z.string().min(1).max(STATEMENT_MAX_CHARS), createdAt: z.number().finite(),
  taxonomyVersion: z.string(), pipelineVersion: z.string()
});

export function createDigest(deps: {clock: Ports["clock"]; newId: Ports["newId"]; counters: CountersApi; taxonomyVersion: () => string}): Digest {
  const {clock, counters} = deps;
  let pool: PendingStatement[] = [];
  let today = clock.dayKey(clock.now());
  let resolvedToday = 0;

  const isCarried = (item: PendingStatement) => clock.dayKey(item.createdAt) !== today;
  const expired = (item: PendingStatement, now: number) => now - item.createdAt >= DIGEST_ITEM_TTL_DAYS * DAY_MS;

  function view(): PendingStatement[] {
    const room = Math.max(0, DIGEST_PER_DAY - resolvedToday);
    const perTarget = new Map<string, number>();
    const chosen: PendingStatement[] = [];
    const take = (item: PendingStatement) => { chosen.push(item); perTarget.set(item.targetId, (perTarget.get(item.targetId) ?? 0) + 1); };

    // Carried items were already shown to the user; they keep their place, oldest first.
    for (const item of pool.filter(isCarried).sort((a, b) => a.createdAt - b.createdAt)) {
      if (chosen.length < room && (perTarget.get(item.targetId) ?? 0) < DIGEST_PER_TARGET) take(item);
    }
    // Today's items: most specific first, one per target before anyone gets a second.
    const fresh = pool.filter((i) => !isCarried(i))
      .sort((a, b) => contentWords(b.statement).size - contentWords(a.statement).size || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (let round = 1; round <= DIGEST_PER_TARGET; round++) {
      for (const item of fresh) {
        if (chosen.length >= room) break;
        if (chosen.includes(item)) continue;
        if ((perTarget.get(item.targetId) ?? 0) < round) take(item);
      }
    }
    return chosen;
  }

  return {
    add(draft) {
      const words = contentWords(draft.statement);
      const twin = pool.find((i) => !isCarried(i) && i.targetId === draft.targetId && overlap(words, contentWords(i.statement)) >= DIGEST_MERGE_OVERLAP);
      if (twin) {
        if (words.size > contentWords(twin.statement).size) twin.statement = draft.statement;
        counters.inc("digest.merged");
        return "merged";
      }
      pool.push({
        id: deps.newId(), kind: draft.kind, targetId: draft.targetId, statement: draft.statement,
        createdAt: clock.now(), taxonomyVersion: deps.taxonomyVersion(), pipelineVersion: PIPELINE_VERSION
      });
      counters.inc("digest.added");
      return "added";
    },
    list: () => view().map((item) => ({...item})),
    resolve(id) {
      const before = pool.length;
      pool = pool.filter((i) => i.id !== id);
      if (pool.length === before) return false;
      resolvedToday += 1;
      return true;
    },
    tick() {
      const now = clock.now();
      const day = clock.dayKey(now);
      if (day !== today) {
        const shown = new Set(view().map((i) => i.id));
        counters.inc("digest.capped", pool.length - shown.size);
        pool = pool.filter((i) => shown.has(i.id));
        today = day;
        resolvedToday = 0;
      }
      const alive = pool.filter((i) => !expired(i, now));
      counters.inc("digest.expired", pool.length - alive.length);
      pool = alive;
    },
    exportPool: () => pool.map((item) => ({...item})),
    importPool(items) {
      if (!Array.isArray(items)) return {accepted: 0, rejected: 0};
      const now = clock.now();
      let accepted = 0;
      let rejected = 0;
      for (const raw of items) {
        const parsed = stored.safeParse(raw);
        if (!parsed.success || expired(parsed.data, now) || pool.some((i) => i.id === parsed.data.id)) { rejected++; continue; }
        pool.push(parsed.data);
        accepted++;
      }
      return {accepted, rejected};
    }
  };
}
```

- [ ] **Step 4: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 11: Wire the pipeline together

**Files:**
- Create: `app/src/core/index.ts`
- Test: `app/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes (exact names from earlier tasks): `createBuffer` (`./buffer`); `buildSkillIndex`, `offeredFor`, `SkillIndex` (`./candidates/index`); `createCounters` (`./counters`); `createDigest` (`./digest`); `createExclusions`, `Exclusions` (`./exclusions/index`); `extract` (`./extraction/extract`); `checkStatement` (`./guard/checks`); `buildForbidden` (`./guard/forbidden`); `compact` (`./scenarios/compact`); `createSegmenter`, `ClosedSpan` (`./scenarios/segmenter`); `scrub` (`./scrub/scrub`); `BUFFER_MAX_AGE_MS`, `EXTRACTION_QUEUE_MAX` (`./constants`); all public types (`./types`).
- Produces: `createPipeline(config: PipelineConfig, ports: Ports): Pipeline`, and re-exports of the public types and of `DEFAULT_EXCLUSIONS`, `DEFAULT_EXCLUDED_SITES`.

Behaviour decisions made here:
- **Capture is OFF until the app sends `captureOn`.** Fail closed.
- `ingest` re-checks the exclusions itself. The app is supposed to call `mayCapture` first, but the core does not rely on it.
- The recognised toolbar strip is used for the site and private-window checks and then thrown away. It is never stored.
- A read's timestamp is the core's clock, not the caller's.
- One extraction at a time. Up to `EXTRACTION_QUEUE_MAX` scenarios wait; when full, the oldest waiting one is dropped. A waiting scenario older than `BUFFER_MAX_AGE_MS` is dropped too, which keeps the sixty-minute promise even when the model is stuck.
- After extraction the scenario's text and blocks are emptied, whatever the outcome.

- [ ] **Step 1: Write the failing test**

`app/src/core/pipeline.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import {BUFFER_MAX_AGE_MS, SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel, type FakeScript} from "./testing/fakeModel";
import type {PipelineConfig} from "./types";

const CONFIG: PipelineConfig = {
  exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "tax-7",
  skills: [
    {id: "pg", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]},
    {id: "redis", displayName: "Redis", canonicalName: "redis", aliases: []}
  ],
  competencies: [{id: "cp1", name: "Problem Solving", description: "Breaks a problem down and resolves it"}],
  userNames: ["Sardor Astanov"]
};

const SLACK = {app: "Slack", title: "#backend-team — Acme Workspace", text: [
  "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy. Any idea what changed?",
  "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
  "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable for support agents?",
  "Sardor 10:51 For the customer page yes. For the support dashboard I would bypass the cache and hit the replica."
].join("\n")};
const JIRA = {app: "Jira", title: "PROJ-4821 Checkout latency regression", text:
  "Assignee Sardor Astanov  Reporter Priya Raman  Status In Review\nRoot Cause: migration 0412 added a join with no supporting index. p95 rose to 2400 ms.\nFix: added the index concurrently and a short cache, then verified on staging with replayed traffic."};

const GATE_YES = {activity_summary: "Debugged a slow query.", is_professional: true, user_demonstrated_something: true};
const GATE_NO = {activity_summary: "Personal browsing.", is_professional: false, user_demonstrated_something: false};
const CLEAN_PG = "Traced a latency regression to a missing index and rebuilt it without blocking writes on a production database.";
const CLEAN_CP = "Weighed stale reads against database load and chose different strategies for customer and support views.";

function setup(script: FakeScript, config: PipelineConfig = CONFIG) {
  let now = Date.UTC(2026, 8, 17, 9);
  let n = 0;
  const model = createFakeModel(script);
  const pipeline = createPipeline(config, {
    model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`
  });
  const advance = (ms: number) => { now += ms; };
  const read = (w: {app: string; title: string; text: string; toolbarText?: string}) => {
    advance(30_000);
    const decision = pipeline.mayCapture(w);
    return decision.allow ? pipeline.ingest({...w, at: now}) : {kept: false as const, reason: decision.reason};
  };
  const finish = async () => { advance(SCENARIO_IDLE_MS + 1_000); pipeline.tick(); await pipeline.whenIdle(); };
  return {pipeline, model, advance, read, finish};
}
const long = (tag: string) => `${tag} investigated the failing integration and documented the outcome for the team. `.repeat(8);

describe("pipeline", () => {
  it("is off until switched on, and stops when the screen locks", () => {
    const {pipeline} = setup([]);
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "captureOff"});
    pipeline.signal("captureOn");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
    pipeline.signal("locked");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "locked"});
    expect(pipeline.ingest({...SLACK, at: 0})).toEqual({kept: false, reason: "locked"});
    pipeline.signal("unlocked");
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
  });

  it("turns a stretch of work into stamped, guarded statements", async () => {
    const {pipeline, model, read, finish} = setup([GATE_YES, {evidence: [{target_id: "pg", statement: CLEAN_PG}, {target_id: "cp1", statement: CLEAN_CP}]}]);
    pipeline.signal("captureOn");
    expect(read(SLACK)).toEqual({kept: true});
    expect(read(SLACK)).toEqual({kept: false, reason: "unchanged"});
    expect(read(JIRA)).toEqual({kept: true});
    await finish();
    // The digest ranks by specificity, so compare without assuming an order.
    const rows = pipeline.digest().map((i) => [i.kind, i.targetId, i.statement, i.taxonomyVersion]);
    expect(rows.sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
      ["competency", "cp1", CLEAN_CP, "tax-7"], ["skill", "pg", CLEAN_PG, "tax-7"]
    ]);
    expect(model.calls[0]!.settings.systemPrompt).toContain("pg = PostgreSQL");
    expect(model.calls[0]!.userText).toContain("[Slack — #backend-team — Acme Workspace]");
    const id = pipeline.digest()[0]!.id;
    pipeline.resolve(id, "approved");
    expect(pipeline.digest().length).toBe(1);
    expect(pipeline.counters()["statements.approved"]).toBe(1);
    const taken = pipeline.takeCounters();
    expect(taken["reads.kept"]).toBe(2);
    expect(taken["reads.skipped.unchanged"]).toBe(1);
    expect(pipeline.counters()).toEqual({});
  });

  it("LEAK TEST: nothing forbidden reaches the digest or the counters, even when the model leaks", async () => {
    const leaky = {evidence: [
      {target_id: "pg", statement: "Explained the root cause of a slow query to Priya and proposed adding a supporting index."},
      {target_id: "pg", statement: "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."},
      {target_id: "cp1", statement: "Closed PROJ-4821 by adding a supporting index and a cache for a rarely changing database value."},
      {target_id: "pg", statement: "Identified a sequential scan over eight million rows and fixed it by adding a supporting index."},
      {target_id: "cp1", statement: CLEAN_CP}
    ]};
    const {pipeline, read, finish} = setup([GATE_YES, leaky]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    expect(pipeline.digest().map((i) => i.statement)).toEqual([CLEAN_CP]);
    expect(pipeline.counters()["guard.discarded.check1"]).toBe(4);
    const everythingThatCouldLeave = JSON.stringify([pipeline.digest(), pipeline.exportPool(), pipeline.counters()]);
    for (const secret of ["Priya", "Raman", "Tomas", "Lindqvist", "Acme", "PROJ", "4821", "0412", "2400", "eight million", "Sardor", "backend-team"]) {
      expect(everythingThatCouldLeave).not.toContain(secret);
    }
  });

  it("never reads an excluded app, even if the app forgets to ask first", async () => {
    const {pipeline, model, read, finish} = setup([]);
    pipeline.signal("captureOn");
    const telegram = {app: "Telegram", title: "Madina", text: long("private")};
    expect(read(telegram)).toEqual({kept: false, reason: "excludedApp"});
    expect(pipeline.ingest({...telegram, at: 0})).toEqual({kept: false, reason: "excludedApp"});
    expect(read({app: "Google Chrome", title: "Log in", text: long("bank"), toolbarText: "https://www.paypal.com/signin"})).toEqual({kept: false, reason: "excludedSite"});
    expect(read({app: "Google Chrome", title: "Example Domain", text: long("secret"), toolbarText: "example.com  Incognito"})).toEqual({kept: false, reason: "privateWindow"});
    await finish();
    expect(model.opened).toBe(0);
  });

  it("scrubs secrets before the model ever sees the text", async () => {
    const {pipeline, model, read, finish} = setup([GATE_NO]);
    pipeline.signal("captureOn");
    read({app: "Terminal", title: "zsh — deploy", text: long("deploy") + "\nexport STRIPE_KEY=sk_live_51AbCdEfGhIjKlMnOpQrStUv\n"});
    await finish();
    expect(model.calls[0]!.userText).toContain("[SECRET]");
    expect(model.calls[0]!.userText).not.toContain("sk_live_51AbCdEfGhIjKlMnOpQrStUv");
    expect(pipeline.digest()).toEqual([]);
  });

  it("denies everything while the configuration is invalid, and recovers when it is fixed", () => {
    const {pipeline} = setup([], {...CONFIG, exclusions: [42] as unknown as string[]});
    pipeline.signal("captureOn");
    let seed = 3;
    for (let i = 0; i < 50; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      expect(pipeline.mayCapture({app: `App${seed % 9}`, title: `Title ${seed}`})).toEqual({allow: false, reason: "rulesInvalid"});
    }
    expect(pipeline.configure({...CONFIG, skills: "nope" as unknown as []}).ok).toBe(false);
    expect(pipeline.configure(CONFIG)).toEqual({ok: true});
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: true});
  });

  it("drops the scenario when the model keeps returning a target that was never offered", async () => {
    const bad = {evidence: [{target_id: "k8s", statement: CLEAN_PG}]};
    const {pipeline, read, finish} = setup([GATE_YES, bad, GATE_YES, bad]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    expect(pipeline.digest()).toEqual([]);
    expect(pipeline.counters()["extract.failed"]).toBe(1);
  });

  it("keeps at most three scenarios waiting and drops the oldest, without ever blocking capture", async () => {
    let release: (v: unknown) => void = () => undefined;
    const blocked = new Promise((resolve) => { release = resolve; });
    const {pipeline, model, advance, read} = setup([() => blocked, GATE_NO, GATE_NO, GATE_NO]);
    pipeline.signal("captureOn");
    for (let i = 0; i < 5; i++) {
      expect(read({app: "Code", title: `file${i}.ts`, text: long(`item${i}`)})).toEqual({kept: true});
      advance(SCENARIO_IDLE_MS + 1_000);
      pipeline.tick();
    }
    expect(pipeline.counters()["scenarios.droppedQueue"]).toBe(1);
    release(GATE_NO);
    await pipeline.whenIdle();
    expect(model.opened).toBe(4);
  });

  it("drops a waiting scenario once it is older than sixty minutes", async () => {
    let release: (v: unknown) => void = () => undefined;
    const blocked = new Promise((resolve) => { release = resolve; });
    const {pipeline, model, advance, read} = setup([() => blocked]);
    pipeline.signal("captureOn");
    for (let i = 0; i < 2; i++) { read({app: "Code", title: `f${i}.ts`, text: long(`w${i}`)}); advance(SCENARIO_IDLE_MS + 1_000); pipeline.tick(); }
    advance(BUFFER_MAX_AGE_MS + 1);
    pipeline.tick();
    expect(pipeline.counters()["scenarios.droppedStale"]).toBe(1);
    release(GATE_NO);
    await pipeline.whenIdle();
    expect(model.opened).toBe(1);
  });

  it("closes the open scenario at once when capture is switched off", async () => {
    const {pipeline, model, read} = setup([GATE_NO]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    pipeline.signal("captureOff");
    await pipeline.whenIdle();
    expect(model.opened).toBe(1);
    expect(pipeline.mayCapture(SLACK)).toEqual({allow: false, reason: "captureOff"});
  });

  it("persists only finished statements", async () => {
    const {pipeline, read, finish} = setup([GATE_YES, {evidence: [{target_id: "cp1", statement: CLEAN_CP}]}]);
    pipeline.signal("captureOn");
    read(SLACK); read(JIRA);
    await finish();
    const pool = pipeline.exportPool();
    expect(pool.map((i) => i.statement)).toEqual([CLEAN_CP]);
    const other = setup([]);
    expect(other.pipeline.importPool(pool)).toEqual({accepted: 1, rejected: 0});
    expect(other.pipeline.digest().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --dir app test src/core/pipeline.test.ts`
Expected: FAIL, `./index` not found.

- [ ] **Step 3: Implement**

`app/src/core/index.ts`:
```ts
import {z} from "zod";
import {createBuffer} from "./buffer";
import {buildSkillIndex, offeredFor, type SkillIndex} from "./candidates/index";
import {BUFFER_MAX_AGE_MS, EXTRACTION_QUEUE_MAX} from "./constants";
import {createCounters} from "./counters";
import {createDigest} from "./digest";
import {createExclusions, type Exclusions} from "./exclusions/index";
import {extract} from "./extraction/extract";
import {checkStatement} from "./guard/checks";
import {buildForbidden} from "./guard/forbidden";
import {compact} from "./scenarios/compact";
import {type ClosedSpan, createSegmenter} from "./scenarios/segmenter";
import {scrub} from "./scrub/scrub";
import type {CaptureDecision, ConfigResult, IngestOutcome, Pipeline, PipelineConfig, Ports, Scenario, SkipReason} from "./types";

export {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./exclusions/defaults";
export type * from "./types";

const taxonomyShape = z.object({
  taxonomyVersion: z.string().min(1),
  skills: z.array(z.object({id: z.string().min(1), displayName: z.string().min(1), canonicalName: z.string(), aliases: z.array(z.string())})),
  competencies: z.array(z.object({id: z.string().min(1), name: z.string().min(1), description: z.string()})),
  userNames: z.array(z.string())
});

/** Denials that mean "the user is somewhere we do not look", which can end a stretch of work. */
const AWAY_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>(["excludedApp", "excludedTitle", "privateWindow"]);

interface Active { config: PipelineConfig; exclusions: Exclusions; index: SkillIndex }

export function createPipeline(initial: PipelineConfig, ports: Ports): Pipeline {
  const {clock} = ports;
  const counters = createCounters();
  const buffer = createBuffer();
  const segmenter = createSegmenter();
  let active: Active | null = null;
  const digest = createDigest({clock, newId: ports.newId, counters, taxonomyVersion: () => active?.config.taxonomyVersion ?? ""});

  let on = false;
  let locked = false;
  let queue: Scenario[] = [];
  let running: Promise<void> | null = null;

  function configure(config: PipelineConfig): ConfigResult {
    const exclusions = createExclusions({exclusions: config?.exclusions, excludedSites: config?.excludedSites});
    const taxonomy = taxonomyShape.safeParse(config);
    const problems = [...exclusions.problems, ...(taxonomy.success ? [] : ["skills, competencies, user names or taxonomy version are malformed"])];
    if (problems.length > 0) { active = null; return {ok: false, problems}; }
    active = {config, exclusions, index: buildSkillIndex(config.skills)};
    return {ok: true};
  }

  const deny = (reason: SkipReason, counter: string): {reason: SkipReason} => { counters.inc(`${counter}.${reason}`); return {reason}; };

  /** Shared by mayCapture and ingest, so ingest never depends on the app having asked first. */
  function gate(front: {app: string; title: string}, counter: string): SkipReason | null {
    if (!on) return deny("captureOff", counter).reason;
    if (locked) return deny("locked", counter).reason;
    if (!active) return deny("rulesInvalid", counter).reason;
    const now = clock.now();
    segmenter.activity(now);
    const reason = active.exclusions.before(front);
    if (reason) {
      if (AWAY_REASONS.has(reason)) segmenter.captureAllowed(now, false);
      return deny(reason, counter).reason;
    }
    segmenter.captureAllowed(now, true);
    return null;
  }

  async function process(scenario: Scenario): Promise<void> {
    const current = active;
    try {
      if (!current) return;
      const offered = offeredFor(current.index, current.config.competencies, scenario);
      const outcome = await extract({scenario, offered, userNames: current.config.userNames, model: ports.model, counters});
      if (outcome.kind !== "statements") return;
      const skillById = new Map(current.config.skills.map((s) => [s.id, s]));
      const allowTerms = offered.flatMap((o) => {
        const skill = skillById.get(o.id);
        return skill ? [skill.displayName, skill.canonicalName, ...skill.aliases] : [o.name];
      });
      const forbidden = buildForbidden({scenario, userNames: current.config.userNames, allowTerms});
      const offeredIds = offered.map((o) => o.id);
      for (const draft of outcome.drafts) {
        const verdict = checkStatement({statement: draft.statement, targetId: draft.targetId, offeredIds, forbidden});
        if (verdict.ok) digest.add(draft);
        else counters.inc(`guard.discarded.check${verdict.check}`);
      }
    } catch {
      counters.inc("pipeline.processFailed");
    } finally {
      // The scenario's raw text is released as soon as extraction ends, whatever happened.
      scenario.text = "";
      scenario.blocks = [];
    }
  }

  function pump(): void {
    if (running || queue.length === 0) return;
    const next = queue.shift() as Scenario;
    running = process(next).finally(() => { running = null; pump(); });
  }

  function closeSpan(span: ClosedSpan): void {
    counters.inc(`scenarios.closed.${span.reason}`);
    const reads = buffer.range(span.openedAt, span.closedAt);
    buffer.dropRange(span.openedAt, span.closedAt);
    const scenario = compact(reads, {id: ports.newId(), openedAt: span.openedAt, closedAt: span.closedAt});
    if (!scenario) { counters.inc("scenarios.droppedThin"); return; }
    if (queue.length >= EXTRACTION_QUEUE_MAX) { queue.shift(); counters.inc("scenarios.droppedQueue"); }
    queue.push(scenario);
    pump();
  }

  configure(initial);

  return {
    configure,
    mayCapture(front): CaptureDecision {
      const reason = gate(front, "capture.denied");
      return reason ? {allow: false, reason} : {allow: true};
    },
    ingest(read): IngestOutcome {
      const reason = gate(read, "reads.skipped");
      if (reason) return {kept: false, reason};
      const after = (active as Active).exclusions.after(read, read.toolbarText);
      if (after) return {kept: false, ...deny(after, "reads.skipped")};

      let text: string;
      try { text = scrub(read.text).text; }
      catch { return {kept: false, ...deny("scrubFailed", "reads.skipped")}; }

      const now = clock.now();
      const result = buffer.accept({app: read.app, title: read.title, text, at: now});
      if (result !== "kept") return {kept: false, ...deny(result, "reads.skipped")};
      segmenter.kept(now);
      counters.inc("reads.kept");
      return {kept: true};
    },
    tick() {
      const now = clock.now();
      counters.inc("buffer.expired", buffer.expire(now));
      const span = segmenter.tick(now);
      if (span) closeSpan(span);
      const fresh = queue.filter((s) => now - s.openedAt <= BUFFER_MAX_AGE_MS);
      counters.inc("scenarios.droppedStale", queue.length - fresh.length);
      queue = fresh;
      digest.tick();
    },
    signal(s) {
      const now = clock.now();
      if (s === "captureOn") on = true;
      if (s === "locked") { locked = true; segmenter.locked(now); }
      if (s === "unlocked") { locked = false; segmenter.unlocked(now); }
      if (s === "captureOff") {
        on = false;
        const span = segmenter.off(now);
        if (span) closeSpan(span);
      }
    },
    digest: () => digest.list(),
    resolve(id, decision) { if (digest.resolve(id)) counters.inc(`statements.${decision}`); },
    counters: () => Object.fromEntries(Object.entries(counters.snapshot()).filter(([, value]) => value !== 0)),
    takeCounters() {
      const taken = Object.fromEntries(Object.entries(counters.snapshot()).filter(([, value]) => value !== 0));
      counters.reset();
      return taken;
    },
    exportPool: () => digest.exportPool(),
    importPool: (items) => digest.importPool(items),
    async whenIdle() { while (running || queue.length > 0) { pump(); await running; } }
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app test src/core/pipeline.test.ts`
Expected: PASS, including the LEAK TEST. If the leak test fails, fix the guard (Task 9). Do not weaken the test.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` and `pnpm --dir app typecheck` — Expected: PASS, no errors.

---

### Task 12: Evaluation set

**Files:**
- Create: `eval/README.md`, eight fixtures in `eval/fixtures/`
- Test: `app/src/core/eval.test.ts`

**Interfaces:**
- Consumes: `createPipeline`, `DEFAULT_EXCLUSIONS`, `DEFAULT_EXCLUDED_SITES` from `./index`; `createFakeModel` from `./testing/fakeModel`; `SCENARIO_IDLE_MS` from `./constants`.
- Produces: the fixture format below, which sub-project B reuses to run the same fixtures against the real model as a release gate.

Fixture format (every field is required unless marked optional):
- `name`, `category`: text.
- `userNames`, `skills`, `competencies`: passed to the pipeline configuration as they are.
- `reads`: in order. Each has `app`, `title`, `text`, optional `toolbarText`, optional `gapSeconds` (default 30).
- `model`: what the scripted fake model answers: `gate`, and `statements` (or `null` when the gate stops the run).
- `expect`: checked with the fake model.
  - `outcomes`: one entry per read: `"kept"` or the skip reason.
  - `modelCalls`: how many times the model was asked.
  - `modelMustNotSee`: strings that must not appear in anything sent to the model.
  - `digestTargets`: the target ids in the digest, sorted.
  - `mustNotAppear`: strings that must not appear in the digest, the exported pool or the counters.
- `expectReal`: for the real model, where the answer is not scripted: `digestMin`, `digestMax`, `allowedTargets`. `outcomes`, `modelMustNotSee` and `mustNotAppear` apply to the real model too.

This task ships one fixture per category named in the spec. The spec asks for about twenty: add the rest as regression fixtures, one for every wrong outcome found while tuning, which is how the set stays honest.

- [ ] **Step 1: Write the runner (it fails until fixtures exist)**

`app/src/core/eval.test.ts`:
```ts
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel} from "./testing/fakeModel";
import type {Competency, Skill} from "./types";

interface Fixture {
  name: string; category: string; userNames: string[]; skills: Skill[]; competencies: Competency[];
  reads: {app: string; title: string; text: string; toolbarText?: string; gapSeconds?: number}[];
  model: {gate: unknown; statements: unknown | null};
  expect: {outcomes: string[]; modelCalls: number; modelMustNotSee: string[]; digestTargets: string[]; mustNotAppear: string[]};
  expectReal: {digestMin: number; digestMax: number; allowedTargets: string[]};
}

const DIR = new URL("../../../eval/fixtures/", import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("evaluation set (scripted model)", () => {
  it("has a fixture for every category in the spec", () => {
    const categories = new Set(files.map((f) => (JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture).category));
    for (const c of ["work-english", "work-portuguese", "private", "mixed", "colleague", "names-everywhere", "secret-on-screen", "recognition-noise"]) {
      expect([...categories]).toContain(c);
    }
  });

  it.each(files)("%s", async (file) => {
    const fx = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture;
    let now = Date.UTC(2026, 8, 17, 9);
    let n = 0;
    const model = createFakeModel(fx.model.statements === null ? [fx.model.gate] : [fx.model.gate, fx.model.statements]);
    const pipeline = createPipeline({
      exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "eval",
      skills: fx.skills, competencies: fx.competencies, userNames: fx.userNames
    }, {model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`});
    pipeline.signal("captureOn");

    const outcomes = fx.reads.map((read) => {
      now += (read.gapSeconds ?? 30) * 1000;
      const decision = pipeline.mayCapture(read);
      if (!decision.allow) return decision.reason;
      const result = pipeline.ingest({...read, at: now});
      return result.kept ? "kept" : result.reason;
    });
    now += SCENARIO_IDLE_MS + 1_000;
    pipeline.tick();
    await pipeline.whenIdle();

    expect(outcomes).toEqual(fx.expect.outcomes);
    expect(model.calls.length).toBe(fx.expect.modelCalls);
    const sentToModel = JSON.stringify(model.calls.map((c) => [c.settings.systemPrompt, c.userText]));
    for (const secret of fx.expect.modelMustNotSee) expect(sentToModel).not.toContain(secret);
    expect(pipeline.digest().map((i) => i.targetId).sort()).toEqual(fx.expect.digestTargets);
    const couldLeave = JSON.stringify([pipeline.digest(), pipeline.exportPool(), pipeline.counters()]);
    for (const secret of fx.expect.mustNotAppear) expect(couldLeave).not.toContain(secret);
  });
});
```

Run: `pnpm --dir app test src/core/eval.test.ts`
Expected: FAIL (the fixtures folder does not exist yet).

- [ ] **Step 2: Write the fixtures**

`eval/fixtures/01-work-english.json`:
```json
{
  "name": "Debugging a latency regression across chat, editor and ticket",
  "category": "work-english",
  "userNames": ["Sardor Astanov"],
  "skills": [
    {"id": "pg", "displayName": "PostgreSQL", "canonicalName": "postgresql", "aliases": ["Postgres"]},
    {"id": "redis", "displayName": "Redis", "canonicalName": "redis", "aliases": []},
    {"id": "k8s", "displayName": "Kubernetes", "canonicalName": "kubernetes", "aliases": ["k8s"]}
  ],
  "competencies": [{"id": "cp-tradeoff", "name": "Tradeoff Analysis", "description": "Weighs options and commits to one with reasons"}],
  "reads": [
    {"app": "Slack", "title": "#backend-team — Acme Workspace", "text": "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after yesterday's deploy. Any idea what changed?\nSardor 10:44 I traced it to the orders query. We added a join on shipments without an index, so Postgres falls back to a sequential scan on 8 million rows.\nPriya Raman 10:45 Can we just add the index in production?\nSardor 10:47 Yes, but create it concurrently so we don't lock writes. I'd also cache the shipment status in Redis with a 30 second TTL.\nTomas Lindqvist 10:52 I set up the Kubernetes autoscaler last week, unrelated but fyi."},
    {"app": "Code", "title": "orderService.ts — checkout-api", "text": "export async function getOrderWithShipment(orderId: string) {\n  // cache shipment status for 30s to avoid the join on hot paths\n  const cached = await redis.get(cacheKey);\n  const row = await db.query(\"SELECT o.*, s.status FROM orders o LEFT JOIN shipments s ON s.order_id = o.id WHERE o.id = $1\", [orderId]);\n  await redis.set(cacheKey, row.status, { EX: 30 });\n}\n$ npm test -- orderService\nPASS src/orderService.test.ts  Tests: 12 passed, 12 total", "gapSeconds": 90},
    {"app": "Jira", "title": "PROJ-4821 Checkout latency regression", "text": "Assignee Sardor Astanov  Reporter Priya Raman  Status In Review\nRoot Cause: migration 0412 introduced a LEFT JOIN with no supporting index. p95 rose from 310 ms to 2400 ms.\nFix: added index concurrently, 30 second Redis cache, support dashboard routed to the read replica.", "gapSeconds": 120}
  ],
  "model": {
    "gate": {"activity_summary": "Diagnosed a latency regression, designed a fix and implemented it.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [
      {"target_id": "pg", "statement": "Diagnosed a latency regression as a sequential scan caused by a missing index and rebuilt it without blocking writes."},
      {"target_id": "redis", "statement": "Introduced a short-lived cache for a rarely changing value to remove an expensive join from hot request paths."},
      {"target_id": "cp-tradeoff", "statement": "Weighed stale reads against database load and chose different strategies for customer and support views."}
    ]}
  },
  "expect": {"outcomes": ["kept", "kept", "kept"], "modelCalls": 2, "modelMustNotSee": [], "digestTargets": ["cp-tradeoff", "pg", "redis"],
    "mustNotAppear": ["Priya", "Tomas", "Acme", "PROJ-4821", "orderService", "checkout-api", "2400"]},
  "expectReal": {"digestMin": 1, "digestMax": 5, "allowedTargets": ["pg", "redis", "cp-tradeoff"]}
}
```

`eval/fixtures/02-work-portuguese.json`:
```json
{
  "name": "Fixing a form bug, discussed in Portuguese",
  "category": "work-portuguese",
  "userNames": ["Rafael Souza"],
  "skills": [
    {"id": "react", "displayName": "React", "canonicalName": "react", "aliases": ["React.js"]},
    {"id": "ts", "displayName": "TypeScript", "canonicalName": "typescript", "aliases": []}
  ],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Slack", "title": "#frontend — Loja Verde", "text": "Camila Nunes 14:02 O formulário de cadastro está perdendo os dados quando o usuário volta uma etapa. Alguém sabe o motivo?\nRafael Souza 14:05 Achei, é um problema clássico de React. O estado de cada etapa fica em um useState local, então ao desmontar o componente os valores somem. Vou mover para um reducer no componente pai e manter os campos controlados.\nCamila Nunes 14:06 Boa. Isso resolve também o problema da validação?\nRafael Souza 14:09 Resolve. A validação roda no reducer, então o erro aparece antes de avançar. Vou escrever testes para entrada vazia e e-mail inválido."},
    {"app": "Code", "title": "CadastroForm.tsx — loja-web", "text": "const [state, dispatch] = useReducer(formReducer, initialState);\nuseEffect(() => { if (state.step === 2) validate(state.fields); }, [state.step]);\nfunction formReducer(state: FormState, action: FormAction): FormState {\n  switch (action.type) { case 'field': return { ...state, fields: { ...state.fields, [action.name]: action.value } }; }\n}\n// TypeScript: FormAction is a discriminated union so every case is checked", "gapSeconds": 120}
  ],
  "model": {
    "gate": {"activity_summary": "Diagnosed lost form state and moved it into a reducer with validation and tests.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [
      {"target_id": "react", "statement": "Diagnosed lost form state as component-local storage and moved it into a parent reducer with controlled fields."},
      {"target_id": "cp-problem", "statement": "Traced a data loss bug to its cause and designed a fix that also resolved a related validation problem."}
    ]}
  },
  "expect": {"outcomes": ["kept", "kept"], "modelCalls": 2, "modelMustNotSee": [], "digestTargets": ["cp-problem", "react"],
    "mustNotAppear": ["Camila", "Nunes", "Rafael", "Loja Verde", "CadastroForm", "loja-web"]},
  "expectReal": {"digestMin": 1, "digestMax": 4, "allowedTargets": ["react", "ts", "cp-problem"]}
}
```

`eval/fixtures/03-private.json`:
```json
{
  "name": "Personal chat, a video and shopping",
  "category": "private",
  "userNames": ["Sardor Astanov"],
  "skills": [{"id": "pg", "displayName": "PostgreSQL", "canonicalName": "postgresql", "aliases": ["Postgres"]}],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Telegram", "title": "Madina", "text": "Madina 19:02 did you pick up the cake for mom's birthday?\nSardor 19:03 yes, chocolate one. also booked the restaurant for 8\nMadina 19:03 love you\nSardor 19:04 love you too, home in 30"},
    {"app": "Google Chrome", "title": "Top 10 Goals of the Week - YouTube", "text": "Top 10 Goals of the Week\n1.2M views  Subscribe  Comments 4,312\nUp next: Best saves of the season, Funniest moments, Full match highlights, Press conference reactions\nShow more  Sort by  Top comments  Newest first  Add a comment  Like  Dislike  Share  Download  Clip  Save\nAutoplay is on  Live chat replay is off  Transcript  Report", "toolbarText": "youtube.com/watch?v=abc123"},
    {"app": "Google Chrome", "title": "Shopping Cart", "text": "Shopping Cart\nWireless earbuds  $49.99  Qty 1  Delete  Save for later  Compare with similar items\nSubtotal (1 item): $49.99  Proceed to checkout  This order contains a gift\nCustomers who bought this item also bought  Frequently bought together  Recently viewed items\nYour items  Buy it again  Sponsored products related to this item", "toolbarText": "shop.example.com/cart"}
  ],
  "model": {"gate": {"activity_summary": "Watching a video and shopping online.", "is_professional": false, "user_demonstrated_something": false}, "statements": null},
  "expect": {"outcomes": ["excludedApp", "kept", "kept"], "modelCalls": 1, "modelMustNotSee": ["Madina", "birthday", "love you"], "digestTargets": [], "mustNotAppear": ["Madina", "earbuds"]},
  "expectReal": {"digestMin": 0, "digestMax": 0, "allowedTargets": []}
}
```

`eval/fixtures/04-mixed.json`:
```json
{
  "name": "Work interrupted by a banking tab and a private window",
  "category": "mixed",
  "userNames": ["Sardor Astanov"],
  "skills": [{"id": "docker", "displayName": "Docker", "canonicalName": "docker", "aliases": []}],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Code", "title": "docker-compose.yml — platform", "text": "services:\n  api:\n    build: ./api\n    depends_on: [db]\n    healthcheck:\n      test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:8080/health\"]\n      interval: 10s\n  db:\n    image: postgres:16\n# Docker: the api container started before the database accepted connections, so added a healthcheck and a depends_on condition\n# verified with docker compose up --wait and a cold start"},
    {"app": "Google Chrome", "title": "Accounts", "text": "Checking account ending 4410  Available balance $3,210.55  Recent transactions  Transfer money  Pay bills  Statements and documents  Card controls  Alerts  Profile and settings  Sign out", "toolbarText": "https://secure.chase.com/web/auth/dashboard"},
    {"app": "Google Chrome", "title": "Example Domain", "text": "Some page the user chose to open privately, with enough words on it to be kept if it were not private at all.", "toolbarText": "example.com   Incognito"},
    {"app": "Terminal", "title": "zsh — platform", "text": "$ docker compose up --wait\n[+] Running 2/2\n Container platform-db-1   Healthy\n Container platform-api-1  Healthy\n$ docker compose logs api | tail -3\napi listening on 8080\nconnected to database\nready", "gapSeconds": 60}
  ],
  "model": {
    "gate": {"activity_summary": "Fixed a container start-order problem.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [{"target_id": "docker", "statement": "Resolved a container start-order failure by adding a health check and a readiness condition, then verified a cold start."}]}
  },
  "expect": {"outcomes": ["kept", "excludedSite", "privateWindow", "kept"], "modelCalls": 2, "modelMustNotSee": ["balance", "4410", "3,210", "chose to open privately"], "digestTargets": ["docker"], "mustNotAppear": ["chase", "4410"]},
  "expectReal": {"digestMin": 0, "digestMax": 3, "allowedTargets": ["docker", "cp-problem"]}
}
```

`eval/fixtures/05-colleague.json`:
```json
{
  "name": "A colleague describes their own achievement; the user only reacts",
  "category": "colleague",
  "userNames": ["Sardor Astanov"],
  "skills": [{"id": "k8s", "displayName": "Kubernetes", "canonicalName": "kubernetes", "aliases": ["k8s"]}],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Slack", "title": "#platform — Acme Workspace", "text": "Tomas Lindqvist 16:20 Finished the Kubernetes migration. I moved every service to the new cluster, wrote the autoscaling policies, and cut node costs by a third by right-sizing the pools. The tricky part was draining stateful workloads without downtime, which I solved with a staged rollout and pod disruption budgets.\nSardor 16:24 nice work, congrats\nTomas Lindqvist 16:25 thanks! writeup is in the wiki if anyone wants the details\nSardor 16:26 will read it tomorrow"}
  ],
  "model": {"gate": {"activity_summary": "Read a colleague's update about a migration and congratulated them.", "is_professional": true, "user_demonstrated_something": false}, "statements": null},
  "expect": {"outcomes": ["kept"], "modelCalls": 1, "modelMustNotSee": [], "digestTargets": [], "mustNotAppear": ["Tomas", "Lindqvist"]},
  "expectReal": {"digestMin": 0, "digestMax": 0, "allowedTargets": []}
}
```

`eval/fixtures/06-names-everywhere.json`:
```json
{
  "name": "The model leaks a name, the client, a ticket and a figure; only the clean statement survives",
  "category": "names-everywhere",
  "userNames": ["Sardor Astanov"],
  "skills": [{"id": "figma", "displayName": "Figma", "canonicalName": "figma", "aliases": []}],
  "competencies": [{"id": "cp-comm", "name": "Clear Communication", "description": "Explains a hard idea plainly"}],
  "reads": [
    {"app": "Microsoft Teams", "title": "Design review | Northwind Traders", "text": "Helena Brandt 11:02 Can you walk us through why the onboarding has 7 screens? Marketing at Northwind wants it down to 3.\nSardor 11:05 Sure. In Figma I mapped every field to the step where we first need it. 4 of the 7 screens only exist because billing details are asked up front. If we defer billing until the first invoice, the flow drops to 3 screens and nothing is lost.\nHelena Brandt 11:07 That is much clearer than the deck. Oskar, can you check with finance?\nOskar Lind 11:08 Will do, ticket DSN-208 is tracking it.\nSardor 11:10 I will post the revised prototype with 3 variants and the drop-off numbers, 41 percent on screen 5."}
  ],
  "model": {
    "gate": {"activity_summary": "Explained a design decision and proposed a shorter flow.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [
      {"target_id": "cp-comm", "statement": "Explained to Helena why the onboarding flow was long and how deferring billing would shorten it."},
      {"target_id": "figma", "statement": "Mapped every onboarding field for Northwind to the step that first needs it and proposed a shorter flow."},
      {"target_id": "figma", "statement": "Tracked the redesign under DSN-208 and prepared revised prototype variants for a follow-up design review."},
      {"target_id": "cp-comm", "statement": "Presented drop-off of forty one percent on one screen to justify deferring billing details in the flow."},
      {"target_id": "cp-comm", "statement": "Explained a long onboarding flow by mapping each field to where it was first needed and proposed a shorter one."}
    ]}
  },
  "expect": {"outcomes": ["kept"], "modelCalls": 2, "modelMustNotSee": [], "digestTargets": ["cp-comm"],
    "mustNotAppear": ["Helena", "Brandt", "Oskar", "Northwind", "DSN-208", "forty one"]},
  "expectReal": {"digestMin": 0, "digestMax": 4, "allowedTargets": ["figma", "cp-comm"]}
}
```

`eval/fixtures/07-secret-on-screen.json`:
```json
{
  "name": "Credentials visible in a terminal and an env file",
  "category": "secret-on-screen",
  "userNames": ["Sardor Astanov"],
  "skills": [{"id": "aws", "displayName": "AWS", "canonicalName": "aws", "aliases": ["Amazon Web Services"]}],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Code", "title": ".env.production — deploy-tools", "text": "# rotated after the incident, never commit this file\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://deployer:Sup3rS3cretPass@db.internal.example.com:5432/orders\nSTRIPE_KEY=sk_live_51AbCdEfGhIjKlMnOpQrStUv\nSUPPORT_EMAIL=oncall@example.com\n# AWS: moved these into the secrets manager and switched the deploy script to read them at runtime"},
    {"app": "Terminal", "title": "zsh — deploy-tools", "text": "$ aws secretsmanager create-secret --name prod/orders/db --secret-string file://db.json\n{ \"Name\": \"prod/orders/db\" }\n$ ./deploy.sh --env production --dry-run\nreading secrets from AWS Secrets Manager\nall 4 secrets resolved, no plaintext credentials in the environment\n$ git rm --cached .env.production && echo .env.production >> .gitignore", "gapSeconds": 90}
  ],
  "model": {
    "gate": {"activity_summary": "Moved plaintext credentials into a secrets manager.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [{"target_id": "aws", "statement": "Moved plaintext credentials into a managed secrets store and changed a deploy script to read them at runtime."}]}
  },
  "expect": {"outcomes": ["kept", "kept"], "modelCalls": 2,
    "modelMustNotSee": ["AKIAIOSFODNN7EXAMPLE", "Sup3rS3cretPass", "sk_live_51AbCdEfGhIjKlMnOpQrStUv", "oncall@example.com"],
    "digestTargets": ["aws"], "mustNotAppear": ["AKIA", "Sup3r", "sk_live", "deploy-tools"]},
  "expectReal": {"digestMin": 0, "digestMax": 3, "allowedTargets": ["aws", "cp-problem"]}
}
```

`eval/fixtures/08-recognition-noise.json`:
```json
{
  "name": "Text recognition errors and a line-number gutter",
  "category": "recognition-noise",
  "userNames": ["Sardor Astanov"],
  "skills": [
    {"id": "py", "displayName": "Python", "canonicalName": "python", "aliases": []},
    {"id": "pandas", "displayName": "pandas", "canonicalName": "pandas", "aliases": []}
  ],
  "competencies": [{"id": "cp-problem", "name": "Problem Solving", "description": "Breaks a problem down and resolves it"}],
  "reads": [
    {"app": "Code", "title": "clean_orders.py — analytics", "text": "1 2 3 4 5 6 7 8 9\nimp0rt pandas as pd\ndf = pd.read_csv('orders.csv', parse_dates=['created_at'])\n# Python: duplicated rows came from a retry in the exporter, so drop on the natural key instead of the full row\ndf = df.drop_duplicates(subset=['order_id', 'line_no'], keep='last')\ndf['total'] = df['qty'] * df['unit_price']\nassert df['total'].ge(0).all(), 'negative totals mean refunds leaked into sales'\nprint(df.groupby('region')['total'].sum().sort_values(ascending=False).head())"},
    {"app": "Terminal", "title": "zsh — analytics", "text": "$ python clean_orders.py\nregion\nnorth    l8420.50\nsouth    17210.00\nwest      9l05.25\n$ pytest tests/test_clean_orders.py -q\n....                                                                  [100%]\n4 passed in 0.62s", "gapSeconds": 60}
  ],
  "model": {
    "gate": {"activity_summary": "Cleaned an orders dataset and verified it with tests.", "is_professional": true, "user_demonstrated_something": true},
    "statements": {"evidence": [{"target_id": "pandas", "statement": "Traced duplicated rows to a retrying exporter and removed them on the natural key, then verified totals with tests."}]}
  },
  "expect": {"outcomes": ["kept", "kept"], "modelCalls": 2, "modelMustNotSee": [], "digestTargets": ["pandas"], "mustNotAppear": ["clean_orders", "17210"]},
  "expectReal": {"digestMin": 0, "digestMax": 3, "allowedTargets": ["py", "pandas", "cp-problem"]}
}
```

`eval/README.md`:
```md
# Evaluation set

Realistic stretches of activity with the outcome we expect. The fixtures are the contract for
"does the pipeline still behave?" and, later, the seed of a fine-tuning dataset.

Two ways to run them:

1. With the scripted fake model, on every change: `pnpm --dir app test src/core/eval.test.ts`.
   This checks everything the core decides: which reads are kept, what the model is allowed to
   see, what the guard lets through, and that nothing listed under mustNotAppear can leave.
2. With the real pinned model, as a release gate. The desktop app sub-project adds that runner.
   It ignores the "model" block and checks "expectReal" together with "outcomes",
   "modelMustNotSee" and "mustNotAppear".

Adding a fixture: copy the closest one, change the reads, write the expectation first, run it.
Add one for every wrong outcome found while tuning. All people, companies and credentials in
fixtures are invented. Never paste real screen text into this folder.
```

- [ ] **Step 3: Run the evaluation set**

Run: `pnpm --dir app test src/core/eval.test.ts`
Expected: PASS, nine tests (the category check plus eight fixtures).

- [ ] **Step 4: Final checkpoint for the whole plan**

Run: `pnpm --dir app test` — Expected: every test passes.
Run: `pnpm --dir app typecheck` — Expected: no errors.
Then confirm by hand: `app/src/core/` contains no import of `fs`, `net`, `http`, `child_process` or `electron` outside `*.test.ts` files (the Task 1 test enforces it), and no file under `eval/` contains real names or credentials.

---

## Verification record

The code in this plan is not hypothetical. On 2026-09-17 every file block above was extracted
from this document into a scratch folder and run as written:

- **164 tests passed, 0 failed** across 16 test files (Bun 1.4.2 as the runner, with `vitest`
  imports mapped to Bun's compatible API, Zod 4.4.3).
- **Strict type check clean** on all 28 non-test source files (TypeScript 6.0.3, `strict` and
  `noUncheckedIndexedAccess`).
- The leak test and all eight evaluation fixtures pass.

What this does **not** prove: that the pinned toolchain (`typescript@7.0.2`, `vitest@5.0.1`,
`zod@4.6.5`) behaves identically. Those versions were never installed. If a step fails only
because of a tool version, adjust the call shape or the config, never the behaviour under test.

Two mistakes were caught by running the plan, and are already fixed above:
1. A pipeline test assumed the digest keeps insertion order. It ranks by specificity.
2. The Portuguese fixture never named its framework, so the skill was never offered and the
   scripted answer was rejected. That is the known limit of name matching, working as designed.

## Deviations from the first approved spec

Each was made for a reason found while writing or running the code. The spec file has been
amended to match, and says so in its status line.

| Area | First spec | Plan and amended spec | Why |
|---|---|---|---|
| Exclusion rules | `App` matches app or title | Adds `App::` = app only; built-ins match the exact app name | "Dock" excluded Docker; "Messages" excluded Slack's "Direct messages" |
| Ambiguous skill names | Signal could be another skill of the same category | Built-in hint table per name | The configuration has no skill categories |
| Phone numbers | Separators were enough | Needs a country code, parentheses or a preceding label | `4821-0412-7788` is a reference number |
| Person names | Any run of capitalised words | Chat speakers, labelled names, mentions, mid-line proper nouns | Headings like "Root Cause" would have been forbidden |
| English check | ASCII share plus stop-words | Two English function words | Simpler; the ASCII share added nothing |
| Counters | "Reset daily" | `takeCounters()` returns and resets | A silent midnight reset loses the day's numbers |
| Import guard | Lint rule and a test | A test only | No linter is set up in this sub-project |
| Evaluation set | About twenty fixtures | Eight, one per category, growing by regression | A fixture is worth most when it records a real failure |

## After this plan

Sub-project B (desktop app) consumes `createPipeline` and supplies the real `ModelPort` using the
settings proven in spike S1. It also adds the real-model runner for `eval/`. Sub-project C (the
native reader) supplies `WindowRead` values, including `toolbarText` for browsers.

## Post-execution fixes (2026-09-17)

The plan was executed as written (164 tests), then owner-approved fixes from the final review were
applied: C1, C2, I1 to I5 and a time-box on `model.open()`. The suite is now 257 tests. These files no
longer match the code blocks above: `constants.ts`, `index.ts`, `extraction/extract.ts`,
`extraction/extract.test.ts`, `guard/checks.ts`, `guard/forbidden.ts`, `guard/numbers.ts`,
`guard/guard.test.ts`, `scrub/patterns.ts`, `scrub/scrub.test.ts`, `pipeline.test.ts`,
`eval/fixtures/08-recognition-noise.json`; `guard/genericParts.ts` is new. Do not re-extract those
blocks over the code. What changed and why:
`docs/superpowers/reviews/2026-09-17-core-pipeline-final-review.md`.
