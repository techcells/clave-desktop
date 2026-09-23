import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import type {ReaderClientEvent} from "../main/reader/readerClient";
import {createRealReader} from "./realReader";

// The helper as `pnpm --dir app build:native` leaves it. Where it has not been built (any machine
// without the Rust toolchain) this file skips instead of failing: the TypeScript suite must stay
// runnable everywhere.
const BINARY = fileURLToPath(new URL(`../../native/reader/target/release/clave-reader${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

describe.skipIf(!existsSync(BINARY))("the real clave-reader binary under the real client", () => {
  it("says ready, answers a permission question with a known value, and leaves by itself when asked", async () => {
    const events: ReaderClientEvent[] = [];
    const real = createRealReader({helperPath: BINARY, exists: existsSync, spawnChild: (path) => spawn(path, [], {stdio: ["pipe", "pipe", "pipe"]}), now: () => Date.now()});
    real.attach({noteReaderEvent: (event) => { events.push(event); }});
    const started = Date.now();
    void real.reader.permission();
    // The first recognition on a machine was measured at about 45 s; the client itself allows 90 s.
    while (real.reader.state() !== "ready") {
      if (Date.now() - started > 85_000) throw new Error("the helper never became ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Which value depends on who started the test run (a terminal may hold a grant of its own), so only
    // the vocabulary is asserted. Nothing is read from the screen here, and nothing is printed.
    expect(["granted", "denied", "needsRestart", "unknown"]).toContain(await real.reader.permission());
    const leaving = Date.now();
    await real.reader.dispose();
    expect(Date.now() - leaving).toBeLessThan(900);          // it left on `shutdown`; the 1 s kill was not needed
    expect(events).toEqual([]);                               // and none of it looked like a crash
  }, 95_000);
});
