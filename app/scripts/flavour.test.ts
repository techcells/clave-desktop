// Tests the pure half of the build flavour (scripts/flavour.mjs) and, through an in-memory esbuild
// build with `write: false`, that the defines really reach the code that reads them
// (src/shared/flavour.ts and src/renderer/copy.ts). Nothing here writes to dist/ or anywhere else.
// Same arrangement as dev-bundle.test.ts: the module under test does nothing at import, and it is
// type-checked by nobody (app/tsconfig.json includes src/** only), hence the namespace import.
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as flavourScript from "./flavour.mjs";

const {FLAVOURS, APP_NAMES, parseFlavour, flavourDefines, buildNumber, buildInfo} = flavourScript as {
  FLAVOURS: string[];
  APP_NAMES: Record<string, string>;
  parseFlavour: (argv: string[]) => {flavour?: string; error?: string};
  flavourDefines: (flavour: string) => Record<string, string>;
  buildNumber: (date: Date) => string;
  buildInfo: (a: {flavour: string; version: string; date: Date}) => {flavour: string; appName: string; version: string; buildNumber: string};
};

const app = fileURLToPath(new URL("..", import.meta.url));

/** Builds one source file to a string, browser platform (copy.ts is renderer code), no output on disk. */
async function bundle(entry: string, define: Record<string, string>): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, new URL("..", import.meta.url)))],
    bundle: true, write: false, platform: "browser", format: "esm", logLevel: "silent", define
  });
  return result.outputFiles[0]?.text ?? "";
}

describe("parseFlavour: which app this build is", () => {
  it("is dev when nothing is asked", () => {
    expect(parseFlavour(["node", "build.mjs"])).toEqual({flavour: "dev"});
    expect(parseFlavour(["node", "build.mjs", "--preview"])).toEqual({flavour: "dev"});
  });

  it("takes each of the three names", () => {
    for (const name of ["dev", "internal", "release"]) {
      expect(parseFlavour(["node", "build.mjs", "--flavour", name])).toEqual({flavour: name});
    }
  });

  it("refuses a flag with no value, an unknown value or a typo: never a silent fallback", () => {
    expect(parseFlavour(["node", "build.mjs", "--flavour"])).toEqual({error: "BAD_FLAVOUR"});
    expect(parseFlavour(["node", "build.mjs", "--flavour", "relaese"])).toEqual({error: "BAD_FLAVOUR"});
    expect(parseFlavour(["node", "build.mjs", "--flavour", "Internal"])).toEqual({error: "BAD_FLAVOUR"});
    expect(parseFlavour(["node", "build.mjs", "--flavour", "--preview"])).toEqual({error: "BAD_FLAVOUR"});
  });

  it("refuses the equals spelling and a repeated flag: neither may become a silent dev build", () => {
    expect(parseFlavour(["node", "build.mjs", "--flavour=internal"])).toEqual({error: "BAD_FLAVOUR"});
    expect(parseFlavour(["node", "build.mjs", "--flavours", "internal"])).toEqual({error: "BAD_FLAVOUR"});
    expect(parseFlavour(["node", "build.mjs", "--flavour", "internal", "--flavour", "release"])).toEqual({error: "BAD_FLAVOUR"});
  });
});

describe("flavourDefines: what esbuild bakes in", () => {
  it("names the three flavours and their app names", () => {
    expect(FLAVOURS).toEqual(["dev", "internal", "release"]);
    expect(APP_NAMES).toEqual({dev: "Clave Agent", internal: "Clave Agent Internal", release: "Clave Agent"});
  });

  it("is a pair of JSON string literals, one per global", () => {
    expect(flavourDefines("internal")).toEqual({__CLAVE_FLAVOUR__: '"internal"', __CLAVE_APP_NAME__: '"Clave Agent Internal"'});
    expect(flavourDefines("release")).toEqual({__CLAVE_FLAVOUR__: '"release"', __CLAVE_APP_NAME__: '"Clave Agent"'});
    expect(flavourDefines("dev")).toEqual({__CLAVE_FLAVOUR__: '"dev"', __CLAVE_APP_NAME__: '"Clave Agent"'});
  });

  it("throws on a name it does not know", () => {
    expect(() => flavourDefines("beta")).toThrow("BAD_FLAVOUR");
  });
});

describe("buildNumber and buildInfo: what dist/build.json says a build is", () => {
  it("is the UTC minute, zero-padded, month one-based", () => {
    expect(buildNumber(new Date(Date.UTC(2026, 8, 22, 7, 5)))).toBe("20260922.0705");
    expect(buildNumber(new Date(Date.UTC(2026, 0, 1, 0, 0)))).toBe("20260101.0000");
    expect(buildNumber(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("20261231.2359");
  });

  it("records the flavour, ITS app name, the version and the build number", () => {
    expect(buildInfo({flavour: "internal", version: "0.1.0", date: new Date(Date.UTC(2026, 8, 22, 7, 5))}))
      .toEqual({flavour: "internal", appName: "Clave Agent Internal", version: "0.1.0", buildNumber: "20260922.0705"});
    expect(buildInfo({flavour: "release", version: "1.2.3", date: new Date(0)}).appName).toBe("Clave Agent");
  });

  it("refuses an unknown flavour or an empty version", () => {
    expect(() => buildInfo({flavour: "beta", version: "0.1.0", date: new Date(0)})).toThrow("BAD_FLAVOUR");
    expect(() => buildInfo({flavour: "release", version: "", date: new Date(0)})).toThrow("BAD_VERSION");
  });
});

describe("the defines reach the code that reads them", () => {
  it("src/shared/flavour.ts resolves to the literals when built with the defines", async () => {
    const internal = await bundle("src/shared/flavour.ts", flavourDefines("internal"));
    expect(internal).toContain('"internal"');
    expect(internal).toContain('"Clave Agent Internal"');
    expect(internal).not.toContain("__CLAVE_FLAVOUR__");
    expect(internal).not.toContain("__CLAVE_APP_NAME__");
  });

  it("src/shared/flavour.ts built WITHOUT the defines still names dev and Clave Agent, by typeof", async () => {
    const bare = await bundle("src/shared/flavour.ts", {});
    expect(bare).toContain("__CLAVE_FLAVOUR__");
    expect(bare).toContain('"Clave Agent"');
    expect(bare).not.toContain('"Clave Agent Internal"');
  });

  it("the renderer copy's appName is the flavour's name, not a fixed string", async () => {
    const internal = await bundle("src/renderer/copy.ts", flavourDefines("internal"));
    expect(internal).toContain('"Clave Agent Internal"');
    const release = await bundle("src/renderer/copy.ts", flavourDefines("release"));
    expect(release).not.toContain("Clave Agent Internal");
    expect(release).toContain('"Clave Agent"');
  });
});
