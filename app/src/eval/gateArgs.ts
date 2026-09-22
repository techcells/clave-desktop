/** Where the two paths are read from the disk. Injected so the parsing below is pure and testable. */
export interface PathKinds { isFile(path: string): boolean; isDirectory(path: string): boolean }

export const GATE_USAGE = "usage: eval-gate <model.gguf> <fixtures dir>\n";
/** `EX_USAGE` from sysexits.h: the shell convention for "you called this wrong". */
export const GATE_USAGE_EXIT = 64;

export type GateArgs = {ok: true; modelPath: string; fixturesDir: string} | {ok: false};

/**
 * The gate's command line. `pnpm eval:gate -- <model> <fixtures>` hands the script a leading `--`,
 * so that is dropped rather than mistaken for the model path. Both paths are checked for what they
 * must be: a model that is a folder, or a fixtures folder that is a file, is a mistake worth saying
 * out loud before a 2.7 GB model is loaded — and never a stack trace from deep inside `readdirSync`.
 */
export function parseGateArgs(argv: readonly string[], kinds: PathKinds): GateArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const [modelPath, fixturesDir] = args;
  if (!modelPath || !fixturesDir || args.length > 2) return {ok: false};
  if (!kinds.isFile(modelPath) || !kinds.isDirectory(fixturesDir)) return {ok: false};
  return {ok: true, modelPath, fixturesDir};
}
