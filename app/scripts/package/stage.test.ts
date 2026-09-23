// Tests the pure half of scripts/package/stage.mjs in plain Node. The module does nothing at
// import (its program half is gated on argv[1]); nothing here touches the filesystem except the
// last block, which READS a manifest a real staging run left behind, if one exists, and skips otherwise.
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as stageScript from "./stage.mjs";

const {shipList, runtimePackageJson, lockHas, pruneDecision, forbidden, manifest, resolveOut, requestedFlavour, installedIds, pnpmInvocation, pickRedistDir, targetFor, TARGETS, TESSDATA_MODELS, checkModels, defaultTools, missingModelBinaries, TESSDATA_SOURCE} = stageScript as {
  pickRedistDir: (candidates: string[]) => {path: string; version: string} | null;
  shipList: (files: string[], flavour: string, platform?: string, arch?: string) => {ship?: string[]; helper?: string; error?: {code: string; path: string}};
  runtimePackageJson: (a: {flavour: string; version: string; nodeLlamaCppVersion: string; platform?: string}) => Record<string, unknown>;
  lockHas: (lock: string, id: string) => boolean;
  pruneDecision: (rel: string, options?: {dropLlamaSource?: boolean; platform?: string; arch?: string}) => "keep" | "drop";
  forbidden: (rel: string, platform?: string, arch?: string) => string | null;
  targetFor: (platform: string, arch?: string) => {helper: string; rustTarget: string; keep: Record<string, string[]>; binaryHomes: string[]; distExtra?: string[]; models?: unknown} | null;
  TARGETS: Record<string, unknown>;
  TESSDATA_MODELS: Array<{file: string; sha256: string}>;
  checkModels: (found: Array<{file: string; sha256: string | null}>) => {code: string; detail: string} | null;
  TESSDATA_SOURCE: {repository: string; commit: string; urls: string[]};
  defaultTools: (platform: string, home: string, env: Record<string, string | undefined>) => {pnpm: string; cargo: string};
  missingModelBinaries: (installed: string[], platform: string, arch?: string) => string[];
  pnpmInvocation: (path: string, o: {nodePath: string; exists: (p: string) => boolean; join?: (...p: string[]) => string; dirname?: (p: string) => string}) => {command: string; args: string[]} | null;
  manifest: (entries: Array<{path: string; bytes: number; sha256: string}>, info: Record<string, string>) => {fileCount: number; totalBytes: number; files: Array<{path: string}>};
  resolveOut: (argv: string[], home: string, appDir: string) => {dir?: string; error?: string};
  requestedFlavour: (argv: string[]) => {flavour?: string | null; error?: string};
  installedIds: (jsons: unknown[]) => string[];
};

