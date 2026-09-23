import {afterEach, describe, expect, it, vi} from "vitest";
import {createFakeModel} from "../../core/testing/fakeModel";
import type {ModelConversation, ModelPort} from "../../core/types";
import {runSelfTest, selfTestKey} from "./selfTest";

const GATE_YES = {activity_summary: "Rewrote a slow query.", is_professional: true, user_demonstrated_something: true};
const GATE_NO = {activity_summary: "Nothing.", is_professional: false, user_demonstrated_something: false};
const STATEMENTS = {evidence: [{target_id: "self-test-postgres", statement: "Rewrote a slow reporting query with a grouped join and a composite index after reading the plan."}]};

describe("self-test", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("passes when the model answers both passes with valid forms, and a fast machine keeps today's limits", async () => {
    const model = createFakeModel([GATE_YES, STATEMENTS]);
    expect(await runSelfTest(model)).toEqual({ok: true, timeScale: 1});
    expect(model.closed).toBe(model.opened);
  });

  /**
   * A model that takes `gateMs` to answer the gate and `statementsMs` the statements, on a clock the
   * test moves itself: what the self-test measures is exactly what the test says.
   */
  function slowModel(gateMs: number, statementsMs: number, openMs = 0): {model: ModelPort; now: () => number; asked: number[]} {
    let clock = 0;
    const asked: number[] = [];
    const answers = [GATE_YES, STATEMENTS];
    const model: ModelPort = {
      async open() {
        clock += openMs;
        return {
          async ask(_text, _form, limits) {
            asked.push(limits.timeoutMs);
            clock += asked.length === 1 ? gateMs : statementsMs;
            return answers[asked.length - 1];
          },
          close: async () => undefined
        };
      }
    };
    return {model, now: () => clock, asked};
  }

  it("runs at the largest factor, so a slow machine is measured rather than cut off", async () => {
    const slow = slowModel(10_000, 20_000);
    await runSelfTest(slow.model, 1_000_000, slow.now);
    expect(slow.asked).toEqual([30_000 * 4, 60_000 * 4]);
  });

  it("reports the slowest step's multiple of its limit, with headroom, rounded up to a tenth", async () => {
    // The gate took 2x its 30 s and the statements 1x their 60 s: 2 times 1.5 headroom is 3.
    const slow = slowModel(60_000, 60_000);
    expect(await runSelfTest(slow.model, 1_000_000, slow.now)).toEqual({ok: true, timeScale: 3});
    // 1.1x the gate: 1.65, rounded up to 1.7.
    const slightly = slowModel(33_000, 10_000);
    expect(await runSelfTest(slightly.model, 1_000_000, slightly.now)).toEqual({ok: true, timeScale: 1.7});
  });

  it("counts the first open too, which loads the model", async () => {
    // Loading took 60 s against the open's 30 s: 2x, so 3 with headroom, though both asks were quick.
    const slow = slowModel(1_000, 1_000, 60_000);
    expect(await runSelfTest(slow.model, 1_000_000, slow.now)).toEqual({ok: true, timeScale: 3});
  });

  it("calls a machine that would need more than the largest factor too slow, even though it answered", async () => {
    // Measured on 2026-09-23 on an i5-10210U with Intel UHD: the gate took 99.6 s, 3.3x its limit.
    const laptop = slowModel(99_600, 145_800);
    expect(await runSelfTest(laptop.model, 1_000_000, laptop.now)).toEqual({ok: false, code: "MODEL_TOO_SLOW"});
  });

  it("calls a step that ran out of even the largest limit too slow, not a broken model", async () => {
    vi.useFakeTimers();
    const conversation: ModelConversation = {ask: () => new Promise(() => undefined), close: async () => undefined};
    const model: ModelPort = {async open() { return conversation; }};
    const result = runSelfTest(model, 10_000_000);
    await vi.advanceTimersByTimeAsync(2 * (30_000 * 4 + 1));
    expect(await result).toEqual({ok: false, code: "MODEL_TOO_SLOW"});
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
