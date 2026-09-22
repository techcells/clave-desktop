import {describe, expect, it} from "vitest";
import type {ModelSettings} from "../../core/types";
import {createHostCore, type ModelBinding} from "./hostCore";
import type {FromHost} from "./protocol";

const SETTINGS: ModelSettings = {systemPrompt: "system", thoughts: "discourage", templateVariation: "3.5", temperature: 0.2};

function fakeBinding(opts: {failLoads?: number; failAsk?: boolean; failCloses?: number} = {}) {
  const log: string[] = [];
  let failLoads = opts.failLoads ?? 0;
  let failCloses = opts.failCloses ?? 0;
  const binding: ModelBinding = {
    async load(path) {
      log.push(`load:${path}`);
      if (failLoads-- > 0) throw new Error("out of memory while reading the secret prompt");
      return {
        async open(settings) {
          log.push(`open:${settings.temperature}`);
          return {
            async ask(userText, _form, maxTokens) { if (opts.failAsk) throw new Error(`cannot answer: ${userText}`); log.push(`ask:${maxTokens}`); return {echo: userText.length}; },
            async close() { if (failCloses-- > 0) { log.push("close-failed"); throw new Error("the context would not let go"); } log.push("close"); }
          };
        },
        async dispose() { log.push("dispose"); }
      };
    }
  };
  return {binding, log};
}

function setup(opts: Parameters<typeof fakeBinding>[0] & {failPost?: boolean} = {}) {
  const {binding, log} = fakeBinding(opts);
  const replies: FromHost[] = [];
  const core = createHostCore({binding, modelPath: "/m/q.gguf", post: (m) => { if (opts.failPost) throw new Error("the channel to main is gone"); replies.push(m); }});
  return {core, log, replies};
}

describe("model host core", () => {
  it("loads the model on the first open, once, and carries a conversation", async () => {
    const {core, log, replies} = setup();
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "open", requestId: 2, settings: {...SETTINGS, temperature: 0}});
    await core.onMessage({type: "ask", requestId: 3, conversationId: 1, userText: "hello", form: {type: "object"}, maxTokens: 300});
    await core.onMessage({type: "close", requestId: 4, conversationId: 1});
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2", "open:0", "ask:300", "close"]);
    expect(replies).toEqual([
      {type: "opened", requestId: 1, conversationId: 1}, {type: "opened", requestId: 2, conversationId: 2},
      {type: "answer", requestId: 3, value: {echo: 5}}, {type: "done", requestId: 4}
    ]);
  });

  it("answers a failure with the fixed code and never with the runtime's message", async () => {
    const {core, replies} = setup({failAsk: true});
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "ask", requestId: 2, conversationId: 1, userText: "Priya's password is hunter2", form: {}, maxTokens: 10});
    expect(replies[1]).toEqual({type: "failed", requestId: 2, code: "MODEL_FAILED"});
    expect(JSON.stringify(replies)).not.toContain("hunter2");
  });

  it("fails an ask or close on an unknown conversation without throwing", async () => {
    const {core, replies} = setup();
    await core.onMessage({type: "ask", requestId: 1, conversationId: 9, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "close", requestId: 2, conversationId: 9});
    expect(replies).toEqual([{type: "failed", requestId: 1, code: "MODEL_FAILED"}, {type: "done", requestId: 2}]);
  });

  it("tries the load again after a failed one", async () => {
    const {core, log, replies} = setup({failLoads: 1});
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "open", requestId: 2, settings: SETTINGS});
    expect(replies.map((r) => r.type)).toEqual(["failed", "opened"]);
    expect(log.filter((l) => l.startsWith("load"))).toHaveLength(2);
  });

  it("unload closes what is open, frees the model, and the next open loads it again", async () => {
    const {core, log, replies} = setup();
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "unload", requestId: 2});
    await core.onMessage({type: "ask", requestId: 3, conversationId: 1, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "open", requestId: 4, settings: SETTINGS});
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2", "close", "dispose", "load:/m/q.gguf", "open:0.2"]);
    expect(replies.map((r) => r.type)).toEqual(["opened", "done", "failed", "opened"]);
  });

  it("ignores garbage, and fails a malformed request that at least carries an id", async () => {
    const {core, replies} = setup();
    await core.onMessage(null); await core.onMessage("open"); await core.onMessage({type: "open"});
    // A request whose id is not a number has nothing to reply TO: `requestId` is how main matches a
    // reply to its caller, so a reply carrying a forged one would resolve somebody else's request.
    // Such a message is dropped in silence, and main's own request timeout is what answers its caller.
    await core.onMessage({type: "ask", requestId: "5", conversationId: 1, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "ask", requestId: null, conversationId: 1, userText: "x", form: {}, maxTokens: 10});
    await core.onMessage({type: "ask", requestId: 5, conversationId: "one", userText: 7});
    await core.onMessage({type: "open", requestId: 6, settings: {...SETTINGS, thoughts: "auto"}});
    expect(replies).toEqual([{type: "failed", requestId: 5, code: "MODEL_FAILED"}, {type: "failed", requestId: 6, code: "MODEL_FAILED"}]);
  });

  it("keeps a conversation whose close failed, so unload can still free it", async () => {
    const {core, log, replies} = setup({failCloses: 1});
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "close", requestId: 2, conversationId: 1});
    expect(replies[1]).toEqual({type: "failed", requestId: 2, code: "MODEL_FAILED"});

    // The close was refused, so the conversation is still the host's to close: it must not have been
    // dropped from the map, or nothing would ever free the context behind it.
    await core.onMessage({type: "unload", requestId: 3});
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2", "close-failed", "close", "dispose"]);
    expect(replies[2]).toEqual({type: "done", requestId: 3});
  });

  it("closes a conversation exactly once when the close succeeded", async () => {
    const {core, log} = setup();
    await core.onMessage({type: "open", requestId: 1, settings: SETTINGS});
    await core.onMessage({type: "close", requestId: 2, conversationId: 1});
    await core.onMessage({type: "close", requestId: 3, conversationId: 1});
    await core.onMessage({type: "unload", requestId: 4});
    expect(log.filter((l) => l === "close")).toEqual(["close"]);
  });

  it("never lets a channel that has gone away become an unhandled rejection", async () => {
    const {core, log} = setup({failPost: true});
    // Both a reply and the failure reply that would follow it are refused by the channel. Neither
    // may escape `onMessage`: the host would take the whole utility process down with it.
    await expect(core.onMessage({type: "open", requestId: 1, settings: SETTINGS})).resolves.toBeUndefined();
    await expect(core.onMessage({type: "ask", requestId: 2, conversationId: 9, userText: "x", form: {}, maxTokens: 10})).resolves.toBeUndefined();
    await expect(core.onMessage({type: "ask", requestId: "3"})).resolves.toBeUndefined();
    expect(log).toEqual(["load:/m/q.gguf", "open:0.2"]);      // the work itself still happened
    await expect(core.shutdown()).resolves.toBeUndefined();
  });
});