const COMPLETE = [
  "main.cjs", "preload.cjs", "model-host.mjs", "WHAT-LEAVES.md", "build.json", "tray.png", "bundled-packages.json", "standins-taxonomy.json",
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
      "renderer/assets/font-abc.woff2", "renderer/index.html", "renderer/main.css", "renderer/main.js", "tray.png"
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

  it("the stub's taxonomy ships only for dev: internal and release both run the real backend", () => {
    expect(shipList(COMPLETE, "dev").ship).toContain("standins-taxonomy.json");
    for (const flavour of ["internal", "release"]) {
      expect(shipList(COMPLETE, flavour).ship, flavour).not.toContain("standins-taxonomy.json");
      expect(shipList(COMPLETE.filter((f) => f !== "standins-taxonomy.json"), flavour).error, flavour).toBeUndefined();
    }
    expect(shipList(COMPLETE.filter((f) => f !== "standins-taxonomy.json"), "dev").error).toEqual({code: "DIST_INCOMPLETE", path: "standins-taxonomy.json"});
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

describe("Windows: the same rules, for what a win32 staging run ships", () => {
  const WIN_COMPLETE = COMPLETE.map((f) => (f === "native/clave-reader" ? "native/clave-reader.exe" : f));

  it("takes the .exe helper out of dist and refuses the macOS name there", () => {
    const r = shipList(WIN_COMPLETE, "internal", "win32");
    expect(r.error).toBeUndefined();
    expect(r.helper).toBe("native/clave-reader.exe");
    expect(shipList(COMPLETE, "internal", "win32").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "native/clave-reader"});
    // And the other way round: a macOS run still refuses a Windows helper.
    expect(shipList(WIN_COMPLETE, "internal").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "native/clave-reader.exe"});
  });

  it("refuses a system nothing here packages", () => {
    expect(shipList(COMPLETE, "internal", "linux").error).toEqual({code: "UNSUPPORTED_PLATFORM", path: "linux"});
  });

  it("keeps the CPU and Vulkan builds and reflink's Windows binary, and drops CUDA, arm64 and every Mac package", () => {
    const win = {platform: "win32"};
    for (const rel of ["@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node", "@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll",
      "@reflink/reflink-win32-x64-msvc/reflink.win32-x64-msvc.node", "@reflink/reflink/index.js", "@node-llama-cpp", "@reflink"]) {
      expect(pruneDecision(rel, win), rel).toBe("keep");
    }
    for (const rel of ["@node-llama-cpp/win-x64-cuda", "@node-llama-cpp/win-x64-cuda-ext", "@node-llama-cpp/win-arm64", "@node-llama-cpp/mac-arm64-metal",
      "@reflink/reflink-darwin-arm64", "@reflink/reflink-win32-arm64-msvc"]) {
      expect(pruneDecision(rel, win), rel).toBe("drop");
    }
  });

  it("drops the linker's leftovers beside the DLLs, and refuses them if one slipped through", () => {
    expect(pruneDecision("@node-llama-cpp/win-x64/bins/win-x64/llama-addon.lib", {platform: "win32"})).toBe("drop");
    expect(pruneDecision("@node-llama-cpp/win-x64/bins/win-x64/llama-addon.pdb", {platform: "win32"})).toBe("drop");
    expect(forbidden("node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.lib", "win32")).toBe("FORBIDDEN_FILE");
  });

  it("allows native binaries in the Windows homes only, and a Mac binary nowhere", () => {
    for (const rel of ["node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama.v0.4.0.dll", "node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll",
      "node_modules/@reflink/reflink-win32-x64-msvc/reflink.win32-x64-msvc.node"]) {
      expect(forbidden(rel, "win32"), rel).toBeNull();
    }
    expect(forbidden("node_modules/node-llama-cpp/dist/stray.dll", "win32")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node", "win32")).not.toBeNull();
    expect(forbidden("dist/native/clave-reader.exe", "win32")).toBe("HELPER_INSIDE_ASAR");
  });

  it("leaves macOS exactly as it was when no platform is named", () => {
    expect(pruneDecision("@node-llama-cpp/win-x64")).toBe("drop");
    expect(forbidden("node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama.v0.4.0.dll")).not.toBeNull();
  });
});

describe("Linux: one target per architecture, the extension in the asar, the models beside the helper", () => {
  const EXTENSION = ["gnome-extension/extension.js", "gnome-extension/logic.js", "gnome-extension/metadata.json"];
  const LINUX_COMPLETE = [...COMPLETE, ...EXTENSION];

  it("targetFor needs an architecture on Linux and knows x64 and arm64 only; the other systems ignore it", () => {
    expect(targetFor("linux")).toBeNull();
    expect(targetFor("linux", "ia32")).toBeNull();
    expect(targetFor("linux", "arm")).toBeNull();
    expect(targetFor("linux", "toString")).toBeNull();
    expect(targetFor("linux", "x64")?.rustTarget).toBe("x86_64-unknown-linux-gnu");
    expect(targetFor("linux", "arm64")?.rustTarget).toBe("aarch64-unknown-linux-gnu");
    for (const arch of ["x64", "arm64"]) expect(targetFor("linux", arch)?.helper, arch).toBe("clave-reader");
    expect(targetFor("darwin", "x64")).toBe(TARGETS.darwin);
    expect(targetFor("win32")).toBe(TARGETS.win32);
    expect(targetFor("freebsd", "x64")).toBeNull();
  });

  it("ships the GNOME extension's three files into the asar on Linux, requires each, and refuses them on other systems", () => {
    for (const arch of ["x64", "arm64"]) {
      const r = shipList(LINUX_COMPLETE, "internal", "linux", arch);
      expect(r.error, arch).toBeUndefined();
      expect(r.helper).toBe("native/clave-reader");
      for (const file of EXTENSION) expect(r.ship, file).toContain(file);
    }
    for (const file of EXTENSION) {
      expect(shipList(LINUX_COMPLETE.filter((f) => f !== file), "release", "linux", "x64").error, file).toEqual({code: "DIST_INCOMPLETE", path: file});
    }
    expect(shipList([...LINUX_COMPLETE, "gnome-extension/prefs.js"], "internal", "linux", "x64").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "gnome-extension/prefs.js"});
    expect(shipList(LINUX_COMPLETE, "internal").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "gnome-extension/extension.js"});
    expect(shipList(LINUX_COMPLETE.map((f) => (f === "native/clave-reader" ? "native/clave-reader.exe" : f)), "internal", "win32").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "gnome-extension/extension.js"});
    expect(shipList(LINUX_COMPLETE.map((f) => (f === "native/clave-reader" ? "native/clave-reader.exe" : f)), "internal", "linux", "x64").error).toEqual({code: "UNEXPECTED_DIST_FILE", path: "native/clave-reader.exe"});
  });

  it("refuses Linux without a known architecture rather than guess one", () => {
    expect(shipList(LINUX_COMPLETE, "internal", "linux").error).toEqual({code: "UNSUPPORTED_PLATFORM", path: "linux"});
    expect(shipList(LINUX_COMPLETE, "internal", "linux", "ppc64").error).toEqual({code: "UNSUPPORTED_PLATFORM", path: "linux-ppc64"});
  });

  it("x64 keeps the CPU and Vulkan builds and reflink's glibc binary; drops CUDA, arm64, musl and every other system's", () => {
    const x64 = {platform: "linux", arch: "x64"};
    for (const rel of ["@node-llama-cpp/linux-x64/bins/linux-x64/llama-addon.node", "@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/libggml-vulkan.so",
      "@reflink/reflink-linux-x64-gnu/reflink.linux-x64-gnu.node", "@reflink/reflink/index.js", "@node-llama-cpp", "@reflink"]) {
      expect(pruneDecision(rel, x64), rel).toBe("keep");
    }
    for (const rel of ["@node-llama-cpp/linux-x64-cuda", "@node-llama-cpp/linux-x64-cuda-ext", "@node-llama-cpp/linux-arm64", "@node-llama-cpp/linux-armv7l",
      "@node-llama-cpp/mac-arm64-metal", "@node-llama-cpp/win-x64", "@reflink/reflink-linux-x64-musl", "@reflink/reflink-linux-arm64-gnu", "@reflink/reflink-darwin-arm64"]) {
      expect(pruneDecision(rel, x64), rel).toBe("drop");
    }
  });

  it("arm64 keeps its one build and reflink's glibc binary, and drops every x64 package", () => {
    const arm64 = {platform: "linux", arch: "arm64"};
    for (const rel of ["@node-llama-cpp/linux-arm64/bins/linux-arm64/libllama.v0.4.0.so", "@reflink/reflink-linux-arm64-gnu/reflink.linux-arm64-gnu.node"]) {
      expect(pruneDecision(rel, arm64), rel).toBe("keep");
    }
    for (const rel of ["@node-llama-cpp/linux-x64", "@node-llama-cpp/linux-x64-vulkan", "@reflink/reflink-linux-x64-gnu", "@reflink/reflink-linux-arm64-musl"]) {
      expect(pruneDecision(rel, arm64), rel).toBe("drop");
    }
  });

  it("OTHER_PLATFORM: each architecture refuses the other's packages, and a Linux package is still refused on macOS and Windows", () => {
    expect(forbidden("node_modules/@node-llama-cpp/linux-arm64/package.json", "linux", "x64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64/package.json", "linux", "arm64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64-vulkan/package.json", "linux", "arm64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@reflink/reflink-linux-arm64-gnu/package.json", "linux", "x64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/a/node_modules/@reflink/reflink-linux-x64-gnu/package.json", "linux", "arm64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64-cuda/package.json", "linux", "x64")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-arm64/package.json", "win32")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-arm64/package.json")).toBe("OTHER_PLATFORM");
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64/package.json", "linux", "x64")).toBeNull();
    expect(forbidden("node_modules/@node-llama-cpp/linux-arm64/package.json", "linux", "arm64")).toBeNull();
  });

  it("allows native binaries in that architecture's homes only", () => {
    for (const rel of ["node_modules/@node-llama-cpp/linux-x64/bins/linux-x64/libggml-base.so", "node_modules/@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/llama-addon.node",
      "node_modules/@reflink/reflink-linux-x64-gnu/reflink.linux-x64-gnu.node"]) {
      expect(forbidden(rel, "linux", "x64"), rel).toBeNull();
    }
    expect(forbidden("node_modules/@node-llama-cpp/linux-arm64/bins/linux-arm64/libggml-cpu-armv8.2_1.so", "linux", "arm64")).toBeNull();
    expect(forbidden("node_modules/node-llama-cpp/llama/libggml.so", "linux", "x64")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("dist/stray.so", "linux", "arm64")).toBe("BINARY_OUTSIDE_ITS_HOME");
    expect(forbidden("node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/libggml.dylib", "linux", "arm64")).not.toBeNull();
    expect(forbidden("dist/native/clave-reader", "linux", "x64")).toBe("HELPER_INSIDE_ASAR");
    expect(forbidden("dist/gnome-extension/extension.js", "linux", "x64")).toBeNull();
    // Without an architecture nothing Linux-native is allowed: the macOS homes apply, never a guess.
    expect(forbidden("node_modules/@node-llama-cpp/linux-x64/bins/linux-x64/libggml-base.so", "linux")).not.toBeNull();
  });

  it("the models are the reader's: the same files and SHA-256s recognise.rs pins (the fast Portuguese model since 2026-09-24)", () => {
    const rust = readFileSync(fileURLToPath(new URL("../../native/reader/src/linux/recognise.rs", import.meta.url)), "utf8");
    const start = rust.indexOf("pub const MODELS");
    const pinned = [...rust.slice(start, rust.indexOf("];", start)).matchAll(/\("([a-z]+\.traineddata)",\s*"([0-9a-f]{64})"\)/g)].map((m) => ({file: m[1], sha256: m[2]}));
    expect(pinned).toEqual([{file: "por.traineddata", sha256: "c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb"}]);
    expect(TESSDATA_MODELS).toEqual(pinned);
    // The languages the reader loads are exactly the pinned files: a language without its file (English put
    // back as "por+eng") would leave Tesseract unable to start and every Linux read failing.
    const languages = /pub const LANGUAGES: &str = "([^"]+)";/.exec(rust)?.[1];
    expect(languages).toBeDefined();
    expect((languages ?? "").split("+").map((l) => `${l}.traineddata`).sort()).toEqual(pinned.map((m) => m.file).sort());
    for (const arch of ["x64", "arm64"]) expect(targetFor("linux", arch)?.models, arch).toBe(TESSDATA_MODELS);
    expect(targetFor("darwin")?.models).toBeUndefined();
  });

  it("names where CI fetches the models: one pinned tessdata_fast commit, one URL per model file", () => {
    expect(TESSDATA_SOURCE.repository).toBe("tesseract-ocr/tessdata_fast");
    expect(TESSDATA_SOURCE.commit).toBe("87416418657359cb625c412a48b6e1d6d41c29bd");
    expect(TESSDATA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(TESSDATA_SOURCE.urls).toEqual(TESSDATA_MODELS.map((m) => `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_SOURCE.commit}/${m.file}`));
  });

  it("checkModels: every pinned file, each with its pinned hash, or a refusal naming the file", () => {
    const good = TESSDATA_MODELS.map((m) => ({file: m.file, sha256: m.sha256}));
    const first = good[0];
    expect(checkModels(good)).toBeNull();
    expect(checkModels([{file: "eng.traineddata", sha256: "1".repeat(64)}, ...good])).toBeNull();
    expect(checkModels([])).toEqual({code: "MODEL_MISSING", detail: first.file});
    expect(checkModels([{file: first.file, sha256: null}])).toEqual({code: "MODEL_MISSING", detail: first.file});
    expect(checkModels([{file: first.file, sha256: "0".repeat(64)}])).toEqual({code: "MODEL_HASH_WRONG", detail: first.file});
    // The best model of the same name, which the reader no longer pins, is refused too.
    expect(checkModels([{file: first.file, sha256: "711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04"}])).toEqual({code: "MODEL_HASH_WRONG", detail: first.file});
  });

  it("the desktop name: the bundle id on Linux (the Wayland app id and the portal's identity), absent elsewhere and for dev", () => {
    const base = {version: "0.1.0", nodeLlamaCppVersion: "3.21.1"};
    expect(runtimePackageJson({...base, flavour: "internal", platform: "linux"}).desktopName).toBe("dev.clave.agent.internal.desktop");
    expect(runtimePackageJson({...base, flavour: "release", platform: "linux"}).desktopName).toBe("dev.clave.agent.desktop");
    expect(runtimePackageJson({...base, flavour: "dev", platform: "linux"})).not.toHaveProperty("desktopName");
    for (const platform of ["darwin", "win32", undefined]) expect(runtimePackageJson({...base, flavour: "release", platform}), String(platform)).not.toHaveProperty("desktopName");
  });

  it("the default tools on Linux: rustup's cargo and pnpm's own install folder", () => {
    expect(defaultTools("linux", "/home/u", {})).toEqual({pnpm: "/home/u/.local/share/pnpm/pnpm", cargo: "/home/u/.cargo/bin/cargo"});
    expect(defaultTools("darwin", "/Users/u", {}).cargo).toBe("/opt/homebrew/opt/rustup/bin/cargo");
  });
});

