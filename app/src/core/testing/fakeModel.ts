import type {JsonSchema, ModelConversation, ModelPort, ModelSettings} from "../types";

export interface FakeCall { settings: ModelSettings; userText: string; form: JsonSchema }
/** Each `ask` takes the next entry. A function entry is called with the call; an Error entry is thrown. */
export type FakeScript = Array<unknown | Error | ((call: FakeCall) => unknown | Promise<unknown>)>;

export interface FakeModel extends ModelPort { calls: FakeCall[]; opened: number; closed: number }

export function createFakeModel(script: FakeScript): FakeModel {
  const queue = [...script];
  const fake: FakeModel = {
    calls: [], opened: 0, closed: 0,
    async open(settings: ModelSettings): Promise<ModelConversation> {
      fake.opened += 1;
      return {
        async ask(userText, form) {
          const call = {settings, userText, form};
          fake.calls.push(call);
          if (queue.length === 0) throw new Error("fake model script exhausted");
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return typeof next === "function" ? await (next as (c: FakeCall) => unknown)(call) : next;
        },
        async close() { fake.closed += 1; }
      };
    }
  };
  return fake;
}
