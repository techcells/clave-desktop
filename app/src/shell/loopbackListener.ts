import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import type {LoopbackListener} from "../main/account/googleSignIn";

/**
 * The one-shot listener a browser sign-in comes back to. It answers exactly one request: a GET of
 * `/callback` whose `state` is the one it was started with and which carries an `oAuthAttemptId`.
 * Everything else — another path, a wrong or missing state, a second visit — is a bare 404 that says
 * nothing. The page it shows is fixed text with no script and no data in it; the attempt id lives in
 * the browser's address bar for the seconds the redirect takes and is never written anywhere here.
 */
const DONE_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Clave Agent</title><p style=\"font:16px system-ui;margin:3em\">You can close this tab and go back to Clave Agent.</p>";

export function createLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  let delivered = false;
  let resolveCallback: ((value: {attemptId: string}) => void) | null = null;
  const callback = new Promise<{attemptId: string}>((resolve) => { resolveCallback = resolve; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const state = url.searchParams.get("state");
    const attemptId = url.searchParams.get("oAuthAttemptId");
    const accepted = request.method === "GET" && url.pathname === "/callback" && !delivered && state !== null && state === expectedState && attemptId !== null && attemptId.length > 0;
    if (!accepted) { response.writeHead(404, {"Content-Type": "text/plain", "Cache-Control": "no-store"}).end("Not found"); return; }
    delivered = true;
    response.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}).end(DONE_PAGE);
    resolveCallback?.({attemptId});
  });
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        callback: () => callback,
        close() { server.closeAllConnections(); server.close(); }
      });
    });
  });
}
