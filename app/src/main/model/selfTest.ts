import {createCounters} from "../../core/counters";
import {CoreError, type CoreErrorCode} from "../../core/errors";
import {extract} from "../../core/extraction/extract";
import type {ModelConversation, ModelPort, Offered, Scenario} from "../../core/types";
import {SELF_TEST_TIMEOUT_MS} from "../constants";

export type SelfTestResult = {ok: true} | {ok: false; code: CoreErrorCode | "SELF_TEST_TIMEOUT" | "SELF_TEST_NO_STATEMENT"};

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
 * Proves, on this machine, that the pinned runtime and model produce a schema-valid answer through
 * the very code path real scenarios use. Capture cannot be switched on until this has passed.
 */
export async function runSelfTest(model: ModelPort, timeoutMs: number = SELF_TEST_TIMEOUT_MS): Promise<SelfTestResult> {
  const {port, onTimeout} = harmlessAfterTimeout(model);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SelfTestResult>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve({ok: false, code: "SELF_TEST_TIMEOUT"}); }, timeoutMs);
  });
  const work = extract({scenario: {...SCENARIO, blocks: [...SCENARIO.blocks]}, offered: OFFERED, userNames: [], model: port, counters: createCounters()})
    .then((outcome): SelfTestResult => {
      if (outcome.kind === "failed") return {ok: false, code: outcome.code};
      return outcome.kind === "statements" && outcome.drafts.length > 0 ? {ok: true} : {ok: false, code: "SELF_TEST_NO_STATEMENT"};
    });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}

export const selfTestKey = (appVersion: string, modelSha256: string): string => `${appVersion}:${modelSha256}`;