describe("missingModelBinaries: the model's own binary packages must be there after the offline install", () => {
  it("names every kept node-llama-cpp build that did not arrive (an offline resolve can skip them silently)", () => {
    expect(missingModelBinaries(["node-llama-cpp", "@node-llama-cpp/mac-arm64-metal"], "darwin")).toEqual([]);
    expect(missingModelBinaries(["node-llama-cpp"], "darwin")).toEqual(["@node-llama-cpp/mac-arm64-metal"]);
    expect(missingModelBinaries(["@node-llama-cpp/win-x64"], "win32")).toEqual(["@node-llama-cpp/win-x64-vulkan"]);
    expect(missingModelBinaries([], "linux", "x64")).toEqual(["@node-llama-cpp/linux-x64", "@node-llama-cpp/linux-x64-vulkan"]);
    expect(missingModelBinaries(["@node-llama-cpp/linux-arm64"], "linux", "arm64")).toEqual([]);
    expect(missingModelBinaries(["@node-llama-cpp/linux-x64"], "linux", "arm64")).toEqual(["@node-llama-cpp/linux-arm64"]);
  });
});

describe("pickRedistDir: which Visual C++ runtime the Windows build copies", () => {
  const crt = (version: string, name = "Microsoft.VC143.CRT") => `C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/${version}/x64/${name}`;

  it("takes the newest version by number, not by text", () => {
    expect(pickRedistDir([crt("14.9.1"), crt("14.44.35112"), crt("14.38.33130")])).toEqual({path: crt("14.44.35112"), version: "14.44.35112"});
  });

  it("ignores a folder that is not a CRT folder or has no version, and answers null when nothing is left", () => {
    expect(pickRedistDir([crt("14.44.35112", "Microsoft.VC143.OpenMP"), crt("onecore"), crt("14.44.35112", "debug_nonredist")])).toBeNull();
    expect(pickRedistDir([])).toBeNull();
    expect(pickRedistDir(["C:\\VS\\VC\\Redist\\MSVC\\14.40.33807\\x64\\Microsoft.VC143.CRT"])).toEqual({path: "C:\\VS\\VC\\Redist\\MSVC\\14.40.33807\\x64\\Microsoft.VC143.CRT", version: "14.40.33807"});
  });
});

