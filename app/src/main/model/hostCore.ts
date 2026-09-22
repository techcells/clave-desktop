import {z} from "zod";
import type {JsonSchema, ModelSettings} from "../../core/types";
import type {FromHost, ToHost} from "./protocol";

/** What the host needs from a model runtime. `llamaBinding.ts` is the real one; tests use a fake. */
export interface HostConversation {
  ask(userText: string, form: JsonSchema, maxTokens: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface LoadedModel {
  open(settings: ModelSettings): Promise<HostConversation>;
  dispose(): Promise<void>;
}
export interface ModelBinding { load(modelPath: string): Promise<LoadedModel> }

const settingsShape = z.object({systemPrompt: z.string(), thoughts: z.literal("discourage"), templateVariation: z.literal("3.5"), temperature: z.number().min(0).max(2)});
const toHostShape = z.discriminatedUnion("type", [
  z.object({type: z.literal("open"), requestId: z.number().int(), settings: settingsShape}),
  z.object({type: z.literal("ask"), requestId: z.number().int(), conversationId: z.number().int(), userText: z.string(), form: z.record(z.string(), z.unknown()), maxTokens: z.number().int().min(1).max(4096)}),
  z.object({type: z.literal("close"), requestId: z.number().int(), conversationId: z.number().int()}),
  z.object({type: z.literal("unload"), requestId: z.number().int()})
]);

export interface HostCore {
  /** One message from main. Never throws; every request gets exactly one reply. */
  onMessage(message: unknown): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The model host's whole behaviour, without a process around it. The model is loaded on the first
 * `open`. Prompts and answers are never logged and never put into an error: a failure is the fixed
 * code MODEL_FAILED and nothing else.
 */
export function createHostCore(deps: {binding: ModelBinding; modelPath: string; post: (message: FromHost) => void}): HostCore {
  const {binding, modelPath, post} = deps;
  let model: Promise<LoadedModel> | null = null;
  let nextConversation = 0;
  const conversations = new Map<number, HostConversation>();

  const loaded = (): Promise<LoadedModel> => {
    if (!model) {
      const loading = binding.load(modelPath);
      model = loading;
      loading.catch(() => { if (model === loading) model = null; });      // a failed load may be tried again
    }
    return model;
  };

  async function unload(): Promise<void> {
    const current = model;
    model = null;
    for (const conversation of conversations.values()) await conversation.close().catch(() => undefined);
    conversations.clear();
    if (current) await current.then((m) => m.dispose()).catch(() => undefined);
  }

  async function run(message: ToHost): Promise<FromHost> {
    switch (message.type) {
      case "open": {
        const conversation = await (await loaded()).open(message.settings);
        const conversationId = ++nextConversation;
        conversations.set(conversationId, conversation);
        return {type: "opened", requestId: message.requestId, conversationId};
      }
      case "ask": {
        const conversation = conversations.get(message.conversationId);
        if (!conversation) return {type: "failed", requestId: message.requestId, code: "MODEL_FAILED"};
        return {type: "answer", requestId: message.requestId, value: await conversation.ask(message.userText, message.form, message.maxTokens)};
      }
      case "close": {
        const conversation = conversations.get(message.conversationId);
        if (conversation) {
          // Dropped only once the close has actually gone through. A conversation whose close was
          // refused is still the host's to free, and only this map can still reach it: forgetting it
          // here would leave its context allocated until the process dies.
          await conversation.close();
          conversations.delete(message.conversationId);
        }
        return {type: "done", requestId: message.requestId};
      }
      case "unload":
        await unload();
        return {type: "done", requestId: message.requestId};
    }
  }

  /**
   * The one way out of here. `post` is the channel to main, which can be gone (main quit, the
   * process is being torn down) and then throws: that must never escape `onMessage`, because an
   * unhandled rejection in the host process is the whole model runner dying over a reply nobody is
   * waiting for any more.
   */
  const reply = (message: FromHost): void => { try { post(message); } catch { /* nobody is listening any more */ } };

  return {
    async onMessage(raw) {
      const parsed = toHostShape.safeParse(raw);
      if (!parsed.success) {
        // No usable `requestId`, no reply: main matches replies to callers by that number, so a
        // reply carrying anything else would resolve a request this message is not an answer to.
        // Such a message is dropped in silence; main's own request timeout answers its caller.
        const requestId = (raw as {requestId?: unknown} | null)?.requestId;
        if (typeof requestId === "number") reply({type: "failed", requestId, code: "MODEL_FAILED"});
        return;
      }
      try { reply(await run(parsed.data as ToHost)); }
      catch { reply({type: "failed", requestId: parsed.data.requestId, code: "MODEL_FAILED"}); }
    },
    shutdown: unload
  };
}
