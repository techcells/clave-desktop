import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {HELPER_MAX_LINE_CHARS} from "../main/reader/constants";
import {parseLine} from "../main/reader/protocol";
import {createReaderClient, type ReaderClientEvent} from "../main/reader/readerClient";
import {createChildHelperLink, createLineSplitter, HELPER_OVERLONG_LINE, PRE_REGISTRATION_LINES_MAX} from "./readerLink";

const SCRIPT = fileURLToPath(new URL("./testing/fakeHelperProcess.mjs", import.meta.url));
const helper = (mode: string) => () => createChildHelperLink(() => spawn(process.execPath, [SCRIPT, mode], {stdio: ["pipe", "pipe", "pipe"]}));

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A child process just real enough for the link: the three streams and the two events it listens to. */
function fakeChild(): ChildProcessWithoutNullStreams & {stdout: PassThrough} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true
  });
  return child as unknown as ChildProcessWithoutNullStreams & {stdout: PassThrough};
}

/** Long enough for what was written to a stream to reach the link. */
const flushed = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

describe("reader link: lines that arrive before the client is listening", () => {
  // Delivered on a later turn, never from inside `onLine`: the client registers `onLine` before it
  // has put the new helper into `current` or `replacement`, so a line handed back re-entrantly is
  // handled against a helper the client does not know about yet. That cost it a `ready` — a
  // mismatching one used to wedge it in "starting" for ever. The client is robust against it now
  // (`readerClient.test.ts`), and this end keeps its side of the bargain as well.
  it("delivers them, in order, on a later turn — never from inside `onLine`", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    child.stdout.write('{"event":"ready","protocol":2}\n{"event":"focus"}\n');
    await flushed();                               // the helper has spoken; nobody was listening yet

    const seen: string[] = [];
    link.onLine((line) => seen.push(line));
    expect(seen).toEqual([]);                      // not re-entrantly, from inside the registration
    // A line that arrives in the gap must not overtake them: order is order, whatever the timing.
    child.stdout.emit("data", Buffer.from('{"id":1,"permission":"granted"}\n'));
    expect(seen).toEqual([]);
    await flushed();
    expect(seen).toEqual(['{"event":"ready","protocol":2}', '{"event":"focus"}', '{"id":1,"permission":"granted"}']);

    child.stdout.write('{"id":2,"permission":"denied"}\n');
    await flushed();
    expect(seen).toHaveLength(4);                  // and from then on straight through
  });

  // Bounded, and what overflows is the END of the burst: the beginning is `ready`, which is the
  // whole reason to keep anything. Filling these already means the client broke its half of the
  // contract, so the lines that go are answers to calls nobody made.
  it("holds a bounded number of them, keeping the first: a helper talking into the void cannot grow main", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    child.stdout.write('{"event":"ready","protocol":2}\n');
    for (let i = 0; i < PRE_REGISTRATION_LINES_MAX + 36; i++) child.stdout.write(`{"id":${i}}\n`);
    await flushed();

    const seen: string[] = [];
    link.onLine((line) => seen.push(line));
    await flushed();
    expect(seen).toHaveLength(PRE_REGISTRATION_LINES_MAX);
    expect(seen[0]).toBe('{"event":"ready","protocol":2}');                   // the line it is all for
    expect(seen[1]).toBe('{"id":0}');
    expect(seen.at(-1)).toBe(`{"id":${PRE_REGISTRATION_LINES_MAX - 2}}`);     // and the newest went
  });
});

describe("reader link: a pipe that fails", () => {
  /**
   * An `error` event with no listener is thrown — in Electron's main process, which is the one
   * process the user cannot afford to lose, for a helper that is replaceable. stdin has had a
   * listener since C-1 (a write to a helper that has just died is an EPIPE); the read ends are the
   * same hazard from the other direction, and the helper's death arrives through `exit` regardless.
   */
  it("survives an error on any of the three pipes, and keeps working", async () => {
    const child = fakeChild();
    const link = createChildHelperLink(() => child);
    const seen: string[] = [];
    link.onLine((line) => seen.push(line));

    expect(() => child.stdout.emit("error", new Error("EIO"))).not.toThrow();
    expect(() => child.stderr.emit("error", new Error("EIO"))).not.toThrow();
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();

    child.stdout.write('{"event":"focus"}\n');
    await flushed();
    expect(seen).toEqual(['{"event":"focus"}']);
  });
});

