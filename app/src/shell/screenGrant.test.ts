import {describe, expect, it, vi} from "vitest";
import type {JsonFile} from "../main/storage/jsonFile";
import {createFakeCipher, createMemFs} from "../main/testing/memFs";
import {createScreenGrant, parseScreenGrant, screenGrantFile} from "./screenGrant";

function memoryFile(initial: {token: string} | null = null): JsonFile<{token: string}> & {saved: string[]} {
  let value = initial;
  const saved: string[] = [];
  return {
    saved,
    async load() { return value; },
    async save(next) { value = next; saved.push(next.token); },
    async remove() { value = null; }
  };
}

function recordingReader() {
  const sent: string[] = [];
  return {
    sent,
    grant: (token: string) => { sent.push(`grant ${token}`); },
    release: () => { sent.push("release"); },
    forgetGrant: () => { sent.push("forget"); }
  };
}

describe("screen grant", () => {
  it("hands a kept token to the reader at start, and nothing when there is none", async () => {
    const reader = recordingReader();
    await createScreenGrant({file: memoryFile({token: "t-1"}), reader}).load();
    expect(reader.sent).toEqual(["grant t-1"]);
    const none = recordingReader();
    await createScreenGrant({file: memoryFile(), reader: none}).load();
    expect(none.sent).toEqual([]);
  });

  it("keeps each fresh token from the reader in the file, in place of the spent one", async () => {
    const file = memoryFile({token: "t-1"});
    const grant = createScreenGrant({file, reader: recordingReader()});
    await grant.load();
    grant.saveToken("t-2");
    await Promise.resolve();
    expect(file.saved).toEqual(["t-2"]);
  });

  it("releases when capture stops and grants the newest token again when it starts", async () => {
    const reader = recordingReader();
    const grant = createScreenGrant({file: memoryFile({token: "t-1"}), reader});
    await grant.load();
    grant.capture(true);
    grant.capture(true);
    grant.saveToken("t-2");
    grant.capture(false);
    grant.capture(false);
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-1", "grant t-1", "release", "grant t-2"]);
  });

  it("sends nothing on start or stop when no token has ever been kept, other than the release", async () => {
    const reader = recordingReader();
    const grant = createScreenGrant({file: memoryFile(), reader});
    await grant.load();
    grant.capture(true);
    grant.capture(false);
    expect(reader.sent).toEqual(["release"]);
  });

  it("a token it cannot keep on disk is still used for this run", async () => {
    const reader = recordingReader();
    const file = memoryFile();
    file.save = async () => { throw new Error("STORAGE_UNAVAILABLE"); };
    const grant = createScreenGrant({file, reader});
    await grant.load();
    grant.saveToken("t-9");
    await Promise.resolve();
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-9"]);
  });

  it("a fresh token that arrives while the kept one is still being read wins over it", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-kept"});
    let finishLoad: () => void = () => undefined;
    file.load = () => new Promise((resolve) => { finishLoad = () => resolve({token: "t-kept"}); });
    const grant = createScreenGrant({file, reader});
    const loading = grant.load();
    grant.saveToken("t-fresh");
    finishLoad();
    await loading;
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-fresh"]);
    expect(file.saved).toEqual(["t-fresh"]);
  });

  it("follows capture from the engine's status, starting with the status it has now, until unsubscribed", async () => {
    const reader = recordingReader();
    const grant = createScreenGrant({file: memoryFile({token: "t-1"}), reader});
    await grant.load();
    reader.sent.length = 0;
    const listeners: ((status: {capture: "on" | "off"}) => void)[] = [];
    const engine = {
      status: () => ({capture: "on" as const}),
      onStatus: (cb: (status: {capture: "on" | "off"}) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; }
    };
    const stop = grant.follow(engine);
    expect(reader.sent).toEqual(["grant t-1"]);
    listeners.forEach((cb) => cb({capture: "off"}));
    listeners.forEach((cb) => cb({capture: "on"}));
    expect(reader.sent).toEqual(["grant t-1", "release", "grant t-1"]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it("releases at launch when capture starts off, so the reader holds the kept grant released", async () => {
    const reader = recordingReader();
    const grant = createScreenGrant({file: memoryFile({token: "t-1"}), reader});
    await grant.load();
    grant.follow({status: () => ({capture: "off"}), onStatus: () => () => undefined});
    expect(reader.sent).toEqual(["grant t-1", "release"]);
  });
});

describe("forgetting the screen grant (delete all local data)", () => {
  it("forgets the token here and in the reader, and removes the file after any save still in flight", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-1"});
    let finishSave: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finishSave = resolve; });
    const save = file.save.bind(file);
    file.save = async (next) => { await gate; await save(next); };
    const grant = createScreenGrant({file, reader});
    await grant.load();
    grant.saveToken("t-2");                     // held on the disk
    const forgetting = grant.forget();
    finishSave();
    await forgetting;
    expect(await file.load()).toBeNull();
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-1", "forget"]);  // no grant after forgetting
  });

  it("still forgets when the file cannot be removed", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-1"});
    file.remove = async () => { throw new Error("disk"); };
    const grant = createScreenGrant({file, reader});
    await grant.load();
    await expect(grant.forget()).rejects.toThrow("disk");
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-1", "forget"]);
  });
});

