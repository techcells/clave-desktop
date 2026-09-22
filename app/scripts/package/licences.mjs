// THIRD-PARTY-LICENSES.txt: every third-party component the bundle carries, its licence, and the
// licence text (packaging design, section 10). Generated at staging time from the staged closure's
// package.json and LICENSE files, the helper's crates (`cargo metadata --offline`), Electron's own
// LICENSE, and a hand-maintained JSON for what no graph can produce (llama.cpp, ggml, the model).
// The build FAILS on a component whose licence is missing or not in the permissive allow-list, so a
// copyleft dependency cannot arrive quietly.
//
// Every decision is a pure function; `generateLicences` at the bottom is the only impure part and
// nothing runs at import. scripts/package/stage.mjs calls it before the manifest is written.
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, posix} from "node:path";
import {fileURLToPath} from "node:url";
import {walk} from "./walk.mjs";

/** Licences a component may carry. Anything else, and anything missing, fails the build. */
export const ALLOWED = ["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Zlib"];

/** When a component offers a choice (`A OR B`), the one this distribution takes: first match wins. */
export const PREFERENCE = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Zlib", "Unlicense", "CC0-1.0", "MIT-0", "BlueOak-1.0.0", "Apache-2.0"];

/**
 * A package.json's licence as one SPDX-style string, or `null`. Accepts `license: "MIT"`,
 * `license: {type: "MIT"}` and the old `licenses: [{type}, ...]` (joined with OR). Blank is null.
 */
export function licenceField(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  const l = pkg.license;
  if (typeof l === "string" && l.trim()) return l.trim();
  if (l && typeof l === "object" && typeof l.type === "string" && l.type.trim()) return l.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((x) => (typeof x === "string" ? x : x && typeof x.type === "string" ? x.type : "")).map((t) => t.trim()).filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return null;
}

/**
 * The licence this distribution takes from an SPDX expression, or `null` when the expression is
 * not acceptable. `A OR B`: the first allowed alternative in PREFERENCE order. `A AND B`: allowed
 * only if every part is, reported as the joined expression. Parentheses are ignored; `WITH`
 * exceptions and anything unknown make the expression unacceptable.
 */
export function chosenLicence(expression) {
  if (typeof expression !== "string") return null;
  const cleaned = expression.replace(/[()]/g, " ").trim();
  if (!cleaned || /\bWITH\b/.test(cleaned)) return null;
  if (/\bAND\b/.test(cleaned)) {
    const parts = cleaned.split(/\s+AND\s+/).map((p) => p.trim());
    return parts.every((p) => ALLOWED.includes(p)) ? parts.join(" AND ") : null;
  }
  const options = cleaned.split(/\s+OR\s+/).map((p) => p.trim());
  if (options.some((o) => !/^[A-Za-z0-9.+-]+$/.test(o))) return null;
  for (const preferred of PREFERENCE) if (options.includes(preferred)) return preferred;
  return null;
}

/**
 * The package.json files that are PACKAGE ROOTS among paths relative to the asar root: directly
 * under a node_modules (or a scope folder in one), at any depth. A package.json inside a package's
 * `dist/` or `test/` is not a package.
 */
export function packageRoots(paths) {
  const roots = [];
  for (const raw of paths) {
    const path = raw.split("\\").join("/");
    if (posix.basename(path) !== "package.json") continue;
    const parts = path.split("/");
    const dir = parts.slice(0, -1);
    const nm = dir.lastIndexOf("node_modules");
    if (nm < 0) continue;
    const after = dir.slice(nm + 1);
    const isRoot = (after.length === 1 && !after[0].startsWith("@") && !after[0].startsWith(".")) || (after.length === 2 && after[0].startsWith("@"));
    if (isRoot) roots.push(path);
  }
  return roots.sort();
}

