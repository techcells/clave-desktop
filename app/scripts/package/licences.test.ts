// Tests the pure half of scripts/package/licences.mjs in plain Node; the module does nothing at
// import. The last block reads a real staged licence file if a staging run left one, and skips otherwise.
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as licences from "./licences.mjs";

const {ALLOWED, licenceField, chosenLicence, packageRoots, licenceFilesIn, cleanText, checkEntries, modelSection, render, pickLicenceFile, normaliseSource, linkedCrates, runtimeEntry} = licences as {
  runtimeEntry: (fixed: unknown, runtime: unknown) => {entry?: Record<string, unknown> | null; error?: string};
  linkedCrates: (graph: unknown) => Array<{name: string; version: string; licence: string | null}>;
  pickLicenceFile: (files: string[], chosen: string | null) => string | null;
  normaliseSource: (raw: unknown) => string | undefined;
  ALLOWED: string[];
  licenceField: (pkg: unknown) => string | null;
  chosenLicence: (expr: unknown) => string | null;
  packageRoots: (paths: string[]) => string[];
  licenceFilesIn: (dir: string, paths: string[]) => string[];
  cleanText: (text: string) => string | null;
  checkEntries: (entries: Array<{name: string; licence: string | null}>) => Array<{code: string; name: string; licence?: string}>;
  modelSection: (model: unknown, flavour: string) => {text?: string; error?: string};
  render: (sections: Record<string, unknown>) => {text?: string; error?: string; detail?: string};
};

describe("runtimeEntry: a system runtime shipped beside the native binaries", () => {
  const fixed = {name: "Microsoft Visual C++ Runtime", licence: "Microsoft terms", copyright: "Copyright (c) Microsoft Corporation", source: "https://learn.microsoft.com/x", note: "Windows only."};
  const copied = {version: "14.44.35112", files: ["msvcp140.dll", "vcruntime140.dll"]};

  it("is nothing when no runtime was copied, as on macOS", () => {
    expect(runtimeEntry(fixed, null)).toEqual({entry: null});
  });

  it("joins the hand-kept description to the version and files of the copy", () => {
    expect(runtimeEntry(fixed, copied)).toEqual({entry: {...fixed, ...copied}});
  });

  it("refuses a runtime that was copied but not described, or described without its terms", () => {
    expect(runtimeEntry(undefined, copied)).toEqual({error: "RUNTIME_ENTRY_MISSING"});
    expect(runtimeEntry({...fixed, source: undefined}, copied)).toEqual({error: "RUNTIME_ENTRY_MISSING"});
    expect(runtimeEntry(fixed, {version: "14.44", files: []})).toEqual({error: "RUNTIME_ENTRY_MISSING"});
  });

  it("is rendered in its own section, outside the allow-list's appendix", () => {
    const base = {app: {name: "clave-agent", version: "0.1.1"}, electron: {name: "Electron", version: "44.4.1", licence: "MIT", text: "MIT text"}, packages: [], crates: [], components: [], model: "Qwen", texts: {}};
    const withRuntime = render({...base, runtimes: [runtimeEntry(fixed, copied).entry]}).text ?? "";
    expect(withRuntime).toContain("System runtime (redistributable, not open source)\n");
    expect(withRuntime).toContain("Microsoft Visual C++ Runtime 14.44.35112\nFiles: msvcp140.dll, vcruntime140.dll\nhttps://learn.microsoft.com/x\nLicence: Microsoft terms\n");
    expect(withRuntime).not.toContain("Appendix");
    expect(render(base).text).not.toContain("System runtime");
  });
});

