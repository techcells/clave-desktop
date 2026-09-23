# L4: a second display for a VM that has one. Mutter's own ScreenCast API can record a VIRTUAL
# monitor (what GNOME Remote Desktop's "extend" mode uses): the monitor joins the layout while a
# PipeWire consumer (here gst-launch into fakesink, nothing kept) takes its stream. Runs for SECONDS,
# printing the layout once the monitor is there, then stops the session, which removes the monitor.
#   python3 l4_virtual.py SECONDS [WIDTHxHEIGHT]
import subprocess, sys, time

from gi.repository import Gio, GLib

seconds = float(sys.argv[1])
width, height = map(int, (sys.argv[2] if len(sys.argv) > 2 else "1280x800").split("x"))
bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def call(path, interface, method, args=None, dest="org.gnome.Mutter.ScreenCast"):
    return bus.call_sync(dest, path, interface, method, args, None, Gio.DBusCallFlags.NONE, -1, None).unpack()


def layout():
    _, monitors, logical, properties = call("/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig",
                                            "GetCurrentState", dest="org.gnome.Mutter.DisplayConfig")
    return [(l[0], l[1], l[2], [m[0] for m in l[5]]) for l in logical]


(session,) = call("/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast", "CreateSession",
                  GLib.Variant("(a{sv})", ({},)))
(stream,) = call(session, "org.gnome.Mutter.ScreenCast.Session", "RecordVirtual",
                 GLib.Variant("(a{sv})", ({"cursor-mode": GLib.Variant("u", 0), "is-platform": GLib.Variant("b", True)},)))
node = []
bus.signal_subscribe("org.gnome.Mutter.ScreenCast", "org.gnome.Mutter.ScreenCast.Stream", "PipeWireStreamAdded",
                     stream, None, Gio.DBusSignalFlags.NONE, lambda *a: node.append(a[5].unpack()[0]))
call(session, "org.gnome.Mutter.ScreenCast.Session", "Start")
context = GLib.MainContext.default()
deadline = time.time() + 5
while not node and time.time() < deadline:
    context.iteration(False)
    time.sleep(0.05)
if not node:
    print("no PipeWire node for the virtual stream")
    sys.exit(1)
consumer = subprocess.Popen(["gst-launch-1.0", "-q", "pipewiresrc", f"path={node[0]}", "!",
                             f"video/x-raw,width={width},height={height}", "!", "fakesink"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
print("layout with the virtual monitor:", layout(), flush=True)
time.sleep(max(0.0, seconds - 3))
consumer.terminate()
call(session, "org.gnome.Mutter.ScreenCast.Session", "Stop")
time.sleep(2)
print("layout after:", layout(), flush=True)
