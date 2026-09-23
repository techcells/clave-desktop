# L7: a browser's toolbar band on Linux, measured through the real reader. Opens our own local page
# in a throwaway profile, reads the focused window with `lines: true`, and prints every line's box IN
# POINTS (scale from the monitor, 1 in the VM) with a LABEL instead of its text:
#   ADDRESS  the line holds our page's path (the address row)
#   BADGE    a private-window word (Incognito, Private, Privat...)
#   PAGE     our page's own first line ("Clave probe page")
#   OTHER    anything else (tabs, buttons), shown by length only
# No recognised text is printed.
#   python3 l7_band.py chrome|firefox normal|private [LANG] [wait-seconds] [scale]
import json, os, re, shutil, subprocess, sys, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
browser, mode = sys.argv[1], sys.argv[2]
lang = sys.argv[3] if len(sys.argv) > 3 else "en_US.UTF-8"
wait = int(sys.argv[4]) if len(sys.argv) > 4 else (15 if browser == "firefox" else 8)
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
work = os.path.expanduser("~/clave-probe")
page = os.path.join(work, "page.html")
profile = os.path.join(work, f"band-{browser}-{mode}")
os.makedirs(work, exist_ok=True)
shutil.rmtree(profile, ignore_errors=True)
with open(page, "w") as f:
    f.write("<!doctype html><title>ClaveProbePage</title>"
            "<body style='margin:8px;font:20px sans-serif'>Clave probe page<br>second line of the page</body>\n")
url = "file://" + page
if browser == "chrome":
    flags = f"--user-data-dir={profile} --no-first-run --no-default-browser-check --password-store=basic"
    command = f"google-chrome {flags} {'--incognito' if mode == 'private' else '--new-window'} {url}"
else:
    os.makedirs(profile, exist_ok=True)
    command = f"firefox --no-remote --profile {profile} {'--private-window' if mode == 'private' else '--new-window'} {url}"
desktop = os.path.expanduser("~/.local/share/applications/clave-probe-band.desktop")
with open(desktop, "w") as f:
    f.write("[Desktop Entry]\nType=Application\nName=Clave probe\nNoDisplay=true\nStartupNotify=true\n"
            f"Exec=env -u LANGUAGE -u LC_ALL -u LC_MESSAGES LANG={lang} {command}\n")
subprocess.run(["gtk-launch", os.path.basename(desktop)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(wait)

p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(p.stdout.readline())
token_file = os.path.expanduser("~/.clave-cast-token")
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
BADGE = re.compile(r"(^|[^a-zà-ÿ])(incognito|private|privat|inkognito|incógnito|anônima)", re.I)
def label(text):
    found = [name for name, hit in (("ADDRESS", "clave-probe" in text or "page.html" in text),
                                    ("BADGE", BADGE.search(text) is not None),
                                    ("PAGE", "Clave probe page" in text or "second line" in text)) if hit]
    return "+".join(found) or "OTHER"

send({"op": "grant", "token": open(token_file).read().strip()})
send({"op": "frontWindow", "id": 1})
window = answer(1).get("window")
result = None
if window is not None:
    for attempt in range(4):
        send({"op": "read", "id": 10 + attempt, "budgetMs": 1500, "expect": window, "lines": True})
        result = answer(10 + attempt)
        if result.get("ok"):
            break
send({"op": "release"}); send({"op": "shutdown"}); p.wait(5)

print(f"{browser} {mode} {lang}:", None if window is None else (window.get("app"), window.get("bundleId")))
if not result or not result.get("ok"):
    print("  read failed:", None if result is None else {k: result.get(k) for k in ("reason", "detail")})
else:
    stats = result.get("stats", {})
    print(f"  capture {stats.get('width')}x{stats.get('height')} px, scale {scale}, band {stats.get('bandPx')} px")
    strip = result.get("toolbarText")
    if strip is None:
        print("  toolbar strip: none (not a measured browser)")
    else:
        print(f"  toolbar strip: address {label(strip).find('ADDRESS') >= 0} | private marker {BADGE.search(strip) is not None}"
              f" | page text in it {'Clave probe page' in strip or 'second line' in strip}")
    for line in sorted(result.get("lines", []), key=lambda l: (l["topPx"], l["leftPx"])):
        if line["topPx"] / scale > 200:
            continue
        print(f"  top {line['topPx'] / scale:6.1f}  bottom {line['bottomPx'] / scale:6.1f}  left {line['leftPx'] / scale:6.1f}"
              f"  {label(line["text"]):14} ({len(line['text'])} chars)")
pattern = "--user-data-dir=" + profile if browser == "chrome" else profile
subprocess.run(["pkill", "-f", "--", pattern])
time.sleep(3)
os.remove(desktop)
shutil.rmtree(profile, ignore_errors=True)
