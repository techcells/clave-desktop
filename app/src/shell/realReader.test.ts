import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import type {ReaderClientEvent} from "../main/reader/readerClient";
import {chooseHelperPath, createRealReader} from "./realReader";

const SCRIPT = fileURLToPath(new URL("./testing/fakeHelperProcess.mjs", import.meta.url));
const asHelper = () => spawn(process.execPath, [SCRIPT, "normal"], {stdio: ["pipe", "pipe", "pipe"]});

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("where the helper is looked for", () => {
  const beside = "/Applications/Clave Agent.app/Contents/MacOS/clave-reader";
  const inDist = "/checkout/app/dist/native/clave-reader";
  it("prefers the helper next to the executable, the layout the grant was measured in", () => {
    expect(chooseHelperPath([beside, inDist], () => true)).toBe(beside);
  });
  it("falls back to dist/native for a run from the checkout", () => {
    expect(chooseHelperPath([beside, inDist], (path) => path === inDist)).toBe(inDist);
  });
  it("reports the first place when the helper is nowhere, so the start failure names the expected layout", () => {
    expect(chooseHelperPath([beside, inDist], () => false)).toBe(beside);
  });
});

describe("the real reader as the app builds it", () => {
  it("refuses to be built without the helper binary, with a fixed code and without starting anything", () => {
    let spawned = 0;
    expect(() => createRealReader({helperPath: "/app/dist/native/clave-reader", exists: () => false, spawnChild: () => { spawned += 1; return asHelper(); }, now: () => Date.now()}))
      .toThrow("READER_HELPER_MISSING");
    expect(spawned).toBe(0);
  });

  it("starts the helper at the given path and reads through it", async () => {
    const paths: string[] = [];
    const real = createRealReader({helperPath: "/app/dist/native/clave-reader", exists: () => true, spawnChild: (path) => { paths.push(path); return asHelper(); }, now: () => Date.now()});
    void real.reader.permission();
    await until(() => real.reader.state() === "ready");
    expect(paths).toEqual(["/app/dist/native/clave-reader"]);
    expect(await real.reader.permission()).toBe("granted");
    await real.reader.dispose();
  });

  it("keeps the events that happen before the engine exists and hands them over in order, then passes later ones straight on", async () => {
    const real = createRealReader({
      helperPath: "/nonexistent/clave-reader", exists: () => true,
      spawnChild: (path) => spawn(path, [], {stdio: ["pipe", "pipe", "pipe"]}),      // cannot start: an exit, not a throw
      now: () => Date.now()
    });
    const seen: ReaderClientEvent[] = [];
    void real.reader.permission();
    await until(() => real.reader.state() === "waiting");
    expect(seen).toEqual([]);
    real.attach({noteReaderEvent: (event) => { seen.push(event); }});
    expect(seen).toEqual(["HELPER_EXIT"]);
    await until(() => seen.length >= 2, 3_000);                                     // the restart fails too, and arrives directly
    expect(seen.every((event) => event === "HELPER_EXIT")).toBe(true);
    await real.reader.dispose();
  });
});
