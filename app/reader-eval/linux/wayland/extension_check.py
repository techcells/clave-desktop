# Checks the production Clave focus extension (app/linux/gnome-extension) from inside the session:
#   python3 extension_check.py get          ask Get() once and describe the answer
#   python3 extension_check.py listen N     ask Get(), then count FocusChanged signals for N seconds
#   python3 extension_check.py overhear N   do NOT ask Get(); count FocusChanged signals for N seconds
# A window title is never printed, only its length.
import json, sys
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def get():
    try:
        reply = bus.call_sync("org.gnome.Shell", "/com/clave/Focus", "com.clave.Focus", "Get", None,
                              GLib.VariantType("(s)"), 0, 5000, None)
    except GLib.Error as error:
        return {"error": Gio.DBusError.get_remote_error(error) or error.message}
    window = json.loads(reply.unpack()[0])
    if window is None:
        return {"window": None}
    return {"window": {**window, "title": f"<{len(window['title'])} chars>"}}


def count_signals(seconds):
    seen = []
    bus.signal_subscribe(None, "com.clave.Focus", "FocusChanged", "/com/clave/Focus", None, 0,
                         lambda *args: seen.append(args[5].unpack()[0]))
    loop = GLib.MainLoop()
    GLib.timeout_add_seconds(seconds, loop.quit)
    loop.run()
    return seen


mode = sys.argv[1] if len(sys.argv) > 1 else "get"
if mode == "get":
    print(json.dumps(get()))
elif mode == "listen":
    print(json.dumps({"get": get(), "signals": len(count_signals(int(sys.argv[2])))}))
elif mode == "overhear":
    print(json.dumps({"signals": len(count_signals(int(sys.argv[2])))}))
