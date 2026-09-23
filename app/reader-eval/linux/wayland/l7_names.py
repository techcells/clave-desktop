# L7: the app name and app id the reader reports for installed applications. Launches each through
# its own desktop entry (gtk-launch, so GNOME focuses it), asks frontWindow, prints name and id only
# (never a title), then closes it.
#   python3 l7_names.py org.gnome.Settings org.gnome.Nautilus ...
import json, os, subprocess, sys, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
token = open(os.path.expanduser("~/.clave-cast-token")).read().strip()
for entry in sys.argv[1:]:
    before = set(subprocess.run(["pgrep", "-u", str(os.getuid())], capture_output=True, text=True).stdout.split())
    subprocess.run(["gtk-launch", entry], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                         env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
    json.loads(p.stdout.readline())
    p.stdin.write(json.dumps({"op": "grant", "token": token}) + "\n")
    p.stdin.write(json.dumps({"op": "frontWindow", "id": 1}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == 1:
            break
    p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
    w = m.get("window")
    print(f"{entry}:", "no front window" if w is None else f"app {w.get('app')!r} | bundleId {w.get('bundleId')!r}")
    after = set(subprocess.run(["pgrep", "-u", str(os.getuid())], capture_output=True, text=True).stdout.split())
    for pid in after - before:
        subprocess.run(["kill", pid], stderr=subprocess.DEVNULL)
    time.sleep(2)
