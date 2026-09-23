import {MODEL_OPEN_TIMEOUT_MS, MODEL_TIME_SCALE_HEADROOM, MODEL_TIME_SCALE_MAX} from "../../core/constants";
import {createCounters} from "../../core/counters";
import {CoreError, type CoreErrorCode} from "../../core/errors";
import {extract} from "../../core/extraction/extract";
import type {ModelConversation, ModelPort, Offered, Scenario} from "../../core/types";
import {SELF_TEST_TIMEOUT_MS} from "../constants";

/**
 * `timeScale`: the factor this machine needs on the model limits (`core/extraction/extract.ts`), which
 * the engine stores beside the passed test. `MODEL_TOO_SLOW`: the model answered correctly or was on
 * its way to, but this machine would need more than MODEL_TIME_SCALE_MAX, so it is not used here.
 */
export type SelfTestResult =
  | {ok: true; timeScale: number}
  | {ok: false; code: CoreErrorCode | "SELF_TEST_TIMEOUT" | "SELF_TEST_NO_STATEMENT" | "MODEL_TOO_SLOW"};

/** Invented text. Nothing here was ever on anyone's screen. */
const TEXT = [
  "[Code \u2014 invoice_totals.sql]",
  "I rewrote the monthly invoice totals query. The old version joined line items for every row and took far too long.",
  "I added a composite index on the customer and month columns, replaced the correlated subquery with a grouped join,",
  "and checked the query plan in Postgres before and after. The plan now uses an index scan and the report loads quickly.",
  "Then I wrote a short note for the team explaining why the subquery was slow and how to spot the same pattern again."
].join("\n");
const SCENARIO: Scenario = {id: "self-test", openedAt: 0, closedAt: 1, blocks: [{app: "Code", title: "invoice_totals.sql", text: TEXT, at: 0}], text: TEXT};
const OFFERED: Offered[] = [
  {id: "self-test-postgres", kind: "skill", name: "PostgreSQL"},
  {id: "self-test-problem-solving", kind: "competency", name: "Problem Solving", description: "Breaks a problem down and resolves it"}
];

/**
 * Once the self-test has timed out, its `extract()` call is abandoned but not cancelled: it may still
 * be awaiting a reply. This wraps the model so that abandonment is harmless: no later `open()` reaches
 * the real model, and whatever conversation was already open gets closed.
 */
function harmlessAfterTimeout(model: ModelPort): {port: ModelPort; onTimeout(): void} {
  let timedOut = false;
  /** One entry per conversation this wrapper handed out, with whether it has been closed yet: the
   *  timeout and the abandoned run both want to close the same conversation, and it must be closed
   *  exactly once. */
  const live = new Set<{conversation: ModelConversation; closed: boolean}>();
  const port: ModelPort = {
    async open(settings) {
      if (timedOut) throw new CoreError("MODEL_FAILED");
      const conversation = await model.open(settings);
      if (timedOut) { conversation.close().catch(() => undefined); throw new CoreError("MODEL_FAILED"); }
      const entry = {conversation, closed: false};
      live.add(entry);
      return {
        async ask(userText, form, limits) {
          if (timedOut) throw new CoreError("MODEL_FAILED");
          return conversation.ask(userText, form, limits);
        },
        async close() {
          live.delete(entry);
          if (entry.closed) return;            // the timeout already closed it: nothing left to say
          entry.closed = true;
          return conversation.close();
        }
      };
    }
  };
  return {
    port,
    onTimeout() {
      timedOut = true;
      for (const entry of live) {
        if (entry.closed) continue;
        entry.closed = true;
        entry.conversation.close().catch(() => undefined);
      }
      live.clear();
    }
  };
}

/**
 * Wraps the model so every open and ask is timed, each as a multiple of the limit it would have at a
 * factor of 1. The largest multiple is the factor this machine needs. Only calls that finished count:
 * a call that never answered is what the timeouts are for.
 */
function timed(model: ModelPort, now: () => number): {port: ModelPort; needed(): number} {
  // From 0, so a machine faster than the limits keeps exactly them: the factor is floored at 1 after the headroom.
  let needed = 0;
  const note =(elapsed: number, baseLimit: number) => { needed = Math.max(needed, elapsed / baseLimit); };
  return {
    port: {
      async open(settings) {
        const started = now();
        const conversation = await model.open(settings);
        note(now() - started, MODEL_OPEN_TIMEOUT_MS);
        return {
          async ask(userText, form, limits) {
            const asked = now();
            const answer = await conversation.ask(userText, form, limits);
            // The limit the ask was given is already stretched to the maximum; its base is that over the maximum.
            note(now() - asked, limits.timeoutMs / MODEL_TIME_SCALE_MAX);
            return answer;
          },
          close: () => conversation.close()
        };
      }
    },
    needed: () => needed
  };
}

/**
 * Proves, on this machine, that the pinned runtime and model produce a schema-valid answer through
 * the very code path real scenarios use, and measures how much time this machine needs to. Capture
 * cannot be switched on until this has passed.
 *
 * The test runs with the limits stretched as far as any machine may have them (MODEL_TIME_SCALE_MAX),
 * so a slow machine is measured rather than cut off, and times each step. The factor it reports is
 * the slowest step's multiple of its base limit, times MODEL_TIME_SCALE_HEADROOM for the longer text
 * of a real scenario, rounded up to a tenth. A machine that would need more than the maximum, or whose
 * steps ran out of time even at the maximum, gets MODEL_TOO_SLOW: a plain answer instead of a model
 * that times out on every scenario.
 */
export async function runSelfTest(model: ModelPort, timeoutMs: number = SELF_TEST_TIMEOUT_MS * MODEL_TIME_SCALE_MAX, now: () => number = Date.now): Promise<SelfTestResult> {
  const clock = timed(model, now);
  const {port, onTimeout} = harmlessAfterTimeout(clock.port);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SelfTestResult>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve({ok: false, code: "SELF_TEST_TIMEOUT"}); }, timeoutMs);
  });
  const work = extract({scenario: {...SCENARIO, blocks: [...SCENARIO.blocks]}, offered: OFFERED, userNames: [], model: port, counters: createCounters(), timeScale: MODEL_TIME_SCALE_MAX})
    .then((outcome): SelfTestResult => {
      if (outcome.kind === "failed") return {ok: false, code: outcome.code === "MODEL_TIMEOUT" ? "MODEL_TOO_SLOW" : outcome.code};
      if (outcome.kind !== "statements" || outcome.drafts.length === 0) return {ok: false, code: "SELF_TEST_NO_STATEMENT"};
      const timeScale = Math.max(1, Math.ceil(clock.needed() * MODEL_TIME_SCALE_HEADROOM * 10) / 10);
      return timeScale > MODEL_TIME_SCALE_MAX ? {ok: false, code: "MODEL_TOO_SLOW"} : {ok: true, timeScale};
    });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}

export const selfTestKey = (appVersion: string, modelSha256: string): string => `${appVersion}:${modelSha256}`;
