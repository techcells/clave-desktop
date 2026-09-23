import {describe, expect, it, vi} from "vitest";
import {createFakeCipher, createMemFs} from "../testing/memFs";
import {createJsonFile, StorageError} from "./jsonFile";
import {dataPaths, deletablePaths} from "./paths";

interface Doc { name: string }
const parse = (value: unknown): Doc | null =>
  typeof value === "object" && value !== null && typeof (value as Doc).name === "string" ? {name: (value as Doc).name} : null;

describe("json file", () => {
  it("round-trips a plain document", async () => {
    const fs = createMemFs();
    const file = createJsonFile({fs, path: "/d/settings.json", parse});
    expect(await file.load()).toBeNull();
    await file.save({name: "clave"});
    expect(fs.text("/d/settings.json")).toBe('{"name":"clave"}');
    expect(await file.load()).toEqual({name: "clave"});
  });

  it("encrypts when given a cipher: the plain text is not on disk", async () => {
    const fs = createMemFs();
    const file = createJsonFile({fs, path: "/d/pool.bin", parse, cipher: createFakeCipher()});
    await file.save({name: "Traced a latency regression"});
    expect(fs.everything()).not.toContain("latency");
    expect(await file.load()).toEqual({name: "Traced a latency regression"});
  });

  it("deletes a file that cannot be decrypted, parsed or validated, and reports it", async () => {
    for (const bytes of ["garbage", '{"name": 5}', "{not json"]) {
      const fs = createMemFs();
      const onUnreadable = vi.fn();
      fs.files.set("/d/pool.bin", new TextEncoder().encode(bytes));
      const file = createJsonFile({fs, path: "/d/pool.bin", parse, onUnreadable, ...(bytes === "garbage" ? {cipher: createFakeCipher()} : {})});
      expect(await file.load()).toBeNull();
      expect(fs.files.has("/d/pool.bin")).toBe(false);
      expect(onUnreadable).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a throwing read as unreadable: removes the file if it can, reports it, and never rejects", async () => {
    const fs = createMemFs();
    fs.files.set("/d/pool.bin", new TextEncoder().encode('{"name":"x"}'));
    fs.failReads = true;
    const onUnreadable = vi.fn();
    const file = createJsonFile({fs, path: "/d/pool.bin", parse, onUnreadable});
    await expect(file.load()).resolves.toBeNull();
    expect(onUnreadable).toHaveBeenCalledTimes(1);
    expect(fs.files.has("/d/pool.bin")).toBe(false);
  });

  it("never rejects even when removing the unreadable file also fails", async () => {
    const fs = createMemFs();
    fs.failReads = true;
    const remove = fs.remove.bind(fs);
    fs.remove = async () => { await remove("/d/pool.bin"); throw new Error("EPERM"); };
    const onUnreadable = vi.fn();
    const file = createJsonFile({fs, path: "/d/pool.bin", parse, onUnreadable});
    await expect(file.load()).resolves.toBeNull();
    expect(onUnreadable).toHaveBeenCalledTimes(1);
  });

  it("returns null without deleting or reporting when the cipher is merely unavailable, not the file corrupt", async () => {
    const fs = createMemFs();
    fs.files.set("/d/pool.bin", new TextEncoder().encode("whatever bytes are on disk"));
    const onUnreadable = vi.fn();
    const file = createJsonFile({fs, path: "/d/pool.bin", parse, cipher: createFakeCipher(false), onUnreadable});
    expect(await file.load()).toBeNull();
    expect(fs.files.has("/d/pool.bin")).toBe(true);
    expect(onUnreadable).not.toHaveBeenCalled();
  });

  it("serialises save so two overlapping saves land in call order, not completion order", async () => {
    const fs = createMemFs();
    const realWrite = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, data) => {
      if (new TextDecoder().decode(data).includes("first")) await new Promise((r) => setTimeout(r, 20));
      await realWrite(path, data);
    };
    const file = createJsonFile({fs, path: "/d/a.json", parse});
    const first = file.save({name: "first"});
    const second = file.save({name: "second"});
    await Promise.all([first, second]);
    expect(fs.text("/d/a.json")).toBe('{"name":"second"}');
  });

  it("refuses to store anything when encryption is unavailable", async () => {
    const fs = createMemFs();
    const file = createJsonFile({fs, path: "/d/pool.bin", parse, cipher: createFakeCipher(false)});
    await expect(file.save({name: "x"})).rejects.toMatchObject({code: "STORAGE_UNAVAILABLE"});
    expect(fs.files.size).toBe(0);
  });

  it("reports a failed write with a fixed code", async () => {
    const fs = createMemFs();
    fs.failWrites = true;
    const file = createJsonFile({fs, path: "/d/settings.json", parse});
    const error = await file.save({name: "x"}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).message).toBe("STORAGE_WRITE_FAILED");
  });

  it("removes", async () => {
    const fs = createMemFs();
    const file = createJsonFile({fs, path: "/d/a.json", parse});
    await file.save({name: "x"});
    await file.remove();
    expect(await file.load()).toBeNull();
  });

  it("reports a failed remove with the same fixed code as a failed write", async () => {
    const fs = createMemFs();
    fs.remove = async () => { throw new Error("EPERM"); };
    const file = createJsonFile({fs, path: "/d/a.json", parse});
    const error = await file.remove().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("STORAGE_WRITE_FAILED");
  });
});

describe("paths", () => {
  it("lists every file, and deletion leaves only the model folder", () => {
    const paths = dataPaths("/data");
    expect(paths.pool).toBe("/data/pool.bin");
    expect(deletablePaths(paths)).toHaveLength(8);
    expect(deletablePaths(paths)).toContain(paths.screenGrant);
    expect(deletablePaths(paths)).not.toContain(paths.modelDir);
  });
});
