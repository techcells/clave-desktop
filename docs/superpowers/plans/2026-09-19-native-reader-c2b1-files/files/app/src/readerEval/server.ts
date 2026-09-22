/**
 * The staged pages, served on the loopback address only.
 *
 * It is its own module rather than a few lines inside `main.ts` for one reason: it can be tested
 * without a screen, and it is worth testing. A 404, a page served under the wrong title or a theme
 * that never arrives does not fail loudly — it produces a run full of `notStaged` repetitions, or
 * worse, a run that scores a page that was not the one asked for, and both of those cost an hour of
 * the owner's time with windows opening on their machine.
 *
 * Any host resolves here: Chrome sends every `*.localhost` name to the loopback address with no
 * change to the machine, which is how one server serves the four toolbar hosts. Nothing but the four
 * staged pages is ever served, and a title only reaches a page through `acceptStagedTitle`.
 */
import {createServer, type Server} from "node:http";
import type {TruthName} from "./cases";
import {acceptStagedTitle, renderPage, PAGE_NAMES, type PageName} from "./pages";

export interface PageServer {
  port: number;
  close(): void;
}

/**
 * The page a request asks for, or `null` if it is not one of the four.
 *
 * Exactly `/<name>.html` and nothing else. The harness only ever asks for that, so anything looser
 * would only ever widen what this server answers to — and the one thing it must be is boring.
 */
export function pageOf(pathname: string): PageName | null {
  const match = /^\/([a-z]+)\.html$/.exec(pathname);
  const name = match?.[1];
  return name !== undefined && (PAGE_NAMES as readonly string[]).includes(name) ? (name as PageName) : null;
}

/** The truth file as the page's rows: its lines, with the trailing blank one dropped. */
export function rowsOf(truth: string): string[] {
  return truth.split("\n").filter((line) => line !== "");
}

export function createPageServer(truth: Readonly<Record<TruthName, string>>): Promise<PageServer> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const name = pageOf(url.pathname);
    if (name === null) {
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
      response.end("no such staged page\n");
      return;
    }
    const page = renderPage({
      name,
      lines: rowsOf(truth[name]),
      title: acceptStagedTitle(url.searchParams.get("stagedTitle"))
    });
    response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    response.end(page);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () => { server.close(); }
      });
    });
  });
}
