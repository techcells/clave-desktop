import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {gateForm, parseGate, parseStatements, statementsForm} from "../core/extraction/forms";
import {parseTaxonomy, type ApprovedStatement} from "../main/ports/claveApi";
import {parseFrontWindow, parseReadResult} from "../main/ports/reader";
import {createMemFs} from "../main/testing/memFs";
import {createDevReader, windowsFromFixture} from "./devReader";
import {isStandIn} from "../main/ports/standIn";
import {createReadyDownloader} from "./readyDownloader";
import {createScriptedBinding} from "./scriptedBinding";
import {createSmokeCipher} from "./smokeCipher";
import {createStubApi} from "./stubApi";

const taxonomy = parseTaxonomy(JSON.parse(readFileSync(new URL("./taxonomy.json", import.meta.url), "utf8")));

describe("dev reader", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads windows out of an evaluation fixture and skips malformed entries", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../eval/fixtures/04-mixed.json", import.meta.url), "utf8"));
    const windows = windowsFromFixture(fixture);
    expect(windows.length).toBe(fixture.reads.length);
    expect(windowsFromFixture({reads: [{app: "Code"}, 7, null]})).toEqual([]);
    expect(windowsFromFixture("nonsense")).toEqual([]);
  });

  it("replays the windows in turn, speaks the Reader port exactly, and announces each switch", async () => {
    const reader = createDevReader([{app: "Code", title: "a.ts", text: "one"}, {app: "Chrome", title: "Docs", text: "two", toolbarText: "docs.example"}], 1_000);
    const switched = vi.fn();
    reader.onFocusChange(switched);
    expect(await reader.permission()).toBe("granted");
    expect(parseFrontWindow(await reader.frontWindow())).toEqual({app: "Code", title: "a.ts"});
    expect(parseReadResult(await reader.read({budgetMs: 100, expect: {app: "Code", title: "a.ts"}})))
      .toEqual({ok: true, window: {app: "Code", title: "a.ts"}, text: "one"});
    vi.advanceTimersByTime(1_000);
    expect(switched).toHaveBeenCalledTimes(1);
    expect(parseReadResult(await reader.read({budgetMs: 100, expect: {app: "Chrome", title: "Docs"}})))
      .toMatchObject({ok: true, text: "two", toolbarText: "docs.example"});
    await reader.dispose();
    vi.advanceTimersByTime(5_000);
    expect(switched).toHaveBeenCalledTimes(1);
  });

  it("has nothing in front when it was given no windows", async () => {
    const reader = createDevReader([], 1_000);
    expect(await reader.frontWindow()).toBeNull();
    // `windowGone` and not `failed`: no window is a state of the screen, and `failed` is what the
    // loop counts towards switching capture off.
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", title: "a.ts"}})).toEqual({ok: false, reason: "windowGone"});
  });

  it("refuses to replay a window that is not the one it was asked for", async () => {
    // The dwell timer moved on between main's own check and the read: the stand-in answers about
    // nothing rather than about a window main never approved, exactly as the real helper does.
    const reader = createDevReader([{app: "Code", title: "a.ts", text: "one"}], 1_000);
    const gone = {ok: false, reason: "windowGone"};
    expect(await reader.read({budgetMs: 100, expect: {app: "1Password", title: "a.ts"}})).toEqual(gone);
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", title: "secrets.ts"}})).toEqual(gone);
    expect(await reader.read({budgetMs: 100, expect: {app: "Code", bundleId: "com.microsoft.VSCode", title: "a.ts"}})).toEqual(gone);
    await reader.dispose();
  });
});

describe("stub api", () => {
  const item: ApprovedStatement = {clientItemId: "a", statement: "Rebuilt an index without blocking writes on a busy table.", kind: "skill", targetId: "stub-postgresql", createdAt: 1, taxonomyVersion: "stub-1", pipelineVersion: "1"};

  it("ships a valid taxonomy that includes the name that used to crash the core", () => {
    expect(taxonomy).not.toBeNull();
    expect(taxonomy?.skills.map((s) => s.canonicalName)).toContain("constructor");
  });

  it("signs anyone in, serves the taxonomy, and records uploads where they can be inspected", async () => {
    const fs = createMemFs();
    const api = createStubApi({fs, uploadsPath: "/d/stub-uploads.jsonl", taxonomy: taxonomy!, now: () => 50});
    await expect(api.signIn("", "x")).rejects.toMatchObject({code: "BAD_CREDENTIALS"});
    const session = await api.signIn("Sardor", "anything");
    expect(session.userId).toBe("stub:sardor");
    expect(await api.taxonomy(session)).toEqual(taxonomy);
    expect(await api.taxonomy(session, "stub-1")).toBe("unchanged");
    expect(await api.submitEvidence(session, [item])).toEqual({accepted: ["a"]});
    expect(JSON.parse(fs.text("/d/stub-uploads.jsonl") as string)).toEqual({receivedAt: 50, userId: "stub:sardor", item});
  });

  it("marks both stand-ins so a production build can refuse them", () => {
    expect(isStandIn(createStubApi({fs: createMemFs(), uploadsPath: "/x", taxonomy: taxonomy!, now: () => 0}))).toBe(true);
    expect(isStandIn(createDevReader([], 1_000))).toBe(true);
    expect(isStandIn({})).toBe(false);
    expect(isStandIn(null)).toBe(false);
  });
});