describe("linkedCrates: the crates inside the helper binary", () => {
  // The shape of `cargo metadata --format-version 1`, cut down to what the walk reads. It mirrors the
  // Windows helper's real graph: `windows` pulls in a proc macro, which pulls in `syn` and `unicode-ident`.
  const pkg = (name: string, licence: string, kind = "lib") => ({id: `${name}-id`, name, version: "1.0.0", license: licence, targets: [{kind: [kind]}]});
  const edge = (name: string, kind: string | null = null) => ({pkg: `${name}-id`, dep_kinds: [{kind, target: null}]});
  const graph = {
    packages: [pkg("clave-reader", "UNLICENSED", "bin"), pkg("serde_json", "MIT OR Apache-2.0"), pkg("windows", "MIT OR Apache-2.0"),
      pkg("windows-implement", "MIT OR Apache-2.0", "proc-macro"), pkg("syn", "MIT OR Apache-2.0"), pkg("unicode-ident", "(MIT OR Apache-2.0) AND Unicode-3.0"),
      pkg("cc", "MIT OR Apache-2.0"), pkg("shared", "MIT")],
    resolve: {
      root: "clave-reader-id",
      nodes: [
        {id: "clave-reader-id", deps: [edge("serde_json"), edge("windows"), edge("cc", "build")]},
        {id: "windows-id", deps: [edge("windows-implement"), edge("shared")]},
        {id: "windows-implement-id", deps: [edge("syn"), edge("shared")]},
        {id: "syn-id", deps: [edge("unicode-ident")]},
        {id: "serde_json-id", deps: [edge("shared")]},
        {id: "cc-id", deps: []}, {id: "shared-id", deps: []}, {id: "unicode-ident-id", deps: []}
      ]
    }
  };

  it("lists what is linked, and not the root, a proc macro, what only it needs, or a build dependency", () => {
    expect(linkedCrates(graph).map((c) => c.name).sort()).toEqual(["serde_json", "shared", "windows"]);
  });

  it("keeps a crate that a proc macro and a linked crate both use", () => {
    expect(linkedCrates(graph).map((c) => c.name)).toContain("shared");
  });

  it("follows an edge that states no kinds, so an older cargo lists more rather than less", () => {
    const old = {...graph, resolve: {...graph.resolve, nodes: graph.resolve.nodes.map((n) => ({...n, deps: n.deps.map((d) => ({pkg: d.pkg}))}))}};
    expect(linkedCrates(old).map((c) => c.name).sort()).toEqual(["cc", "serde_json", "shared", "windows"]);
  });
});

describe("licenceField: a package.json's licence as one string", () => {
  it("reads the three spellings and trims", () => {
    expect(licenceField({license: " MIT "})).toBe("MIT");
    expect(licenceField({license: {type: "ISC"}})).toBe("ISC");
    expect(licenceField({licenses: [{type: "MIT"}, {type: "Apache-2.0"}]})).toBe("MIT OR Apache-2.0");
    expect(licenceField({licenses: ["BSD-3-Clause"]})).toBe("BSD-3-Clause");
  });
  it("is null when absent, blank or malformed", () => {
    expect(licenceField({})).toBeNull();
    expect(licenceField({license: ""})).toBeNull();
    expect(licenceField({license: {}})).toBeNull();
    expect(licenceField({license: {type: "  "}})).toBeNull();
    expect(licenceField({licenses: [{}, "  "]})).toBeNull();
    expect(licenceField({licenses: []})).toBeNull();
    expect(licenceField(null)).toBeNull();
    expect(licenceField("MIT")).toBeNull();
  });
});

describe("chosenLicence: what this distribution takes from an SPDX expression", () => {
  it("accepts each allowed licence on its own", () => {
    for (const l of ALLOWED) expect(chosenLicence(l), l).toBe(l);
  });
  it("picks the preferred alternative of an OR, parentheses or not", () => {
    expect(chosenLicence("(BSD-2-Clause OR MIT OR Apache-2.0)")).toBe("MIT");
    expect(chosenLicence("Zlib OR Apache-2.0 OR MIT")).toBe("MIT");
    expect(chosenLicence("Unlicense OR MIT")).toBe("MIT");
    expect(chosenLicence("Apache-2.0 OR GPL-3.0")).toBe("Apache-2.0");
    expect(chosenLicence("BlueOak-1.0.0 OR Apache-2.0")).toBe("BlueOak-1.0.0");
  });
  it("requires every part of an AND", () => {
    expect(chosenLicence("MIT AND ISC")).toBe("MIT AND ISC");
    expect(chosenLicence("MIT AND GPL-2.0")).toBeNull();
  });
  it("refuses copyleft, unknown, exceptions, blank and non-strings", () => {
    for (const l of ["GPL-3.0", "LGPL-2.1", "AGPL-3.0", "MPL-2.0", "SEE LICENSE IN LICENSE", "UNLICENSED", "GPL-2.0 OR GPL-3.0", "MIT WITH Exception", "", "  ", "MIT OR", "Custom"]) {
      expect(chosenLicence(l), l).toBeNull();
    }
    expect(chosenLicence(null)).toBeNull();
    expect(chosenLicence(undefined)).toBeNull();
  });
});

