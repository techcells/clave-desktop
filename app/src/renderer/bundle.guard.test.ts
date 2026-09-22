/**
 * The regex guard in model/views.test.ts (`rendererProblems`) reads source text, and source text
 * can be spelled around: a no-op backslash escape (`from "\electron"`, `from "../m\ain/engine"`,
 * `from "n\ode:fs"`) is nonsense to a pattern but decodes to the real specifier under esbuild's own
 * string-literal parser — the parser that actually resolves the module. All three return `[]` from
 * the regex guard while esbuild resolves them to the forbidden module all the same.
 *
 * A regex over source cannot win that fight. This file asks the bundler instead: it builds the real
 * renderer entry with the exact options the production build uses (`rendererBuildOptions`, shared
 * with scripts/build.mjs so the two can never drift), then inspects esbuild's own metafile — the
 * module graph esbuild actually resolved, not what the source merely says.
 */
import {build} from "esbuild";
import type {Metafile} from "esbuild";
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {findForbiddenRendererInputs, PREVIEW_FORBIDDEN, PRODUCTION_FORBIDDEN, rendererBuildOptions} from "../../scripts/rendererBuildOptions.mjs";

const rendererDir = fileURLToPath(new URL(".", import.meta.url));
const app = fileURLToPath(new URL("../..", import.meta.url));
const tmpDir = join(rendererDir, ".guard-tmp");

/**
 * Builds one entry file with the production renderer options, `write: false` so nothing ever lands
 * on disk. Returns `{rejected: true}` when esbuild throws (its own way of refusing a specifier it
 * cannot resolve under `platform: "browser"`, e.g. "electron" or a `node:` built-in) or when the
 * metafile it produced still contains a forbidden input/import; `{rejected: false, metafile}`
 * otherwise. Either way, this is the one check both the test and scripts/build.mjs use.
 */
async function attempt(entryPath: string, folders: string[] = PRODUCTION_FORBIDDEN): Promise<{rejected: boolean; metafile?: Metafile}> {
  try {
    const result = await build({...rendererBuildOptions, entryPoints: [entryPath], outfile: entryPath + ".out.js", write: false, metafile: true, logLevel: "silent"});
    const offenders = findForbiddenRendererInputs(result.metafile, folders);
    return {rejected: offenders.length > 0, metafile: result.metafile};
  } catch {
    return {rejected: true};
  }
}

describe("the renderer bundle's real module graph", () => {
  it("never pulls in main/, core/, shell/, standins/, electron, or a Node built-in", async () => {
    const result = await build({...rendererBuildOptions, entryPoints: [join(app, "src/renderer/main.tsx")], outfile: join(app, "dist-guard-probe/main.js"), write: false, metafile: true, logLevel: "silent"});
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input, input).not.toMatch(/[\\/]src[\\/]main[\\/]/);
      expect(input, input).not.toMatch(/[\\/]src[\\/]core[\\/]/);
      expect(input, input).not.toMatch(/[\\/]src[\\/]shell[\\/]/);
      expect(input, input).not.toMatch(/[\\/]src[\\/]standins[\\/]/);
    }
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imp of output.imports ?? []) {
        if (imp.external) {
          expect(imp.path).not.toBe("electron");
          expect(imp.path.startsWith("node:")).toBe(false);
        }
      }
    }
    expect(findForbiddenRendererInputs(result.metafile)).toEqual([]);
  });
});

describe("the guard bites on every spelling that got past the regex", () => {
  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  const write = (name: string, content: string): string => {
    mkdirSync(tmpDir, {recursive: true});
    const path = join(tmpDir, name);
    writeFileSync(path, content);
    return path;
  };

  const rejectedCases: ReadonlyArray<readonly [string, string, string]> = [
    ["a plain value import of ../main/engine", "plain.ts", 'import {createEngine} from "../../main/engine";\nexport {createEngine};\n'],
    ["the statement-not-at-line-start form", "not-line-start.ts", 'const a = 1;import {createEngine} from "../../main/engine";\nexport {createEngine, a};\n'],
    ["a no-op backslash escape inside the main/ specifier", "noop-escape.ts", 'import {createEngine} from "../../m\\ain/engine";\nexport {createEngine};\n'],
    ["a star re-export of core/", "star-export.ts", 'export * from "../../core/index";\n'],
    ["a side-effect import of shell/trust", "side-effect.ts", 'import "../../shell/trust";\nexport {};\n'],
    ["a no-op backslash escape spelling electron", "electron-escape.ts", 'import {ipcRenderer} from "\\electron";\nexport {ipcRenderer};\n'],
    ["a no-op backslash escape spelling node:fs", "node-fs-escape.ts", 'import {readFileSync} from "n\\ode:fs";\nexport {readFileSync};\n'],
    ["a dynamic import of main/engine", "dynamic-import.ts", 'export async function later() { return import("../../main/engine"); }\n'],
    ["a require() of main/engine", "require-call.ts", 'export const engine = require("../../main/engine");\n']
  ];

  it.each(rejectedCases)("rejects %s", async (_name, fileName, content) => {
    const entry = write(fileName, content);
    const result = await attempt(entry);
    expect(result.rejected, JSON.stringify(result.metafile?.inputs ?? {})).toBe(true);
  });

  /**
   * The dev folder is the one difference between the two browser bundles this repo builds. The app
   * may not touch it — it holds a mock bridge, twelve fabricated statements and a scenario picker,
   * and a shipped window that imported any of it would be showing somebody invented evidence. The
   * preview's whole job is to import it. Before this, nothing REFUSED it in the app: the production
   * graph merely happened not to reach it, which is a fact about today's imports, not a rule.
   */
  it("refuses src/renderer/dev/ in the app and allows it in the preview", async () => {
    const entry = write("uses-dev.ts", 'import {SCENARIOS} from "../dev/mockBridge";\nexport {SCENARIOS};\n');
    expect((await attempt(entry, PRODUCTION_FORBIDDEN)).rejected).toBe(true);
    expect((await attempt(entry, PREVIEW_FORBIDDEN)).rejected).toBe(false);
  });

  it("refuses main/ in the preview as well", async () => {
    const entry = write("preview-reaches-main.ts", 'import {createEngine} from "../../main/engine";\nexport {createEngine};\n');
    expect((await attempt(entry, PREVIEW_FORBIDDEN)).rejected).toBe(true);
  });

  it("passes a harmless file that only takes a type from shared/ipc and mentions main/ in prose", async () => {
    const entry = write("harmless.ts", 'import type {EngineStatus} from "../../shared/ipc";\n// see the main/ folder for details\nexport const x: EngineStatus | null = null;\n');
    const result = await attempt(entry);
    expect(result.rejected).toBe(false);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("harmless.ts");
  });
});
