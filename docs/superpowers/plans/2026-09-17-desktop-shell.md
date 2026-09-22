# Desktop Shell (sub-project B, plan B-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the headless engine of plan B-1 into a running macOS tray app: owner-stamped settings, a typed IPC contract, the real model host, the Electron shell, and the four screens, proven by an in-app smoke test and a real-model evaluation gate.

**Architecture:** Electron-free logic stays in `app/src/main/` and is tested with vitest (IPC router, download adapters, model host core, release gate). `app/src/shell/` is the only folder that imports `electron`; it is a thin composition around `createEngine`. The renderer (`app/src/renderer/`) is a sandboxed React page that can reach main only through `window.clave` (the `ClaveBridge` in `app/src/shared/ipc.ts`); its decisions live in pure, tested view-model functions and its look is built with the `frontend-design` skill. esbuild bundles the four programs; there is no Vite.

**Tech Stack:** Electron 44.4.1, node-llama-cpp 3.21.1, esbuild 0.28.2, React 19.2, TypeScript 7.0.2, Vitest 5.0.1, Zod 4.6.5, pnpm 11. macOS first.

**Spec:** `docs/superpowers/specs/2026-09-17-desktop-app-design.md` (sections 2, 5, 7, 9). Also read `docs/superpowers/reviews/2026-09-17-desktop-engine-review.md`: Task 2 closes its open items 1 to 4.

## Global Constraints

- **No git operations.** Not a git repository; the owner forbids init, commit, branch or push unless he asks. "Commit" means **Checkpoint**: full suite, typecheck, stop on red.
- Run every command from the repository root `/Users/sardorastanov/techcells/asset-to-evidence` as `pnpm --dir app <script>`. Never `cd`.
- **Installs:** Task 1 installs exactly `electron`, `node-llama-cpp`, `esbuild`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, and only after the owner has approved it for this execution. Nothing else, ever. If a pinned version does not exist, use the nearest published version of the same package and record it in `app/README.md`.
- **Copy, never retype, plan code.** Use a script that copies the fenced blocks byte for byte (the B-1 run used `apply_task.py`; adapt it to this file). After every task run `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md <task>`; it must end with `mismatches: 0`. "Replace this / with this" edits must each match exactly once.
- **Verified code:** Tasks 2 to 7 were built and run before this plan was written (see "Verification record"). If a step fails, check the transcription first; if it still fails, stop and report. Never change behaviour or weaken a test to get green. Tool-version friction (Electron or esbuild flags, pnpm build-script approval) may be fixed in config and must be recorded in `app/README.md`.
- Only `app/src/shell/` may import `electron`. Production files in `app/src/main/` still must not import `standins/`, `testing/`, `electron` or `vitest`, and never call `console.*`. The renderer reaches `main/`, `core/`, `shell/` and `standins/` through `import type` only, and loads nothing remote (fonts and images are bundled).
- Nothing read from a screen may appear in any error, log line, status, IPC message, notification or file other than the encrypted pool and outbox and the plain sent log. Errors are fixed codes.
- The renderer is untrusted input: every IPC argument is validated in `ipcRouter.ts` before it reaches the engine, and only our own window's local page may call in.
- The stand-ins (`devReader`, `stubApi`, scripted model, ready downloader, smoke cipher) only run when `CLAVE_STANDINS=1` and the app is not packaged. `createEngine` refuses stand-ins in production.
- All user-facing text lives in `app/src/renderer/copy.ts`. The five claims are verbatim from `docs/implementation-plan.md`; a test enforces it.
- Thresholds of the app live in `app/src/main/constants.ts` (shell-only values such as `BATTERY_POLL_MS` live next to their use in `shell/`).

## File Structure

```
app/
  package.json                 adds main, scripts (build, start, smoke, eval:gate) and the new packages
  tsconfig.renderer.json       DOM + JSX for the renderer only
  scripts/build.mjs            esbuild: main.cjs, preload.cjs, model-host.mjs, eval-gate.mjs, renderer/
  src/
    shared/ipc.ts              ClaveBridge, channel lists: the whole renderer<->main surface
    main/
      ipcRouter.ts             validates and routes every request; pure
      ipc.leak.test.ts         nothing from the screen crosses to the renderer
      engine.owner.test.ts     settings belong to one account; per-file storage problems
      model/nodeDownload.ts    fetch + fs + crypto behind the downloader
      model/hostCore.ts        the model host's behaviour, without a process
      model/llamaBinding.ts    node-llama-cpp with the spike S1 settings
      model/inProcessLink.ts   HostLink without a process (evaluation gate only)
    eval/gate.ts, gateCli.ts   the release gate for the real model
    shell/                     the only folder that imports electron
      adapters.ts              safeStorage -> Cipher, powerMonitor -> PowerSource, utilityProcess -> HostLink
      batteryLevel.ts          pmset -> battery level (Electron has none in main)
      modelHostEntry.ts        utility-process entry
      preload.ts               exposes window.clave, nothing else
      app.ts                   composition: single instance, tray, window, engine, IPC, notifications
      smoke.ts                 the in-app end-to-end smoke run
    renderer/
      index.html, main.tsx     entry (Task 1 placeholder, replaced in Task 8)
      copy.ts                  every sentence the user can read
      model/views.ts           pure view-model: onboarding step, screens, download, review rows
      ...                      the four screens (Task 8, frontend-design skill)
    standins/                  + scriptedBinding.ts, readyDownloader.ts, smokeCipher.ts
docs/WHAT-LEAVES.md            the page the app links to
```

---

### Task 1: Packages, build tooling and the page the app links to

**This task downloads packages. Do not start it without the owner's approval for this execution.**

**Files:**
- Modify (replace the whole file): `app/package.json`
- Create: `app/tsconfig.renderer.json`, `app/scripts/build.mjs`, `app/src/renderer/index.html`, `app/src/renderer/main.tsx` (a placeholder that Task 8 replaces), `docs/WHAT-LEAVES.md`

**Interfaces:**
- Consumes: nothing.
- Produces: scripts `build`, `start`, `start:scripted`, `smoke`, `eval:gate`; `typecheck` now also checks the renderer with DOM types; `dist/` layout: `main.cjs`, `preload.cjs`, `model-host.mjs`, `eval-gate.mjs`, `renderer/index.html`, `renderer/main.js`, `standins-taxonomy.json`, `WHAT-LEAVES.md`. The build entry points `src/shell/*.ts` and `src/eval/gateCli.ts` arrive in Tasks 5 and 6, so **`pnpm --dir app build` is first expected to work at the end of Task 6.**

- [ ] **Step 1: Write the files**

`app/package.json`:
```json
{
  "name": "clave-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.cjs",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.renderer.json",
    "build": "node scripts/build.mjs",
    "start": "node scripts/build.mjs && CLAVE_STANDINS=1 electron .",
    "start:scripted": "node scripts/build.mjs && CLAVE_STANDINS=1 CLAVE_SCRIPTED_MODEL=1 electron .",
    "smoke": "node scripts/build.mjs && CLAVE_STANDINS=1 CLAVE_SCRIPTED_MODEL=1 CLAVE_SMOKE=1 CLAVE_DATA_DIR=\"$(mktemp -d)\" electron .",
    "eval:gate": "node scripts/build.mjs && node dist/eval-gate.mjs"
  },
  "dependencies": {
    "node-llama-cpp": "3.21.1",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "22.20.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.3",
    "electron": "44.4.1",
    "esbuild": "0.28.2",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

`app/tsconfig.renderer.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": []
  },
  "include": ["src/renderer/**/*.ts", "src/renderer/**/*.tsx", "src/shared/**/*.ts"],
  "exclude": ["src/renderer/**/*.test.ts"]
}
```

`app/scripts/build.mjs`:
```js
// Bundles the four programs of the desktop app with esbuild. Run from the repo root: pnpm --dir app build
import {build} from "esbuild";
import {cpSync, existsSync, mkdirSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "dist");
rmSync(out, {recursive: true, force: true});
mkdirSync(join(out, "renderer"), {recursive: true});

const node = {bundle: true, platform: "node", target: "node22", sourcemap: false, logLevel: "warning"};
await Promise.all([
  // Main process. CommonJS, so `__dirname` exists. Electron is provided by the runtime.
  build({...node, entryPoints: [join(app, "src/shell/app.ts")], format: "cjs", outfile: join(out, "main.cjs"), external: ["electron"]}),
  // A sandboxed preload must be CommonJS.
  build({...node, entryPoints: [join(app, "src/shell/preload.ts")], format: "cjs", outfile: join(out, "preload.cjs"), external: ["electron"]}),
  // The model host. node-llama-cpp is ESM with native binaries: never bundled.
  build({...node, entryPoints: [join(app, "src/shell/modelHostEntry.ts")], format: "esm", outfile: join(out, "model-host.mjs"), external: ["electron", "node-llama-cpp"]}),
  // The release gate for the real model (a plain Node command, no Electron).
  build({...node, entryPoints: [join(app, "src/eval/gateCli.ts")], format: "esm", outfile: join(out, "eval-gate.mjs"), external: ["node-llama-cpp"]}),
  // The renderer: a browser bundle. No Node, no Electron, nothing remote.
  build({bundle: true, platform: "browser", target: "chrome130", format: "iife", logLevel: "warning", jsx: "automatic",
    entryPoints: [join(app, "src/renderer/main.tsx")], outfile: join(out, "renderer/main.js"),
    loader: {".woff2": "file", ".svg": "file", ".png": "file"}, assetNames: "assets/[name]-[hash]"})
]);
cpSync(join(app, "src/renderer/index.html"), join(out, "renderer/index.html"));
cpSync(join(app, "src/standins/taxonomy.json"), join(out, "standins-taxonomy.json"));
const whatLeaves = join(app, "..", "docs", "WHAT-LEAVES.md");
if (existsSync(whatLeaves)) cpSync(whatLeaves, join(out, "WHAT-LEAVES.md"));
console.log("built", out);
```

`app/src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:" />
    <title>Clave Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="./main.js"></script>
  </body>
</html>
```

`app/src/renderer/main.tsx`:
```tsx
// Placeholder entry so the shell can be built and smoke-tested before the UI exists (Task 7 replaces it).
const root = document.getElementById("root");
if (root) root.textContent = "Clave Agent";
export {};
```

`docs/WHAT-LEAVES.md`:
```md
# What leaves this machine

Clave Agent reads the text on your screen to find evidence of your skills. This page says exactly
what it keeps, what it sends, and what it never does. It is written to be checked: run the app with
your Wi-Fi off, or watch its network traffic, and compare.

## The five promises

1. You switch it on and off yourself. It never runs unless you started it.
2. It reads the text on your screen. Anything it captures to do that is deleted within seconds.
   Nothing older than an hour exists anywhere, and nothing is stored on disk.
3. It never looks at the apps and sites you exclude, or at private browser windows it can recognise.
4. Nothing reaches your profile until you read it and say yes. It names no one else.
5. It works with your Wi-Fi off. Only the short statements you approve ever leave.

## What is sent, and when

| What | When | To |
|---|---|---|
| Your email or handle and your password | when you sign in (the password is never stored) | Clave |
| A request for the public list of skills | at sign-in, then at most once a day | Clave |
| Each statement you approved: its text, the skill or competency it is about, when it was written, and version numbers | after you press Approve | Clave |
| The model file download (about 2.7 GB, one time) | during set-up | the model host |

Nothing else. No screenshots, no screen text, no window titles, no app names, no file names, no
rejected statements, no usage data. The "Sent" list in the app shows every statement that left.

## What is kept on this machine

- In memory only, for at most sixty minutes: the text that was read, already stripped of passwords,
  keys, emails, card and phone numbers. It is gone when you quit.
- On disk, encrypted with your Keychain: your sign-in token, the statements waiting for your
  answer, and approved statements that have not been uploaded yet.
- On disk, readable: your settings, the public list of skills, the list of what was sent, the model
  file, and a log that can only hold fixed codes and numbers, never text.
- "Delete all local data" in Settings removes all of it.

## What the automatic check cannot do

Before you see a statement, the app discards any that contains a name, company, product, file,
address, ticket number or figure that was on your screen. It cannot recognise:

- a confidential fact that is phrased in ordinary words;
- a name written entirely in capital letters.

That is why nothing leaves until you have read it and said yes.
```

- [ ] **Step 2: Install**

Run: `pnpm --dir app install`
Expected: finishes without errors. pnpm may report that build scripts were not run. Two packages matter:
- Electron downloads its binary in a post-install script. If `app/node_modules/electron/dist` does not exist afterwards, run `node app/node_modules/electron/install.js` (spike S1 needed exactly this).
- node-llama-cpp ships a prebuilt `@node-llama-cpp/mac-arm64-metal` binary as an optional dependency and works without its post-install script (spike S1). Do not build it from source.
Record anything you had to do in `app/README.md`.

- [ ] **Step 3: Checkpoint**

Run: `pnpm --dir app test` — Expected: 545 tests pass (unchanged: this task adds no tests).
Run: `pnpm --dir app typecheck` — Expected: no errors, for both configs.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 1` — Expected: `mismatches: 0`.

---

### Task 2: Engine follow-ups: settings belong to one account

Closes the open items of the engine review: settings are owner-stamped and reset durably for another account (even when the pool file is gone); a discarded outbox is logged; storage problems are tracked per file, so one file's success cannot clear another's problem; the capture loop ignores focus callbacks while it is not running.

**Files:**
- Modify: `app/src/main/settings.ts`, `app/src/main/log.ts`, `app/src/main/review/uploader.ts`, `app/src/main/capture/loop.ts`, `app/src/main/engine.ts`
- Test (new): `app/src/main/engine.owner.test.ts`

