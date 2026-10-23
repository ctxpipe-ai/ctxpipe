import type { WorkspaceUpgradeItem } from "./queries"

type FormatUpgradeItem = Pick<WorkspaceUpgradeItem, "kind" | "status">

/** The format upgrade of a Workspace that is not applied yet, or undefined. */
export function pendingFormatUpgrade<T extends FormatUpgradeItem>(
  items: readonly T[] | undefined,
): T | undefined {
  return items?.find(
    (item) => item.kind === "format" && item.status !== "completed",
  )
}

/**
 * The one rule for "this Workspace needs the format upgrade first". The
 * sources of a Workspace, the connect flows and the Add controls need the
 * newest format. A Workspace needs the upgrade when it has a format upgrade
 * that is not applied, or when ctxpipe read a format below the newest one. The
 * server can have no upgrade item yet for a format that ctxpipe did not read,
 * so an unread format (null) with no item says nothing. A format file that
 * is not valid, or a format above the newest, is not fixed with an upgrade.
 */
export function workspaceNeedsFormatUpgrade(state: {
  items: readonly FormatUpgradeItem[] | undefined
  formatVersion?: number | null | undefined
  codeFormat?: number | undefined
}): boolean {
  if (pendingFormatUpgrade(state.items)) return true
  const { formatVersion, codeFormat } = state
  return (
    typeof formatVersion === "number" &&
    typeof codeFormat === "number" &&
    formatVersion >= 0 &&
    formatVersion < codeFormat
  )
}

/** The Workspace settings link that lands on the Status group. */
export function workspaceUpgradesHref(
  orgSlug: string,
  workspaceSlug: string,
): string {
  return `/${orgSlug}/ws/${workspaceSlug}?pane=settings#upgrades`
}

export type FormatUpgradeContext = "workspace" | "sources" | "connect"

/** What the notice says about the Workspace, for the place where the user reads it. */
export function formatUpgradeCopy(context: FormatUpgradeContext): {
  title: string
  body: string
} {
  switch (context) {
    case "workspace":
      return {
        title: "This Workspace needs the format upgrade",
        body: "Its repository still has the old layout. Until you merge the upgrade, the sources of this Workspace are not available, so chat answers can be incomplete.",
      }
    case "sources":
      return {
        title: "Sources move with the format upgrade",
        body: "This Workspace keeps its sources in the old layout. The format upgrade moves them. Until you merge it, you cannot add or change sources here.",
      }
    case "connect":
      return {
        title: "Upgrade the Workspace before you add a source",
        body: "Sources need the new repository layout. Run the format upgrade first, then try again.",
      }
  }
}

/** The line that says where the upgrade stands, and what happens next. */
export function formatUpgradeStatusLine(
  item: Pick<WorkspaceUpgradeItem, "status" | "note"> | undefined,
): string {
  switch (item?.status) {
    case "queued":
    case "running":
      return "ctxpipe is preparing the upgrade pull request now."
    case "pr_open":
      return "The upgrade pull request is open. Merge it on GitHub. Then ctxpipe reads the new format."
    case "blocked":
      return `${item.note ?? "ctxpipe cannot start the upgrade now."} Open Upgrades for the next step.`
    case undefined:
      return "ctxpipe has not found the upgrade yet. Open Upgrades to check the repository again."
    default:
      return ""
  }
}
