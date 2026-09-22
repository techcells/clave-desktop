import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MODEL_CLOSE_TIMEOUT_MS, MODEL_OPEN_TIMEOUT_MS, RETRY_TEMPERATURE, TEMPERATURE} from "../constants";
import {createCounters} from "../counters";
import {createFakeModel} from "../testing/fakeModel";
import type {ModelConversation, ModelPort, Offered, Scenario} from "../types";
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
