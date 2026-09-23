// Clave focus: tells the Clave reader which window is focused and where it is on screen, which on
// Wayland only the compositor knows. It answers the installed reader and nobody else, and it sends
// focus changes only to that reader. The decisions live in logic.js; this file only gathers facts
// from Mutter and speaks D-Bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {mayAnswer, parseReaderPath, readerPathFileIsSafe, shapeAnswer, shellCoversWindows} from './logic.js';

const OBJECT_PATH = '/com/clave/Focus';
const INTERFACE = 'com.clave.Focus';
const NOT_ALLOWED = 'com.clave.Focus.Error.NotAllowed';
const FAILED = 'com.clave.Focus.Error.Failed';
const IFACE_XML = `<node><interface name="${INTERFACE}">
  <method name="Get"><arg type="s" direction="out" name="json"/></method>
  <signal name="FocusChanged"><arg type="t" name="window"/></signal>
</interface></node>`;

/** What logic.js needs to know about a Mutter window, or null. */
function snapshotOf(window) {
    if (!window)
        return null;
    // A window with no matching .desktop entry gets a made-up "window-backed" app whose id changes
    // on every run; such names could never match an exclusion, so they are left out.
    const tracked = Shell.WindowTracker.get_default().get_window_app(window);
    const app = tracked && !tracked.is_window_backed() ? tracked : null;
    const rect = window.get_frame_rect();
    const monitor = window.get_monitor();
    const monitorRect = monitor >= 0 ? global.display.get_monitor_geometry(monitor) : null;
    return {
        id: window.get_id(),
        title: window.get_title(),
        appName: app?.get_name() ?? null,
        appId: app?.get_id() ?? null,
        wmClass: window.get_wm_class(),
        x11: window.get_client_type() === Meta.WindowClientType.X11,
        frame: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        monitor,
        monitorFrame: monitorRect
            ? {x: monitorRect.x, y: monitorRect.y, width: monitorRect.width, height: monitorRect.height}
            : null,
        scale: monitor >= 0 ? global.display.get_monitor_scale(monitor) : null,
        // From the client's socket credentials on Wayland, from _NET_WM_PID or XRes on X11; -1 when
        // unknown, which logic.js turns into null.
        pid: window.get_pid(),
    };
}

export default class ClaveFocusExtension extends Extension {
    enable() {
        // The unique bus name of the reader that last asked, once it was allowed. Focus changes are
        // sent to it alone, never broadcast.
        this._reader = null;
        this._titleWindow = null;
        this._titleHandler = 0;
        // Read once: changing which program may ask then takes a new login, the same bar as
        // changing this file.
        this._allowedReader = this._readReaderPath();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._focusHandler = global.display.connect('notify::focus-window', () => this._onFocusChanged());
        this._watchTitle();
    }

    disable() {
        global.display.disconnect(this._focusHandler);
        this._unwatchTitle();
        this._dbus.unexport();
        this._dbus = null;
        this._reader = null;
        this._allowedReader = null;
    }

    // GJS calls a method named `<Method>Async` with the invocation, which is what gives us the
    // caller's bus name.
    GetAsync(_parameters, invocation) {
        const sender = invocation.get_sender();
        this._callerExe(sender, exe => {
            if (!mayAnswer(exe, this._allowedReader)) {
                invocation.return_dbus_error(NOT_ALLOWED, 'This caller is not the Clave reader');
                return;
            }
            let answer;
            try {
                const covered = shellCoversWindows({overviewVisible: Main.overview.visible, modalCount: Main.modalCount});
                answer = shapeAnswer(covered ? null : snapshotOf(global.display.focus_window));
            } catch {
                // Never leave the reader waiting out the D-Bus timeout; it treats this as unknown focus.
                invocation.return_dbus_error(FAILED, 'The focused window could not be described');
                return;
            }
            this._reader = sender;
            invocation.return_value(new GLib.Variant('(s)', [answer]));
        });
    }

    /**
     * The reader path the app wrote beside metadata.json, or null. The file is trusted only when it
     * is a regular file owned by this user that nobody else may write.
     */
    _readReaderPath() {
        try {
            const file = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'reader-path']));
            const info = file.query_info('standard::type,unix::uid,unix::mode',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            const facts = {
                regular: info.get_file_type() === Gio.FileType.REGULAR,
                ownerUid: info.get_attribute_uint32('unix::uid'),
                mode: info.get_attribute_uint32('unix::mode'),
            };
            if (!readerPathFileIsSafe(facts, new Gio.Credentials().get_unix_user()))
                return null;
            const [, bytes] = file.load_contents(null);
            return parseReaderPath(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    /** Resolves a bus name to its process's executable, or null when anything along the way fails. */
    _callerExe(sender, done) {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                let exe = null;
                try {
                    const [pid] = connection.call_finish(result).deepUnpack();
                    exe = GLib.file_read_link(`/proc/${pid}/exe`);
                } catch {
                    exe = null;
                }
                done(exe);
            });
    }

    _onFocusChanged() {
        this._unwatchTitle();
        this._watchTitle();
        this._announce();
    }

    _watchTitle() {
        const window = global.display.focus_window;
        if (!window)
            return;
        this._titleWindow = window;
        this._titleHandler = window.connect('notify::title', () => this._announce());
    }

    _unwatchTitle() {
        if (this._titleWindow && this._titleHandler)
            this._titleWindow.disconnect(this._titleHandler);
        this._titleWindow = null;
        this._titleHandler = 0;
    }

    /** Tells the reader, and only the reader, that focus or the focused title changed. */
    _announce() {
        if (!this._reader)
            return;
        const window = global.display.focus_window;
        try {
            Gio.DBus.session.emit_signal(this._reader, OBJECT_PATH, INTERFACE, 'FocusChanged',
                new GLib.Variant('(t)', [window ? window.get_id() : 0]));
        } catch {
            // Sending to a name that has left the bus does not throw; this only guards a closed
            // connection. Unique names are never reused, so a stale one reaches nobody.
            this._reader = null;
        }
    }
}
