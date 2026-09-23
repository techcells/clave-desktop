// Bundles the four programs of the desktop app with esbuild. Run from the repo root: pnpm --dir app build
import {build} from "esbuild";
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {findForbiddenRendererInputs, PREVIEW_FORBIDDEN, PRODUCTION_FORBIDDEN, rendererBuildOptions} from "./rendererBuildOptions.mjs";
import {nodeModulesInputs, packageDirOf, standinInputs, uniquePackages} from "./bundled.mjs";
import {chosenLicence, licenceField, pickLicenceFile} from "./package/licences.mjs";
import {buildInfo, flavourDefines, parseFlavour} from "./flavour.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "dist");
/**
 * The dev preview is a SIBLING of dist/, not a folder inside it. Inside, every `build` and every
 * `smoke` wiped it (they clear dist/ first), so the preview was only ever there until the next
 * build of the app — and a static server pointed at it served a 404 the rest of the time.
 */
const previewOut = join(app, "dist-preview");

// The page the app links to from the pitch and from About. It is part of the promise, not a nicety:
// a build that cannot ship it is a build whose claims cannot be checked, so it fails here rather
// than shipping a link to nothing.
const whatLeaves = join(app, "..", "docs", "WHAT-LEAVES.md");
if (!existsSync(whatLeaves)) {
  console.error("BUILD_FAILED WHAT_LEAVES_MISSING", whatLeaves);
  process.exit(1);
}

// Which app this build is (packaging design, section 2). Baked into every bundle as two string
// literals; a bad `--flavour` value refuses rather than falling back to dev.
const parsed = parseFlavour(process.argv);
if (parsed.error) {
  console.error("BUILD_FAILED", parsed.error, "use: --flavour dev|internal|release");
  process.exit(1);
}
const flavour = parsed.flavour;
const define = flavourDefines(flavour);

rmSync(out, {recursive: true, force: true});
mkdirSync(join(out, "renderer"), {recursive: true});

// `absWorkingDir`: metafile input paths are then relative to app/, whatever the shell's cwd was.
const node = {bundle: true, platform: "node", target: "node22", sourcemap: false, logLevel: "warning", define, absWorkingDir: app};
const [mainResult, preloadResult, hostResult, , rendererResult] = await Promise.all([
  // Main process. CommonJS, so `__dirname` exists. Electron is provided by the runtime.
  build({...node, entryPoints: [join(app, "src/shell/app.ts")], format: "cjs", outfile: join(out, "main.cjs"), external: ["electron"], metafile: true}),
  // A sandboxed preload must be CommonJS.
  build({...node, entryPoints: [join(app, "src/shell/preload.ts")], format: "cjs", outfile: join(out, "preload.cjs"), external: ["electron"], metafile: true}),
  // The model host. node-llama-cpp is ESM with native binaries: never bundled.
  build({...node, entryPoints: [join(app, "src/shell/modelHostEntry.ts")], format: "esm", outfile: join(out, "model-host.mjs"), external: ["electron", "node-llama-cpp"], metafile: true}),
  // The release gate for the real model (a plain Node command, no Electron).
  build({...node, entryPoints: [join(app, "src/eval/gateCli.ts")], format: "esm", outfile: join(out, "eval-gate.mjs"), external: ["node-llama-cpp"]}),
  // The renderer: a browser bundle, always a PRODUCTION one. React's development build ships
  // warnings, prop checks and readable component names; none of that belongs in a window that shows
  // somebody's evidence, and `NODE_ENV` is what React switches on. `legalComments: "none"` keeps the
  // licence banners out of the one file the CSP allows to run. `rendererBuildOptions` is the exact
  // same object the import-boundary test builds with, so the two can never drift apart.
  build({...rendererBuildOptions, define: {...rendererBuildOptions.define, ...define}, absWorkingDir: app, entryPoints: [join(app, "src/renderer/main.tsx")], outfile: join(out, "renderer/main.js"), metafile: true}),
  // The staged-window evaluation's reading half (pnpm --dir app reader:eval). Built exactly like
  // main.cjs -- CommonJS, electron external -- because it is an Electron main script too: the dev
  // bundle loads it INSTEAD of the app when CLAVE_DEV_ENTRY=reader-eval (scripts/dev-launcher.cjs),
  // which is the only way the Screen Recording grant belongs to the app rather than to a terminal.
  // It ships in every build and costs nothing when nothing loads it.
  build({...node, entryPoints: [join(app, "src/readerEval/main.ts")], format: "cjs", outfile: join(out, "reader-eval.cjs"), external: ["electron"]})
]);

// The regex guard in src/renderer/model/views.test.ts is a fast pre-check over source text, but
// source text can be spelled around (a no-op backslash escape reads as nonsense to a pattern and as
// the real specifier to esbuild). This is the check that cannot be fooled that way: it asks esbuild
// what module graph it actually built, not what the source merely says.
const forbidden = findForbiddenRendererInputs(rendererResult.metafile, PRODUCTION_FORBIDDEN);
if (forbidden.length > 0) {
  console.error("BUILD_FAILED RENDERER_IMPORTS_FORBIDDEN", forbidden[0]);
  process.exit(1);
}