describe("the user stopped the screen share (Linux, protocol 5)", () => {
  it("drops the token here and from the file, after any save still in flight, and grants nothing after", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-1"});
    let finishSave: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finishSave = resolve; });
    const save = file.save.bind(file);
    file.save = async (next) => { await gate; await save(next); };
    const grant = createScreenGrant({file, reader});
    await grant.load();
    grant.saveToken("t-2");                     // held on the disk
    const revoking = grant.revoke();
    finishSave();
    await revoking;
    expect(await file.load()).toBeNull();
    grant.capture(true);
    // The reader client dropped the token itself when it heard the stop: nothing to tell it here.
    expect(reader.sent).toEqual(["grant t-1"]);
  });

  it("keeps the token of a share the user starts again", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-1"});
    const grant = createScreenGrant({file, reader});
    await grant.load();
    await grant.revoke();
    grant.saveToken("t-2");
    grant.capture(true);
    await Promise.resolve();
    expect(reader.sent).toEqual(["grant t-1", "grant t-2"]);
    await vi.waitFor(async () => expect(await file.load()).toEqual({token: "t-2"}));
  });

  it("still drops the token here when the file cannot be removed", async () => {
    const reader = recordingReader();
    const file = memoryFile({token: "t-1"});
    file.remove = async () => { throw new Error("disk"); };
    const grant = createScreenGrant({file, reader});
    await grant.load();
    await expect(grant.revoke()).rejects.toThrow("disk");
    grant.capture(true);
    expect(reader.sent).toEqual(["grant t-1"]);
  });
});

describe("the kept grant file", () => {
  it("is always encrypted: the token never reaches the disk as it is, and reads back", async () => {
    const fs = createMemFs();
    const file = screenGrantFile({fs, path: "/data/screen-grant.bin", cipher: createFakeCipher()});
    await file.save({token: "0e5a3c2d-8f1b"});
    expect(fs.everything()).not.toContain("0e5a3c2d");
    expect(await file.load()).toEqual({token: "0e5a3c2d-8f1b"});
  });

  it("stores nothing at all when the keyring cannot encrypt", async () => {
    const fs = createMemFs();
    const file = screenGrantFile({fs, path: "/data/screen-grant.bin", cipher: createFakeCipher(false)});
    await file.save({token: "0e5a3c2d-8f1b"}).catch(() => undefined);
    expect(fs.files.size).toBe(0);
  });

  it("accepts only a plausible token, the same rule the reader keeps", () => {
    expect(parseScreenGrant({token: "0e5a3c2d-8f1b"})).toEqual({token: "0e5a3c2d-8f1b"});
    for (const value of [null, "t", {}, {token: 7}, {token: ""}, {token: "a b"}, {token: "a".repeat(129)}]) {
      expect(parseScreenGrant(value), JSON.stringify(value)).toBeNull();
    }
  });
});
