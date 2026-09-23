import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MODEL_CLOSE_TIMEOUT_MS, MODEL_OPEN_TIMEOUT_MS, MODEL_TIME_SCALE_MAX, RETRY_TEMPERATURE, TEMPERATURE} from "../constants";
import {createCounters} from "../counters";
import {createFakeModel} from "../testing/fakeModel";
import type {ModelConversation, ModelPort, Offered, Scenario} from "../types";
import {clampTimeScale, extract, scaledLimits} from "./extract";
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

describe("the machine factor", () => {
  /** A model that answers at once and records the limits it was given. */
  function recording(): {model: ModelPort; limits: Array<{maxTokens: number; timeoutMs: number}>} {
    const limits: Array<{maxTokens: number; timeoutMs: number}> = [];
    const answers = [gateYes, good];
    const model: ModelPort = {
      async open() {
        return {async ask(_text, _form, given) { limits.push(given); return answers[limits.length - 1]; }, close: async () => undefined};
      }
    };
    return {model, limits};
  }

  it("stretches the gate and statement limits by the factor, never the token budget", async () => {
    const r = recording();
    await extract({scenario, offered, userNames: [], model: r.model, counters: createCounters(), timeScale: 2.5});
    expect(r.limits).toEqual([{maxTokens: 300, timeoutMs: 75_000}, {maxTokens: 700, timeoutMs: 150_000}]);
  });

  it("uses today's limits with no factor, and never shrinks them or goes past the largest factor", async () => {
    for (const [scale, gate] of [[undefined, 30_000], [0.5, 30_000], [Number.NaN, 30_000], [99, 30_000 * MODEL_TIME_SCALE_MAX]] as const) {
      const r = recording();
      await extract({scenario, offered, userNames: [], model: r.model, counters: createCounters(), timeScale: scale});
      expect(r.limits[0]!.timeoutMs, String(scale)).toBe(gate);
    }
    expect(clampTimeScale("3")).toBe(1);
    expect(scaledLimits({maxTokens: 10, timeoutMs: 1_000}, 1.25)).toEqual({maxTokens: 10, timeoutMs: 1_250});
  });

  it("gives the first open, which loads the model, the stretched limit too", async () => {
    vi.useFakeTimers();
    try {
      let resolveOpen!: (c: ModelConversation) => void;
      const model: ModelPort = {open: () => new Promise((resolve) => { resolveOpen = resolve; })};
      const running = extract({scenario, offered, userNames: [], model, counters: createCounters(), timeScale: 2});
      await vi.advanceTimersByTimeAsync(MODEL_OPEN_TIMEOUT_MS + 1);
      // Past today's 30 s but inside 60 s: still waiting, not failed.
      let settled = false;
      void running.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      resolveOpen({async ask() { return {...gateYes, is_professional: false}; }, close: async () => undefined});
      expect(await running).toEqual({kind: "notProfessional"});
    } finally { vi.useRealTimers(); }
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

  describe("conversation.close() that never settles", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("still resolves with the normal outcome once MODEL_CLOSE_TIMEOUT_MS has elapsed", async () => {
      const base = createFakeModel([gateYes, good]);
      const model: ModelPort = {
        async open(settings) {
          const conversation = await base.open(settings);
          return {ask: conversation.ask, close: () => new Promise<void>(() => undefined)};
        }
      };
      const resultPromise = extract({scenario, offered, userNames: ["Sardor Astanov"], model, counters: createCounters()});
      await vi.advanceTimersByTimeAsync(MODEL_CLOSE_TIMEOUT_MS);
      const outcome = await resultPromise;
      expect(outcome).toEqual({kind: "statements", drafts: [
        {targetId: "pg", kind: "skill", statement: good.evidence[0]!.statement},
        {targetId: "cp1", kind: "competency", statement: good.evidence[1]!.statement}
      ]});
    });
  });

  describe("conversation.open() that never settles", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("fails with MODEL_TIMEOUT after both the first attempt and the retry have each waited MODEL_OPEN_TIMEOUT_MS", async () => {
      const model: ModelPort = {open: () => new Promise<ModelConversation>(() => undefined)};
      const counters = createCounters();
      const resultPromise = extract({scenario, offered, userNames: ["Sardor Astanov"], model, counters});
      await vi.advanceTimersByTimeAsync(MODEL_OPEN_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(MODEL_OPEN_TIMEOUT_MS);
      const outcome = await resultPromise;
      expect(outcome).toEqual({kind: "failed", code: "MODEL_TIMEOUT"});
      const snapshot = counters.snapshot();
      expect(snapshot["extract.retries"]).toBe(1);
      expect(snapshot["extract.failed"]).toBe(1);
    });

    it("closes a conversation whose open() settles late, so it is not leaked", async () => {
      const closeSpy = vi.fn(async () => undefined);
      let resolveLate!: (conversation: ModelConversation) => void;
      const late = new Promise<ModelConversation>((resolve) => { resolveLate = resolve; });
      const retryModel = createFakeModel([gateYes, good]);
      let calls = 0;
      const model: ModelPort = {
        open(settings) {
          calls += 1;
          return calls === 1 ? late : retryModel.open(settings);
        }
      };
      const resultPromise = extract({scenario, offered, userNames: ["Sardor Astanov"], model, counters: createCounters()});
      await vi.advanceTimersByTimeAsync(MODEL_OPEN_TIMEOUT_MS);
      // The retry must not wait on the first attempt's still-pending open() call.
      expect(calls).toBe(2);
      resolveLate({ask: async () => { throw new Error("late conversation must not be asked"); }, close: closeSpy});
      await vi.advanceTimersByTimeAsync(0);
      const outcome = await resultPromise;
      expect(outcome.kind).toBe("statements");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
