# The Wayland pipeline end to end: ask the extension for the focused window, take a portal
# screenshot, crop to the window, delete the file, recognise with Tesseract on one thread.
# Prints the timing of each step and the recognised text.
import json, os, subprocess, time, urllib.parse
from gi.repository import Gio, GLib
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
t = {}
started = time.time()
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
reply = bus.call_sync("org.gnome.Shell", "/com/clave/Focus", "com.clave.Focus", "Get", None, GLib.VariantType("(s)"), 0, -1, None)
win = json.loads(reply.unpack()[0])
t["focus"] = time.time() - started
if win is None:
    raise SystemExit("no focused window")

started = time.time()
uri = subprocess.run(["python3", os.path.join(HERE, "shot.py"), "1"], capture_output=True, text=True, check=True).stdout.split()[-1]
path = urllib.parse.unquote(uri[len("file://"):])
t["screenshot"] = time.time() - started

started = time.time()
screen = Image.open(path)
screen.load()
os.remove(path)
x, y, w, h = [int(v * win["scale"]) for v in win["frame"]]
crop = screen.crop((x, y, x + w, y + h)).convert("L")
crop.save("/tmp/window.png")
t["crop+delete"] = time.time() - started

started = time.time()
text = subprocess.run(["tesseract", "/tmp/window.png", "-", "-l", "eng"], capture_output=True, text=True,
                      env={**os.environ, "OMP_THREAD_LIMIT": "1"}).stdout
t["tesseract"] = time.time() - started
print(json.dumps({"window": win, "screen": screen.size, "crop": crop.size, "ms": {k: int(v * 1000) for k, v in t.items()}}, ensure_ascii=False))
print(text.strip())