/** The licence-text files in a package's own folder (not its children), in a stable order. */
export function licenceFilesIn(packageDir, paths) {
  const dir = packageDir.split("\\").join("/").replace(/\/$/, "");
  return paths.map((p) => p.split("\\").join("/"))
    .filter((p) => posix.dirname(p) === dir && /^(licen[cs]e|copying)/i.test(posix.basename(p)))
    .sort();
}

/** CRLF to LF; refuses text with control characters (C0 other than tab and newline, DEL, C1) or a replacement character. */
export function cleanText(text) {
  const lf = text.split("\r\n").join("\n").split("\r").join("\n");
  if (lf.includes("\uFFFD")) return null;
  for (const ch of lf) {
    const code = ch.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code < 160)) return null;
  }
  return lf.trim();
}

/**
 * Which of a package's licence files to print: the one named after the licence this distribution
 * takes (`LICENSE.MIT` among `LICENSE.APACHE2`, `LICENSE.BSD`, `LICENSE.MIT`), or the only file
 * there is. Several files and none named after the choice: none (the appendix text is used), so
 * a MIT claim is never followed by an Apache text.
 */
export function pickLicenceFile(files, chosen) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (files.length === 1) return files[0];
  const token = String(chosen ?? "").toLowerCase().split("-")[0].replace(/[^a-z0-9]/g, "");
  if (!token) return null;
  const named = files.filter((f) => posix.basename(f).toLowerCase().replace(/[^a-z0-9]/g, "").includes(token));
  return named.length === 1 ? named[0] : null;
}

/** A package's source as an https URL, or undefined: `git+https://x.git`, `git://`, `git@github.com:o/r.git` are normalised or dropped. */
export function sourceOf(pkg) {
  const raw = typeof pkg?.homepage === "string" ? pkg.homepage : typeof pkg?.repository === "string" ? pkg.repository : typeof pkg?.repository?.url === "string" ? pkg.repository.url : undefined;
  return normaliseSource(raw);
}

export function normaliseSource(raw) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let url = raw.trim().replace(/^git\+/, "");
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
  url = url.replace(/\.git$/, "");
  return /^https?:\/\/[^\s]+$/.test(url) ? url : undefined;
}

/**
 * Checks every entry `{name, version, licence, text}`: a licence must be present and acceptable.
 * Returns the problems, empty when the list is clean. The text is optional (the standard text of
 * the chosen licence is appended once for entries without their own).
 */
export function checkEntries(entries) {
  const problems = [];
  for (const e of entries) {
    if (!e.licence) { problems.push({code: "LICENCE_MISSING", name: e.name}); continue; }
    if (chosenLicence(e.licence) === null) problems.push({code: "LICENCE_NOT_ALLOWED", name: e.name, licence: e.licence});
  }
  return problems;
}

/** The model's paragraph, or a refusal for a release build whose model licence is not confirmed. */
export function modelSection(model, flavour) {
  if (!model || typeof model.name !== "string") return {error: "MODEL_ENTRY_MISSING"};
  if (model.licence === null || model.licence === undefined) {
    if (flavour === "release") return {error: "MODEL_LICENCE_UNCONFIRMED"};
    return {text: `${model.name}\n${model.source ?? ""}\nLicence: not yet confirmed by the publisher of this build.\n${model.note ?? ""}`.trim()};
  }
  if (chosenLicence(String(model.licence)) === null) return {error: "LICENCE_NOT_ALLOWED"};
  return {text: `${model.name}\n${model.source ?? ""}\nLicence: ${model.licence}\n${model.note ?? ""}`.trim()};
}

const RULE = "-".repeat(72);

/**
 * The whole file, or a refusal. `sections` is `{app, electron, packages, crates, components, model,
 * texts}` where packages/crates/components are entries `{name, version, licence, text?, copyright?,
 * source?}`. Entries without their own text are followed by a reference to the appendix, which holds
 * each chosen licence's standard text once; a chosen licence with no standard text on file is a
 * refusal (`APPENDIX_TEXT_MISSING`), never a dangling reference. Deterministic: sorted by name, no
 * dates, no paths.
 */
