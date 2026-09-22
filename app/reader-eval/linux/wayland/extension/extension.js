// Exposes the focused window's title, app id and on-screen frame on the session bus, so an
// unprivileged process can learn what the compositor otherwise keeps to itself on Wayland.
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node><interface name="com.clave.Focus"><method name="Get"><arg type="s" direction="out" name="json"/></method></interface></node>`;

export default class FocusProbe extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/com/clave/Focus');
    }
    disable() {
        this._dbus?.unexport();
        this._dbus = null;
    }
    Get() {
        const w = global.display.focus_window;
        if (!w) return JSON.stringify(null);
        const r = w.get_frame_rect();
        return JSON.stringify({title: w.get_title(), wmClass: w.get_wm_class(), appId: w.get_gtk_application_id(),
            sandboxed: w.get_sandboxed_app_id(), x11: w.get_client_type() === 1, frame: [r.x, r.y, r.width, r.height],
            monitor: w.get_monitor(), scale: global.display.get_monitor_scale(w.get_monitor())});
    }
}
