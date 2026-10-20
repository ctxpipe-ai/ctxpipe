import { useQuery } from "@tanstack/react-query"
import { workspaceNeedsFormatUpgrade } from "./format-gate"
import { pendingWorkspaceUpgradesOptions } from "./queries"

/**
 * Which Workspaces of the org need the format upgrade, from one read of the
 * pending upgrades (CTX-935). The connect flows use it to stop before a save
 * that the server refuses. While the read loads, no Workspace needs it.
 */
export function useWorkspaceFormatGate(orgSlug: string) {
  const { data } = useQuery(pendingWorkspaceUpgradesOptions(orgSlug))
  return {
    needsUpgrade: (workspaceSlug: string) =>
      workspaceNeedsFormatUpgrade({
        items: data?.find((entry) => entry.workspaceSlug === workspaceSlug)
          ?.items,
      }),
  }
}
