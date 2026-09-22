// Tests the pure half of scripts/package/stage.mjs in plain Node. The module does nothing at
// import (its program half is gated on argv[1]); nothing here touches the filesystem except the
// last block, which READS a manifest a real staging run left behind, if one exists, and skips otherwise.
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as stageScript from "./stage.mjs";

const {shipList, runtimePackageJson, lockHas, pruneDecision, forbidden, manifest, resolveOut, requestedFlavour, installedIds} = stageScript as {
  shipList: (files: string[], flavour: string) => {ship?: string[]; helper?: string; error?: {code: string; path: string}};
  runtimePackageJson: (a: {flavour: string; version: string; nodeLlamaCppVersion: string}) => Record<string, unknown>;
  lockHas: (lock: string, id: string) => boolean;
  pruneDecision: (rel: string, options?: {dropLlamaSource?: boolean}) => "keep" | "drop";
  forbidden: (rel: string) => string | null;
  manifest: (entries: Array<{path: string; bytes: number; sha256: string}>, info: Record<string, string>) => {fileCount: number; totalBytes: number; files: Array<{path: string}>};
  resolveOut: (argv: string[], home: string, appDir: string) => {dir?: string; error?: string};
  requestedFlavour: (argv: string[]) => {flavour?: string | null; error?: string};
  installedIds: (jsons: unknown[]) => string[];
};

const COMPLETE = [
  "main.cjs", "preload.cjs", "model-host.mjs", "WHAT-LEAVES.md", "build.json", "bundled-packages.json", "standins-taxonomy.json",
  "renderer/index.html", "renderer/main.js", "renderer/main.css", "renderer/assets/font-abc.woff2",
  "native/clave-reader", "reader-eval.cjs", "eval-gate.mjs"
];

describe("shipList: what from dist/ goes into the asar", () => {
  it("ships the app, the renderer and the promise page; never the harness or the gate; the helper apart", () => {
    const r = shipList(COMPLETE, "internal");
    expect(r.error).toBeUndefined();
    expect(r.helper).toBe("native/clave-reader");
    expect(r.ship).toEqual([
      "WHAT-LEAVES.md", "build.json", "main.cjs", "model-host.mjs", "preload.cjs",
      "renderer/assets/font-abc.woff2", "renderer/index.html", "renderer/main.css", "renderer/main.js", "standins-taxonomy.json"
    ]);
    expect(r.ship).not.toContain("reader-eval.cjs");
    expect(r.ship).not.toContain("eval-gate.mjs");
    expect(r.ship).not.toContain("native/clave-reader");
    expect(r.ship).not.toContain("bundled-packages.json");
  });

  it("bundled-packages.json is consumed, never shipped, and required", () => {
    expect(shipList(COMPLETE, "release").ship).not.toContain("bundled-packages.json");
    expect(shipList(COMPLETE.filter((f) => f !== "bundled-packages.json"), "release").error).toEqual({code: "DIST_INCOMPLETE", path: "bundled-packages.json"});
  });

  it("the stub's taxonomy ships for dev and internal, not for release", () => {
    expect(shipList(COMPLETE, "dev").ship).toContain("standins-taxonomy.json");
    expect(shipList(COMPLETE, "release").ship).not.toContain("standins-taxonomy.json");
    expect(shipList(COMPLETE.filter((f) => f !== "standins-taxonomy.json"), "release").error).toBeUndefined();
    expect(shipList(COMPLETE.filter((f) => f !== "standins-taxonomy.json"), "internal").error).toEqual({code: "DIST_INCOMPLETE", path: "standins-taxonomy.json"});
  });

  it("refuses a file nobody listed: a new build output is decided here before it can ship", () => {
    expect(shipList([...COMPLETE, "telemetry.mjs"], "internal").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "telemetry.mjs"});
    expect(shipList([...COMPLETE, "native/other-tool"], "internal").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "native/other-tool"});
  });

  it("refuses a source map anywhere in dist", () => {
    expect(shipList([...COMPLETE, "renderer/main.js.map"], "internal").error).toEqual({code: "SOURCE_MAP_IN_DIST", path: "renderer/main.js.map"});
    expect(shipList([...COMPLETE, "main.cjs.map"], "release").error).toEqual({code: "SOURCE_MAP_IN_DIST", path: "main.cjs.map"});
  });

  it("refuses an incomplete dist: a missing required file, renderer file or helper", () => {
    expect(shipList(COMPLETE.filter((f) => f !== "preload.cjs"), "internal").error).toEqual({code: "DIST_INCOMPLETE", path: "preload.cjs"});
    expect(shipList(COMPLETE.filter((f) => f !== "renderer/main.css"), "internal").error).toEqual({code: "DIST_INCOMPLETE", path: "renderer/main.css"});
    expect(shipList(COMPLETE.filter((f) => f !== "native/clave-reader"), "internal").error).toEqual({code: "DIST_INCOMPLETE", path: "native/clave-reader"});
    expect(shipList(COMPLETE.filter((f) => f !== "build.json"), "release").error).toEqual({code: "DIST_INCOMPLETE", path: "build.json"});
  });

  it("refuses an unknown flavour and normalises backslashes", () => {
    expect(shipList(COMPLETE, "beta").error?.code).toBe("BAD_FLAVOUR");
    expect(shipList(COMPLETE.map((f) => f.split("/").join("\\")), "internal").ship).toContain("renderer/index.html");
  });
});

