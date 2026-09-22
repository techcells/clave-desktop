// Which npm packages esbuild INLINED into the shipped bundles (react, react-dom, scheduler, zod, ...),
// read from esbuild's own metafiles: those packages are not in the staged node_modules, so the
// licence file (scripts/package/licences.mjs) would never see them otherwise (Task 3 review, C1).
// Pure: the filesystem is injected. scripts/build.mjs writes the result to dist/bundled-packages.json,
// which the staging step consumes and never ships.

/** Every input path of the given metafiles that lives under a node_modules folder, once, sorted. */
export function nodeModulesInputs(metafiles) {
  const out = new Set();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta?.inputs ?? {})) {
      const path = input.split("\\").join("/");
      if (path.includes("/node_modules/") || path.startsWith("node_modules/")) out.add(path);
    }
  }
  return [...out].sort();
}

/**
 * The directory of the package an input file belongs to: the nearest ancestor holding a
 * package.json that is directly under a node_modules (or a scope folder in one). `exists` answers
 * for a path; `null` when no such ancestor.
 */
export function packageDirOf(inputPath, exists) {
  const parts = inputPath.split("\\").join("/").split("/");
  for (let end = parts.length - 1; end > 0; end -= 1) {
    const dir = parts.slice(0, end);
    const nm = dir.lastIndexOf("node_modules");
    if (nm < 0) return null;
    const after = dir.slice(nm + 1);
    const isRoot = (after.length === 1 && !after[0].startsWith("@") && !after[0].startsWith(".")) || (after.length === 2 && after[0].startsWith("@"));
    if (isRoot && exists(dir.join("/") + "/package.json")) return dir.join("/");
  }
  return null;
}

/**
 * The inputs of a metafile that come from `src/standins/`: the stub backend, the dev reader, the
 * scripted model. A RELEASE build that contains one is refused by scripts/build.mjs, because the
 * start guard's other half (the real clave-back client, sub-project D) is then not what was built.
 */
export function standinInputs(metafile) {
  return Object.keys(metafile?.inputs ?? {}).map((p) => p.split("\\").join("/")).filter((p) => /(^|\/)src\/standins\//.test(p)).sort();
}

/** Dedupes `{name, version}` entries by `name@version`, sorted by name then version. */
export function uniquePackages(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!e || typeof e.name !== "string" || typeof e.version !== "string") continue;
    const key = `${e.name}@${e.version}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}
