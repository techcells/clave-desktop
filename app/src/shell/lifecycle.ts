/**
 * The two rules the shell needs around anything that can fail on its own: a promise nobody awaits
 * must not become an unhandled rejection, and nothing that reaches a console may carry a message.
 * Both are pure functions over an output sink, so both are tested without Electron.
 */

/** The only line a failed background task ever writes. No error text: a message could carry screen text. */
export const BACKGROUND_TASK_FAILED = "BACKGROUND_TASK_FAILED";

/**
 * Starts work whose result nobody waits for (the model check at launch, a tray click, the quit
 * sequence). A rejection is swallowed after one fixed line, so a failure is visible in a terminal
 * and invisible everywhere else.
 */
export function background(promise: Promise<unknown>, write: (line: string) => void = (line) => void process.stderr.write(line)): void {
  void promise.then(
    () => undefined,
    () => { write(`${BACKGROUND_TASK_FAILED}\n`); }
  );
}

/** The only reasons launch can fail before the window exists. Anything else is UNKNOWN. */
export const START_FAILURES = ["NO_READER_YET", "STANDIN_TAXONOMY_INVALID", "STANDIN_IN_PRODUCTION", "READER_HELPER_MISSING"] as const;
export type StartFailure = typeof START_FAILURES[number] | "UNKNOWN";

/**
 * The code printed after START_FAILED. Only a value from the list above ever leaves: an error
 * message or an error's own `code` could be a path, a URL or a line of somebody's screen.
 */
export function startFailureCode(error: unknown): StartFailure {
  const candidates = error instanceof Error ? [error.message, (error as {code?: unknown}).code] : [error];
  for (const candidate of candidates) {
    const found = START_FAILURES.find((code) => code === candidate);
    if (found) return found;
  }
  return "UNKNOWN";
}
