const SITE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const HOST = /(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[:/\s]|$)/g;

export function parseSites(raw: unknown): {sites: string[]; problems: string[]} {
  if (!Array.isArray(raw)) return {sites: [], problems: ["excluded sites must be a list"]};
  const sites: string[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") { problems.push(`site ${index + 1} is not text`); return; }
    const site = entry.trim().toLowerCase();
    if (!site) return;
    if (!SITE.test(site)) { problems.push(`site ${index + 1} is not a hostname`); return; }
    sites.push(site);
  });
  return {sites, problems};
}

export function extractHosts(toolbarText: string): string[] {
  const hosts = new Set<string>();
  for (const match of toolbarText.toLowerCase().matchAll(HOST)) if (match[1]) hosts.add(match[1]);
  return [...hosts];
}

/**
 * How much of a toolbar strip is ever looked at. The MEASURED sizes, corrected 2026-09-21 after the
 * re-review found the first set of numbers flattering: Chrome's strips are 130-148 characters (44
 * reads at `bandPx: 82`, single staged tab); Safari's are 15-26 for a normal window and 50-102 for a
 * private one (`readerEval/score.ts`, and the recorded runs). So the headroom here is about 14x —
 * ONE order of magnitude, not two, and thinner still for a Chrome window with many tabs open. It can
 * only be reached by a reader that is broken or hostile, which is exactly the case the core says it
 * defends against ("A read comes from another process, so a field that should be text may be
 * anything", `core/index.ts`). There is no length cap anywhere earlier on the path:
 * `main/ports/reader.ts` parses `toolbarText` as `z.string().optional()` with no `.max()`.
 * `readerEval/score.ts` writes the same rule down for its own strip scan (it also drops a trailing
 * lone high surrogate, which is not copied here because the answer is a boolean).
 *
 * THERE IS NO LINE CAP, and that is deliberate (re-review N2). A cap of 16 lines kept the FIRST 16,
 * and `toolbar.rs` collects the band top to bottom — in Chrome the omnibox is the BOTTOM row, under
 * the tab strip, so the cap discarded exactly the line the rule needs, first. It was binding at 356
 * characters, nowhere near 2048, and unlike Safari's translate banner a tab count does not go away
 * in five seconds: it silently and permanently stopped reads in a window with enough tabs. It bought
 * nothing either — after the character cap, splitting and scanning ALL lines is linear in 2048
 * characters (measured: a 90 KB colon string, 100 KB of `a` and a 50 000-line strip together, 0.64 ms).
 *
 * `extractHosts` is deliberately NOT capped. It answers "which excluded site is this?", so a cap
 * there could only ever fail OPEN — an excluded site named past the cap would stop being recognised.
 * It is also measured linear: worst seen 1.63 ms on 270 KB of input shaped to make it backtrack.
 */
export const STRIP_SCAN_MAX_CHARS = 2048;

/**
 * Words a browser draws on the address ROW, before the address itself. A CLOSED list: Chrome renders
 * the omnibox of a non-trustworthy http origin as `Not secure | host/path`, and that label is TEXT,
 * so without this every `http://192.168.x.x`, `http://wiki` and `http://jira` read was dropped —
 * exactly the population the single-label rule was added to serve. Chrome treats `localhost` and
 * `*.localhost` as trustworthy, so the headline `localhost:3000` case never showed it; Safari does
 * not show it for plain http at all.
 *
 * Measured and ruled on 2026-09-21. Nothing generic belongs here — not "Secure", not "File", not
 * "View site information". A word admitted here is a word that can stand in front of anything and
 * still leave the line an address line, so ADDING ONE IS A MEASURED, OWNER-VISIBLE CHANGE: it needs
 * a real rendering behind it, not a guess, and it changes what the privacy rule keeps. Matched
 * whole-word, so "cannot secure …" and "Not securely …" are not labels.
 *
 * THE LIST IS ENGLISH-ONLY, and that is a known limit, not an oversight. "Not secure" is the string
 * Chrome draws in an ENGLISH UI; a Chrome running in another language draws another string, and on
 * that machine this rule does nothing — the whole http LAN and intranet class (`http://192.168.x.x`
 * routers, NAS boxes, printers, `http://wiki`, `http://jira`, `http://grafana`) stays unread for as
 * long as the user is on it. That is fail-closed, so it costs reads and not privacy. It is NOT
 * cured by guessing translations: the cure is to MEASURE the label in that Chrome's own UI language
 * and add the exact string, which is why the tests pin the obvious guesses as NOT recognised. This
 * matters here in particular because the owner's own system language is probably not English.
 */
