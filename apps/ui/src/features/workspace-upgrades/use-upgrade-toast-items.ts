import { useQuery } from "@tanstack/react-query"
import type { Workspace } from "@/features/workspaces/types"
import { upgradeDismissKey, useUserPreferences } from "@/lib/user-preferences"
import {
  pendingWorkspaceUpgradesOptions,
  type WorkspaceUpgradeItem,
} from "./queries"
import { upgradeCanStart } from "./upgrade-copy"

export type UpgradeToastItem = {
  dismissKey: string
  workspace: Workspace
  item: WorkspaceUpgradeItem
}

/**
 * The upgrade items that an owner or admin can start, in the order of the
 * Workspaces, split by the browser's dismissed keys (CTX-894).
 */
export function useUpgradeToastItems(orgSlug: string, workspaces: Workspace[]) {
  const { data } = useQuery(pendingWorkspaceUpgradesOptions(orgSlug))
  const [preferences, updatePreferences] = useUserPreferences()
  const all: UpgradeToastItem[] = workspaces.flatMap((workspace) =>
    (data?.find((entry) => entry.workspaceSlug === workspace.slug)?.items ?? [])
      .filter(upgradeCanStart)
      .map((item) => ({
        workspace,
        item,
        dismissKey: upgradeDismissKey({
          orgSlug,
          workspaceSlug: workspace.slug,
          key: item.key,
          status: item.status,
        }),
      })),
  )
  const dismissed = all.filter((entry) =>
    preferences.dismissedUpgrades.includes(entry.dismissKey),
  )
  return {
    shown: all.filter((entry) => !dismissed.includes(entry)),
    dismissed,
    updatePreferences,
  }
}
