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
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {TruthName} from "./cases";
import {acceptStagedTitle, renderPage, FALLBACK_TITLE, PAGE_NAMES, type PageName} from "./pages";

export interface PageServer {
  port: number;
  /**
   * Whether the IPv6 loopback was bound as well as the IPv4 one, on the same port.
   *
   * It is always `true` on a server this function returns: a half-bound pair is refused rather than
   * used (`createPageServer`). It is reported all the same, because a run's results file should say
   * that the two families were had rather than leaving a reader to infer it from the absence of a
   * refusal — every toolbar URL is a `*.localhost` name, which Chromium resolves to `::1` first.
   */
  ipv6: boolean;
  /**
   * How many requests carried this staged title, and what the last of them was answered with.
   *
   * The counters exist for one question the first toolbar run could not answer: when a staging comes
   * back `notStaged`, did the browser ever ASK for the page? A count of 0 puts the failure before
   * the page — the URL, the host, the launch — and a count of 1 with status 200 puts it after it,
   * in the title or the window server. Two numbers per case, and the key is a title this harness
   * minted: a request carrying anything else is counted under the fixed fallback name, never under
   * itself, so nothing from outside is stored here.
   */
  served(stagedTitle: string): {count: number; lastStatus: number | null};
  close(): void;
}

/** How many times a matched pair of ports is attempted before the run is refused. */
export const PAGE_SERVER_TRIES = 5;

/** The fixed code a run is refused with when no matched pair of loopback sockets can be had. */
export const PAGE_SERVER_REFUSAL = "PAGE_SERVER";

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

/** Listen on one address, or answer `false`: a loopback family that is not there is not a failure. */
function listenOn(server: Server, host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const failed = (): void => { resolve(false); };
    server.once("error", failed);
    server.listen(port, host, () => {
      server.removeListener("error", failed);
      resolve(true);
    });
  });
}

/**
 * **Both loopback families, on one port.**
 *
 * The accuracy cases ask for `127.0.0.1` literally; every TOOLBAR case asks for a `*.localhost`
 * name, and Chromium resolves those itself — `ResolveLocalHostname` answers with `::1` first and
 * `127.0.0.1` second. A server bound to the IPv4 address alone is therefore reached by one mode and
 * approached IPv6-first by the other, which is the only functional difference between the path that
 * worked and the path that returned 40 `notStaged` rows on 2026-09-21. Whether the browser falls
 * back to IPv4 quickly enough to hide it is not something this harness should depend on: binding
 * both costs one socket and removes the question.
 *
 * Both are LOOPBACK addresses, named explicitly. Nothing here listens on `0.0.0.0` or `::`, which
 * would put the staged pages on the network.
 *
 * **Neither half alone.** The IPv6 socket is bound to the port the IPv4 socket was given, and if it
 * cannot be, both are closed and the pair is tried again on a fresh ephemeral port — bounded by
 * `PAGE_SERVER_TRIES`, then refused with `PAGE_SERVER_REFUSAL`. A machine with no IPv6 loopback
 * therefore cannot run this harness, which is deliberate: a run that quietly lost the family the
 * toolbar URLs are resolved to first looks exactly like a run that never had it, and a `::1` port
 * that is taken means some OTHER local process receives the staged URLs.
 */
export async function createPageServer(
  truth: Readonly<Record<TruthName, string>>,
  /**
   * Every staged title this run could mint. The counter map is PRE-SEEDED with them and will take
   * no other key (review D, Important 2).
   *
   * Without it the map was keyed by whatever passed `isStagedTitle` — a prefix test with no nonce,
   * no case name and no length cap — so any local process could add unbounded keys of up to a
   * header's length, for the whole of a twenty-four-minute run. Seeded, the map is exactly as big
   * as the case table and the doc's claim that nothing from outside is stored here is true by
   * construction. A request carrying anything else is counted under the fixed fallback name, which
   * is seeded as well. REQUIRED: a default of `[]` would leave every counter at zero, and a row
   * reading `pageRequests: 0` is exactly the conclusion "the browser never asked for the page" that
   * these counters exist to reach.
   */
  stagedTitles: readonly string[],
  /**
   * How a socket is bound. Injected only so a test can make a bind fail: on this machine neither
   * branch of the retry is reachable, and an unreachable branch is an unproved one.
   */
  listen: (server: Server, host: string, port: number) => Promise<boolean> = listenOn
): Promise<PageServer> {
  // An EMPTY seed list is refused as loudly as a missing one: every counter would then answer
  // `{count: 0}` for every case, and `pageRequests: 0` is exactly the conclusion "the browser never
  // asked for the page" that these counters exist to reach. Required by the type AND at run time,
  // because a type is not there when somebody passes a list that happens to be empty.
  if (stagedTitles.length === 0) throw new Error(PAGE_SERVER_REFUSAL);
  /** Per staged title: how many requests carried it, and what the last was answered with. */
  const counts = new Map<string, {count: number; lastStatus: number | null}>();
  for (const title of [...stagedTitles, FALLBACK_TITLE]) counts.set(title, {count: 0, lastStatus: null});
  const record = (title: string, status: number): void => {
    const seen = counts.get(title);
    // Only a key this run seeded. Anything else is not counted at all rather than added.
    if (seen === undefined) return;
    counts.set(title, {count: seen.count + 1, lastStatus: status});
  };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Only ever a title this harness minted, or the fixed fallback: `acceptStagedTitle` is the same
    // gate the page itself goes through, so nothing from a request is ever a key here.
    const title = acceptStagedTitle(url.searchParams.get("stagedTitle"));
    const name = pageOf(url.pathname);
    if (name === null) {
      record(title, 404);
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
      response.end("no such staged page\n");
      return;
    }
    record(title, 200);
    const page = renderPage({name, lines: rowsOf(truth[name]), title});
    response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    response.end(page);
  };

  /**
   * A MATCHED PAIR, or nothing.
   *
   * Taking the IPv4 socket and shrugging at the IPv6 one is the state review D called out: the whole
   * premise of the fix is that a `*.localhost` name goes to `::1` first, so a run that quietly lost
   * that half looks exactly like a run that never had it — and a `::1` port that is taken means
   * some OTHER local process receives the staged URLs, nonce and all, as Chrome's first attempt.
   * So the pair is retried on a fresh ephemeral port, bounded, and a run that cannot have both is
   * refused with a fixed code rather than started half-bound. The IPv4 result is checked too
   * (review D, Minor 2): a failed bind used to leave `port = 0` and stage every window at
   * `http://host:0/`.
   */
  for (let attempt = 0; attempt < PAGE_SERVER_TRIES; attempt += 1) {
    const ipv4: Server = createServer(handler);
    if (!await listen(ipv4, "127.0.0.1", 0)) continue;
    const address = ipv4.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const ipv6: Server = createServer(handler);
    if (port > 0 && await listen(ipv6, "::1", port)) {
      return {
        port,
        ipv6: true,
        served: (stagedTitle) => counts.get(stagedTitle) ?? {count: 0, lastStatus: null},
        close: () => { ipv4.close(); ipv6.close(); }
      };
    }
    // Neither half is kept: a port that one family has and the other does not is the state this
    // loop exists to avoid.
    ipv4.close();
    ipv6.close();
  }
  throw new Error(PAGE_SERVER_REFUSAL);
}
