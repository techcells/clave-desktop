# L5 and L8 (Linux plan, Task 11): read times and read outcomes over a working session, through the
# INSTALLED reader (/opt/Clave Agent Internal/clave-reader, with the models beside it), the way the app's
# capture loop reads: every INTERVAL seconds ask what is in front, then read it with the app's Linux budget
# (READ_BUDGET_MS_LINUX, 2500 ms since 2026-09-24; --budget 1500 gives the shared one) and that window as
# the expectation. The owner works normally meanwhile. L5's own bar stays 1000 ms at the 95th percentile.
#
# Records per read only: the application name the extension reports, the round-trip time of the read
# call, the reader's capture and recognition times, whether its pixel cache answered, the outcome code,
# and how many lines and characters came back. NEVER a window title or any recognised text: the text is
# counted and dropped. Windows the app would never read are skipped the same way it skips them: none in
# front, the app itself, "Passwords and Keys", and a browser the reader withholds (bandWithheld).
#
# The screen-share grant is this probe's own (a token file under ~/clave-probe, 0600), never the app's:
# with no token it asks through `requestPermission`, which shows GNOME's Share dialog once.
# `windowsSeen` counts every front window by application name and id, skipped ones included: that is
# how the packaged app's own window is seen to be named "Clave Agent Internal" (dev.clave.agent.internal).
#   python3 l5_session.py [--minutes 10] [--interval 2] [--budget MS] [--reader PATH]
# Writes each row to ~/clave-probe/l5-<unix time>.jsonl as it is read (so a reader that dies loses nothing),
# then ~/clave-probe/l5-<unix time>.json (the rows and the summary), and prints the summary.
import json, math, os, subprocess, sys, time

args = sys.argv[1:]
opt = lambda name, default: args[args.index(name) + 1] if name in args else default
MINUTES = float(opt("--minutes", "10"))
INTERVAL = float(opt("--interval", "2"))
READER = opt("--reader", "/opt/Clave Agent Internal/clave-reader")
BUDGET_MS = int(opt("--budget", "2500"))   # app/src/main/constants.ts READ_BUDGET_MS_LINUX
PASS_P95_MS = 1000         # L5's bar (design section 11, item 8: two thirds of the shared 1500 ms budget)
SKIP_APPS = {"Clave Agent Internal", "Clave Agent", "Passwords and Keys"}
OUT = os.path.expanduser("~/clave-probe")
TOKEN = os.path.join(OUT, "l5-token")
os.makedirs(OUT, exist_ok=True)

p = subprocess.Popen([READER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, OMP_THREAD_LIMIT="1"))   # CLAVE_TESSDATA unset: the models beside the reader
hello = json.loads(p.stdout.readline())


def send(message):
    p.stdin.write(json.dumps(message) + "\n")
    p.stdin.flush()


class ReaderGone(Exception):
    pass


def answer(i):
    while True:
        line = p.stdout.readline()
        if not line:
            raise ReaderGone()
        m = json.loads(line)
        if m.get("event") == "grant":
            with open(TOKEN + ".part", "w") as f:
                f.write(m["token"])
            os.chmod(TOKEN + ".part", 0o600)
            os.replace(TOKEN + ".part", TOKEN)
            continue
        if "event" in m:
            continue
        if m.get("id") == i:
            return m


# The Linux reader answers what is in front only once it holds a screen-share grant: the saved token
# if there is one, else GNOME's Share dialog through `requestPermission` (the app's "Share the screen").
if os.path.exists(TOKEN):
    send({"op": "grant", "token": open(TOKEN).read().strip()})
next_id = 1


def ask(op):
    global next_id
    next_id += 1
    send({"op": op, "id": next_id})
    return answer(next_id)


permission = ask("permission").get("permission")
if permission != "granted":
    # Only acknowledged at once (`{"id": n}`); the dialog's outcome shows in `permission` afterwards.
    print("asking for the screen share: press Share in GNOME's dialog", flush=True)
    ask("requestPermission")
    deadline = time.monotonic() + 180
    while permission != "granted" and time.monotonic() < deadline:
        time.sleep(2)
        permission = ask("permission").get("permission")
print("permission:", permission, flush=True)
if permission != "granted":
    send({"op": "shutdown"})
    sys.exit(1)

