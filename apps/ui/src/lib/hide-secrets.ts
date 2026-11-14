const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Machine text for the screen, without secret-like values (R5):
 * - the query of a URL (a signed link carries its signature there) becomes "?…";
 * - the value after "Bearer", or after a secret-like name and ":" or "="
 *   (token, secret, password, key, signature, authorization, auth_token), becomes "…"; after a
 *   secret-like name and a space, a value with a digit becomes "…";
 * - a long run of token characters keeps only its first 4 characters. A UUID
 *   is an id, not a secret, so it stays.
 */
export function hideSecrets(text: string): string {
  return (
    text
      // Stop before a final punctuation mark of the sentence; a fragment
      // stays a fragment ("#…").
      .replace(
        /(https?:\/\/[^\s?#]+)(?:(\?)[^\s#]*?)?(?:(#)\S*?)?(?=[.,;)]?(?:\s|$))/g,
        (match, base: string, query?: string, hash?: string) =>
          query || hash
            ? `${base}${query ? "?…" : ""}${hash ? "#…" : ""}`
            : match,
      )
      .replace(/\b(bearer)\s+[^\s,;"']+/gi, "$1 …")
      // "token abc123": a value with a digit after a secret-like name and a
      // space. A plain word ("token expired", "key not found") stays.
      .replace(
        /\b(token|secret|password|passwd|api[_-]?key|key)\s+(?=[^\s,;"']*\d)[^\s,;"']{6,}/gi,
        "$1 …",
      )
      .replace(
        /\b((?:access[_-]?|refresh[_-]?|api[_-]?|client[_-]?|private[_-]?)?(?:token|secret|password|passwd|key|signature|auth(?:orization|[_-]?token)?))(["']?\s*[:=]\s*["']?)(?!bearer\b)[^\s,;&"']+/gi,
        "$1$2…",
      )
      .replace(/[A-Za-z0-9_-]{32,}/g, (run) =>
        UUID.test(run) ? run : `${run.slice(0, 4)}…`,
      )
  )
}
