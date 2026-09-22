/**
 * What the staged-window run reads, as a table.
 *
 * The shape is phase 0's (four pages x light/dark x 14/11 px, plus a terminal; four hosts x five
 * page variants x normal/incognito) so this run's numbers can be put beside the findings' numbers.
 * Two things are new, and both come from the spec:
 *
 * - Every window is staged at a FIXED size and position. Phase 0 did not, and it cost the phase its
 *   only unexplained result: the terminal case scored 0.8686 in one run and 0.9882 in the next, and
 *   a later repeat of ten reads of one unchanged Terminal window scored 0.9882 every single time
 *   with one identical text. Recognition of unchanged pixels is deterministic on this machine, so
 *   the 0.8686 came from a different WINDOW STATE — size, wrapping, scroll, or which Terminal window
 *   was frontmost — and none of those was recorded (findings, "P4 addendum 2"; spec 10.1 item 15).
 * - There are two terminal cases. `terminal-narrow` exists because spec 10.1 item 15 asks for "a
 *   narrow terminal" by name: a 72-column window wraps the long test-runner lines of `terminal.txt`,
 *   which is the state nobody measured and the most plausible explanation of the 0.8686.
 *
 * Nothing here decides thresholds (`thresholds.ts`) or how a window is opened (`stage.ts`).
 */
import type {PageName} from "./pages";
import {stagedTitleFor} from "./stagedTitle";
import type {AccuracyGroup} from "./thresholds";

export type Theme = "light" | "dark";
export type TruthName = "chat" | "ticket" | "code" | "pt" | "terminal";

/** The app name the window server reports, which is also the app the guard demands. */
export const CHROME = "Google Chrome";
export const TERMINAL = "Terminal";
export const SAFARI = "Safari";

/**
 * The staged browser window, in points, at a fixed place on the screen.
 *
 * **1160 x 640 since 2026-09-20, and the reason is the first run against a screen.** The size was
 * 1268 x 708 until then, which is what phase 0 happened to get (findings, "Window pixel size of the
 * reads": 16 of the 17 P4 reads were 1268 x 708 px on a 1x display, so points and pixels were the
 * same number) — but phase 0 ran on an external 2560 x 1440 display, and nothing about that number
 * was ever a requirement. On the built-in panel it is a size that may not fit: a 1280 x 800 pt work
 * area leaves 1280 - 40 = 1240 pt of width and 800 - 60 = 740 pt of height below the default corner,
 * before the menu bar and the Dock take their share, and a window that does not fit is a window the
 * window manager resizes — which is the one thing this table exists to prevent (spec 10.1 item 15:
 * the window size is recorded because the terminal case moved 0.8686 -> 0.9882 between two runs and
 * nobody knew what had changed).
 *
 * 1160 x 640 fits INSIDE a 1280 x 800 pt work area at the default corner with 80 pt to spare at the
 * right and 100 pt at the bottom — enough for a menu bar (25 pt) or a Dock, whichever way the work
 * area is measured — and it is still wide enough to lay out every staged page without wrapping the
 * long `code` lines differently from phase 0. A machine whose work area cannot take even this is
 * refused outright (`DISPLAY_TOO_SMALL`, see `fitsWorkArea`) rather than staged at some other size:
 * a run whose windows were silently resized measures something nobody chose.
 *
 * The position is away from the top-left corner so the window cannot land under the menu bar.
 */
export const BROWSER_WINDOW = {widthPt: 1160, heightPt: 640, xPt: 40, yPt: 60} as const;
/**
 * Written out rather than left as `typeof BROWSER_WINDOW`, which made every field the LITERAL
 * number it happens to hold: with that type no second box can exist, and `positioned` below has to
 * build one. `BROWSER_WINDOW` still satisfies this, and `cases.test.ts` still pins its four numbers.
 */
export interface WindowBox {
  widthPt: number;
  heightPt: number;
  xPt: number;
  yPt: number;
}

/** A staged window's top-left corner, in points. The only part of the box `--position` may move. */
export interface WindowPosition {
  xPt: number;
  yPt: number;
}

