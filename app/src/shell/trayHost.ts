/**
 * Whether the desktop can show a tray icon, and what closing the window does about it.
 *
 * On Linux a tray icon is a StatusNotifierItem, shown only while something owns
 * `org.kde.StatusNotifierWatcher` on the session bus: Ubuntu's AppIndicator extension does, plain
 * GNOME (Fedora) does not. The app lives in the tray, so with no tray a hidden window could never be
 * brought back (design 6.5), and the tray menu's Quit is not there either: closing the window then
 * quits the app. The question is asked at each close, not once at start, because the user can turn
 * the AppIndicator extension on or off while the app runs.
 */

/** gdbus's answer to `NameHasOwner`: `(true,)` or `(false,)`. Anything else is no tray. */
export function trayHostFrom(gdbusOutput: string): boolean {
  return gdbusOutput.trim() === "(true,)";
}

/** What closing the window does. */
export function closeAction(hasTray: boolean): "hide" | "quit" {
  return hasTray ? "hide" : "quit";
}

/** The gdbus command that asks whether a tray host is on the session bus. */
export const TRAY_HOST_QUERY: [string, string[]] = [
  "gdbus",
  ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
    "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher"]
];

/** How long a close waits for gdbus. The bus answers in milliseconds; a hung one is no tray. */
export const TRAY_HOST_TIMEOUT_MS = 1000;

type Run = (file: string, args: readonly string[], options: {timeout: number}, callback: (error: Error | null, stdout: string) => void) => void;

/** Ask the session bus whether a tray host is there. Every failure, and no answer in time, is no tray. */
export function askTrayHost(run: Run): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), TRAY_HOST_TIMEOUT_MS);
    const answer = (value: boolean) => { clearTimeout(timer); resolve(value); };
    try {
      run(TRAY_HOST_QUERY[0], TRAY_HOST_QUERY[1], {timeout: TRAY_HOST_TIMEOUT_MS}, (error, stdout) => answer(!error && trayHostFrom(stdout)));
    } catch {
      answer(false);
    }
  });
}