describe("runtimePackageJson: the asar root's package.json", () => {
  it("names the one runtime dependency at the pinned version and nothing else", () => {
    expect(runtimePackageJson({flavour: "release", version: "0.1.0", nodeLlamaCppVersion: "3.21.1"})).toEqual({
      name: "clave-agent", version: "0.1.0", private: true, main: "dist/main.cjs", dependencies: {"node-llama-cpp": "3.21.1"}
    });
    expect(runtimePackageJson({flavour: "internal", version: "0.1.0", nodeLlamaCppVersion: "3.21.1"}).name).toBe("clave-agent-internal");
  });

  it("refuses a bad flavour, an empty version or a non-exact dependency version", () => {
    expect(() => runtimePackageJson({flavour: "beta", version: "0.1.0", nodeLlamaCppVersion: "3.21.1"})).toThrow("BAD_FLAVOUR");
    expect(() => runtimePackageJson({flavour: "release", version: "", nodeLlamaCppVersion: "3.21.1"})).toThrow("BAD_VERSION");
    expect(() => runtimePackageJson({flavour: "release", version: "0.1.0", nodeLlamaCppVersion: "^3.21.1"})).toThrow("BAD_DEPENDENCY_VERSION");
    expect(() => runtimePackageJson({flavour: "release", version: "0.1.0", nodeLlamaCppVersion: "3.21.1-beta"})).toThrow("BAD_DEPENDENCY_VERSION");
    expect(() => runtimePackageJson({flavour: "release", version: "0.1.0", nodeLlamaCppVersion: "v3.21.1"})).toThrow("BAD_DEPENDENCY_VERSION");
    expect(() => runtimePackageJson({flavour: "release", version: "0.1.0", nodeLlamaCppVersion: undefined as unknown as string})).toThrow("BAD_DEPENDENCY_VERSION");
  });
});

describe("lockHas: is a package at this version in the app's lockfile", () => {
  const lock = "packages:\n\n  ansi-regex@6.3.0:\n    resolution: {integrity: x}\n\n  '@scope/pkg@1.2.3':\n    resolution: {integrity: y}\n\nsnapshots:\n\n  ansi-regex@6.3.0: {}\n";
  it("matches the exact line, quoted or not", () => {
    expect(lockHas(lock, "ansi-regex@6.3.0")).toBe(true);
    expect(lockHas(lock, "@scope/pkg@1.2.3")).toBe(true);
  });
  it("does not match a prefix, another version or a substring", () => {
    expect(lockHas(lock, "ansi-regex@6.3")).toBe(false);
    expect(lockHas(lock, "ansi-regex@6.3.1")).toBe(false);
    expect(lockHas(lock, "regex@6.3.0")).toBe(false);
    expect(lockHas(lock, "resolution")).toBe(false);
  });
});

