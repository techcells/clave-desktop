// The part of the Clave focus extension that decides things. It imports nothing from GNOME, so
// vitest runs it on any machine; extension.js gathers the facts from Mutter and asks these.

/**
 * The installed reader's path, from the `reader-path` file the app writes beside metadata.json:
 * exactly one absolute path, optionally followed by one newline. Anything else is `null`, and a
 * `null` path answers nobody.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseReaderPath(text) {
  if (typeof text !== "string") return null;
  const path = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (path.length < 2 || !path.startsWith("/") || path.includes("\n") || path.includes("\0")) return null;
  return path;
}

/**
 * Whether a caller may be told which window is focused: its executable, as `/proc/<pid>/exe`
 * resolves it, must be exactly the installed reader. On Wayland a window's title is otherwise known
 * only to the compositor, so this answer must not reach every process on the session bus. A reader
 * binary replaced while it runs resolves to "<path> (deleted)" and is refused too.
 *
 * @param {unknown} callerExe
 * @param {unknown} readerPath
 * @returns {boolean}
 */
export function mayAnswer(callerExe, readerPath) {
  return typeof callerExe === "string" && typeof readerPath === "string" && readerPath.length > 0
    && callerExe === readerPath;
}

/**
 * Whether the `reader-path` file can be trusted: a regular file owned by the user the shell runs as,
 * that nobody else may write (no group or other write bit). Anything unknown is untrusted.
 *
 * @param {null | {regular: unknown, ownerUid: unknown, mode: unknown}} file
 * @param {unknown} uid the uid GNOME Shell runs as
 * @returns {boolean}
 */
export function readerPathFileIsSafe(file, uid) {
  return file !== null && typeof file === "object" && file.regular === true
    && Number.isSafeInteger(uid) && file.ownerUid === uid
    && Number.isSafeInteger(file.mode) && (file.mode & 0o022) === 0;
}

/**
 * Whether GNOME Shell is drawing something of its own over the windows: the Activities overview,
 * or anything that holds a modal (a system dialog such as the Share-screen prompt, a top-bar menu,
 * the Alt+Tab switcher). Mutter's focus stays on the last window meanwhile, so without this the
 * reader would crop the window's rectangle out of the overview and read another window's thumbnail
 * under this window's name (L7, 2026-09-23). A notification banner is drawn over the windows too,
 * without a modal: a message from an excluded messenger would be read inside whatever window is
 * focused (Task 6 review, reproduced live). While any of these is true `Get()` answers no window. A
 * state that cannot be read counts as covered: unknown means do not capture.
 *
 * @param {unknown} state `{overviewVisible, modalCount, bannerShowing}` as read from the shell
 * @returns {boolean}
 */
export function shellCoversWindows(state) {
  if (state === null || typeof state !== "object") return true;
  const {overviewVisible, modalCount, bannerShowing} =
    /** @type {{overviewVisible: unknown, modalCount: unknown, bannerShowing: unknown}} */ (state);
  if (typeof overviewVisible !== "boolean" || typeof bannerShowing !== "boolean"
    || !Number.isSafeInteger(modalCount) || modalCount < 0) return true;
  return overviewVisible || bannerShowing || modalCount > 0;
}

/** A rectangle `{x, y, width, height}` of finite numbers with a positive size, or null. */
function area(rect) {
  if (rect === null || typeof rect !== "object") return null;
  const {x, y, width, height} = rect;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) && width > 0 && height > 0
    ? {x, y, width, height}
    : null;
}

/**
 * Whether another program's window, stacked above the focused one on the current workspace, overlaps
 * it: a picture-in-picture video or an always-on-top window. The reader crops the focused window's
 * rectangle out of the whole screen, so anything drawn over it would be read under its name. The
 * focused program's own windows above it (its menus, popups and dialogs) are its own content and
 * pass. A pid or a frame that cannot be read counts as another program's window over it.
 *
 * @param {unknown} focused `{frame, pid}` of the focused window
 * @param {unknown} above `[{frame, pid}]` of the windows showing above it
 * @returns {boolean}
 */
export function othersCover(focused, above) {
  if (focused === null || typeof focused !== "object" || !Array.isArray(above)) return true;
  const frame = area(/** @type {{frame: unknown}} */ (focused).frame);
  if (frame === null) return true;
  const pid = /** @type {{pid: unknown}} */ (focused).pid;
  const known = (value) => Number.isSafeInteger(value) && value > 0;
  return above.some((window) => {
    if (window === null || typeof window !== "object") return true;
    const other = area(window.frame);
    if (other === null) return true;
    const overlaps = other.x < frame.x + frame.width && frame.x < other.x + other.width
      && other.y < frame.y + frame.height && frame.y < other.y + other.height;
    return overlaps && (!known(pid) || !known(window.pid) || window.pid !== pid);
  });
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isCoordinate = (value) => Number.isSafeInteger(value);
const nameOrNull = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/** A rectangle with whole-number coordinates and a positive whole-number size, as [x, y, w, h]. */
function rectangle(rect) {
  if (rect === null || typeof rect !== "object") return null;
  const {x, y, width, height} = rect;
  if (!isCoordinate(x) || !isCoordinate(y) || !isCount(width) || width === 0 || !isCount(height) || height === 0) {
    return null;
  }
  return [x, y, width, height];
}

/**
 * The answer to `Get()`, as JSON: the focused window as the reader needs it, or `null`.
 *
 * `frame` and `monitorFrame` are both in the stage's logical layout, so the reader crops a monitor's
 * stream at `(frame - monitorFrame origin) * streamWidth / monitorFrame width`. That holds whether or
 * not Mutter scales the framebuffer (on Xorg, and on Wayland without `scale-monitor-framebuffer`, the
 * layout is already in device pixels, so "frame times scale" would be wrong). `scale` is carried as
 * a fact, not as the crop factor.
 *
 * The id, the two frames, the monitor and the scale are what the reader crops with, so a window
 * missing any of them answers `null`, never a guess: unknown focus or position means the frame is
 * dropped. The names are only descriptive, and a missing one is `null` (the title an empty string).
 *
 * `pid` is the process that owns the window, or `null` when Mutter does not know it. The reader
 * uses it only for a browser whose private-window marker is a word: Chrome's interface language from
 * the `--lang` its child processes carry, and Firefox's history mode from its profile; an unknown pid
 * there means the window is withheld.
 *
 * @param {null | undefined | {
 *   id: unknown, title: unknown, appName: unknown, appId: unknown, wmClass: unknown, x11: unknown,
 *   frame: unknown, monitor: unknown, monitorFrame: unknown, scale: unknown, pid: unknown
 * }} window
 * @returns {string}
 */
export function shapeAnswer(window) {
  if (window === null || window === undefined) return JSON.stringify(null);
  const {id, monitor, scale} = window;
  const frame = rectangle(window.frame);
  const monitorFrame = rectangle(window.monitorFrame);
  const located = isCount(id) && id > 0 && frame !== null && monitorFrame !== null && isCount(monitor)
    && typeof scale === "number" && Number.isFinite(scale) && scale > 0;
  if (!located) return JSON.stringify(null);
  return JSON.stringify({
    id,
    title: typeof window.title === "string" ? window.title : "",
    appName: nameOrNull(window.appName),
    appId: nameOrNull(window.appId),
    wmClass: nameOrNull(window.wmClass),
    x11: window.x11 === true,
    frame,
    monitor,
    monitorFrame,
    scale,
    pid: isCount(window.pid) && window.pid > 0 && window.pid <= 0xffffffff ? window.pid : null
  });
}