describe("scripted model binding", () => {
  const open = async () => (await createScriptedBinding().load("ignored")).open({
    systemPrompt: "s", thoughts: "discourage", templateVariation: "3.5", temperature: 0
  });

  it("answers the gate form in the shape the core parses", async () => {
    const session = await open();
    const answer = await session.ask("some replayed work", gateForm(), 512);
    expect(parseGate(answer)).toMatchObject({is_professional: true, user_demonstrated_something: true});
    await session.close();
  });

  it("answers the statements form with the FIRST id it was offered, so the fixture always lands somewhere", async () => {
    const session = await open();
    const offered = ["stub-postgresql", "stub-typescript"];
    const answer = await session.ask("some replayed work", statementsForm(offered), 512);
    const parsed = parseStatements(answer, offered);
    expect(parsed?.evidence).toHaveLength(1);
    expect(parsed?.evidence[0]?.target_id).toBe("stub-postgresql");
    expect(parsed?.evidence[0]?.statement.length).toBeGreaterThan(20);
    // Offer the other one on its own and the answer follows the offer, not a hard-coded id.
    expect(parseStatements(await session.ask("more", statementsForm(["stub-typescript"]), 512), ["stub-typescript"])?.evidence[0]?.target_id).toBe("stub-typescript");
  });

  it("answers an empty offer with an id the core will refuse rather than inventing one", async () => {
    const session = await open();
    const answer = await session.ask("work", statementsForm([]), 512);
    expect(parseStatements(answer, [])).toBeNull();
  });

  it("is marked, and unloading it is safe", async () => {
    const binding = createScriptedBinding();
    expect(isStandIn(binding)).toBe(true);
    await expect((await binding.load("ignored")).dispose()).resolves.toBeUndefined();
  });
});

describe("ready downloader", () => {
  it("is ready before anything is asked of it, and stays ready", async () => {
    const downloader = createReadyDownloader();
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(await downloader.inspect()).toEqual({kind: "ready"});
  });

  it("is inert: starting, pausing and removing change nothing and tell nobody", async () => {
    const downloader = createReadyDownloader();
    const changed = vi.fn();
    const unsubscribe = downloader.onChange(changed);
    await downloader.start();
    downloader.pause();
    await downloader.removeAll();
    expect(changed).not.toHaveBeenCalled();
    expect(downloader.state()).toEqual({kind: "ready"});
    expect(unsubscribe()).toBeUndefined();
  });

  it("has no file path, because the scripted host is told to be scripted instead", () => {
    expect(createReadyDownloader().filePath()).toBe("");
  });

  it("is marked so a production build can refuse it", () => {
    expect(isStandIn(createReadyDownloader())).toBe(true);
  });
});

describe("smoke cipher", () => {
  it("round-trips everything the engine stores through it", () => {
    const cipher = createSmokeCipher();
    expect(cipher.available()).toBe(true);
    for (const plain of ["", "token-123", '{"token":"t","expiresAt":1,"userId":"stub:sardor"}', "Ünïcødé — ünd emoji 🙂", String.fromCharCode(0, 0xa5)]) {
      expect(cipher.decrypt(cipher.encrypt(plain)), JSON.stringify(plain)).toBe(plain);
    }
  });

  it("scrambles rather than protects: that is why it is only ever the smoke run's", () => {
    const cipher = createSmokeCipher();
    const plain = "token-123";
    const encrypted = cipher.encrypt(plain);
    expect(new TextDecoder().decode(encrypted)).not.toBe(plain);
    expect([...encrypted]).toEqual([...new TextEncoder().encode(plain)].map((b) => b ^ 0xa5));
  });

  it("is marked so a production build can refuse it", () => {
    expect(isStandIn(createSmokeCipher())).toBe(true);
  });
});
