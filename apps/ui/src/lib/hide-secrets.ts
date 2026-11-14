const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Machine text for the screen, without secret-like values (R5):
 * - the query of a URL (a signed link carries its signature there) becomes "?…";
 * - the value after "Bearer", or after a secret-like name and ":" or "="
 *   (token, secret, password, key, signature, auth…), becomes "…";
 * - a long run of token characters keeps only its first 4 characters. A UUID
 *   is an id, not a secret, so it stays.
 */
export function hideSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?…")
    .replace(/\b(bearer)\s+[^\s,;"']+/gi, "$1 …")
    .replace(
      /\b((?:access[_-]?|refresh[_-]?|api[_-]?|client[_-]?|private[_-]?)?(?:token|secret|password|passwd|key|signature|auth\w*))(["']?\s*[:=]\s*["']?)(?!bearer\b)[^\s,;&"']+/gi,
      "$1$2…",
    )
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) =>
      UUID.test(run) ? run : `${run.slice(0, 4)}…`,
    )
}
