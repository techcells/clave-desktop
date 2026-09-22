import {beforeEach, describe, expect, it, vi} from "vitest";
import type {JsonSchema, ModelSettings} from "../../core/types";
import {MODEL_GRAMMAR_CACHE_MAX} from "../constants";
import {createLlamaBinding} from "./llamaBinding";

/**
 * The one thing in `llamaBinding.ts` that is a decision rather than a setting: which grammars are
 * kept built. The runtime underneath is replaced, because the real one wants a 2.7 GB file; nothing
 * else in the file is exercised here (the release gate does that with the real model).
 */
const builds: string[] = [];
let failNext = false;

vi.mock("node-llama-cpp", () => ({
  getLlama: () => Promise.resolve({
    createGrammarForJsonSchema: (form: object) => {
      builds.push(JSON.stringify(form));
      if (failNext) { failNext = false; return Promise.reject(new Error("grammar")); }
      return Promise.resolve({parse: (answer: string) => answer});
    },
    loadModel: () => Promise.resolve({
      tokenize: (text: string) => [...text],
      createContext: () => Promise.resolve({getSequence: () => ({}), dispose: () => Promise.resolve()}),
      dispose: () => Promise.resolve()
    })
  }),
  LlamaChatSession: class { prompt = () => Promise.resolve("{}"); dispose(): void { /* nothing to free */ } },
  QwenChatWrapper: class { }
}));

const SETTINGS: ModelSettings = {systemPrompt: "s", thoughts: "discourage", templateVariation: "3.5", temperature: 0};
const statementsForm = (id: string): JsonSchema => ({type: "object", properties: {target_id: {const: id}}} as unknown as JsonSchema);
const GATE_FORM = {type: "object", properties: {is_professional: {type: "boolean"}}} as unknown as JsonSchema;

async function conversation() {
  const loaded = await createLlamaBinding().load("/m/model.gguf");
  return {loaded, talk: await loaded.open(SETTINGS)};
}

describe("the grammar cache", () => {
  beforeEach(() => { builds.length = 0; failNext = false; });

  it("builds one grammar per form and reuses it", async () => {
    const {talk} = await conversation();
    await talk.ask("a", GATE_FORM, 100);
    await talk.ask("b", GATE_FORM, 100);
    await talk.ask("c", statementsForm("pg"), 100);
    await talk.ask("d", statementsForm("pg"), 100);
    expect(builds).toHaveLength(2);
  });

  it("keeps the gate's grammar for the life of the model, however many others came after it", async () => {
    const {talk} = await conversation();
    await talk.ask("gate", GATE_FORM, 100);
    for (let i = 0; i < MODEL_GRAMMAR_CACHE_MAX * 3; i++) await talk.ask("s", statementsForm(`id${i}`), 100);
    const before = builds.length;
    await talk.ask("gate again", GATE_FORM, 100);
    expect(builds).toHaveLength(before);                   // the gate was never rebuilt
  });

  it("holds at most the gate plus MODEL_GRAMMAR_CACHE_MAX others, dropping the oldest first", async () => {
    const {talk} = await conversation();
    await talk.ask("gate", GATE_FORM, 100);
    for (let i = 0; i < MODEL_GRAMMAR_CACHE_MAX + 1; i++) await talk.ask("s", statementsForm(`id${i}`), 100);
    const before = builds.length;
    // id0 was the oldest non-gate form and has been dropped, so asking for it again rebuilds it...
    await talk.ask("s", statementsForm("id0"), 100);
    expect(builds).toHaveLength(before + 1);
    // ...while the newest one is still there.
    await talk.ask("s", statementsForm(`id${MODEL_GRAMMAR_CACHE_MAX}`), 100);
    expect(builds).toHaveLength(before + 1);
  });

  it("never remembers a build that failed as the answer for that form", async () => {
    const {talk} = await conversation();
    failNext = true;
    await expect(talk.ask("gate", GATE_FORM, 100)).rejects.toThrow();
    await talk.ask("gate", GATE_FORM, 100);                // built again, and this time it works
    expect(builds).toHaveLength(2);
  });

  it("refuses a prompt that would not leave the answer room, rather than truncating it", async () => {
    const {talk} = await conversation();
    await expect(talk.ask("x".repeat(100_000), GATE_FORM, 100)).rejects.toThrow("PROMPT_TOO_LONG");
    expect(builds).toEqual([]);                            // refused before anything was built
  });
});