cpSync(join(app, "src/renderer/index.html"), join(out, "renderer/index.html"));
// esbuild writes main.css next to main.js as soon as the entry imports a stylesheet, and writes
// nothing while it does not. index.html links it either way, so the file is always there: a missing
// stylesheet under `default-src 'none'` is a console error the CSP reports, not a page that degrades.
const css = join(out, "renderer/main.css");
if (!existsSync(css)) writeFileSync(css, "");
cpSync(join(app, "src/standins/taxonomy.json"), join(out, "standins-taxonomy.json"));
cpSync(whatLeaves, join(out, "WHAT-LEAVES.md"));
// The tray icon. macOS draws the tray as text (●/○/!) and never loads it; Windows has no tray text,
// and a tray with no image there is an invisible one.
cpSync(join(app, "build/icon-preview.png"), join(out, "tray.png"));
// What this dist IS, for the staging step (which refuses a dist built for another flavour) and for
// About. The version is the app's own from package.json; the build number is the UTC minute.
const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
writeFileSync(join(out, "build.json"), JSON.stringify(buildInfo({flavour, version, date: new Date()})) + "\n");
// The release gate (design section 2): a release build carries no stand-in. Until sub-project D wires
// the real client into app.ts, this refuses, which is the point: a release cannot be built by accident.
if (flavour === "release") {
  const standins = standinInputs(mainResult.metafile);
  if (standins.length > 0) {
    console.error("BUILD_FAILED STANDINS_IN_RELEASE", standins[0]);
    process.exit(1);
  }
}
// The packages esbuild inlined into the SHIPPED bundles, with their licence, for the licence file
// the staging step generates (they are not in the staged node_modules). Consumed at staging, never
// shipped. A bundled package without a package.json in reach is a build failure: a licence nobody
// can name is not shipped.
const bundled = [];
for (const input of nodeModulesInputs([mainResult.metafile, preloadResult.metafile, hostResult.metafile, rendererResult.metafile])) {
  const dir = packageDirOf(join(app, input), existsSync);
  if (dir === null) { console.error("BUILD_FAILED BUNDLED_PACKAGE_UNRESOLVED", input); process.exit(1); }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") { console.error("BUILD_FAILED BUNDLED_PACKAGE_UNNAMED", input); process.exit(1); }
  const licence = licenceField(pkg);
  const licenceFile = pickLicenceFile(readdirSync(dir).filter((f) => /^(licen[cs]e|copying)/i.test(f)).sort(), chosenLicence(licence));
  bundled.push({
    name: pkg.name, version: pkg.version,
    licence,
    source: typeof pkg.homepage === "string" ? pkg.homepage : typeof pkg.repository === "string" ? pkg.repository : typeof pkg.repository?.url === "string" ? pkg.repository.url : undefined,
    licenceText: licenceFile ? readFileSync(join(dir, licenceFile), "utf8") : null
  });
}
writeFileSync(join(out, "bundled-packages.json"), JSON.stringify(uniquePackages(bundled), null, 2) + "\n");

// The native reader helper, when it has been built (pnpm --dir app build:native). dist/ was wiped a
// few lines up, so it is copied in on every build; without it the app still builds, and asking for the
// real reader then fails at launch with READER_HELPER_MISSING rather than here.
const helperName = process.platform === "win32" ? "clave-reader.exe" : "clave-reader";
const helper = join(app, "native/reader/target/release", helperName);
if (existsSync(helper)) {
  mkdirSync(join(out, "native"), {recursive: true});
  cpSync(helper, join(out, "native", helperName));
}

// The dev preview: the same App and the same stylesheet, mounted in a browser against an in-memory
// ClaveBridge, so the four screens can be LOOKED AT without an Electron window. It is an extra
// output and never a part of the app: it is emitted only for `--preview`, its own entry is
// src/renderer/dev/preview.tsx (which main.tsx does not import — and which the production check
// above now REFUSES by folder, not merely by not happening to reach it), and it is written outside
// dist/ entirely, so nothing in dist/ can load it and no app build can delete it.
if (process.argv.includes("--preview")) {
  rmSync(previewOut, {recursive: true, force: true});
  mkdirSync(previewOut, {recursive: true});
  const previewResult = await build({
    ...rendererBuildOptions,
    define: {...rendererBuildOptions.define, ...define},
    entryPoints: [join(app, "src/renderer/dev/preview.tsx")],
    outfile: join(previewOut, "preview.js"),
    minify: false,
    metafile: true
  });
  // The preview is a browser page too: main-process code has no business in it either. Its own
  // folder is the one thing it may import that the app may not.
  const previewForbidden = findForbiddenRendererInputs(previewResult.metafile, PREVIEW_FORBIDDEN);
  if (previewForbidden.length > 0) {
    console.error("BUILD_FAILED PREVIEW_IMPORTS_FORBIDDEN", previewForbidden[0]);
    process.exit(1);
  }
  // A neutral backdrop with the window at its real 420 x 600, so it reads as the real thing. This
  // page's own chrome (the backdrop, the scenario links) is written here rather than in styles.css:
  // nothing about the preview belongs in the stylesheet the app ships.
  writeFileSync(join(previewOut, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Clave Agent preview</title>
    <link rel="stylesheet" href="./preview.css" />
    <style>
      body { min-height: 100vh; background: #8a8781; display: block; padding: 22px 0 40px; }
      @media (prefers-color-scheme: dark) { body { background: #0a0b0c; } }
      #root { display: flex; flex-direction: column; align-items: center; gap: 20px; }
      .window { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); }
      .picker { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 10px; max-width: 700px; }
      .picker a { font: 10px/1.6 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: #f2efe8; text-decoration: none; opacity: 0.6; }
      .picker a:hover { opacity: 1; text-decoration: underline; }
      .picker a.picker-here { opacity: 1; text-decoration: underline; text-underline-offset: 3px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./preview.js"></script>
  </body>
</html>
`);
  console.log("built", previewOut);
}

console.log("built", out, "flavour", flavour);
