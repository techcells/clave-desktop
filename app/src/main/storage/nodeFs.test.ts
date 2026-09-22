import {mkdir, mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createNodeFs} from "./nodeFs";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

describe("node file system", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "clave-fs-")); });
  afterEach(async () => { await rm(dir, {recursive: true, force: true}); });

  it("reads null and size 0 for a missing file", async () => {
    const fs = createNodeFs();
    expect(await fs.read(join(dir, "nope"))).toBeNull();
    expect(await fs.size(join(dir, "nope"))).toBe(0);
  });

  it("writes atomically, creating folders, and leaves no temporary file", async () => {
    const fs = createNodeFs();
    const path = join(dir, "nested", "a.json");
    await fs.writeAtomic(path, bytes("one"));
    await fs.writeAtomic(path, bytes("two"));
    expect(text(await fs.read(path))).toBe("two");
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });

  it("appends and reports the size", async () => {
    const fs = createNodeFs();
    const path = join(dir, "log");
    await fs.append(path, bytes("ab"));
    await fs.append(path, bytes("cd"));
    expect(text(await fs.read(path))).toBe("abcd");
    expect(await fs.size(path)).toBe(4);
  });

  it("gives each concurrent writeAtomic call its own temporary name, so both resolve and only one file remains", async () => {
    const fs = createNodeFs();
    const path = join(dir, "shared.json");
    await Promise.all([fs.writeAtomic(path, bytes("one")), fs.writeAtomic(path, bytes("two"))]);
    const entries = await readdir(dir);
    expect(entries).toEqual(["shared.json"]);
    expect(["one", "two"]).toContain(text(await fs.read(path)));
  });

  it("removes its temporary file when the rename fails, instead of leaving it behind", async () => {
    const fs = createNodeFs();
    const path = join(dir, "target");
    await mkdir(path); // renaming a file over a directory fails, so writeAtomic must reject
    await expect(fs.writeAtomic(path, bytes("x"))).rejects.toThrow();
    const entries = await readdir(dir);
    expect(entries).toEqual(["target"]);
  });

  it("removes, and removing twice is fine", async () => {
    const fs = createNodeFs();
    const path = join(dir, "a");
    await fs.writeAtomic(path, bytes("x"));
    await fs.remove(path);
    await fs.remove(path);
    expect(await fs.read(path)).toBeNull();
  });
});
