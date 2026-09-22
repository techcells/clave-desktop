import {z} from "zod";
import {STATEMENT_MAX_CHARS, STATEMENTS_MAX, STATEMENTS_MIN, SUMMARY_MAX_CHARS} from "../constants";
import type {JsonSchema} from "../types";

/** Field order matters: the model must summarise before it decides. */
export function gateForm(): JsonSchema {
  return {
    type: "object",
    properties: {
      activity_summary: {type: "string", maxLength: SUMMARY_MAX_CHARS},
      is_professional: {type: "boolean"},
      user_demonstrated_something: {type: "boolean"}
    }
  };
}

export function statementsForm(offeredIds: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      evidence: {
        type: "array", minItems: STATEMENTS_MIN, maxItems: STATEMENTS_MAX,
        items: {
          type: "object",
          properties: {
            target_id: {enum: offeredIds},
            statement: {type: "string", maxLength: STATEMENT_MAX_CHARS}
          }
        }
      }
    }
  };
}

const gateAnswer = z.object({
  activity_summary: z.string().max(SUMMARY_MAX_CHARS),
  is_professional: z.boolean(),
  user_demonstrated_something: z.boolean()
});
export type GateAnswer = z.infer<typeof gateAnswer>;

export interface StatementsAnswer { evidence: {target_id: string; statement: string}[] }

/** Our own check. It does not depend on the runtime having enforced the form. */
export function parseGate(answer: unknown): GateAnswer | null {
  const result = gateAnswer.safeParse(answer);
  return result.success ? result.data : null;
}

export function parseStatements(answer: unknown, offeredIds: string[]): StatementsAnswer | null {
  const allowed = new Set(offeredIds);
  const shape = z.object({
    evidence: z.array(z.object({
      target_id: z.string().refine((id) => allowed.has(id)),
      statement: z.string().trim().min(1).max(STATEMENT_MAX_CHARS)
    })).min(STATEMENTS_MIN).max(STATEMENTS_MAX)
  });
  const result = shape.safeParse(answer);
  return result.success ? result.data : null;
}
