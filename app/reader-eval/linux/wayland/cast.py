# The ScreenCast portal: one monitor, persist_mode 2 (until revoked). First run asks; the saved
# restore token should make later runs silent. Grabs one frame through PipeWire with GStreamer.
import os, subprocess, sys, time
from gi.repository import Gio, GLib
TOKEN_FILE = os.path.expanduser("~/.clave-cast-token")
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
sender = bus.get_unique_name()[1:].replace(".", "_")
loop = GLib.MainLoop(); n = [0]
def request(method, args_fmt, args):
    n[0] += 1; token = f"cast{os.getpid()}_{n[0]}"
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    got = {}
    def on_response(_c, _s, _p, _i, _sig, params, *_):
        got["code"], got["res"] = params.unpack(); loop.quit()
    sub = bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", path, None, 0, on_response)
    args[-1]["handle_token"] = GLib.Variant("s", token)
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.ScreenCast", method,
                  GLib.Variant(args_fmt, tuple(args)), None, 0, -1, None)
    GLib.timeout_add_seconds(120, loop.quit); loop.run(); bus.signal_unsubscribe(sub)
    return got.get("code"), got.get("res", {})
started = time.time()
code, res = request("CreateSession", "(a{sv})", [{"session_handle_token": GLib.Variant("s", f"s{os.getpid()}")}])
session = res["session_handle"]
opts = {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False), "persist_mode": GLib.Variant("u", 2), "cursor_mode": GLib.Variant("u", 1)}
if os.path.exists(TOKEN_FILE): opts["restore_token"] = GLib.Variant("s", open(TOKEN_FILE).read().strip())
code, _ = request("SelectSources", "(oa{sv})", [session, opts])
code, res = request("Start", "(osa{sv})", [session, "", {}])
print(f"start: code {code} after {int((time.time()-started)*1000)} ms, restore token {'reused' if 'restore_token' in opts else 'new'}")
if code != 0: sys.exit(1)
if res.get("restore_token"): open(TOKEN_FILE, "w").write(res["restore_token"])
node = res["streams"][0][0]
fdlist = Gio.UnixFDList()
reply, fds = bus.call_with_unix_fd_list_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.ScreenCast",
    "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (session, {})), None, 0, -1, fdlist, None)
fd = fds.get(reply.unpack()[0])
out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cast.png"
t = time.time()
subprocess.run(["gst-launch-1.0", "-q", "pipewiresrc", f"fd={fd}", f"path={node}", "num-buffers=1", "!", "videoconvert", "!", "pngenc", "!", "filesink", f"location={out}"],
               pass_fds=[fd], check=True, timeout=30)
print(f"frame: {out} in {int((time.time()-t)*1000)} ms")