export function render(sections) {
  const lines = [];
  lines.push(`Third-party software in ${sections.app.name} ${sections.app.version}`, "");
  lines.push("This file lists the third-party components this application contains or downloads, with their licences.", "");
  const needed = new Set();
  const block = (title, entries) => {
    lines.push(RULE, title, RULE, "");
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))) {
      const chosen = chosenLicence(e.licence) ?? e.licence;
      lines.push(`${e.name} ${e.version}${e.bundled ? " (compiled into the application code)" : ""}`);
      if (typeof e.source === "string" && /^https?:\/\//.test(e.source)) lines.push(e.source);
      lines.push(`Licence: ${e.licence}${chosen !== e.licence ? ` (distributed here under ${chosen})` : ""}`);
      if (e.copyright) lines.push(e.copyright);
      if (e.text) lines.push("", e.text);
      else { lines.push(`(standard ${chosen} text: see the appendix)`); needed.add(chosen); }
      lines.push("");
    }
  };
  block("Runtime framework", [sections.electron]);
  lines.push("Chromium and its third-party components: their licences are in LICENSES.chromium.html beside this file.", "");
  block("Inference engine", sections.components);
  block("Native reader helper: Rust crates (statically linked)", sections.crates);
  block("JavaScript packages", sections.packages);
  lines.push(RULE, "Language model (downloaded at set-up, not bundled)", RULE, "", sections.model, "");
  const missing = [...needed].filter((n) => typeof sections.texts?.[n] !== "string" || !sections.texts[n].trim()).sort();
  if (missing.length > 0) return {error: "APPENDIX_TEXT_MISSING", detail: missing.join(",")};
  const appendix = [...needed].sort();
  if (appendix.length > 0) {
    lines.push(RULE, "Appendix: standard licence texts", RULE, "");
    for (const n of appendix) lines.push(`[${n}]`, "", sections.texts[n], "");
  }
  return {text: lines.join("\n") + "\n"};
}

// ---------------------------------------------------------------------------------------------
// The impure half. Nothing below runs at import.

const FIXED_PATH = join(dirname(fileURLToPath(import.meta.url)), "licences.fixed.json");

/**
 * Reads everything, checks it, renders it. Returns `{text, electronFiles}` or `{error, detail}`.
 * `root` is the staged asar root; `appDir` the checkout's app/; `cargo` the absolute cargo path.
 */