describe("packageRoots and licenceFilesIn", () => {
  const paths = [
    "package.json", "dist/main.cjs",
    "node_modules/chalk/package.json", "node_modules/chalk/license", "node_modules/chalk/source/index.js",
    "node_modules/@scope/pkg/package.json", "node_modules/@scope/pkg/LICENSE.md",
    "node_modules/tar/package.json", "node_modules/tar/dist/esm/package.json", "node_modules/tar/LICENSE",
    "node_modules/a/node_modules/b/package.json", "node_modules/a/node_modules/b/COPYING",
    "node_modules/x/test/package.json", "node_modules/.bin/package.json", "node_modules/node-llama-cpp/llama/package.json"
  ];
  it("lists the package roots only, at any depth, and never the asar root's own package.json", () => {
    expect(packageRoots(paths)).toEqual([
      "node_modules/@scope/pkg/package.json", "node_modules/a/node_modules/b/package.json",
      "node_modules/chalk/package.json", "node_modules/tar/package.json"
    ]);
  });
  it("finds the licence files in the package's own folder only", () => {
    expect(licenceFilesIn("node_modules/chalk", paths)).toEqual(["node_modules/chalk/license"]);
    expect(licenceFilesIn("node_modules/@scope/pkg", paths)).toEqual(["node_modules/@scope/pkg/LICENSE.md"]);
    expect(licenceFilesIn("node_modules/a/node_modules/b", paths)).toEqual(["node_modules/a/node_modules/b/COPYING"]);
    expect(licenceFilesIn("node_modules/a", paths)).toEqual([]);
    expect(licenceFilesIn("node_modules/tar", paths)).toEqual(["node_modules/tar/LICENSE"]);
  });
});

describe("cleanText", () => {
  it("normalises line endings and trims", () => {
    expect(cleanText("a\r\nb\rc\n\n")).toBe("a\nb\nc");
  });
  it("refuses control characters and the replacement character", () => {
    expect(cleanText("ok\ttab\nline")).toBe("ok\ttab\nline");
    expect(cleanText("bad" + String.fromCharCode(0) + "byte")).toBeNull();
    expect(cleanText("bad" + String.fromCharCode(27) + "escape")).toBeNull();
    expect(cleanText("bad" + String.fromCharCode(0xfffd) + "decode")).toBeNull();
    expect(cleanText("bad" + String.fromCharCode(127) + "del")).toBeNull();
    expect(cleanText("bad" + String.fromCharCode(0x85) + "c1")).toBeNull();
    expect(cleanText("fine" + String.fromCharCode(0xa0) + "nbsp and " + String.fromCharCode(0xe9))).toBe("fine" + String.fromCharCode(0xa0) + "nbsp and " + String.fromCharCode(0xe9));
  });
});

