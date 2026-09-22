import {afterEach, describe, expect, it, vi} from "vitest";
import {createFakeModel} from "../../core/testing/fakeModel";
import type {ModelConversation, ModelPort} from "../../core/types";
import {runSelfTest, selfTestKey} from "./selfTest";

const GATE_YES = {activity_summary: "Rewrote a slow query.", is_professional: true, user_demonstrated_something: true};
const GATE_NO = {activity_summary: "Nothing.", is_professional: false, user_demonstrated_something: false};
const STATEMENTS = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

describe("self-test", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("passes when the model answers both passes with valid forms", async () => {
    const model = createFakeModel([GATE_YES, STATEMENTS]);
    expect(await runSelfTest(model)).toEqual({ok: true});
    expect(model.closed).toBe(model.opened);
  });

  it("fails when the model sees no work in obvious work, or keeps answering with junk", async () => {
    expect(await runSelfTest(createFakeModel([GATE_NO]))).toEqual({ok: false, code: "SELF_TEST_NO_STATEMENT"});
    expect(await runSelfTest(createFakeModel([{nonsense: true}, {nonsense: true}]))).toEqual({ok: false, code: "MODEL_ANSWER_INVALID"});
  });

  it("fails with a fixed code when the model never answers", async () => {
    vi.useFakeTimers();
    const silent: ModelPort = {open: () => new Promise(() => undefined)};
    const result = runSelfTest(silent, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ok: false, code: "SELF_TEST_TIMEOUT"});
  });

  it("is keyed by app version and model hash, so either change forces a new test", () => {
    expect(selfTestKey("1.0.0", "abc")).toBe("1.0.0:abc");
    expect(selfTestKey("1.0.1", "abc")).not.toBe(selfTestKey("1.0.0", "abc"));
  });

  it("makes an abandoned run harmless: after the timeout, a late open is refused and the open conversation is closed", async () => {
    vi.useFakeTimers();
    let openCount = 0;
    let closedCalls = 0;
    const hangingConversation: ModelConversation = {
      ask: () => new Promise(() => undefined),
      close: () => { closedCalls += 1; return new Promise(() => undefined); }
    };
    const slow: ModelPort = {async open() { openCount += 1; return hangingConversation; }};

    const result = runSelfTest(slow, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ok: false, code: "SELF_TEST_TIMEOUT"});
    expect(closedCalls).toBe(1);   // the conversation opened by the abandoned run got closed
    expect(openCount).toBe(1);
  });

  it("closes a conversation exactly once, even when the timeout already closed it", async () => {
    vi.useFakeTimers();
    let closedCalls = 0;
    let answerAsk!: (value: unknown) => void;
    const conversation: ModelConversation = {
      // Answers only when released, so the abandoned run is still holding this conversation when the
      // timeout fires, and afterwards carries on into its own `finally { close() }`.
      ask: () => new Promise((resolve) => { answerAsk = resolve; }),
      close: async () => { closedCalls += 1; }
    };
    const model: ModelPort = {async open() { return conversation; }};

    const result = runSelfTest(model, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ok: false, code: "SELF_TEST_TIMEOUT"});
    expect(closedCalls).toBe(1);                 // the timeout closed the conversation it abandoned

    answerAsk({nonsense: true});                 // the abandoned run resumes and closes it too
    await vi.advanceTimersByTimeAsync(0);
    expect(closedCalls).toBe(1);                 // the host is told once, not twice
  });

  it("never yields ok:true when the model's statement targets an id that was not offered", async () => {
    const offTarget = {evidence: [{target_id: "not-offered", statement: "Rewrote a slow reporting query with a grouped join and a composite index."}]};
    const model = createFakeModel([GATE_YES, offTarget, GATE_YES, offTarget]);
    const result = await runSelfTest(model);
    expect(result.ok).toBe(false);
  });
});
