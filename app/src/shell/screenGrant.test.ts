import {describe, expect, it} from "vitest";
import type {JsonFile} from "../main/storage/jsonFile";
import {createScreenGrant, parseScreenGrant} from "./screenGrant";

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
  return {sent, grant: (token: string) => { sent.push(`grant ${token}`); }, release: () => { sent.push("release"); }};
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

  it("keeps each fresh token from the reader, encrypted by the file, in place of the spent one", async () => {
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
});

describe("the kept grant file", () => {
  it("accepts only a plausible token, the same rule the reader keeps", () => {
    expect(parseScreenGrant({token: "0e5a3c2d-8f1b"})).toEqual({token: "0e5a3c2d-8f1b"});
    for (const value of [null, "t", {}, {token: 7}, {token: ""}, {token: "a b"}, {token: "a".repeat(129)}]) {
      expect(parseScreenGrant(value), JSON.stringify(value)).toBeNull();
    }
  });
});