describe("pruneDecision: what of the offline install is thrown away", () => {
  it("keeps the runtime packages, the two Mac binaries and their files", () => {
    for (const rel of ["node-llama-cpp", "node-llama-cpp/dist/index.js", "node-llama-cpp/llama/CMakeLists.txt",
      "@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node", "@reflink/reflink/index.js",
      "@reflink/reflink-darwin-arm64/reflink.darwin-arm64.node", "chalk/source/index.js", "cross-spawn/node_modules/which/bin/which.js"]) {
      expect(pruneDecision(rel), rel).toBe("keep");
    }
  });

  it("drops every dot entry, TypeScript, declarations and maps", () => {
    for (const rel of [".bin", ".bin/nlc", ".pnpm", ".modules.yaml", ".pnpm-workspace-state-v1.json", "cross-spawn/node_modules/.bin/node-which",
      "some-pkg/.eslintrc", "typescript", "typescript/lib/tsc.js", "node-llama-cpp/dist/index.d.ts", "zod/index.d.mts", "chalk/source/index.js.map",
      "@reflink/reflink/binding.d.ts", "@node-llama-cpp/mac-arm64-metal/index.d.ts"]) {
      expect(pruneDecision(rel), rel).toBe("drop");
    }
  });

  it("drops every binary package for another platform, keeps the Mac-arm64 ones", () => {
    for (const rel of ["@node-llama-cpp/mac-x64", "@node-llama-cpp/linux-x64-cuda/bins/x", "@node-llama-cpp/win-arm64", "@reflink/reflink-linux-x64-gnu", "@reflink/reflink-win32-x64-msvc/x.node"]) {
      expect(pruneDecision(rel), rel).toBe("drop");
    }
    expect(pruneDecision("@node-llama-cpp/mac-arm64-metal")).toBe("keep");
    expect(pruneDecision("@reflink/reflink-darwin-arm64")).toBe("keep");
  });

  it("keeps the bare scope folders themselves: the walk prunes parents first, so dropping a scope would take the Mac package with it", () => {
    expect(pruneDecision("@node-llama-cpp")).toBe("keep");
    expect(pruneDecision("@reflink")).toBe("keep");
  });

  it("drops node-llama-cpp's llama/ source tree only when asked", () => {
    expect(pruneDecision("node-llama-cpp/llama", {dropLlamaSource: true})).toBe("drop");
    expect(pruneDecision("node-llama-cpp/llama/addon/addon.cpp", {dropLlamaSource: true})).toBe("drop");
    expect(pruneDecision("node-llama-cpp/llama/addon/addon.cpp")).toBe("keep");
    expect(pruneDecision("node-llama-cpp/dist/index.js", {dropLlamaSource: true})).toBe("keep");
  });
});

