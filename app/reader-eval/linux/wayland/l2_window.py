# L2/L4: a window of our own whose content says where its edges are. Five words are drawn at known
# places, measured in GTK's logical pixels from the drawing area's corners, and their ink boxes are
# written to ~/clave-probe/l2-expected.json for l2_crop.py. Undecorated by default, so the window's
# frame IS the drawing area; "decorated" adds the usual title bar (GTK's own on Wayland, Mutter's on
# X11), which moves the words down by its height and nothing else.
# "fullscreen=N" puts it fullscreen on monitor N (the one placement a Wayland client can ask for);
# "at=X,Y" moves it there in the layout (X11 clients only; Wayland ignores it).
#   python3 l2_window.py wayland|x11 [decorated] [WIDTHxHEIGHT] [fullscreen=N] [at=X,Y]
import json, os, sys

os.environ["GDK_BACKEND"] = sys.argv[1]
import gi
gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk
import cairo

APP_ID = "dev.clave.ProbeL2"
INSET, SIZE = 24, 30
WIDTH, HEIGHT = next((tuple(map(int, a.split("x"))) for a in sys.argv[2:] if a[0].isdigit()), (900, 560))
# word, horizontal anchor, vertical anchor, extra distance from that vertical edge
WORDS = [("NORTHWEST", "left", "top", 0), ("NORTHEAST", "right", "top", 70), ("CENTRE", "centre", "centre", 0),
         ("SOUTHWEST", "left", "bottom", 70), ("SOUTHEAST", "right", "bottom", 0)]
decorated = "decorated" in sys.argv[1:]
options = dict(a.split("=", 1) for a in sys.argv[2:] if "=" in a)
expected = os.path.expanduser("~/clave-probe/l2-expected.json")
written = None  # the size last written: the boxes are written again whenever the window is resized

GLib.set_prgname(APP_ID)
Gdk.set_program_class(APP_ID)


def draw(area, cr):
    global written
    width, height = area.get_allocated_width(), area.get_allocated_height()
    cr.set_source_rgb(1, 1, 1)
    cr.paint()
    cr.set_source_rgb(0, 0, 0)
    cr.select_font_face("DejaVu Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(SIZE)
    boxes = {}
    for word, across, down, extra in WORDS:
        x_bearing, y_bearing, ink_width, ink_height, _, _ = cr.text_extents(word)
        left = {"left": INSET, "right": width - INSET - ink_width, "centre": (width - ink_width) / 2}[across]
        top = {"top": INSET + extra, "bottom": height - INSET - extra - ink_height, "centre": (height - ink_height) / 2}[down]
        cr.move_to(left - x_bearing, top - y_bearing)
        cr.show_text(word)
        boxes[word] = [left, top, left + ink_width, top + ink_height]
    if written != (width, height):
        written = (width, height)
        os.makedirs(os.path.dirname(expected), exist_ok=True)
        with open(expected + ".part", "w") as f:
            json.dump({"width": width, "height": height, "decorated": decorated, "backend": type(area.get_display()).__name__,
                       "boxes": boxes}, f)
        os.replace(expected + ".part", expected)
    return False


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="Clave L2 probe")
    window.set_decorated(decorated)
    window.set_resizable("fullscreen" in options)
    area = Gtk.DrawingArea()
    area.set_size_request(WIDTH, HEIGHT)
    area.connect("draw", draw)
    window.add(area)
    if "fullscreen" in options:
        window.fullscreen_on_monitor(window.get_screen(), int(options["fullscreen"]))
    window.show_all()
    window.present()
    if "at" in options:
        x, y = map(int, options["at"].split(","))
        GLib.timeout_add(300, lambda: window.move(x, y) and False)


application = Gtk.Application(application_id=APP_ID)
application.connect("activate", activate)
application.run([])