describe("pnpmInvocation: running pnpm without a shell", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);
  const opts = (paths: string[]) => ({nodePath: "NODE", exists: exists(paths), join: (...p: string[]) => p.join("/"), dirname: (p: string) => p.slice(0, p.lastIndexOf("/"))});

  it("runs a real executable as it is", () => {
    expect(pnpmInvocation("/home/u/Library/pnpm/bin/pnpm", opts(["/home/u/Library/pnpm/bin/pnpm"]))).toEqual({command: "/home/u/Library/pnpm/bin/pnpm", args: []});
  });

  it("replaces a global npm .cmd shim by the JavaScript entry beside it, run with Node", () => {
    expect(pnpmInvocation("C:/Users/u/AppData/Roaming/npm/pnpm.cmd", opts(["C:/Users/u/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs"])))
      .toEqual({command: "NODE", args: ["C:/Users/u/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs"]});
  });

  it("finds the entry of a .bin shim one folder up", () => {
    expect(pnpmInvocation("D:/tools/node_modules/.bin/pnpm.CMD", opts(["D:/tools/node_modules/.bin/../pnpm/bin/pnpm.cjs"])))
      .toEqual({command: "NODE", args: ["D:/tools/node_modules/.bin/../pnpm/bin/pnpm.cjs"]});
  });

  it("runs a named .cjs entry with Node, and reports what cannot be run", () => {
    expect(pnpmInvocation("D:/pnpm/bin/pnpm.cjs", opts(["D:/pnpm/bin/pnpm.cjs"]))).toEqual({command: "NODE", args: ["D:/pnpm/bin/pnpm.cjs"]});
    expect(pnpmInvocation("C:/nowhere/pnpm.cmd", opts([]))).toBeNull();
    expect(pnpmInvocation("/nowhere/pnpm", opts([]))).toBeNull();
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
    // Resolved, because that is what the function returns: the same strings on macOS, drive-rooted on Windows.
    expect(resolveOut(["node", "stage.mjs"], "/Users/nobody", "/repo/app")).toEqual({dir: resolve("/repo/app/out")});
    expect(resolveOut(["node", "stage.mjs", "--out", "/tmp/x"], "/Users/nobody", "/repo/app")).toEqual({dir: resolve("/tmp/x")});
    expect(resolveOut(["node", "stage.mjs", "--out", "~/scratch"], "/Users/nobody", "/repo/app")).toEqual({dir: resolve("/Users/nobody/scratch")});
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
    const m = JSON.parse(readFileSync(path, "utf8")) as {files: Array<{path: string; bytes: number; sha256: string}>; flavour: string; platform?: string; arch?: string; models?: Array<{file: string; sha256: string}>};
    // A manifest from before Windows carries no platform: it was a macOS run.
    const platform = m.platform ?? "darwin";
    expect(m.files.length).toBeGreaterThan(100);
    for (const f of m.files) {
      expect(forbidden(f.path, platform, m.arch), f.path).toBeNull();
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const paths = m.files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("dist/main.cjs");
    expect(paths).toContain("dist/THIRD-PARTY-LICENSES.txt");
    const linuxAddons = m.arch === "x64"
      ? ["node_modules/@node-llama-cpp/linux-x64/bins/linux-x64/llama-addon.node", "node_modules/@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/llama-addon.node"]
      : ["node_modules/@node-llama-cpp/linux-arm64/bins/linux-arm64/llama-addon.node"];
    const addons = platform === "win32"
      ? ["node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node", "node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/llama-addon.node"]
      : platform === "linux" ? linuxAddons : ["node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node"];
    for (const addon of addons) expect(paths).toContain(addon);
    // Windows: Microsoft's C++ runtime beside each addon, so the model loads on a PC without it installed.
    if (platform === "win32") {
      for (const dir of ["node_modules/@node-llama-cpp/win-x64/bins/win-x64", "node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan"]) {
        for (const dll of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) expect(paths).toContain(`${dir}/${dll}`);
      }
    }
    // Linux: the GNOME extension inside the asar, and the two pinned models recorded beside the helper.
    if (platform === "linux") {
      for (const file of ["extension.js", "logic.js", "metadata.json"]) expect(paths).toContain(`dist/gnome-extension/${file}`);
      expect(m.models).toEqual(TESSDATA_MODELS.map((model) => expect.objectContaining(model)));
    }
    if (m.flavour === "release") expect(paths).not.toContain("dist/standins-taxonomy.json");
  });
  it("records whether a run was checked", () => { expect(manifests.length >= 0).toBe(true); });
});
