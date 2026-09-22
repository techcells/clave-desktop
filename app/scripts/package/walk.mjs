// One directory walk for the packaging scripts: every entry under `dir` as a posix path relative to
// `dir`, parent before children, symlinks reported as such and never followed. Pure apart from the
// reads; nothing at import.
import {readdirSync} from "node:fs";
import {join, posix, sep} from "node:path";

export function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    const rel = posix.join(...full.slice(base.length + 1).split(sep));
    if (entry.isSymbolicLink()) { out.push({rel, kind: "symlink"}); continue; }
    if (entry.isDirectory()) { out.push({rel, kind: "dir"}); out.push(...walk(full, base)); continue; }
    out.push({rel, kind: "file"});
  }
  return out;
}
