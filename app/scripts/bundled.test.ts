// Tests scripts/bundled.mjs (pure) in plain Node: which packages esbuild inlined into the shipped
// bundles, from metafile input paths, with the filesystem injected.
import {describe, expect, it} from "vitest";
import * as bundled from "./bundled.mjs";

const {nodeModulesInputs, packageDirOf, uniquePackages, standinInputs} = bundled as {
  standinInputs: (metafile: {inputs: Record<string, unknown>} | undefined) => string[];
  nodeModulesInputs: (metafiles: Array<{inputs: Record<string, unknown>} | undefined>) => string[];
  packageDirOf: (inputPath: string, exists: (p: string) => boolean) => string | null;
  uniquePackages: (entries: unknown[]) => Array<{name: string; version: string}>;
};

describe("nodeModulesInputs", () => {
  it("lists node_modules inputs across metafiles once, sorted, and nothing from src", () => {
    const a = {inputs: {"src/shell/app.ts": {}, "node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js": {}, "node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core.js": {}}};
    const b = {inputs: {"src/renderer/main.tsx": {}, "node_modules/.pnpm/react@19.2.0/node_modules/react/index.js": {}, "node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js": {}}};
    expect(nodeModulesInputs([a, b, undefined])).toEqual([
      "node_modules/.pnpm/react@19.2.0/node_modules/react/index.js",
      "node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js",
      "node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core.js"
    ]);
    expect(nodeModulesInputs([{inputs: {"src/a.ts": {}}}])).toEqual([]);
  });
});

describe("packageDirOf", () => {
  const files = new Set([
    "/app/node_modules/.pnpm/zod@4.6.5/node_modules/zod/package.json",
    "/app/node_modules/.pnpm/react-dom@19.2.0_react@19.2.0/node_modules/react-dom/package.json",
    "/app/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/package.json",
    "/app/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/package.json"
  ]);
  const exists = (p: string) => files.has(p);
  it("finds the nearest package root that sits directly under a node_modules, scoped or not", () => {
    expect(packageDirOf("/app/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core.js", exists)).toBe("/app/node_modules/.pnpm/zod@4.6.5/node_modules/zod");
    expect(packageDirOf("/app/node_modules/.pnpm/react-dom@19.2.0_react@19.2.0/node_modules/react-dom/cjs/react-dom.production.js", exists)).toBe("/app/node_modules/.pnpm/react-dom@19.2.0_react@19.2.0/node_modules/react-dom");
    expect(packageDirOf("/app/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/dist/i.js", exists)).toBe("/app/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg");
  });
  it("is null outside node_modules or when no package.json is in reach", () => {
    expect(packageDirOf("/app/src/shell/app.ts", exists)).toBeNull();
    expect(packageDirOf("/app/node_modules/.pnpm/nothing@1/node_modules/nothing/index.js", exists)).toBeNull();
  });
});

describe("uniquePackages", () => {
  it("dedupes by name@version, sorts, and drops malformed entries", () => {
    expect(uniquePackages([{name: "zod", version: "4.6.5"}, {name: "react", version: "19.2.0"}, {name: "zod", version: "4.6.5", extra: 1}, {name: "react", version: "19.1.0"}, {name: "x"}, null]))
      .toEqual([{name: "react", version: "19.1.0"}, {name: "react", version: "19.2.0"}, {name: "zod", version: "4.6.5"}]);
  });
});

describe("standinInputs: the release gate's evidence", () => {
  it("lists every input from src/standins and nothing else", () => {
    const meta = {inputs: {"src/shell/app.ts": {}, "src/standins/stubApi.ts": {}, "src/standins/devReader.ts": {}, "src/main/engine.ts": {}, "node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js": {}, "src/core/standinsLike.ts": {}}};
    expect(standinInputs(meta)).toEqual(["src/standins/devReader.ts", "src/standins/stubApi.ts"]);
    expect(standinInputs({inputs: {"src/shell/app.ts": {}}})).toEqual([]);
    expect(standinInputs(undefined)).toEqual([]);
  });
});
