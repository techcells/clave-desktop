import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {ApiError, type ApiErrorCode, type ApprovedStatement, type Session} from "../ports/claveApi";
import {createHttpApi, jwtExpiresAtMs, sessionFrom, SUBMIT_CHUNK, wireItem} from "./httpApi";

const EXP = 1_790_000_000;                                   // seconds
const jwt = (payload: unknown) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const TOKEN = jwt({exp: EXP, nameid: "acc-1"});
const SESSION: Session = {token: "old-token-secret", expiresAt: 1, userId: "acc-1"};
const STATEMENT = "Tuned a slow PostgreSQL query with an index";
const ITEM: ApprovedStatement = {clientItemId: "c1", statement: STATEMENT, kind: "skill", targetId: "6650dddddddddddddddddddd", createdAt: Date.UTC(2026, 8, 22, 10, 30, 5, 250), taxonomyVersion: "abc", pipelineVersion: "1"};
const ok = (data: unknown) => ({successful: true, error: null, data});
const refused = (code: number) => ({successful: false, error: {code, message: "Server-side words that must never surface"}, data: null});

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | null }

/** A fetch that answers from a queue and records every request. */
function fakeFetch(answers: Array<{status?: number; body?: unknown; text?: string} | Error>) {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null});
    const next = answers.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    const text = next.text ?? JSON.stringify(next.body ?? null);
    return new Response(text, {status: next.status ?? 200, headers: {"Content-Type": "application/json"}});
  };
  return {impl, seen};
}

const api = (answers: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(answers);
  return {api: createHttpApi({baseUrl: "https://api.test", fetchImpl: f.impl}), seen: f.seen};
};
const codeOfRejection = async (p: Promise<unknown>): Promise<ApiErrorCode> => {
  try { await p; } catch (error) { expect(error).toBeInstanceOf(ApiError); return (error as ApiError).code; }
  throw new Error("did not reject");
};

describe("session from clave-back's auth answer", () => {
  it("reads the expiry out of the token and the user out of accountId", () => {
    expect(jwtExpiresAtMs(TOKEN)).toBe(EXP * 1000);
    expect(sessionFrom({accountId: "acc-1", accessToken: {type: "Bearer", value: TOKEN}, email: "x@y", isVerified: true})).toEqual({token: TOKEN, expiresAt: EXP * 1000, userId: "acc-1"});
  });

  it("refuses an answer without an account, a token, or a readable expiry", () => {
    expect(sessionFrom({accessToken: {value: TOKEN}})).toBeNull();
    expect(sessionFrom({accountId: "acc-1"})).toBeNull();
    expect(sessionFrom({accountId: "", accessToken: {value: TOKEN}})).toBeNull();
    for (const bad of ["not-a-jwt", "a.b", "a..c", `x.${Buffer.from("not json").toString("base64url")}.y`, jwt({}), jwt({exp: "soon"}), jwt({exp: 0}), jwt({exp: Number.NaN}), jwt(null), `h.${Buffer.from('{"exp":1e400}').toString("base64url")}.s`]) {
      expect(jwtExpiresAtMs(bad), bad).toBeNull();
      expect(sessionFrom({accountId: "acc-1", accessToken: {value: bad}}), bad).toBeNull();
    }
  });
});

describe("the wire form of a statement", () => {
  it("uses clave-back's names and an ISO instant in UTC", () => {
    expect(wireItem(ITEM)).toEqual({clientItemId: "c1", statement: STATEMENT, kind: "skill", targetId: ITEM.targetId, datetimeWritten: "2026-09-22T10:30:05.250Z", taxonomyVersion: "abc", pipelineVersion: "1"});
  });

  it("sends null for a time the server's parser would refuse, so the server refuses that one item for good", () => {
    for (const createdAt of [8.7e15, 253402300800000, -62135596800001, Number.NaN]) expect(wireItem({...ITEM, createdAt}).datetimeWritten, String(createdAt)).toBeNull();
    expect(wireItem({...ITEM, createdAt: 253402300799999}).datetimeWritten).toBe("9999-12-31T23:59:59.999Z");
    expect(wireItem({...ITEM, createdAt: -62135596800000}).datetimeWritten).toBe("0001-01-01T00:00:00.000Z");
  });

  it("a competency goes on the wire as a competency, word for word", () => {
    expect(wireItem({...ITEM, kind: "competency", targetId: "6650eeeeeeeeeeeeeeeeeeee"})).toMatchObject({kind: "competency", targetId: "6650eeeeeeeeeeeeeeeeeeee"});
  });
});