export const BROWSER_ADDRESS_LABELS: readonly string[] = ["not secure"];

/** At most 2 leading glyph tokens + 1 address token + 3 trailing glyph tokens. */
const LEADING_GLYPHS_MAX = 2;
const LEADING_GLYPH_CHARS_MAX = 2;
const TRAILING_GLYPHS_MAX = 3;
const TRAILING_GLYPH_CHARS_MAX = 3;
const LABEL_WORDS_MAX = Math.max(...BROWSER_ADDRESS_LABELS.map((label) => label.split(" ").length));
const TOKENS_MAX = LEADING_GLYPHS_MAX + LABEL_WORDS_MAX + 1 + TRAILING_GLYPHS_MAX;

/**
 * Every pattern here is LINEAR and every one is anchored at the start of a single token.
 *
 * The version this replaces had `\[[0-9a-f.:]*:[0-9a-f.:]*:[0-9a-f.:]*\]` — three greedy runs over
 * one character class ending in a literal `]`. When the `]` never comes the engine enumerates every
 * way to split the run into three, which is cubic: measured on this machine 1.23 s at 1.6 KB, 8.6 s
 * at 3.2 KB, and 3.4 s on a 90 KB string built from ordinary 300-character runs. One bounded greedy
 * run plus one literal is linear (0.10 ms on the 6.4 KB case), and the colon count moves to JS.
 */
/**
 * The glyph run the recogniser glues to the front of the token (`•github.com`, `(github.com)`), and
 * the punctuation it leaves on the end. Both classes exclude EVERY letter and digit, not just the
 * ASCII ones: they used to be `[^0-9a-z]`, so a non-Latin letter stuck to the token counted as
 * punctuation and `<CJK>github.com` was an address line while its spaced twin was not (review P4).
 * `[` is excluded in front because a bracketed IPv6 literal starts with one.
 *
 * The round-2 review's third behaviour-neutral survivor was a `(?=[\p{L}\p{N}[])` lookahead here.
 * It is DELETED, and the reason an earlier version of this comment gave for that is no longer true
 * of this file. It was measured BEFORE the hyphen rule below existed: a `DOMAIN` label could then
 * start with a hyphen, so with the lookahead `--.github.com` was left whole and matched `DOMAIN`.
 * With labels unable to start with a hyphen the lookahead is answer-neutral - every host pattern
 * needs a letter, a digit or `[` first, so whichever way the run is stripped a token that still
 * starts with punctuation matches nothing; re-review 3 measured 0 differences over 600 000 inputs
 * and `--.github.com` is refused with or without it. It stays deleted because it buys nothing.
 */
const GLYPHS_IN_FRONT = /^[^\p{L}\p{N}[]{1,2}/u;
const SCHEME = /^https?:\/\//i;
/**
 * A DNS label may not begin or end with a hyphen (RFC 1123), and saying so here is not pedantry: a
 * hyphen is a legal host CHARACTER, so a glued run of them sailed past the glyph bound and into the
 * host grammar — `---github.com` and `--.github.com` were address lines. Refusing it costs nothing
 * real (every host in the true table is unaffected, `xn--80ak6aa92e.com` included, because the rule
 * is about the label's ends and not its middle).
 */
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/i;
const LOCALHOST_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*localhost/i;
const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}/;
/**
 * 45 characters is the longest real IPv6 literal, so this is a SEMANTIC bound — it is what stops a
 * 60-colon run or a 12-group hex literal counting as an address. It is NOT what makes the pattern
 * linear: one bounded greedy run over a character class followed by a single literal is linear at
 * any bound, including none. An earlier comment credited it with the ReDoS fix, which it does not do.
 */
