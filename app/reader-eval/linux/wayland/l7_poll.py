# L7: what the reader says is in front, once a second, while the owner opens and closes GNOME Shell
# surfaces (a top-bar menu, the overview, a dialog). Prints the elapsed second and the app name or
# "none", only when it changes. Never a title.
#   python3 l7_poll.py [seconds]
import json, os, subprocess, sys, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 40
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(p.stdout.readline())
p.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n")
last, start = object(), time.time()
for i in range(1, seconds + 1):
    p.stdin.write(json.dumps({"op": "frontWindow", "id": i}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            break
    w = m.get("window")
    now = "none" if w is None else w.get("app")
    if now != last:
        print(f"{time.time() - start:5.1f} s  {now}", flush=True)
        last = now
    time.sleep(1)
p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
print("done", flush=True)
