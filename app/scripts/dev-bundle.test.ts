// Tests the pure half of app/scripts/dev-bundle.mjs, in plain Node. Same arrangement as
// dev-launcher.test.ts and reader-eval.test.ts: the script's program half is gated on argv[1], so
// importing it here never builds, signs or replaces anything, and app/tsconfig.json's `include` is
// src/**/*.ts, so this file is run by vitest and type-checked by nobody -- which is why the interop
// below is a plain namespace import.
//
// Nothing here runs `pgrep`, or any other process: the decision is a function of what pgrep said,
// and what pgrep said is written out by hand. No path in this file is a real one -- the home
// directory below belongs to nobody, and nothing is passed to the filesystem.
import {describe, expect, it} from "vitest";
import * as bundleScript from "./dev-bundle.mjs";

const {runningAppCheck, resolveOutDir} = bundleScript as {
  runningAppCheck: (probe: {defaultLocation: boolean; status: number | null; output: string}) => string;
  resolveOutDir: (argv: string[], home: string) => {dir: string; defaultLocation: boolean};
};

const HOME = "/Users/nobody";
const DEFAULT = "/Users/nobody/Applications";
const here = {defaultLocation: true};

describe("what pgrep's answer means for a build about to replace the bundle", () => {
  it("refuses: exit 0 with a pid is the app running from inside this bundle", () => {
    expect(runningAppCheck({...here, status: 0, output: "4213\n"})).toBe("running");
    expect(runningAppCheck({...here, status: 0, output: "4213\n4214\n"})).toBe("running");
  });

  it("proceeds: exit 1 is pgrep's own 'nothing matched'", () => {
    expect(runningAppCheck({...here, status: 1, output: ""})).toBe("proceed");
  });

  /**
   * The check not having run is NOT the check saying no. Allowing the replacement on an answer pgrep
   * could not give would leave the guard silently degraded to no guard, on the one step where the
   * Screen Recording grant was lost before — and the person reading the output could not tell which
   * of the two they got.
   */
  it("refuses: any other exit status is a check that did not happen", () => {
    expect(runningAppCheck({...here, status: 2, output: ""})).toBe("unanswered");
    expect(runningAppCheck({...here, status: 127, output: "not found\n"})).toBe("unanswered");
  });

  it("refuses: a pgrep that could not be spawned at all has no exit status", () => {
    expect(runningAppCheck({...here, status: null, output: ""})).toBe("unanswered");
  });

  it("refuses: an exit 0 that names nobody is pgrep contradicting itself", () => {
    expect(runningAppCheck({...here, status: 0, output: "   \n"})).toBe("unanswered");
    expect(runningAppCheck({...here, status: 0, output: ""})).toBe("unanswered");
  });

  /**
   * A `--out` build is a copy somewhere else: nothing has been granted to it and nothing is running
   * from it, so neither a running app nor an unanswered check says anything about it.
   */
  it("proceeds for a build that is not going to the default bundle, whatever pgrep said", () => {
    for (const status of [0, 1, 2, null]) {
      expect(runningAppCheck({defaultLocation: false, status, output: "4213\n"})).toBe("proceed");
    }
  });
});

// The dev bundle is a macOS .app under ~/Applications and dev-bundle.mjs refuses to run anywhere else
// (NOT_MACOS), so its paths are POSIX paths by definition; on Windows `resolve` would drive-root them.
describe.skipIf(process.platform === "win32")("which bundle a run is about to write, and whether the guard applies to it", () => {
  it("writes to ~/Applications when no --out is given, and that is the guarded one", () => {
    expect(resolveOutDir(["node", "dev-bundle.mjs"], HOME)).toEqual({dir: DEFAULT, defaultLocation: true});
  });

  it("writes where --out says, and does not guard that", () => {
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "/tmp/somewhere"], HOME))
      .toEqual({dir: "/tmp/somewhere", defaultLocation: false});
  });

  /**
   * The two holes a "was `--out` given" test left open: the flag with nothing after it falls back to
   * the default location, and the flag can simply name it. The destination decides, not the spelling.
   */
  it("guards a --out with no path after it, which writes to the default location anyway", () => {
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out"], HOME)).toEqual({dir: DEFAULT, defaultLocation: true});
  });

  it("guards a --out that names the default location, however it is spelled", () => {
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", DEFAULT], HOME).defaultLocation).toBe(true);
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "~/Applications"], HOME))
      .toEqual({dir: DEFAULT, defaultLocation: true});
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "/Users/nobody/Applications/"], HOME).defaultLocation).toBe(true);
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "/Users/nobody/../nobody/Applications"], HOME).defaultLocation).toBe(true);
  });

  it("does not confuse a neighbour of the default location with it", () => {
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "/Users/nobody/Applications2"], HOME).defaultLocation).toBe(false);
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "/Users/nobody/Applications/sub"], HOME).defaultLocation).toBe(false);
    expect(resolveOutDir(["node", "dev-bundle.mjs", "--out", "~/Applications-old"], HOME).defaultLocation).toBe(false);
  });
});
