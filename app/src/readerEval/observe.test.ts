/**
 * What an `observe` run is asked for: the closed set of expectations, the host grammar, and the rows
 * the owner's terminal prints.
 *
 * The one thing every test here is really about is finding O1. A mode whose windows the OWNER opens
 * by hand accepted a run in which one window of twenty had been opened, because nothing in the run
 * had ever said what it wanted. These are the values that say it.
 */
import {existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {CHROME, OBSERVE_CASES, SAFARI, stagedTitleOf} from "./cases";
import {
  DEFAULT_OBSERVE_HOST,
  EXPECT_MAX_LENGTH,
  OBSERVE_EXPECT_SETS,
  OBSERVE_HOST_MAX,
  OBSERVE_READ_ATTEMPTS_MAX,
  expectationOf,
  inExpectSet,
  noToolbarStrip,
  observeProgressName,
  observeUrlsFile,
  observeUrlsName,
  parseExpectSets,
  parseObserveHost,
  readAsExpected,
  observeRevealName,
  revealRowOf,
  revealSafe,
  serialiseObserveReveal,
  REVEAL_LINES_MAX,
  REVEAL_LINE_MAX,
  REVEAL_REPLACEMENT,
  REVEAL_HEARTBEAT_MS,
  REVEAL_HEARTBEAT_MAX_AGE_MS,
  createRevealGate,
  heartbeatFresh,
  observeAliveName,
  revealLength,
  revealUnsafeCodePoint,
  revealFileNames,
  writeRevealFile,
  REVEAL_FILE_MODE,
  REVEAL_PARTIAL_SUFFIX,
  REVEAL_CLAIMED_SUFFIX,
  type ObserveRevealLine
} from "./observe";

const NONCE = "abc123";

describe("the sets a run may expect", () => {
  /** Derived from the case table, so a browser added there brings its three names with it. */
  it("is one name per browser and one per half of it", () => {
    expect([...OBSERVE_EXPECT_SETS].sort()).toEqual(
      ["chrome", "chrome-normal", "chrome-private", "safari", "safari-normal", "safari-private"]
    );
  });

  it("names five cases per half and ten per browser, out of the twenty in the table", () => {
    expect(OBSERVE_CASES).toHaveLength(20);
    expect(expectationOf(["safari-private"])?.cases).toHaveLength(5);
    expect(expectationOf(["safari-normal"])?.cases).toHaveLength(5);
    expect(expectationOf(["safari"])?.cases).toHaveLength(10);
    expect(expectationOf(["chrome"])?.cases).toHaveLength(10);
  });

  /** Every set name resolves to cases, or a run could be "expected" and have nothing to wait for. */
  it.each([...OBSERVE_EXPECT_SETS])("resolves %s to cases of the table", (set) => {
    const expectation = expectationOf([set]);
    expect(expectation?.cases.length).toBeGreaterThan(0);
    for (const name of expectation?.cases ?? []) {
      expect(OBSERVE_CASES.some((entry) => entry.name === name), name).toBe(true);
    }
  });

  /**
   * Membership is decided on the case's own `app` and `expectPrivate` — the two fields the guard and
   * the verdict use — and never on its name.
   */
  it("puts a case in its browser's set and in the half its expectation belongs to", () => {
    const safariPrivate = OBSERVE_CASES.find((entry) => entry.app === SAFARI && entry.expectPrivate);
    const chromeNormal = OBSERVE_CASES.find((entry) => entry.app === CHROME && !entry.expectPrivate);
    if (safariPrivate === undefined || chromeNormal === undefined) throw new Error("the table lost a case");
    expect(inExpectSet(safariPrivate, "safari")).toBe(true);
    expect(inExpectSet(safariPrivate, "safari-private")).toBe(true);
    expect(inExpectSet(safariPrivate, "safari-normal")).toBe(false);
    expect(inExpectSet(safariPrivate, "chrome")).toBe(false);
    expect(inExpectSet(chromeNormal, "chrome-normal")).toBe(true);
    expect(inExpectSet(chromeNormal, "chrome-private")).toBe(false);
  });

  it("puts no case in a set it does not have", () => {
    for (const theCase of OBSERVE_CASES) expect(inExpectSet(theCase, "everything"), theCase.name).toBe(false);
  });

  it("takes a comma list, in the order it was written, and unions the cases once each", () => {
    expect(parseExpectSets("safari-private,chrome-private")).toEqual(["safari-private", "chrome-private"]);
    const both = expectationOf(["safari", "safari-private"]);
    // `safari` already holds every `safari-private` case: a case named twice is listed once.
    expect(both?.cases).toHaveLength(10);
    expect(new Set(both?.cases).size).toBe(10);
  });

  it.each([
    ["a set it does not have", "safari-privat"],
    ["a set differing only in case", "Safari-Private"],
    ["an empty value", ""],
    ["a trailing comma", "safari,"],
    ["a repeat", "safari,safari"],
    ["spaces", "safari, chrome"],
    ["something far too long", "a".repeat(EXPECT_MAX_LENGTH + 1)]
  ])("refuses %s rather than narrowing it", (_label, raw) => {
    expect(parseExpectSets(raw)).toBeNull();
  });

  /** `null` is the exploratory run: it named nothing, and the verdict says so. */
  it("has no expectation at all when nobody asked", () => {
    expect(expectationOf(null)).toBeNull();
  });
});

/**
 * Finding O4, as the one rule both the progress line and the verdict use: a read that FAILED agreed
 * with nothing and disagreed with nothing.
 */
describe("whether a read agreed with its own case", () => {
  it("is true for a private case that showed the marker and a normal one that did not", () => {
    expect(readAsExpected({outcome: "ok", expectPrivate: true, private: true})).toBe(true);
    expect(readAsExpected({outcome: "ok", expectPrivate: false, private: false})).toBe(true);
  });

  it("is false for a private case with no marker, including one with no strip at all", () => {
    expect(readAsExpected({outcome: "ok", expectPrivate: true, private: false})).toBe(false);
    expect(readAsExpected({outcome: "ok", expectPrivate: true, private: null})).toBe(false);
  });

  /**
   * Review, Minor 5. A NORMAL window read with no toolbar strip at all was called a pass by
   * `private !== true`, so `--expect safari-normal` could be ACCEPTED over five reads in which the
   * product's rule was never applied to anything. Nothing was checked, so nothing passed.
   */
  it("is false for a normal case that came back with no toolbar strip at all", () => {
    expect(noToolbarStrip({outcome: "ok", private: null})).toBe(true);
    expect(readAsExpected({outcome: "ok", expectPrivate: false, private: null})).toBe(false);
    // and a read that failed is not "no strip" — it is no read
    expect(noToolbarStrip({outcome: "windowGone", private: null})).toBe(false);
    expect(noToolbarStrip({outcome: "ok", private: false})).toBe(false);
  });

  it("is false for a normal case flagged private", () => {
    expect(readAsExpected({outcome: "ok", expectPrivate: false, private: true})).toBe(false);
  });

  /** The row of run #2 that was printed as a private window that would have been KEPT. */
  it.each(["windowGone", "timeout", "black", "failed", "notStaged"])("is false for a %s read, whatever it expected", (outcome) => {
    expect(readAsExpected({outcome, expectPrivate: true, private: null})).toBe(false);
    expect(readAsExpected({outcome, expectPrivate: false, private: null})).toBe(false);
  });
});

describe("the host the URLs use", () => {
  it("defaults to the loopback address every run so far has used", () => {
    expect(DEFAULT_OBSERVE_HOST).toBe("127.0.0.1");
    expect(parseObserveHost(DEFAULT_OBSERVE_HOST)).toBe("127.0.0.1");
  });

  it.each([
    ["the bare name", "localhost"],
    ["a word host", "app.clave.localhost"],
    ["one with digits and hyphens", "mail-2.corp.localhost"],
    ["the longest name that fits", `${"a".repeat(OBSERVE_HOST_MAX - ".localhost".length)}.localhost`]
  ])("takes %s", (_label, raw) => {
    expect(parseObserveHost(raw)).toBe(raw);
  });

  /**
   * The grammar is closed because this string goes into a URL the owner pastes into a browser — a
   * private one included. `.localhost` is reserved for the loopback address, so the grammar is also
   * the reason no packet leaves the machine.
   */
  it.each([
    ["a name off the loopback reservation", "example.com"],
    ["an address that is not the loopback one", "10.0.0.1"],
    ["an uppercase name", "App.Clave.localhost"],
    ["a name with a slash", "clave.localhost/x"],
    ["a name with a colon and a port", "clave.localhost:8080"],
    ["an empty name", ""],
    ["the bare suffix", ".localhost"],
    ["an empty label", "a..localhost"],
    ["a label starting with a hyphen", "-a.localhost"],
    ["a label ending with a hyphen", "a-.localhost"],
    ["a name past the bound", `${"a".repeat(OBSERVE_HOST_MAX)}.localhost`]
  ])("refuses %s", (_label, raw) => {
    expect(parseObserveHost(raw)).toBeNull();
  });
});

describe("the file the owner's terminal reads", () => {
  /** Finding O3: the nonce is in the NAME, so another run's file cannot answer for this one. */
  it("is named with this run's nonce, and so is the progress file beside it", () => {
    expect(observeUrlsName(NONCE)).toBe("observe-urls-abc123.json");
    expect(observeProgressName(NONCE)).toBe("observe-progress-abc123.json");
    expect(observeUrlsName("other")).not.toBe(observeUrlsName(NONCE));
  });

  it("lists the whole table, each URL carrying this run's staged title and the asked-for host", () => {
    const file = observeUrlsFile({port: 51234, nonce: NONCE, host: "app.clave.localhost", expect: ["safari-private"]});
    expect(file.urls).toHaveLength(OBSERVE_CASES.length);
    expect(file.host).toBe("app.clave.localhost");
    expect(file.nonce).toBe(NONCE);
    for (const row of file.urls) {
      expect(row.url.startsWith("http://app.clave.localhost:51234/")).toBe(true);
      // Through `pageUrl`, which is the one URL builder in this harness — the same query encoding
      // every staged Chrome window has been opened with, where a space is `+` and the page server's
      // own `searchParams.get` turns it back into one.
      expect(row.url).toContain(new URLSearchParams({stagedTitle: stagedTitleOf(row.case, NONCE)}).toString());
    }
  });

  /** The terminal prints the expected rows only, so it filters on a flag the BUNDLE decided. */
  it("marks exactly the expected cases, and marks none at all on an exploratory run", () => {
    const expected = observeUrlsFile({port: 1, nonce: NONCE, host: DEFAULT_OBSERVE_HOST, expect: ["safari-private"]});
    expect(expected.expect).toEqual(["safari-private"]);
    expect(expected.urls.filter((row) => row.expected)).toHaveLength(5);
    for (const row of expected.urls.filter((row) => row.expected)) {
      expect(row.app).toBe(SAFARI);
      expect(row.expectPrivate).toBe(true);
    }
    const exploratory = observeUrlsFile({port: 1, nonce: NONCE, host: DEFAULT_OBSERVE_HOST, expect: null});
    expect(exploratory.expect).toBeNull();
    expect(exploratory.urls.every((row) => row.expected === false)).toBe(true);
  });

  it("uses the loopback address by default, as every run before the option did", () => {
    const file = observeUrlsFile({port: 7, nonce: NONCE, host: DEFAULT_OBSERVE_HOST, expect: null});
    expect(file.urls[0]?.url.startsWith("http://127.0.0.1:7/")).toBe(true);
  });
});

/** A window that failed three reads two seconds apart is not a window that was merely moved. */
describe("how many times one window is read", () => {
  it("is bounded at three", () => {
    expect(OBSERVE_READ_ATTEMPTS_MAX).toBe(3);
  });
});

/**
 * The reveal channel. Every test here is about a fence rather than a feature: this is the one place
 * the harness shows recognised text, and what it must NOT show is the whole design.
 */
describe("the revealed toolbar strip", () => {
  const line = (text: string, over: Partial<ObserveRevealLine> = {}) =>
    ({text, topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200, ...over});

  it("shows the strip and the band's own lines, with the boxes they were recognised in", () => {
    const row = revealRowOf({
      case: "safari-normal-chat-light-14",
      toolbarText: "127.0.0.1/chat.html",
      lines: [line("127.0.0.1/chat.html")],
      bandPx: 41
    });
    expect(row.case).toBe("safari-normal-chat-light-14");
    expect(row.toolbarText).toBe("127.0.0.1/chat.html");
    expect(row.toolbarTextLength).toBe(19);
    expect(row.bandPx).toBe(41);
    expect(row.lines).toEqual([
      {text: "127.0.0.1/chat.html", length: 19, topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200}
    ]);
    expect(row.linesInBand).toBe(1);
  });

  /**
   * The rule the whole channel turns on. A line below the band is page content — the thing this must
   * never show — and `bandPx` is where the helper judged the toolbar to end.
   */
  it("never shows a line below the band", () => {
    const row = revealRowOf({
      case: "safari-normal-chat-light-14",
      toolbarText: "127.0.0.1",
      lines: [line("127.0.0.1"), line("PAGE BODY SECRET", {topPx: 200, bottomPx: 220})],
      bandPx: 41
    });
    expect(row.lines.map((entry) => entry.text)).toEqual(["127.0.0.1"]);
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  /** And with no band there is no answer to "which of these are toolbar lines", so none is shown. */
  it("shows no line at all when the read came back with no band", () => {
    const row = revealRowOf({
      case: "safari-normal-chat-light-14",
      toolbarText: "127.0.0.1",
      lines: [line("127.0.0.1"), line("PAGE BODY SECRET", {topPx: 200, bottomPx: 220})],
      bandPx: null
    });
    expect(row.lines).toEqual([]);
    expect(row.linesInBand).toBe(0);
    expect(JSON.stringify(row)).not.toContain("SECRET");
    // the assembled strip is still shown: the helper builds it from the band itself
    expect(row.toolbarText).toBe("127.0.0.1");
  });

  it("shows at most REVEAL_LINES_MAX lines, and says how many there were", () => {
    const row = revealRowOf({
      case: "safari-normal-chat-light-14",
      toolbarText: "x",
      lines: [...Array(20).keys()].map((index) => line(`line ${index}`)),
      bandPx: 41
    });
    expect(REVEAL_LINES_MAX).toBe(8);
    expect(row.lines).toHaveLength(REVEAL_LINES_MAX);
    expect(row.linesInBand).toBe(20);
  });

  it("cuts every string to REVEAL_LINE_MAX and reports the length it had", () => {
    const long = "a".repeat(500);
    const row = revealRowOf({case: "c", toolbarText: long, lines: [line(long)], bandPx: 41});
    expect(REVEAL_LINE_MAX).toBe(120);
    expect(row.toolbarText).toHaveLength(REVEAL_LINE_MAX);
    expect(row.toolbarTextLength).toBe(500);
    expect(row.lines[0]?.text).toHaveLength(REVEAL_LINE_MAX);
    expect(row.lines[0]?.length).toBe(500);
  });

  /** A terminal is the one place a raw control byte must not land. */
  it("replaces control characters rather than printing them", () => {
    const nasty = `a${String.fromCharCode(27)}[2Jb${String.fromCharCode(0)}c${String.fromCharCode(10)}d`;
    expect(revealSafe(nasty)).toBe(`a${REVEAL_REPLACEMENT}[2Jb${REVEAL_REPLACEMENT}c${REVEAL_REPLACEMENT}d`);
    const row = revealRowOf({case: "c", toolbarText: nasty, lines: [line(nasty)], bandPx: 41});
    for (const value of [row.toolbarText, row.lines[0]?.text ?? ""]) {
      for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        expect(code < 0x20 || code === 0x7f, value).toBe(false);
      }
    }
  });

  /** The cut counts code points, so half an astral character never reaches a terminal. */
  it("never cuts an astral character in half", () => {
    const astral = String.fromCodePoint(0x1f600);
    const cut = revealSafe(astral.repeat(200));
    expect([...cut]).toHaveLength(REVEAL_LINE_MAX);
    expect(cut.endsWith(astral)).toBe(true);
  });

  it("is named with this run's nonce, like the other two", () => {
    expect(observeRevealName(NONCE)).toBe("observe-reveal-abc123.json");
    expect(observeRevealName("other")).not.toBe(observeRevealName(NONCE));
  });

  /** The serialiser admits six fields per row and six per line, each rebuilt by name. */
  it("writes the six fields of a row and nothing that rode along", () => {
    const written = serialiseObserveReveal({
      schema: 1, nonce: NONCE,
      rows: [{
        case: "safari-normal-chat-light-14", bandPx: 41, toolbarText: "127.0.0.1",
        toolbarTextLength: 9, linesInBand: 1,
        lines: [{text: "127.0.0.1", length: 9, topPx: 16, bottomPx: 37, leftPx: 10, rightPx: 200, body: "SMUGGLED-LINE"} as never],
        text: "SMUGGLED-PAGE-BODY",
        title: "SMUGGLED-WINDOW-TITLE"
      } as never]
    });
    expect(written).not.toContain("SMUGGLED");
    const parsed = JSON.parse(written) as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(parsed).sort()).toEqual(["nonce", "rows", "schema"]);
    const row = parsed.rows?.[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["bandPx", "case", "lines", "linesInBand", "toolbarText", "toolbarTextLength"]
    );
    expect(Object.keys((row.lines as Record<string, unknown>[])[0] ?? {}).sort()).toEqual(
      ["bottomPx", "leftPx", "length", "rightPx", "text", "topPx"]
    );
  });
});

/**
 * The liveness gate (review, Important 1c). The terminal is launched from a shell; the bundle is
 * launched by LaunchServices through `open -n -W`, so Ctrl-C kills the terminal and leaves the
 * bundle running. This is the half the terminal's own signal handlers cannot reach.
 */
describe("revealing only while the terminal is there", () => {
  const rows = [{
    case: "safari-normal-chat-light-14", bandPx: 41, toolbarText: "127.0.0.1", toolbarTextLength: 9,
    linesInBand: 0, lines: []
  }];
  const gateWith = (ages: (number | null)[]) => {
    const written: string[] = [];
    const removed: number[] = [];
    let index = 0;
    const gate = createRevealGate(NONCE, {
      heartbeatAgeMs: () => ages[Math.min(index++, ages.length - 1)] ?? null,
      write: (contents) => { written.push(contents); },
      remove: () => { removed.push(written.length); }
    });
    return {gate, written, removed};
  };

  it("writes while the heartbeat is fresh", () => {
    const {gate, written, removed} = gateWith([0, 900, REVEAL_HEARTBEAT_MAX_AGE_MS]);
    gate.reveal(rows);
    gate.reveal(rows);
    gate.reveal(rows);
    expect(written).toHaveLength(3);
    expect(removed).toEqual([]);
    expect(gate.stopped()).toBe(false);
    expect(written[0]).toContain("127.0.0.1");
  });

  /** The whole point: a stale heartbeat takes the text off the disk and stops for good. */
  it("deletes the file and stops for the rest of the run when the heartbeat goes stale", () => {
    const {gate, written, removed} = gateWith([0, REVEAL_HEARTBEAT_MAX_AGE_MS + 1, 0, 0]);
    gate.reveal(rows);
    expect(written).toHaveLength(1);
    gate.reveal(rows);                                   // stale: removed, and stopped
    expect(removed).toHaveLength(1);
    expect(gate.stopped()).toBe(true);
    // it does not resume, even if a heartbeat comes back: that terminal is not the one that asked
    gate.reveal(rows);
    gate.reveal(rows);
    expect(written).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  /** No heartbeat file at all is not "maybe": a bundle that cannot see a terminal writes nothing. */
  it("never writes when there is no heartbeat at all", () => {
    const {gate, written, removed} = gateWith([null]);
    gate.reveal(rows);
    expect(written).toEqual([]);
    expect(removed).toHaveLength(1);
    expect(gate.stopped()).toBe(true);
  });

  /**
   * End of run. The two instructions pull opposite ways — the bundle should delete its own file, and
   * the last case's strip must not be dropped — and the same question settles both.
   */
  it("deletes at the end of a run whose terminal is gone, and leaves it for one that is not", () => {
    const dead = gateWith([REVEAL_HEARTBEAT_MAX_AGE_MS + 1]);
    dead.gate.end();
    expect(dead.removed).toHaveLength(1);

    const alive = gateWith([0]);
    alive.gate.end();
    expect(alive.removed).toEqual([]);                   // the terminal will claim it within a poll

    // and a gate that already stopped does not remove twice
    const stopped = gateWith([REVEAL_HEARTBEAT_MAX_AGE_MS + 1]);
    stopped.gate.reveal(rows);
    stopped.gate.end();
    expect(stopped.removed).toHaveLength(1);
  });

  it("calls a heartbeat fresh up to the bound and stale past it", () => {
    expect(REVEAL_HEARTBEAT_MAX_AGE_MS).toBe(5_000);
    expect(REVEAL_HEARTBEAT_MS).toBe(1_000);
    expect(heartbeatFresh(0)).toBe(true);
    expect(heartbeatFresh(REVEAL_HEARTBEAT_MAX_AGE_MS)).toBe(true);
    expect(heartbeatFresh(REVEAL_HEARTBEAT_MAX_AGE_MS + 1)).toBe(false);
    expect(heartbeatFresh(null)).toBe(false);
    // a wall clock that stepped can stamp a file in the future; that is not a dead terminal
    expect(heartbeatFresh(-2_000)).toBe(true);
  });

  it("names the heartbeat with this run's nonce, like every other file of the run", () => {
    expect(observeAliveName(NONCE)).toBe("observe-alive-abc123");
    expect(observeAliveName("other")).not.toBe(observeAliveName(NONCE));
  });
});

/** Review, Minor 1: what a terminal must never be handed, built from numbers. */
describe("the characters a revealed string may not hold", () => {
  const CODES = [
    0x00, 0x1b, 0x1f, 0x7f,                 // C0 and DEL
    0x80, 0x9b, 0x9f,                       // C1, the 8-bit CSI among them
    0x061c,                                 // ARABIC LETTER MARK
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width and the marks
    0x2028, 0x2029,                         // line and paragraph separators
    0x202a, 0x202d, 0x202e,                 // bidi embeddings and the override
    0x2060, 0x2066, 0x2069, 0xfeff
  ];

  it.each(CODES)("replaces U+%s", (code) => {
    expect(revealUnsafeCodePoint(code)).toBe(true);
    expect(revealSafe(`a${String.fromCodePoint(code)}b`)).toBe(`a${REVEAL_REPLACEMENT}b`);
  });

  /** The reviewer's own probe string, which came back with three of its characters verbatim. */
  it("leaves nothing of the reviewer's probe string", () => {
    const probe = `safe${String.fromCodePoint(0x202e)}gpj.exe${String.fromCodePoint(0x200b)}${String.fromCodePoint(0x9b)}[2J`;
    expect(revealSafe(probe)).toBe(`safe${REVEAL_REPLACEMENT}gpj.exe${REVEAL_REPLACEMENT}${REVEAL_REPLACEMENT}[2J`);
  });

  it.each([0x20, 0x41, 0x7e, 0x61c - 1, 0x2010, 0x2027, 0x202f, 0x2061, 0x2065, 0x206a, 0xfefe, 0x1f600])(
    "leaves an ordinary character alone (U+%s)",
    (code) => {
      expect(revealUnsafeCodePoint(code)).toBe(false);
      expect(revealSafe(String.fromCodePoint(code))).toBe(String.fromCodePoint(code));
    }
  );

  /** Review, Minor 2: the cut counts code points, so the length beside it must too. */
  it("reports a length in the unit the cut counts", () => {
    const astral = String.fromCodePoint(0x1f600).repeat(REVEAL_LINE_MAX);
    const row = revealRowOf({
      case: "c", toolbarText: astral,
      lines: [{text: astral, topPx: 1, bottomPx: 2, leftPx: 3, rightPx: 4}],
      bandPx: 41
    });
    expect(revealLength(astral)).toBe(REVEAL_LINE_MAX);
    expect(astral.length).toBe(REVEAL_LINE_MAX * 2);            // what the old count would have said
    // not truncated, and the number says so
    expect(row.toolbarTextLength).toBe(REVEAL_LINE_MAX);
    expect([...row.toolbarText]).toHaveLength(REVEAL_LINE_MAX);
    expect(row.lines[0]?.length).toBe(REVEAL_LINE_MAX);
  });
});

/**
 * The gate against a real folder, wired the way `main.ts` wires it.
 *
 * The factory above is tested with counters; this is the claim the owner cares about, stated in the
 * only terms that matter — after a stale heartbeat there is NOTHING ON DISK. The three lines of
 * `fs` here are the same three `main.ts` supplies (`statSync().mtimeMs`, `writeAtomic`, `rmSync` of
 * the file and its `.partial`), so a change to that wiring has a shape to be compared against.
 */
describe("what the gate leaves on disk", () => {
  const rows = [{
    case: "safari-normal-chat-light-14", bandPx: 41, toolbarText: "SENTINEL-STRIP-127.0.0.1",
    toolbarTextLength: 24, linesInBand: 0, lines: []
  }];

  const wire = (dir: string, ageMs: () => number | null) => {
    const path = join(dir, observeRevealName(NONCE));
    return {
      path,
      partial: `${path}.partial`,
      gate: createRevealGate(NONCE, {
        heartbeatAgeMs: ageMs,
        write: (contents) => {
          writeFileSync(`${path}.partial`, contents, {mode: 0o600});
          renameSync(`${path}.partial`, path);
        },
        remove: () => {
          for (const victim of [path, `${path}.partial`]) rmSync(victim, {force: true});
        }
      })
    };
  };

  it("leaves nothing on disk once the heartbeat has gone stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-gate-"));
    try {
      let age: number | null = 0;
      const {gate, path, partial} = wire(dir, () => age);

      gate.reveal(rows);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("SENTINEL-STRIP");
      // the file the owner alone may read
      expect(statSync(path).mode & 0o777).toBe(0o600);

      age = REVEAL_HEARTBEAT_MAX_AGE_MS + 1;
      gate.reveal(rows);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(partial)).toBe(false);

      // and it never comes back, whatever the heartbeat does afterwards
      age = 0;
      gate.reveal(rows);
      gate.end();
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /** A half-written file left by an interrupted write goes with it (review, Minor 3). */
  it("takes the half-written sibling with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-gate-"));
    try {
      const {gate, partial} = wire(dir, () => REVEAL_HEARTBEAT_MAX_AGE_MS + 1);
      writeFileSync(partial, "SENTINEL-STRIP-half-written");
      gate.reveal(rows);
      expect(existsSync(partial)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  /** And a run whose terminal is still there leaves exactly one file, for that terminal to claim. */
  it("leaves the file for a terminal that is still beating", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-gate-"));
    try {
      const {gate, path} = wire(dir, () => 0);
      gate.reveal(rows);
      gate.end();
      expect(existsSync(path)).toBe(true);
      expect(readdirSync(dir)).toEqual([observeRevealName(NONCE)]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

/**
 * Review Minor B, re-review: the mode is asserted on a file the PRODUCTION function wrote.
 *
 * The old arrangement asserted it on a file the test itself wrote with a mode it itself passed, and
 * the constant was pinned only by its declaration — so dropping it from the real call site left
 * every test green. `writeRevealFile` chooses the mode, and the only thing the test supplies is
 * `node:fs`.
 */
describe("how the reveal file is written", () => {
  const withDir = (body: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-mode-"));
    try { body(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
  };
  const realIo = {writeFile: writeFileSync, rename: renameSync};

  it("is readable by the owner and by nobody else", () => {
    withDir((dir) => {
      const path = join(dir, observeRevealName(NONCE));
      writeRevealFile(path, "SENTINEL-STRIP", realIo);
      expect(REVEAL_FILE_MODE).toBe(0o600);
      expect(statSync(path).mode & 0o777).toBe(REVEAL_FILE_MODE);
      expect(readFileSync(path, "utf8")).toBe("SENTINEL-STRIP");
    });
  });

  /** Atomically, through the `.partial` name every cleanup list knows. */
  it("renames its half-written sibling into place and leaves nothing beside it", () => {
    withDir((dir) => {
      const path = join(dir, observeRevealName(NONCE));
      writeRevealFile(path, "SENTINEL-STRIP", realIo);
      expect(readdirSync(dir)).toEqual([observeRevealName(NONCE)]);
      expect(existsSync(`${path}${REVEAL_PARTIAL_SUFFIX}`)).toBe(false);
    });
  });

  it("writes the temporary file first and the final name second", () => {
    const order: string[] = [];
    writeRevealFile("/out/r.json", "x", {
      writeFile: (path, _contents, options) => { order.push(`write ${path} ${options.mode.toString(8)}`); },
      rename: (from, to) => { order.push(`rename ${from} ${to}`); }
    });
    expect(order).toEqual([
      `write /out/r.json${REVEAL_PARTIAL_SUFFIX} 600`,
      `rename /out/r.json${REVEAL_PARTIAL_SUFFIX} /out/r.json`
    ]);
  });
});

/** Re-review, Minor A: `.claimed` is a name this run's strips can be under, so it is in the list. */
describe("every name the strips can be on disk under", () => {
  it("is the file, its half-written sibling and the terminal's claimed copy", () => {
    expect(revealFileNames(NONCE)).toEqual([
      "observe-reveal-abc123.json",
      "observe-reveal-abc123.json.partial",
      "observe-reveal-abc123.json.claimed"
    ]);
    expect(REVEAL_PARTIAL_SUFFIX).toBe(".partial");
    expect(REVEAL_CLAIMED_SUFFIX).toBe(".claimed");
    // and all three are swept by the one prefix the orphan sweep uses
    for (const name of revealFileNames(NONCE)) expect(name.startsWith("observe-reveal-")).toBe(true);
  });

  /** The gate's `remove` is handed these names, so a stale heartbeat takes all three off the disk. */
  it("is what the gate removes when the terminal is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "clave-eval-claimed-"));
    try {
      for (const name of revealFileNames(NONCE)) writeFileSync(join(dir, name), "SENTINEL-STRIP");
      const gate = createRevealGate(NONCE, {
        heartbeatAgeMs: () => REVEAL_HEARTBEAT_MAX_AGE_MS + 1,
        write: () => { throw new Error("must not write"); },
        remove: () => {
          for (const name of revealFileNames(NONCE)) rmSync(join(dir, name), {force: true});
        }
      });
      gate.reveal([]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