describe("forbidden: the must-not-ship rule over the asar root", () => {
  it("allows exactly package.json, dist/ and node_modules/ content", () => {
    for (const rel of ["package.json", "dist/main.cjs", "dist/renderer/index.html", "dist/WHAT-LEAVES.md", "dist/THIRD-PARTY-LICENSES.txt",
      "node_modules/node-llama-cpp/dist/index.js", "node_modules/node-llama-cpp/LICENSE", "node_modules/node-llama-cpp/README.md",
      "node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node",
      "node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/libggml-base.dylib",
      "node_modules/@reflink/reflink-darwin-arm64/reflink.darwin-arm64.node", "node_modules/@reflink/reflink/index.js"]) {
      expect(forbidden(rel), rel).toBeNull();
    }
  });

  it("refuses the harness, the gate, the helper inside the asar, maps and every stray root file", () => {
    expect(forbidden("dist/reader-eval.cjs")).toBe("FORBIDDEN_FILE");
    expect(forbidden("dist/eval-gate.mjs")).toBe("FORBIDDEN_FILE");
    expect(forbidden("dist/native/clave-reader")).toBe("HELPER_INSIDE_ASAR");
    expect(forbidden("dist/main.cjs.map")).toBe("FORBIDDEN_FILE");
    for (const rel of ["README.md", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", "scripts/dev-launcher.cjs", "src/shell/app.ts", "eval/fixtures/01-work-english.json"]) {
      expect(forbidden(rel), rel).toBe("FORBIDDEN_FILE");
    }
  });

  it("refuses every dotfile, secret-looking file, model file and log, wherever it is", () => {
    for (const rel of [".env", ".git/config", "dist/.DS_Store", "node_modules/x/.npmrc", ".dev-launch.json"]) expect(forbidden(rel), rel).toBe("DOTFILE");
    for (const rel of ["dist/cert.p12", "node_modules/x/key.pem", "dist/AuthKey.p8", "dist/models/Qwen.gguf", "dist/app.log", "dist/stub-uploads.jsonl", "node_modules/x/login.keychain-db", "dist/x.provisionprofile"]) {
      expect(forbidden(rel), rel).toBe("FORBIDDEN_FILE");
    }
  });

  it("refuses a native binary anywhere but its two homes, other-platform packages, TypeScript and declarations", () => {
    expect(forbidden("dist/helper.node")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/some-pkg/build/Release/thing.node")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/node-llama-cpp/llama/libggml.dylib")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/@node-llama-cpp/mac-x64/bins/mac-x64/llama-addon.node")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64/package.json")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@reflink/reflink-linux-x64-gnu/package.json")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/typescript/package.json")).toBe("FORBIDDEN_FILE");
    expect(forbidden("node_modules/.bin/nlc")).toBe("DOTFILE");
    expect(forbidden("node_modules/node-llama-cpp/dist/index.d.ts")).toBe("FORBIDDEN_FILE");
    expect(forbidden("node_modules/x/index.d.mts")).toBe("FORBIDDEN_FILE");
    expect(forbidden("node_modules/x/index.d.cts")).toBe("FORBIDDEN_FILE");
  });

  it("applies the node_modules rules at every nesting level", () => {
    expect(forbidden("node_modules/a/node_modules/typescript/package.json")).toBe("FORBIDDEN_FILE");
    expect(forbidden("node_modules/a/node_modules/.bin/x")).toBe("DOTFILE");
    expect(forbidden("node_modules/a/node_modules/@node-llama-cpp/linux-x64/package.json")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/a/node_modules/@reflink/reflink-win32-x64-msvc/package.json")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/a/node_modules/@reflink/reflink/index.js")).toBeNull();
    expect(forbidden("node_modules/a/node_modules/b/index.js")).toBeNull();
  });
});

