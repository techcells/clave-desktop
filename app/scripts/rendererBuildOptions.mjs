// The esbuild options for the renderer bundle, and the check that its module graph never reaches
// main-process code or a runtime the renderer's single <script> tag cannot provide. Shared between
// the production build (scripts/build.mjs) and the import-boundary test
// (src/renderer/bundle.guard.test.ts), so the two can never drift apart: whatever esbuild is told
// to do to produce the real bundle is exactly what the guard interrogates.
//
// A regex over source text loses this fight — a no-op backslash escape (`from "\electron"`,
// `from "../m\ain/engine"`) reads as nonsense to a naive pattern but decodes to the real specifier
// under esbuild's own string-literal parser, which is what actually resolves the module. Building
// the real graph and inspecting esbuild's own metafile means there is nothing left to spell around:
// whatever esbuild resolved is what shipped.

/**
 * Identical to the options scripts/build.mjs passes for the renderer build, minus `entryPoints`,
 * `outfile`, `write` and `metafile`, which callers supply (a real build writes to disk; the guard
 * test builds throwaway entries in memory).
 */
export const rendererBuildOptions = {
  bundle: true,
  platform: "browser",
  target: "chrome130",
  format: "iife",
  logLevel: "warning",
  jsx: "automatic",
  minify: true,
  define: {"process.env.NODE_ENV": '"production"'},
  legalComments: "none",
  loader: {".woff2": "file", ".svg": "file", ".png": "file"},
  assetNames: "assets/[name]-[hash]"
};

/**
 * The folders under `src/` the PRODUCTION renderer bundle may never include a file from.
 * `renderer/dev` is on this list and not on the preview's: the dev preview's whole job is to mount
 * the real App against an in-memory stand-in bridge, so its own entry legitimately imports
 * `renderer/dev/` — while the shipped window importing one byte of it would mean a mock bridge, a
 * scenario picker and twelve fabricated statements inside the app somebody trusts with their screen.
 */
export const PRODUCTION_FORBIDDEN = ["main", "core", "shell", "standins", "renderer/dev"];

/** The same, for the dev preview: main-process code has no business in a browser page either. */
export const PREVIEW_FORBIDDEN = ["main", "core", "shell", "standins"];

/** One folder list as a pattern over an esbuild input path, in either slash style. */
const forbiddenInput = (folders) =>
  new RegExp(`(^|[\\\\/])src[\\\\/](?:${folders.map((f) => f.split("/").join("[\\\\/]")).join("|")})([\\\\/]|$)`);

/** Node's built-in module names, the ones a bare specifier (no `node:` prefix) can still name. */
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "domain", "events", "fs",
  "http", "http2", "https", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib", "module", "inspector", "async_hooks", "diagnostics_channel", "constants",
  "sys", "wasi"
]);

/** True for a specifier the renderer bundle may never actually load at run time. */
export function isForbiddenRuntimeSpecifier(specifier) {
  if (specifier === "electron") return true;
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

/**
 * Checks an esbuild metafile from a renderer build for the two ways it could smuggle in code the
 * bundle must never ship: an input file that was actually pulled from a forbidden folder, or an
 * import that esbuild left external and that names Electron or a Node built-in. Returns the
 * offending input paths / specifiers, empty when the graph is clean.
 *
 * `folders` is a parameter because the two browser bundles this repo builds do not forbid the same
 * things: see `PRODUCTION_FORBIDDEN` and `PREVIEW_FORBIDDEN` above. It defaults to the stricter of
 * the two, so a caller that forgets to say gets the production rule.
 *
 * Note what this does NOT need to handle: esbuild given `platform: "browser"` (no `external` list)
 * cannot resolve "electron" or a `node:` specifier to a real module at all, so those forms surface
 * as a thrown build error instead of a clean metafile — the caller's try/catch covers that case.
 * This function exists for the forms that build successfully: a relative import that resolves to a
 * real file under a forbidden folder.
 */
export function findForbiddenRendererInputs(metafile, folders = PRODUCTION_FORBIDDEN) {
  const pattern = forbiddenInput(folders);
  const offenders = [];
  for (const inputPath of Object.keys(metafile.inputs)) {
    if (pattern.test(inputPath)) offenders.push(inputPath);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.external && isForbiddenRuntimeSpecifier(imp.path)) offenders.push(imp.path);
    }
  }
  return offenders;
}
