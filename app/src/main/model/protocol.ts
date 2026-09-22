import type {JsonSchema, ModelSettings} from "../../core/types";

/** Messages between main (`client.ts`) and the model host process (`host.ts`, sub-plan B-2). */
export type ToHost =
  | {type: "open"; requestId: number; settings: ModelSettings}
  | {type: "ask"; requestId: number; conversationId: number; userText: string; form: JsonSchema; maxTokens: number}
  | {type: "close"; requestId: number; conversationId: number}
  | {type: "unload"; requestId: number};

export type FromHost =
  | {type: "opened"; requestId: number; conversationId: number}
  | {type: "answer"; requestId: number; value: unknown}
  | {type: "done"; requestId: number}
  /** A fixed code only. The host never puts prompt or answer text in an error. */
  | {type: "failed"; requestId: number; code: "MODEL_FAILED"};

/** One running host process. `spawn` starts it with the verified model file already chosen. */
export interface HostLink {
  send(message: ToHost): void;
  onMessage(cb: (message: FromHost) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}
