/**
 * Specific phrases only. The bare words "private" and "incognito" are deliberately absent:
 * they flag ordinary pages ("Private API docs", "Incognito Marketing Agency").
 * Biased toward skipping: a false positive skips one read; a false negative reads private browsing.
 */
const TITLE_PHRASES = [
  "(incognito)", "- incognito", "— incognito",
  "private browsing", "(private)", "— private", "- private window", "inprivate",
  "navegação privativa", "navegação privada", "navegação anônima", "janela anônima", "(anônima)",
  "navegación privada", "(incógnito)", "modo incógnito",
  "privates fenster", "privater modus", "(inkognito)",
  "navigation privée"
];

/** Words that appear as a standalone label in a private window's toolbar strip. */
const TOOLBAR_MARKERS = /(^|[^a-zà-ÿ])(incognito|inprivate|inkognito|incógnito|anônima|private browsing)([^a-zà-ÿ]|$)/i;

export function isPrivateTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return TITLE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Safari's private badge is the bare word "Private" (measured on Safari 27: recognised as `Private`,
 * `• Private` or `¡• Private`), and Safari puts no marker in the window title. The bare word is
 * accepted for Safari ONLY, and only in the toolbar strip: Safari's address field shows just the host,
 * whereas Chrome's shows the whole address, where "private" is an everyday path segment
 * (github.com/acme/private-api) that would skip ordinary work. The known cost in Safari: a tab whose
 * title contains the word, shown in the compact tab bar inside the strip, skips that read. That is
 * the standing trade: a false positive skips one read, a false negative reads private browsing.
 * Other languages' badges are not measured and are not guessed at here.
 */
const SAFARI_BADGE = /(^|[^a-zà-ÿ])private([^a-zà-ÿ]|$)/i;
const isSafari = (app: string | undefined): boolean => app !== undefined && app.trim().toLowerCase() === "safari";

export function hasPrivateToolbarMarker(toolbarText: string, app?: string): boolean {
  return TOOLBAR_MARKERS.test(toolbarText) || (isSafari(app) && SAFARI_BADGE.test(toolbarText));
}
