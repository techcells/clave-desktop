import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const ROOT = new URL(".", import.meta.url).pathname;
const FORBIDDEN = [
  "fs", "node:fs", "fs/promises", "node:fs/promises", "net", "node:net", "http", "node:http",
  "https", "node:https", "child_process", "node:child_process", "electron", "dgram", "node:dgram"
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("core stays pure", () => {
  it("never imports disk, network, process or Electron modules", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g)) {
        const mod = match[1] ?? match[2] ?? "";
        if (FORBIDDEN.includes(mod)) offenders.push(`${file.replace(ROOT, "")} imports ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never calls console", () => {
    const offenders = sourceFiles(ROOT).filter((file) => /\bconsole\.(log|info|warn|error|debug)\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });
});
