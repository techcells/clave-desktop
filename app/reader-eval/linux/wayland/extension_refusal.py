# Task 7 review I2, live: the extension refuses a reader whose binary was replaced on disk while it
# ran (a package upgrade), and the reader now says so (protocol 4's `extension` event). Replaces the
# binary with a byte-identical copy, so nothing else changes. Prints events and outcomes only.
import json, os, shutil, subprocess, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
print("ready:", json.loads(p.stdout.readline()).get("protocol"))
p.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n")
events = []
def front(i):
    p.stdin.write(json.dumps({"op": "frontWindow", "id": i}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("event") == "extension":
            events.append(m)
            continue
        if m.get("id") == i:
            return "window" if m.get("window") else "none"
print("before the replacement:", front(1), "| extension events:", events)
copy = BIN + ".probe-copy"
shutil.copy2(BIN, copy)
os.replace(copy, BIN)                    # the running reader's executable is now "(deleted)"
time.sleep(0.5)
print("after the replacement:", front(2), "| extension events:", events)
print("asked again:", front(3), "| extension events:", events, "(sent once)")
p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
q = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(q.stdout.readline())
q.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n")
q.stdin.write(json.dumps({"op": "frontWindow", "id": 9}) + "\n"); q.stdin.flush()
while True:
    m = json.loads(q.stdout.readline())
    if m.get("id") == 9:
        print("a fresh reader:", "window" if m.get("window") else "none")
        break
q.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); q.stdin.flush(); q.wait(5)