rows, skipped, seen = [], {}, {}
stamp = int(time.time())
live = open(os.path.join(OUT, f"l5-{stamp}.jsonl"), "w")
reader_gone = False
end = time.monotonic() + MINUTES * 60
while time.monotonic() < end:
    started = time.monotonic()
    try:
        window = ask("frontWindow").get("window")
    except ReaderGone:
        reader_gone = True
        break
    if window is not None:
        key = f"{window.get('app')} | {window.get('bundleId')}"
        seen[key] = seen.get(key, 0) + 1
    why = ("noWindow" if window is None else "self" if window.get("app") in SKIP_APPS else "withheld" if window.get("bandWithheld") else None)
    if why:
        skipped[why] = skipped.get(why, 0) + 1
    else:
        t0 = time.monotonic()
        next_id += 1
        send({"op": "read", "id": next_id, "budgetMs": BUDGET_MS, "expect": window})
        try:
            result = answer(next_id)
        except ReaderGone:
            reader_gone = True
            break
        wall = round((time.monotonic() - t0) * 1000)
        stats = result.get("stats") or {}
        text = result.get("text") or ""
        rows.append({"app": window.get("app") or window.get("bundleId") or "?", "ms": wall,
                     "captureMs": stats.get("captureMs"), "recogniseMs": stats.get("recogniseMs"), "cacheHit": stats.get("cacheHit"),
                     "outcome": "ok" if result.get("ok") else result.get("reason", "?"),
                     "lines": len([l for l in text.split("\n") if l.strip()]), "chars": len(text)})
        detail = result.get("detail")
        if not result.get("ok") and isinstance(detail, str) and detail.isalpha():   # a fixed failure code, never text
            rows[-1]["detail"] = detail
        text = None
        live.write(json.dumps(rows[-1]) + "\n")
        live.flush()
    time.sleep(max(0.0, INTERVAL - (time.monotonic() - started)))

live.close()
try:
    send({"op": "release"})
    send({"op": "shutdown"})
    p.wait(5)
except (subprocess.TimeoutExpired, BrokenPipeError):
    p.kill()


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(q / 100 * len(s)) - 1))]


recognised = [r["ms"] for r in rows if r["outcome"] == "ok" and not r["cacheHit"]]
cached = [r["ms"] for r in rows if r["outcome"] == "ok" and r["cacheHit"]]
outcomes, by_app = {}, {}
for r in rows:
    outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1
    a = by_app.setdefault(r["app"], {"reads": 0, "ok": 0, "cacheHit": 0, "emptyOk": 0, "p95ms": None, "_ms": []})
    a["reads"] += 1
    if r["outcome"] == "ok":
        a["ok"] += 1
        a["cacheHit"] += 1 if r["cacheHit"] else 0
        a["emptyOk"] += 1 if r["lines"] == 0 else 0
        if not r["cacheHit"]:
            a["_ms"].append(r["ms"])
for a in by_app.values():
    a["p95ms"] = pct(a.pop("_ms"), 95)
p95 = pct(recognised, 95)
summary = {
    "reader": READER, "protocol": hello.get("protocol"), "minutes": MINUTES, "intervalS": INTERVAL, "budgetMs": BUDGET_MS,
    "reads": len(rows), "skipped": skipped, "outcomes": outcomes, "readerGone": reader_gone,
    "recognised": {"n": len(recognised), "p50": pct(recognised, 50), "p95": p95, "max": max(recognised) if recognised else None,
                   # A read that runs past the budget comes back as `timeout`; count those, and any ok read over it.
                   "overBudget": outcomes.get("timeout", 0) + len([m for m in recognised if m > BUDGET_MS])},
    "cacheHits": {"n": len(cached), "p95": pct(cached, 95)},
    "captureMsP95": pct([r["captureMs"] for r in rows if r["captureMs"] is not None], 95),
    "recogniseMsP95": pct([r["recogniseMs"] for r in rows if r["recogniseMs"] is not None], 95),
    "byApp": by_app,
    "windowsSeen": seen,
    "L5": None if p95 is None else ("PASS" if p95 <= PASS_P95_MS else "FAIL"),
}
path = os.path.join(OUT, f"l5-{stamp}.json")
with open(path, "w") as f:
    json.dump({"summary": summary, "rows": rows}, f, indent=1)
print(json.dumps(summary, indent=1))
print("written", path)
