import {describe, expect, it} from "vitest";
import {BROWSER_ADDRESS_LABELS, extractHosts, hostMatches, parseSites, showsAddress, siteExcluded, STRIP_SCAN_MAX_CHARS} from "./sites";

/**
 * Non-Latin sample text for the glyph tests, by code point so that nothing in the tool chain can
 * quietly rewrite it: two CJK characters, three Arabic letters, two Sinhala letters.
 */
const CJK = String.fromCodePoint(0x4e2d, 0x6587);
const ARABIC = String.fromCodePoint(0x0627, 0x0644, 0x0639);
const SINHALA = String.fromCodePoint(0x0d95, 0x0daf);

describe("parseSites", () => {
  it("lowercases and accepts hostnames and bare labels", () => {
    expect(parseSites(["PayPal.com", " chase "])).toEqual({sites: ["paypal.com", "chase"], problems: []});
  });
  it("rejects anything that is not a hostname or label", () => {
    expect(parseSites(["https://paypal.com"]).problems.length).toBe(1);
    expect(parseSites(["pay pal"]).problems.length).toBe(1);
    expect(parseSites("paypal.com").problems.length).toBe(1);
  });
});

describe("extractHosts", () => {
  it("pulls hostnames out of recognised toolbar text", () => {
    expect(extractHosts("https://online.chase.com/accounts/summary")).toEqual(["online.chase.com"]);
    expect(extractHosts("github.com/acme/api   localhost:3000")).toEqual(["github.com"]);
  });
  it("returns nothing for text without a hostname", () => {
    expect(extractHosts("Search or enter address")).toEqual([]);
  });
});

