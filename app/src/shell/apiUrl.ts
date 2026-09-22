/**
 * Which clave-back the app talks to. A packaged build always talks to production: the switch is
 * dead there (`devEnv`), and this function does not even look at it. An unpackaged build talks to
 * the dev deployment unless `CLAVE_API_URL` points it at a local server; a switch that is set but
 * not acceptable refuses the launch (`BAD_API_URL`) rather than falling through to any default,
 * because "I set the switch and it silently went to production" is the one outcome nobody wants.
 */
export const PROD_API_URL = "https://api.clave.co";
export const DEV_API_URL = "https://api.d.clave.co";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type ApiUrlChoice = {ok: true; url: string} | {ok: false; code: "BAD_API_URL"};

export function resolveApiUrl(input: {packaged: boolean; switchValue: string | undefined}): ApiUrlChoice {
  if (input.packaged) return {ok: true, url: PROD_API_URL};
  if (input.switchValue === undefined) return {ok: true, url: DEV_API_URL};
  const accepted = acceptableBase(input.switchValue);
  return accepted ? {ok: true, url: accepted} : {ok: false, code: "BAD_API_URL"};
}

/** `https://host[:port]` anywhere, plain `http://` only on this machine; no path, query, fragment or credentials. Answers the origin, or `null`. */
export function acceptableBase(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}
