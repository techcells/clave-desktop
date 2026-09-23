# L2/L4: is the reader's crop exactly the focused window? Opens l2_window.py (our own window, five
# marker words at known places) as a Wayland or an X11 client, asks the RELEASE reader what is in
# front, reads it with `lines: true`, and compares every marker's line box with where the window drew
# it, times the pixel factor (the monitor scale; GTK's logical pixels to the stream's). Prints codes,
# sizes and pixel differences only; the only words recognised are our own markers, printed as labels.
#   python3 l2_crop.py wayland|x11 [decorated] [--factor K] [--wait S] [--size WIDTHxHEIGHT] [fullscreen=N] [at=X,Y] [--activate]
# Leaves ~/.local/share/applications/dev.clave.ProbeL2.desktop in place; remove it when done.
# Undecorated: every marker should land within a few pixels of (box * K), and the capture should be
# (width * K) x (height * K), one pixel more on a side at fractional scales (edges round outwards).
# Decorated: the left, right and bottom gaps should match the undecorated ones (no shadow in the
# crop); the top gap grows by the title bar.
import json, os, subprocess, sys, time

BIN = os.path.expanduser("~/clave/app/native/reader/target/release/clave-reader")
HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
backend = args[0]
decorated = "decorated" in args
factor = float(args[args.index("--factor") + 1]) if "--factor" in args else 1.0
wait = float(args[args.index("--wait") + 1]) if "--wait" in args else 3.0
size = args[args.index("--size") + 1] if "--size" in args else "900x560"
expected_file = os.path.expanduser("~/clave-probe/l2-expected.json")
desktop = os.path.expanduser("~/.local/share/applications/dev.clave.ProbeL2.desktop")

subprocess.run(["pkill", "-f", "l2_window.py"])
time.sleep(0.5)
if os.path.exists(expected_file):
    os.remove(expected_file)
# One .desktop file, left in place between runs: GNOME Shell learns of a new one only a moment after
# it appears, and a window that opens before that is reported with no app name. The window's
# settings travel in a file beside the expected boxes instead of the Exec line.
os.makedirs(os.path.dirname(expected_file), exist_ok=True)
with open(os.path.expanduser("~/clave-probe/l2-args"), "w") as f:
    f.write(" ".join([backend] + (["decorated"] if decorated else []) + [size] + [a for a in args if "=" in a]) + "\n")
if not os.path.exists(desktop):
    with open(desktop, "w") as f:
        f.write("[Desktop Entry]\nType=Application\nName=Clave L2 probe\nNoDisplay=true\nStartupNotify=true\n"
                "StartupWMClass=dev.clave.ProbeL2\n"
                f"Exec=sh -c 'exec python3 {HERE}/l2_window.py $(cat ~/clave-probe/l2-args)'\n")
    time.sleep(3)
subprocess.run(["gtk-launch", os.path.basename(desktop)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
    if os.path.exists(expected_file):
        break
    time.sleep(0.1)
if "--activate" in args:
    # On Xorg GNOME does not focus a window a script started (focus-stealing prevention); this asks
    # for it the way a pager does, which stands in for the user's click.
    subprocess.run(["xdotool", "search", "--sync", "--classname", "dev.clave.ProbeL2", "windowactivate", "--sync"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
time.sleep(wait)
drawn =json.load(open(expected_file)) if os.path.exists(expected_file) else None

p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env=dict(os.environ, CLAVE_TESSDATA=os.path.expanduser("~/tessdata"), OMP_THREAD_LIMIT="1"))
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


send({"op": "grant", "token": open(token_file).read().strip()})
send({"op": "frontWindow", "id": 1})
window = answer(1).get("window")
result, reasons = None, []
if window is not None:
    for attempt in range(4):
        send({"op": "read", "id": 10 + attempt, "budgetMs": 3000, "expect": window, "lines": True})
        result = answer(10 + attempt)
        if result.get("ok"):
            break
        reasons.append(result.get("reason"))
        time.sleep(1)
send({"op": "release"}); send({"op": "shutdown"})
try:
    p.wait(5)
except subprocess.TimeoutExpired:
    p.kill()

label = " ".join([backend] + (["decorated"] if decorated else []) + [f"x{factor:g}"] + [a for a in args if "=" in a])
if drawn is None:
    print(f"{label}: the probe window never drew")
elif window is None:
    print(f"{label}: frontWindow none")
else:
    ours = window.get("title") == "Clave L2 probe"
    print(f"{label}: front {window.get('app')!r} {window.get('bundleId')!r}, our window {ours}, drawn by {drawn['backend']} at {drawn['width']}x{drawn['height']}"
          f"{', failed reads first: ' + ','.join(map(str, reasons)) if reasons and result and result.get('ok') else ''}")
    if not result or not result.get("ok"):
        print("  read failed:", None if result is None else {k: result.get(k) for k in ("reason", "detail")})
    else:
        stats = result.get("stats", {})
        width, height = stats.get("width"), stats.get("height")
        want_w, want_h = drawn["width"] * factor, drawn["height"] * factor
        print(f"  capture {width}x{height} px; the drawing area times the factor {want_w:g}x{want_h:g}"
              f" (difference {width - want_w:+g}, {height - want_h:+g})")
        found, others = {}, 0
        for line in result.get("lines", []):
            words = [w for w in drawn["boxes"] if w in line["text"].upper()]
            if len(words) == 1 and words[0] not in found:
                found[words[0]] = line
            else:
                others += 1
        # Gaps from the crop's own edges, in pixels, against the drawn gaps times the factor.
        for word, (left, top, right, bottom) in drawn["boxes"].items():
            line = found.get(word)
            if line is None:
                print(f"  {word:9}  not found")
                continue
            print(f"  {word:9}  left {line['leftPx'] - left * factor:+6.1f}  top {line['topPx'] - top * factor:+6.1f}"
                  f"  right-gap {(width - line['rightPx']) - (drawn['width'] - right) * factor:+6.1f}"
                  f"  bottom-gap {(height - line['bottomPx']) - (drawn['height'] - bottom) * factor:+6.1f}")
        print(f"  other lines: {others}")
subprocess.run(["pkill", "-f", "l2_window.py"])
