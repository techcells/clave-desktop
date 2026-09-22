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
 * 1268 x 708 is what phase 0 happened to get (findings, "Window pixel size of the reads": 16 of the
 * 17 P4 reads were 1268 x 708 px on a 1x display, so points and pixels were the same number). Asking
 * for it explicitly is the whole change: it is now recorded rather than observed afterwards. The
 * position is away from the top-left corner so the window cannot land under the menu bar.
 */
export const BROWSER_WINDOW = {widthPt: 1268, heightPt: 708, xPt: 40, yPt: 60} as const;
export type WindowBox = typeof BROWSER_WINDOW;

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

/** 140 x 40 is comfortably wider than the longest line of `terminal.txt`; 72 x 40 wraps several. */
export const TERMINAL_WIDE = {columns: 140, rows: 40} as const;
export const TERMINAL_NARROW = {columns: 72, rows: 40} as const;

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

export const OBSERVE_CASES: readonly ObserveCase[] = (["normal", "private"] as const).flatMap((mode) =>
  TOOLBAR_VARIANTS.map((variant): ObserveCase => ({
    name: `safari-${mode}-${variant.page}-${variant.theme}-${variant.sizePx}`,
    app: SAFARI,
    page: variant.page,
    theme: variant.theme,
    sizePx: variant.sizePx,
    expectPrivate: mode === "private"
  }))
);
