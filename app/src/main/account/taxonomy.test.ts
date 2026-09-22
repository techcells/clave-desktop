import {describe, expect, it, vi} from "vitest";
import {TAXONOMY_REFRESH_MS, TAXONOMY_RETRY_MS} from "../constants";
import {createFakeApi, TAXONOMY_V1} from "../testing/fakeApi";
import {createFakeCipher, createMemFs} from "../testing/memFs";
import {createSessionStore} from "./session";
import {createTaxonomyCache} from "./taxonomy";

async function setup(signedIn = true) {
  let now = 1_000_000;
  const fs = createMemFs();
  const api = createFakeApi(() => now);
  const session = createSessionStore({api, fs, cipher: createFakeCipher(), path: "/d/session.bin", now: () => now});
  if (signedIn) await session.signIn("sardor", "correct");
  const make = () => createTaxonomyCache({api, session, fs, path: "/d/taxonomy.json", now: () => now});
  return {fs, api, session, make, advance: (ms: number) => { now += ms; }};
}

describe("taxonomy cache", () => {
  it("fetches, caches on disk, tells listeners, and is found again after a restart", async () => {
    const {make} = await setup();
    const cache = make();
    const seen = vi.fn();
    cache.onChange(seen);
    expect(await cache.refresh()).toBe("updated");
    expect(cache.current()).toEqual(TAXONOMY_V1);
    expect(seen).toHaveBeenCalledWith(TAXONOMY_V1);

    const again = make();
    await again.load();
    expect(again.current()?.version).toBe("tax-1");
  });

  it("asks at most once a day, and sends the known version", async () => {
    const {api, make, advance} = await setup();
    const cache = make();
    await cache.refresh();
    expect(await cache.refresh()).toBe("skipped");
    advance(TAXONOMY_REFRESH_MS + 1);
    expect(await cache.refresh()).toBe("unchanged");
    expect(await cache.refresh()).toBe("skipped");
    expect(api.calls.filter((c) => c === "taxonomy")).toHaveLength(2);
  });

  it("picks up a new version", async () => {
    const {api, make, advance} = await setup();
    const cache = make();
    await cache.refresh();
    api.taxonomyValue = {...TAXONOMY_V1, version: "tax-2"};
    advance(TAXONOMY_REFRESH_MS + 1);
    expect(await cache.refresh()).toBe("updated");
    expect(cache.current()?.version).toBe("tax-2");
  });

  it("keeps the cached copy when the fetch fails or the answer is malformed", async () => {
    const {api, make} = await setup();
    const cache = make();
    await cache.refresh();
    api.failWith = "OFFLINE";
    expect(await cache.refresh(true)).toBe("failed");
    expect(cache.current()?.version).toBe("tax-1");
    api.failWith = null;
    api.taxonomyValue = {version: "tax-3", skills: [{id: ""}], competencies: []} as never;
    expect(await cache.refresh(true)).toBe("failed");
    expect(cache.current()?.version).toBe("tax-1");
  });

  it("does not ask again within TAXONOMY_RETRY_MS after a failed refresh, unless forced or the window has passed", async () => {
    const {api, make, advance} = await setup();
    const cache = make();
    api.failWith = "OFFLINE";
    expect(await cache.refresh()).toBe("failed");
    expect(await cache.refresh()).toBe("failed"); // still within the retry window: no new network call
    expect(api.calls.filter((c) => c === "taxonomy")).toHaveLength(1);
    expect(await cache.refresh(true)).toBe("failed"); // force bypasses the backoff
    expect(api.calls.filter((c) => c === "taxonomy")).toHaveLength(2);
    advance(TAXONOMY_RETRY_MS + 1);
    api.failWith = null;
    expect(await cache.refresh()).toBe("updated");
    expect(api.calls.filter((c) => c === "taxonomy")).toHaveLength(3);
  });

  it("treats 'unchanged' as a failure when nothing is cached yet: there is nothing for the server's answer to mean", async () => {
    const {api, make} = await setup();
    const cache = make();
    api.taxonomy = async () => { api.calls.push("taxonomy"); return "unchanged"; };
    expect(await cache.refresh()).toBe("failed");
    expect(cache.current()).toBeNull();
  });

  it("does nothing while signed out", async () => {
    const {api, make} = await setup(false);
    expect(await make().refresh()).toBe("skipped");
    expect(api.calls).toEqual([]);
  });

  it("clear forgets the cache and the file", async () => {
    const {fs, make} = await setup();
    const cache = make();
    await cache.refresh();
    await cache.clear();
    expect(cache.current()).toBeNull();
    expect(fs.files.has("/d/taxonomy.json")).toBe(false);
  });
});
