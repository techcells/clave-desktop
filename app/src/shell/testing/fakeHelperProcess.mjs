// A scripted stand-in for the native reader helper, as a REAL child process, for readerLink.test.ts.
// argv[2]: "normal" (default) | "stubborn" (ignores its input being closed) | "noisy" (also writes to
// stderr) | "overlong" (answers its first call with one line past main's cap, then behaves)
import {writeSync} from "node:fs";
import {createInterface} from "node:readline";

const mode = process.argv[2] ?? "normal";
const say = (message) => process.stdout.write(JSON.stringify(message) + "\n");
// A blocking write straight to fd 2, as a native helper would do it: if the parent does not drain
// stderr, this never returns and `ready` is never sent.
if (mode === "noisy") writeSync(2, "STDERR-NOISE-MUST-BE-IGNORED\n".repeat(20000));
say({event: "ready", protocol: 3});

// The one window this stand-in ever has in front. Protocol 2: a read says which window main
// approved, and anything else is refused without a capture — so this fake refuses too, which is how
// readerLink.test.ts can see that `expect` really travelled down the pipe.
const FRONT = {app: "Fake", title: "fake window"};
const approved = (expect) => expect !== null && typeof expect === "object"
  && expect.app === FRONT.app && expect.title === FRONT.title && expect.bundleId === undefined;

// One line longer than HELPER_MAX_LINE_CHARS (2,000,000), written once: a helper with a runaway
// buffer, seen from the other end of a real pipe. Main must refuse it without holding it.
let flooded = false;

const lines = createInterface({input: process.stdin});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.op === "shutdown") { if (mode !== "stubborn") process.exit(0); return; }
  if (mode === "overlong" && !flooded) { flooded = true; process.stdout.write(`${"x".repeat(2_100_000)}\n`); return; }
  if (message.op === "permission") say({id: message.id, permission: "granted"});
  else if (message.op === "frontWindow") say({id: message.id, window: FRONT});
  else if (message.op === "read") {
    say({event: "focus"});
    if (!approved(message.expect)) say({id: message.id, ok: false, reason: "windowGone"});
    else say({id: message.id, ok: true, window: FRONT, text: "line one\nlínea dos ✓", stats: {captureMs: 3, cacheHit: false}});
  }
  else if (message.op === "requestPermission") say({id: message.id});
  // Protocol 3: a grant answered the way a Linux helper does once a session starts with it.
  else if (message.op === "grant") say({event: "grant", token: `${message.token}-next`});
});
lines.on("close", () => { if (mode !== "stubborn") process.exit(0); });
if (mode === "stubborn") setInterval(() => undefined, 1000);
