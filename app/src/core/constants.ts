export const PIPELINE_VERSION = "1";

export const BUFFER_MAX_AGE_MS = 60 * 60_000;
export const MIN_READ_CHARS = 40;

export const SCENARIO_IDLE_MS = 5 * 60_000;
export const SCENARIO_AWAY_MS = 2 * 60_000;
export const SCENARIO_MAX_MS = 10 * 60_000;
export const SCENARIO_MIN_CHARS = 400;
export const SCENARIO_MAX_CHARS = 24_000;
export const SNAPSHOTS_PER_WINDOW = 3;
export const SNAPSHOT_MAX_LINE_OVERLAP = 0.6;
export const EXTRACTION_QUEUE_MAX = 3;

export const MAX_CANDIDATE_SKILLS = 20;
export const MAX_PHRASE_TOKENS = 5;

export const GATE_LIMITS = {maxTokens: 300, timeoutMs: 30_000} as const;
export const STATEMENT_LIMITS = {maxTokens: 700, timeoutMs: 60_000} as const;
/** A conversation open that never settles must not wedge the pipeline. */
export const MODEL_OPEN_TIMEOUT_MS = 30_000;
/** A conversation close that never settles must not wedge the pipeline. */
export const MODEL_CLOSE_TIMEOUT_MS = 5_000;
export const SUMMARY_MAX_CHARS = 500;
export const STATEMENT_MAX_CHARS = 260;
export const STATEMENTS_MIN = 1;
export const STATEMENTS_MAX = 5;
export const TEMPERATURE = 0.2;
export const RETRY_TEMPERATURE = 0;

export const GUARD_MIN_WORDS = 8;
export const GUARD_MAX_WORDS = 40;
/** Shortest domain-label / path-segment / file-stem part treated as a proper-noun word. */
export const GUARD_MIN_PART_CHARS = 3;
/** A mixed letter-digit token (e.g. "l8420.50") with more digits than this is a garbled figure, not an identifier like "k8s" or "p95". */
export const GUARD_MIXED_TOKEN_MAX_DIGITS = 2;

export const DIGEST_PER_TARGET = 2;
export const DIGEST_PER_DAY = 10;
export const DIGEST_ITEM_TTL_DAYS = 3;
export const DIGEST_MERGE_OVERLAP = 0.6;

export const RULE_MAX_LENGTH = 200;
