/**
 * The page server, against a real loopback server. No window is opened and nothing is captured: this
 * is an HTTP request to a port this test started and closes again.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {TruthName} from "./cases";
import {createServer} from "node:http";
import {STAGED_TITLE_MAX, TOOLBAR_CASES, stagedTitleOf} from "./cases";

/** One real toolbar case, the one whose host reads as a place a person would mind being read. */
const TOOLBAR_CASE = TOOLBAR_CASES.find((entry) => entry.host === "mybank.example.localhost") as (typeof TOOLBAR_CASES)[number];
import {PAGE_SERVER_REFUSAL, PAGE_SERVER_TRIES, createPageServer, pageOf, rowsOf, type PageServer} from "./server";
import {pageUrl} from "./stage";
import {FALLBACK_TITLE} from "./pages";
import {STAGED_TITLE_PREFIX, stagedTitleFor} from "./stagedTitle";

const TRUTH: Record<TruthName, string> = {
  chat: "Marta Oliveira 09:12\nMorning team.\n",
  ticket: "PLAT-2841 Retry queue\n",
  code: "const a = 1;\n",
  pt: "Reuniao de revisao\n",
  terminal: "$ pnpm test\n"
};

let server: PageServer;
const get = async (path: string): Promise<{status: number; body: string}> => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
  return {status: response.status, body: await response.text()};
};

/** Exactly the titles this "run" could mint; the counter map takes no other key. */
const SEEDED = [stagedTitleFor("a00", "abc123"), stagedTitleOf(TOOLBAR_CASE.name, "38f0f465d288")];

beforeAll(async () => { server = await createPageServer(TRUTH, SEEDED); });
afterAll(() => { server.close(); });

describe("which page a request asks for", () => {
  it.each(["/chat.html", "/ticket.html", "/code.html", "/pt.html"])("%s is a staged page", (path) => {
    expect(pageOf(path)).not.toBeNull();
  });

  it.each(["/", "/terminal.html", "/../../etc/passwd", "/chat", "/chat.html.html", "/CHAT.html"])(
    "%s is not", (path) => { expect(pageOf(path)).toBeNull(); }
  );
});

