/**
 * The name the harness gives a window it staged, and the only name it will ever read.
 *
 * This is the privacy design in one string. The harness may capture a window only when the window
 * server reports that window's title contains a title built here, for THIS case and THIS run — so a
 * window the harness did not stage cannot be read even by accident, and a window staged by an
 * earlier run cannot be mistaken for this one. The nonce is what makes the second half true: an
 * abandoned Chrome window from a run ten minutes ago carries a different one.
 *
 * The prefix is also the rule a served page checks before it will put a title into `document.title`
 * at a visitor's request (`pages.ts`): a page that would set any title asked of it is a page that
 * could be told to impersonate somebody's real window.
 */
export const STAGED_TITLE_PREFIX = "CLAVE-EVAL ";

/** `CLAVE-EVAL <case name> <run nonce>`. */
export function stagedTitleFor(caseName: string, nonce: string): string {
  return `${STAGED_TITLE_PREFIX}${caseName} ${nonce}`;
}

/**
 * Is this a title this harness could have minted? Prefix only — the case name and the nonce are
 * checked by whoever knows which case is being staged, which is not the page.
 */
export function isStagedTitle(value: string): boolean {
  return value.startsWith(STAGED_TITLE_PREFIX) && value.length > STAGED_TITLE_PREFIX.length;
}
