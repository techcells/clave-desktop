import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReaderClientEvent} from "./reader/readerClient";
import {createHarness, type Harness} from "./testing/harness";

const logCodes = (h: Harness): string[] =>
  (h.fs.text("/data/app.log") ?? "").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as {code: string}).code);

describe("engine: what the reader's supervisor reports goes to the log as a code", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("logs each of the six events under its own code", async () => {
    const h = createHarness();
    const engine = await h.launch();
    const events: ReaderClientEvent[] = ["HELPER_EXIT", "HELPER_START_TIMEOUT", "HELPER_WEDGED", "HELPER_PROTOCOL_MISMATCH", "HELPER_GAVE_UP", "HELPER_REPLACED"];
    for (const event of events) engine.noteReaderEvent(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(logCodes(h).filter((code) => code.startsWith("READER_"))).toEqual([
      "READER_HELPER_EXIT", "READER_HELPER_START_TIMEOUT", "READER_HELPER_WEDGED", "READER_PROTOCOL_MISMATCH", "READER_HELPER_GAVE_UP", "READER_HELPER_REPLACED"
    ]);
    await engine.quit();
  });

  it("writes nothing for a value that is not one of the six, whatever the caller claims its type is", async () => {
    const h = createHarness();
    const engine = await h.launch();
    const before = logCodes(h).length;
    engine.noteReaderEvent("the text of a window" as ReaderClientEvent);
    engine.noteReaderEvent("toString" as ReaderClientEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(logCodes(h)).toHaveLength(before);
    expect(h.fs.text("/data/app.log") ?? "").not.toContain("window");
    await engine.quit();
  });

  it("logs nothing after quit", async () => {
    const h = createHarness();
    const engine = await h.launch();
    await engine.quit();
    const before = logCodes(h).length;
    engine.noteReaderEvent("HELPER_EXIT");
    await vi.advanceTimersByTimeAsync(0);
    expect(logCodes(h)).toHaveLength(before);
  });
});
