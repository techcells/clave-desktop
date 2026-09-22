/** Every threshold of the desktop app lives here. No magic numbers elsewhere in `main/`. */

// Capture loop
export const FOCUS_SETTLE_MS = 400;
export const ACTIVE_POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;
export const IDLE_AFTER_SECONDS = 60;
/** No input for this long means the user has left: no reads at all, so the core sees no activity and closes the scenario. */
export const AWAY_AFTER_SECONDS = 5 * 60;
export const READ_BUDGET_MS = 1_500;
/** A `frontWindow()`/`read()` call that never settles must not hang the loop forever. `read` gets this on top of `READ_BUDGET_MS`. */
export const READER_CALL_TIMEOUT_MS = 5_000;
export const PIPELINE_TICK_MS = 10_000;
export const QUIT_DRAIN_MS = 5_000;
export const PAUSE_FOR_MS = 60 * 60_000;

// Reader supervision
export const READER_FAILURE_LIMIT = 5;
export const READER_FAILURE_WINDOW_MS = 10 * 60_000;
/**
 * How long a run of cycles that read nothing has to be before the app admits it. BOTH conditions
 * have to hold, and they are sized so that the time one dominates in ordinary use: 24 cycles is two
 * minutes at the 5 s active poll, so a busy user crosses the count long before the clock. The count
 * is there for the other end — the 30 s idle poll, where 24 cycles is twelve minutes — so that a
 * handful of cycles spread over a long quiet stretch never raises it on their own.
 *
 * Walking away cannot raise it at all: five minutes without input answers `userAway`, which is
 * neutral (it neither extends nor ends a streak), so an empty chair produces no cycles to count.
 */
export const BARREN_CYCLE_LIMIT = 24;
export const BARREN_AFTER_MS = 10 * 60_000;

// Model
export const MODEL_CRASH_LIMIT = 3;
export const MODEL_CRASH_WINDOW_MS = 10 * 60_000;
export const MODEL_IDLE_UNLOAD_MS = 10 * 60_000;
/** Above the core's longest per-ask limit (60 s): a host that never replies must not hang a request forever. */
export const MODEL_REQUEST_TIMEOUT_MS = 90_000;
export const SELF_TEST_TIMEOUT_MS = 120_000;
export const DOWNLOAD_FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;
/** How many new bytes are worth one `downloading` notification. 2.7 GB in 8 MiB steps is ~340 of them. */
export const DOWNLOAD_PROGRESS_STEP_BYTES = 8 * 1024 * 1024;
/** The context one scenario (at most 24,000 characters) plus the prompts and the answer are sized for. */
export const MODEL_CONTEXT_TOKENS = 16_384;
/** Kept free for the answer: a prompt that does not leave this much room is refused, never truncated. */
export const MODEL_CONTEXT_RESERVE_TOKENS = 2_500;
/**
 * How many grammars other than the gate's are kept built. The gate form is one fixed object asked
 * for every scenario, so it is kept for the life of the model; the statements form carries the
 * offered target ids, so it is a different object per taxonomy shape and would otherwise grow
 * without end over a long-running day.
 */
export const MODEL_GRAMMAR_CACHE_MAX = 8;

// Power
export const LOW_BATTERY_LEVEL = 0.2;

// Account
export const SESSION_REFRESH_BEFORE_MS = 24 * 60 * 60_000;
/** After a failed token renewal while running, do not ask again before this much time has passed. */
export const SESSION_REFRESH_RETRY_MS = 15 * 60_000;
export const TAXONOMY_REFRESH_MS = 24 * 60 * 60_000;
/** After a failed taxonomy refresh, do not ask again before this much time has passed, unless forced. */
export const TAXONOMY_RETRY_MS = 15 * 60_000;

/** One clave-back call; the taxonomy is a few hundred kilobytes and gets its own. A silent server must never hang a launch. */
export const API_TIMEOUT_MS = 15_000;
export const API_TAXONOMY_TIMEOUT_MS = 60_000;
/** How long a browser sign-in may take before the app stops listening for it. */
export const OAUTH_TIMEOUT_MS = 5 * 60_000;

// Upload
export const UPLOAD_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

// Review
export const DEFAULT_REVIEW_TIME = "17:30";
export const SCHEDULER_CHECK_MS = 60_000;

// Log
export const LOG_MAX_BYTES = 256 * 1024;

// IPC bounds. What the renderer may send, checked before it reaches the engine. A rule's own length
// is the core's business (`RULE_MAX_LENGTH`), so it is not repeated here.
export const IPC_MAX_RULES = 500;
export const IPC_MAX_ID_CHARS = 200;
export const IPC_MAX_IDENTIFIER_CHARS = 320;      // the longest legal email address
export const IPC_MAX_PASSWORD_CHARS = 1024;
export const IPC_MAX_ONBOARDING_STEP = 100;