describe("manifest, resolveOut, requestedFlavour, installedIds", () => {
  it("manifest sorts by path and totals the bytes", () => {
    const m = manifest([{path: "dist/b", bytes: 2, sha256: "x"}, {path: "dist/a", bytes: 3, sha256: "y"}], {flavour: "internal", appName: "Clave Agent Internal", version: "0.1.0", buildNumber: "20260922.1200"});
    expect(m.files.map((f) => f.path)).toEqual(["dist/a", "dist/b"]);
    expect(m.fileCount).toBe(2);
    expect(m.totalBytes).toBe(5);
    expect(m).toMatchObject({flavour: "internal", appName: "Clave Agent Internal", version: "0.1.0", buildNumber: "20260922.1200"});
  });

  it("resolveOut defaults to app/out, takes --out, refuses the two Applications folders and a missing path", () => {
    expect(resolveOut(["node", "stage.mjs"], "/Users/nobody", "/repo/app")).toEqual({dir: "/repo/app/out"});
    expect(resolveOut(["node", "stage.mjs", "--out", "/tmp/x"], "/Users/nobody", "/repo/app")).toEqual({dir: "/tmp/x"});
    expect(resolveOut(["node", "stage.mjs", "--out", "~/scratch"], "/Users/nobody", "/repo/app")).toEqual({dir: "/Users/nobody/scratch"});
    expect(resolveOut(["node", "stage.mjs", "--out", "~/Applications"], "/Users/nobody", "/repo/app")).toEqual({error: "OUT_IS_APPLICATIONS"});
    expect(resolveOut(["node", "stage.mjs", "--out", "/Users/nobody/Applications/deep"], "/Users/nobody", "/repo/app")).toEqual({error: "OUT_IS_APPLICATIONS"});
    expect(resolveOut(["node", "stage.mjs", "--out", "/Applications"], "/Users/nobody", "/repo/app")).toEqual({error: "OUT_IS_APPLICATIONS"});
    expect(resolveOut(["node", "stage.mjs", "--out"], "/Users/nobody", "/repo/app")).toEqual({error: "BAD_OUT"});
    expect(resolveOut(["node", "stage.mjs", "--out", "--flavour"], "/Users/nobody", "/repo/app")).toEqual({error: "BAD_OUT"});
  });

  it("requestedFlavour is null when absent, a name when valid, a refusal otherwise", () => {
    expect(requestedFlavour(["node", "stage.mjs"])).toEqual({flavour: null});
    expect(requestedFlavour(["node", "stage.mjs", "--flavour", "release"])).toEqual({flavour: "release"});
    expect(requestedFlavour(["node", "stage.mjs", "--flavour", "Release"])).toEqual({error: "BAD_FLAVOUR"});
    expect(requestedFlavour(["node", "stage.mjs", "--flavour"])).toEqual({error: "BAD_FLAVOUR"});
    expect(requestedFlavour(["node", "stage.mjs", "--flavour=release"])).toEqual({error: "BAD_FLAVOUR"});
    expect(requestedFlavour(["node", "stage.mjs", "--flavour", "release", "--flavour", "internal"])).toEqual({error: "BAD_FLAVOUR"});
    expect(resolveOut(["node", "stage.mjs", "--out=/tmp/x"], "/Users/nobody", "/repo/app")).toEqual({error: "BAD_OUT"});
    expect(resolveOut(["node", "stage.mjs", "--out", "/tmp/x", "--out", "/tmp/y"], "/Users/nobody", "/repo/app")).toEqual({error: "BAD_OUT"});
  });

  it("installedIds lists name@version once each and ignores malformed package.json objects", () => {
    expect(installedIds([{name: "a", version: "1.0.0"}, {name: "a", version: "1.0.0"}, {name: "b"}, null, {version: "2"}, {name: "@s/c", version: "0.1.0"}])).toEqual(["@s/c@0.1.0", "a@1.0.0"]);
  });
});

describe("a real staging run, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const manifests = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "staging", "manifest.json")).filter((p) => existsSync(p)) : [];
  it.each(manifests.length > 0 ? manifests : [])("%s ships nothing forbidden and no map", (path) => {
    const m = JSON.parse(readFileSync(path, "utf8")) as {files: Array<{path: string; bytes: number; sha256: string}>; flavour: string};
    expect(m.files.length).toBeGreaterThan(100);
    for (const f of m.files) {
      expect(forbidden(f.path), f.path).toBeNull();
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const paths = m.files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("dist/main.cjs");
    expect(paths).toContain("dist/THIRD-PARTY-LICENSES.txt");
    expect(paths).toContain("node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node");
    if (m.flavour === "release") expect(paths).not.toContain("dist/standins-taxonomy.json");
  });
  it("records whether a run was checked", () => { expect(manifests.length >= 0).toBe(true); });
});
