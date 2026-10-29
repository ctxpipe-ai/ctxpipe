import { useNow } from "@/lib/useNow"

import type { WorkspaceUpgradeItem } from "./queries"
import { upgradeIsCheckingFormat } from "./upgrade-copy"

/**
 * After the merge, a re-ingestion stays blocked for the format until the
 * scan after the hydrate rewrites it, and ctxpipe shows "Checking the new
 * format". If that scan never runs, the state must end: a minute after this
 * client first saw it, the item shows the blocked line again, and the 3 s
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
 * The keys of the items whose checking state is older than a minute, and a
 * re-render when a minute ends. The Upgrades card and the summary of
 * Workspace settings both call it. The first sight of each item is in one
 * map, so the two change together. The clock stops when no item checks and is
 * not expired, so the card does not render each second for ever.
 * `scope` names the Workspace: `<org>/<workspace>`.
 */
export function useExpiredCheckingKeys(
  scope: string,
  items: readonly WorkspaceUpgradeItem[],
  formatVersion: number | null,
): ReadonlySet<string> {
  const expired = new Set<string>()
  let ticking = false
  for (const item of items) {
    const checking = upgradeIsCheckingFormat(item, formatVersion)
    if (checkingFormatExpired(`${scope}/${item.key}`, checking))
      expired.add(item.key)
    else if (checking) ticking = true
  }
  // The tick re-renders the group. The render after the minute sees the
  // expired key and turns the clock off.
  useNow(ticking)
  return expired
}
