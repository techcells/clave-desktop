import type {ModelBinding} from "../main/model/hostCore";

const STATEMENT = "Reworked a slow database query by adding a supporting index and confirmed the improvement afterwards.";

/**
 * STAND-IN for the real model, so the app can be run and smoke-tested without the 2.7 GB file.
 * It says every scenario is professional and returns one fixed, clean statement for the first
 * target it was offered. Never part of a production build.
 */
export function createScriptedBinding(): ModelBinding & {readonly standIn: true} {
  return {
    standIn: true,
    async load() {
      return {
        async open() {
          return {
            async ask(_userText, form) {
              const properties = (form as {properties?: Record<string, unknown>}).properties ?? {};
              if ("is_professional" in properties) return {activity_summary: "Worked on a technical task.", is_professional: true, user_demonstrated_something: true};
              const evidence = properties["evidence"] as {items?: {properties?: {target_id?: {enum?: string[]}}}} | undefined;
              const target = evidence?.items?.properties?.target_id?.enum?.[0] ?? "";
              return {evidence: [{target_id: target, statement: STATEMENT}]};
            },
            async close() { /* nothing to free */ }
          };
        },
        async dispose() { /* nothing to free */ }
      };
    }
  };
}
