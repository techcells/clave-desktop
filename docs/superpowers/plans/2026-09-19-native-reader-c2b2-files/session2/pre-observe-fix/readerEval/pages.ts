/**
 * The staged HTML pages (`$SPIKE/tools/make_pages.py`), ported.
 *
 * The styling is the spike's, character for character apart from one deliberate change and one
 * addition, because the phase-0 accuracy numbers are numbers about THESE pixels: change the font
 * stack or the line padding and a rerun is no longer comparable with the findings it is checked
 * against.
 *
 * The change: `.marker` opacity. The spike shipped `opacity:.6` and run 1 came back with
 * `"markers": false` for `code-light-14` and `code-light-11` — the recogniser had dropped the
 * STARTMARKER/ENDMARKER lines, which at .6 over near-black text on white blend to roughly 2:1
 * contrast (findings, "P4 / Staging changes made"). Raising it to 1 fixed both. It is 1 here for
 * every page, not just `code`, and `pages.test.ts` pins it: a marker the recogniser cannot see turns
 * a scoring failure into a silent "the page had no body", which is the one failure this harness must
 * never make on its own account.
 *
 * The addition: the page's title. A staged window is only readable by the harness because its title
 * says so (`stagedTitle.ts`), so the title is the page's most load-bearing content.
 */
import {STAGED_TITLE_PREFIX, isStagedTitle} from "./stagedTitle";

/** Exactly the spike's stylesheet, with `.marker` at full opacity (see the file comment). */
export const PAGE_STYLE = `
body{margin:24px;font:14px -apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#1d1c1d}
body.dark{background:#1a1d21;color:#d1d2d3}
.marker{font:12px Menlo,monospace;opacity:1;margin:8px 0}
.chat .l{padding:3px 0}.chat .l.name{font-weight:700;margin-top:10px}
.ticket .l{padding:4px 0;border-bottom:1px solid #8883}
.code .l,.terminal .l{font-family:Menlo,Monaco,monospace;white-space:pre}
`;

/**
 * Theme and font size come from the query string, as in the spike. The third clause is this
 * harness's: a title is taken from `stagedTitle` ONLY when it is one of ours, so the page cannot be
 * asked to call itself something belonging to somebody else. It is `textContent`, never HTML.
 *
 * The rule is the SAME rule `isStagedTitle` applies — the prefix and something after it — and the
 * prefix is interpolated from `STAGED_TITLE_PREFIX` rather than typed out a second time. Both halves
 * of that matter: the script used to check only the prefix, so `?stagedTitle=CLAVE-EVAL%20` was
 * refused by `acceptStagedTitle` on the way out and then set by the page on arrival, giving a staged
 * window a title neither rule would accept.
 */
export const PAGE_SCRIPT = `
const q=new URLSearchParams(location.search);
if(q.get('theme')==='dark')document.body.classList.add('dark');
if(q.get('size'))document.body.style.fontSize=q.get('size')+'px';
const p=${JSON.stringify(STAGED_TITLE_PREFIX)};
const t=q.get('stagedTitle');
if(t&&t.startsWith(p)&&t.length>p.length)document.title=t;
`;

/** The four page kinds the spike built; `pt` is laid out as a chat, as it was there. */
export const PAGE_NAMES = ["chat", "ticket", "code", "pt"] as const;
export type PageName = (typeof PAGE_NAMES)[number];

const kindOf = (name: PageName): string => (name === "pt" ? "chat" : name);

/** A chat line that ends in a clock time is a speaker's name row, and is set in bold. */
const NAME_ROW = /\d\d:\d\d$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * The title the served page carries. Anything that is not one of this harness's staged titles is
 * refused and the page falls back to a fixed, meaningless name — the same rule the in-page script
 * applies, kept in one place so the two can never disagree.
 */
/** What a page calls itself when it was asked for a title that is not one of this harness's. */
export const FALLBACK_TITLE = "Clave reader evaluation";

export function acceptStagedTitle(raw: string | null | undefined): string {
  return raw !== null && raw !== undefined && isStagedTitle(raw) ? raw : FALLBACK_TITLE;
}

export interface PageRequest {
  name: PageName;
  /** The truth file's lines, in order, exactly as they are on disk. */
  lines: readonly string[];
  /** Already checked by `acceptStagedTitle`. */
  title: string;
}

/** One staged page: the truth between the two markers, and nothing else. */
export function renderPage({name, lines, title}: PageRequest): string {
  const kind = kindOf(name);
  const rows = lines
    .map((line) => {
      const cls = kind === "chat" && NAME_ROW.test(line) ? "l name" : "l";
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    })
    .join("");
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style>` +
    `<body class="${kind}"><div class="marker">STARTMARKER</div>${rows}` +
    `<div class="marker">ENDMARKER</div><script>${PAGE_SCRIPT}</script>`
  );
}
