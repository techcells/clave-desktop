# Task 6 review: is a window reported while a GNOME notification banner shows over it? Focuses a
# Terminal, sends one notification (our own fixed words), and asks frontWindow every 0.5 s for 10 s.
# Prints the elapsed time and the app name or "none" when it changes. Never a title.
import json, os, subprocess, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
subprocess.run(["gtk-launch", "org.gnome.Terminal"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(p.stdout.readline())
p.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n")
ids = iter(range(1, 1000))
def front():
    i = next(ids)
    p.stdin.write(json.dumps({"op": "frontWindow", "id": i}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            w = m.get("window")
            return "none" if w is None else w.get("app")
start, last = time.time(), None
def log(now):
    global last
    if now != last:
        print(f"{time.time() - start:5.1f} s  {now}", flush=True)
        last = now
log(front())
sent = subprocess.run(["notify-send", "-p", "Clave probe", "banner over the window"], capture_output=True, text=True)
note_id = sent.stdout.strip()
print(f"{time.time() - start:5.1f} s  (notification sent)", flush=True)
for step in range(20):
    time.sleep(0.5)
    log(front())
    if step == 5 and note_id.isdigit():
        # GNOME keeps a banner up while the user is idle; close it the way its sender could.
        subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications",
                        "--object-path", "/org/freedesktop/Notifications",
                        "--method", "org.freedesktop.Notifications.CloseNotification", note_id], stdout=subprocess.DEVNULL)
        print(f"{time.time() - start:5.1f} s  (notification closed)", flush=True)
p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