describe("http clave-back client", () => {
  it("signs in with an email or a handle, and never sends a bearer token to the login", async () => {
    const {api: a, seen} = api([{body: ok({accountId: "acc-1", accessToken: {type: "Bearer", value: TOKEN}})}, {body: ok({accountId: "acc-1", accessToken: {value: TOKEN}})}]);
    expect(await a.signIn("  Sardor@Example.com ", "pw")).toEqual({token: TOKEN, expiresAt: EXP * 1000, userId: "acc-1"});
    expect(seen[0]).toMatchObject({url: "https://api.test/api/security/login", method: "POST", headers: {Accept: "application/json", "Content-Type": "application/json"}});
    expect(JSON.parse(seen[0]!.body!)).toEqual({email: "Sardor@Example.com", password: "pw"});
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    await a.signIn("sardor", "pw");
    expect(JSON.parse(seen[1]!.body!)).toEqual({handle: "sardor", password: "pw"});
  });

  it("maps a refused login to BAD_CREDENTIALS, and only on the login route", async () => {
    for (const code of [3, 5, 6]) expect(await codeOfRejection(api([{body: refused(code)}]).api.signIn("a@b", "x")), String(code)).toBe("BAD_CREDENTIALS");
    // An identifier the server cannot even parse as an email (HTTP 400 ProblemDetails) reads as a mismatch too.
    expect(await codeOfRejection(api([{status: 400, body: {title: "One or more validation errors occurred.", errors: {Email: ["not valid"]}}}]).api.signIn("sardor@", "x"))).toBe("BAD_CREDENTIALS");
    expect(await codeOfRejection(api([{status: 400, text: "{}"}]).api.refresh(SESSION))).toBe("SERVER");
    // An answer that is not a session, on either route that yields one.
    expect(await codeOfRejection(api([{body: ok({accountId: "acc-1"})}]).api.signIn("a@b", "x"))).toBe("BAD_RESPONSE");
    expect(await codeOfRejection(api([{body: ok({accessToken: {value: TOKEN}})}]).api.refresh(SESSION))).toBe("BAD_RESPONSE");
    expect(await codeOfRejection(api([{body: refused(6)}]).api.profile(SESSION))).toBe("UNAUTHORISED");
    expect(await codeOfRejection(api([{body: refused(3)}]).api.profile(SESSION))).toBe("SERVER");
    expect(await codeOfRejection(api([{body: refused(5)}]).api.profile(SESSION))).toBe("SERVER");
  });

  it("maps every other answer to a fixed code", async () => {
    const cases: Array<[Parameters<typeof fakeFetch>[0][number], ApiErrorCode]> = [
      [new TypeError("fetch failed"), "OFFLINE"],
      [{status: 401, text: "Unauthorized"}, "UNAUTHORISED"],
      [{status: 403, body: {successful: false, error: {code: 6}}}, "UNAUTHORISED"],
      [{status: 500, text: "<html>oops</html>"}, "SERVER"],
      [{status: 503, text: ""}, "SERVER"],
      [{status: 404, text: "not here"}, "SERVER"],
      [{status: 400, body: {title: "One or more validation errors occurred.", errors: {}}}, "SERVER"],
      [{status: 200, text: "<html>login page</html>"}, "BAD_RESPONSE"],
      [{status: 200, body: {data: {names: []}}}, "BAD_RESPONSE"],
      [{status: 200, body: refused(11)}, "RATE_LIMITED"],
      [{status: 200, body: refused(8)}, "UNAUTHORISED"],
      [{status: 200, body: refused(2)}, "SERVER"],
      [{status: 200, body: {successful: false}}, "SERVER"],
      [{status: 200, body: ok({names: "Sardor"})}, "BAD_RESPONSE"],
      [{status: 200, body: ok(null)}, "BAD_RESPONSE"]
    ];
    for (const [answer, code] of cases) expect(await codeOfRejection(api([answer]).api.profile(SESSION)), JSON.stringify(answer)).toBe(code);
  });

  it("refreshes with the token as a bearer and nothing else", async () => {
    const {api: a, seen} = api([{body: ok({accountId: "acc-1", accessToken: {value: TOKEN}})}]);
    expect(await a.refresh(SESSION)).toEqual({token: TOKEN, expiresAt: EXP * 1000, userId: "acc-1"});
    expect(seen[0]).toMatchObject({url: "https://api.test/api/security/refresh", method: "PUT", headers: {Authorization: `Bearer ${SESSION.token}`}, body: null});
    expect(seen[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it("exchanges a browser sign-in's attempt id, and treats a refused attempt as UNAUTHORISED", async () => {
    const {api: a, seen} = api([
      {body: ok({accountId: "acc-1", accessToken: {value: TOKEN}, isSuccessful: true, errorMessage: null})},
      {body: ok({accountId: null, accessToken: null, isSuccessful: false, errorMessage: "No account for that Google email"})},
      {body: ok({accountId: "acc-1", accessToken: {value: TOKEN}, isSuccessful: false})},
      {body: refused(6)}
    ]);
    expect(await a.exchangeOAuthAttempt("att/1 ?", "v3rifier~x")).toEqual({token: TOKEN, expiresAt: EXP * 1000, userId: "acc-1"});
    expect(seen[0]).toMatchObject({url: "https://api.test/api/security/oAuthAttempt/att%2F1%20%3F?codeVerifier=v3rifier~x", method: "GET"});
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(await codeOfRejection(a.exchangeOAuthAttempt("att-2", "v"))).toBe("UNAUTHORISED");
    expect(await codeOfRejection(a.exchangeOAuthAttempt("att-3", "v"))).toBe("UNAUTHORISED");
    expect(await codeOfRejection(a.exchangeOAuthAttempt("att-4", "v"))).toBe("UNAUTHORISED");
    const b = api([{body: ok({accountId: null, accessToken: {value: TOKEN}, isSuccessful: true})}]);
    expect(await codeOfRejection(b.api.exchangeOAuthAttempt("att-5", "v"))).toBe("UNAUTHORISED");
    // A string the URL cannot carry never reaches fetch and never throws anything but a code.
    const c = api([]);
    expect(await codeOfRejection(c.api.exchangeOAuthAttempt("\ud800", "v"))).toBe("UNAUTHORISED");
    expect(await codeOfRejection(c.api.exchangeOAuthAttempt("att-6", "\ud800"))).toBe("UNAUTHORISED");
    expect(c.seen).toEqual([]);
  });

  it("asks for the profile names with the session", async () => {
    const {api: a, seen} = api([{body: ok({names: ["Sardor", "Astanov"]})}]);
    expect(await a.profile(SESSION)).toEqual({names: ["Sardor", "Astanov"]});
    expect(seen[0]).toMatchObject({url: "https://api.test/api/agent/profile", method: "GET", headers: {Authorization: `Bearer ${SESSION.token}`}});
  });

  it("asks for the taxonomy with the known version, and understands both answers", async () => {
    const full = {version: "v2", unchanged: false, skills: [{id: "s1", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]}], competencies: [{id: "c1", name: "Problem Solving", description: ""}]};
    const {api: a, seen} = api([{body: ok({version: "v1", unchanged: true})}, {body: ok(full)}, {body: ok({version: "v3", unchanged: false, skills: [{id: "s1"}], competencies: []})}, {body: ok({version: "", unchanged: true})}]);
    expect(await a.taxonomy(SESSION, "v1")).toBe("unchanged");
    expect(seen[0]).toMatchObject({url: "https://api.test/api/agent/taxonomy?knownVersion=v1", method: "GET", headers: {Authorization: `Bearer ${SESSION.token}`}});
    expect(await a.taxonomy(SESSION)).toEqual({version: "v2", skills: full.skills, competencies: full.competencies});
    expect(seen[1]!.url).toBe("https://api.test/api/agent/taxonomy");
    expect(await codeOfRejection(a.taxonomy(SESSION, "v2"))).toBe("BAD_RESPONSE");
    expect(await codeOfRejection(a.taxonomy(SESSION, "v2"))).toBe("BAD_RESPONSE");
    const b = api([{body: ok({version: "v1", unchanged: true})}, {body: ok({version: "v1", unchanged: true})}]);
    await b.api.taxonomy(SESSION, "a b&c=d");
    expect(b.seen[0]!.url).toBe("https://api.test/api/agent/taxonomy?knownVersion=a%20b%26c%3Dd");
    expect(await codeOfRejection(b.api.taxonomy(SESSION, "\ud800"))).toBe("BAD_RESPONSE");
    expect(b.seen).toHaveLength(1);
  });

  it("uploads the outbox in clave-back's shape and hands back both lists", async () => {
    const {api: a, seen} = api([{body: ok({accepted: ["c1"], rejected: ["c2"]})}, {body: ok({accepted: "nope"})}]);
    expect(await a.submitEvidence(SESSION, [ITEM, {...ITEM, clientItemId: "c2", kind: "competency"}])).toEqual({accepted: ["c1"], rejected: ["c2"]});
    expect(seen[0]).toMatchObject({url: "https://api.test/api/agent/evidence", method: "POST", headers: {Authorization: `Bearer ${SESSION.token}`, "Content-Type": "application/json"}});
    expect(JSON.parse(seen[0]!.body!)).toEqual({items: [wireItem(ITEM), wireItem({...ITEM, clientItemId: "c2", kind: "competency"})]});
    expect(JSON.parse(seen[0]!.body!).items[1]).toMatchObject({kind: "competency", clientItemId: "c2"});
    // Nothing to send is nothing sent.
    expect(await a.submitEvidence(SESSION, [])).toEqual({accepted: [], rejected: []});
    expect(seen).toHaveLength(1);
    expect(await codeOfRejection(a.submitEvidence(SESSION, [ITEM]))).toBe("BAD_RESPONSE");
  });

  it("sends a large outbox in pieces the server accepts, and merges what it says", async () => {
    const items = Array.from({length: 2 * SUBMIT_CHUNK + 1}, (_, i) => ({...ITEM, clientItemId: `c${i}`}));
    const refused = new Set(["c7", "c63", "c100"]);
    const answers = (from: number, to: number) => {
      const ids = items.slice(from, to).map((i) => i.clientItemId);
      return {body: ok({accepted: ids.filter((id) => !refused.has(id)), rejected: ids.filter((id) => refused.has(id))})};
    };
    const {api: a, seen} = api([answers(0, 50), answers(50, 100), answers(100, 101)]);
    const result = await a.submitEvidence(SESSION, items);
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => (JSON.parse(s.body!) as {items: unknown[]}).items.length)).toEqual([50, 50, 1]);
    expect(result.accepted).toHaveLength(98);
    expect(result.rejected).toEqual(["c7", "c63", "c100"]);
    for (const id of refused) expect(result.accepted).not.toContain(id);
  });

  it("a later piece failing keeps what the earlier pieces achieved; the first piece failing is the request failing", async () => {
    const items = Array.from({length: SUBMIT_CHUNK + 2}, (_, i) => ({...ITEM, clientItemId: `c${i}`}));
    const first = api([{body: ok({accepted: items.slice(0, 50).map((i) => i.clientItemId), rejected: []})}, {body: refused(11)}]);
    const partial = await first.api.submitEvidence(SESSION, items);
    expect(partial.accepted).toHaveLength(50);
    expect(partial.accepted).not.toContain("c50");
    expect(first.seen).toHaveLength(2);

    const second = api([{body: refused(11)}]);
    expect(await codeOfRejection(second.api.submitEvidence(SESSION, items))).toBe("RATE_LIMITED");
    expect(second.seen).toHaveLength(1);

    const third = api([{body: ok({accepted: items.slice(0, 50).map((i) => i.clientItemId)})}, {status: 200, text: "<html>"}]);
    expect((await third.api.submitEvidence(SESSION, items)).accepted).toHaveLength(50);
  });

  it("LEAK TEST: no thrown error carries the token, the password, a statement, or a word from the server", async () => {
    const secrets = [SESSION.token, "pw-secret", STATEMENT, "Server-side words", "login page", "oops"];
    const attempts: Array<() => Promise<unknown>> = [
      () => api([{body: refused(3)}]).api.signIn("a@b", "pw-secret"),
      () => api([{status: 500, text: "oops " + SESSION.token}]).api.submitEvidence(SESSION, [ITEM]),
      () => api([{status: 200, text: "<html>login page</html>"}]).api.profile(SESSION),
      () => api([new Error(`ECONNREFUSED ${SESSION.token}`)]).api.refresh(SESSION),
      () => api([{body: ok({names: STATEMENT})}]).api.profile(SESSION)
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try { await attempt(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ApiError);
      const dump = JSON.stringify({message: (caught as Error).message, stack: undefined, ...(caught as object)});
      for (const secret of secrets) expect(dump).not.toContain(secret);
    }
  });
});

describe("http clave-back client against a real local server", () => {
  let server: Server;
  let base = "";
  let hits = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      hits += 1;
      if (request.url === "/api/security/refresh") { response.writeHead(302, {Location: "/api/agent/profile"}).end(); return; }
      // Headers, then silence: the deadline must cover the body too.
      if (request.url === "/api/agent/evidence") { response.writeHead(200, {"Content-Type": "application/json"}); response.write("{\"successful\":true,"); return; }
      if (request.url === "/api/agent/profile") { response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify(ok({names: ["Sardor"]}))); return; }
      // Anything else is never answered: the deadline is the only way out.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

  it("gives up on a silent server at the deadline and answers OFFLINE, with the taxonomy's own longer deadline", async () => {
    const a = createHttpApi({baseUrl: base, timeouts: {callMs: 150, taxonomyMs: 600}});
    let started = Date.now();
    expect(await codeOfRejection(a.exchangeOAuthAttempt("never-answered", "v"))).toBe("OFFLINE");
    const profileTook = Date.now() - started;
    expect(profileTook).toBeLessThan(500);
    started = Date.now();
    expect(await codeOfRejection(a.taxonomy(SESSION))).toBe("OFFLINE");
    const taxonomyTook = Date.now() - started;
    expect(taxonomyTook).toBeGreaterThanOrEqual(500);
    expect(taxonomyTook).toBeLessThan(3_000);
  });

  it("a body that never finishes is OFFLINE too: the deadline covers the bytes, not only the headers", async () => {
    const a = createHttpApi({baseUrl: base, timeouts: {callMs: 200, taxonomyMs: 200}});
    expect(await codeOfRejection(a.submitEvidence(SESSION, [ITEM]))).toBe("OFFLINE");
  });

  it("never follows a redirect, even to its own host", async () => {
    const a = createHttpApi({baseUrl: base, timeouts: {callMs: 2_000, taxonomyMs: 2_000}});
    hits = 0;
    expect(await codeOfRejection(a.refresh(SESSION))).toBe("OFFLINE");
    expect(hits).toBe(1);
    expect(await a.profile(SESSION)).toEqual({names: ["Sardor"]});
  });
});
