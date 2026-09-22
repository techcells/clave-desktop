import {getLlama, LlamaChatSession, QwenChatWrapper} from "node-llama-cpp";
import {MODEL_CONTEXT_RESERVE_TOKENS, MODEL_CONTEXT_TOKENS, MODEL_GRAMMAR_CACHE_MAX} from "../constants";
import type {ModelBinding} from "./hostCore";

/**
 * node-llama-cpp 3.21.1 with the settings spike S1 proved necessary:
 * - `QwenChatWrapper({thoughts: "discourage", variation: "3.5"})`: with default thinking the
 *   grammar-constrained answer starts inside a thought segment and is stripped;
 * - the answer is forced to the JSON form by a grammar and parsed by that same grammar.
 * Nothing here logs, and nothing here is reachable from the renderer.
 *
 * Every limit here comes from `main/constants.ts`; the only behaviour the file adds is refusing a
 * prompt that would not fit the context and deciding which grammars stay built. Those two are
 * covered by `llamaBinding.test.ts` over a stand-in runtime; everything else needs the real 2.7 GB
 * model and is exercised by the release gate (`eval/gate.ts`).
 */
export function createLlamaBinding(): ModelBinding {
  return {
    async load(modelPath) {
      const llama = await getLlama();
      const model = await llama.loadModel({modelPath});
      // One grammar per JSON form, not per ask: building it is pure work over the form and the core
      // asks with the same two forms all day. Keyed by the form itself, and per loaded model, so a
      // reload cannot hand out a grammar built against a model that is gone.
      //
      // The cache is bounded, because one of the two forms is not fixed: the statements form carries
      // the offered target ids, so a taxonomy that changes (or a scenario that offers a different
      // set) is a new key, and an unbounded map would hold every one of them for as long as the
      // model is loaded. The FIRST form ever asked for is kept for the life of the model: the core
      // gates every scenario before it asks for statements (`core/extraction/extract.ts`), so the
      // first form is the gate's, and the gate is the one form that really is asked for all day.
      // Of the rest, at most MODEL_GRAMMAR_CACHE_MAX are kept and the oldest is dropped first —
      // insertion order, which `Map` keeps, and not use order: a grammar is cheap to rebuild and a
      // wrong guess here costs one build, never a wrong answer.
      const build = (form: object) => llama.createGrammarForJsonSchema(form as Parameters<typeof llama.createGrammarForJsonSchema>[0]);
      const grammars = new Map<string, ReturnType<typeof build>>();
      let gateKey: string | null = null;
      const grammarFor = (form: object): ReturnType<typeof build> => {
        const key = JSON.stringify(form);
        const known = grammars.get(key);
        if (known) return known;
        const built = build(form);
        grammars.set(key, built);
        gateKey ??= key;
        for (const old of grammars.keys()) {
          if (grammars.size <= MODEL_GRAMMAR_CACHE_MAX + 1) break;
          if (old !== gateKey) grammars.delete(old);
        }
        // A failed build must not be remembered as the answer for that form for ever.
        void built.catch(() => { if (grammars.get(key) === built) grammars.delete(key); });
        return built;
      };
      return {
        async open(settings) {
          const context = await model.createContext({contextSize: MODEL_CONTEXT_TOKENS});
          const session = new LlamaChatSession({
            contextSequence: context.getSequence(),
            chatWrapper: new QwenChatWrapper({thoughts: settings.thoughts, variation: settings.templateVariation}),
            systemPrompt: settings.systemPrompt
          });
          return {
            async ask(userText, form, maxTokens) {
              // Measured before prompting, and refused rather than truncated: a context overflow
              // would otherwise silently drop the end of the scenario (or of the system prompt) and
              // the model would answer about text nobody sent it. The host turns any throw from
              // here into the fixed code MODEL_FAILED, which the core retries or gives up on.
              const used = model.tokenize(settings.systemPrompt + userText).length;
              if (used > MODEL_CONTEXT_TOKENS - MODEL_CONTEXT_RESERVE_TOKENS) throw new Error("PROMPT_TOO_LONG");
              const grammar = await grammarFor(form);
              const answer = await session.prompt(userText, {grammar, maxTokens, temperature: settings.temperature});
              return grammar.parse(answer);
            },
            async close() { session.dispose(); await context.dispose(); }
          };
        },
        async dispose() { grammars.clear(); await model.dispose(); }
      };
    }
  };
}
