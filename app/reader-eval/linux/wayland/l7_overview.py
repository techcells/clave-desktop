# L7: what the reader reports and reads while GNOME's Activities overview covers the screen.
# Focuses a Chrome window on our own page, then reads it with the overview closed and open. Prints
# app name, app id, and per read: ok or not, the number of lines, how many hold our page's text, and
# how many hold anything else. No recognised text or title is printed.
import json, os, shutil, subprocess, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
work = os.path.expanduser("~/clave-probe")
page = os.path.join(work, "page.html")
profile = os.path.join(work, "overview-chrome")
os.makedirs(work, exist_ok=True)
shutil.rmtree(profile, ignore_errors=True)
with open(page, "w") as f:
    f.write("<!doctype html><title>ClaveProbePage</title>"
            "<body style='margin:8px;font:20px sans-serif'>Clave probe page<br>second line of the page</body>\n")
desktop = os.path.expanduser("~/.local/share/applications/clave-probe-overview.desktop")
with open(desktop, "w") as f:
    f.write("[Desktop Entry]\nType=Application\nName=Clave probe\nNoDisplay=true\nStartupNotify=true\n"
            f"Exec=google-chrome --user-data-dir={profile} --no-first-run --no-default-browser-check "
            f"--password-store=basic --new-window file://{page}\n")
subprocess.run(["gtk-launch", os.path.basename(desktop)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(8)

def overview(active):
    subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell",
                    "--method", "org.freedesktop.DBus.Properties.Set", "org.gnome.Shell", "OverviewActive",
                    "<true>" if active else "<false>"], stdout=subprocess.DEVNULL)
    time.sleep(1.5)

token_file = os.path.expanduser("~/.clave-cast-token")
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(p.stdout.readline())
def send(message):
    p.stdin.write(json.dumps(message) + "\n"); p.stdin.flush()
def answer(i):
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("event") == "grant":
            with open(token_file, "w") as f:
                f.write(m["token"])
            os.chmod(token_file, 0o600)
            continue
        if m.get("id") == i:
            return m
send({"op": "grant", "token": open(token_file).read().strip()})
ids = iter(range(1, 1000))

def look(label):
    i = next(ids)
    send({"op": "frontWindow", "id": i})
    window = answer(i).get("window")
    if window is None:
        print(f"{label}: no front window"); return
    result = None
    for _ in range(3):
        i = next(ids)
        send({"op": "read", "id": i, "budgetMs": 1500, "expect": window, "lines": True})
        result = answer(i)
        if result.get("ok"):
            break
    lines = result.get("lines", []) if result.get("ok") else []
    ours = sum(("Clave probe page" in l["text"] or "second line" in l["text"]) for l in lines)
    print(f"{label}: app {window.get('app')!r} | id {window.get('bundleId')!r} | read ok {result.get('ok')} "
          f"{'' if result.get('ok') else result.get('reason')} | cache hit {result.get('stats', {}).get('cacheHit')} | lines {len(lines)} | our page's {ours} | other {len(lines) - ours}")

look("overview closed")
overview(True)
look("overview OPEN  ")
overview(False)
look("overview closed")
send({"op": "release"}); send({"op": "shutdown"}); p.wait(5)
subprocess.run(["pkill", "-f", "--", "--user-data-dir=" + profile])
time.sleep(3)
os.remove(desktop)
shutil.rmtree(work, ignore_errors=True)
