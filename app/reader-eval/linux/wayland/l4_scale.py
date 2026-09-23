# L4: sets the VM's one monitor to a mode and a scale through Mutter's DisplayConfig, TEMPORARILY
# (method 1: not written to monitors.xml, so a reboot restores the saved setup). "fractional on"
# switches GNOME's scale-monitor-framebuffer on first (logical layout, fractional scales offered);
# "off" switches it off (physical layout, whole scales only). The scale asked for is matched to the
# nearest one Mutter offers for that mode. Prints the layout mode and the scale applied.
#   python3 l4_scale.py WIDTHxHEIGHT SCALE [fractional on|off]
#   python3 l4_scale.py state
import subprocess, sys, time

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def call(method, args=None):
    return bus.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                         "org.gnome.Mutter.DisplayConfig", method, args, None, Gio.DBusCallFlags.NONE, -1, None).unpack()


def state():
    serial, monitors, logical, properties = call("GetCurrentState")
    current = [(m[0], mode) for m in monitors for mode in m[1] if mode[6].get("is-current")]
    return serial, monitors, logical, properties, current


def describe():
    _, _, logical, properties, current = state()
    print(f"layout-mode {properties.get('layout-mode')} ({'logical' if properties.get('layout-mode') == 1 else 'physical'}),"
          f" modes {[mode[0] for _, mode in current]}, logical monitors {[(l[0], l[1], l[2]) for l in logical]}")


if sys.argv[1] == "state":
    describe()
    sys.exit()

size, wanted = sys.argv[1], float(sys.argv[2])
if "fractional" in sys.argv:
    on = sys.argv[sys.argv.index("fractional") + 1] == "on"
    subprocess.run(["gsettings", "set", "org.gnome.mutter", "experimental-features",
                    "['scale-monitor-framebuffer']" if on else "[]"], check=True)
    time.sleep(2)
serial, monitors, _, _, _ = state()
connector = monitors[0][0][0]
modes = [mode for mode in monitors[0][1] if mode[0].startswith(size + "@")]
mode = max(modes, key=lambda m: m[3])
scale = min(mode[5], key=lambda s: abs(s - wanted))
call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})",
                                         (serial, 1, [(0, 0, scale, 0, True, [(connector, mode[0], {})])], {})))
time.sleep(3)
print(f"applied {mode[0]} scale {scale}")
describe()
