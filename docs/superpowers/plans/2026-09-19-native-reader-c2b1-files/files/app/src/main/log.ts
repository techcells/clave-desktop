import {LOG_MAX_BYTES} from "./constants";
import type {FileSystem, Now} from "./ports/system";

/** Every code the app is allowed to log. A code outside this set is written as `LOG_BAD_CODE`. */
export const LOG_CODES = [
  "CAPTURE_ON", "CAPTURE_OFF", "READER_PROBLEM", "STORAGE_PROBLEM", "MODEL_PROBLEM",
  "EXTRACTION_PAUSED", "EXTRACTION_RESUMED", "SELF_TEST_PASSED", "SELF_TEST_FAILED",
  "SESSION_FILE_UNREADABLE", "OUTBOX_FILE_UNREADABLE", "POOL_FILE_UNREADABLE",
  "LOG_BAD_CODE", "BACKGROUND_TASK_FAILED", "SETTINGS_FILE_UNREADABLE", "PERMISSION_LOST", "DATA_DELETED", "OUTBOX_DISCARDED", "SETTINGS_RESET_FOR_NEW_OWNER",
  // The native reader's supervisor (main/reader/readerClient.ts). Codes only, like everything else here.
  "READER_HELPER_EXIT", "READER_HELPER_START_TIMEOUT", "READER_HELPER_WEDGED", "READER_PROTOCOL_MISMATCH", "READER_HELPER_GAVE_UP", "READER_HELPER_REPLACED",
  // Reading was on and nothing came through it for a long time. Not a failure and not a blocker.
  "READER_NOTHING_TO_READ"
] as const;
export type LogCode = typeof LOG_CODES[number];

/**
 * Every count key the app is allowed to log. A key outside this set is dropped, never written.
 *
 * The long tail is the capture loop's `CycleOutcome` names, one key each — what `READER_NOTHING_TO_READ`
 * and `CAPTURE_OFF` tally. They are fixed identifiers of this codebase, exactly like the codes above:
 * no window title, app name or recognised text can be spelled as one of them, which is the whole
 * reason the set is closed rather than a pattern. `main/engine.ts` asserts at compile time that every
 * outcome the loop can report has a key here, so a new outcome cannot arrive as a dropped count.
 */
export const LOG_COUNT_KEYS = [
  "blockers", "failures", "count",
  "kept", "unchanged", "noWindow", "windowGone", "black", "windowChanged", "denied", "notKept",
  "locked", "userAway", "stopped", "timeout", "failed", "empty"
] as const;
export type LogCountKey = typeof LOG_COUNT_KEYS[number];

const CODE_SET: ReadonlySet<string> = new Set(LOG_CODES);
const COUNT_KEY_SET: ReadonlySet<string> = new Set(LOG_COUNT_KEYS);

export interface AppLog {
  /** `code` must be a member of `LOG_CODES`; anything else is recorded as `LOG_BAD_CODE`. */
  event(code: LogCode, counts?: Partial<Record<LogCountKey, number>>): Promise<void>;
}

/**
 * Fixed codes and fixed count keys only, checked against closed sets rather than a pattern. There is
 * deliberately no way to log a sentence, so nothing read from a screen can reach this file by accident —
 * a caller reached through JS/IPC that lies about its argument types cannot smuggle free text through
 * either, because membership is checked at runtime regardless of what TypeScript believed at compile time.
 */
export function createLog(deps: {fs: FileSystem; path: string; now: Now}): AppLog {
  const {fs, path, now} = deps;
  const encoder = new TextEncoder();
  return {
    async event(code, counts = {}) {
      const safeCode: LogCode = CODE_SET.has(code) ? code : "LOG_BAD_CODE";
      const safeCounts: Partial<Record<LogCountKey, number>> = {};
      for (const [key, value] of Object.entries(counts)) {
        if (COUNT_KEY_SET.has(key) && typeof value === "number" && Number.isFinite(value)) {
          safeCounts[key as LogCountKey] = value;
        }
      }
      const line = `${JSON.stringify({at: now(), code: safeCode, counts: safeCounts})}\n`;
      try {
        if (await fs.size(path) > LOG_MAX_BYTES) await fs.remove(path);
        await fs.append(path, encoder.encode(line));
      } catch { /* a log that cannot be written must never stop the app */ }
    }
  };
}
