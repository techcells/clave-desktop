# After the owner stopped the share from GNOME's indicator: does a NEW reader process, given the kept
# token (as the app gives it at launch), reopen the share without a dialog? Prints codes only.
#   python3 stop_restart.py
import json, os, subprocess, time
BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
TOKEN = os.path.expanduser("~/.clave-cast-token")
p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata"), OMP_THREAD_LIMIT="1"))
fresh = []
def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
def recv(i):
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("event") == "grant":
            fresh.append(1); open(TOKEN, "w").write(m["token"]); os.chmod(TOKEN, 0o600); continue
        if m.get("id") == i: return m
def sessions():
    out = subprocess.run(["busctl", "--user", "tree", "org.freedesktop.portal.Desktop"], capture_output=True, text=True).stdout
    return sum(1 for l in out.splitlines() if "/session/" in l)
p.stdout.readline()
send({"op": "grant", "token": open(TOKEN).read().strip()})
send({"op": "permission", "id": 1}); print("permission:", recv(1)["permission"])
send({"op": "frontWindow", "id": 2}); w = recv(2)["window"]
print("front:", None if w is None else w.get("app"))
start = time.time()
if w is not None:
    send({"op": "read", "id": 3, "budgetMs": 20000, "expect": w}); r = recv(3)
    print(f"read after {time.time() - start:.1f} s:", {k: r[k] for k in ("ok", "reason", "detail") if k in r})
print("portal sessions:", sessions(), "| fresh token:", bool(fresh))
send({"op": "release"}); send({"op": "shutdown"}); p.wait(10)
