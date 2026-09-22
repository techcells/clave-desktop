import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {createModelClient} from "../main/model/client";
import {createInProcessLink} from "../main/model/inProcessLink";
import {createLlamaBinding} from "../main/model/llamaBinding";
import {runGate} from "./gate";
import {GATE_USAGE, GATE_USAGE_EXIT, parseGateArgs, type PathKinds} from "./gateArgs";

const kind = (path: string, want: "file" | "directory"): boolean => {
  try { const info = statSync(path); return want === "file" ? info.isFile() : info.isDirectory(); }
  catch { return false; }
};
const kinds: PathKinds = {isFile: (path) => kind(path, "file"), isDirectory: (path) => kind(path, "directory")};

/** usage: node dist/eval-gate.mjs <model.gguf> <fixtures dir>. Exit code: 0 everything passed, 2 safe but with quality findings, 1 a safety problem, 64 called wrong. */
async function main(): Promise<void> {
  const args = parseGateArgs(process.argv.slice(2), kinds);
  if (!args.ok) { process.stderr.write(GATE_USAGE); process.exit(GATE_USAGE_EXIT); }
  const fixtures = readdirSync(args.fixturesDir).filter((f) => f.endsWith(".json")).sort()
    .map((name) => ({name, value: JSON.parse(readFileSync(join(args.fixturesDir, name), "utf8")) as unknown}));
  const binding = createLlamaBinding();
  const client = createModelClient({spawn: () => createInProcessLink({binding, modelPath: args.modelPath}), now: () => Date.now()});
  const report = await runGate({model: client, fixtures, now: () => Date.now(), onResult: (r) => {
    if (r.skipped) { process.stdout.write(`SKIP  ${r.name}\n`); return; }
    process.stdout.write(`${r.ok ? "PASS" : r.safety ? "FAIL" : "NOTE"}  ${r.name}  ${r.seconds}s${r.ok ? "" : `  ${r.problems.join("; ")}`}\n`);
  }});
  process.stdout.write(`self-test: ${report.selfTest ? "PASS" : "FAIL"}\n${report.passed ? "GATE PASSED" : report.safe ? "GATE SAFE, WITH QUALITY FINDINGS" : "GATE FAILED: SAFETY"}\n`);
  client.shutdown();
  process.exit(report.passed ? 0 : report.safe ? 2 : 1);
}

// One line out and exit 1 for anything that escapes `main` (an unreadable fixture, a model that
// cannot be loaded). A stack trace would be the one place in this project where a path, a fixture's
// text or a prompt could reach a terminal, so there is deliberately none.
void main().catch(() => { process.stderr.write("GATE ERROR\n"); process.exit(1); });
