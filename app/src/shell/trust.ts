/**
 * Which frame the IPC handlers will answer. Kept as a pure function of two strings so that the one
 * comparison the whole IPC surface hangs on is tested without Electron.
 */

/**
 * True when `url` is the app's own page, whatever the fragment or the query says. In-page routing
 * (`index.html#/settings`) and a query (`index.html?x=1`) are the same document and stay trusted;
 * ANY other path is not, including one that merely starts with the page's own name
 * (`index.html.evil`), a page fetched over http, and the empty string a frame that has gone reports.
 *
 * The fragment and the query are cut, not stripped with a URL parser: a parser would also normalise
 * (`..` segments, percent-encoding, a default port), and two strings that normalise to one document
 * is exactly the kind of "same enough" this comparison must not accept. Both sides come from
 * `pathToFileURL`, so the trusted string is already the exact one the window was loaded with.
 */
export const samePage = (url: string, page: string): boolean => url.split(/[#?]/, 1)[0] === page;