**Interfaces:**
- Consumes: the engine of plan B-1 as it stands after its fix rounds.
- Produces: `Settings.ownerUserId: string | null` (files without it are adopted by the next account to sign in); log codes `OUTBOX_DISCARDED` and `SETTINGS_RESET_FOR_NEW_OWNER`; `Uploader.adoptOwner(userId): Promise<number>` (how many of another account's statements were discarded) and `Uploader.resave(): Promise<void>`; inside the engine `ensureSettingsOwner()` and `adoptOutbox()`, called at start-up, at sign-in and retried on the tick; blocker `STORAGE_PROBLEM` is raised per file (`pool`, `outbox`, `settings`) and also while the settings still belong to another account.

- [ ] **Step 1: Write the failing tests**

`app/src/main/engine.owner.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PIPELINE_TICK_MS} from "./constants";
import type {Engine} from "./engine";
import {createHarness, type Harness} from "./testing/harness";

const GATE_YES = {activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true};
const SELF_TEST = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

async function ready(h: Harness, user = "sardor"): Promise<Engine> {
  const engine = await h.launch();
  await engine.signIn(user, "correct");
  h.client.script.push(GATE_YES, SELF_TEST);
  expect(await engine.selfTest()).toEqual({ok: true});
  return engine;
}
const stored = (h: Harness) => JSON.parse(h.fs.text("/data/settings.json") as string) as {ownerUserId: string | null; excludedSites: string[]; captureOn: boolean};
const logCodes = (h: Harness) => (h.fs.text("/data/app.log") ?? "").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as {code: string}).code);

describe("engine: settings belong to one account", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("stamps the settings with the first account that signs in", async () => {
    const h = createHarness();
    const engine = await ready(h);
    expect(stored(h).ownerUserId).toBe("user:sardor");
    await engine.quit();
  });

  it("another account never inherits exclusions or the capture switch, even when the pool file is gone", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"], reviewTime: "08:15"});
    await first.setCapture(true);
    await first.quit();
    await h.fs.remove("/data/pool.bin");                 // what a corrupt pool file, deleted by design, leaves behind
    await h.fs.remove("/data/session.bin");              // signed out at the next launch

    const second = await h.launch();
    await second.signIn("bea", "correct");
    expect(second.settings().excludedSites).not.toContain("bank.example");
    expect(second.settings().reviewTime).toBe("17:30");
    expect(second.settings().captureOn).toBe(false);
    expect(second.status().capture).toBe("off");
    expect(stored(h).ownerUserId).toBe("user:bea");
    const reads = h.reader.reads;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 5);
    expect(h.reader.reads).toBe(reads);
    await second.quit();
  });

  it("also at launch: a stored session of another account than the settings' owner resets them before anything is read", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.quit();
    const settings = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify({...settings, ownerUserId: "user:someone-before"})));

    const reads = h.reader.reads;
    const second = await h.launch();
    expect(second.settings().excludedSites).not.toContain("bank.example");
    expect(second.status().capture).toBe("off");
    expect(h.reader.reads).toBe(reads);
    await second.quit();
  });

  it("the same account keeps its settings across sign-out, sign-in and a restart", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.signOut();
    await first.signIn("sardor", "correct");
    expect(first.settings().excludedSites).toContain("bank.example");
    await first.quit();
    const second = await h.launch();
    expect(second.settings().excludedSites).toContain("bank.example");
    await second.quit();
  });

  it("a reset that the disk refuses blocks capture, is retried on the tick, and clears by itself", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.setCapture(true);
    await first.signOut();

    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let settingsBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (settingsBroken && path.endsWith("settings.json")) throw new Error("EIO"); return realWrite(path, data); };
    await first.signIn("bea", "correct");
    expect(first.status().blockers).toContain("STORAGE_PROBLEM");
    expect(first.status().capture).toBe("off");
    expect(await first.setCapture(true)).toMatchObject({ok: false});

    settingsBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(first.status().blockers).not.toContain("STORAGE_PROBLEM");
    expect(first.settings().excludedSites).not.toContain("bank.example");
    expect(stored(h).ownerUserId).toBe("user:bea");
    expect(first.status().capture).toBe("off");          // and capture does not start by itself for the new account
    await first.quit();
  });

  it("an old settings file without an owner is adopted, not reset", async () => {
    const h = createHarness();
    const first = await ready(h);
    await first.updateSettings({excludedSites: ["bank.example"]});
    await first.quit();
    const {ownerUserId: _dropped, ...legacy} = stored(h);
    h.fs.files.set("/data/settings.json", new TextEncoder().encode(JSON.stringify(legacy)));
    const second = await h.launch();
    expect(second.settings().excludedSites).toContain("bank.example");
    expect(second.status().blockers).not.toContain("SETTINGS_NEED_REVIEW");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(stored(h).ownerUserId).toBe("user:sardor");
    await second.quit();
  });
});

describe("engine: storage problems are tracked per file", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("a write that works again clears only its own file's problem", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const realWrite = h.fs.writeAtomic.bind(h.fs);
    const broken = new Set(["pool.bin", "outbox.bin"]);
    const realRemove = h.fs.remove.bind(h.fs);
    const refused = (path: string) => [...broken].some((name) => path.endsWith(name));
    h.fs.writeAtomic = async (path, data) => { if (refused(path)) throw new Error("EIO"); return realWrite(path, data); };
    h.fs.remove = async (path) => { if (refused(path)) throw new Error("EIO"); return realRemove(path); };
    await engine.signOut();
    await engine.signIn("bea", "correct");                // a new owner: the old pool must go and the outbox be rewritten, both refused
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");

    broken.delete("outbox.bin");                          // the outbox recovers, the pool does not
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 3);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");

    broken.delete("pool.bin");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });

  it("an outbox write that failed once is probed again on the tick, so the blocker cannot stick", async () => {
    const h = createHarness();
    const engine = await ready(h);
    const realWrite = h.fs.writeAtomic.bind(h.fs);
    let outboxBroken = true;
    h.fs.writeAtomic = async (path, data) => { if (outboxBroken && path.endsWith("outbox.bin")) throw new Error("EIO"); return realWrite(path, data); };
    await engine.signOut();
    await engine.signIn("sardor", "correct");             // adoptOwner writes the outbox: refused
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    expect(engine.status().blockers).toContain("STORAGE_PROBLEM");
    outboxBroken = false;
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS * 2);
    expect(engine.status().blockers).not.toContain("STORAGE_PROBLEM");
    await engine.quit();
  });
});

describe("engine: a discarded outbox is said out loud", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("logs OUTBOX_DISCARDED with the count when another account signs in over unsent statements", async () => {
    const h = createHarness();
    const engine = await ready(h);
    h.client.script.push(GATE_YES, {evidence: [{target_id: "pg", statement: "Traced a slow report to a missing index and rebuilt it without blocking writes on a busy table."}]});
    await engine.setCapture(true);
    h.reader.front = {app: "Code", title: "report.sql"};
    h.reader.text = "I traced the slow report to the orders query. Postgres fell back to a sequential scan, so I added the missing index concurrently and checked the plan again. ".repeat(4);
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    h.api.failWith = "OFFLINE";
    expect(await engine.approve(engine.review().pending[0]!.id)).toBe(true);
    await engine.signOut();
    h.api.failWith = null;
    await engine.signIn("bea", "correct");
    expect(logCodes(h)).toContain("OUTBOX_DISCARDED");
    expect(h.api.submitted).toEqual([]);
    await engine.quit();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/main/engine.owner.test.ts`
Expected: FAIL, 7 of 9 (no `ownerUserId` is written, another account inherits `bank.example`, no `OUTBOX_DISCARDED` line).

- [ ] **Step 3: Apply the edits**

Each edit replaces exactly one occurrence. Edit nothing else in these files.

In `app/src/main/settings.ts` replace
```ts
  /** `${appVersion}:${modelSha256}` of the last passed self-test. */
  selfTestPassedFor: string | null;
}
```
with
```ts
  /** `${appVersion}:${modelSha256}` of the last passed self-test. */
  selfTestPassedFor: string | null;
  /**
   * Whose exclusions, review time and capture switch these are. `null` until the first sign-in.
   * Another account never inherits them: the engine resets them before anything is read.
   */
  ownerUserId: string | null;
}
```

In `app/src/main/settings.ts` replace
```ts
"lastPromptDay" | "selfTestPassedFor">>;
```
with
```ts
"lastPromptDay" | "selfTestPassedFor" | "ownerUserId">>;
```

In `app/src/main/settings.ts` replace
```ts
captureOn: false, onboardingStep: 0, lastPromptDay: null, selfTestPassedFor: null
});
```
with
```ts
captureOn: false, onboardingStep: 0, lastPromptDay: null, selfTestPassedFor: null, ownerUserId: null
});
```

In `app/src/main/settings.ts` replace
```ts
  lastPromptDay: z.string().nullable(), selfTestPassedFor: z.string().nullable()
});
```
with
```ts
  lastPromptDay: z.string().nullable(), selfTestPassedFor: z.string().nullable(),
  // Files written before settings had an owner are adopted by the next account that signs in.
  ownerUserId: z.string().min(1).nullable().default(null)
});
```

In `app/src/main/log.ts` replace
```ts
"DATA_DELETED"
```
with
```ts
"DATA_DELETED", "OUTBOX_DISCARDED", "SETTINGS_RESET_FOR_NEW_OWNER"
```

In `app/src/main/review/uploader.ts` replace
```ts
  adoptOwner(userId: string): Promise<void>;
```
with
```ts
  /** Returns how many of another account's statements were discarded (0 when the owner is unchanged). */
  adoptOwner(userId: string): Promise<number>;
  /** Writes the outbox again as it is. The engine uses it to find out whether the disk takes writes again. */
  resave(): Promise<void>;
```

In `app/src/main/review/uploader.ts` replace
```ts
      await file.save(next);
      stored = next;
      if (clearing) { failures = 0; notBefore = 0; }
    },
```
with
```ts
      const discarded = clearing ? stored.items.length : 0;
      await file.save(next);
      stored = next;
      if (clearing) { failures = 0; notBefore = 0; }
      return discarded;
    },
    resave: () => file.save(stored),
```

In `app/src/main/capture/loop.ts` replace
```ts
        subscribed = reader.onFocusChange(() => {
          if (settleTimer) clearTimeout(settleTimer);
```
with
```ts
        subscribed = reader.onFocusChange(() => {
          // A reader that registered this callback and then threw, or one that keeps calling after
          // stop(): with the loop not running there is nothing to settle and no timer to arm.
          if (!active) return;
          if (settleTimer) clearTimeout(settleTimer);
```

In `app/src/main/engine.ts` replace
```ts
  let storageProblem = false;

```
with
```ts
  /** Which files the disk is refusing. One flag per file: a write that works again clears only its own. */
  const storageProblems = new Set<"pool" | "outbox" | "settings">();

```

In `app/src/main/engine.ts` replace
```ts
    if (storageProblem) found.push("STORAGE_PROBLEM");
```
with
```ts
    // Settings that still belong to another account count as a storage problem: the reset has not
    // reached the disk yet, and until it has, nothing may be read under that account's choices.
    if (storageProblems.size > 0 || settingsBelongToSomeoneElse()) found.push("STORAGE_PROBLEM");
```

In `app/src/main/engine.ts` replace
```ts
  async function raiseStorageProblem(): Promise<void> {
    if (storageProblem) return;
    storageProblem = true;
    background(log.event("STORAGE_PROBLEM"));
    await evaluate();
  }
```
with
```ts
  async function raiseStorageProblem(source: "pool" | "outbox" | "settings"): Promise<void> {
    if (storageProblems.has(source)) return;
    const first = storageProblems.size === 0;
    storageProblems.add(source);
    if (first) background(log.event("STORAGE_PROBLEM"));
    await evaluate();
  }
```

In `app/src/main/engine.ts` replace
```ts
  async function clearStorageProblem(): Promise<void> {
    if (!storageProblem) return;
    storageProblem = false;
    await evaluate();
  }
```
with
```ts
  async function clearStorageProblem(source: "pool" | "outbox" | "settings"): Promise<void> {
    if (!storageProblems.delete(source)) return;
    await evaluate();
  }

  const settingsBelongToSomeoneElse = (): boolean => {
    const userId = session.userId();
    const owner = settings.get().ownerUserId;
    return userId !== null && owner !== null && owner !== userId;
  };

  /**
   * Exclusions, excluded sites, the review time and the capture switch belong to one account. The
   * first account to sign in adopts settings that have no owner yet; any other account gets the
   * defaults with capture off. Nobody's screen is read because somebody else once agreed to it.
   * `onboardingStep` and `selfTestPassedFor` are facts about this install, so they stay.
   * The reset is durable: until it is on disk the mismatch itself blocks capture (see `blockers`),
   * and the tick calls this again.
   */
  async function ensureSettingsOwner(): Promise<void> {
    const userId = session.userId();
    if (userId === null) return;
    const owner = settings.get().ownerUserId;
    if (owner === userId) { await clearStorageProblem("settings"); return; }
    const fresh = defaultSettings();
    const result = await settings.update(owner === null
      ? {ownerUserId: userId}
      : {exclusions: fresh.exclusions, excludedSites: fresh.excludedSites, reviewTime: fresh.reviewTime, captureOn: false, lastPromptDay: null, ownerUserId: userId});
    if (!result.ok) { await raiseStorageProblem("settings"); return; }
    if (owner !== null) background(log.event("SETTINGS_RESET_FOR_NEW_OWNER"));
    pipeline.configure(config());
    await clearStorageProblem("settings");
  }

  /**
   * Takes over the outbox for the signed-in account. Another account's unsent statements are
   * discarded (never uploaded to the wrong profile) and that is logged with the count. A disk that
   * refuses the write is a storage problem, not a failed sign-in; the tick tries again.
   */
  async function adoptOutbox(): Promise<void> {
    const userId = session.userId();
    try {
      if (userId === null) await uploader.resave();
      else {
        const discarded = await uploader.adoptOwner(userId);
        if (discarded > 0) background(log.event("OUTBOX_DISCARDED", {count: discarded}));
      }
      await clearStorageProblem("outbox");
    } catch { await raiseStorageProblem("outbox"); }
  }
```

In `app/src/main/engine.ts` replace
```ts
      try { await pool.save(pipeline, poolOwner); savedPool = snapshot; await clearStorageProblem(); }
      catch { await raiseStorageProblem(); }
```
with
```ts
      try { await pool.save(pipeline, poolOwner); savedPool = snapshot; await clearStorageProblem("pool"); }
      catch { await raiseStorageProblem("pool"); }
```

In `app/src/main/engine.ts` replace
```ts
    if (STORAGE_FLUSH_CODES.has(result)) await raiseStorageProblem();
```
with
```ts
    if (STORAGE_FLUSH_CODES.has(result)) await raiseStorageProblem("outbox");
```

In `app/src/main/engine.ts` replace
```ts
    else if (result === "sent") await clearStorageProblem();
```
with
```ts
    else if (result === "sent") await clearStorageProblem("outbox");
```

In `app/src/main/engine.ts` replace
```ts
  if (session.userId()) await uploader.adoptOwner(session.userId() as string);

```
with
```ts
  if (session.userId()) await adoptOutbox();
  // Before anything can be read: settings left by another account are reset, ownerless ones adopted.
  await ensureSettingsOwner();

```

In `app/src/main/engine.ts` replace
```ts
    try { await pool.clear(); } catch { await raiseStorageProblem(); }
```
with
```ts
    // A refused removal is retried by the next pool save: the empty snapshot below no longer matches.
    try { await pool.clear(); } catch { savedPool = ""; await raiseStorageProblem("pool"); }
```

In `app/src/main/engine.ts` replace
```ts
    // The user-owned settings belonged to the previous user, not to this machine: which apps and
    // sites they chose to keep out, what time they read their statements, and whether they had
    // capture switched on. A new user starts from the defaults, with capture off — nobody's screen
    // is read because somebody else once agreed to it. `onboardingStep` and `selfTestPassedFor` are
    // facts about this install and this machine, so they stay.
    const fresh = defaultSettings();
    const reset = await settings.update({
      exclusions: fresh.exclusions, excludedSites: fresh.excludedSites, reviewTime: fresh.reviewTime,
      captureOn: false, lastPromptDay: null
    });
    // A refused write would leave the previous user's choices in force for this one, which is the
    // one outcome this must not have: same treatment as a pool file that could not be cleared.
    if (!reset.ok) await raiseStorageProblem();

```
with
```ts
    // The previous account's settings are dealt with by `ensureSettingsOwner`, which does not depend
    // on a pool file being there to notice that the account changed.

```

In `app/src/main/engine.ts` replace
```ts
        await uploader.adoptOwner(userId);

```
with
```ts
        await adoptOutbox();
        await ensureSettingsOwner();

```

In `app/src/main/engine.ts` replace
```ts
        // The outbox could not be written. The statement stays pending and the user is told why.
        await raiseStorageProblem();
```
with
```ts
        // The outbox could not be written. The statement stays pending and the user is told why.
        await raiseStorageProblem("outbox");
```

In `app/src/main/engine.ts` replace
```ts
      storageProblem = false;

```
with
```ts
      storageProblems.clear();

```

In `app/src/main/engine.ts` replace
```ts
      background(taxonomy.refresh());
      // The permission can be taken away
```
with
```ts
      background(taxonomy.refresh());
      // Whatever the disk refused is tried again, file by file, so no storage problem can outlive its cause.
      if (storageProblems.has("outbox")) background(adoptOutbox());
      if (storageProblems.has("settings") || settingsBelongToSomeoneElse() || (session.userId() !== null && settings.get().ownerUserId === null)) background(ensureSettingsOwner());
      // The permission can be taken away
```

In `app/src/main/engine.ts` replace
```ts
      pipeline.resolve(id, "approved");
      await savePool();
```
with
```ts
      await clearStorageProblem("outbox");     // the outbox just took a write
      pipeline.resolve(id, "approved");
      await savePool();
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/main/engine.owner.test.ts src/main/engine.test.ts src/main/review/review.test.ts src/main/capture/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (554 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 2` — Expected: `mismatches: 0`.

---

### Task 3: The IPC contract and its router

The whole surface between the renderer and main, in one shared file, and a pure router that validates every argument before the engine sees it. The renderer is untrusted input: unknown channels and malformed arguments get a fixed code and are never echoed.

**Files:**
- Create: `app/src/shared/ipc.ts`, `app/src/main/ipcRouter.ts`
- Test: `app/src/main/ipcRouter.test.ts`, `app/src/main/ipc.leak.test.ts`

**Interfaces:**
- Consumes: `Engine`, `EngineStatus`, `ReviewView`, `UserSettingsPatch`, `Blocker` (engine.ts); `Downloader`, `DownloadState`; `Reader`; `SignInResult`; `SelfTestResult`; `Permission`; `SettingsProblem`; `createHarness` for the tests.
- Produces: `app/src/shared/ipc.ts`: `ClaveBridge`, `UserSettings`, `AppInfo`, `INVOKE_CHANNELS`, `EVENT_CHANNELS`, `InvokeChannel`, `EventChannel`, `invokeName(channel)`, `eventName(channel)`. `createIpcRouter(deps: IpcRouterDeps): IpcRouter` with `handle(channel, args): Promise<unknown>` and `subscribe(send): () => void`; `class IpcError {code: "BAD_CHANNEL" | "BAD_ARGS"}`. The `settings` channel returns `UserSettings` only (no owner, self-test key or prompt day).

- [ ] **Step 1: Write the failing tests**

`app/src/main/ipcRouter.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {INVOKE_CHANNELS} from "../shared/ipc";
import {createIpcRouter, IpcError, type IpcRouter} from "./ipcRouter";
import {createHarness, type Harness} from "./testing/harness";

async function setup() {
  const h: Harness = createHarness();
  const engine = await h.launch();
  const calls: string[] = [];
  const router: IpcRouter = createIpcRouter({
    engine, reader: {requestPermission: async () => { calls.push("requestPermission"); }},
    downloader: {state: h.downloader.state, onChange: h.downloader.onChange, start: async () => { calls.push("start"); }, pause: () => { calls.push("pause"); }},
    recentApp: () => "Figma", appInfo: {version: "1.0.0", modelSha256: "sha", modelSizeBytes: 5, standIns: true},
    openWhatLeaves: async () => { calls.push("openWhatLeaves"); }, restartApp: () => { calls.push("restartApp"); }
  });
  return {h, engine, router, calls};
}

describe("ipc router", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("answers every channel in the list, and nothing outside it", async () => {
    const {engine, router} = await setup();
    const sample: Record<string, unknown[]> = {
      approve: ["x"], reject: ["x"], setCapture: [false], signIn: ["sardor", "correct"], updateSettings: [{reviewTime: "09:00"}],
      retry: ["model"], deleteAllData: [{removeModel: false}]
    };
    for (const channel of INVOKE_CHANNELS) await expect(router.handle(channel, sample[channel] ?? []), channel).resolves.not.toThrow();
    for (const channel of ["quit", "takeCounters", "system", "__proto__", "constructor", "toString", ""]) {
      await expect(router.handle(channel, [])).rejects.toMatchObject({code: "BAD_CHANNEL"});
    }
    await engine.quit();
  });

  it("rejects malformed arguments with a fixed code and never echoes them", async () => {
    const {engine, router} = await setup();
    const bad: [string, unknown[]][] = [
      ["approve", []], ["approve", [7]], ["approve", ["x", "extra"]], ["setCapture", ["yes"]], ["signIn", ["sardor"]],
      ["signIn", ["sardor", "x".repeat(2000)]], ["retry", ["disk"]], ["deleteAllData", [{removeModel: "no"}]],
      ["deleteAllData", [{removeModel: true, also: "this"}]], ["status", ["unexpected"]],
      ["updateSettings", [{captureOn: true}]], ["updateSettings", [{selfTestPassedFor: "1.0.0:sha"}]], ["updateSettings", [{ownerUserId: "user:x"}]],
      ["updateSettings", ["Priya said hunter2"]]
    ];
    for (const [channel, args] of bad) {
      const error = await router.handle(channel, args).catch((e: unknown) => e);
      expect(error, channel).toBeInstanceOf(IpcError);
      expect((error as IpcError).message).toBe("BAD_ARGS");
    }
    await engine.quit();
  });

  it("never hands the renderer the settings' internal bookkeeping", async () => {
    const {engine, router} = await setup();
    await router.handle("signIn", ["sardor", "correct"]);
    const settings = await router.handle("settings", []);
    expect(Object.keys(settings as object).sort()).toEqual(["captureOn", "excludedSites", "exclusions", "onboardingStep", "reviewTime"]);
    await engine.quit();
  });

  it("routes to the engine and the other dependencies", async () => {
    const {engine, router, calls} = await setup();
    expect(await router.handle("signIn", ["sardor", "correct"])).toEqual({ok: true});
    expect(await router.handle("updateSettings", [{reviewTime: "08:30"}])).toEqual({ok: true});
    expect(await router.handle("settings", [])).toMatchObject({reviewTime: "08:30"});
    expect(await router.handle("approve", ["no-such-id"])).toBe(false);
    expect(await router.handle("recentApp", [])).toBe("Figma");
    expect(await router.handle("appInfo", [])).toMatchObject({version: "1.0.0", standIns: true});
    await router.handle("requestPermission", []); await router.handle("downloadStart", []); await router.handle("downloadPause", []);
    await router.handle("openWhatLeaves", []); await router.handle("restartApp", []);
    expect(calls).toEqual(["requestPermission", "start", "pause", "openWhatLeaves", "restartApp"]);
    await engine.quit();
  });

  it("pushes status and download changes until unsubscribed", async () => {
    const {h, engine, router} = await setup();
    const seen: string[] = [];
    const stop = router.subscribe((channel) => seen.push(channel));
    h.downloader.set({kind: "missing"});
    expect(seen).toContain("download");
    expect(seen).toContain("status");
    stop();
    const before = seen.length;
    h.downloader.set({kind: "ready"});
    expect(seen.length).toBe(before);
    await engine.quit();
  });
});
```

`app/src/main/ipc.leak.test.ts`:
```ts
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SCENARIO_IDLE_MS} from "../core/constants";
import {INVOKE_CHANNELS} from "../shared/ipc";
import {createDevReader} from "../standins/devReader";
import {createStubApi} from "../standins/stubApi";
import {PIPELINE_TICK_MS} from "./constants";
import {createIpcRouter} from "./ipcRouter";
import {parseTaxonomy, type Taxonomy} from "./ports/claveApi";
import {createHarness} from "./testing/harness";

const taxonomy = parseTaxonomy(JSON.parse(readFileSync(new URL("../standins/taxonomy.json", import.meta.url), "utf8"))) as Taxonomy;
const SLACK = {app: "Slack", title: "#backend-team — Acme Workspace", text: [
  "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy. Any idea what changed?",
  "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
  "Sardor 10:46 export STRIPE_KEY=sk_live_51HxQbLkT9vW3mZpR8sYcD2eF",
  "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable for support agents? Mail me at tomas@acme.io",
  "Sardor 10:51 For the customer page yes. For the support dashboard I would bypass the cache and hit the replica."
].join("\n")};
const GATE_YES = {activity_summary: "Debugged a slow query.", is_professional: true, user_demonstrated_something: true};
const CLEAN = "Weighed stale reads against database load and chose different caching strategies for two kinds of page.";
const LEAKY = {evidence: [
  {target_id: "stub-postgresql", statement: "Explained the root cause of a slow query to Priya and proposed adding a supporting index."},
  {target_id: "stub-postgresql", statement: "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."},
  {target_id: "stub-redis", statement: "Emailed tomas@acme.io a proposal for a thirty second cache in front of a slow database query."},
  {target_id: "stub-problem-solving", statement: CLEAN}
]};
const SECRETS = ["Priya", "Raman", "Tomas", "Lindqvist", "Acme", "acme.io", "sk_live", "51HxQb", "backend-team", "8 million", "2.4 seconds", "sequential scan on"];

describe("LEAK TEST (IPC): everything that can cross to the renderer", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 17, 9, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("no pushed event and no answer on any channel carries anything read from the screen", async () => {
    const h = createHarness();
    const reader = createDevReader([SLACK], 60_000);
    const api = createStubApi({fs: h.fs, uploadsPath: "/data/stub-uploads.jsonl", taxonomy, now: () => Date.now()});
    const engine = await h.launch({reader, api});
    const router = createIpcRouter({
      engine, reader, downloader: {state: h.downloader.state, onChange: h.downloader.onChange, start: async () => undefined, pause: () => undefined},
      recentApp: () => null, appInfo: {version: "1.0.0", modelSha256: "sha", modelSizeBytes: 1, standIns: true},
      openWhatLeaves: async () => undefined, restartApp: () => undefined
    });
    const crossed: unknown[] = [];
    router.subscribe((channel, payload) => crossed.push([channel, payload]));

    crossed.push(await router.handle("signIn", ["sardor", "anything"]));
    h.client.script.push(GATE_YES, {evidence: [{target_id: "self-test-postgres", statement: CLEAN}]});
    crossed.push(await router.handle("selfTest", []));
    h.client.script.push(GATE_YES, LEAKY);
    crossed.push(await router.handle("setCapture", [true]));
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);
    engine.system("locked");
    await vi.advanceTimersByTimeAsync(SCENARIO_IDLE_MS + 2 * PIPELINE_TICK_MS);
    engine.system("unlocked");
    await vi.advanceTimersByTimeAsync(PIPELINE_TICK_MS);

    const review = (await router.handle("review", [])) as {pending: {id: string; statement: string}[]};
    expect(review.pending.map((p) => p.statement)).toEqual([CLEAN]);
    const skip = new Set(["signIn", "selfTest", "setCapture", "approve", "reject", "deleteAllData", "restartApp", "signOut"]);
    for (const channel of INVOKE_CHANNELS) if (!skip.has(channel)) crossed.push([channel, await router.handle(channel, channel === "updateSettings" ? [{}] : channel === "retry" ? ["reader"] : [])]);
    crossed.push(await router.handle("approve", [review.pending[0]!.id]));
    crossed.push(await router.handle("review", []));
    for (const bad of [["approve", [SLACK.text]], ["nope", []], ["updateSettings", [{exclusions: SLACK.text}]]] as [string, unknown[]][]) {
      crossed.push(await router.handle(bad[0], bad[1]).catch((error: unknown) => String(error)));
    }
    await engine.quit();

    const everything = JSON.stringify(crossed);
    expect(everything).toContain(CLEAN);                       // the one approved-able statement did cross
    for (const secret of SECRETS) expect(everything, secret).not.toContain(secret);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/main/ipcRouter.test.ts src/main/ipc.leak.test.ts`
Expected: FAIL with `Cannot find module '../shared/ipc'`.

- [ ] **Step 3: Implement**

`app/src/shared/ipc.ts`:
```ts
/**
 * The whole surface between the renderer and the main process. The preload exposes exactly this
 * and nothing else. Only `import type` from `main/` is allowed here: types vanish at build time,
 * so no main-process code can reach the renderer bundle through this file.
 */
import type {SignInResult} from "../main/account/session";
import type {Blocker, EngineStatus, ReviewView, UserSettingsPatch} from "../main/engine";
import type {DownloadState} from "../main/model/download";
import type {SelfTestResult} from "../main/model/selfTest";
import type {Permission} from "../main/ports/reader";
import type {SettingsProblem} from "../main/settings";

export type {Blocker, DownloadState, EngineStatus, Permission, ReviewView, SelfTestResult, SettingsProblem, SignInResult, UserSettingsPatch};

/** What the renderer may know about the settings. Internal bookkeeping (owner, self-test key, prompt day) stays in main. */
export interface UserSettings { exclusions: string[]; excludedSites: string[]; reviewTime: string; captureOn: boolean; onboardingStep: number }
export interface AppInfo { version: string; modelSha256: string; modelSizeBytes: number; standIns: boolean }

export interface ClaveBridge {
  status(): Promise<EngineStatus>;
  review(): Promise<ReviewView>;
  approve(id: string): Promise<boolean>;
  reject(id: string): Promise<boolean>;
  setCapture(on: boolean): Promise<{ok: true} | {ok: false; blockers: Blocker[]}>;
  pauseForAnHour(): Promise<void>;
  signIn(identifier: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  settings(): Promise<UserSettings>;
  settingsOpened(): Promise<void>;
  updateSettings(patch: UserSettingsPatch): Promise<{ok: true} | {ok: false; problem: SettingsProblem}>;
  selfTest(): Promise<SelfTestResult>;
  recheckPermission(): Promise<Permission>;
  requestPermission(): Promise<void>;
  retry(problem: "model" | "reader"): Promise<void>;
  deleteAllData(opts: {removeModel: boolean}): Promise<void>;
  downloadState(): Promise<DownloadState>;
  downloadStart(): Promise<void>;
  downloadPause(): Promise<void>;
  /** The last app in front that was not this one: "add the app I'm using now". `null` when unknown. */
  recentApp(): Promise<string | null>;
  appInfo(): Promise<AppInfo>;
  openWhatLeaves(): Promise<void>;
  restartApp(): Promise<void>;
  onStatus(cb: (status: EngineStatus) => void): () => void;
  onDownload(cb: (state: DownloadState) => void): () => void;
}

/** Every request channel, in one list. The router refuses anything else. */
export const INVOKE_CHANNELS = [
  "status", "review", "approve", "reject", "setCapture", "pauseForAnHour", "signIn", "signOut", "settings", "settingsOpened",
  "updateSettings", "selfTest", "recheckPermission", "requestPermission", "retry", "deleteAllData", "downloadState",
  "downloadStart", "downloadPause", "recentApp", "appInfo", "openWhatLeaves", "restartApp"
] as const;
export type InvokeChannel = typeof INVOKE_CHANNELS[number];

/** Every push channel from main to the renderer. */
export const EVENT_CHANNELS = ["status", "download"] as const;
export type EventChannel = typeof EVENT_CHANNELS[number];

/** Electron channel names: one prefix, so nothing else in the process can collide. */
export const invokeName = (channel: InvokeChannel): string => `clave:invoke:${channel}`;
export const eventName = (channel: EventChannel): string => `clave:event:${channel}`;
```

`app/src/main/ipcRouter.ts`:
```ts
import {z} from "zod";
import {EVENT_CHANNELS, INVOKE_CHANNELS, type AppInfo, type EventChannel, type InvokeChannel, type UserSettings} from "../shared/ipc";
import type {Engine} from "./engine";
import type {Downloader} from "./model/download";
import type {Reader} from "./ports/reader";

export type IpcErrorCode = "BAD_CHANNEL" | "BAD_ARGS";
/** A fixed code. The renderer is untrusted input: nothing it sends is echoed back in an error. */
export class IpcError extends Error { constructor(readonly code: IpcErrorCode) { super(code); this.name = "IpcError"; } }

export interface IpcRouterDeps {
  engine: Engine;
  downloader: Pick<Downloader, "state" | "start" | "pause" | "onChange">;
  reader: Pick<Reader, "requestPermission">;
  recentApp: () => string | null;
  appInfo: AppInfo;
  openWhatLeaves: () => Promise<void>;
  restartApp: () => void;
}

export interface IpcRouter {
  /** One request from the renderer. Rejects with an IpcError for an unknown channel or malformed arguments. */
  handle(channel: string, args: unknown[]): Promise<unknown>;
  /** Starts pushing status and download changes. Returns the function that stops it. */
  subscribe(send: (channel: EventChannel, payload: unknown) => void): () => void;
}

const none = z.tuple([]);
const patch = z.object({
  exclusions: z.array(z.string().max(500)).max(500).optional(), excludedSites: z.array(z.string().max(500)).max(500).optional(),
  reviewTime: z.string().max(5).optional(), onboardingStep: z.number().int().min(0).max(100).optional()
}).strict();

const ARGS = {
  status: none, review: none, pauseForAnHour: none, signOut: none, settings: none, settingsOpened: none, selfTest: none,
  recheckPermission: none, requestPermission: none, downloadState: none, downloadStart: none, downloadPause: none,
  recentApp: none, appInfo: none, openWhatLeaves: none, restartApp: none,
  approve: z.tuple([z.string().min(1).max(200)]), reject: z.tuple([z.string().min(1).max(200)]),
  setCapture: z.tuple([z.boolean()]),
  signIn: z.tuple([z.string().min(1).max(320), z.string().min(1).max(1024)]),
  updateSettings: z.tuple([patch]),
  retry: z.tuple([z.enum(["model", "reader"])]),
  deleteAllData: z.tuple([z.object({removeModel: z.boolean()}).strict()])
} satisfies Record<InvokeChannel, z.ZodTypeAny>;

const isChannel = (value: string): value is InvokeChannel => (INVOKE_CHANNELS as readonly string[]).includes(value);

/**
 * Everything the renderer can ask for, checked before it reaches the engine. Pure: no Electron here,
 * so the whole contract is tested without a window. `shell/ipcMain.ts` connects it to `ipcMain`.
 */
export function createIpcRouter(deps: IpcRouterDeps): IpcRouter {
  const {engine, downloader} = deps;

  const userSettings = (): UserSettings => {
    const s = engine.settings();
    return {exclusions: s.exclusions, excludedSites: s.excludedSites, reviewTime: s.reviewTime, captureOn: s.captureOn, onboardingStep: s.onboardingStep};
  };

  async function run(channel: InvokeChannel, a: unknown[]): Promise<unknown> {
    switch (channel) {
      case "status": return engine.status();
      case "review": return engine.review();
      case "approve": return engine.approve(a[0] as string);
      case "reject": return engine.reject(a[0] as string);
      case "setCapture": return engine.setCapture(a[0] as boolean);
      case "pauseForAnHour": return engine.pauseForAnHour();
      case "signIn": return engine.signIn(a[0] as string, a[1] as string);
      case "signOut": return engine.signOut();
      case "settings": return userSettings();
      case "settingsOpened": engine.settingsOpened(); return undefined;
      case "updateSettings": return engine.updateSettings(a[0] as Parameters<Engine["updateSettings"]>[0]);
      case "selfTest": return engine.selfTest();
      case "recheckPermission": return engine.recheckPermission();
      case "requestPermission": await deps.reader.requestPermission(); return undefined;
      case "retry": engine.retry(a[0] as "model" | "reader"); return undefined;
      case "deleteAllData": return engine.deleteAllData(a[0] as {removeModel: boolean});
      case "downloadState": return downloader.state();
      case "downloadStart": void downloader.start(); return undefined;     // long-running: progress arrives as events
      case "downloadPause": downloader.pause(); return undefined;
      case "recentApp": return deps.recentApp();
      case "appInfo": return deps.appInfo;
      case "openWhatLeaves": return deps.openWhatLeaves();
      case "restartApp": deps.restartApp(); return undefined;
    }
  }

  return {
    async handle(channel, args) {
      if (typeof channel !== "string" || !isChannel(channel)) throw new IpcError("BAD_CHANNEL");
      const parsed = ARGS[channel].safeParse(Array.isArray(args) ? args : []);
      if (!parsed.success) throw new IpcError("BAD_ARGS");
      return run(channel, parsed.data as unknown[]);
    },
    subscribe(send) {
      const stops = [
        engine.onStatus((status) => send("status", status)),
        downloader.onChange((state) => send("download", state))
      ];
      return () => { for (const stop of stops) stop(); };
    }
  };
}

export {EVENT_CHANNELS};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/main/ipcRouter.test.ts src/main/ipc.leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (562 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 3` — Expected: `mismatches: 0`.

---

### Task 4: Download adapters for Node

The real network and disk behind `createDownloader`: `fetch` with redirects and a streamed body, `fs` append, a streamed SHA-256, and free space from `statfs`. Tested against a real local HTTP server and a real temp folder.

**Files:**
- Create: `app/src/main/model/nodeDownload.ts`
- Test: `app/src/main/model/nodeDownload.test.ts`

**Interfaces:**
- Consumes: `Http`, `DownloadDisk`, `createDownloader` from `./download`.
- Produces: `createNodeHttp(fetchImpl = fetch): Http`, `createNodeDownloadDisk(): DownloadDisk`.

- [ ] **Step 1: Write the failing tests**

`app/src/main/model/nodeDownload.test.ts`:
```ts
import {createHash} from "node:crypto";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {createDownloader} from "./download";
import {createNodeDownloadDisk, createNodeHttp} from "./nodeDownload";

const CONTENT = Buffer.from("clave-model-bytes-".repeat(5000));          // ~90 KB standing in for 2.7 GB
const SHA = createHash("sha256").update(CONTENT).digest("hex");
const ranges: (string | undefined)[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/moved") { response.writeHead(302, {Location: "/model.gguf"}).end(); return; }
    if (request.url === "/gone") { response.writeHead(404).end(); return; }
    ranges.push(request.headers.range);
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const from = match ? Number(match[1]) : 0;
    response.writeHead(match ? 206 : 200, {"Content-Length": CONTENT.length - from});
    response.end(CONTENT.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe("node download adapters (a real local server and a real temp folder)", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "clave-dl-")); ranges.length = 0; });
  afterEach(async () => { await rm(dir, {recursive: true, force: true}); });
  const make = (path: string) => createDownloader({
    http: createNodeHttp(), disk: createNodeDownloadDisk(), dir: join(dir, "models"),
    spec: {url: base + path, fileName: "m.gguf", sha256: SHA, sizeBytes: CONTENT.length}
  });

  it("downloads through a redirect, verifies, and leaves only the final file", async () => {
    const downloader = make("/moved");
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(await readdir(join(dir, "models"))).toEqual(["m.gguf"]);
    expect((await readFile(downloader.filePath())).equals(CONTENT)).toBe(true);
  });

  it("resumes with a Range request from the bytes already on disk", async () => {
    const disk = createNodeDownloadDisk();
    await disk.append(join(dir, "models", "m.gguf.part"), CONTENT.subarray(0, 40_000));
    const downloader = make("/model.gguf");
    await downloader.start();
    expect(ranges).toEqual(["bytes=40000-"]);
    expect(downloader.state()).toEqual({kind: "ready"});
  });

  it("reports a missing file as a failure, with nothing left under the final name", async () => {
    const downloader = make("/gone");
    await downloader.start();
    expect(downloader.state()).toEqual({kind: "error", code: "DOWNLOAD_FAILED"});
    expect(await readdir(join(dir, "models")).catch(() => [])).not.toContain("m.gguf");
  });

  it("hashes by streaming and measures free space", async () => {
    const disk = createNodeDownloadDisk();
    const path = join(dir, "blob");
    await writeFile(path, CONTENT);
    expect(await disk.sha256(path)).toBe(SHA);
    expect(await disk.size(path)).toBe(CONTENT.length);
    expect(await disk.size(join(dir, "nope"))).toBe(0);
    expect(await disk.freeBytes(join(dir, "new-folder"))).toBeGreaterThan(1_000_000);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/main/model/nodeDownload.test.ts`
Expected: FAIL with `Cannot find module './nodeDownload'`.

- [ ] **Step 3: Implement**

`app/src/main/model/nodeDownload.ts`:
```ts
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {appendFile, mkdir, rename, rm, stat, statfs} from "node:fs/promises";
import {dirname} from "node:path";
import type {DownloadDisk, Http} from "./download";

/**
 * The real network and disk behind `createDownloader`. `fetch` follows redirects (model hosts
 * redirect to a CDN) and the body is consumed as a stream, so 2.7 GB never sits in memory.
 */
export function createNodeHttp(fetchImpl: typeof fetch = fetch): Http {
  return {
    async get(url, {rangeStart, signal}) {
      const response = await fetchImpl(url, {signal, redirect: "follow", headers: rangeStart > 0 ? {Range: `bytes=${rangeStart}-`} : {}});
      const body = response.body;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (!body) return;
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) yield chunk;
      }
      return {status: response.status, body: chunks()};
    }
  };
}

const missing = (error: unknown) => (error as {code?: string}).code === "ENOENT";

export function createNodeDownloadDisk(): DownloadDisk {
  return {
    async size(path) {
      try { return (await stat(path)).size; }
      catch (error) { if (missing(error)) return 0; throw error; }
    },
    async append(path, chunk) { await mkdir(dirname(path), {recursive: true}); await appendFile(path, chunk); },
    async remove(path) { await rm(path, {force: true}); },
    rename: (from, to) => rename(from, to),
    sha256(path) {
      return new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
      });
    },
    async freeBytes(dir) {
      await mkdir(dir, {recursive: true});
      const info = await statfs(dir);
      return info.bavail * info.bsize;
    }
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/main/model/nodeDownload.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (568 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 4` — Expected: `mismatches: 0`.

---

### Task 5: The model host, the llama binding and the release gate

`hostCore.ts` is the model host's whole behaviour without a process: validates every message, loads the model on the first `open`, answers failures with the fixed code and never with the runtime's message. `llamaBinding.ts` is node-llama-cpp with the settings spike S1 proved necessary. The release gate runs the self-test and every non-adversarial fixture through the real pipeline with the real model and separates safety problems from quality findings.

**Files:**
- Create: `app/src/main/model/hostCore.ts`, `app/src/main/model/llamaBinding.ts`, `app/src/main/model/inProcessLink.ts`, `app/src/eval/gate.ts`, `app/src/eval/gateCli.ts`
- Test: `app/src/main/model/hostCore.test.ts`, `app/src/eval/gate.test.ts`

**Interfaces:**
- Consumes: `ToHost`, `FromHost`, `HostLink` (protocol.ts); `createModelClient`; `runSelfTest`; `runFixture`, `judgeReal`, `parseFixture`; `createFakeModel`; `ModelSettings`, `JsonSchema`, `ModelPort` from the core.
- Produces: `ModelBinding`, `LoadedModel`, `HostConversation`, `createHostCore({binding, modelPath, post}): HostCore` (`onMessage(raw)`, `shutdown()`); `createLlamaBinding(): ModelBinding`; `createInProcessLink({binding, modelPath}): HostLink`; `runGate({model, fixtures, now, onResult?}): Promise<GateReport>` with `GateReport {selfTest, results, safe, passed}` and `GateResult {name, ok, problems, safety, seconds}`; `gateCli.ts` (exit code 0 passed, 2 safe with quality findings, 1 safety problem).

- [ ] **Step 1: Write the failing tests**

`app/src/main/model/hostCore.test.ts`:
```ts
import {describe, expect, it} from "vitest";
import type {ModelSettings} from "../../core/types";
import {createHostCore, type ModelBinding} from "./hostCore";
import type {FromHost} from "./protocol";

const SETTINGS: ModelSettings = {systemPrompt: "system", thoughts: "discourage", templateVariation: "3.5", temperature: 0.2};

function fakeBinding(opts: {failLoads?: number; failAsk?: boolean} = {}) {
  const log: string[] = [];
  let failLoads = opts.failLoads ?? 0;
  const binding: ModelBinding = {
    async load(path) {
      log.push(`load:${path}`);
      if (failLoads-- > 0) throw new Error("out of memory while reading the secret prompt");
      return {
        async open(settings) {
          log.push(`open:${settings.temperature}`);
          return {
            async ask(userText, _form, maxTokens) { if (opts.failAsk) throw new Error(`cannot answer: ${userText}`); log.push(`ask:${maxTokens}`); return {echo: userText.length}; },
            async close() { log.push("close"); }
          };
        },
        async dispose() { log.push("dispose"); }
      };
    }
  };
  return {binding, log};
}

function setup(opts: Parameters<typeof fakeBinding>[0] = {}) {
  const {binding, log} = fakeBinding(opts);
  const replies: FromHost[] = [];
  const core = createHostCore({binding, modelPath: "/m/q.gguf", post: (m) => replies.push(m)});
  return {core, log, replies};
}

describe("model host core", () => {
  it("loads the model on the first open, once, and carries a conversation", async () => {
    const {core, log, replies} = setup();
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "open", requestId: 2, settings: {...SETTINGS, temperature: 0}});
    await core.onMessage({type: "ask", requestId: 3, conversationId: 1, userText: "hello", form: {type: "object"}, maxTokens: 300});
    await core.onMessage({type: "close", requestId: 4, conversationId: 1});
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2", "open:0", "ask:300", "close"]);
    expect(replies).toEqual([
      {type: "opened", requestId: 1, conversationId: 1}, {type: "opened", requestId: 2, conversationId: 2},
      {type: "answer", requestId: 3, value: {echo: 5}}, {type: "done", requestId: 4}
    ]);
  });

  it("answers a failure with the fixed code and never with the runtime's message", async () => {
    const {core, replies} = setup({failAsk: true});
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "ask", requestId: 2, conversationId: 1, userText: "Priya's password is hunter2", form: {}, maxTokens: 10});
    expect(replies[1]).toEqual({type: "failed", requestId: 2, code: "MODEL_FAILED"});
    expect(JSON.stringify(replies)).not.toContain("hunter2");
  });

  it("fails an ask or close on an unknown conversation without throwing", async () => {
    const {core, replies} = setup();
    await core.onMessage({type: "ask", requestId: 1, conversationId: 9, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "close", requestId: 2, conversationId: 9});
    expect(replies).toEqual([{type: "failed", requestId: 1, code: "MODEL_FAILED"}, {type: "done", requestId: 2}]);
  });

  it("tries the load again after a failed one", async () => {
    const {core, log, replies} = setup({failLoads: 1});
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "open", requestId: 2, settings: SETTINGS});
    expect(replies.map((r) => r.type)).toEqual(["failed", "opened"]);
    expect(log.filter((l) => l.startsWith("load"))).toHaveLength(2);
  });

  it("unload closes what is open, frees the model, and the next open loads it again", async () => {
    const {core, log, replies} = setup();
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "unload", requestId: 2});
    await core.onMessage({type: "ask", requestId: 3, conversationId: 1, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "open", requestId: 4, settings: SETTINGS});
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2", "close", "dispose", "load:/m/q.gguf", "open:0.2"]);
    expect(replies.map((r) => r.type)).toEqual(["opened", "done", "failed", "opened"]);
  });

  it("ignores garbage, and fails a malformed request that at least carries an id", async () => {
    const {core, replies} = setup();
    await core.onMessage(null); await core.onMessage("open"); await core.onMessage({type: "open"});
    await core.onMessage({type: "ask", requestId: 5, conversationId: "one", userText: 7});
    await core.onMessage({type: "open", requestId: 6, settings: {...SETTINGS, thoughts: "auto"}});
    expect(replies).toEqual([{type: "failed", requestId: 5, code: "MODEL_FAILED"}, {type: "failed", requestId: 6, code: "MODEL_FAILED"}]);
  });
});
```

`app/src/eval/gate.test.ts`:
```ts
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {createFakeModel} from "../core/testing/fakeModel";
import type {ModelPort} from "../core/types";
import {runGate} from "./gate";

const DIR = new URL("../../../eval/fixtures/", import.meta.url).pathname;
const load = (file: string) => ({name: file, value: JSON.parse(readFileSync(join(DIR, file), "utf8")) as {model: {gate: unknown; statements: unknown | null}}});
const SELF_GATE = {activity_summary: "Rewrote a query.", is_professional: true, user_demonstrated_something: true};
const SELF_ANSWER = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

/** Answers the self-test first, then each fixture's own scripted answers, in order. */
function scripted(files: string[]): ModelPort {
  const script: unknown[] = [SELF_GATE, SELF_ANSWER];
  for (const file of files.filter((f) => !f.includes("adversarial"))) { const m = load(file).value.model; script.push(m.gate); if (m.statements !== null) script.push(m.statements); }
  return createFakeModel(script);
}

describe("release gate", () => {
  it("passes when the self-test and every fixture pass, and reports each one", async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
    const seen: string[] = [];
    const report = await runGate({model: scripted(files), fixtures: files.map(load), now: () => 0, onResult: (r) => seen.push(r.name)});
    expect(report.selfTest).toBe(true);
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.safe).toBe(true);
    // Adversarial fixtures only differ in their scripted model, which a real run ignores: skipped.
    expect(seen).toEqual(files.filter((f) => !f.includes("adversarial")));
  });

  it("fails on a failed self-test, a malformed fixture, a run that throws, or a judged problem", async () => {
    const silent: ModelPort = {open: async () => { throw new Error("no model"); }};
    const report = await runGate({model: silent, fixtures: [{name: "bad.json", value: {name: "x"}}, load("01-work-english.json")], now: () => 0});
    expect(report.selfTest).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.results[0]).toMatchObject({ok: false, problems: ["fixture is malformed"]});
    expect(report.results[1]?.ok).toBe(false);
    expect(report.safe).toBe(false);
  });

  it("tells a quality finding from a safety problem", async () => {
    const colleague = load("05-colleague.json");
    const eager = createFakeModel([SELF_GATE, SELF_ANSWER,
      {activity_summary: "Migrated a cluster.", is_professional: true, user_demonstrated_something: true},
      {evidence: [{target_id: "k8s", statement: "Migrated every service to a new cluster with a staged rollout and disruption budgets for stateful workloads."}]}]);
    const report = await runGate({model: eager, fixtures: [colleague], now: () => 0});
    expect(report.results[0]).toMatchObject({ok: false, safety: false});
    expect(report).toMatchObject({safe: true, passed: false});
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/main/model/hostCore.test.ts src/eval/gate.test.ts`
Expected: FAIL with `Cannot find module './hostCore'`.

- [ ] **Step 3: Implement**

`app/src/main/model/hostCore.ts`:
```ts
import {z} from "zod";
import type {JsonSchema, ModelSettings} from "../../core/types";
import type {FromHost, ToHost} from "./protocol";

/** What the host needs from a model runtime. `llamaBinding.ts` is the real one; tests use a fake. */
export interface HostConversation {
  ask(userText: string, form: JsonSchema, maxTokens: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface LoadedModel {
  open(settings: ModelSettings): Promise<HostConversation>;
  dispose(): Promise<void>;
}
export interface ModelBinding { load(modelPath: string): Promise<LoadedModel> }

const settingsShape = z.object({systemPrompt: z.string(), thoughts: z.literal("discourage"), templateVariation: z.literal("3.5"), temperature: z.number().min(0).max(2)});
const toHostShape = z.discriminatedUnion("type", [
  z.object({type: z.literal("open"), requestId: z.number().int(), settings: settingsShape}),
  z.object({type: z.literal("ask"), requestId: z.number().int(), conversationId: z.number().int(), userText: z.string(), form: z.record(z.string(), z.unknown()), maxTokens: z.number().int().min(1).max(4096)}),
  z.object({type: z.literal("close"), requestId: z.number().int(), conversationId: z.number().int()}),
  z.object({type: z.literal("unload"), requestId: z.number().int()})
]);

export interface HostCore {
  /** One message from main. Never throws; every request gets exactly one reply. */
  onMessage(message: unknown): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The model host's whole behaviour, without a process around it. The model is loaded on the first
 * `open`. Prompts and answers are never logged and never put into an error: a failure is the fixed
 * code MODEL_FAILED and nothing else.
 */
export function createHostCore(deps: {binding: ModelBinding; modelPath: string; post: (message: FromHost) => void}): HostCore {
  const {binding, modelPath, post} = deps;
  let model: Promise<LoadedModel> | null = null;
  let nextConversation = 0;
  const conversations = new Map<number, HostConversation>();

  const loaded = (): Promise<LoadedModel> => {
    if (!model) {
      const loading = binding.load(modelPath);
      model = loading;
      loading.catch(() => { if (model === loading) model = null; });      // a failed load may be tried again
    }
    return model;
  };

  async function unload(): Promise<void> {
    const current = model;
    model = null;
    for (const conversation of conversations.values()) await conversation.close().catch(() => undefined);
    conversations.clear();
    if (current) await current.then((m) => m.dispose()).catch(() => undefined);
  }

  async function run(message: ToHost): Promise<FromHost> {
    switch (message.type) {
      case "open": {
        const conversation = await (await loaded()).open(message.settings);
        const conversationId = ++nextConversation;
        conversations.set(conversationId, conversation);
        return {type: "opened", requestId: message.requestId, conversationId};
      }
      case "ask": {
        const conversation = conversations.get(message.conversationId);
        if (!conversation) return {type: "failed", requestId: message.requestId, code: "MODEL_FAILED"};
        return {type: "answer", requestId: message.requestId, value: await conversation.ask(message.userText, message.form, message.maxTokens)};
      }
      case "close": {
        const conversation = conversations.get(message.conversationId);
        conversations.delete(message.conversationId);
        if (conversation) await conversation.close();
        return {type: "done", requestId: message.requestId};
      }
      case "unload":
        await unload();
        return {type: "done", requestId: message.requestId};
    }
  }

  return {
    async onMessage(raw) {
      const parsed = toHostShape.safeParse(raw);
      if (!parsed.success) {
        const requestId = (raw as {requestId?: unknown} | null)?.requestId;
        if (typeof requestId === "number") post({type: "failed", requestId, code: "MODEL_FAILED"});
        return;
      }
      try { post(await run(parsed.data as ToHost)); }
      catch { post({type: "failed", requestId: parsed.data.requestId, code: "MODEL_FAILED"}); }
    },
    shutdown: unload
  };
}
```

`app/src/main/model/llamaBinding.ts`:
```ts
import {getLlama, LlamaChatSession, QwenChatWrapper} from "node-llama-cpp";
import type {ModelBinding} from "./hostCore";

/** The context is sized for one scenario (at most 24,000 characters) plus the prompts and the answer. */
const CONTEXT_TOKENS = 12_288;

/**
 * node-llama-cpp 3.21.1 with the settings spike S1 proved necessary:
 * - `QwenChatWrapper({thoughts: "discourage", variation: "3.5"})`: with default thinking the
 *   grammar-constrained answer starts inside a thought segment and is stripped;
 * - the answer is forced to the JSON form by a grammar and parsed by that same grammar.
 * Nothing here logs, and nothing here is reachable from the renderer.
 */
export function createLlamaBinding(): ModelBinding {
  return {
    async load(modelPath) {
      const llama = await getLlama();
      const model = await llama.loadModel({modelPath});
      return {
        async open(settings) {
          const context = await model.createContext({contextSize: CONTEXT_TOKENS});
          const session = new LlamaChatSession({
            contextSequence: context.getSequence(),
            chatWrapper: new QwenChatWrapper({thoughts: settings.thoughts, variation: settings.templateVariation}),
            systemPrompt: settings.systemPrompt
          });
          return {
            async ask(userText, form, maxTokens) {
              const grammar = await llama.createGrammarForJsonSchema(form as Parameters<typeof llama.createGrammarForJsonSchema>[0]);
              const answer = await session.prompt(userText, {grammar, maxTokens, temperature: settings.temperature});
              return grammar.parse(answer);
            },
            async close() { session.dispose(); await context.dispose(); }
          };
        },
        async dispose() { await model.dispose(); }
      };
    }
  };
}
```

`app/src/main/model/inProcessLink.ts`:
```ts
import {createHostCore, type ModelBinding} from "./hostCore";
import type {FromHost, HostLink} from "./protocol";

/**
 * A HostLink with no process behind it: the host core runs in the caller's process. Used by the
 * evaluation gate (a command-line run has no Electron to fork from). The desktop app never uses it:
 * there the model lives in a utility process so a native crash cannot take the app down.
 */
export function createInProcessLink(deps: {binding: ModelBinding; modelPath: string}): HostLink {
  let onMessage: (message: FromHost) => void = () => undefined;
  let alive = true;
  const core = createHostCore({binding: deps.binding, modelPath: deps.modelPath, post: (message) => { if (alive) queueMicrotask(() => onMessage(message)); }});
  return {
    send(message) { if (alive) void core.onMessage(message); },
    onMessage(cb) { onMessage = cb; },
    onExit() { /* nothing here can exit on its own: a native crash takes the whole command down */ },
    kill() { if (!alive) return; alive = false; void core.shutdown(); }
  };
}
```

`app/src/eval/gate.ts`:
```ts
import type {ModelPort} from "../core/types";
import {runSelfTest} from "../main/model/selfTest";
import {judgeReal, parseFixture, runFixture} from "./runFixture";

export interface GateResult { name: string; ok: boolean; problems: string[]; safety: boolean; seconds: number }
/**
 * `safe` is the hard requirement: no fixture let a forbidden string reach the model or leave, every
 * read was kept or skipped as expected, and nothing crashed. `passed` additionally wants the
 * quality expectations (how many statements, for which targets), which a real model at a non-zero
 * temperature misses now and then: those are tuning findings, not release blockers.
 */
export interface GateReport { selfTest: boolean; results: GateResult[]; safe: boolean; passed: boolean }

/** Problems from `judgeReal` that are about quality only. Everything else is a safety problem. */
const QUALITY = /^(digest size |unexpected target )/;
/** Adversarial fixtures differ from their originals only in the SCRIPTED model, which a real run ignores. */
const SCRIPT_ONLY = /^adversarial-/;

/**
 * The release gate: the self-test, then every fixture through the real pipeline with the given
 * model, judged by `judgeReal`. Problems are fixed phrases with indexes, never fixture text.
 */
export async function runGate(deps: {model: ModelPort; fixtures: {name: string; value: unknown}[]; now: () => number; onResult?: (result: GateResult) => void}): Promise<GateReport> {
  const selfTest = (await runSelfTest(deps.model)).ok;
  const results: GateResult[] = [];
  for (const {name, value} of deps.fixtures) {
    const started = deps.now();
    const fixture = parseFixture(value);
    if (fixture && SCRIPT_ONLY.test(fixture.category)) continue;
    let problems: string[];
    if (!fixture) problems = ["fixture is malformed"];
    else {
      try { problems = judgeReal(fixture, await runFixture(fixture, deps.model)); }
      catch { problems = ["run failed"]; }
    }
    const result = {name, ok: problems.length === 0, problems, safety: problems.some((p) => !QUALITY.test(p)), seconds: Math.round((deps.now() - started) / 1000)};
    results.push(result);
    deps.onResult?.(result);
  }
  return {selfTest, results, safe: selfTest && results.every((r) => !r.safety), passed: selfTest && results.every((r) => r.ok)};
}
```

`app/src/eval/gateCli.ts`:
```ts
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {createModelClient} from "../main/model/client";
import {createInProcessLink} from "../main/model/inProcessLink";
import {createLlamaBinding} from "../main/model/llamaBinding";
import {runGate} from "./gate";

/** usage: node dist/eval-gate.mjs <model.gguf> <fixtures dir>. Exit code: 0 everything passed, 2 safe but with quality findings, 1 a safety problem. */
async function main(): Promise<void> {
  const [modelPath, fixturesDir] = process.argv.slice(2);
  if (!modelPath || !fixturesDir) { process.stderr.write("usage: eval-gate <model.gguf> <fixtures dir>\n"); process.exit(2); }
  const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort()
    .map((name) => ({name, value: JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown}));
  const binding = createLlamaBinding();
  const client = createModelClient({spawn: () => createInProcessLink({binding, modelPath}), now: () => Date.now()});
  const report = await runGate({model: client, fixtures, now: () => Date.now(), onResult: (r) => {
    process.stdout.write(`${r.ok ? "PASS" : r.safety ? "FAIL" : "NOTE"}  ${r.name}  ${r.seconds}s${r.ok ? "" : `  ${r.problems.join("; ")}`}\n`);
  }});
  process.stdout.write(`self-test: ${report.selfTest ? "PASS" : "FAIL"}\n${report.passed ? "GATE PASSED" : report.safe ? "GATE SAFE, WITH QUALITY FINDINGS" : "GATE FAILED: SAFETY"}\n`);
  client.shutdown();
  process.exit(report.passed ? 0 : report.safe ? 2 : 1);
}
void main();
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/main/model/hostCore.test.ts src/eval/gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (583 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 5` — Expected: `mismatches: 0`.

---

### Task 6: The Electron shell

The only folder that imports `electron`. `app.ts` composes everything: single-instance lock (two instances would mean two sixty-minute buffers), no dock icon, a tray with the three states, one 420 x 600 sandboxed window that loads a local file and can navigate nowhere, the engine, the IPC wiring restricted to our own window's local page, lock/sleep events, and notifications. Electron has no battery level in the main process, so `batteryLevel.ts` reads `pmset`. Three more stand-ins make the app runnable and smoke-testable without the 2.7 GB model and without a Keychain dialog.

**Files:**
- Create: `app/src/standins/scriptedBinding.ts`, `app/src/standins/readyDownloader.ts`, `app/src/standins/smokeCipher.ts`, `app/src/shell/adapters.ts`, `app/src/shell/batteryLevel.ts`, `app/src/shell/modelHostEntry.ts`, `app/src/shell/preload.ts`, `app/src/shell/smoke.ts`, `app/src/shell/app.ts`
- Test: `app/src/shell/batteryLevel.test.ts`

**Interfaces:**
- Consumes: `createEngine`, `createIpcRouter`, `createModelClient`, `createDownloader`, `PINNED_MODEL`, `createNodeHttp`, `createNodeDownloadDisk`, `createNodeFs`, `dataPaths`, `systemLocalTime`, `parseTaxonomy`, `parseFrontWindow`, `createHostCore`, `createLlamaBinding`, `createDevReader`, `windowsFromFixture`, `createStubApi`, the channel lists of `shared/ipc.ts`.
- Produces: `createSafeStorageCipher(safeStorage)`, `createPowerSource(powerMonitor, battery)`, `createUtilityHostLink(fork)`; `parsePmset(output)`, `watchBattery(run)`, `BATTERY_POLL_MS`; `runSmoke(deps): Promise<string>` (`"SMOKE OK"` or a fixed `SMOKE_*` code); stand-ins `createScriptedBinding()`, `createReadyDownloader()`, `createSmokeCipher()`. Environment switches (dev only, ignored when packaged): `CLAVE_STANDINS=1`, `CLAVE_SCRIPTED_MODEL=1`, `CLAVE_SMOKE=1`, `CLAVE_DATA_DIR`, `CLAVE_FIXTURES`, `CLAVE_MODEL_URL`.

- [ ] **Step 1: Write the failing tests**

`app/src/shell/batteryLevel.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BATTERY_POLL_MS, parsePmset, watchBattery} from "./batteryLevel";

describe("battery level", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads the percentage out of pmset's output", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t83%; discharging; 4:12 remaining present: true")).toBe(0.83);
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged; 0:00 remaining")).toBe(1);
    expect(parsePmset("Now drawing from 'AC Power'")).toBeNull();
    expect(parsePmset("")).toBeNull();
  });

  it("polls once a minute, tells listeners only on a change, and survives a failing command", async () => {
    const outputs = ["\t50%;", "\t50%;", "\t19%;"];
    const changes = vi.fn();
    const battery = watchBattery(async () => { const next = outputs.shift(); if (next === undefined) throw new Error("pmset missing"); return next; });
    battery.onChange(changes);
    await vi.advanceTimersByTimeAsync(0);
    expect(battery.level()).toBe(0.5);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(changes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(battery.level()).toBe(0.19);
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(battery.level()).toBeNull();
    battery.stop();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/shell/batteryLevel.test.ts`
Expected: FAIL with `Cannot find module './batteryLevel'`.

- [ ] **Step 3: Implement**

`app/src/standins/scriptedBinding.ts`:
```ts
import type {ModelBinding} from "../main/model/hostCore";

const STATEMENT = "Reworked a slow database query by adding a supporting index and confirmed the improvement afterwards.";

/**
 * STAND-IN for the real model, so the app can be run and smoke-tested without the 2.7 GB file.
 * It says every scenario is professional and returns one fixed, clean statement for the first
 * target it was offered. Never part of a production build.
 */
export function createScriptedBinding(): ModelBinding & {readonly standIn: true} {
  return {
    standIn: true,
    async load() {
      return {
        async open() {
          return {
            async ask(_userText, form) {
              const properties = (form as {properties?: Record<string, unknown>}).properties ?? {};
              if ("is_professional" in properties) return {activity_summary: "Worked on a technical task.", is_professional: true, user_demonstrated_something: true};
              const evidence = properties["evidence"] as {items?: {properties?: {target_id?: {enum?: string[]}}}} | undefined;
              const target = evidence?.items?.properties?.target_id?.enum?.[0] ?? "";
              return {evidence: [{target_id: target, statement: STATEMENT}]};
            },
            async close() { /* nothing to free */ }
          };
        },
        async dispose() { /* nothing to free */ }
      };
    }
  };
}
```

`app/src/standins/readyDownloader.ts`:
```ts
import type {Downloader, DownloadState} from "../main/model/download";

/** STAND-IN: a model that is always "downloaded", for running with the scripted model. */
export function createReadyDownloader(): Downloader & {readonly standIn: true} {
  const state: DownloadState = {kind: "ready"};
  return {
    standIn: true, state: () => state, inspect: async () => state, start: async () => undefined, pause: () => undefined,
    filePath: () => "", removeAll: async () => undefined, onChange: () => () => undefined
  };
}
```

`app/src/standins/smokeCipher.ts`:
```ts
import type {Cipher} from "../main/ports/system";

/**
 * STAND-IN for the Keychain, used only by the automated smoke run so that no Keychain dialog can
 * block it. It scrambles, it does not protect. Never part of a production build.
 */
export function createSmokeCipher(): Cipher & {readonly standIn: true} {
  const flip = (bytes: Uint8Array) => bytes.map((b) => b ^ 0xa5);
  return {
    standIn: true, available: () => true,
    encrypt: (plain) => flip(new TextEncoder().encode(plain)),
    decrypt: (data) => new TextDecoder().decode(flip(data))
  };
}
```

`app/src/shell/adapters.ts`:
```ts
import type {Notification as ElectronNotification, PowerMonitor, SafeStorage, UtilityProcess} from "electron";
import type {FromHost, HostLink, ToHost} from "../main/model/protocol";
import type {Cipher} from "../main/ports/system";
import type {PowerSource, ThermalState} from "../main/power";

/** Electron `safeStorage` (the macOS Keychain) as the engine's Cipher. */
export function createSafeStorageCipher(safeStorage: SafeStorage): Cipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data))
  };
}

const THERMAL: readonly ThermalState[] = ["nominal", "fair", "serious", "critical"];

/**
 * Electron has no battery level in the main process, so the level comes from `readBatteryLevel`
 * (on macOS: `pmset -g batt`, see `batteryLevel.ts`), refreshed by the caller. Everything else is
 * `powerMonitor`.
 */
export function createPowerSource(powerMonitor: PowerMonitor, battery: {level: () => number | null; onChange: (cb: () => void) => () => void}): PowerSource {
  return {
    onBattery: () => powerMonitor.isOnBatteryPower(),
    batteryLevel: battery.level,
    thermalState() {
      const state = powerMonitor.getCurrentThermalState?.();
      return (THERMAL as readonly string[]).includes(state as string) ? (state as ThermalState) : "unknown";
    },
    subscribe(cb) {
      const events = ["on-ac", "on-battery", "thermal-state-change"] as const;
      for (const name of events) powerMonitor.on(name as "on-ac", cb);
      const stopBattery = battery.onChange(cb);
      return () => { for (const name of events) powerMonitor.removeListener(name as "on-ac", cb); stopBattery(); };
    }
  };
}

/** One model host in a utility process. `fork` is Electron's `utilityProcess.fork`, already bound to the host script. */
export function createUtilityHostLink(fork: () => UtilityProcess): HostLink {
  const child = fork();
  return {
    send(message: ToHost) { child.postMessage(message); },
    onMessage(cb) { child.on("message", (message: unknown) => cb(message as FromHost)); },
    onExit(cb) { child.once("exit", () => cb()); },
    kill() { child.kill(); }
  };
}

export type NotificationCtor = new (options: {title: string; body: string; silent?: boolean}) => ElectronNotification;
```

`app/src/shell/batteryLevel.ts`:
```ts
/** Parses `pmset -g batt` ("... 83%; discharging; ..."). `null` when there is no battery or the output is not understood. */
export function parsePmset(output: string): number | null {
  const match = /(\d{1,3})%/.exec(output);
  if (!match) return null;
  const percent = Number(match[1]);
  return percent >= 0 && percent <= 100 ? percent / 100 : null;
}

export const BATTERY_POLL_MS = 60_000;

/** Polls the battery level once a minute. `run` executes `pmset -g batt` and resolves with its output. */
export function watchBattery(run: () => Promise<string>): {level: () => number | null; onChange: (cb: () => void) => () => void; stop: () => void} {
  let level: number | null = null;
  const listeners = new Set<() => void>();
  const read = async () => {
    const next = parsePmset(await run().catch(() => ""));
    if (next !== level) { level = next; for (const cb of listeners) cb(); }
  };
  void read();
  const timer = setInterval(() => { void read(); }, BATTERY_POLL_MS);
  return {level: () => level, onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }, stop: () => clearInterval(timer)};
}
```

`app/src/shell/modelHostEntry.ts`:
```ts
import {createHostCore} from "../main/model/hostCore";
import {createLlamaBinding} from "../main/model/llamaBinding";
import {createScriptedBinding} from "../standins/scriptedBinding";

/**
 * Entry point of the model's utility process. argv: <model path | "scripted">.
 * It talks to main over `process.parentPort` only, writes nothing to stdout, and holds no file
 * handles besides the model.
 */
interface ParentPort { on(event: "message", cb: (event: {data: unknown}) => void): void; postMessage(message: unknown): void }
const port = (process as unknown as {parentPort: ParentPort}).parentPort;
const modelPath = process.argv[2] ?? "";
const core = createHostCore({
  binding: modelPath === "scripted" ? createScriptedBinding() : createLlamaBinding(),
  modelPath,
  post: (message) => port.postMessage(message)
});
port.on("message", (event) => { void core.onMessage(event.data); });
```

`app/src/shell/preload.ts`:
```ts
import {contextBridge, ipcRenderer} from "electron";
import {eventName, EVENT_CHANNELS, INVOKE_CHANNELS, invokeName, type ClaveBridge, type EventChannel} from "../shared/ipc";

/** Exactly the ClaveBridge and nothing else: no ipcRenderer, no Node, no paths. */
const bridge: Record<string, unknown> = {};
for (const channel of INVOKE_CHANNELS) bridge[channel] = (...args: unknown[]) => ipcRenderer.invoke(invokeName(channel), ...args);

const listen = (channel: EventChannel) => (cb: (payload: unknown) => void) => {
  const handler = (_event: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(eventName(channel), handler);
  return () => { ipcRenderer.removeListener(eventName(channel), handler); };
};
bridge["onStatus"] = listen(EVENT_CHANNELS[0]);
bridge["onDownload"] = listen(EVENT_CHANNELS[1]);

contextBridge.exposeInMainWorld("clave", bridge as unknown as ClaveBridge);
```

`app/src/shell/smoke.ts`:
```ts
import {readFileSync} from "node:fs";
import type {BrowserWindow} from "electron";
import type {Engine} from "../main/engine";
import type {IpcRouter} from "../main/ipcRouter";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(250); }
  return false;
}

/**
 * The end-to-end smoke test, run inside the real app with the stand-ins and the scripted model:
 * the window loads, the preload bridge answers from the renderer's side, a stretch of replayed
 * work becomes a statement, approving it uploads it to the stub. Returns "SMOKE OK" or a fixed
 * failure code.
 */
export async function runSmoke(deps: {engine: Engine; router: IpcRouter; window: () => BrowserWindow | null; uploadsPath: string}): Promise<string> {
  const {engine, router} = deps;
  const window = deps.window();
  if (!window) return "SMOKE_NO_WINDOW";
  if (!(await until(() => !window.webContents.isLoading(), 15_000))) return "SMOKE_WINDOW_DID_NOT_LOAD";
  const bridged = await window.webContents.executeJavaScript("window.clave.status().then((s) => typeof s.capture)").catch(() => null);
  if (bridged !== "string") return "SMOKE_BRIDGE_MISSING";
  const leaked = await window.webContents.executeJavaScript("typeof window.require + typeof window.process + typeof window.ipcRenderer").catch(() => null);
  if (leaked !== "undefinedundefinedundefined") return "SMOKE_RENDERER_HAS_NODE";

  if (!((await router.handle("signIn", ["smoke", "smoke"])) as {ok: boolean}).ok) return "SMOKE_SIGN_IN_FAILED";
  if (!((await router.handle("selfTest", [])) as {ok: boolean}).ok) return "SMOKE_SELF_TEST_FAILED";
  if (!((await router.handle("setCapture", [true])) as {ok: boolean}).ok) return `SMOKE_BLOCKED_${engine.status().blockers.join("_")}`;
  await wait(9_000);                                   // the dev reader walks through its windows
  await router.handle("setCapture", [false]);          // switching off closes the scenario at once
  if (!(await until(() => engine.status().pending > 0, 30_000))) return "SMOKE_NO_STATEMENT";
  const pending = engine.review().pending[0];
  if (!pending || !(await router.handle("approve", [pending.id]))) return "SMOKE_APPROVE_FAILED";
  if (!(await until(() => engine.review().sent.length === 1, 10_000))) return "SMOKE_NOT_UPLOADED";
  const uploaded = readFileSync(deps.uploadsPath, "utf8").trim().split("\n");
  return uploaded.length === 1 && uploaded[0]?.includes(pending.statement) ? "SMOKE OK" : "SMOKE_UPLOAD_MISMATCH";
}
```

`app/src/shell/app.ts`:
```ts
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, shell, Tray, utilityProcess} from "electron";
import {createEngine, type Engine, type EngineStatus} from "../main/engine";
import {createIpcRouter} from "../main/ipcRouter";
import {createModelClient} from "../main/model/client";
import {createDownloader, PINNED_MODEL, type Downloader} from "../main/model/download";
import {createNodeDownloadDisk, createNodeHttp} from "../main/model/nodeDownload";
import {parseTaxonomy, type ClaveApi} from "../main/ports/claveApi";
import {parseFrontWindow, type Reader} from "../main/ports/reader";
import {systemLocalTime} from "../main/review/scheduler";
import {createNodeFs} from "../main/storage/nodeFs";
import {dataPaths} from "../main/storage/paths";
import {EVENT_CHANNELS, eventName, INVOKE_CHANNELS, invokeName} from "../shared/ipc";
import {createDevReader, windowsFromFixture} from "../standins/devReader";
import {createReadyDownloader} from "../standins/readyDownloader";
import {createSmokeCipher} from "../standins/smokeCipher";
import {createStubApi} from "../standins/stubApi";
import {createPowerSource, createSafeStorageCipher, createUtilityHostLink} from "./adapters";
import {watchBattery} from "./batteryLevel";
import {runSmoke} from "./smoke";

const APP_NAME = "Clave Agent";                       // also a built-in exclusion of the core: the app never reads itself
const WINDOW = {width: 420, height: 600};
const MODEL_URL = process.env["CLAVE_MODEL_URL"] ?? "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf";
const here = (file: string) => join(__dirname, file);

/**
 * Until sub-projects C (native reader) and D (clave-back) exist the app can only run with the
 * stand-ins, and only outside a packaged build. `createEngine` refuses stand-ins when `production`.
 */
const STANDINS = process.env["CLAVE_STANDINS"] === "1" && !app.isPackaged;
const SCRIPTED_MODEL = STANDINS && process.env["CLAVE_SCRIPTED_MODEL"] === "1";
const SMOKE = STANDINS && process.env["CLAVE_SMOKE"] === "1";

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let engine: Engine | null = null;
let quitting = false;

function standIns(dataDir: string): {reader: Reader; api: ClaveApi} {
  const fixturesDir = process.env["CLAVE_FIXTURES"] ?? join(app.getAppPath(), "..", "eval", "fixtures");
  const fixture = JSON.parse(readFileSync(join(fixturesDir, "01-work-english.json"), "utf8")) as unknown;
  const taxonomy = parseTaxonomy(JSON.parse(readFileSync(here("standins-taxonomy.json"), "utf8")));
  if (!taxonomy) throw new Error("STANDIN_TAXONOMY_INVALID");
  return {
    reader: createDevReader(windowsFromFixture(fixture), 1_500),
    api: createStubApi({fs: createNodeFs(), uploadsPath: join(dataDir, "stub-uploads.jsonl"), taxonomy, now: () => Date.now()})
  };
}

function showWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    ...WINDOW, resizable: false, fullscreenable: false, show: false, title: APP_NAME,
    webPreferences: {preload: here("preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged}
  });
  // The renderer is a local file and never navigates anywhere or opens anything.
  window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest((details, respond) => {
    respond({cancel: !(details.url.startsWith("file://") || details.url.startsWith("devtools://"))});
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  void window.loadFile(here("renderer/index.html"));
}

const TRAY_TITLE: Record<"on" | "off" | "problem", string> = {on: "\u25CF", off: "\u25CB", problem: "!"};
function trayState(status: EngineStatus): "on" | "off" | "problem" {
  if (status.capture === "on") return "on";
  return status.blockers.some((b) => b.endsWith("_PROBLEM") || b === "NO_PERMISSION" || b === "SIGNED_OUT") ? "problem" : "off";
}

function refreshTray(status: EngineStatus): void {
  if (!tray || !engine) return;
  const current = engine;
  tray.setTitle(TRAY_TITLE[trayState(status)] + (status.pending > 0 ? ` ${status.pending}` : ""));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: status.capture === "on" ? "Reading is on" : "Reading is off", type: "checkbox", checked: status.capture === "on",
      click: () => { void current.setCapture(status.capture !== "on").then((r) => { if (!r.ok) showWindow(); }); }},
    {label: `Review (${status.pending})`, click: showWindow},
    {label: "Pause for 1 hour", enabled: status.capture === "on", click: () => { void current.pauseForAnHour(); }},
    {type: "separator"},
    {label: "Settings", click: showWindow},
    {label: "Quit", click: () => app.quit()}
  ]));
}

async function start(): Promise<void> {
  if (process.platform === "darwin") app.dock?.hide();
  const dataDir = process.env["CLAVE_DATA_DIR"] ?? app.getPath("userData");
  const paths = dataPaths(dataDir);
  if (!STANDINS) throw new Error("NO_READER_YET");      // sub-projects C and D replace the stand-ins; nothing else can run

  const {reader, api} = standIns(dataDir);
  const downloader: Downloader = SCRIPTED_MODEL
    ? createReadyDownloader()
    : createDownloader({http: createNodeHttp(), disk: createNodeDownloadDisk(), dir: paths.modelDir, spec: {...PINNED_MODEL, url: MODEL_URL}});
  await downloader.inspect();

  const model = createModelClient({
    now: () => Date.now(),
    spawn: () => createUtilityHostLink(() => utilityProcess.fork(here("model-host.mjs"), [SCRIPTED_MODEL ? "scripted" : downloader.filePath()], {serviceName: "Clave model"}))
  });

  const battery = watchBattery(() => new Promise((resolve, reject) => execFile("/usr/bin/pmset", ["-g", "batt"], (error, stdout) => (error ? reject(error) : resolve(stdout)))));
  let recentApp: string | null = null;
  reader.onFocusChange(() => { void reader.frontWindow().then((front) => { const w = parseFrontWindow(front); if (w && w.app !== APP_NAME) recentApp = w.app; }).catch(() => undefined); });

  engine = await createEngine({
    reader, api, model, downloader, fs: createNodeFs(), cipher: SMOKE ? createSmokeCipher() : createSafeStorageCipher(safeStorage), dataDir,
    power: createPowerSource(powerMonitor, battery),
    // An unattended smoke run has nobody at the keyboard; without this the loop would (correctly) treat the user as away and read nothing.
    idleSeconds: () => (SMOKE ? 0 : powerMonitor.getSystemIdleTime()),
    now: () => Date.now(), local: systemLocalTime, newId: () => randomUUID(),
    appVersion: app.getVersion(), modelSha256: SCRIPTED_MODEL ? "scripted" : PINNED_MODEL.sha256, production: app.isPackaged,
    notifyReview: (count) => {
      const note = new Notification({title: APP_NAME, body: count === 1 ? "1 statement to review" : `${count} statements to review`});
      note.on("click", showWindow);
      note.show();
    },
    notifyCaptureResumed: () => new Notification({title: APP_NAME, body: "Reading is on, as you left it.", silent: true}).show()
  });
  const current = engine;

  const router = createIpcRouter({
    engine: current, downloader, reader, recentApp: () => recentApp,
    appInfo: {version: app.getVersion(), modelSha256: PINNED_MODEL.sha256, modelSizeBytes: PINNED_MODEL.sizeBytes, standIns: STANDINS},
    openWhatLeaves: async () => { await shell.openPath(here("WHAT-LEAVES.md")); },
    restartApp: () => { app.relaunch(); app.quit(); }
  });
  // Only our own window may call in, and only while it shows our own local page.
  const trusted = (sender: Electron.WebContents, url: string | undefined) => window !== null && sender === window.webContents && (url ?? "").startsWith("file://");
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(invokeName(channel), (event, ...args: unknown[]) => {
      if (!trusted(event.sender, event.senderFrame?.url)) throw new Error("BAD_SENDER");
      return router.handle(channel, args);
    });
  }
  router.subscribe((channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send(eventName(channel), payload); });
  void EVENT_CHANNELS;

  powerMonitor.on("lock-screen", () => current.system("locked"));
  powerMonitor.on("unlock-screen", () => current.system("unlocked"));
  powerMonitor.on("suspend", () => current.system("suspend"));
  powerMonitor.on("resume", () => current.system("resume"));

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip(APP_NAME);
  current.onStatus(refreshTray);
  refreshTray(current.status());
  showWindow();

  if (SMOKE) {
    const result = await runSmoke({engine: current, router, window: () => window, uploadsPath: join(dataDir, "stub-uploads.jsonl")});
    process.stdout.write(`${result}\n`);
    quitting = true;
    await current.quit();
    battery.stop();
    app.exit(result === "SMOKE OK" ? 0 : 1);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();      // two instances would mean two sixty-minute buffers
else {
  app.setName(APP_NAME);
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => { /* the tray keeps the app alive */ });
  app.on("before-quit", (event) => {
    if (quitting || !engine) return;
    event.preventDefault();
    quitting = true;
    void engine.quit().finally(() => app.quit());
  });
  void app.whenReady().then(start).catch((error: unknown) => {
    process.stderr.write(`START_FAILED ${error instanceof Error ? error.message.replace(/[^A-Z_]/g, "") : ""}\n`);
    app.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/shell/batteryLevel.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (585 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 6` — Expected: `mismatches: 0`.
Run: `pnpm --dir app smoke` — Expected: the last line printed is `SMOKE OK` and the exit code is 0 (about 25 seconds). It launches the real app with the stand-ins and the scripted model: the window loads, `window.clave` answers from the renderer's side and has no Node in it, the model runs in a utility process, replayed work becomes a statement, approving it uploads it to the stub. Any `SMOKE_*` code is a failure: report it, do not edit `smoke.ts`.

---

### Task 7: Renderer foundation: every sentence, and the decisions behind the screens

All user-facing text in one file, with the five claims checked against the overall plan, and the screens' decisions as pure functions: which onboarding step to show (machine-checked steps follow the real state, so onboarding resumes correctly and goes back when something was undone), which screen to open, download progress, review rows. A guard test keeps the renderer away from `main/`, `core/`, `shell/` and `standins/` except through `import type`, and away from anything remote.

**Files:**
- Create: `app/src/renderer/copy.ts`, `app/src/renderer/model/views.ts`
- Test: `app/src/renderer/model/views.test.ts`

**Interfaces:**
- Consumes: `Blocker`, `DownloadState`, `EngineStatus`, `ReviewView`, `UserSettings` from `shared/ipc.ts` (types only).
- Produces: `CLAIMS`, `KNOWN_LIMITS`, `BLOCKERS: Record<Blocker, {sentence, action}>`, `COPY`; `STEPS`, `Step`, `onboardingStep(status, settings)`, `Screen`, `startScreen(status, settings)`, `firstBlocker(status)`, `downloadView(state, sizeBytes)`, `reviewRows(view, localDay)`, `gigabytes(bytes)`.

- [ ] **Step 1: Write the failing tests**

`app/src/renderer/model/views.test.ts`:
```ts
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {EngineStatus, UserSettings} from "../../shared/ipc";
import {BLOCKERS, CLAIMS} from "../copy";
import {downloadView, firstBlocker, gigabytes, onboardingStep, reviewRows, startScreen} from "./views";

const status = (blockers: EngineStatus["blockers"], pending = 0): EngineStatus => ({capture: "off", resumeAt: null, blockers, extractionPaused: null, pending, waitingUpload: 0});
const settings = (onboardingStep: number): UserSettings => ({exclusions: [], excludedSites: [], reviewTime: "17:30", captureOn: false, onboardingStep});

describe("the pitch", () => {
  it("uses the five claims verbatim from the overall plan", () => {
    const plan = readFileSync(new URL("../../../../docs/implementation-plan.md", import.meta.url), "utf8");
    const section = plan.slice(plan.indexOf("The claims:"), plan.indexOf("What we do not claim anywhere"));
    const canonical = [...section.matchAll(/^\d\. ([\s\S]*?)(?=^\d\. |\s*$(?![\s\S]))/gm)].map((m) => (m[1] as string).replace(/\s+/g, " ").trim());
    expect(canonical).toHaveLength(5);
    expect([...CLAIMS]).toEqual(canonical);
  });

  it("has a sentence and one fix button for every blocker", () => {
    for (const copy of Object.values(BLOCKERS)) { expect(copy.sentence.length).toBeGreaterThan(10); expect(copy.action.length).toBeGreaterThan(2); }
    expect(Object.keys(BLOCKERS)).toHaveLength(10);
  });
});

describe("onboarding", () => {
  it("walks the spec's order, and the machine-checked steps follow the real state", () => {
    expect(onboardingStep(status(["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]), settings(0))).toBe("pitch");
    expect(onboardingStep(status(["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]), settings(1))).toBe("signIn");
    expect(onboardingStep(status(["MODEL_MISSING", "NO_PERMISSION"]), settings(1))).toBe("model");
    expect(onboardingStep(status(["SELF_TEST_NEEDED", "NO_PERMISSION"]), settings(1))).toBe("model");
    expect(onboardingStep(status(["PERMISSION_NEEDS_RESTART"]), settings(1))).toBe("permission");
    expect(onboardingStep(status([]), settings(1))).toBe("neverRead");
    expect(onboardingStep(status([]), settings(5))).toBe("reviewTime");
    expect(onboardingStep(status([]), settings(6))).toBe("done");
  });

  it("goes back to a machine-checked step when something was undone, however far the user had come", () => {
    expect(onboardingStep(status(["SIGNED_OUT"]), settings(6))).toBe("signIn");
    expect(onboardingStep(status(["NO_PERMISSION"]), settings(6))).toBe("permission");
  });

  it("owns the window until it is finished, then opens on review when there is something to review", () => {
    expect(startScreen(status([]), settings(3))).toBe("onboarding");
    expect(startScreen(status([], 4), settings(6))).toBe("review");
    expect(startScreen(status([]), settings(6))).toBe("home");
    expect(firstBlocker(status(["MODEL_PROBLEM", "STORAGE_PROBLEM"]))).toBe("MODEL_PROBLEM");
    expect(firstBlocker(status([]))).toBeNull();
  });
});

describe("download and review views", () => {
  it("turns download states into a phase and a percentage", () => {
    expect(downloadView({kind: "missing"}, 1000)).toEqual({phase: "idle", percent: 0, errorCode: null});
    expect(downloadView({kind: "downloading", receivedBytes: 255}, 1000)).toMatchObject({phase: "running", percent: 25});
    expect(downloadView({kind: "partial", receivedBytes: 999}, 1000)).toMatchObject({phase: "paused", percent: 99});
    expect(downloadView({kind: "downloading", receivedBytes: 5000}, 1000).percent).toBe(100);
    expect(downloadView({kind: "error", code: "DOWNLOAD_BAD_HASH"}, 1000)).toMatchObject({phase: "error", errorCode: "DOWNLOAD_BAD_HASH"});
    expect(gigabytes(2_740_937_888)).toBe("2.7");
  });

  it("lists statements in the engine's order with the target's name and the day", () => {
    const rows = reviewRows({pending: [{id: "a", kind: "skill", targetId: "pg", targetName: "PostgreSQL", statement: "Rebuilt an index.", createdAt: Date.UTC(2026, 8, 17, 9), taxonomyVersion: "t", pipelineVersion: "1"}], waitingUpload: [], sent: []},
      (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(rows).toEqual([{id: "a", statement: "Rebuilt an index.", target: "PostgreSQL", kind: "skill", day: "2026-09-17"}]);
  });
});

describe("what the renderer may import", () => {
  const ROOT = new URL("..", import.meta.url).pathname;
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !name.includes(".test.") ? [path] : [];
  });
  it.each(files(ROOT))("%s reaches main/ and core/ through types only, and nothing remote", (file) => {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
      const [, typeOnly, target] = match;
      if (/\/(main|core|shell|standins)\//.test(target as string) || /^electron$|^node:/.test(target as string)) expect(typeOnly, `${file} imports ${target}`).toBeTruthy();
    }
    expect(source).not.toMatch(/https?:\/\//);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --dir app exec vitest run src/renderer/model/views.test.ts`
Expected: FAIL with `Cannot find module '../copy'`.

- [ ] **Step 3: Implement**

`app/src/renderer/copy.ts`:
```ts
import type {Blocker} from "../shared/ipc";

/**
 * Every sentence the user can read lives in this file, so the pitch is identical everywhere and
 * can be reviewed in one place. The five claims are verbatim from docs/implementation-plan.md
 * ("One pitch for every platform"); a test keeps them that way.
 */
export const CLAIMS: readonly string[] = [
  "You switch it on and off yourself. It never runs unless you started it.",
  "It reads the text on your screen. Anything it captures to do that is deleted within seconds. Nothing older than an hour exists anywhere, and nothing is stored on disk.",
  "It never looks at the apps and sites you exclude, or at private browser windows it can recognise.",
  "Nothing reaches your profile until you read it and say yes. It names no one else.",
  "It works with your Wi-Fi off. Only the short statements you approve ever leave."
];

/** Stated plainly in onboarding (spec section 7, step 5). */
export const KNOWN_LIMITS: readonly string[] = [
  "It cannot recognise a confidential fact that is phrased in ordinary words.",
  "It does not recognise a name written entirely in capital letters.",
  "That is why nothing leaves until you have read it and said yes."
];

export interface BlockerCopy { sentence: string; action: string }
export const BLOCKERS: Record<Blocker, BlockerCopy> = {
  SIGNED_OUT: {sentence: "You are signed out.", action: "Sign in"},
  NO_TAXONOMY: {sentence: "The list of skills has not been downloaded yet.", action: "Try again"},
  MODEL_MISSING: {sentence: "The model has not been downloaded yet.", action: "Download the model"},
  SELF_TEST_NEEDED: {sentence: "The model has not been checked on this machine yet.", action: "Check it now"},
  NO_PERMISSION: {sentence: "Screen Recording is switched off for this app.", action: "Open System Settings"},
  PERMISSION_NEEDS_RESTART: {sentence: "Screen Recording is on. The app needs a restart to use it.", action: "Restart now"},
  SETTINGS_NEED_REVIEW: {sentence: "Your settings could not be read and were reset. Please check what is excluded.", action: "Open Settings"},
  MODEL_PROBLEM: {sentence: "The model stopped working several times in a row.", action: "Try again"},
  READER_PROBLEM: {sentence: "Reading the screen failed several times in a row.", action: "Try again"},
  STORAGE_PROBLEM: {sentence: "The disk refused a write, so reading is paused.", action: "Try again"}
};

export const COPY = {
  appName: "Clave Agent",
  review: {title: "Today's evidence", empty: "Nothing to review today.", approve: "Approve", reject: "Reject",
    waiting: (n: number) => `Waiting to upload (${n})`, sent: "Sent"},
  tray: {on: "Reading is on", off: "Reading is off", pause: "Pause for 1 hour"},
  onboarding: {
    download: (gigabytes: string) => `Download the model (${gigabytes} GB)`,
    checking: "Checking it works on your machine",
    permission: "macOS will ask you to allow Screen Recording. After you allow it, the app has to restart once.",
    neverRead: "What is never read", privateWindows: "Private browser windows are always skipped.",
    reviewTime: "When should I show you today's evidence?", done: "All set. Reading stays off until you switch it on."
  },
  settings: {addCurrent: (app: string) => `Exclude ${app}`, deleteAll: "Delete all local data", alsoModel: "Also remove the model", signOut: "Sign out"}
} as const;
```

`app/src/renderer/model/views.ts`:
```ts
import type {Blocker, DownloadState, EngineStatus, ReviewView, UserSettings} from "../../shared/ipc";

/** The onboarding steps of spec section 7, in order. */
export const STEPS = ["pitch", "signIn", "model", "permission", "neverRead", "reviewTime", "done"] as const;
export type Step = typeof STEPS[number];

/**
 * Which onboarding step to show. Steps that the machine can verify (signed in, model ready and
 * checked, permission) are decided by the real state, not by a stored number, so onboarding
 * resumes correctly after a restart or after something was undone. Steps that are only "seen"
 * (pitch, never-read, review time) use `onboardingStep`: the index of the last step the user finished.
 */
export function onboardingStep(status: EngineStatus, settings: UserSettings): Step {
  const seen = settings.onboardingStep;
  const has = (b: Blocker) => status.blockers.includes(b);
  if (seen < 1) return "pitch";
  if (has("SIGNED_OUT")) return "signIn";
  if (has("MODEL_MISSING") || has("SELF_TEST_NEEDED")) return "model";
  if (has("NO_PERMISSION") || has("PERMISSION_NEEDS_RESTART")) return "permission";
  if (seen < 5) return "neverRead";
  if (seen < 6) return "reviewTime";
  return "done";
}

export type Screen = "onboarding" | "home" | "review" | "settings";
/** Onboarding owns the window until it is finished; after that the tabs are free. */
export const startScreen = (status: EngineStatus, settings: UserSettings): Screen =>
  (settings.onboardingStep < STEPS.length - 1 ? "onboarding" : status.pending > 0 ? "review" : "home");

/** The one problem shown on the home screen: the first blocker, in the engine's order. `null` when capture may run. */
export const firstBlocker = (status: EngineStatus): Blocker | null => status.blockers[0] ?? null;

export interface DownloadView { phase: "idle" | "running" | "paused" | "verifying" | "ready" | "error"; percent: number; errorCode: string | null }
export function downloadView(state: DownloadState, sizeBytes: number): DownloadView {
  const percent = (bytes: number) => (sizeBytes > 0 ? Math.min(100, Math.floor((bytes / sizeBytes) * 100)) : 0);
  switch (state.kind) {
    case "missing": return {phase: "idle", percent: 0, errorCode: null};
    case "partial": return {phase: "paused", percent: percent(state.receivedBytes), errorCode: null};
    case "downloading": return {phase: "running", percent: percent(state.receivedBytes), errorCode: null};
    case "verifying": return {phase: "verifying", percent: 100, errorCode: null};
    case "ready": return {phase: "ready", percent: 100, errorCode: null};
    case "error": return {phase: "error", percent: 0, errorCode: state.code};
  }
}

export interface ReviewRow { id: string; statement: string; target: string; kind: "skill" | "competency"; day: string }
/** Rows in the engine's order. `day` is the local calendar day the statement was captured. */
export function reviewRows(view: ReviewView, localDay: (epochMs: number) => string): ReviewRow[] {
  return view.pending.map((p) => ({id: p.id, statement: p.statement, target: p.targetName, kind: p.kind, day: localDay(p.createdAt)}));
}

export const gigabytes = (bytes: number): string => (bytes / 1_000_000_000).toFixed(1);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --dir app exec vitest run src/renderer/model/views.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (595 in total).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md 7` — Expected: `mismatches: 0`.

---

### Task 8: The four screens (built with the frontend-design skill)

**REQUIRED SUB-SKILL for this task: `frontend-design`** (owner's instruction, spec decision 8). Load it before writing any component and commit to ONE deliberate aesthetic direction for all four screens. This task has no pre-written component code on purpose: the look is a design decision made here, with the skill. Everything the screens DECIDE is already written and tested (Task 7); this task renders it.

**Files:**
- Replace: `app/src/renderer/main.tsx`
- Create: `app/src/renderer/App.tsx`, `app/src/renderer/bridge.ts` (`export const clave = window.clave` typed as `ClaveBridge`, plus a `useStatus()` / `useDownload()` hook pair built on `onStatus` / `onDownload`), `app/src/renderer/screens/Onboarding.tsx`, `Home.tsx`, `Review.tsx`, `Settings.tsx`, `app/src/renderer/styles.css` (imported from `main.tsx`; add `".css": "css"` handling only if esbuild needs it), bundled font files under `app/src/renderer/assets/`
- Modify: `app/src/renderer/index.html` only to link the bundled stylesheet that esbuild emits (`./main.css`), keeping the Content-Security-Policy as strict as it is

**Interfaces:**
- Consumes: `window.clave: ClaveBridge` (Task 3), `copy.ts` and `model/views.ts` (Task 7). No other way to reach main exists.
- Produces: the finished window.

**Requirements (each one is checked in Step 4):**
1. Screens and order exactly as spec section 7. Onboarding shows `onboardingStep(status, settings)`; finishing a "seen" step calls `updateSettings({onboardingStep: n})` with n = 1 after the pitch, 5 after "never read", 6 after the review time. The pitch shows the five `CLAIMS` verbatim and a link that calls `openWhatLeaves()`. The model step shows the size (`gigabytes(appInfo.modelSizeBytes)`) before the button, progress from `downloadView`, pause and resume, then `COPY.onboarding.checking` while `selfTest()` runs. The permission step says the app must restart, calls `requestPermission()`, polls `recheckPermission()`, and offers `restartApp()` on `needsRestart`. "Never read" lists exclusions and excluded sites, editable in place, states that private windows are always skipped, and shows `KNOWN_LIMITS`. Review time defaults to 17:30. The last step leaves capture off.
2. Home: the on/off switch (`setCapture`; when it answers `{ok: false}` show the first blocker), "Pause for 1 hour", and, when `firstBlocker(status)` is not null, exactly one sentence and one button from `BLOCKERS`. The button does the matching thing: sign in, `downloadStart`, `selfTest`, open onboarding's permission step, `restartApp`, open Settings and call `settingsOpened()`, `retry("model")`, `retry("reader")`, or for `STORAGE_PROBLEM` and `NO_TAXONOMY` simply re-read the status.
3. Review: at most ten rows from `reviewRows`; each row shows the statement, the target name, the day, and **Approve** and **Reject** with equal visual weight, no pre-selected action, no "approve all", no way to edit. Below: "Waiting to upload (n)" and the "Sent" log. Empty state `COPY.review.empty`.
4. Settings: excluded apps with `COPY.settings.addCurrent(recentApp)` when `recentApp()` is not null, excluded sites, review time, sign out, delete all local data with the "also remove the model" checkbox and a confirmation, About (version, model hash, link to `WHAT-LEAVES.md`). Opening the screen calls `settingsOpened()`. Validation problems from `updateSettings` are shown next to the field. Nothing else.
5. Every sentence comes from `copy.ts`. No text literal in a component except punctuation.
6. Light and dark appearance (`prefers-color-scheme`), a fixed 420 x 600 window with its own scrolling regions, fully keyboard operable with visible focus, semantic HTML, `aria-live` for status changes.
7. Nothing remote: fonts are files in `assets/` bundled by esbuild. The `views.test.ts` guard (no `http://` or `https://` in renderer sources, types-only imports from main) must stay green. Add no package.
8. The renderer never sees screen text: it shows only what `ClaveBridge` returns.

- [ ] **Step 1: Load the `frontend-design` skill, choose the direction, and write it down** in a comment at the top of `styles.css` (tone, type pairing, palette as CSS variables, the one memorable element). A calm, trustworthy, precise tone fits a privacy tool; avoid generic defaults.
- [ ] **Step 2: Build `bridge.ts`, `App.tsx` and the four screens** against the requirements above.
- [ ] **Step 3: Typecheck and build.** Run: `pnpm --dir app typecheck` and `pnpm --dir app build`. Expected: no errors.
- [ ] **Step 4: Look at it.** Run `pnpm --dir app start:scripted`, walk through onboarding, approve and reject a statement, open Settings, toggle dark mode, and drive the whole window with the keyboard only. Check each numbered requirement and note the result in the report, with screenshots of the four screens in both appearances.
- [ ] **Step 5: Checkpoint**

Run: `pnpm --dir app test` — Expected: all tests pass (the Task 7 total, plus any you added for new pure helpers).
Run: `pnpm --dir app typecheck` — Expected: no errors.
Run: `pnpm --dir app smoke` — Expected: `SMOKE OK` (the smoke run does not depend on the UI, but the page must still load and expose `window.clave`).

---

### Task 9: Release-gate run and hand-over

**Files:**
- Modify: `docs/HANDOFF.md` (state of sub-project B), `eval/README.md` (how to run the gate)

- [ ] **Step 1: Run the real-model gate** if the model file is on this machine (`~/.cache/clave-agent/models/hf_unsloth_Qwen3.5-4B.Q4_K_M.gguf`, SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`):
`pnpm --dir app eval:gate -- "$HOME/.cache/clave-agent/models/hf_unsloth_Qwen3.5-4B.Q4_K_M.gguf" eval/fixtures`
It takes about two minutes on an M2. Exit code 0 (everything passed) or 2 (safe, with quality findings) is acceptable; record every `NOTE` line in the report as a tuning finding for the owner. **Exit code 1 (a `FAIL` line) is a safety problem: stop and report it.** If the file is not there, say so and skip; do not download it.
- [ ] **Step 2: Add to `eval/README.md`** a section "Running the gate" with that command and the meaning of the three exit codes.
- [ ] **Step 3: Update `docs/HANDOFF.md`**: plan B-2 executed, how to run the app (`pnpm --dir app start:scripted`, `pnpm --dir app start` for the real model), what still stands in (reader, clave-back), and the gate result.
- [ ] **Step 4: Final checkpoint**

Run: `pnpm --dir app test`, `pnpm --dir app typecheck`, `pnpm --dir app smoke`, and `python3 docs/superpowers/plans/verify-plan-code.py docs/superpowers/plans/2026-09-17-desktop-shell.md` (every labelled block except `app/src/renderer/main.tsx` and `app/src/renderer/index.html`, which Task 8 replaces on purpose, must be `ok`).

---

## Verification record

Written 2026-09-17. Tasks 2 to 7 are not hypothetical: Electron 44.4.1, node-llama-cpp 3.21.1 and
esbuild 0.28.2 were installed from this machine's local package cache (left by the spikes; nothing was
downloaded) into a scratch folder next to a copy of `app/`, and the code was run there:

- The whole suite passes with these tasks applied, and `tsc --noEmit` is clean for both configs,
  including the files that import `electron` and `node-llama-cpp`. This document was generated from
  those files by a script and then replayed task by task on a fresh copy; the totals in the
  Checkpoints are the replayed numbers.
- **The real app was launched** (the Electron binary, headless) with `CLAVE_SMOKE=1`: window loaded,
  `window.clave` answered from the renderer's side with no Node reachable, the model host ran in a
  utility process, replayed work became a statement, approval uploaded it to the stub. Result:
  `SMOKE OK`, exit 0.
- **The real model was run** through `llamaBinding` -> `hostCore` -> `createModelClient` -> the core
  pipeline with `eval-gate.mjs` on an M2: self-test PASS; all eight original fixtures PASS
  (6 to 18 s each); no safety problem in any run. On the adversarial copies (same reads, real model)
  it once credited a skill outside `allowedTargets` and once produced four statements where at most
  three were expected. Those are quality findings of a model at temperature 0.2, which is why the gate
  separates `safe` from `passed` and skips the script-only fixtures.

Not verified, because React was not in the local cache and the look is decided at build time:
Task 1's install, Task 8's components, and the exact React and `@types/react-dom` versions.

Found while writing it, and reflected above:
1. Electron's main process has no battery level: `pmset -g batt` is polled once a minute.
2. A sandboxed preload must be CommonJS, and `__dirname` needs a CommonJS main, so esbuild emits
   `main.cjs` and `preload.cjs`; the model host stays ESM because node-llama-cpp is ESM-only.
3. `safeStorage` can raise a Keychain dialog, which would hang an automated run, so the smoke run
   (and only it) uses a stand-in cipher.
4. The capture loop goes silent when nobody has touched the machine for five minutes, which is exactly
   the state of an unattended run, so the smoke run (and only it) reports zero idle seconds. Found when
   the first real execution printed `SMOKE_NO_STATEMENT` on a Mac that had been idle for ten minutes.
5. A closed scenario needs five idle minutes; the smoke run switches capture off instead, which
   closes the scenario at once.

## Deviations from the spec

| Spec | This plan | Why |
|---|---|---|
| "Electron + Vite + React" (overall plan) | esbuild only | one small build script, one fewer toolchain, and it could be verified offline |
| `main/ipc.ts` "the typed channel list" | `shared/ipc.ts` + `main/ipcRouter.ts` | the renderer needs the types without importing `main/` |
| `eval/run.ts` | `app/src/eval/gate.ts` + `gateCli.ts`, bundled to `dist/eval-gate.mjs` | lives with the code it runs and is typechecked and tested |
| Electron smoke test "completes onboarding" | an in-app scripted run through the same IPC router; onboarding is walked by hand in Task 8 | no browser-automation package to download |
| Production build | refuses to start (`NO_READER_YET`) | sub-projects C and D do not exist; only the stand-ins can run |

## After this plan

Sub-project C replaces `devReader` (it must answer `failed`, not `black`, when Screen Recording is
revoked, and tolerate `read()` being re-entered). Sub-project D replaces `stubApi`. The fifth piece
adds Sentry, the usage summary from `engine.takeCounters()`, signing, notarisation and the installer.

## Post-execution fixes (2026-09-18)

Executed with subagents, then reviewed area by area and fixed in waves E, F, G (main, shell, build) and
H, I (the UI). The suite is now 768 tests. Most files no longer match the code blocks above: never
re-extract them over the code. Record, decisions and open items:
`docs/superpowers/reviews/2026-09-18-desktop-shell-review.md`.

