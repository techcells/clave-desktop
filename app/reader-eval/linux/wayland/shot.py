# The Screenshot portal, non-interactive, N times: does it ask, and how long does each take?
import sys, time
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
sender = bus.get_unique_name()[1:].replace(".", "_")
loop = GLib.MainLoop()
def once(n):
    token = f"clave{n}"
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    result = {}
    def on_response(_c, _s, _p, _i, _sig, params, *_):
        code, res = params.unpack(); result["code"] = code; result["uri"] = res.get("uri"); loop.quit()
    sub = bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", path, None, 0, on_response)
    started = time.time()
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
                  GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)})),
                  None, 0, -1, None)
    GLib.timeout_add_seconds(120, loop.quit); loop.run(); bus.signal_unsubscribe(sub)
    print(f"shot {n}: code {result.get('code')} ({'ok' if result.get('code') == 0 else 'refused/cancelled'}) {int((time.time()-started)*1000)} ms {result.get('uri')}", flush=True)
for n in range(int(sys.argv[1]) if len(sys.argv) > 1 else 3): once(n)