const BRACKETED = /^\[[0-9a-f.:]{0,45}\]/i;
/**
 * A single label must carry a LETTER, or "09" in "09:12" would be a host with a port; and, like any
 * other label, it may not begin or end with a hyphen (see `DOMAIN`), or `-wiki/` would be one.
 */
const SINGLE_LABEL = /^(?=[a-z0-9-]{2,})(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/i;
/**
 * Optional `:port`, optional path/query/fragment, then up to three closing marks. A port is one to
 * five digits and the FIRST IS NOT A ZERO: a browser never draws a zero-padded port, and `[0-9]{1,5}`
 * accepted `:080` and `:00080` (re-review 3, F3). The pattern is written out in both tails.
 */
const TAIL = /^(?::([1-9][0-9]{0,4}))?(?:[/?#]\S*)?[^\p{L}\p{N}]{0,3}$/u;
/** The same, but the port or the path is compulsory — what turns `wiki` into `wiki/`. */
const TAIL_REQUIRED = /^(?::([1-9][0-9]{0,4})(?:[/?#]\S*)?|[/?#]\S*)[^\p{L}\p{N}]{0,3}$/u;

/** `[::1]` is two colons; a clock with seconds, `[09:12:33]`, is also two — so `::` or three. */
const bracketedIsIpv6 = (literal: string) =>
  literal.includes("::") || literal.split(":").length - 1 >= 3;

/**
 * A digit COUNT is not a range. Without this `localhost:0` and `localhost:99999` were address lines
 * although neither names a reachable port — and, through the single-label rule, so were `ab:0` and
 * `Q3:0`. The tail patterns capture the port so the range can be checked where a range belongs.
 *
 * Since the port pattern became `[1-9][0-9]{0,4}` the two overlap on purpose: port 0 no longer
 * parses at all, so the LOWER bound here is belt and braces, while the UPPER bound is still the only
 * thing that refuses 65536-99999. In the other direction the upper bound makes the pattern's
 * five-digit limit redundant (a sixth digit after a non-zero first one is already over 65535). Both
 * are kept: the range is the statement of intent, and neither may be dropped for the other.
 */
const PORT_MIN = 1;
const PORT_MAX = 65535;
function tailFits(rest: string, pattern: RegExp): boolean {
  const match = pattern.exec(rest);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const port = Number(match[1]);
  return port >= PORT_MIN && port <= PORT_MAX;
}

/**
 * One token of a line, with the recogniser's glued-on glyphs (`•github.com`, `(github.com)`) and an
 * `http(s)://` scheme taken off the front first. `chrome://` and `file://` are NOT schemes here:
 * the strip is showing a web page's address or it is showing something else, and a `chrome://`
 * page has no host to check against the excluded-site list, which is the whole point of the rule.
 */
function isAddressToken(raw: string): boolean {
  const token = raw.replace(GLYPHS_IN_FRONT, "").replace(SCHEME, "");
  for (const host of [DOMAIN, LOCALHOST_HOST, IPV4, BRACKETED]) {
    const match = host.exec(token);
    if (!match) continue;
    if (host === BRACKETED && !bracketedIsIpv6(match[0])) continue;
    if (tailFits(token.slice(match[0].length), TAIL)) return true;
  }
  // I2: a single-label host — `wiki/`, `jira/browse/ABC-1`, `intranet:8080` — but never a bare word.
  const label = SINGLE_LABEL.exec(token);
  return label !== null && tailFits(token.slice(label[0].length), TAIL_REQUIRED);
}

/**
 * A glyph is SHORT and it carries no letter and no digit — `@`, `•`, `¡•`, `*`, `-`, `=`, `+`, `…`.
 * Unicode-aware on purpose: the test used to be `/[0-9a-z]/i`, which is ASCII only, so a whole word
 * in a non-Latin script counted as a glyph and `index.html <two CJK characters>` was an address line.
 * The repo already stages non-English pages and the owner's own system language is probably neither
 * English nor Portuguese.
 */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const isGlyph = (token: string, maxChars: number) =>
  token.length <= maxChars && !HAS_LETTER_OR_DIGIT.test(token);

/**
 * How many tokens at `at` are one of the closed list of browser labels, matched whole-word and
 * case-insensitively. Zero when the next tokens are not a label — or when they ARE one but nothing
 * follows, because a bare `Not secure` is a banner, not an address.
 */
function labelWordsAt(tokens: string[], at: number): number {
  for (const label of BROWSER_ADDRESS_LABELS) {
    const words = label.split(" ");
    if (words.every((word, index) => tokens[at + index]?.toLowerCase() === word)) return words.length;
  }
  return 0;
}

/**
 * Is this line, on its own, an address? Up to two leading glyph tokens, then at most one known
 * browser label, then ONE address token, then up to three trailing glyph tokens, and nothing else.
 *
 * The trailing tokens are held to the SAME test as the leading ones, and that is the re-review's
 * finding N1: they used to be length-checked only, so an address-like token followed by up to three
 * short WORDS was an address line, and English is full of three-letter words. Every row of the old
 * false table was saved only by its trailing word happening to be four characters or longer —
 * `Node.js API`, `main.py fix`, `github.com PR` and `site.com a b c` all passed. An earlier version
 * of this comment claimed "a word is longer than three characters or sits where no glyph can",
 * which was simply not true; the property the rule actually needs is letterless AND digitless.
 */
function lineIsAddress(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter((token) => token.length > 0);
  // `tokens.length > TOKENS_MAX` is an EARLY-OUT with no effect on the answer: `TOKENS_MAX` is
  // derived as exactly the longest line the four checks below already admit, so anything it rejects
  // they would reject too. It is kept because it stops a thousand-token line being walked at all,
  // and derived rather than hard-coded so it cannot drift away from those four. Removing it changes
  // no answer (proven by a 28-row differential probe in the round-2 review, mutation X4).
  if (tokens.length === 0 || tokens.length > TOKENS_MAX) return false;
  let at = 0;
  while (at < tokens.length && isGlyph(tokens[at] as string, LEADING_GLYPH_CHARS_MAX)) at++;
  // `at === tokens.length` here — an all-glyph line — is likewise redundant rather than load-bearing:
  // `labelWordsAt` returns 0 when `tokens[at]` is undefined, so the identical check two lines down
  // catches it. Kept for legibility, and named here so nobody has to re-derive it (mutation X14).
  if (at > LEADING_GLYPHS_MAX || at === tokens.length) return false;
  at += labelWordsAt(tokens, at);
  if (at === tokens.length) return false;
  if (!isAddressToken(tokens[at] as string)) return false;
  const trailing = tokens.slice(at + 1);
  return trailing.length <= TRAILING_GLYPHS_MAX
    && trailing.every((token) => isGlyph(token, TRAILING_GLYPH_CHARS_MAX));
}

/**
 * Does the toolbar strip show an address? Owner decision O8 (2026-09-21): a read from a measured
 * browser whose strip shows NO address is not kept, because an excluded site is recognised by its
 * host on that strip and a strip without one cannot be checked against the list. Measured that day:
 * on a page Safari offers to translate, the address field shows "Translation Available" in place of
 * the host for the first seconds after the load, and the whole recognised strip was that message
 * plus a glyph — so an excluded site opened in that window would have been kept.
 *
 * THE QUESTION IS ASKED PER LINE, and that is the correction the review of 2026-09-21 forced (C1).
 * The strip is not the address field: `native/reader/src/toolbar.rs` joins EVERY recognised line
 * whose bottom edge falls inside the band, and the band is the tab strip plus the omnibox in Chrome,
 * and in Safari the compact tab bar drawing the other tabs' titles in the same row as the address —
 * the channel `privateWindows.ts` already documents as a known cost of the neighbouring rule. So
 * "some token somewhere in the strip looks like an address" is satisfied by almost any tab title:
 * `Node.js`, `README.md`, `Release 10.0.0.1 notes`, `localhost setup guide` and `[09:12:33] build ok`
 * all passed it, which made the rule very nearly a no-op on Chrome. Asking per line works because a
 * tab title is prose and an address line is one token with at most a few glyphs around it.
 *
 * It is still broader than `extractHosts`, and the two answer different questions. `extractHosts`
 * answers "which excludable site is this?", so it only sees a domain. This answers "is the address
 * field showing an address?", which `localhost:3000`, `myapp.localhost`, `127.0.0.1:8080`, `[::1]`
 * and a single-label intranet host like `wiki/` all do although no excluded-site pattern could ever
 * match them — an excluded site is a domain, and a loopback, LAN or single-label page has no "site"
 * to exclude. The target users are developers who spend the day on `localhost:3000` and on a company
 * `http://wiki`; defining "no address" as `extractHosts(...).length === 0` would stop reading their
 * own work.
 *
 * THE RESIDUAL HOLE, at its real size. It is a GRAMMAR, not three examples: ANY line that is one
 * token parsing as a host, optionally with a glyph after it. That is
 *  · a dotted file name, because `md`, `py`, `sh`, `js`, `json`, `toml`, `yml`, `rs`, `css`, `txt`
 *    and `out` all look like a TLD to the domain rule — `Node.js`, `README.md`, `package.json`,
 *    `docker-compose.yml`, `a.out`, `Dr.Who`;
 *  · a slashed word, which the single-label rule reads as a host with a path — `TCP/IP`, `and/or`,
 *    `km/h`, `CI/CD`;
 *  · and — THE COMMON CASE, which an earlier version of this comment understated — a TRUNCATED tab
 *    title. A browser cuts a tab title to the tab's width and the mark it leaves is letterless, so
 *    `README.md …`, `Node.js …`, `index.html …` land in exactly the address-line shape and survive
 *    the letter check. With several tabs open that is the normal rendering, not an edge case.
 * One or two punctuation marks glued to the front of such a token do not take it out of the hole,
 * hyphens included: `-github.com` and `--github.com` are address lines because the run is stripped
 * as a glued icon glyph, and only the third hyphen (`---github.com`) is refused - accepted as is by
 * the owner's ruling on re-review 3, F7.
 * All of this is because the core is handed the whole band as one blob of lines with the per-line
 * geometry already thrown away. Closing it needs the reader to hand the core the address ROW
 * (`toolbar.rs` still has `top`/`bottom`/`x`/`right` at the point of the join); that is a
 * sub-project C change, recorded as a design item and deliberately not done here. A `describe` block
 * is named after this hole, and pins its edge as well as its extent, so it cannot pass for a pass.
 *
 * Known cost of answering false, accepted by the owner: a Chrome page with nothing in the address
 * field is not kept — `chrome://…` pages, a New Tab whose field is empty, and a `file:///` path.
 * For those the cost is bounded, because the field fills in again. It is NOT bounded for everything:
 * a label Chrome keeps on the row for as long as the page is open (see `BROWSER_ADDRESS_LABELS`) is
 * permanent, so "the loop will read again in five seconds" is no consolation there at all — which is
 * why the known labels are allowed in front of the address rather than waited out.
 */
export function showsAddress(toolbarText: string): boolean {
  const lines = toolbarText.slice(0, STRIP_SCAN_MAX_CHARS).split("\n");
  // The character cap can cut the last line in half, and half a line can look like a whole address:
  // `example.com and more prose` cut after `example.com` is an address line although the real line
  // is not. So a half line is not asked — unless the strip really ended there, or the cap happened
  // to fall exactly on the newline, in which cases the last line is whole.
  if (toolbarText.length > STRIP_SCAN_MAX_CHARS && toolbarText[STRIP_SCAN_MAX_CHARS] !== "\n") lines.pop();
  return lines.some(lineIsAddress);
}

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.includes(".")) return host === pattern || host.endsWith("." + pattern);
  return host.split(".").includes(pattern);
}

function titleMentions(title: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(title);
}

/** Either signal is enough. Without an exact address we stay cautious. */
export function siteExcluded(sites: string[], title: string, toolbarText: string | undefined): boolean {
  const hosts = extractHosts(toolbarText ?? "");
  return sites.some((site) => hosts.some((host) => hostMatches(host, site)) || titleMentions(title, site));
}
