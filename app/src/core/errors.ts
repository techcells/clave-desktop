/** Fixed codes only. A CoreError never carries captured text. */
export type CoreErrorCode =
  | "CONFIG_INVALID" | "SCRUB_FAILED" | "MODEL_FAILED" | "MODEL_TIMEOUT"
  | "MODEL_ANSWER_INVALID" | "POOL_IMPORT_INVALID";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "CoreError";
    this.code = code;
  }
}
