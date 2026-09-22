# Native Reader Phase 0 (Spikes P1 to P6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the six open questions of the native reader spec with measurements, write the findings into the spec's results table, and leave nothing behind in `app/`.

**Architecture:** One throwaway Swift probe (capture, recognise, serve, soak) answers every question that does not depend on the language. A re-signed copy of the dev `Electron.app` with its own bundle id hosts the probe so the Screen Recording grant is attributed as it will be in the product. One throwaway Rust probe answers only P3 (can Rust drive ScreenCaptureKit and Vision). Staged windows with known text and a Python scorer give the accuracy numbers.

**Tech Stack:** Swift 6.4 (`swiftc`, already installed, no downloads), Python 3.14 standard library (already installed), Electron 44.4.1 (already in `app/node_modules`), Rust 1.98.1 at `/opt/homebrew/opt/rustup/bin` with the `objc2` crate family (the ONLY download in this plan, Task 5, needs the owner's approval at that moment).

**Spec:** `docs/superpowers/specs/2026-09-18-native-reader-design.md` (sections 6 and 10). Per its decision 2, the build plan for C is written only after this plan has reported, without branches.

## Global Constraints

- NO git at all: no init, commit, branch, push. Tasks end with a "Checkpoint" step instead.
- Never `cd`. Every command uses absolute paths. Project scripts run as `pnpm --dir app <script>` from the repo root `/Users/sardorastanov/techcells/asset-to-evidence`.
- No downloads or installs without the owner's approval for that execution. Task 5 Step 2 is the only download. Ask before it; if refused, record P3 as "not run".
- All spike code lives in `$SPIKE`, defined as `<the executing session's scratchpad directory>/reader-spikes`. Nothing is created under `app/`. Wherever this plan writes `$SPIKE`, substitute that absolute path; shell state does not persist between commands, so start each command with `SPIKE=<absolute path>;`.
- The Rust toolchain is NOT on PATH. Call `/opt/homebrew/opt/rustup/bin/cargo` by absolute path and pass `--manifest-path`.
- The probe may only ever be pointed at STAGED windows (the spike's own Chrome profile, the staged Terminal window, a Safari window showing a staged page). Never run `read` or `soak` against a window with the owner's real content. Output files stay in `$SPIKE/out` and are deleted in Task 9.
- The executor must NOT do these; they are the owner's steps and are marked **OWNER**: creating the signing certificate in Keychain Access, granting or revoking Screen Recording in System Settings, running `tccutil`, opening a Safari private window.
- Launch the host app ONLY with `open -n` (LaunchServices). Started from a terminal, macOS attributes screen access to the terminal program instead of the app, and every finding would be wrong.
- Pass thresholds are copied from the spec and must not be lowered: P3 median under 400 ms and memory flat over 1,000 reads; P4 character accuracy at least 97% chat and tickets, 95% terminal, 95% Portuguese with accents kept, 90% code; P5 address host in at least 19 of 20 captures and the private label in 20 of 20. A shortfall is reported to the owner with the numbers.
- Each task is reviewed independently before the next one starts: the reviewer re-runs the task's measurement command and compares its numbers with the recorded finding.
- Existing state must not change: after Task 9, `pnpm --dir app test` still reports 768 passing tests.

## File Structure

Everything below is under `$SPIKE` and is throwaway.

| Path | Responsibility |
|---|---|
| `truth/chat.txt`, `ticket.txt`, `code.txt`, `pt.txt`, `terminal.txt` | The known text of each staged window |
| `tools/make_pages.py` | Turns the truth files into staged HTML pages |
| `tools/score.py` | Character accuracy of a probe `read` answer against a truth file; has a self-test |
| `stage/www/*.html` | Generated pages, served on `127.0.0.1:8765` |
| `stage/terminal.command` | Opens Terminal showing `truth/terminal.txt` |
| `probe/main.swift` | The Swift probe: `check`, `request`, `read`, `serve`, `soak` |
| `host/ClaveReaderSpike.app` | Re-signed copy of the dev Electron with bundle id `dev.clave.readerspike`, the probe inside it, and `main.js` |
| `rust/` | The Rust probe for P3 |
| `out/` | Every measurement output; deleted in Task 9 |
| `FINDINGS.md` | One section per spike, written as each task ends; copied into the spec in Task 9 |

---

### Task 1: Workspace, staged content and the scorer

**Files:**
- Create: `$SPIKE/truth/chat.txt`, `ticket.txt`, `code.txt`, `pt.txt`, `terminal.txt`
- Create: `$SPIKE/tools/score.py`, `$SPIKE/tools/make_pages.py`
- Create: `$SPIKE/stage/terminal.command`

**Interfaces:**
- Produces: `python3 $SPIKE/tools/score.py <read.json> <truth.txt>` printing `{"accuracy": float, "markers": bool, "accents": float}`; pages at `http://127.0.0.1:8765/<name>.html?theme=light|dark&size=<px>`; every page wraps its text between the words `STARTMARKER` and `ENDMARKER`.

- [ ] **Step 1: Create the folders**

```bash
SPIKE=<absolute path>; mkdir -p "$SPIKE"/{truth,tools,stage/www,probe,host,rust,out}
```

- [ ] **Step 2: Write the truth files**

`$SPIKE/truth/chat.txt`:
```
Marta Oliveira 09:12
Morning team, the checkout latency alert fired again at 03:40.
Dev Patel 09:14
I saw it. The p95 went from 180 ms to 920 ms for about six minutes.
Marta Oliveira 09:15
Was it the payment provider or our side?
Dev Patel 09:17
Ours. The retry queue doubled every message after the deploy.
I rolled back the consumer and opened a ticket with the trace.
Marta Oliveira 09:18
Thanks. Can you write the post-mortem by Thursday?
Dev Patel 09:19
Yes. I will add a load test that replays 5,000 orders first.
```

`$SPIKE/truth/ticket.txt`:
```
PLAT-2841 Retry queue duplicates messages after consumer restart
Status: In Review    Priority: High    Assignee: Dev Patel
Description
After a rolling restart the consumer acknowledges a message twice.
The second acknowledgement re-enqueues it with a fresh visibility timeout.
Steps to reproduce
1. Publish 200 orders to the staging queue.
2. Restart two of the three consumers within 10 seconds.
3. Count deliveries per order id: about 14% arrive twice.
Acceptance criteria
Each order id is delivered exactly once across 10 restarts.
The fix ships behind the flag consumer.idempotent_ack.
```

`$SPIKE/truth/code.txt`:
```
export async function ackOnce(msg: QueueMessage, seen: Set<string>): Promise<boolean> {
  const key = `${msg.orderId}:${msg.attempt}`;
  if (seen.has(key)) { return false; }
  seen.add(key);
  try {
    await queue.ack(msg.receipt, { timeoutMs: 2_500 });
  } catch (err) {
    seen.delete(key);
    throw new AckError(`ack failed for ${key}`, { cause: err });
  }
  return msg.attempt <= MAX_ATTEMPTS && !msg.flags["dead-letter"];
}
const retries = items.filter((i) => i.status !== "done").map((i) => i.id);
```

`$SPIKE/truth/pt.txt`:
```
Reunião de revisão do sprint, terça-feira às 14h30
A migração do serviço de autenticação não está concluída.
João: já corrigi a validação do endereço e a paginação.
Conceição: faltam três testes de integração e a documentação.
Decisão: adiamos a publicação para a próxima semana.
Ações: atualizar o calendário, avisar o cliente e rever o orçamento.
Observação: a versão de produção também precisa de atenção.
```

`$SPIKE/truth/terminal.txt`:
```
$ pnpm --dir app test
 RUN  v5.0.1 /Users/dev/clave-agent/app
 ✓ src/core/scrub.test.ts (41 tests) 38ms
 ✓ src/main/capture/loop.test.ts (57 tests) 212ms
 ❯ src/main/reader/supervisor.test.ts (12 tests | 1 failed) 96ms
   × restarts with backoff after an unplanned exit
     AssertionError: expected 500 to be 1000
 Test Files  1 failed | 63 passed (64)
      Tests  1 failed | 767 passed (768)
$ git log --oneline -3
a41f9c2 fix(loop): abandon reader calls on stop
77be013 feat(shell): refuse to start a packaged build on stand-ins
```

- [ ] **Step 3: Write the scorer**

`$SPIKE/tools/score.py`:
```python
#!/usr/bin/env python3
"""THROWAWAY spike tool. Character accuracy of a probe `read` answer against known text."""
import json
import re
import sys
import unicodedata

ACCENTED = "áàâãçéêíóôõúÁÀÂÃÇÉÊÍÓÔÕÚ"


def norm(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def between(text):
    m = re.search(r"STARTMARKER(.*)ENDMARKER", text, re.S | re.I)
    return (m.group(1), True) if m else (text, False)


def accuracy(ocr, truth):
    o, t = norm(ocr), norm(truth)
    return max(0.0, 1 - lev(o, t) / max(1, len(t)))


def accents(ocr, truth):
    o = unicodedata.normalize("NFC", ocr)
    t = unicodedata.normalize("NFC", truth)
    want = sum(t.count(c) for c in ACCENTED)
    got = sum(min(o.count(c), t.count(c)) for c in ACCENTED)
    return 1.0 if want == 0 else got / want


def selftest():
    assert lev("kitten", "sitting") == 3
    assert accuracy("hello world", "hello  world") == 1.0
    assert between("tab bar STARTMARKER body ENDMARKER footer") == (" body ", True)
    assert between("no markers") == ("no markers", False)
    assert abs(accuracy("helo world", "hello world") - (1 - 1 / 11)) < 1e-9
    assert accents("nao esta", "não está") == 0.0
    assert accents("não está", "não está") == 1.0
    print("SELFTEST OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
        sys.exit(0)
    read = json.load(open(sys.argv[1], encoding="utf-8"))
    truth = open(sys.argv[2], encoding="utf-8").read()
    body, found = between(read.get("text", ""))
    print(json.dumps({"accuracy": round(accuracy(body, truth), 4), "markers": found,
                      "accents": round(accents(body, truth), 4)}))
```

- [ ] **Step 4: Run the scorer's self-test**

Run: `SPIKE=<absolute path>; python3 "$SPIKE/tools/score.py" --selftest`
Expected: `SELFTEST OK`

- [ ] **Step 5: Write the page generator**

`$SPIKE/tools/make_pages.py`:
```python
#!/usr/bin/env python3
"""THROWAWAY spike tool. Builds one staged HTML page per truth file."""
import html
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
STYLE = """
body{margin:24px;font:14px -apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#1d1c1d}
body.dark{background:#1a1d21;color:#d1d2d3}
.marker{font:12px Menlo,monospace;opacity:.6;margin:8px 0}
.chat .l{padding:3px 0}.chat .l.name{font-weight:700;margin-top:10px}
.ticket .l{padding:4px 0;border-bottom:1px solid #8883}
.code .l,.terminal .l{font-family:Menlo,Monaco,monospace;white-space:pre}
"""
SCRIPT = """
const q=new URLSearchParams(location.search);
if(q.get('theme')==='dark')document.body.classList.add('dark');
if(q.get('size'))document.body.style.fontSize=q.get('size')+'px';
"""
for name in ["chat", "ticket", "code", "pt"]:
    lines = (root / "truth" / f"{name}.txt").read_text(encoding="utf-8").splitlines()
    kind = "chat" if name in ("chat", "pt") else name
    rows = []
    for line in lines:
        cls = "l name" if kind == "chat" and re.search(r"\d\d:\d\d$", line) else "l"
        rows.append(f'<div class="{cls}">{html.escape(line)}</div>')
    page = (f'<!doctype html><meta charset="utf-8"><title>Staged {name}</title><style>{STYLE}</style>'
            f'<body class="{kind}"><div class="marker">STARTMARKER</div>{"".join(rows)}'
            f'<div class="marker">ENDMARKER</div><script>{SCRIPT}</script>')
    (root / "stage" / "www" / f"{name}.html").write_text(page, encoding="utf-8")
print("PAGES OK")
```

- [ ] **Step 6: Generate the pages and write the terminal stage**

Run: `SPIKE=<absolute path>; python3 "$SPIKE/tools/make_pages.py" "$SPIKE"`
Expected: `PAGES OK`, and four files in `$SPIKE/stage/www/`.

`$SPIKE/stage/terminal.command` (replace `<absolute path>` inside the file too, then `chmod +x` it):
```bash
#!/bin/bash
clear
echo STARTMARKER
cat "<absolute path>/truth/terminal.txt"
echo ENDMARKER
sleep 3600
```

Run: `SPIKE=<absolute path>; chmod +x "$SPIKE/stage/terminal.command"`

- [ ] **Step 7: Checkpoint**

Confirm: self-test printed `SELFTEST OK`; `ls "$SPIKE/stage/www"` lists `chat.html code.html pt.html ticket.html`; nothing was created under `app/`.

---

### Task 2: The Swift probe

**Files:**
- Create: `$SPIKE/probe/main.swift`
- Build output: `$SPIKE/probe/clave-reader-probe`

**Interfaces:**
- Produces, one JSON object per line on stdout:
  - `clave-reader-probe check --owner <App Name>` → `{"preflight":bool,"titles":int,"window":bool,"capture":"ok"|"black"|"noWindow"|"error","errorDomain"?:string,"errorCode"?:int,"width"?:int,"height"?:int}`. Never prints text or titles.
  - `clave-reader-probe request` → `{"requested":bool}` (triggers the system prompt).
  - `clave-reader-probe read --owner <App Name>` → the `check` fields plus `"text":string,"lines":[{"text":string,"topPx":int,"bottomPx":int}],"captureMs":int,"recogniseMs":int`.
  - `clave-reader-probe serve` → reads lines `check <App Name>` or `quit` on stdin, answers each with a `check` object.
  - `clave-reader-probe soak --owner <App Name> --n <count>` → every 100 reads `{"reads":int,"medianMs":int,"rssMB":float}`.
- `--owner` picks the topmost normal window (layer 0, at least 100 by 100 points) owned by that app name, from the window server list, which is ordered front to back.

- [ ] **Step 1: Write the probe**

`$SPIKE/probe/main.swift`:
```swift
// THROWAWAY spike code. Never copy into app/.
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

func emit(_ d: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: "--\(name)"), i + 1 < a.count else { return nil }
  return a[i + 1]
}

enum ProbeError: Error { case noWindow }

func windowList() -> [[String: Any]] {
  CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}

/// How many on-screen windows reveal a title: zero without the Screen Recording grant.
func titledCount() -> Int {
  windowList().filter { !(($0[kCGWindowName as String] as? String) ?? "").isEmpty }.count
}

func topWindow(owner: String) -> CGWindowID? {
  for w in windowList() {
    guard (w[kCGWindowOwnerName as String] as? String) == owner,
          (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          ((b["Width"] as? NSNumber)?.doubleValue ?? 0) >= 100,
          ((b["Height"] as? NSNumber)?.doubleValue ?? 0) >= 100,
          let id = w[kCGWindowNumber as String] as? NSNumber else { continue }
    return CGWindowID(id.uint32Value)
  }
  return nil
}

func capture(_ id: CGWindowID) async throws -> CGImage {
  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  guard let w = content.windows.first(where: { $0.windowID == id }) else { throw ProbeError.noWindow }
  let filter = SCContentFilter(desktopIndependentWindow: w)
  let cfg = SCStreamConfiguration()
  let scale = CGFloat(filter.pointPixelScale)
  cfg.width = Int(filter.contentRect.width * scale)
  cfg.height = Int(filter.contentRect.height * scale)
  cfg.showsCursor = false
  cfg.ignoreShadowsSingleWindow = true
  return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
}

func isBlack(_ img: CGImage) -> Bool {
  guard let data = img.dataProvider?.data, let p = CFDataGetBytePtr(data) else { return true }
  let bpp = img.bitsPerPixel / 8
  for gy in 0..<16 {
    for gx in 0..<16 {
      let x = (img.width - 1) * gx / 15, y = (img.height - 1) * gy / 15
      let o = y * img.bytesPerRow + x * bpp
      if p[o] > 8 || p[o + 1] > 8 || p[o + 2] > 8 { return false }
    }
  }
  return true
}

func gray(_ img: CGImage) -> CGImage {
  let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  return ctx.makeImage()!
}

struct Line { let text: String; let x: Double; let top: Double; let bottom: Double }

func recognise(_ img: CGImage) throws -> [Line] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  req.recognitionLanguages = ["en-US", "pt-BR"]
  try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
  return (req.results ?? []).compactMap { o in
    guard let c = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox  // normalised, origin bottom-left
    return Line(text: c.string, x: b.minX, top: 1 - b.maxY, bottom: 1 - b.minY)
  }
}

/// Top to bottom; lines whose tops differ by less than half a line height are one row, ordered left to right.
func ordered(_ lines: [Line]) -> [Line] {
  var rows: [[Line]] = []
  for l in lines.sorted(by: { $0.top < $1.top }) {
    if let first = rows.last?.first, abs(l.top - first.top) < (first.bottom - first.top) * 0.5 {
      rows[rows.count - 1].append(l)
    } else {
      rows.append([l])
    }
  }
  return rows.flatMap { $0.sorted { $0.x < $1.x } }
}

func check(owner: String, withText: Bool) async -> [String: Any] {
  var out: [String: Any] = ["preflight": CGPreflightScreenCaptureAccess(), "titles": titledCount()]
  guard let id = topWindow(owner: owner) else { out["window"] = false; out["capture"] = "noWindow"; return out }
  out["window"] = true
  do {
    let t0 = Date()
    let img = try await capture(id)
    let t1 = Date()
    out["width"] = img.width; out["height"] = img.height
    if isBlack(img) { out["capture"] = "black"; return out }
    out["capture"] = "ok"
    if withText {
      let lines = ordered(try recognise(gray(img)))
      out["captureMs"] = Int(t1.timeIntervalSince(t0) * 1000)
      out["recogniseMs"] = Int(Date().timeIntervalSince(t1) * 1000)
      out["text"] = lines.map(\.text).joined(separator: "\n")
      out["lines"] = lines.map { ["text": $0.text, "topPx": Int($0.top * Double(img.height)), "bottomPx": Int($0.bottom * Double(img.height))] }
    }
  } catch ProbeError.noWindow {
    out["capture"] = "noWindow"
  } catch {
    let e = error as NSError
    out["capture"] = "error"; out["errorDomain"] = e.domain; out["errorCode"] = e.code
  }
  return out
}

func rssMB() -> Double {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
  let kr = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
  }
  return kr == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : -1
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "check"
switch mode {
case "request":
  emit(["requested": CGRequestScreenCaptureAccess()])
case "check":
  emit(await check(owner: arg("owner") ?? "", withText: false))
case "read":
  emit(await check(owner: arg("owner") ?? "", withText: true))
case "serve":
  while let line = readLine() {
    if line == "quit" { break }
    if line.hasPrefix("check ") { emit(await check(owner: String(line.dropFirst(6)), withText: false)) }
  }
case "soak":
  let owner = arg("owner") ?? "", n = Int(arg("n") ?? "1000") ?? 1000
  var ms: [Int] = []
  for i in 1...n {
    let t = Date()
    let r = await check(owner: owner, withText: true)
    if (r["capture"] as? String) != "ok" { emit(["reads": i, "failed": r["capture"] ?? "?"]); break }
    ms.append(Int(Date().timeIntervalSince(t) * 1000))
    if i % 100 == 0 { emit(["reads": i, "medianMs": ms.sorted()[ms.count / 2], "rssMB": (rssMB() * 10).rounded() / 10]); ms = [] }
  }
default:
  emit(["error": "unknown mode"])
}
```

- [ ] **Step 2: Build it**

Run:
```bash
SPIKE=<absolute path>; swiftc -O -swift-version 5 -target arm64-apple-macos14 "$SPIKE/probe/main.swift" -o "$SPIKE/probe/clave-reader-probe"
```
Expected: exit 0, no errors. If the compiler rejects an API name, fix it against the installed SDK headers (`xcrun --show-sdk-path`); behaviour must stay as the Interfaces block says.

- [ ] **Step 3: Verify the ungranted path without any grant**

Run: `SPIKE=<absolute path>; "$SPIKE/probe/clave-reader-probe" check --owner Finder`
Expected: one JSON line with a `preflight` and a `capture` field and no `text` field. The values depend on what the terminal program is granted and are not a finding (see the `open -n` rule); this step only proves the probe runs and prints valid JSON.

Run: `SPIKE=<absolute path>; echo quit | "$SPIKE/probe/clave-reader-probe" serve; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 4: Checkpoint**

Confirm the binary exists and both commands behaved as expected.

---

### Task 3: The signed host app

**Files:**
- Create: `$SPIKE/host/ClaveReaderSpike.app` (copy of `app/node_modules/electron/dist/Electron.app`)
- Create: `$SPIKE/host/ClaveReaderSpike.app/Contents/Resources/app/package.json`, `main.js`

**Interfaces:**
- Consumes: `$SPIKE/probe/clave-reader-probe` (Task 2).
- Produces: `open -n "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=watch --owner=Terminal --out=<file> --seconds=<n>` appends one JSON line to `<file>` whenever the observed state changes: `{"t":iso,"A":check,"B":check,"main":{"sources":int,"nonEmpty":int}}`, where A is one long-lived `serve` helper, B is a fresh `check` helper per tick, and `main` is Electron's own `desktopCapturer` in the main process. `--scenario=request` runs `clave-reader-probe request` once, writes its answer, and quits.

- [ ] **Step 1: OWNER creates the signing certificate (once)**

Ask the owner to do this, and wait: Keychain Access → menu Keychain Access → Certificate Assistant → Create a Certificate. Name: `Clave Agent Dev`. Identity Type: Self-Signed Root. Certificate Type: Code Signing. Create.

Verify: `security find-identity -p codesigning | grep "Clave Agent Dev"`
Expected: one line naming the certificate (it may be listed as not trusted; that is fine for local signing).

- [ ] **Step 2: Copy Electron and give it its own identity**

```bash
SPIKE=<absolute path>; APP="$SPIKE/host/ClaveReaderSpike.app"
cp -R /Users/sardorastanov/techcells/asset-to-evidence/app/node_modules/electron/dist/Electron.app "$APP"
plutil -replace CFBundleIdentifier -string dev.clave.readerspike "$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Clave Reader Spike" "$APP/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "Clave Reader Spike" "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources/app"
cp "$SPIKE/probe/clave-reader-probe" "$APP/Contents/MacOS/clave-reader-probe"
```

- [ ] **Step 3: Write the host script**

`$APP/Contents/Resources/app/package.json`:
```json
{"name": "clave-reader-spike", "version": "0.0.0", "main": "main.js"}
```

`$APP/Contents/Resources/app/main.js`:
```js
// THROWAWAY spike code. Never copy into app/.
const {app, desktopCapturer} = require("electron");
const {spawn, execFile} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const probe = path.join(path.dirname(process.execPath), "clave-reader-probe");
const out = arg("out", "/dev/null");
const write = (record) => fs.appendFileSync(out, JSON.stringify({t: new Date().toISOString(), ...record}) + "\n");

const once = (args) => new Promise((resolve) => {
  execFile(probe, args, {timeout: 10_000}, (error, stdout) => {
    try { resolve(JSON.parse(stdout.trim().split("\n").pop())); } catch { resolve({capture: "probeFailed", error: String(error)}); }
  });
});

function longLived() {
  const child = spawn(probe, ["serve"]);
  const lines = readline.createInterface({input: child.stdout});
  const waiting = [];
  lines.on("line", (line) => { const next = waiting.shift(); if (next) { try { next(JSON.parse(line)); } catch { next({capture: "badLine"}); } } });
  child.on("exit", () => { for (const next of waiting.splice(0)) next({capture: "helperExited"}); });
  return {
    check: (owner) => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve({capture: "helperExited"}); return; }
      const timer = setTimeout(() => resolve({capture: "noAnswer"}), 10_000);
      waiting.push((value) => { clearTimeout(timer); resolve(value); });
      child.stdin.write(`check ${owner}\n`);
    }),
    quit: () => { try { child.stdin.write("quit\n"); } catch { /* already gone */ } }
  };
}

async function inMain() {
  try {
    const sources = await desktopCapturer.getSources({types: ["window"], thumbnailSize: {width: 320, height: 200}});
    return {sources: sources.length, nonEmpty: sources.filter((s) => !s.thumbnail.isEmpty()).length};
  } catch (error) { return {error: String(error)}; }
}

app.whenReady().then(async () => {
  if (arg("scenario", "watch") === "request") {
    write({request: await once(["request"])});
    app.quit();
    return;
  }
  const owner = arg("owner", "Terminal");
  const until = Date.now() + Number(arg("seconds", "600")) * 1000;
  const helperA = longLived();
  let last = "";
  write({started: true, owner});
  while (Date.now() < until) {
    const record = {A: await helperA.check(owner), B: await once(["check", "--owner", owner]), main: await inMain()};
    const key = JSON.stringify(record);
    if (key !== last) { last = key; write(record); }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  helperA.quit();
  write({finished: true});
  app.quit();
});
```

- [ ] **Step 4: Sign the helper, then the bundle**

```bash
SPIKE=<absolute path>; APP="$SPIKE/host/ClaveReaderSpike.app"
codesign --force --sign "Clave Agent Dev" "$APP/Contents/MacOS/clave-reader-probe"
codesign --force --deep --sign "Clave Agent Dev" "$APP"
codesign --verify --deep --strict "$APP"; echo "verify=$?"
codesign -dv "$APP" 2>&1 | grep -E "^Identifier|^Authority|Signature"
```
Expected: `verify=0`, `Identifier=dev.clave.readerspike`, and the authority `Clave Agent Dev` (not `adhoc`).

- [ ] **Step 5: Prove the host runs and logs before any grant**

```bash
SPIKE=<absolute path>; open "$SPIKE/stage/terminal.command"
open -n "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=watch --owner=Terminal --out="$SPIKE/out/host-smoke.jsonl" --seconds=12
```
Wait 20 seconds, then read `$SPIKE/out/host-smoke.jsonl`.
Expected: a `started` line, at least one record with `A`, `B` and `main`, and a `finished` line. With no grant yet, `B.preflight` is `false` and `B.capture` is not `ok`. If macOS shows a Screen Recording prompt, the owner dismisses it WITHOUT granting; record that the prompt appeared and which app it named.

- [ ] **Step 6: Checkpoint**

Confirm the log has the three kinds of lines and the signature is the certificate, not ad hoc.

---

### Task 4: Spikes P1 and P2 (does the grant reach the helper; is a helper restart enough)

**Files:**
- Create: `$SPIKE/out/p1p2.jsonl`
- Modify: `$SPIKE/FINDINGS.md` (sections P1, P2)

**Interfaces:**
- Consumes: the host app's `watch` and `request` scenarios (Task 3), the staged Terminal window (Task 1).

- [ ] **Step 1: OWNER resets the spike's grant so the run starts clean**

Ask the owner to run: `tccutil reset ScreenCapture dev.clave.readerspike`
Expected: `Successfully reset ScreenCapture approval status for dev.clave.readerspike`.

- [ ] **Step 2: Start a ten-minute watch with the staged Terminal open**

```bash
SPIKE=<absolute path>; open "$SPIKE/stage/terminal.command"
open -n "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=watch --owner=Terminal --out="$SPIKE/out/p1p2.jsonl" --seconds=600
```
Read the first record. Expected before the grant: `B.preflight=false`, `B.titles=0` or very low, `B.capture` is `error` (record `errorDomain` and `errorCode`; this is the value the product maps to `failed`).

- [ ] **Step 3: Trigger the system prompt from the helper and note which app it names**

```bash
SPIKE=<absolute path>; open -n "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=request --out="$SPIKE/out/p2-request.jsonl"
```
Ask the owner: which app name does the dialog show ("Clave Reader Spike", "Electron", "clave-reader-probe", something else)? Write the answer down verbatim.

- [ ] **Step 4: OWNER grants Screen Recording while the watch is still running**

Ask the owner: System Settings → Privacy & Security → Screen & System Audio Recording → enable the entry that appeared. Ask them to report (a) the name of the entry, (b) whether macOS offered "Quit & Reopen" and, if so, to choose **Later**. Note the wall-clock time of the grant.

- [ ] **Step 5: Read what changed after the grant**

Wait 15 seconds, then read `$SPIKE/out/p1p2.jsonl`. For the records after the grant time, write down:
- `B` (fresh helper each tick): does `capture` become `ok`, does `preflight` become `true`, does `titles` rise?
- `A` (the helper that was already running): same three fields.
- `main`: does `nonEmpty` rise above 0?

- [ ] **Step 6: Decide P1 and P2 from the table**

| Observation | Finding |
|---|---|
| `B.capture == "ok"` after the grant, entry listed under the app's name | **P1 pass**: the standalone helper is the design |
| `B.capture != "ok"` but `main.nonEmpty > 0` | **P1 fail for the standalone helper**; the floor (capture in main, recognise in the helper) works. Stop and tell the owner: testing the Node-child form needs a native addon and its own short plan |
| neither | **P1 fail everywhere**; stop and report to the owner with the log |
| `B` ok while the app kept running | **P2 pass**: a helper restart is enough, the app need not restart |
| `A.capture == "ok"` too | Note: even the running helper picked the grant up; `needsRestart` may never be needed |
| `B` ok only after the owner quits and reopens the host app | **P2 fail**: `needsRestart` means restarting the app (to test: let the watch finish, run Step 2 again, read the first record) |

- [ ] **Step 7: Write the findings**

Append to `$SPIKE/FINDINGS.md` a `## P1` and a `## P2` section, each with: date, macOS 27.0, Electron 44.4.1, the exact records quoted from the log (they contain no text or titles), the owner's answers from Steps 3 and 4, the verdict from Step 6, and the error domain and code seen before the grant.

- [ ] **Step 8: Checkpoint**

The reviewer re-reads `$SPIKE/out/p1p2.jsonl` and confirms the verdicts follow from the records. If P1 failed everywhere, STOP the plan here and report.

---

### Task 5: Spike P3 (ScreenCaptureKit and Vision from Rust)

**Files:**
- Create: `$SPIKE/rust/Cargo.toml`, `$SPIKE/rust/src/main.rs`
- Create: `$SPIKE/out/p3-swift.json`, `p3-rust.json`, `p3-soak-rust.jsonl`, `p3-soak-swift.jsonl`
- Modify: `$SPIKE/FINDINGS.md` (section P3)

**Interfaces:**
- Consumes: the signed host bundle (the Rust probe is copied into it and signed, so it runs under the granted identity); the Swift probe's `read` and `soak` as the reference.
- Produces: `reader-spike read --owner <App>` and `reader-spike soak --owner <App> --n <count>` with the same JSON fields as the Swift probe's `read` and `soak` (`text`, `captureMs`, `recogniseMs`; `reads`, `medianMs`, `rssMB`).

**Time box:** the code below has never been compiled (nothing can be downloaded before the owner approves). The `objc2` framework crates are generated one-to-one from Apple's headers, so every call below exists; exact method spellings and `unsafe` markers may differ. Fix compile errors against `https://docs.rs/objc2-screen-capture-kit` and `https://docs.rs/objc2-vision` without changing behaviour. If the probe does not compile and produce a correct `read` within three hours of effort, that IS the finding: record **P3 fail**, and the macOS layer becomes a thin Swift static library (spec section 6).

- [ ] **Step 1: Write the crate**

`$SPIKE/rust/Cargo.toml`:
```toml
[package]
name = "reader-spike"
version = "0.0.0"
edition = "2024"

[dependencies]
objc2 = "0.6"
block2 = "0.6"
objc2-foundation = "0.3"
objc2-core-foundation = "0.3"
objc2-core-graphics = "0.3"
objc2-screen-capture-kit = "0.3"
objc2-vision = "0.3"
serde_json = "1"

[profile.release]
opt-level = 3
```

`$SPIKE/rust/src/main.rs`:
```rust
// THROWAWAY spike code. Never copy into app/.
use std::sync::mpsc;
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2::AllocAnyThread;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString};
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};
use serde_json::json;

/// Completion handlers run on another queue; the objects they hand over are safe to move once retained.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == &format!("--{name}")).and_then(|i| a.get(i + 1).cloned())
}

fn shareable_content() -> Result<Retained<SCShareableContent>, i64> {
    let (tx, rx) = mpsc::channel::<Sendable<Result<Retained<SCShareableContent>, i64>>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = match unsafe { Retained::retain(content) } {
            Some(c) => Ok(c),
            None => Err(unsafe { error.as_ref() }.map(|e| e.code() as i64).unwrap_or(-1)),
        };
        let _ = tx.send(Sendable(result));
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &block) };
    rx.recv().map(|s| s.0).unwrap_or(Err(-2))
}

/// The spike picks the largest on-screen layer-0 window of the named app. (The product picks by window id from the
/// window server; the Swift probe proves that path.)
fn pick_window(content: &SCShareableContent, owner: &str) -> Option<Retained<SCWindow>> {
    let mut best: Option<(f64, Retained<SCWindow>)> = None;
    for w in unsafe { content.windows() }.iter() {
        let name = unsafe { w.owningApplication() }.map(|a| unsafe { a.applicationName() }.to_string()).unwrap_or_default();
        let frame = unsafe { w.frame() };
        let area = frame.size.width * frame.size.height;
        if name == owner && unsafe { w.windowLayer() } == 0 && unsafe { w.isOnScreen() } && frame.size.width >= 100.0 && frame.size.height >= 100.0 {
            if best.as_ref().map(|(a, _)| area > *a).unwrap_or(true) { best = Some((area, w.clone())); }
        }
    }
    best.map(|(_, w)| w)
}

fn capture(window: &SCWindow) -> Result<CFRetained<CGImage>, i64> {
    let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), window) };
    let cfg = unsafe { SCStreamConfiguration::new() };
    let rect = unsafe { filter.contentRect() };
    let scale = unsafe { filter.pointPixelScale() } as f64;
    unsafe {
        cfg.setWidth((rect.size.width * scale) as usize);
        cfg.setHeight((rect.size.height * scale) as usize);
        cfg.setShowsCursor(false);
        cfg.setIgnoreShadowsSingleWindow(true);
    }
    let (tx, rx) = mpsc::channel::<Sendable<Result<CFRetained<CGImage>, i64>>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let result = match std::ptr::NonNull::new(image) {
            Some(p) => Ok(unsafe { CFRetained::retain(p) }),
            None => Err(unsafe { error.as_ref() }.map(|e| e.code() as i64).unwrap_or(-1)),
        };
        let _ = tx.send(Sendable(result));
    });
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &cfg, Some(&block)) };
    rx.recv().map(|s| s.0).unwrap_or(Err(-2))
}

/// (text, x, top) per recognised line, top measured from the top edge, 0..1.
fn recognise(image: &CGImage) -> Result<Vec<(String, f64, f64, f64)>, i64> {
    let request = unsafe { VNRecognizeTextRequest::new() };
    unsafe {
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(false);
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&[NSString::from_str("en-US"), NSString::from_str("pt-BR")]));
    }
    let handler = unsafe { VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), image, &NSDictionary::new()) };
    let requests: Retained<NSArray<VNRequest>> = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(request.clone()))]);
    unsafe { handler.performRequests_error(&requests) }.map_err(|e| e.code() as i64)?;
    let mut lines = Vec::new();
    if let Some(results) = unsafe { request.results() } {
        for observation in results.iter() {
            let candidates = unsafe { observation.topCandidates(1) };
            if let Some(best) = candidates.iter().next() {
                let b = unsafe { observation.boundingBox() };
                lines.push((unsafe { best.string() }.to_string(), b.origin.x, 1.0 - (b.origin.y + b.size.height), b.size.height));
            }
        }
    }
    Ok(lines)
}

fn ordered(mut lines: Vec<(String, f64, f64, f64)>) -> Vec<String> {
    lines.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap());
    let mut rows: Vec<Vec<(String, f64, f64, f64)>> = Vec::new();
    for l in lines {
        match rows.last_mut() {
            Some(row) if (l.2 - row[0].2).abs() < row[0].3 * 0.5 => row.push(l),
            _ => rows.push(vec![l]),
        }
    }
    rows.into_iter().flat_map(|mut r| { r.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap()); r.into_iter().map(|l| l.0) }).collect()
}

fn read(owner: &str) -> serde_json::Value {
    autoreleasepool(|_| {
        let content = match shareable_content() { Ok(c) => c, Err(code) => return json!({"capture": "error", "errorCode": code}) };
        let Some(window) = pick_window(&content, owner) else { return json!({"capture": "noWindow"}) };
        let t0 = Instant::now();
        let image = match capture(&window) { Ok(i) => i, Err(code) => return json!({"capture": "error", "errorCode": code}) };
        let capture_ms = t0.elapsed().as_millis() as u64;
        let t1 = Instant::now();
        // The spike recognises the colour image; the grey conversion is plain CoreGraphics and is not the question here.
        match recognise(&image) {
            Ok(lines) => json!({"capture": "ok", "captureMs": capture_ms, "recogniseMs": t1.elapsed().as_millis() as u64, "text": ordered(lines).join("\n")}),
            Err(code) => json!({"capture": "error", "errorCode": code}),
        }
    })
}

fn rss_mb() -> f64 {
    let out = std::process::Command::new("/bin/ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    out.ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<f64>().ok()).map(|kb| kb / 1024.0).unwrap_or(-1.0)
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let owner = arg("owner").unwrap_or_default();
    match mode.as_str() {
        "read" => println!("{}", read(&owner)),
        "soak" => {
            let n: usize = arg("n").and_then(|v| v.parse().ok()).unwrap_or(1000);
            let mut ms: Vec<u128> = Vec::new();
            for i in 1..=n {
                let t = Instant::now();
                let r = read(&owner);
                if r["capture"] != "ok" { println!("{}", json!({"reads": i, "failed": r["capture"]})); break; }
                ms.push(t.elapsed().as_millis());
                if i % 100 == 0 { ms.sort(); println!("{}", json!({"reads": i, "medianMs": ms[ms.len() / 2] as u64, "rssMB": (rss_mb() * 10.0).round() / 10.0})); ms.clear(); }
            }
        }
        _ => println!("{}", json!({"error": "unknown mode"})),
    }
}
```

- [ ] **Step 2: ASK THE OWNER, then build (the only download in this plan)**

Ask: "Task 5 needs to download the Rust crates objc2, block2, objc2-foundation, objc2-core-foundation, objc2-core-graphics, objc2-screen-capture-kit, objc2-vision, serde_json and their dependencies from crates.io into `~/.cargo`. Approve?" If refused: write `## P3: not run (download refused)` in FINDINGS and skip to Task 6.

Run:
```bash
SPIKE=<absolute path>; /opt/homebrew/opt/rustup/bin/cargo build --release --manifest-path "$SPIKE/rust/Cargo.toml"
```
Expected: exit 0 (after fixing spellings as the time box describes). Record the resolved versions: `grep -A1 -E 'name = "(objc2|block2|objc2-[a-z-]+|serde_json)"' "$SPIKE/rust/Cargo.lock"`.

- [ ] **Step 3: Put both probes under the granted identity**

A binary started from a terminal is judged by the terminal's grant, so both probes run from inside the host bundle, started by the host. Add one scenario to `main.js`, before the `const owner = ...` line:

```js
  if (arg("scenario", "watch") === "run") {
    // Runs any probe binary inside the bundle with the given arguments; stdout goes to --out verbatim.
    const bin = path.join(path.dirname(process.execPath), arg("bin", "clave-reader-probe"));
    const child = spawn(bin, JSON.parse(arg("probeArgs", "[]")));
    child.stdout.on("data", (chunk) => fs.appendFileSync(out, chunk));
    child.on("exit", () => app.quit());
    return;
  }
```

Then copy the Rust binary in and re-sign:
```bash
SPIKE=<absolute path>; APP="$SPIKE/host/ClaveReaderSpike.app"
cp "$SPIKE/rust/target/release/reader-spike" "$APP/Contents/MacOS/reader-spike"
codesign --force --sign "Clave Agent Dev" "$APP/Contents/MacOS/reader-spike"
codesign --force --deep --sign "Clave Agent Dev" "$APP"
codesign --verify --deep --strict "$APP"; echo "verify=$?"
```
Expected: `verify=0`. Then run the Task 4 Step 2 watch for 12 seconds and confirm `B.capture` is still `ok`; if re-signing lost the grant, record that in FINDINGS (it matters for the product's dev workflow) and ask the owner to grant again.

- [ ] **Step 4: Same window, both probes, compare the text**

```bash
SPIKE=<absolute path>; APP="$SPIKE/host/ClaveReaderSpike.app"; open "$SPIKE/stage/terminal.command"
open -n -W "$APP" --args --scenario=run --bin=clave-reader-probe --probeArgs='["read","--owner","Terminal"]' --out="$SPIKE/out/p3-swift.json"
open -n -W "$APP" --args --scenario=run --bin=reader-spike --probeArgs='["read","--owner","Terminal"]' --out="$SPIKE/out/p3-rust.json"
python3 "$SPIKE/tools/score.py" "$SPIKE/out/p3-swift.json" "$SPIKE/truth/terminal.txt"
python3 "$SPIKE/tools/score.py" "$SPIKE/out/p3-rust.json" "$SPIKE/truth/terminal.txt"
```
Expected: both print `"markers": true`; the Rust accuracy is within 0.01 of the Swift accuracy.

- [ ] **Step 5: Soak both for 1,000 reads**

```bash
SPIKE=<absolute path>; APP="$SPIKE/host/ClaveReaderSpike.app"
open -n -W "$APP" --args --scenario=run --bin=reader-spike --probeArgs='["soak","--owner","Terminal","--n","1000"]' --out="$SPIKE/out/p3-soak-rust.jsonl"
open -n -W "$APP" --args --scenario=run --bin=clave-reader-probe --probeArgs='["soak","--owner","Terminal","--n","1000"]' --out="$SPIKE/out/p3-soak-swift.jsonl"
```
Each takes a few minutes; keep the staged Terminal window on screen and unlocked.

**P3 pass** needs all three: every `medianMs` in the Rust file under 400; Rust `rssMB` at 1,000 reads no more than 20 MB above its value at 100 reads; Step 4's accuracy match. Record both files' first and last lines.

- [ ] **Step 6: Write the P3 finding**

Append `## P3` to FINDINGS: verdict, resolved crate versions, the numbers from Steps 4 and 5 for both probes, how many spellings had to be fixed and how long the port took, and any `unsafe` surprises worth knowing for the build plan.

- [ ] **Step 7: Checkpoint**

The reviewer re-runs Step 4 and confirms the two accuracy numbers.

---

### Task 6: Spike P6 (revoking the grant while the helper runs)

**Files:**
- Create: `$SPIKE/out/p6.jsonl`
- Modify: `$SPIKE/FINDINGS.md` (section P6)

**Interfaces:**
- Consumes: the host `watch` scenario with the grant in place (Tasks 3 and 4).

- [ ] **Step 1: Start a five-minute watch with the grant in place**

```bash
SPIKE=<absolute path>; open "$SPIKE/stage/terminal.command"
open -n "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=watch --owner=Terminal --out="$SPIKE/out/p6.jsonl" --seconds=300
```
Expected first record: `A.capture` and `B.capture` both `ok`.

- [ ] **Step 2: OWNER revokes the grant while it runs**

Ask the owner: System Settings → Privacy & Security → Screen & System Audio Recording → switch "Clave Reader Spike" off. Ask whether macOS demanded to quit the app, and to choose **Later** if it offers. Note the time.

- [ ] **Step 3: Read what the helpers report after the revocation**

Wait 15 seconds, read `$SPIKE/out/p6.jsonl`. Write down, for A and for B after the revoke time: `preflight`, `titles`, `capture`, and `errorDomain`/`errorCode` if present. The two outcomes that matter:
- `capture` is `error` → the product answers `failed`. **P6 pass** if also `preflight` is `false` for B (the permission check stops saying granted for a fresh helper).
- `capture` is `black`, or `ok` with stale pixels → **P6 fail as designed**: section 5.3 of the spec must change so that a refused capture is recognised another way (for example `titles == 0`, which the record also shows). Record exactly which signal does distinguish the revoked state.

If macOS killed the host app on revoke, the log simply stops: record that as the finding (the product then restarts into `denied`, which B already handles).

- [ ] **Step 4: OWNER grants again** (Tasks 7 and 8 need it), then confirm with a 12-second watch that `B.capture` is `ok`.

- [ ] **Step 5: Write the P6 finding and checkpoint**

Append `## P6` to FINDINGS with the quoted records, the owner's observations and the verdict. The reviewer re-reads the log against the verdict.

---

### Task 7: Spike P4 (recognition quality on staged windows)

**Files:**
- Create: `$SPIKE/tools/run_p4.sh`, `$SPIKE/out/p4/*.json`, `$SPIKE/out/p4-scores.jsonl`
- Modify: `$SPIKE/FINDINGS.md` (section P4)

**Interfaces:**
- Consumes: the pages (Task 1), the host `run` scenario (Task 5 Step 3; if Task 5 was skipped, add that scenario to `main.js` now exactly as written there and re-sign with the two `codesign` lines and the verify line), `score.py`.
- Produces: one score line per (page, theme, size) and one for the terminal.

- [ ] **Step 1: Serve the pages locally**

Run in the background: `SPIKE=<absolute path>; python3 -m http.server 8765 --bind 127.0.0.1 --directory "$SPIKE/stage/www"`
Verify: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/chat.html` prints `200`.

- [ ] **Step 2: Write the runner**

`$SPIKE/tools/run_p4.sh` (replace `<absolute path>`; `chmod +x`):
```bash
#!/bin/bash
# THROWAWAY spike tool. Opens each staged page in the spike's own Chrome profile, reads it, scores it.
SPIKE="<absolute path>"
APP="$SPIKE/host/ClaveReaderSpike.app"
PROFILE="$SPIKE/chrome-profile"
mkdir -p "$SPIKE/out/p4"
: > "$SPIKE/out/p4-scores.jsonl"
for page in chat ticket code pt; do
  for variant in "light 14" "dark 14" "light 11" "dark 11"; do
    set -- $variant
    name="$page-$1-$2"
    open -na "Google Chrome" --args --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --new-window "http://127.0.0.1:8765/$page.html?theme=$1&size=$2"
    sleep 4
    rm -f "$SPIKE/out/p4/$name.json"
    open -n -W "$APP" --args --scenario=run --bin=clave-reader-probe --probeArgs='["read","--owner","Google Chrome"]' --out="$SPIKE/out/p4/$name.json"
    score=$(python3 "$SPIKE/tools/score.py" "$SPIKE/out/p4/$name.json" "$SPIKE/truth/$page.txt")
    echo "{\"case\":\"$name\",\"score\":$score}" >> "$SPIKE/out/p4-scores.jsonl"
    pkill -f "user-data-dir=$PROFILE" ; sleep 2
  done
done
open "$SPIKE/stage/terminal.command"; sleep 3
rm -f "$SPIKE/out/p4/terminal.json"
open -n -W "$APP" --args --scenario=run --bin=clave-reader-probe --probeArgs='["read","--owner","Terminal"]' --out="$SPIKE/out/p4/terminal.json"
echo "{\"case\":\"terminal\",\"score\":$(python3 "$SPIKE/tools/score.py" "$SPIKE/out/p4/terminal.json" "$SPIKE/truth/terminal.txt")}" >> "$SPIKE/out/p4-scores.jsonl"
cat "$SPIKE/out/p4-scores.jsonl"
```
The separate `--user-data-dir` makes this a second Chrome instance, so `pkill` never touches the owner's own Chrome. Tell the owner before running: windows will open and close for about three minutes, and the owner's own Chrome windows should be minimised so the staged window is Chrome's topmost.

- [ ] **Step 3: Run it**

Run: `SPIKE=<absolute path>; "$SPIKE/tools/run_p4.sh"`
Expected: 17 lines, each with `"markers": true`. A line with `"markers": false` means the wrong window was read or a marker was misrecognised: inspect that one JSON, fix the staging (not the scorer), and rerun.

- [ ] **Step 4: Judge against the spec's thresholds**

Lowest accuracy per group must reach: chat ≥ 0.97, ticket ≥ 0.97, terminal ≥ 0.95, pt ≥ 0.95 with `accents` = 1.0, code ≥ 0.90. Report light/dark and 14/11 px separately. For every case under its threshold, list the five most frequent character confusions (diff the OCR body against the truth by eye; typical: `l`/`1`, `` ` ``/`'`, `_`/`-`, dropped `{}`), because the build plan's noise stripping and the core's tolerance depend on them.

- [ ] **Step 5: Write the P4 finding and checkpoint**

Append `## P4` to FINDINGS: the 17 score lines, per-group minimum, pass or fail per group, the confusion lists, median `captureMs` and `recogniseMs` across the 17 reads. **Any group under its threshold goes to the owner with the numbers before the build plan is written; the threshold is not changed by the executor.** The reviewer reruns the runner and compares.

---

### Task 8: Spike P5 (the toolbar strip: address host and private label)

**Files:**
- Create: `$SPIKE/tools/toolbar.py`, `$SPIKE/tools/run_p5.sh`, `$SPIKE/out/p5/*.json`, `$SPIKE/out/p5-results.jsonl`
- Modify: `$SPIKE/FINDINGS.md` (section P5)

**Interfaces:**
- Consumes: the `lines` array of the probe's `read` answer (`text`, `topPx`, `bottomPx`), the local server (Task 7 Step 1; Chrome resolves any `*.localhost` name to the loopback address with no system change).
- Produces: `python3 toolbar.py <read.json> <expected host> [<private word>]` printing `{"host":bool,"hostBottomPx":int|null,"private":bool|null,"privateBottomPx":int|null}`, searching only lines whose `topPx` is under 260.

- [ ] **Step 1: Write the toolbar checker**

`$SPIKE/tools/toolbar.py`:
```python
#!/usr/bin/env python3
"""THROWAWAY spike tool. Is the address host (and the private-window label) in the top band of a read?"""
import json
import sys

BAND_PX = 260  # generous on purpose: the finding is how small the band can be


def squash(s):
    return "".join(s.lower().split())


def find(lines, needle):
    for line in lines:
        if line["topPx"] < BAND_PX and squash(needle) in squash(line["text"]):
            return line["bottomPx"]
    return None


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        demo = [{"text": "staging.jira . localhost:8765/ticket.html", "topPx": 90, "bottomPx": 118},
                {"text": "Incognito", "topPx": 92, "bottomPx": 116},
                {"text": "incognito mode explained", "topPx": 700, "bottomPx": 730}]
        assert find(demo, "staging.jira.localhost") == 118
        assert find(demo, "Incognito") == 116
        assert find(demo[2:], "Incognito") is None
        print("SELFTEST OK")
        sys.exit(0)
    lines = json.load(open(sys.argv[1], encoding="utf-8")).get("lines", [])
    host = find(lines, sys.argv[2])
    private = find(lines, sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps({"host": host is not None, "hostBottomPx": host,
                      "private": (private is not None) if len(sys.argv) > 3 else None, "privateBottomPx": private}))
```

Run: `SPIKE=<absolute path>; python3 "$SPIKE/tools/toolbar.py" --selftest` → `SELFTEST OK`.

- [ ] **Step 2: Write the Chrome runner (20 normal and 20 incognito captures)**

`$SPIKE/tools/run_p5.sh` (replace `<absolute path>`; `chmod +x`):
```bash
#!/bin/bash
# THROWAWAY spike tool. 4 hosts x 5 page variants, once normal and once incognito, in the spike's own Chrome profile.
SPIKE="<absolute path>"
APP="$SPIKE/host/ClaveReaderSpike.app"
PROFILE="$SPIKE/chrome-profile"
mkdir -p "$SPIKE/out/p5"
: > "$SPIKE/out/p5-results.jsonl"
for mode in normal incognito; do
  for host in app.clave.localhost staging.jira.localhost mybank.example.localhost mail.corp.localhost; do
    for variant in "chat light 14" "ticket dark 14" "code light 11" "pt dark 11" "chat dark 11"; do
      set -- $variant
      name="$mode-$host-$1-$2-$3"
      flag=""; word=""
      if [ "$mode" = incognito ]; then flag="--incognito"; word="Incognito"; fi
      open -na "Google Chrome" --args --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check $flag --new-window "http://$host:8765/$1.html?theme=$2&size=$3"
      sleep 4
      rm -f "$SPIKE/out/p5/$name.json"
      open -n -W "$APP" --args --scenario=run --bin=clave-reader-probe --probeArgs='["read","--owner","Google Chrome"]' --out="$SPIKE/out/p5/$name.json"
      echo "{\"case\":\"$name\",\"result\":$(python3 "$SPIKE/tools/toolbar.py" "$SPIKE/out/p5/$name.json" "$host" $word)}" >> "$SPIKE/out/p5-results.jsonl"
      pkill -f "user-data-dir=$PROFILE"; sleep 2
    done
  done
done
cat "$SPIKE/out/p5-results.jsonl"
```

- [ ] **Step 3: Run it** (about six minutes; same notice to the owner as Task 7)

Run: `SPIKE=<absolute path>; "$SPIKE/tools/run_p5.sh"`
Count: normal cases with `"host": true` (need ≥ 19 of 20); incognito cases with `"private": true` (need 20 of 20) and with `"host": true` (report). Band height = the largest `hostBottomPx` and `privateBottomPx` seen, plus 10%; also express it as a fraction of the window's pixel height, since the product must work at any pixel density.

Also check the opposite error, which matters as much: in the 20 NORMAL captures, run `toolbar.py <file> <host> Incognito` on each and confirm `"private": false` for all 20 (no false private detection from page or tab text inside the band).

- [ ] **Step 4: Safari, by hand, 5 normal and 5 private**

Safari cannot be driven into a private window from the command line without scripting the owner's UI. **OWNER:** open Safari, load `http://127.0.0.1:8765/chat.html`, `ticket.html`, `code.html`, `pt.html`, `chat.html?theme=dark` one at a time in a normal window; after each, the executor runs:
```bash
SPIKE=<absolute path>; open -n -W "$SPIKE/host/ClaveReaderSpike.app" --args --scenario=run --bin=clave-reader-probe --probeArgs='["read","--owner","Safari"]' --out="$SPIKE/out/p5/safari-normal-N.json"
python3 "$SPIKE/tools/toolbar.py" "$SPIKE/out/p5/safari-normal-N.json" 127.0.0.1
```
Then the same five in a private window (File → New Private Window), checking `toolbar.py <file> 127.0.0.1 Private`. Safari shows "Private" in the address field area; if the word recognised is different, record the actual label from the `lines` of the top band. The owner must close any private window with real content first; only the staged pages may be on screen in Safari during this step.

- [ ] **Step 5: Write the P5 finding and checkpoint**

Append `## P5` to FINDINGS: counts per browser and mode, the false-private count, the band height in pixels and as a fraction, the exact private labels seen, and for each browser the verdict (reliable, or "private detection unreliable: the user advice to exclude the browser stands"). Arc is not installed on this machine: record "Arc: not tested". The reviewer reruns `run_p5.sh` and compares the counts.

---

### Task 9: Report into the spec, clean up, hand over

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-native-reader-design.md` (section 10 table only, plus section 5.3 if P6 required it)
- Modify: `docs/HANDOFF.md` (section 0 and the table row for C)
- Delete: `$SPIKE/out`, `$SPIKE/chrome-profile`, `$SPIKE/host`, `$SPIKE/rust/target`

- [ ] **Step 1: Fill the spec's results table**

For each of P1 to P6 write the date, a two-sentence finding with its key numbers, and the consequence for the design, taken from `$SPIKE/FINDINGS.md`. Where a spike failed, state which branch of the spec now applies (section 2 fallback, Swift static library, app-level `needsRestart`, adjusted section 5.3, browser marked unreliable). Copy the full `FINDINGS.md` to `docs/superpowers/reviews/2026-09-18-native-reader-phase0-findings.md`; it contains records and numbers only, no screen text.

- [ ] **Step 2: Stop the server and delete everything that held staged output**

```bash
SPIKE=<absolute path>; pkill -f "http.server 8765"; pkill -f "user-data-dir=$SPIKE/chrome-profile"
rm -rf "$SPIKE/out" "$SPIKE/chrome-profile" "$SPIKE/host" "$SPIKE/rust/target"
```
Before running `rm`, print `echo "$SPIKE"` and confirm it is the scratchpad path and not empty.

- [ ] **Step 3: OWNER removes the spike's grant and, if wanted, the certificate**

Ask the owner to run `tccutil reset ScreenCapture dev.clave.readerspike`. Keep the `Clave Agent Dev` certificate: the build plan's dev workflow uses it.

- [ ] **Step 4: Prove the product is untouched**

Run: `pnpm --dir app test` → 768 passed. Run: `pnpm --dir app typecheck` → clean. Run: `find /Users/sardorastanov/techcells/asset-to-evidence/app -newer /Users/sardorastanov/techcells/asset-to-evidence/docs/superpowers/plans/2026-09-18-native-reader-phase0-spikes.md -not -path "*/node_modules/*" -not -path "*/dist/*" -type f` → no output.

- [ ] **Step 5: Update the handoff and stop**

In `docs/HANDOFF.md`: set the C row to "Phase 0 done <date>, findings in the spec section 10; build plan not written", and add to section 0 the chosen branch per spike and "Carried to packaging: repeat P1, P2 and P6 under a real Developer ID". Then tell the owner the results in plain words and ask whether to write the build plan for C with `superpowers:writing-plans`. Do not start it unasked.

---

## Verification record (2026-09-18)

Every code block except the Rust crate was extracted from this document into a scratch folder and
run: `main.swift` compiles cleanly with the exact Step 2 command (Swift 6.4, target macOS 14) and
`serve` and `check` behave as Task 2 Step 3 expects; `score.py --selftest` and
`toolbar.py --selftest` print `SELFTEST OK`; `make_pages.py` prints `PAGES OK` and writes four
pages (six name lines in the chat page); `main.js` passes `node --check`; both runners pass
`bash -n`. NOT verified: anything needing the grant, the signing certificate or a window (Tasks 3
to 8 as wholes), and the Rust source (no download was allowed while planning). Earlier plans in
this repo had defects despite such checks, so the per-task reviews stay.

## Self-review record

- Spec coverage: P1 → Task 4; P2 → Task 4; P3 → Task 5; P4 → Task 7; P5 → Task 8; P6 → Task 6; results table and the Developer ID carry-over → Task 9. The spec's "P1 and P3 run first" holds (Tasks 4 and 5). The Node-child form of P1 is NOT pre-built here: it needs a native addon, so it is planned only if the standalone helper fails (Task 4 Step 6 says so and stops).
- Known weak point, stated rather than hidden: the Rust source in Task 5 is uncompiled; the task carries a three-hour time box whose expiry is itself the P3 verdict.
- Type consistency: the probe's `check`/`read` field names (`preflight`, `titles`, `window`, `capture`, `errorDomain`, `errorCode`, `text`, `lines[].topPx/bottomPx`, `captureMs`, `recogniseMs`) are the ones `main.js`, `score.py`, `toolbar.py` and the runners read. The `run` scenario is defined in Task 5 Step 3 and referenced, with its fallback instruction, in Task 7.