describe("reader link: the line splitter", () => {
  const collect = (): {lines: string[]; splitter: ReturnType<typeof createLineSplitter>} => {
    const lines: string[] = [];
    return {lines, splitter: createLineSplitter((line) => lines.push(line))};
  };

  it("splits several lines out of one chunk, and joins one line out of several chunks", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.push(Buffer.from("3}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(splitter.pending()).toBe(0);
  });

  it("strips a carriage return, and keeps an empty line empty", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"a":1}\r\n\r\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', "", '{"b":2}']);
  });

  it("keeps a character whose bytes are split across two chunks", () => {
    const {lines, splitter} = collect();
    const bytes = Buffer.from('{"text":"línea dos ✓"}\n');
    splitter.push(bytes.subarray(0, 12));          // cuts the í in half
    splitter.push(bytes.subarray(12, 22));         // and the ✓ too
    splitter.push(bytes.subarray(22));
    expect(lines).toEqual(['{"text":"línea dos ✓"}']);
  });

  it("drops a line that was never terminated when the stream ends", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from('{"half":'));
    splitter.end();
    expect(lines).toEqual([]);
    expect(splitter.pending()).toBe(0);
  });

  // Ten megabytes and no newline: `readline` would have held every byte of it in main, because the
  // cap used to be checked only once the line had arrived.
  it("never buffers a line past the cap, and reports it exactly once", () => {
    const {lines, splitter} = collect();
    const chunk = Buffer.from("x".repeat(1_000_000));
    for (let i = 0; i < 10; i++) {
      splitter.push(chunk);
      expect(splitter.pending()).toBeLessThanOrEqual(HELPER_MAX_LINE_CHARS + chunk.length);
    }
    expect(lines).toEqual([HELPER_OVERLONG_LINE]);
    expect(splitter.pending()).toBe(0);

    splitter.push(Buffer.from('\n{"back":"in step"}\n'));   // the rest of it, then a real line
    expect(lines).toEqual([HELPER_OVERLONG_LINE, '{"back":"in step"}']);
  });

  it("reports an over-long line that does end, rather than handing it on to be refused later", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from(`${"x".repeat(HELPER_MAX_LINE_CHARS + 1)}\n{"next":1}\n`));
    expect(lines).toEqual([HELPER_OVERLONG_LINE, '{"next":1}']);
  });

  it("keeps a line of exactly the cap, which is what the parser still accepts", () => {
    const {lines, splitter} = collect();
    splitter.push(Buffer.from(`${"x".repeat(HELPER_MAX_LINE_CHARS)}\n`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(HELPER_MAX_LINE_CHARS);
  });

  // The marker stands in for a line the client must refuse: it only behaves like the over-long line
  // it replaces because the protocol's own parser throws it away.
  it("reports it with something the protocol parser refuses", () => {
    expect(parseLine(HELPER_OVERLONG_LINE)).toBeNull();
  });
});

describe("reader link: a real child process speaking the line protocol", () => {
  it("carries every call through the client, accents and symbols intact, and leaves when asked", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({spawn: helper("normal"), now: () => Date.now(), onEvent: (e) => events.push(e)});
    let focus = 0;
    client.onFocusChange(() => { focus += 1; });
    await until(() => client.state() === "ready");

    expect(await client.permission()).toBe("granted");
    expect(await client.frontWindow()).toEqual({app: "Fake", title: "fake window"});
    expect(await client.read({budgetMs: 1500, expect: {app: "Fake", title: "fake window"}}))
      .toEqual({ok: true, window: {app: "Fake", title: "fake window"}, text: "line one\nlínea dos ✓"});
    // The approved window really travelled down the pipe: this helper refuses anything else, and
    // the answer's own `stats` is stripped by the port before the caller ever sees it.
    expect(await client.read({budgetMs: 1500, expect: {app: "1Password", title: "Vault"}}))
      .toEqual({ok: false, reason: "windowGone"});
    expect(focus).toBe(2);
    await client.requestPermission();

    await client.dispose();
    expect(events).toEqual([]);                                  // a clean shutdown is not a crash
  });

  it("is not blocked by a helper that floods its stderr", async () => {
    const client = createReaderClient({spawn: helper("noisy"), now: () => Date.now()});
    void client.permission();
    await until(() => client.state() === "ready");
    expect(await client.permission()).toBe("granted");
    await client.dispose();
  });

  it("kills a helper that ignores both shutdown and its input being closed", async () => {
    const client = createReaderClient({spawn: helper("stubborn"), now: () => Date.now()});
    void client.permission();
    await until(() => client.state() === "ready");
    const started = Date.now();
    await client.dispose();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);    // it was given its grace period first
  }, 10_000);

  // The cap in the splitter and the cap in `parseLine` have to agree end to end: an over-long line
  // costs the call that was in flight and nothing else — the helper is not killed (C-1 decision D6)
  // and the pipe is back in step at the next newline.
  it("loses the call a helper answers with a line past the cap, and nothing else", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({spawn: helper("overlong"), now: () => Date.now(), onEvent: (e) => events.push(e)});
    void client.permission();
    await until(() => client.state() === "ready");

    expect(await client.permission()).toBe("unknown");
    expect(client.state()).toBe("ready");
    expect(await client.permission()).toBe("granted");
    expect(events).toEqual([]);
    await client.dispose();
  });

  it("a binary that does not exist shows up as an exit, not as a thrown error", async () => {
    const events: ReaderClientEvent[] = [];
    const client = createReaderClient({
      spawn: () => createChildHelperLink(() => spawn("/nonexistent/clave-reader", [], {stdio: ["pipe", "pipe", "pipe"]})),
      now: () => Date.now(), onEvent: (e) => events.push(e)
    });
    expect(await client.permission()).toBe("unknown");
    await until(() => events.includes("HELPER_EXIT"));
    await client.dispose();
  });
});