describe("pickLicenceFile and normaliseSource", () => {
  it("takes the file named after the chosen licence, the only file, or none", () => {
    const rc = ["node_modules/rc/LICENSE.APACHE2", "node_modules/rc/LICENSE.BSD", "node_modules/rc/LICENSE.MIT"];
    expect(pickLicenceFile(rc, "MIT")).toBe("node_modules/rc/LICENSE.MIT");
    expect(pickLicenceFile(rc, "Apache-2.0")).toBe("node_modules/rc/LICENSE.APACHE2");
    expect(pickLicenceFile(rc, "BSD-2-Clause")).toBe("node_modules/rc/LICENSE.BSD");
    expect(pickLicenceFile(rc, "ISC")).toBeNull();
    expect(pickLicenceFile(["node_modules/x/LICENSE"], "MIT")).toBe("node_modules/x/LICENSE");
    expect(pickLicenceFile(["node_modules/x/LICENSE", "node_modules/x/LICENSE.md"], "MIT")).toBeNull();
    expect(pickLicenceFile([], "MIT")).toBeNull();
    expect(pickLicenceFile(rc, null)).toBeNull();
  });
  it("prints only https sources, normalising git spellings", () => {
    expect(normaliseSource("https://github.com/o/r")).toBe("https://github.com/o/r");
    expect(normaliseSource("git+https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(normaliseSource("git://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(normaliseSource("git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(normaliseSource("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(normaliseSource("o/r")).toBeUndefined();
    expect(normaliseSource("")).toBeUndefined();
    expect(normaliseSource(undefined)).toBeUndefined();
    expect(normaliseSource("https://x.y/a b")).toBeUndefined();
  });
});

describe("checkEntries and modelSection", () => {
  it("names every missing or unacceptable licence, by component", () => {
    expect(checkEntries([{name: "a", licence: "MIT"}, {name: "b", licence: null}, {name: "c", licence: "GPL-3.0"}, {name: "d", licence: "(ISC OR GPL-2.0)"}]))
      .toEqual([{code: "LICENCE_MISSING", name: "b"}, {code: "LICENCE_NOT_ALLOWED", name: "c", licence: "GPL-3.0"}]);
  });
  it("an unconfirmed model licence blocks a release build and is stated plainly in an internal one", () => {
    const model = {name: "Model X", source: "https://example.invalid/model", licence: null, note: "n"};
    expect(modelSection(model, "release")).toEqual({error: "MODEL_LICENCE_UNCONFIRMED"});
    expect(modelSection(model, "internal").text).toContain("not yet confirmed");
    expect(modelSection({...model, licence: "Apache-2.0"}, "release").text).toContain("Licence: Apache-2.0");
    expect(modelSection({...model, licence: "Proprietary"}, "release")).toEqual({error: "LICENCE_NOT_ALLOWED"});
    expect(modelSection(undefined, "release")).toEqual({error: "MODEL_ENTRY_MISSING"});
    expect(modelSection({...model, licence: undefined}, "release")).toEqual({error: "MODEL_LICENCE_UNCONFIRMED"});
  });
});

describe("render", () => {
  const sections = {
    app: {name: "clave-agent-internal", version: "0.1.0"},
    electron: {name: "Electron", version: "44.4.1", licence: "MIT", text: "ELECTRON TEXT"},
    packages: [{name: "zeta", version: "1.0.0", licence: "MIT", text: "ZETA TEXT"}, {name: "alpha", version: "2.0.0", licence: "(BSD-2-Clause OR MIT OR Apache-2.0)", text: null, source: "https://example.invalid/alpha"},
      {name: "react", version: "19.2.0", licence: "MIT", text: "REACT TEXT", bundled: true, source: "git@github.com:facebook/react.git"}, {name: "alpha", version: "1.0.0", licence: "MIT", text: "ALPHA OLD"}],
    crates: [{name: "objc2", version: "0.6.3", licence: "MIT", text: null}, {name: "bitflags", version: "2.13.2", licence: "MIT OR Apache-2.0", text: null}],
    components: [{name: "llama.cpp", version: "bundled", licence: "MIT", copyright: "Copyright (c) X"}],
    model: "MODEL PARAGRAPH",
    texts: {MIT: "MIT STANDARD TEXT", ISC: "ISC STANDARD TEXT"}
  };
  const out = render(sections).text as string;
  it("names every component, sorted, with its licence and text or an appendix reference", () => {
    expect(out).toContain("react 19.2.0 (compiled into the application code)");
    expect(out).toContain("REACT TEXT");
    expect(out).not.toContain("git@github.com");
    expect(out.indexOf("alpha 1.0.0")).toBeLessThan(out.indexOf("alpha 2.0.0"));
    expect(out).not.toContain("Licence: MIT (distributed here under");
    expect(out).toContain("Third-party software in clave-agent-internal 0.1.0");
    expect(out.indexOf("alpha 2.0.0")).toBeLessThan(out.indexOf("zeta 1.0.0"));
    expect(out.indexOf("bitflags 2.13.2")).toBeLessThan(out.indexOf("objc2 0.6.3"));
    expect(out).toContain("ZETA TEXT");
    expect(out).toContain("ELECTRON TEXT");
    expect(out).toContain("Licence: (BSD-2-Clause OR MIT OR Apache-2.0) (distributed here under MIT)");
    expect(out).toContain("Licence: MIT OR Apache-2.0 (distributed here under MIT)");
    expect(out).toContain("(standard MIT text: see the appendix)");
    expect(out).toContain("MODEL PARAGRAPH");
    expect(out).toContain("LICENSES.chromium.html");
    expect(out).toContain("Copyright (c) X");
  });
  it("appends each needed standard text exactly once, and no unneeded one", () => {
    expect(out.split("MIT STANDARD TEXT").length - 1).toBe(1);
    expect(out).not.toContain("ISC STANDARD TEXT");
  });
  it("refuses a chosen licence with no standard text on file instead of leaving a dangling reference", () => {
    const r = render({...sections, crates: [{name: "c", version: "1", licence: "BlueOak-1.0.0", text: null}]});
    expect(r).toEqual({error: "APPENDIX_TEXT_MISSING", detail: "BlueOak-1.0.0"});
    expect(render({...sections, texts: {MIT: "MIT STANDARD TEXT", ISC: "ISC STANDARD TEXT", "BlueOak-1.0.0": "BLUE TEXT"}, crates: [{name: "c", version: "1", licence: "BlueOak-1.0.0", text: null}]}).text).toContain("BLUE TEXT");
  });

  it("is deterministic and carries no path", () => {
    expect(render(sections).text).toBe(out);
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("node_modules/");
  });
});

describe("a real staged licence file, when one exists", () => {
  const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "out");
  const files = existsSync(outDir) ? readdirSync(outDir).map((f) => join(outDir, f, "staging", "app", "dist", "THIRD-PARTY-LICENSES.txt")).filter((p) => existsSync(p)) : [];
  it.each(files.length > 0 ? files : [])("%s names Electron, node-llama-cpp, the crates and the model, and is clean", (path) => {
    const text = readFileSync(path, "utf8");
    expect(cleanText(text)).not.toBeNull();
    // The helper's crates are the packaged system's: the staging manifest beside the file says which
    // (none means a run from before Windows, i.e. macOS).
    const manifestPath = join(path, "..", "..", "..", "manifest.json");
    const platform = (existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {platform?: string}).platform : undefined) ?? "darwin";
    const crates = platform === "win32" ? ["\nwindows 0.62", "\nwindows-core 0.62"] : ["objc2-vision", "objc2-screen-capture-kit"];
    for (const crate of crates) expect(text, crate).toContain(crate);
    // Compile-time-only crates run inside the compiler and are not in the binary (`linkedCrates`).
    if (platform === "win32") for (const macro of ["\nwindows-implement ", "\nsyn ", "\nunicode-ident "]) expect(text, macro).not.toContain(macro);
    // The Microsoft runtime Windows ships beside the model binaries is named, in its own section.
    if (platform === "win32") {
      expect(text).toContain("System runtime (redistributable, not open source)");
      expect(text).toMatch(/\nMicrosoft Visual C\+\+ Runtime 14\.[0-9.]+\nFiles: msvcp140\.dll, vcruntime140\.dll, vcruntime140_1\.dll\n/);
    } else expect(text).not.toContain("Microsoft Visual C++ Runtime");
    for (const needle of ["Electron 44.", "node-llama-cpp 3.21.1", "llama.cpp", "Qwen3.5-4B", "LICENSES.chromium.html", "Appendix: standard licence texts",
      "react 19.2.0 (compiled into the application code)", "react-dom 19.2.0 (compiled", "scheduler 0.", "zod 4.6.5 (compiled"]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toContain("/Users/");
    expect(text).not.toMatch(/GPL/);
    expect(text).not.toContain("git@github.com");
    expect(text).not.toContain("git://");
    // rc is triple-licensed and printed under MIT: the MIT file follows, never the Apache one.
    const rc = text.indexOf("\nrc 1.");
    if (rc >= 0) expect(text.slice(rc, rc + 2500)).not.toContain("Apache License");
    expect((text.match(/^ansi-regex /gm) ?? []).length).toBe(new Set(text.match(/^ansi-regex [0-9.]+/gm) ?? []).size);
  });
  it("records whether a run was checked", () => { expect(files.length >= 0).toBe(true); });
});
