/** One-time hints on real UI for new users (CTX-552). */
export type HintId = "add-workspace" | "panes" | "create-pr"

/** When several anchors are on the page, the earlier hint shows first. */
const HINT_ORDER: readonly HintId[] = ["add-workspace", "panes", "create-pr"]

/** The one hint to show now, or `null`. */
export function activeHint(input: {
  /** Hints whose anchor is on the page. */
  mounted: readonly HintId[]
  seen: readonly string[]
  /** The user finished onboarding in the guide window. */
  newUser: boolean
}): HintId | null {
  if (!input.newUser) return null
  for (const id of HINT_ORDER) {
    if (!input.mounted.includes(id) || input.seen.includes(id)) continue
    if (id === "create-pr" && !input.seen.includes("panes")) continue
    return id
  }
  return null
}
