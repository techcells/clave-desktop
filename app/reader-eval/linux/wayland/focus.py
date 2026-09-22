# Which window is focused, and where is it? Tries every route a Linux reader could use and prints what each returns.
import json, subprocess, sys
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib

def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
    return (p.stdout.strip() or p.stderr.strip())[:400]

out = {}
out["x11_active"] = run("id=$(xprop -root _NET_ACTIVE_WINDOW | awk '{print $NF}'); xprop -id $id WM_CLASS _NET_WM_NAME 2>&1")
out["shell_eval"] = run("gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'global.display.focus_window.get_title()'")
out["shell_introspect"] = run("gdbus call --session --dest org.gnome.Shell.Introspect --object-path /org/gnome/Shell/Introspect --method org.gnome.Shell.Introspect.GetWindows")
out["extension"] = run("gdbus call --session --dest org.gnome.Shell --object-path /com/clave/Focus --method com.clave.Focus.Get")

# AT-SPI: the active frame, as the accessibility bus reports it. Position is only meaningful on X11.
active = []
desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app is None: continue
    for j in range(app.get_child_count()):
        w = app.get_child_at_index(j)
        if w is None: continue
        try:
            if w.get_state_set().contains(Atspi.StateType.ACTIVE):
                e = w.get_extents(Atspi.CoordType.SCREEN)
                active.append({"app": app.get_name(), "title": w.get_name(), "extents": [e.x, e.y, e.width, e.height]})
        except GLib.Error as err:
            active.append({"app": app.get_name(), "error": str(err)})
out["atspi_active"] = active
print(json.dumps(out, indent=1, ensure_ascii=False))
