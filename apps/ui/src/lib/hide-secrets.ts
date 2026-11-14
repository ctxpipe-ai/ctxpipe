/**
 * Machine text for the screen, without secret-like values: the query of a
 * URL (a signed link carries its signature there) becomes "?…", and a long
 * run of token characters keeps only its first 4 characters.
 */
export function hideSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?…")
    .replace(/[A-Za-z0-9_-]{32,}/g, (token) => `${token.slice(0, 4)}…`)
}