/**
 * Where a staged Chrome window goes when nobody says otherwise: exactly where `BROWSER_WINDOW` has
 * always put it, so a run made without `--position` stays comparable with every run made before the
 * option existed. The option exists for one reason — spec 10.1 item 8, the Retina check: the only
 * way to measure recognition on a 2x display is to stage the window ON that display, and a position
 * is the only thing Chrome will take from a command line that decides which display that is.
 *
 * Derived from the box rather than written out again, so there is one pair of numbers to change.
 */
export const DEFAULT_POSITION: WindowPosition = {xPt: BROWSER_WINDOW.xPt, yPt: BROWSER_WINDOW.yPt};

/** The same box at another corner: the case's own SIZE is kept, only the corner moves. */
export function positioned(window: WindowBox, position: WindowPosition): WindowBox {
  return {widthPt: window.widthPt, heightPt: window.heightPt, xPt: position.xPt, yPt: position.yPt};
}

/**
 * The display's usable area, in points: what `screen.getPrimaryDisplay().workArea` reports — the
 * screen less the menu bar and the Dock. Two numbers about a display, nothing about a machine.
 */
export interface WorkArea {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

/** Does the whole staged box lie inside the work area? Corners included: a clipped window is not staged. */
export function fitsWorkArea(box: WindowBox, workArea: WorkArea): boolean {
  return (
    box.xPt >= workArea.xPt &&
    box.yPt >= workArea.yPt &&
    box.xPt + box.widthPt <= workArea.xPt + workArea.widthPt &&
    box.yPt + box.heightPt <= workArea.yPt + workArea.heightPt
  );
}

/** The fixed code a run is refused with when the staged window cannot fit the display AT ALL. */
export const DISPLAY_TOO_SMALL = "DISPLAY_TOO_SMALL";

/**
 * The fixed code for a window that WOULD fit, but not at the corner it was asked for.
 *
 * A code of its own because the two are different instructions to the owner: `DISPLAY_TOO_SMALL`
 * means "not on this display, at any position", and this means "move it". Review B found the two
 * conflated, and the conflation mattered: `--position` exists to stage on ANOTHER display (spec 10.1
 * item 8, the Retina check), and a second display's coordinates lie outside the primary's work area
 * by definition — so the Retina run was being told its display was too small. The work area is now
 * the one belonging to the display NEAREST the staging position, and this code is what is left: a
 * corner that really does hang the window off that display.
 */
export const POSITION_OFF_DISPLAY = "POSITION_OFF_DISPLAY";

/**
 * Refuse the run, or `null`.
 *
 * A window the display cannot hold is not staged at the size the table asks for: macOS resizes it,
 * and every number the run then produces belongs to a window nobody chose — at a size that is not in
 * the results as staged, in a run whose whole point (spec 10.1 item 15) is that the window size is
 * recorded. The first run against a screen is exactly this failure with the sign reversed: sixteen
 * captures at one size, none of them the staged one, and no field anywhere saying so.
 *
 * So it is a refusal with a fixed code before anything opens, not a silent restaging at some size
 * that does fit: choosing another size on the owner's behalf would put numbers in the record under a
 * staging that was never asked for, and the owner cannot see a window that was never opened.
 *
 * Only the browser cases are checked. A Terminal window is opened by LaunchServices wherever the
 * owner's Terminal opens it and this harness neither sizes nor places it (see `RunDeps.position`).
 */
export function displayRefusal(
  workArea: WorkArea,
  position: WindowPosition,
  cases: readonly {window: WindowBox}[]
): string | null {
  // Asked in this order because the two codes are different instructions: a window larger than the
  // work area cannot be staged at any corner, so no amount of moving helps and the position is not
  // the thing to report.
  const tooBig = cases.some(
    (entry) => entry.window.widthPt > workArea.widthPt || entry.window.heightPt > workArea.heightPt
  );
  if (tooBig) return DISPLAY_TOO_SMALL;
  const off = cases.some((entry) => !fitsWorkArea(positioned(entry.window, position), workArea));
  return off ? POSITION_OFF_DISPLAY : null;
}

export const THEMES: readonly Theme[] = ["light", "dark"];
export const FONT_SIZES_PX: readonly number[] = [14, 11];

export interface BrowserAccuracyCase {
  kind: "browser";
  name: string;
  group: AccuracyGroup;
  app: typeof CHROME;
  page: PageName;
  theme: Theme;
  sizePx: number;
  truth: TruthName;
  window: WindowBox;
}

export interface TerminalAccuracyCase {
  kind: "terminal";
  name: string;
  group: "terminal";
  app: typeof TERMINAL;
  columns: number;
  rows: number;
  truth: "terminal";
}

export type AccuracyCase = BrowserAccuracyCase | TerminalAccuracyCase;

/**
 * The two staged terminals: wide and narrow, both **30 rows** since 2026-09-21.
 *
 * The COLUMN count is what these two cases are about — spec 10.1 item 15 asks for "a narrow
 * terminal" by name, and 140 against 72 is that difference. The rows were 40 for no reason beyond
 * "comfortably more than the text needs", and shake-down #5 showed what that cost: `terminal-narrow`
 * came back with the shell reporting **72 x 37** for a staged 72 x 40, because Terminal opened that
 * window on the owner's built-in 2560 x 1600 Retina panel, whose work area cannot hold 40 rows of
 * his Terminal font. The same run's `terminal` case, which landed on the external display, reported
 * exactly 140 x 40. Nothing was wrong with the window or the reading — the harness had simply asked
 * for more rows than a display it cannot choose was able to give.
 *
 * 30 rows fits the text with room over on both displays: `terminal.txt` is 12 lines, plus the two
 * marker lines is 14, and the shell prints nothing else into a screen it has just cleared. It is
 * chosen to be a size BOTH of the owner's displays can hold, because this harness neither sizes nor
 * places a Terminal window (see `RunDeps.position`) and so cannot decide which one it opens on.
 *
 * If a future truth file grows past about 28 lines this number has to grow with it, and a run that
 * cannot have the rows it asked for now says so in `readyColumns`/`readyRows` rather than having to
 * be guessed at again.
 */
export const TERMINAL_WIDE = {columns: 140, rows: 30} as const;
export const TERMINAL_NARROW = {columns: 72, rows: 30} as const;

export const ACCURACY_CASES: readonly AccuracyCase[] = [
  ...(["chat", "ticket", "code", "pt"] as const).flatMap((page) =>
    THEMES.flatMap((theme) =>
      FONT_SIZES_PX.map((sizePx): BrowserAccuracyCase => ({
        kind: "browser",
        name: `${page}-${theme}-${sizePx}`,
        group: page,
        app: CHROME,
        page,
        theme,
        sizePx,
        truth: page,
        window: BROWSER_WINDOW
      }))
    )
  ),
  {kind: "terminal", name: "terminal", group: "terminal", app: TERMINAL, ...TERMINAL_WIDE, truth: "terminal"},
  {kind: "terminal", name: "terminal-narrow", group: "terminal", app: TERMINAL, ...TERMINAL_NARROW, truth: "terminal"}
];

/**
 * The four hosts of `run_p5.sh`. Chrome resolves any `*.localhost` name to the loopback address with
 * no change to the machine, so these are four different-looking hosts served by one local server.
 * Two of them read as places a person would mind being read (`mybank`, `mail.corp`), which is the
 * point: the address strip is what the product's site exclusions act on.
 */
export const TOOLBAR_HOSTS: readonly string[] = [
  "app.clave.localhost",
  "staging.jira.localhost",
  "mybank.example.localhost",
  "mail.corp.localhost"
];

/** The five page variants of `run_p5.sh`, in its order. */
export const TOOLBAR_VARIANTS: readonly {page: PageName; theme: Theme; sizePx: number}[] = [
  {page: "chat", theme: "light", sizePx: 14},
  {page: "ticket", theme: "dark", sizePx: 14},
  {page: "code", theme: "light", sizePx: 11},
  {page: "pt", theme: "dark", sizePx: 11},
  {page: "chat", theme: "dark", sizePx: 11}
];

export type ToolbarMode = "normal" | "incognito";

export interface ToolbarCase {
  name: string;
  app: typeof CHROME;
  host: string;
  page: PageName;
  theme: Theme;
  sizePx: number;
  mode: ToolbarMode;
  /** What the private-window rule must say about this capture. The case name carries it too. */
  expectPrivate: boolean;
  window: WindowBox;
}

export const TOOLBAR_CASES: readonly ToolbarCase[] = (["normal", "incognito"] as const).flatMap((mode) =>
  TOOLBAR_HOSTS.flatMap((host) =>
    TOOLBAR_VARIANTS.map((variant): ToolbarCase => ({
      name: `${mode}-${host}-${variant.page}-${variant.theme}-${variant.sizePx}`,
      app: CHROME,
      host,
      page: variant.page,
      theme: variant.theme,
      sizePx: variant.sizePx,
      mode,
      expectPrivate: mode === "incognito",
      window: BROWSER_WINDOW
    }))
  )
);

/**
 * The toolbar cases in the order a LIMITED run takes them: normal, incognito, normal, incognito.
 *
 * The table itself is twenty normal windows and then twenty incognito ones, which is the right order
 * for a full run and the wrong one for a short one: `--limit 4` off the top would stage four normal
 * windows and measure nothing at all about the private badge, which is the half that matters most
 * (spec 10.1 items 8-9). Zipped by index, so n = 4 is two of each, n = 1 is a normal window, and any
 * even n is balanced.
 *
 * The full run is unaffected: this is the same forty cases, and `runToolbar` uses this order for
 * every run so that a limited run is a PREFIX of the run the owner would otherwise have made.
 */
export function interleavedToolbarCases(cases: readonly ToolbarCase[] = TOOLBAR_CASES): ToolbarCase[] {
  const normal = cases.filter((entry) => entry.mode === "normal");
  const incognito = cases.filter((entry) => entry.mode === "incognito");
  const zipped: ToolbarCase[] = [];
  for (let index = 0; index < Math.max(normal.length, incognito.length); index += 1) {
    const first = normal[index];
    const second = incognito[index];
    if (first !== undefined) zipped.push(first);
    if (second !== undefined) zipped.push(second);
  }
  return zipped;
}

/**
 * The first `limit` cases, or all of them.
 *
 * A limited run exists for one purpose: the toolbar path failed forty times out of forty on a real
 * screen, and a full failing run costs the owner twenty-four minutes to learn what four cases would
 * have said. It can never be an acceptance run (`summary.ts`), so cutting the table here costs
 * nothing but the cases it does not stage.
 */
export function limitedTo<T>(cases: readonly T[], limit: number | null): readonly T[] {
  return limit === null ? cases : cases.slice(0, limit);
}

/**
 * `observe` mode's cases: the stagings no command line can make.
 *
 * Safari cannot be driven into a private window without an Automation grant, which this harness will
 * not ask for, so the owner opens the window and the harness watches for it. The expectation is
 * inside the case NAME, which is inside the staged title, which is inside the window title the
 * harness matched before it read anything — so a recorded observation cannot be filed under the
 * wrong expectation afterwards.
 */
export interface ObserveCase {
  name: string;
  app: string;
  page: PageName;
  theme: Theme;
  sizePx: number;
  expectPrivate: boolean;
}

/**
 * The two browsers a hand-staged window may be in, and the word each case name starts with.
 *
 * Chrome is here as well as Safari because `observe` is the only way to reach the five Chrome
 * toolbar layouts of carried item 30 — a bookmarks bar, an extensions row, a side panel, a tab
 * group, a theme. Four of those five cannot be staged from a command line at all (they need an
 * installed extension or theme, or a click), so the automated `toolbar` mode will never see them;
 * the owner sets the window up by hand and this watches for it. It is the same guard, the same
 * `lines: true` and the same rule in both browsers: only the app name differs, and that is compared
 * exactly, so a Safari window can never answer for a Chrome case or the other way round.
 */
export const OBSERVE_BROWSERS: readonly {app: string; slug: string}[] = [
  {app: SAFARI, slug: "safari"},
  {app: CHROME, slug: "chrome"}
];

/**
 * `<browser>-<normal|private>-<page>-<theme>-<size>`.
 *
 * `private` is the word in both browsers' names although Chrome calls that window Incognito: the
 * word in the case name is the EXPECTATION this harness is judging (the private-window rule must
 * say `true`), not the browser's label for its menu item, and one word keeps the name, the staged
 * title and `expectPrivate` in step for both. The terminal side says "an incognito window" when it
 * tells the owner which Chrome window to open.
 */
export const OBSERVE_CASES: readonly ObserveCase[] = OBSERVE_BROWSERS.flatMap((browser) =>
  (["normal", "private"] as const).flatMap((mode) =>
    TOOLBAR_VARIANTS.map((variant): ObserveCase => ({
      name: `${browser.slug}-${mode}-${variant.page}-${variant.theme}-${variant.sizePx}`,
      app: browser.app,
      page: variant.page,
      theme: variant.theme,
      sizePx: variant.sizePx,
      expectPrivate: mode === "private"
    }))
  )
);

/**
 * The SHORT id a staged window's title carries, instead of the case's name.
 *
 * **Measured, 2026-09-21 (toolbar --limit 4, nonce 3ef68102fca6).** All four rows came back
 * `notStaged` with `frontAppSeen: true`, `stagedTitleSeen: true`, `pageRequests: 2`,
 * `pageStatus: 200`: the page was fetched twice, Chrome was in front, a title carrying this
 * harness's prefix was on it — and `approve` still refused, which can only mean the front window's
 * title did not CONTAIN the whole staged title. Accuracy titles are about 37 characters and match;
 * a toolbar title is `CLAVE-EVAL incognito-mybank.example.localhost-ticket-dark-14 <nonce>`, 73
 * characters, and does not. The native reader copies `kCGWindowName` whole with no cap anywhere on
 * the path (review D checked), so the shortening is Chrome's or the window server's, not ours.
 *
 * So the title stops carrying the name. It carries a fixed-width id — a letter for the table and
 * two digits for the position in it, `a07`, `t13`, `o02` — and the results keep the full case NAME,
 * which is what a reader of the file needs. The mapping is this table, in code, so the id is
 * recoverable without anybody parsing anything.
 *
 * **Why ids cannot prefix-collide.** They are FIXED WIDTH, so `t1` is not an id at all and `t13`
 * cannot be a prefix of another id; and the staged title puts a space and this run's nonce after
 * the id, so even a variable-width scheme could not have `CLAVE-EVAL t1 <nonce>` inside
 * `CLAVE-EVAL t13 <nonce>`. `cases.test.ts` holds both halves.
 */
export const CASE_ID_DIGITS = 2;

/** One letter per table: accuracy, toolbar, observe. */
export const CASE_ID_LETTERS = {accuracy: "a", toolbar: "t", observe: "o"} as const;

/** `a07`. Two digits, so a table may hold up to 99 cases; `cases.test.ts` pins that none does. */
export function caseId(letter: string, index: number): string {
  return `${letter}${String(index).padStart(CASE_ID_DIGITS, "0")}`;
}

const CASE_IDS: ReadonlyMap<string, string> = new Map([
  ...ACCURACY_CASES.map((entry, index) => [entry.name, caseId(CASE_ID_LETTERS.accuracy, index)] as const),
  ...TOOLBAR_CASES.map((entry, index) => [entry.name, caseId(CASE_ID_LETTERS.toolbar, index)] as const),
  ...OBSERVE_CASES.map((entry, index) => [entry.name, caseId(CASE_ID_LETTERS.observe, index)] as const)
]);

/** The id of a case this harness stages, or `null` for a name that is not in any table. */
export function stagedIdFor(caseName: string): string | null {
  return CASE_IDS.get(caseName) ?? null;
}

/** Every id this run could mint, which is what the page server pre-seeds its counters with. */
export function allStagedIds(): string[] {
  return [...CASE_IDS.values()];
}

/**
 * The longest a staged title may be, in characters.
 *
 * `CLAVE-EVAL ` (11) + an id (3) + a space + a twelve-character nonce is 27, and the terminal's
 * READY mark adds seven more. 40 leaves room for a longer nonce and none for a case name.
 */
export const STAGED_TITLE_MAX = 40;

/**
 * `CLAVE-EVAL <id> <nonce>` for a case of one of the three tables.
 *
 * A name that is in no table throws rather than falling back to itself: a staged title that is
 * silently long again is the failure this whole change exists to end, and every caller stages a
 * case out of a table.
 */
export function stagedTitleOf(caseName: string, nonce: string): string {
  const id = stagedIdFor(caseName);
  if (id === null) throw new Error("EVAL_UNKNOWN_CASE");
  const title = stagedTitleFor(id, nonce);
  // The cap is ENFORCED here, not merely stated: a title over it is the failure of 2026-09-21
  // coming back — a staged title the window server does not report whole — and it must not be
  // possible to reintroduce one by lengthening an id, a prefix or a nonce.
  if (title.length > STAGED_TITLE_MAX) throw new Error("EVAL_TITLE_TOO_LONG");
  return title;
}