export function generateLicences({root, appDir, flavour, cargo, env}) {
  const fixed = JSON.parse(readFileSync(FIXED_PATH, "utf8"));
  const appPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = walk(root).filter((e) => e.kind === "file").map((e) => e.rel);

  const packages = [];
  const seen = new Set();
  for (const rootPath of packageRoots(files)) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, rootPath), "utf8")); } catch { return {error: "PACKAGE_JSON_UNREADABLE", detail: rootPath}; }
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return {error: "PACKAGE_UNNAMED", detail: rootPath};
    if (seen.has(`${pkg.name}@${pkg.version}`)) continue;            // a nested copy of the same version: one entry
    seen.add(`${pkg.name}@${pkg.version}`);
    const licence = licenceField(pkg);
    const licenceFile = pickLicenceFile(licenceFilesIn(posix.dirname(rootPath), files), chosenLicence(licence));
    let text = null;
    if (licenceFile) {
      text = cleanText(readFileSync(join(root, licenceFile), "utf8"));
      if (text === null) return {error: "LICENCE_TEXT_UNREADABLE", detail: licenceFile};
    }
    packages.push({name: pkg.name, version: pkg.version, licence, text, source: sourceOf(pkg)});
  }
  if (packages.length === 0) return {error: "NO_PACKAGES_FOUND"};

  // The packages esbuild inlined into the shipped bundles (react, zod, ...): written by the build
  // into dist/bundled-packages.json, which never ships. Without it nothing can vouch for them.
  const bundledPath = join(appDir, "dist", "bundled-packages.json");
  if (!existsSync(bundledPath)) return {error: "BUNDLED_PACKAGES_MISSING", detail: "run: pnpm --dir app build"};
  let bundledList;
  try { bundledList = JSON.parse(readFileSync(bundledPath, "utf8")); } catch { return {error: "BUNDLED_PACKAGES_MISSING"}; }
  if (!Array.isArray(bundledList) || bundledList.length === 0) return {error: "BUNDLED_PACKAGES_MISSING", detail: "empty"};
  for (const b of bundledList) {
    if (typeof b?.name !== "string" || typeof b?.version !== "string") return {error: "PACKAGE_UNNAMED", detail: "bundled"};
    if (seen.has(`${b.name}@${b.version}`)) continue;
    seen.add(`${b.name}@${b.version}`);
    let text = null;
    if (typeof b.licenceText === "string") {
      text = cleanText(b.licenceText);
      if (text === null) return {error: "LICENCE_TEXT_UNREADABLE", detail: b.name};
    }
    packages.push({name: b.name, version: b.version, licence: typeof b.licence === "string" ? b.licence : null, text, source: normaliseSource(b.source), bundled: true});
  }

  const manifest = join(appDir, "native", "reader", "Cargo.toml");
  const meta = spawnSync(cargo, ["metadata", "--offline", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin", "--manifest-path", manifest], {stdio: ["ignore", "pipe", "pipe"], env: {...env, PATH: `${dirname(cargo)}:${env.PATH ?? ""}`}});
  if (meta.status !== 0) return {error: "CARGO_METADATA_FAILED", detail: String(meta.status)};
  let graph;
  try { graph = JSON.parse(String(meta.stdout)); } catch { return {error: "CARGO_METADATA_FAILED", detail: "unparseable"}; }
  const inResolve = new Set((graph.resolve?.nodes ?? []).map((n) => n.id));
  const crates = (graph.packages ?? []).filter((p) => inResolve.has(p.id) && p.id !== graph.resolve?.root)
    .map((p) => ({name: p.name, version: p.version, licence: p.license ?? null, source: p.repository ?? undefined}));
  if (crates.length === 0) return {error: "NO_CRATES_FOUND"};

  const electronDist = join(appDir, "node_modules", "electron", "dist");
  const electronLicence = join(electronDist, "LICENSE");
  const chromium = join(electronDist, "LICENSES.chromium.html");
  if (!existsSync(electronLicence) || !existsSync(chromium)) return {error: "ELECTRON_LICENCE_MISSING"};
  const electronVersion = readFileSync(join(electronDist, "version"), "utf8").trim();
  const electronText = cleanText(readFileSync(electronLicence, "utf8"));
  if (electronText === null) return {error: "LICENCE_TEXT_UNREADABLE", detail: "electron"};
  const electron = {name: "Electron", version: electronVersion, licence: "MIT", text: electronText, source: "https://github.com/electron/electron"};
  if (!packages.some((p) => p.bundled)) return {error: "BUNDLED_PACKAGES_MISSING", detail: "none"};

  const components = (fixed.components ?? []).map((c) => ({name: c.name, version: c.version, licence: c.licence, copyright: c.copyright, source: c.source}));
  const model = modelSection(fixed.model, flavour);
  if (model.error) return {error: model.error};

  const problems = checkEntries([electron, ...components, ...crates, ...packages]);
  if (problems.length > 0) return {error: problems[0].code, detail: `${problems[0].name}${problems[0].licence ? ` (${problems[0].licence})` : ""}`};

  const rendered = render({app: {name: appPackage.name, version: appPackage.version}, electron, packages, crates, components, model: model.text, texts: fixed.texts ?? {}});
  if (rendered.error) return {error: rendered.error, detail: rendered.detail};
  const clean = cleanText(rendered.text);
  if (clean === null) return {error: "LICENCE_TEXT_UNREADABLE", detail: "rendered"};
  return {text: clean + "\n", electronFiles: [electronLicence, chromium], counts: {packages: packages.length, bundled: packages.filter((p) => p.bundled).length, crates: crates.length}};
}
