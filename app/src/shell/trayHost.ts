/**
 * Whether the desktop can show a tray icon, and what closing the window does about it.
 *
 * On Linux a tray icon is a StatusNotifierItem, shown only while something owns
 * `org.kde.StatusNotifierWatcher` on the session bus: Ubuntu's AppIndicator extension does, plain
 * GNOME (Fedora) does not. The app lives in the tray, so with no tray a hidden window could never be
 * brought back (design 6.5): closing it minimises it instead, and it stays in the dash.
 */

/** gdbus's answer to `NameHasOwner`: `(true,)` or `(false,)`. Anything else is no tray. */
export function trayHostFrom(gdbusOutput: string): boolean {
  return gdbusOutput.trim() === "(true,)";
}

/** What closing the window does while the app keeps running. */
export function closeAction(hasTray: boolean): "hide" | "minimize" {
  return hasTray ? "hide" : "minimize";
}

/** The gdbus command that asks whether a tray host is on the session bus. */
export const TRAY_HOST_QUERY: [string, string[]] = [
  "gdbus",
  ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
    "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher"]
];
