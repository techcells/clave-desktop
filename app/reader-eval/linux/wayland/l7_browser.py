# L7: what the reader is told about a browser window, normal or private, in a given language.
# Opens our own local page (title "ClaveProbePage") in a throwaway profile. Prints the app name, app
# id, bandWithheld, and the title ONLY with our page's name replaced by <PAGE> (what remains is the
# browser's own suffix); a title without our page name is printed as a length only.
#   python3 l7_browser.py chrome|firefox normal|private|permanent LANG [wait-seconds]   (permanent: Firefox only)
import json, os, shutil, subprocess, sys, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
browser, mode, lang = sys.argv[1], sys.argv[2], sys.argv[3]
wait = int(sys.argv[4]) if len(sys.argv) > 4 else (15 if browser == "firefox" else 7)
PAGE_NAME = "ClaveProbePage"
# Firefox is a snap: only non-hidden folders under home are visible to it, and its /tmp is its own.
work = os.path.expanduser("~/clave-probe")
page = os.path.join(work, "page.html")
profile = os.path.join(work, f"{browser}-{mode}-{lang.split('.')[0]}")
os.makedirs(work, exist_ok=True)
shutil.rmtree(profile, ignore_errors=True)
with open(page, "w") as f:
    f.write(f"<!doctype html><title>{PAGE_NAME}</title><body style='font:20px sans-serif'>Clave probe page</body>\n")
url = "file://" + page
if browser == "chrome":
    flags = f"--user-data-dir={profile} --no-first-run --no-default-browser-check --password-store=basic"
    command = f"google-chrome {flags} {'--incognito' if mode == 'private' else '--new-window'} {url}"
else:
    os.makedirs(profile, exist_ok=True)
    if mode == "permanent":
        # "Never remember history": every window private, with a normal title (Task 6 review).
        with open(os.path.join(profile, "user.js"), "w") as f:
            f.write('user_pref("browser.privatebrowsing.autostart", true);\n')
    command = f"firefox --no-remote --profile {profile} {'--private-window' if mode == 'private' else '--new-window'} {url}"
desktop = os.path.expanduser("~/.local/share/applications/clave-probe-l7.desktop")
with open(desktop, "w") as f:
    f.write("[Desktop Entry]\nType=Application\nName=Clave probe\nNoDisplay=true\nStartupNotify=true\n"
            f"Exec=env -u LANGUAGE -u LC_ALL -u LC_MESSAGES LANG={lang} {command}\n")
subprocess.run(["gtk-launch", os.path.basename(desktop)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(wait)

p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata")))
json.loads(p.stdout.readline())
p.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n")
p.stdin.write(json.dumps({"op": "frontWindow", "id": 1}) + "\n"); p.stdin.flush()
while True:
    m = json.loads(p.stdout.readline())
    if m.get("id") == 1:
        break
p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
w = m.get("window")
label = f"{browser} {mode} {lang}"
if w is None:
    print(label, "-> no front window")
else:
    title = w.get("title", "")
    shown = title.replace(PAGE_NAME, "<PAGE>") if PAGE_NAME in title else f"<other title, {len(title)} chars>"
    print(label, "-> app:", repr(w.get("app")), "| bundleId:", repr(w.get("bundleId")),
          "| bandWithheld:", w.get("bandWithheld", False), "| title:", repr(shown))
pattern = "--user-data-dir=" + profile if browser == "chrome" else profile
subprocess.run(["pkill", "-f", "--", pattern])
time.sleep(3)
os.remove(desktop)
shutil.rmtree(profile, ignore_errors=True)
