# Task 6 live check: does the reader withhold Chrome by its interface language? Prints the app
# name, app id and the bandWithheld flag only; never a title.
import json, os, subprocess, sys, time, shutil
BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
lang = sys.argv[1]
tag = lang.split(".")[0]
profile = f"/tmp/clave-chrome-{tag}"
desktop = os.path.expanduser(f"~/.local/share/applications/clave-probe-chrome-{tag}.desktop")
shutil.rmtree(profile, ignore_errors=True)
os.makedirs(os.path.dirname(desktop), exist_ok=True)
with open(desktop, "w") as f:
    f.write("[Desktop Entry]\nType=Application\nName=Clave probe\nNoDisplay=true\nStartupNotify=true\n"
            f"Exec=env -u LANGUAGE -u LC_ALL -u LC_MESSAGES LANG={lang} google-chrome --user-data-dir={profile} "
            "--no-first-run --no-default-browser-check --password-store=basic --new-window about:blank\n")

renv = dict(os.environ)
renv["CLAVE_TESSDATA"] = os.path.expanduser("~/tessdata")
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=renv)
json.loads(p.stdout.readline())
p.stdin.write(json.dumps({"op": "grant", "token": open(os.path.expanduser("~/.clave-cast-token")).read().strip()}) + "\n"); p.stdin.flush()
def ask(i):
    p.stdin.write(json.dumps({"op": "frontWindow", "id": i}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            return m.get("window")
def show(label, w):
    if w is None:
        print(label, "-> no front window")
    else:
        print(label, "-> app:", w.get("app"), "| bundleId:", w.get("bundleId"), "| bandWithheld:", w.get("bandWithheld", False))

show("before", ask(1))
subprocess.run(["gtk-launch", os.path.basename(desktop)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(7)
show(f"LANG {lang}", ask(2))
p.stdin.write(json.dumps({"op": "shutdown"}) + "\n"); p.stdin.flush(); p.wait(5)
subprocess.run(["pkill", "-f", "--", f"--user-data-dir={profile}"])
time.sleep(2)
os.remove(desktop)
shutil.rmtree(profile, ignore_errors=True)
