import { workspaceNeedsFormatUpgrade } from "@/features/workspace-upgrades/format-gate"
import { formatHealthLine } from "@/features/workspace-upgrades/upgrade-copy"

type AddRepositoriesGate = {
  title: string
  body: string
  /** The button that opens the next step in the Workspace settings. */
  action: "Open Workspace settings" | "Review upgrades"
}

/**
 * Why a Workspace cannot take repositories now, or null. The server refuses
 * each add (409) when the Workspace is read-only or its repository is below
 * the format that Sources need, so the dialog shows the reason and the next
 * step first. The checks run in the order of Add Workspace step 2.
 */
export function addRepositoriesGate(input: {
  canEdit: boolean
  readOnlyReason: string | null | undefined
  formatVersion: number | null
  codeFormat: number
}): AddRepositoriesGate | null {
  const { formatVersion, codeFormat } = input
  if (!input.canEdit)
    return {
      title: "Read-only",
      body: input.readOnlyReason ?? "This Workspace is read-only.",
      action: "Open Workspace settings",
    }
  if (formatVersion === null)
    return {
      title: "Still setting up the Workspace repository",
      body: "Try again in a moment, or open the Workspace settings.",
      action: "Open Workspace settings",
    }
  // A format file that is not valid reads as a negative number. A format
  // above the one that ctx| reads makes the Workspace read-only. An upgrade
  // does not fix either case.
  if (formatVersion < 0 || formatVersion > codeFormat)
    return {
      title: "Read-only",
      body: formatHealthLine(formatVersion, codeFormat),
      action: "Open Workspace settings",
    }
  if (workspaceNeedsFormatUpgrade({ items: [], formatVersion, codeFormat }))
    return {
      title: "Upgrade this Workspace before you add repositories",
      body: "Repositories need the newest repository format. An owner or admin starts the upgrade. It opens a pull request. Merge it, then add repositories.",
      action: "Review upgrades",
    }
  return null
}
