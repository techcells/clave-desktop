import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import type {EngineStatus, NothingReadWhy, UserSettings} from "../../shared/ipc";
import {NOTHING_READ_WHY} from "../../shared/ipc";
import {APP_FILE, BLOCKERS, blockerCopy, checkingPermissionLine, CLAIMS, COPY, KNOWN_LIMITS, knownLimits, NOTHING_READ, PERMISSION_STEPS, privateWindowsLine, WINDOWS_COPY} from "../copy";
import {downloadView, firstBlocker, gigabytes, isTranslocated, LONG_WAIT_MS, mustSignIn, nothingReadLine, onboardingStep, reviewRows, startScreen, stillWaiting} from "./views";

const status = (blockers: EngineStatus["blockers"], pending = 0): EngineStatus => ({capture: "off", resumeAt: null, blockers, extractionPaused: null, pending, waitingUpload: 0, nothingRead: null, checkingPermission: false, account: null});
const settings = (onboardingStep: number): UserSettings => ({exclusions: [], excludedSites: [], reviewTime: "17:30", captureOn: false, onboardingStep});

describe("the pitch", () => {
  // The plan is internal and not in the public repo, so this only runs where the file exists.
  const planUrl = new URL("../../../../docs/implementation-plan.md", import.meta.url);
  it.skipIf(!existsSync(planUrl))("uses the five claims verbatim from the overall plan", () => {
    const plan = readFileSync(planUrl, "utf8");
    const section = plan.slice(plan.indexOf("The claims:"), plan.indexOf("What we do not claim anywhere"));
    const canonical = [...section.matchAll(/^\d\. ([\s\S]*?)(?=^\d\. |\s*$(?![\s\S]))/gm)].map((m) => (m[1] as string).replace(/\s+/g, " ").trim());
    expect(canonical).toHaveLength(5);
    expect([...CLAIMS]).toEqual(canonical);
  });

  it("repeats the same five claims verbatim on the page the app links to", () => {
    const page = readFileSync(new URL("../../../../docs/WHAT-LEAVES.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const claim of CLAIMS) expect(page, claim).toContain(claim.replace(/\s+/g, " "));
  });

  it("has a sentence and one fix button for every blocker", () => {
    for (const copy of Object.values(BLOCKERS)) { expect(copy.sentence.length).toBeGreaterThan(10); expect(copy.action.length).toBeGreaterThan(2); }
    expect(Object.keys(BLOCKERS)).toHaveLength(10);
  });

  it("counts statements the way a person would in the notification and the tray", () => {
    expect(COPY.notify.review(1)).toBe("1 statement to review");
    expect(COPY.notify.review(3)).toBe("3 statements to review");
    expect(COPY.tray.review(0)).toBe("Review (0)");
    expect(COPY.tray.review(3)).toBe("Review (3)");
  });

  // Pins the four limits verbatim and in order, so the Chrome/Safari address-bar limit (owner
  // decision O8, 2026-09-21) stays third — before the closing sentence it is a reason FOR, not after.
  it("states the known limits in order, ending on the sentence they lead to", () => {
    expect([...KNOWN_LIMITS]).toEqual([
      "It cannot recognise a confidential fact that is phrased in ordinary words.",
      "It does not recognise a name written entirely in capital letters.",
      "In Chrome and Safari it only reads a page while the address is visible.",
      "That is why nothing leaves until you have read it and said yes."
    ]);
  });
});

describe("onboarding", () => {
  it("walks the spec's order, and the machine-checked steps follow the real state", () => {
    expect(onboardingStep(status(["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]), settings(0))).toBe("pitch");
    expect(onboardingStep(status(["SIGNED_OUT", "NO_TAXONOMY", "MODEL_MISSING", "NO_PERMISSION"]), settings(1))).toBe("signIn");
    expect(onboardingStep(status(["MODEL_MISSING", "NO_PERMISSION"]), settings(1))).toBe("model");
    expect(onboardingStep(status(["SELF_TEST_NEEDED", "NO_PERMISSION"]), settings(1))).toBe("model");
    expect(onboardingStep(status(["PERMISSION_NEEDS_RESTART"]), settings(1))).toBe("permission");
    // Not answered yet is not granted: the step is never skipped on a guess.
    expect(onboardingStep({...status([]), checkingPermission: true}, settings(1))).toBe("permission");
    expect(onboardingStep({...status([]), checkingPermission: true}, settings(0))).toBe("pitch");
    expect(onboardingStep(status([]), settings(1))).toBe("neverRead");
    expect(onboardingStep(status([]), settings(5))).toBe("reviewTime");
    expect(onboardingStep(status([]), settings(6))).toBe("done");
    expect(onboardingStep(status([]), settings(7))).toBe("done");
  });

  it("shows the last step before it lets go of the window: 6 is Done, 7 is over", () => {
    // A stored 6 means the review time was chosen and the Done step has not been read yet, so
    // onboarding still owns the window and Done is what is on it. Its button writes 7, and only
    // then do the tabs open. A user who stored 6 before this rule existed simply sees Done once.
    expect(startScreen(status([]), settings(6))).toBe("onboarding");
    expect(onboardingStep(status([]), settings(6))).toBe("done");
    expect(startScreen(status([]), settings(7))).toBe("home");
    expect(startScreen(status([], 2), settings(7))).toBe("review");
  });

  it("goes back to a machine-checked step when something was undone, however far the user had come", () => {
    expect(onboardingStep(status(["SIGNED_OUT"]), settings(7))).toBe("signIn");
    expect(onboardingStep(status(["NO_PERMISSION"]), settings(7))).toBe("permission");
  });

  it("turns the whole window into the sign-in for a finished user who is signed out, and only then", () => {
    expect(mustSignIn(status(["SIGNED_OUT"]), settings(7))).toBe(true);
    expect(mustSignIn(status(["NO_PERMISSION", "SIGNED_OUT"]), settings(7))).toBe(true);
    // Still in onboarding: the sign-in is its own step there, with the step count above it.
    expect(mustSignIn(status(["SIGNED_OUT"]), settings(1))).toBe(false);
    expect(mustSignIn(status(["SIGNED_OUT"]), settings(6))).toBe(false);
    expect(mustSignIn(status(["NO_PERMISSION"]), settings(7))).toBe(false);
  });

  it("leaves a finished user on the home screen when the problem is not an onboarding step", () => {
    for (const blocker of ["MODEL_PROBLEM", "READER_PROBLEM", "STORAGE_PROBLEM", "SETTINGS_NEED_REVIEW"] as const) {
      expect(onboardingStep(status([blocker]), settings(7)), blocker).toBe("done");
      expect(firstBlocker(status([blocker])), blocker).toBe(blocker);
    }
  });

  it("owns the window until it is finished, then opens on review when there is something to review", () => {
    expect(startScreen(status([]), settings(3))).toBe("onboarding");
    expect(startScreen(status([], 4), settings(7))).toBe("review");
    expect(startScreen(status([]), settings(7))).toBe("home");
    expect(firstBlocker(status(["MODEL_PROBLEM", "STORAGE_PROBLEM"]))).toBe("MODEL_PROBLEM");
    expect(firstBlocker(status([]))).toBeNull();
  });
});

/**
 * The Screen Recording step. The owner watched macOS 27 do this with the app installed, so the copy
 * is measured rather than imagined, and the sentence it replaces was measured WRONG: the app notices
 * the grant by itself, no restart. That old sentence is asserted out of the whole file, not merely
 * off the object, because a string left behind in a comment is a string somebody puts back.
 */
describe("the permission step's copy", () => {
  const source = readFileSync(new URL("../copy.ts", import.meta.url), "utf8");

  it("has stopped telling the user that allowing it costs a restart", () => {
    expect(source).not.toContain("After you allow it, the app has to restart once.");
    expect(source).not.toContain("the app has to restart");
    // The rare case a restart really does cure keeps its own sentence and its own button.
    expect(BLOCKERS.PERMISSION_NEEDS_RESTART.sentence).toBe("Screen Recording is on. The app needs a restart to use it.");
  });

  it("prepares the user for what macOS will say, and for the three things they will have to do", () => {
    expect(COPY.onboarding.permission.lead).toContain("screen and audio");
    expect(COPY.onboarding.permission.lead).toContain("keeps no picture and no sound");
    expect(PERMISSION_STEPS).toHaveLength(3);
    expect(PERMISSION_STEPS[0]).toContain("Open System Settings");
    expect(PERMISSION_STEPS[1]).toContain("+ button");
    expect(PERMISSION_STEPS[2]).toContain("No restart is needed");
    expect(COPY.onboarding.permission.aside).toContain("Quit & Reopen");
    expect(COPY.onboarding.stillWaitingPermission).toContain("up to a minute");
  });

  /**
   * The name in System Settings is the .app FILE's name, and the window is told only the product
   * name, so the file name is derived in one place and substituted in. Asked for a different name,
   * the step has to answer with THAT name and with no trace of the derived one — which is what stops
   * the name being spelled out in the sentence and the parameter quietly ignored.
   */
  it("puts the app FILE's name in the second step, and takes it from whatever it is handed", () => {
    expect(APP_FILE).toBe("Clave Agent.app");
    expect(PERMISSION_STEPS[1]).toContain(APP_FILE);
    const probe = COPY.onboarding.permission.steps("Probe Name.app");
    expect(probe[1]).toContain("Probe Name.app");
    expect(probe[1]).not.toContain(APP_FILE);
  });
});

describe("the words for Windows", () => {
  const windowsLines = [
    blockerCopy("NO_PERMISSION", "windows").sentence, blockerCopy("NO_PERMISSION", "windows").action,
    checkingPermissionLine("windows"), privateWindowsLine("windows"), ...knownLimits("windows"),
    WINDOWS_COPY.permission.title, WINDOWS_COPY.permission.lead, WINDOWS_COPY.checkingOnboarding
  ];

  it("says nothing a Windows user cannot find: no System Settings, Screen Recording, menu bar or Safari", () => {
    for (const line of windowsLines) expect(line).not.toMatch(/System Settings|Screen Recording|menu bar|macOS|Applications|Safari/);
  });

  it("names the browsers that are measured there, Chrome only in English, and keeps every other limit as it is", () => {
    expect(privateWindowsLine("windows")).toContain("Microsoft Edge");
    expect(privateWindowsLine("windows")).toContain("InPrivate");
    expect(privateWindowsLine("windows")).toContain("Google Chrome");
    expect(privateWindowsLine("windows")).toContain("Incognito");
    expect(privateWindowsLine("windows")).toContain("English");
    expect(WINDOWS_COPY.addressLimit).toContain("Google Chrome");
    expect(knownLimits("windows")).toHaveLength(KNOWN_LIMITS.length);
    expect(knownLimits("windows").filter((line) => !KNOWN_LIMITS.includes(line))).toEqual([WINDOWS_COPY.addressLimit]);
  });

  it("leaves macOS, and a window told no platform, with the macOS words exactly", () => {
    for (const platform of ["mac", undefined] as const) {
      expect(blockerCopy("NO_PERMISSION", platform)).toBe(BLOCKERS.NO_PERMISSION);
      expect(checkingPermissionLine(platform)).toBe(COPY.home.checkingPermission);
      expect(privateWindowsLine(platform)).toBe(COPY.onboarding.privateWindows);
      expect(knownLimits(platform)).toBe(KNOWN_LIMITS);
    }
    // Only NO_PERMISSION has Windows words; every other blocker reads the same everywhere.
    expect(blockerCopy("MODEL_MISSING", "windows")).toBe(BLOCKERS.MODEL_MISSING);
  });
});

/**
 * Reading is on, the engine is healthy, and nothing has come through for a long while. One quiet
 * line, never a blocker — `blockers` is empty in every case below, so nothing here may reach the
 * home screen's fix-button path.
 */
describe("the nothing-read line", () => {
  const reading = (why: NothingReadWhy, over: Partial<EngineStatus> = {}): EngineStatus => ({
    ...status([]), capture: "on", nothingRead: {since: Date.UTC(2026, 8, 19, 11, 5), why}, ...over
  });
  /** Stands in for the screen's own clock, exactly as `reviewRows` is handed `localDay`. */
  const at = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

  it("has a sentence for every reason the engine can give, and no more", () => {
    expect(Object.keys(NOTHING_READ).sort()).toEqual([...NOTHING_READ_WHY].sort());
  });

  it.each(NOTHING_READ_WHY)("says what is happening, and since when, for %s", (why) => {
    expect(nothingReadLine(reading(why), at)).toBe(`${NOTHING_READ[why]} Since 11:05.`);
    // Every one of them opens by saying reading IS on: that is the thing the silence casts doubt on.
    expect(NOTHING_READ[why].startsWith("Reading is on.")).toBe(true);
  });

  it("names the excluded windows, the missing window and the general case apart", () => {
    expect(nothingReadLine(reading("notAllowed"), at)).toContain("windows in front are ones this app does not read");
    expect(nothingReadLine(reading("noWindow"), at)).toContain("no window to read");
    expect(nothingReadLine(reading("other"), at)).toContain("Nothing has been readable");
  });

  it("says nothing at all unless reading is actually on and the engine is actually reporting it", () => {
    expect(nothingReadLine(status([]), at)).toBeNull();
    expect(nothingReadLine(reading("noWindow", {capture: "off"}), at)).toBeNull();
    expect(nothingReadLine(reading("noWindow", {capture: "pausedByUser", resumeAt: Date.now()}), at)).toBeNull();
    expect(nothingReadLine({...reading("noWindow"), nothingRead: null}, at)).toBeNull();
  });

  it("returns null rather than the word \"undefined\" when the engine sends a why outside the closed list", () => {
    // EngineStatus crosses IPC as unvalidated JSON (no zod schema): a stale renderer talking to a
    // newer main process that ever adds a fourth NothingReadWhy is exactly the skew that reaches this
    // function at runtime, past the type system. `why` is cast through `unknown` to simulate that.
    const bogus = "aFourthReasonTheTypeDoesNotKnowAbout" as unknown as NothingReadWhy;
    expect(nothingReadLine(reading(bogus), at)).toBeNull();
  });

  it("is never a blocker, so the home screen's one-problem-one-button path never sees it", () => {
    for (const why of NOTHING_READ_WHY) expect(firstBlocker(reading(why))).toBeNull();
  });
});

/** The permission step's second, quieter line: only once the wait has actually run long. */
describe("waiting for the grant", () => {
  it("stays quiet through the ordinary wait and speaks up once it has run long", () => {
    expect(stillWaiting(1000, 1000)).toBe(false);
    expect(stillWaiting(1000, 1000 + LONG_WAIT_MS - 1)).toBe(false);
    expect(stillWaiting(1000, 1000 + LONG_WAIT_MS)).toBe(true);
    expect(stillWaiting(1000, 1000 + 60_000)).toBe(true);
  });
});

describe("download and review views", () => {
  it("turns download states into a phase and a percentage", () => {
    expect(downloadView({kind: "missing"}, 1000)).toEqual({phase: "idle", percent: 0, errorCode: null});
    expect(downloadView({kind: "downloading", receivedBytes: 255}, 1000)).toMatchObject({phase: "running", percent: 25});
    expect(downloadView({kind: "partial", receivedBytes: 999}, 1000)).toMatchObject({phase: "paused", percent: 99});
    expect(downloadView({kind: "downloading", receivedBytes: 5000}, 1000).percent).toBe(100);
    expect(downloadView({kind: "error", code: "DOWNLOAD_BAD_HASH"}, 1000)).toMatchObject({phase: "error", errorCode: "DOWNLOAD_BAD_HASH"});
    expect(gigabytes(2_740_937_888)).toBe("2.7");
  });

  it("lists statements in the engine's order with the target's name and the day", () => {
    const rows = reviewRows({pending: [{id: "a", kind: "skill", targetId: "pg", targetName: "PostgreSQL", statement: "Rebuilt an index.", createdAt: Date.UTC(2026, 8, 17, 9), taxonomyVersion: "t", pipelineVersion: "1"}], waitingUpload: [], sent: []},
      (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(rows).toEqual([{id: "a", statement: "Rebuilt an index.", target: "PostgreSQL", kind: "skill", day: "2026-09-17"}]);
  });
});

/**
 * The renderer bundle must contain no main-process code and must load nothing from the network.
 * The rule is one pure function over a file's text so that every form of reaching out can be proved
 * caught with a string, instead of being trusted to a regex nobody has ever seen fail.
 *
 * `src/shared/` is walked by the same rule: it is compiled into the renderer bundle too, and the
 * only thing it may take from `main/` is a type, which disappears at build time.
 */
const REACHES_INTO = /\/(?:main|core|shell|standins)(?:\/|$)/;
/** A specifier the renderer may not have at run time: main-process folders, Electron, Node built-ins. */
export const forbiddenSpecifier = (specifier: string, inTest = false): boolean =>
  // Node built-ins are the one rule a test file is exempt from: a test runs under Node and reads the
  // repo off the disk. Reaching into `main/` or `electron` is refused there too — a renderer test
  // that pulled the engine in would be testing something the bundle can never do.
  REACHES_INTO.test(specifier) || specifier === "electron" || (!inTest && specifier.startsWith("node:"));

/**
 * Every quoted string in a file: double, single, and a template literal with no substitution in it.
 * Strings are matched WITHOUT line anchors and without caring what statement they sit in, because
 * `const a = 1;import {x} from "../../main/engine";` is one line, and an anchored rule waves it
 * through. Single and double quotes may not span a line, so an apostrophe in prose can reach no
 * further than the end of its own line, and an opening single quote directly after a letter or digit
 * (`the user's`) is not a string at all. A template with `${` in it is left alone: a specifier built
 * at run time is refused by the `import(`/`require(` rules below, whatever it was built from.
 */
const QUOTED = /"(?:[^"\\\n]|\\.)*"|(?<![A-Za-z0-9_$)\]])'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`/g;
/** A character written as an escape. In something specifier-shaped it is only ever a way past a rule. */
const ESCAPE = /\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/;

/**
 * What the engine would load, not what the file says: `"../../main/engine"` is `../../main/engine`.
 * This mirrors what a JS string literal actually decodes to, including the case a naive reader
 * misses: a backslash before a character with no special meaning (`\a`, `\e`, `\o`, ...) is not an
 * error and not the literal two characters — the backslash is simply dropped, per the language's own
 * "identity escape" rule. That is exactly how `"\electron"` reads as `electron` and `"n\ode:fs"`
 * reads as `node:fs` to whatever actually resolves the module (esbuild's parser, same as V8's), so
 * it has to be exactly how this reads them too.
 */
const decode = (raw: string): string => raw.replace(
  /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([\s\S])/g,
  (_whole: string, codepoint: string | undefined, unit: string | undefined, byte: string | undefined, ch: string | undefined) => {
    if (codepoint !== undefined) return String.fromCodePoint(Number.parseInt(codepoint, 16));
    if (unit !== undefined) return String.fromCharCode(Number.parseInt(unit, 16));
    if (byte !== undefined) return String.fromCharCode(Number.parseInt(byte, 16));
    const named: Record<string, string> = {n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0"};
    return ch === undefined ? "" : (named[ch] ?? ch);
  }
);

/**
 * Where the one exemption starts: the opening quote of an `import type … from "x"` or
 * `export type … from "x"` specifier. Those disappear at build time, so they are the only strings
 * allowed to name `main/`. The clause may hold no quote or semicolon, so one statement can never
 * swallow the next, and the exemption is positional: the same text anywhere else is still a problem.
 */
function typeSpecifierStarts(source: string): Set<number> {
  const starts = new Set<number>();
  for (const match of source.matchAll(/\b(?:import|export)\s+type\b[^;"'`]*?\bfrom\s*["']/g)) {
    if (match.index !== undefined) starts.add(match.index + match[0].length - 1);
  }
  return starts;
}

/**
 * The opening quote of a specifier that names a module at run time: `import … from "x"`,
 * `export … from "x"` (the "type" form is excluded — that is `typeSpecifierStarts`'s job), a
 * side-effect `import "x"`, and `require("x")`. A backslash has no legitimate reason to appear in
 * any of these — a specifier is a bare path or package name, never text that needs escaping — so
 * this is where a no-op escape (`"\electron"`, `"../m\ain/engine"`, `"n\ode:fs"`) is caught even
 * when it does not spell out one of the forbidden names in `ESCAPE`'s narrower unicode/hex forms.
 */
function valueSpecifierStarts(source: string): Set<number> {
  const starts = new Set<number>();
  for (const match of source.matchAll(/\b(?:import|export)\s+(?!type\b)[^;"'`]*?\bfrom\s*["']/g)) {
    if (match.index !== undefined) starts.add(match.index + match[0].length - 1);
  }
  for (const match of source.matchAll(/\bimport\s*["']/g)) {
    if (match.index !== undefined) starts.add(match.index + match[0].length - 1);
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*["']/g)) {
    if (match.index !== undefined) starts.add(match.index + match[0].length - 1);
  }
  return starts;
}

/**
 * `import(` is refused as a dynamic import of a specifier built at run time — except when it is the
 * operand of `typeof`, e.g. `type X = typeof import("../../shared/ipc")`. That form never runs: the
 * whole expression is erased at compile time along with every other type, so it carries nothing into
 * the bundle. Stripping `typeof import(` before testing means a real `import(...)` elsewhere in the
 * same file is still caught.
 */
const hasDynamicImport = (source: string): boolean => /\bimport\s*\(/.test(source.replace(/\btypeof\s+import\s*\(/g, ""));

export function importProblems(source: string, inTest = false): string[] {
  const problems: string[] = [];
  const typeStarts = typeSpecifierStarts(source);
  const valueStarts = valueSpecifierStarts(source);
  for (const match of source.matchAll(QUOTED)) {
    if (match.index === undefined || typeStarts.has(match.index)) continue;
    const raw = match[0].slice(1, -1);
    const specifier = decode(raw);
    // A module specifier holds no whitespace and needs no escapes, so an escape inside something
    // that could be one is refused on sight — before the decoding above is trusted to have seen
    // through it. Prose (which has spaces) may still be written however it likes. Outside a known
    // specifier position, only the narrower unicode/hex forms are treated as suspicious; inside one,
    // any backslash at all is disqualifying, whatever it would decode to.
    const looksEscaped = ESCAPE.test(raw) || (valueStarts.has(match.index) && raw.includes("\\"));
    if (looksEscaped && !/\s/.test(specifier)) problems.push(`escaped specifier ${raw}`);
    if (forbiddenSpecifier(specifier, inTest)) problems.push(`forbidden specifier ${specifier}`);
  }
  // `import()` and `require()` are refused whatever their target: a specifier that is built at run
  // time cannot be checked here at all, and the renderer is one bundle with no second chunk to load.
  if (hasDynamicImport(source)) problems.push("dynamic import()");
  if (/\brequire\s*\(/.test(source)) problems.push("require()");
  return problems;
}

export function remoteProblems(source: string): string[] {
  const problems: string[] = [];
  if (/https?:\/\//.test(source)) problems.push("absolute http(s) URL");
  // "//fonts.example/x.css" inherits the page's scheme: still remote, and easy to miss by eye.
  if (/["'`]\/\/[^"'`/\s]/.test(source)) problems.push("protocol-relative URL");
  // CSS `url(...)` (and `@import url(...)`) needs no quotes at all, which is exactly the form the
  // rule above misses: `url(//cdn/x.css)` has no quote character sitting right before the `//`, so
  // it walked straight through. `url(https://...)` unquoted is already caught by the first rule
  // above (it is just a substring match), but the protocol-relative form gets its own check rather
  // than loosening the quote-based one, which would start flagging an ordinary `//` comment that
  // happens to sit right after an unrelated `(`.
  if (/\burl\(\s*\/\//i.test(source)) problems.push("protocol-relative URL");
  return problems;
}

export const rendererProblems = (source: string, inTest = false): string[] => [...importProblems(source, inTest), ...remoteProblems(source)];

describe("what the renderer may import", () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ["a type import from main", 'import type {Blocker} from "../../main/engine";', null],
    ["a value import from main", 'import {createEngine} from "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["a re-export of types", 'export type {Blocker} from "../../main/engine";', null],
    ["a re-export of values", 'export {createEngine} from "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["a star re-export", 'export * from "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["a single-quoted specifier", "import {createEngine} from '../../main/engine';", "forbidden specifier ../../main/engine"],
    ["a side-effect import", 'import "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["a side-effect import of a stylesheet", 'import "./app.css";', null],
    ["a folder specifier with no trailing slash", 'import {x} from "../../main";', "forbidden specifier ../../main"],
    ["the core, the shell and the stand-ins", 'import {a} from "../../core";\nimport {b} from "../../shell/app";\nimport {c} from "../../standins/stubApi";', "forbidden specifier ../../core"],
    ["a dynamic import", 'const engine = await import("../../main/engine");', "dynamic import()"],
    ["a dynamic import of something local", 'const later = await import("./views");', "dynamic import()"],
    ["typeof import() in a type position, which vanishes at build time", 'type Status = typeof import("../../shared/ipc");\nexport type {Status};', null],
    ["require", 'const fs = require("node:fs");', "require()"],
    ["import-equals-require", 'import fs = require("node:fs");', "require()"],
    ["electron", 'import {ipcRenderer} from "electron";', "forbidden specifier electron"],
    ["a node built-in", 'import {join} from "node:path";', "forbidden specifier node:path"],
    ["a multi-line import from main", 'import {\n  createEngine,\n  type Engine\n} from "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["an absolute URL", 'const font = "https://fonts.example/Inter.woff2";', "absolute http(s) URL"],
    ["a protocol-relative URL", 'const font = "//fonts.example/Inter.woff2";', "protocol-relative URL"],
    ["an ordinary comment", 'const x = 1; // half // of // this line is a comment\n', null],
    ["prose with an apostrophe in it", "// the renderer's own problem, not the engine's\nexport const a = 1;\n", null],
    // The three bypasses the combined re-review walked straight through the old anchored rule with.
    ["an import that is not the first thing on its line", 'const a = 1;import {createEngine} from "../../main/engine";', "forbidden specifier ../../main/engine"],
    ["the n of main written as an escape", 'import {createEngine} from "../../mai\\u006e/engine";', "escaped specifier ../../mai\\u006e/engine"],
    ["the same escape, seen through", 'import {createEngine} from "../../mai\\u006e/engine";', "forbidden specifier ../../main/engine"],
    ["a hex escape", 'import {ipcRenderer} from "\\x65lectron";', "forbidden specifier electron"],
    ["a no-op backslash escape, the kind a regex over source text cannot see through", 'import {createEngine} from "../../m\\ain/engine";', "forbidden specifier ../../main/engine"],
    ["electron spelled with a no-op backslash escape", 'import {ipcRenderer} from "\\electron";', "forbidden specifier electron"],
    ["node:fs spelled with a no-op backslash escape", 'import {readFileSync} from "n\\ode:fs";', "forbidden specifier node:fs"],
    ["any backslash in a value specifier is disqualifying, even one that resolves to nothing forbidden", 'import {onboardingStep} from "./vi\\ews";', "escaped specifier ./vi\\ews"],
    ["an aliased require", 'const read = require;\nconst fs = read("node:fs");', "forbidden specifier node:fs"],
    ["a type-looking string that is not a specifier position", 'const where = "import type {x} from \'../../main/engine\'";', "forbidden specifier import type {x} from '../../main/engine'"],
    ["everything it is allowed to do", 'import type {EngineStatus} from "../../shared/ipc";\nimport {COPY} from "../copy";\nexport const a = 1;', null]
  ];
  it.each(cases)("catches %s", (_name, source, expected) => {
    const problems = rendererProblems(source);
    if (expected === null) expect(problems).toEqual([]);
    else expect(problems).toContain(expected);
  });

  it("lets a test file read the disk, and nothing more", () => {
    expect(rendererProblems('import {readFileSync} from "node:fs";', true)).toEqual([]);
    expect(rendererProblems('import {readFileSync} from "node:fs";')).toContain("forbidden specifier node:fs");
    expect(rendererProblems('import {createEngine} from "../../main/engine";', true)).toContain("forbidden specifier ../../main/engine");
  });

  const roots = [fileURLToPath(new URL("../", import.meta.url)), fileURLToPath(new URL("../../shared/", import.meta.url))];
  /**
   * Both files are the rule, not its subject: this file's `cases` table and bundle.guard.test.ts's
   * throwaway fixtures each hold every forbidden form as data — a string that looks like a bad
   * specifier to the human eye but is never actually imported by that file. Walking them anyway
   * would have the regex catch its own test data, which is a false positive, not a finding.
   */
  const GUARD = new Set([fileURLToPath(import.meta.url), fileURLToPath(new URL("../bundle.guard.test.ts", import.meta.url))]);
  const files = (dir: string, pattern: RegExp): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, pattern) : pattern.test(name) && !GUARD.has(path) ? [path] : [];
  });
  const walked = roots.flatMap((root) => files(root, /\.(ts|tsx)$/));
  /** The walk yields native paths; the expectations below are written with `/`, which Windows does not use. */
  const endsWith = (file: string, tail: string) => file.replaceAll("\\", "/").endsWith(tail);

  it("walks the renderer and the shared surface, tests included, and finds them there", () => {
    expect(walked.some((f) => endsWith(f, "/renderer/main.tsx"))).toBe(true);
    expect(walked.some((f) => endsWith(f, "/renderer/copy.ts"))).toBe(true);
    expect(walked.some((f) => endsWith(f, "/shared/ipc.ts"))).toBe(true);
    expect(walked.some((f) => endsWith(f, "/shared/ipc.test.ts"))).toBe(true);
    expect(walked.some((f) => GUARD.has(f))).toBe(false);
  });

  it.each(walked)("%s reaches main/ and core/ through types only, and nothing remote", (file) => {
    expect(rendererProblems(readFileSync(file, "utf8"), /\.test\.tsx?$/.test(file))).toEqual([]);
  });

  /**
   * The stylesheet and the page are not TypeScript, and until now nothing walked them — which is
   * where a remote resource is EASIEST to add and hardest to spot: one `@font-face` with a
   * `url(https://…)`, one `@import`, one `<link>` or `<img>` in index.html. None of those is an
   * import, so `importProblems` has nothing to say about them; `remoteProblems` is the whole rule
   * that applies, and it is the one that matters — the app's promise is that it works with the
   * Wi-Fi off and fetches nothing, ever.
   */
  const assets = files(fileURLToPath(new URL("../", import.meta.url)), /\.(css|html)$/);

  it("walks the renderer's stylesheet and page too", () => {
    expect(assets.some((f) => endsWith(f, "/renderer/styles.css"))).toBe(true);
    expect(assets.some((f) => endsWith(f, "/renderer/index.html"))).toBe(true);
  });

  it.each(assets)("%s fetches nothing from anywhere", (file) => {
    expect(remoteProblems(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("would notice a remote font or an absolute link in either of them", () => {
    expect(remoteProblems('@font-face { src: url("https://fonts.example/Inter.woff2"); }')).toContain("absolute http(s) URL");
    expect(remoteProblems('@import url("//fonts.example/all.css");')).toContain("protocol-relative URL");
    expect(remoteProblems('<link rel="stylesheet" href="https://cdn.example/a.css" />')).toContain("absolute http(s) URL");
    expect(remoteProblems('<img src="//cdn.example/pixel.gif" />')).toContain("protocol-relative URL");
    expect(remoteProblems('.a { background: none; } /* no url() here */')).toEqual([]);
  });

  it("would notice an UNQUOTED remote reference inside CSS url(...) or @import, which the quote-based rule alone cannot see", () => {
    expect(remoteProblems("@import url(//cdn/x.css);")).toContain("protocol-relative URL");
    expect(remoteProblems("@font-face { src: url(https://x/y.woff2); }")).toContain("absolute http(s) URL");
    expect(remoteProblems(".a { background: url(  //cdn.example/bg.png); }")).toContain("protocol-relative URL");
  });

  it("leaves an ordinary local or data url() alone", () => {
    expect(remoteProblems("@font-face { src: url(./assets/font.woff2); }")).toEqual([]);
    expect(remoteProblems('.a { background: url(data:image/png;base64,iVBORw0KGgo=); }')).toEqual([]);
  });
});

describe("isTranslocated", () => {
  it("is true only for an exact true from main; an older main without the field means no", () => {
    expect(isTranslocated({translocated: true})).toBe(true);
    expect(isTranslocated({translocated: false})).toBe(false);
    expect(isTranslocated({})).toBe(false);
    expect(isTranslocated({translocated: undefined})).toBe(false);
    expect(isTranslocated({translocated: "true" as unknown as boolean})).toBe(false);
  });
});

describe("the translocation copy", () => {
  it("names the .app file the user must move, says what to do in order, and never asks for the grant", () => {
    const steps = COPY.onboarding.translocated.steps(APP_FILE);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toContain(APP_FILE);
    expect((steps[0] ?? "").toLowerCase()).toContain("quit");
    expect((steps[2] ?? "").toLowerCase()).toContain("open it");
    for (const line of [COPY.onboarding.translocated.title, COPY.onboarding.translocated.lead, ...steps]) {
      expect(line.toLowerCase()).not.toContain("system settings");
      expect(line.toLowerCase()).not.toContain("allow");
    }
  });
});
