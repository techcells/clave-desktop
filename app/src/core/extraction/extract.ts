import {GATE_LIMITS, MODEL_CLOSE_TIMEOUT_MS, MODEL_OPEN_TIMEOUT_MS, RETRY_TEMPERATURE, STATEMENT_LIMITS, TEMPERATURE} from "../constants";
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
  const opening = model.open({
    systemPrompt: buildSystemPrompt({userNames, offered}), thoughts: "discourage", templateVariation: "3.5", temperature
  });
  let conversation: Awaited<ReturnType<ModelPort["open"]>>;
  try {
    conversation = await withTimeout(opening, MODEL_OPEN_TIMEOUT_MS);
  } catch (error) {
    opening.then((late) => late.close()).catch(() => undefined);
    throw error;
  }
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
    await withTimeout(conversation.close(), MODEL_CLOSE_TIMEOUT_MS).catch(() => undefined);
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
