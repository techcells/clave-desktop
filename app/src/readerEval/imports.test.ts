/**
 * The import boundary around the evaluation harness, in the style of `src/main/imports.test.ts`.
 *
 * It runs in two directions, and the first is the one that matters:
 *
 * - **Nothing the product ships may import `src/readerEval`.** This folder exists to open windows,
 *   kill processes and photograph a screen on purpose. None of that belongs in the app, and an
 *   import is all it would take for a staging command or a `pkill` to end up in a build somebody
 *   installs.
 * - **The harness may import only the few product modules it is meant to reuse**, so the two things
 *   that must not be re-implemented — protocol 2's wire and the private-window rule — stay borrowed
 *   rather than copied, and nothing else creeps in.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const HERE = new URL(".", import.meta.url).pathname;
const SRC = join(HERE, "..");

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : productionFiles(path);
    return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}

const IMPORT = /from\s+"([^"]+)"|import\("([^"]+)"\)|require\("([^"]+)"\)/g;
const targets = (source: string): string[] =>
  [...source.matchAll(IMPORT)].map((match) => (match[1] ?? match[2] ?? match[3]) as string);

const outside = productionFiles(SRC).filter((path) => !path.startsWith(HERE));
const inside = productionFiles(HERE);

describe("nothing the product ships may import the evaluation harness", () => {
  it("finds the product's files", () => {
    expect(outside.length).toBeGreaterThan(50);
  });

  it.each(outside)("%s imports nothing from readerEval", (file) => {
    for (const target of targets(readFileSync(file, "utf8"))) {
      expect(target, `${file} imports ${target}`).not.toMatch(/readerEval/);
    }
  });
});

/**
 * The allow-list. `../main/reader/protocol` and `../shell/readerLink` are how the harness speaks to
 * the real helper over the real transport; `../core/exclusions/privateWindows` is the product's own
 * private-window rule and `../core/exclusions/sites` its address-line rule (owner decision O8), both
 * of which the harness must CALL rather than copy — a copy could pass here while the real one drops
 * a read on somebody's screen, and measuring a copy would be measuring the wrong thing;
 * `../core/types` is the shared `FrontWindow`; `../main/reader/constants` is the protocol number the
 * helper is checked against.
 */
const ALLOWED_OUTSIDE = [
  "../core/types",
  "../core/exclusions/privateWindows",
  "../core/exclusions/sites",
  "../main/reader/protocol",
  "../main/reader/constants",
  "../shell/readerLink"
];

describe("what the harness may import", () => {
  it("finds its own files", () => {
    expect(inside.length).toBeGreaterThan(8);
  });

  it.each(inside)("%s imports only node builtins, electron, its own folder and the allow-list", (file) => {
    for (const target of targets(readFileSync(file, "utf8"))) {
      if (target.startsWith("node:") || target === "electron") continue;
      if (target.startsWith("./")) continue;
      expect(ALLOWED_OUTSIDE, `${file} imports ${target}`).toContain(target);
    }
  });

  it.each(inside)("%s imports no test double", (file) => {
    for (const target of targets(readFileSync(file, "utf8"))) {
      expect(target, `${file} imports ${target}`).not.toMatch(/\/testing\/|^vitest$/);
    }
  });

  it.each(inside)("%s never writes to the console", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/\bconsole\s*\./);
  });

  it("keeps electron out of everything but the entry point", () => {
    for (const file of inside) {
      if (file.endsWith("main.ts")) continue;
      expect(targets(readFileSync(file, "utf8")), file).not.toContain("electron");
    }
  });
});
