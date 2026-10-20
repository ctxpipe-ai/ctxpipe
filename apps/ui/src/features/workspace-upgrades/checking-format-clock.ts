import { useNow } from "@/lib/useNow"

/**
 * After the merge, a re-ingestion stays blocked for the format until the
 * scan after the hydrate rewrites it, and ctx| shows "Checking the new
 * format". If that scan never runs, the state must end: a minute after this
 * client first saw it, the card shows the blocked line again, and the 3 s
 * poll stops (CTX-949). The minute counts from the first sight in this
 * browser. It does not use `updatedAt`: a slow scan would bring back the "up
 * to date and Blocked" pair.
 */
const CHECKING_FORMAT_MS = 60_000

const firstSeen = new Map<string, number>()

/**
 * True when the checking state of `scope` is older than a minute. A scope that
 * is not checking now starts again at its next sight. `scope` names the item:
 * `<org>/<workspace>/<key>`.
 */
export function checkingFormatExpired(
  scope: string,
  checking: boolean,
  now = Date.now(),
): boolean {
  if (!checking) {
    firstSeen.delete(scope)
    return false
  }
  const since = firstSeen.get(scope) ?? now
  firstSeen.set(scope, since)
  return now - since >= CHECKING_FORMAT_MS
}

/**
 * The same answer as {@link checkingFormatExpired}, and a re-render when the
 * minute ends. The clock stops when the state has expired, so the card does
 * not render each second for ever.
 */
export function useCheckingFormatExpired(
  scope: string,
  checking: boolean,
): boolean {
  const expired = checkingFormatExpired(scope, checking)
  // The tick re-renders the card. The render after the minute sees `expired`
  // and turns the clock off.
  useNow(checking && !expired)
  return expired
}
