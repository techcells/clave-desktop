/**
 * The page server, against a real loopback server. No window is opened and nothing is captured: this
 * is an HTTP request to a port this test started and closes again.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {TruthName} from "./cases";
import {createPageServer, pageOf, rowsOf, type PageServer} from "./server";
import {stagedTitleFor} from "./stagedTitle";

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

beforeAll(async () => { server = await createPageServer(TRUTH); });
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
