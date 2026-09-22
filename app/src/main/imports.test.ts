import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = new URL(".", import.meta.url).pathname;
function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : productionFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = productionFiles(ROOT);
const IMPORT = /from\s+"([^"]+)"|import\("([^"]+)"\)/g;

describe("main/: what production code may depend on", () => {
  it("finds the production files", () => { expect(files.length).toBeGreaterThan(15); });

  it.each(files)("%s imports no stand-in, no test helper and no Electron", (file) => {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const target = (match[1] ?? match[2]) as string;
      expect(target, `${file} imports ${target}`).not.toMatch(/standins|\/testing\/|^electron$|^vitest$/);
    }
  });

  it.each(files)("%s never writes to the console", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/\bconsole\s*\./);
  });
});