describe("hostMatches", () => {
  it("matches a domain exactly or on a dot boundary", () => {
    expect(hostMatches("paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("www.paypal.com", "paypal.com")).toBe(true);
    expect(hostMatches("notpaypal.com", "paypal.com")).toBe(false);
  });
  it("matches a bare label against any domain label", () => {
    expect(hostMatches("online.chase.com", "chase")).toBe(true);
    expect(hostMatches("chase.co.uk", "chase")).toBe(true);
    expect(hostMatches("purchase.com", "chase")).toBe(false);
  });
});

/**
 * O8 (2026-09-21), as corrected by the review of 2026-09-21 (C1, C2, I2, I3).
 *
 * The question is asked PER LINE, because the strip is the whole toolbar BAND, tab titles included
 * (`native/reader/src/toolbar.rs` joins every recognised line in the band with "\n"). "Some token
 * somewhere in the strip looks like an address" is satisfied by almost any tab title and is not
 * fail closed — the review's probe `"Translation Available\nNode.js docs"` was KEPT under the first
 * version of this rule, which is the very scenario O8 was decided on.
 */
describe("showsAddress: a line that IS an address", () => {
  it.each([
    // Measured renderings. The leading glyphs are the recogniser's version of the field's icons.
    "@ 127.0.0.1",
    "• 127.0.0.1",
    "@ example.com",
    "¡• github.com",
    "•github.com",
    "app.clave.localhost:8765/chat.html?th...",
    "github.com/acme/...",
    // The real Safari strip, measured 2026-09-21 (session1/ledger.md:118): the glyph run came
    // back as its OWN line beside the address, not appended to it. `toolbarTextLength` was 15,
    // which is exactly this string. Round 1 invented a glued `… C =` case; the measurement
    // contradicted it, so it is gone and this is here instead.
    "@ 127.0.0.1\nC =",
    "github.com/acme/repo +",
    "example.com …",
    // Ordinary addresses.
    "github.com/acme/repo",
    "https://www.paypal.com/signin",
    "192.168.1.20:8080",
    "0.0.0.0:3000",
    "127.0.0.1:8000/docs",
    "localhost",
    "localhost:3000/dashboard",
    "localhost:5173",
    "http://localhost:3000",
    "myapp.localhost",
    "LOCALHOST:3000",
    "[::1]:8080",
    "[::1]:3000",
    "[2001:db8::1]",
    "[fe80::1]:8080",
    "http://[2001:db8::1]:8080/health",
    "myapp.test",
    "foo.local",
    "host.docker.internal:8080",
    "db.svc.cluster.local:5432",
    "xn--80ak6aa92e.com",
    // An address line anywhere in the band is enough; here it is the second line.
    "Pull requests\ngithub.com/acme/api/pulls",
    "Translation Available\n@ example.com",
    // M1: a closing mark the recogniser tacked on must not throw the address away.
    "github.com.",
    "github.com,",
    "(github.com)",
    "localhost:3000,",
    // I2: a single-label host, but ONLY with a port or a path.
    "wiki/",
    "jira/browse/ABC-1",
    "intranet:8080",
    "http://wiki/",
    "grafana:3000/d/abc",
    // N3: Chrome draws a PERSISTENT security label before the address of an http origin.
    // It is text on the address row, so a closed list of known labels is allowed in front.
    "Not secure 192.168.1.20",
    "Not secure wiki/",
    "Not Secure example.test/login",
    "NOT SECURE 10.0.0.7:8080",
    "@ Not secure 192.168.1.20"
  ])("sees an address line in %s", (strip) => expect(showsAddress(strip)).toBe(true));
});

describe("showsAddress: a line that is NOT an address", () => {
  // C1's probes. Every one of these was KEPT by the first version of the rule.
  it.each([
    "Translation Available\nNode.js docs",
    "chrome://settings\nNode.js docs",
    "Release 10.0.0.1 notes",
    "Version 1.2.3.4 release notes",
    "Meeting at 10.30.15.20",
    "localhost setup guide",
    "How to run localhost",
    "[09:12:33] build ok",
    "README.md - GitHub",
    "bob@example.com wrote",
    "Mr.Smith replied",
    "we are done.Next up",
    "report.final.pdf attached",
    "Dockerfile.dev changes",
    "main.py failing",
    "config.json diff",
    "ASP.NET Core docs",
    "v2.final review"
  ])("prose is not an address line: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // The banners and glyphs the recogniser really returns in place of an address, and numbers that
  // merely look like one. Any of these counting as an address brings back the defect O8 was decided on.
  it.each([
    "Translation Available",
    "Translation Available ⌄",
    "",
    "   ",
    "Private",
    "• Private",
    "¡• Private",
    "* Incognito",
    "Search or enter address",
    "New Tab",
    "chrome://settings",
    "chrome://settings/searchEngines",
    "file:///Users/sardor/notes.html",
    "file:///Users/sardor/Documents/",
    "42",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "09:12",
    "3.14",
    "e.g.",
    "C =",
    "+",
    "…"
  ])("sees no address line in %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // I3: the two guards the reviewer's surviving mutations exposed. Neither had a test.
  it.each(["[09:12]", "[09:12:33]", "[2026-09-21]", "[]", "[abc]"])(
    "a bracketed token is only an address with :: or three colons: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  it.each(["localhosting", "localhostel", "notlocalhost"])(
    "localhost must end where the token ends: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // I2's other half: a bare single word is never a host, whatever it is called.
  it.each(["wiki", "intranet", "jira", "grafana", "Dockerfile"])(
    "a bare single word is not an address: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // The four counting guards on the line shape. Each of these was found by a mutation that the
  // rest of the table let through: a glyph is SHORT as well as letterless, and there are only so
  // many of them. Without the length limit a rule of punctuation is a glyph and anything may
  // follow it; without the count limits a line of prose separators is an address line.
  it.each([
    "=========== github.com",
    "•••• github.com",
    "-------- localhost:3000",
    "<<<<<<<<<<< 127.0.0.1"
  ])("a long run of punctuation is not a leading glyph: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // The same on the other side. A glyph is short AND letterless; dropping either half lets a rule
  // of punctuation stand in for the missing evidence that the address row is what was recognised.
  it.each([
    "github.com ===========",
    "localhost:3000 --------",
    "127.0.0.1 ••••••••",
    "example.com ....."
  ])("a long run of punctuation is not a trailing glyph either: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * P2. Every glyph bound was pinned in its SPACED form and none in its GLUED form — although glued
   * renderings (`•github.com`, `(github.com)`) are the whole reason the glued classes exist. A run
   * stuck to the token goes through `GLYPHS_IN_FRONT` or the tail's punctuation class instead, and
   * those two bounds were the ones no test held.
   */
  it.each([
    "===========github.com",
    ".........github.com",
    "<<<<<<<<<<<127.0.0.1",
    "github.com.........",
    "example.com.............",
    "intranet:80........."
  ])("a glued run of punctuation is bounded too: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * Found while checking P2's glued bounds, and not in any review: a HYPHEN is a legal host
   * character, so a glued run of them slipped past the glyph bound and straight into the host
   * grammar — `---github.com` was an address line. A DNS label may not begin or end with a hyphen
   * (RFC 1123), so refusing that costs nothing real: every host in the true table above is
   * unaffected, which is what makes this safe to tighten rather than merely disclose.
   */
  it.each([
    "---github.com", "--.github.com", "github-.com", "---localhost:3000", "---wiki/", "--_intranet:8080"
  ])("a host label may not begin or end with a hyphen: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // The edge of that fix, so it is not mistaken for more than it is: a run of ONE OR TWO leading
  // punctuation characters is stripped as a glued icon glyph first (the `•github.com` mechanism), so
  // `-github.com` is an address line and only what survives the strip is held to the label rule.
  it.each(["-github.com", "--github.com", "-wiki/", "--intranet:8080"])(
    "but one or two leading marks are still a glued glyph: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  /**
   * P3. Three numeric bounds no test held, and one range check that did not exist at all. A port is
   * 1-65535: a digit COUNT is not a range, so `localhost:0` and `localhost:99999` used to be address
   * lines although neither is a reachable port — which also made `ab:0` and `Q3:0` address lines.
   */
  it.each([
    "localhost:0", "localhost:65536", "localhost:99999", "localhost:123456",
    "intranet:0", "intranet:123456", "ab:0", "Q3:0", "127.0.0.1:0", "example.com:70000"
  ])("a port outside 1-65535 is not a port: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  it.each(["localhost:1", "localhost:65535", "intranet:8080", "127.0.0.1:1", "example.com:65535"])(
    "and a port inside the range still is: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  // The digit COUNT and the RANGE are two different guards and each needs its own row: the range
  // check subsumes the count for everything except a padded port, where they disagree. A browser
  // never renders `:000080`, so refusing it is the fail-closed reading — and without this row the
  // `{1,5}` bound could be deleted in silence, which is how the last three rounds each lost a guard.
  it.each(["localhost:000080", "intranet:000080", "127.0.0.1:000080"])(
    "a padded port is not a port: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  // The 45-character bound on the bracketed literal. It is a SEMANTIC bound, not a ReDoS one.
  it.each([
    "[" + ":".repeat(60) + "]",
    "[" + Array.from({length: 12}, () => "aaaa").join(":") + "]"
  ])("a bracketed literal longer than a real one is not an address: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  it.each(["@ • * github.com", "- - - localhost:3000", "@ • * • github.com"])(
    "at most two glyph tokens may come before the address: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  it.each(["github.com - - - -", "localhost:3000 = = = =", "example.com + … - ="])(
    "at most three glyph tokens may follow the address: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * N1, the re-review's fail-open. A trailing token was only MEASURED, never letter-checked, so an
   * address-like token followed by up to three short WORDS was an address line — and English is full
   * of three-letter words. Every row of the round-1 false table was saved only by its trailing word
   * happening to be four characters or longer; shorten it and the row passed. A trailing token must
   * now be letterless and digitless, exactly like a leading one.
   */
  it.each([
    "README.md doc", "Node.js API", "Node.js API v2", "main.py fix", "index.html new",
    "github.com PR", "localhost:3000 up", "app.py old", "Cargo.toml dep", "wiki/ new",
    "Mr.Smith re", "v2.final rev", "ASP.NET 8", "asp.net 8 doc", "Dockerfile.dev fix",
    "example.com is up", "github.com the fix", "site.com a b c", "foo.bar baz qux",
    "10.30.15.20 lab", "TCP/IP 101", "report.final.pdf v2"
  ])("a short WORD after the address is not a glyph: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * The same omission had a second face: the old test was `/[0-9a-z]/i`, which is ASCII only, so in
   * a non-Latin script a whole word counted as a glyph. The repo already stages non-English pages,
   * and the owner's own system language is probably neither English nor Portuguese.
   *
   * Built from code points, never typed: a literal here would be unreadable in a diff and is exactly
   * the kind of character a recogniser or an editor can silently change.
   */
  it.each([
    `index.html ${CJK}`, `README.md ${CJK}`, `${CJK} github.com`,
    `github.com ${ARABIC}`, `${SINHALA} github.com`,
    // P4: the same must hold GLUED to the token, where the leading and trailing character classes
    // used to be ASCII-only, so a non-Latin letter counted as punctuation and the line passed.
    `${CJK}github.com`, `github.com${CJK}`, `README.md${ARABIC}`, `${SINHALA}127.0.0.1`
  ])("a word in a non-Latin script is not a glyph, spaced or glued: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * N3's closed list is CLOSED. Only the labels a browser really draws on the address row are
   * allowed, only immediately before the address token, and never on their own.
   */
  it.each([
    "Not secure",
    "Not Secure",
    "@ Not secure",
    "Very not secure example.com",
    "Secure github.com",
    "Info github.com",
    "Dangerous example.test",
    "File github.com",
    "View site information github.com",
    "Reader Available 127.0.0.1",
    "127.0.0.1 Reader Available",
    "Not secure Not secure example.com",
    // KNOWN COST, and the one thing that may make N3's fix ineffective in practice: if the
    // recogniser returns Chrome's separator glued between the label and the address, this shape is
    // what arrives, and it is NOT an address line. The C-2b observe run has to settle it; widening
    // the rule to cover it was not authorised and is not guessed at here.
    "Not secure | example.test/login"
  ])("the label list is closed and never stands alone: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * P1. The label is matched WHOLE-WORD, and until this round that half was asserted only in a
   * comment: changing the `===` in `labelWordsAt` to `.includes` left the whole suite green while
   * every row below became an address line. This is the one rule in the file that by design lets
   * words stand in front of an address, so a substring match there is a free pass for any word
   * containing "not" followed by any word containing "secure".
   */
  it.each([
    "cannot secure github.com",
    "Not securely github.com",
    "notsecure secure github.com",
    "notsecure github.com",
    "cannot securely 192.168.1.20"
  ])("the label matches whole words only: %s", (strip) => expect(showsAddress(strip)).toBe(false));

  /**
   * P6, A KNOWN LIMIT rather than a bug. `not secure` is the string Chrome draws in an ENGLISH UI.
   * On a Chrome running in another language the label is another string, so this whole class — the
   * http LAN and intranet pages N3 was raised for — stays unread. The cure is to MEASURE that
   * Chrome's label and add it; it is deliberately not guessed at here, which is why these rows are
   * false rather than true. See the doc comment on `BROWSER_ADDRESS_LABELS`.
   */
  it.each([
    "Nao seguro 192.168.1.20",
    "No es seguro example.test",
    "Nicht sicher wiki/"
  ])("known limit: a non-English Chrome label is not recognised: %s", (strip) => expect(showsAddress(strip)).toBe(false));
});

/**
 * THE RESIDUAL HOLE, on the record and deliberately not closed here. A tab title that is by itself
 * exactly one address-like token is indistinguishable from the omnibox line, because the core is
 * handed the whole band as one blob of lines. Closing it needs the reader to hand the core the
 * address ROW (`toolbar.rs` has the per-line geometry and throws it away in the join) — a change in
 * sub-project C, recorded as a design item, not done here.
 */
describe("showsAddress: the residual hole (a one-token tab title)", () => {
  // The grammar, not three examples: ANY one-token line that parses as a host. A dotted file name
  // reaches it through the domain rule (`md`, `py`, `sh`, `js`, `json` all look like TLDs to it).
  it.each([
    "Node.js", "README.md", "index.html", "package.json", "tsconfig.json", "Cargo.toml",
    "docker-compose.yml", "webpack.config.js", "app.py", "run.sh", "main.rs", "styles.css",
    "notes.txt", "data.csv", "a.out", "core.dump", "CHANGELOG.md", "foo.bar", "Dr.Who"
  ])("a one-token tab title that parses as a host still counts: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  // Created by I2's single-label rule: an everyday word with a slash in it is a host with a path.
  it.each(["TCP/IP", "and/or", "km/h", "CI/CD", "AC/DC"])(
    "I2's single-label rule also lets a slashed word through: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  /**
   * AND THIS IS THE COMMON CASE, which round 1 understated. A browser truncates a tab title to the
   * tab's width and the trailing mark is letterless — so a truncated tab title lands in EXACTLY the
   * address-line shape (one address-like token + one glyph) and survives N1's letter check. With
   * several tabs open this is the normal rendering, not an edge case.
   */
  it.each([
    "README.md …", "Node.js …", "index.html …", "spec.md …", "notes.txt …", "main.py …",
    "Node.js —", "README.md -", "Node.js ...", "Cargo.toml …"
  ])("a TRUNCATED tab title is the common form of the hole: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  /**
   * P5. The hole grew this round and the growth belongs here, not only in prose: because a label may
   * stand in front of anything that parses as a host, the shape is now an optional `not secure` plus
   * a one-token line. That is the price of N3 and it is on the record.
   */
  it.each([
    "Not secure Node.js", "Not secure README.md", "Not secure and/or", "Not secure TCP/IP",
    "not secure index.html …"
  ])("the label widens the hole by exactly one optional prefix: %s", (strip) => expect(showsAddress(strip)).toBe(true));

  // The correctly-rejected neighbours, so the hole's edge is pinned too and cannot quietly widen.
  it.each(["v1.2.3.4", "a/b", "N/A", "24/7", "I/O", ":8080", "x:1", "w/o", "9/11"])(
    "but a token that does not parse as a host is still refused: %s", (strip) => expect(showsAddress(strip)).toBe(false));
});

/**
 * C2. The old `IPV6` was three greedy runs over one character class ending in a literal `]`: cubic
 * when the `]` never comes. Measured on this machine before the fix: 1.23 s at 1.6 KB, 3.4 s on a
 * 90 KB string built from ordinary 300-character runs. A real toolbar strip is a few dozen
 * characters (Safari's is 15-26), so the input is capped as well as the patterns made linear —
 * the same rule `readerEval/score.ts` already writes down for its own strip scan.
 */
describe("showsAddress: bounded input and linear patterns", () => {
  it("reads no more than the first STRIP_SCAN_MAX_CHARS characters", () => {
    expect(showsAddress("github.com/")).toBe(true);
    // The address begins one character past the cap, so it is never looked at.
    expect(showsAddress("x".repeat(STRIP_SCAN_MAX_CHARS) + "\ngithub.com/")).toBe(false);
    expect(showsAddress("x".repeat(STRIP_SCAN_MAX_CHARS - 40) + "\ngithub.com/")).toBe(true);
  });

  /**
   * N2. There is NO line cap. `split("\n", 16)` kept the FIRST 16 lines, and `toolbar.rs` collects
   * the band top to bottom — in Chrome the omnibox is the BOTTOM row, under the tab strip. So the
   * cap discarded exactly the line the rule needs, first, and it was binding at 356 characters when
   * the character cap is 2048. Unlike Safari's translate banner a tab count does not go away in five
   * seconds, so it was silent and permanent for that window.
   */
  it.each([14, 16, 20, 40, 100])("reads the omnibox line under %i lines of tab titles", (tabs) => {
    const band = "Some tab title\n".repeat(tabs) + "app.clave.localhost:8765/chat.html?theme=light";
    expect(band.length).toBeLessThan(STRIP_SCAN_MAX_CHARS);
    expect(showsAddress(band)).toBe(true);
  });

  // The character cap is the only bound left, and this is its honest cost: a band longer than it
  // loses its bottom row, which in Chrome is the address. 2048 characters is about 14x the measured
  // 130-148, so it takes a band an order of magnitude past anything recorded. Fail closed.
  it("a band past the character cap does lose its last line, and that is the cost", () => {
    const band = "Some tab title\n".repeat(200) + "app.clave.localhost:8765/chat.html?theme=light";
    expect(band.length).toBeGreaterThan(STRIP_SCAN_MAX_CHARS);
    expect(showsAddress(band)).toBe(false);
  });

  /**
   * The character cap can cut the LAST line in half, and half a line can look like a whole address:
   * `example.com and more prose` cut after `example.com` is an address line although the real line
   * is not. A truncated final line is therefore ignored — unless the strip really ended there.
   */
  it("ignores a final line the character cap cut in half", () => {
    const head = "x".repeat(STRIP_SCAN_MAX_CHARS - 12);
    expect(showsAddress(head + "\nexample.com and more prose")).toBe(false);
    expect(showsAddress(head + "\nexample.com")).toBe(true);           // the strip ended there
    expect(showsAddress(head + "\nexample.com\nmore prose")).toBe(true); // cut exactly on the newline
  });

  // A structural bound first (above), and a wall clock only as a backstop. 50 ms is ~25x the real
  // cost of the whole table above, so it cannot flake, and the pre-fix code needed 1.2 s on row 1.
  it("keeps the label list closed, so widening it is a visible edit", () => {
    expect(BROWSER_ADDRESS_LABELS).toEqual(["not secure"]);
  });

  it("cannot be made slow by a strip that is not a strip", () => {
    const adversarial = [
      "[" + ":".repeat(1600),
      "[" + ":".repeat(6400),
      ("[" + ":".repeat(300)).repeat(300),
      "[" + "a:".repeat(800),
      "a".repeat(100_000),
      "a.".repeat(50_000),
      ("ab.cd " as string).repeat(17_000)
    ];
    const started = Date.now();
    for (const strip of adversarial) showsAddress(strip);
    expect(Date.now() - started).toBeLessThan(50);
    expect(showsAddress("[" + ":".repeat(6400))).toBe(false);
  });

  // `extractHosts` is measured linear (under 3 ms on 100 KB) and is deliberately NOT capped: an
  // excluded site named past the cap must still be recognised, so a cap there could only fail OPEN.
  it("leaves extractHosts uncapped, and it stays linear", () => {
    const started = Date.now();
    expect(extractHosts("a".repeat(100_000))).toEqual([]);
    expect(extractHosts("a.".repeat(50_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(50);
    expect(extractHosts("x".repeat(STRIP_SCAN_MAX_CHARS * 2) + " paypal.com")).toEqual(["paypal.com"]);
  });
});

describe("siteExcluded", () => {
  const sites = ["paypal.com", "chase"];
  it("drops on the toolbar host", () => {
    expect(siteExcluded(sites, "Summary", "https://www.paypal.com/myaccount")).toBe(true);
  });
  it("drops on the title when the toolbar gave nothing", () => {
    expect(siteExcluded(sites, "Chase Online - Accounts", undefined)).toBe(true);
    expect(siteExcluded(sites, "PayPal.com: Wallet", "")).toBe(true);
  });
  it("does not drop on a substring of another word", () => {
    expect(siteExcluded(sites, "Purchase order 12 - Docs", "docs.google.com/document/d/1")).toBe(false);
  });
});
