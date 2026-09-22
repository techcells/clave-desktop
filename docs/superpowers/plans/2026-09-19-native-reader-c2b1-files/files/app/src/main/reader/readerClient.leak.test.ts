import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createFakeHelpers} from "../testing/fakeReaderHelper";
import {CLIENT_CALL_DEADLINE_MS, HELPER_BACKOFF_MAX_MS, HELPER_EXIT_LIMIT} from "./constants";
import {createReaderClient, ReaderDown, type ReaderClientEvent} from "./readerClient";

const MARKER = "SECRET-ON-SCREEN-4471";
/** The title main approved, which protocol 2 puts on the wire. A window title is the user's too. */
const APPROVED = "SECRET-WINDOW-TITLE-9082";
const EVENT_CODES: readonly ReaderClientEvent[] = ["HELPER_EXIT", "HELPER_START_TIMEOUT", "HELPER_WEDGED", "HELPER_PROTOCOL_MISMATCH", "HELPER_GAVE_UP", "HELPER_REPLACED"];

describe("reader client: nothing read from a screen leaves through a side channel", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("events are bare codes, errors carry no text, and nothing is written to the console or stderr", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });

    const helpers = createFakeHelpers();
    const events: unknown[][] = [];
    const client = createReaderClient({spawn: helpers.spawn, now: () => Date.now(), onEvent: (...args: unknown[]) => { events.push(args); }});
    const window = {app: MARKER, title: MARKER};

    void client.permission();
    helpers.latest().ready();
    await vi.advanceTimersByTimeAsync(0);

    const read = client.read({budgetMs: 1500, expect: {app: MARKER, bundleId: MARKER, title: APPROVED}});
    helpers.latest().answerLast({ok: true, window, text: MARKER, toolbarText: MARKER});
    expect(await read).toMatchObject({text: MARKER});                       // the caller gets it; nobody else does

    // The approved title goes to the helper's stdin and nowhere else. It reaches the one process
    // that has to know it, on the one channel that is meant to carry it, and the assertions at the
    // end of this test say that no event, error, console line or stream ever saw it.
    expect(helpers.latest().lastRead().expect).toEqual({app: MARKER, bundleId: MARKER, title: APPROVED});

    const bad = client.read({budgetMs: 1500, expect: {app: MARKER, title: APPROVED}});
    helpers.latest().emitRaw(`{"id": oops ${MARKER}`);                       // an unreadable line full of screen text
    await bad;

    const errors: unknown[] = [];
    const front = client.frontWindow().catch((error: unknown) => { errors.push(error); });
    await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);             // wedged → killed → HELPER_WEDGED, HELPER_EXIT
    await front;
    for (let i = 0; i < HELPER_EXIT_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(HELPER_BACKOFF_MAX_MS);
      helpers.latest().emitRaw(MARKER);
      helpers.latest().exit();
    }
    await client.dispose();

    expect(events.length).toBeGreaterThan(3);
    for (const args of events) {
      expect(args).toHaveLength(1);
      expect(EVENT_CODES).toContain(args[0]);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ReaderDown);
    expect(String((errors[0] as Error).message)).toBe("READER_DOWN");
    expect(JSON.stringify((errors[0] as Error).stack ?? "")).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(APPROVED);
    expect(JSON.stringify(events)).not.toContain(APPROVED);
    expect(JSON.stringify(errors.map((error) => [(error as Error).message, (error as Error).stack ?? ""]))).not.toContain(APPROVED);
  });
});
