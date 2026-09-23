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
      openWhatLeaves: async () => undefined, openLicences: async () => "LICENCES_MISSING", restartApp: () => undefined
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
    const id = review.pending[0]!.id;
    // Only the four channels that would end this run early are left out: two of them are asserted to
    // answer nothing at all in `ipcRouter.test.ts`, and `signIn`/`selfTest`/`setCapture` were called
    // above with real arguments. Everything else is called here, `reject` and `signOut` included, and
    // every answer is inspected below.
    const skip = new Set(["signIn", "selfTest", "setCapture", "approve", "deleteAllData", "restartApp"]);
    const args = (channel: string): unknown[] => (channel === "updateSettings" ? [{}] : channel === "retry" ? ["reader"] : channel === "reject" ? [id] : channel === "extension" ? ["check"] : []);
    for (const channel of INVOKE_CHANNELS) if (!skip.has(channel)) crossed.push([channel, await router.handle(channel, args(channel))]);
    // `reject` took the one statement and `signOut` followed it: approving it now answers a plain
    // `false`, and the review screen is empty for a screen nobody is signed in to.
    crossed.push(await router.handle("approve", [id]));
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