describe("the truth as page rows", () => {
  it("drops the trailing blank line the file ends with", () => {
    expect(rowsOf("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps every other line, in order", () => {
    expect(rowsOf("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });
});

describe("what the server answers", () => {
  it("serves a staged page with its truth between the markers", async () => {
    const {status, body} = await get("/chat.html?theme=light&size=14");
    expect(status).toBe(200);
    expect(body).toContain("STARTMARKER");
    expect(body).toContain("Morning team.");
    expect(body).toContain("ENDMARKER");
  });

  it("carries a staged title through to the page", async () => {
    const title = stagedTitleFor("chat-light-14", "abc123");
    const {body} = await get(`/chat.html?stagedTitle=${encodeURIComponent(title)}`);
    expect(body).toContain(`<title>${title}</title>`);
  });

  it("refuses to call itself anything but one of ours", async () => {
    const {body} = await get(`/chat.html?stagedTitle=${encodeURIComponent("Inbox (14) - Mail")}`);
    expect(body).toContain("<title>Clave reader evaluation</title>");
    expect(body).not.toContain("Inbox");
  });

  it("serves nothing but the four staged pages", async () => {
    for (const path of ["/", "/index.html", "/terminal.html", "/anything.html"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("listens on the loopback address only, on a port the system picked", () => {
    expect(server.port).toBeGreaterThan(0);
  });
});
/**
 * How a TOOLBAR case reaches this server, which is not how an accuracy case does.
 *
 * The first real toolbar run (nonce 38f0f465d288, 2026-09-21) came back with ALL 40 rows
 * `notStaged` — normal and incognito alike, two staging attempts each, no read at all — while the
 * accuracy mode of the same session was perfect. The one functional difference between the two
 * paths is the URL's HOST: an accuracy case asks for `127.0.0.1` literally, a toolbar case asks for
 * one of four `*.localhost` names. Chromium resolves those itself, and `ResolveLocalHostname`
 * answers with **::1 first** and 127.0.0.1 second — while this server bound the IPv4 address alone.
 * A window showing a connection error carries the host as its title, never the staged one, which is
 * exactly `notStaged` forty times over.
 */
describe("the way a toolbar case reaches the server", () => {
  const toolbarCase = TOOLBAR_CASE;
  const stagedTitle = stagedTitleOf(toolbarCase.name, "38f0f465d288");

  /** The whole URL a toolbar staging passes to Chrome, built by the code that builds it. */
  const url = (port: number): string => pageUrl({
    host: toolbarCase.host, port, page: "chat", theme: "light", sizePx: 14, stagedTitle
  });

  const fetchAt = async (address: string, port: number): Promise<{status: number; body: string}> => {
    const path = new URL(url(port)).pathname + new URL(url(port)).search;
    const host = new URL(url(port)).host;
    const response = await fetch(`http://${address === "::1" ? "[::1]" : address}:${port}${path}`, {
      headers: {Host: host}
    });
    return {status: response.status, body: await response.text()};
  };

  /** Does this machine have an IPv6 loopback at all? Asked rather than assumed. */
  const hasIpv6 = async (): Promise<boolean> => await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => { resolve(false); });
    probe.listen(0, "::1", () => { probe.close(() => { resolve(true); }); });
  });

  it("answers an IPv4 request carrying a toolbar host, with that case's whole title", async () => {
    const {status, body} = await fetchAt("127.0.0.1", server.port);
    expect(status).toBe(200);
    expect(body).toContain(`<title>${stagedTitle}</title>`);
    // and the title is the SHORT one now: the case's id, never its long dotted name, which is what
    // the measurement of 2026-09-21 forced (`cases.ts`, `stagedIdFor`)
    expect(stagedTitle).not.toContain(".");
    expect(stagedTitle).not.toContain(toolbarCase.host);
    expect(stagedTitle.length).toBeLessThanOrEqual(STAGED_TITLE_MAX);
  });

  it("answers the SAME request on the IPv6 loopback, which is where a *.localhost name goes first", async () => {
    if (!await hasIpv6()) return;                       // no IPv6 loopback here: nothing to prove
    expect(server.ipv6).toBe(true);
    const {status, body} = await fetchAt("::1", server.port);
    expect(status).toBe(200);
    expect(body).toContain(`<title>${stagedTitle}</title>`);
  });

  it("counts what it served for that case, and with what status", async () => {
    const before = server.served(stagedTitle);
    await fetchAt("127.0.0.1", server.port);
    const after = server.served(stagedTitle);
    expect(after.count).toBe(before.count + 1);
    expect(after.lastStatus).toBe(200);
    // a case this run never staged has no requests and no status
    expect(server.served(stagedTitleFor("t99", "38f0f465d288"))).toEqual({count: 0, lastStatus: null});
  });

  /**
   * Review D, Important 2 and Important 3. `isStagedTitle` is a prefix test — no nonce, no case
   * name, no length cap — so the map used to take a key from any local process that began a title
   * with `CLAVE-EVAL `, unbounded, for the whole of a twenty-four-minute run. It is now PRE-SEEDED
   * with this run's own titles and takes no other key.
   *
   * This is the proof the old E2 did not give: it reverts nothing about the page's own title (which
   * `pages.test.ts` covers), only the counter's key.
   */
  it("takes no counter key but this run's own, however well a foreign title is dressed", async () => {
    const foreign = [
      `${STAGED_TITLE_PREFIX}not-our-case-1 ffffffffffff`,
      `${STAGED_TITLE_PREFIX}t00 ffffffffffff`,                 // our grammar, another run's nonce
      `${STAGED_TITLE_PREFIX}${"A".repeat(4_000)}`,
      "Inbox (14)"
    ];
    const fallbackBefore = server.served(FALLBACK_TITLE).count;
    for (const title of foreign) {
      await fetch(`http://127.0.0.1:${server.port}/chat.html?stagedTitle=${encodeURIComponent(title)}`);
      // not a key: asking for it answers the empty count, whatever it did to the page
      expect(server.served(title), title.slice(0, 20)).toEqual({count: 0, lastStatus: null});
    }
    // the one that is not ours by the page's own gate is counted under the fixed fallback; the
    // three that pass `isStagedTitle` — prefix only, no nonce, no case, no length cap — are counted
    // NOWHERE, which is the whole point of seeding the map
    expect(server.served(FALLBACK_TITLE).count).toBe(fallbackBefore + 1);
  });
});

/**
 * Review D, Important 1: a run that lost the IPv6 half used to look exactly like a run that never
 * had it. It is now a matched pair or a refusal, and the fact is in the results file.
 */
describe("a matched pair of loopback sockets, or none", () => {
  it("reports that it got both", async () => {
    expect(server.ipv6).toBe(true);
  });

  it("answers on both families at the SAME port", async () => {
    const path = "/chat.html?theme=light&size=14";
    expect((await fetch(`http://127.0.0.1:${server.port}${path}`)).status).toBe(200);
    expect((await fetch(`http://[::1]:${server.port}${path}`)).status).toBe(200);
  });

  it("refuses with a fixed code rather than starting half-bound", () => {
    expect(PAGE_SERVER_REFUSAL).toBe("PAGE_SERVER");
    expect(PAGE_SERVER_TRIES).toBeGreaterThan(1);
  });

  it("closes both sockets when it is closed", async () => {
    const second = await createPageServer(TRUTH, SEEDED);
    second.close();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await expect(fetch(`http://127.0.0.1:${second.port}/chat.html`)).rejects.toThrow();
    await expect(fetch(`http://[::1]:${second.port}/chat.html`)).rejects.toThrow();
  });
});
/** Minor 1 of re-review D: the IPv4 branch is unreachable on this machine, so it is injected. */
describe("a bind that fails", () => {
  const titles = SEEDED;

  it("retries the pair rather than keeping a server with no port", async () => {
    let asked = 0;
    const server = await createPageServer(TRUTH, titles, async (socket, host, port) => {
      asked += 1;
      // the first IPv4 bind fails; everything after it is the real thing
      if (asked === 1 && host === "127.0.0.1") return false;
      return await new Promise<boolean>((resolve) => {
        const failed = (): void => { resolve(false); };
        socket.once("error", failed);
        socket.listen(port, host, () => { socket.removeListener("error", failed); resolve(true); });
      });
    });
    expect(server.port).toBeGreaterThan(0);
    expect(server.ipv6).toBe(true);
    expect(asked).toBeGreaterThan(2);                        // it really did try again
    expect((await fetch(`http://127.0.0.1:${server.port}/chat.html`)).status).toBe(200);
    server.close();
  });

  it("refuses an empty seed list, which would zero every counter", async () => {
    await expect(createPageServer(TRUTH, [])).rejects.toThrow(PAGE_SERVER_REFUSAL);
  });

  it("refuses with the fixed code when no pair can be had", async () => {
    await expect(createPageServer(TRUTH, titles, async () => false)).rejects.toThrow(PAGE_SERVER_REFUSAL);
  });

  it("tries the bounded number of times and no more", async () => {
    let attempts = 0;
    await expect(createPageServer(TRUTH, titles, async (_socket, host) => {
      if (host === "127.0.0.1") attempts += 1;
      return false;
    })).rejects.toThrow(PAGE_SERVER_REFUSAL);
    expect(attempts).toBe(PAGE_SERVER_TRIES);
  });
});
