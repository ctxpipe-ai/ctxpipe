import { useQuery } from "@tanstack/react-query"
import { workspaceNeedsFormatUpgrade } from "./format-gate"
import { pendingWorkspaceUpgradesOptions } from "./queries"

/**
 * Which Workspaces of the org need the format upgrade, from one read of the
 * pending upgrades (CTX-935). The read lists each Workspace below the newest
 * format, also one with no upgrade item yet, with its format. The connect
 * flows use it to stop before a save that the server refuses. Until the read
 * has succeeded, `ready` is false and the answer is not known: a flow keeps
 * its choices off (`pending` while it loads, `failed` after an error), it
 * does not treat the Workspaces as allowed.
 */
export function useWorkspaceFormatGate(orgSlug: string) {
  const query = useQuery(pendingWorkspaceUpgradesOptions(orgSlug))
  return {
    pending: query.isPending,
    ready: query.isSuccess,
    failed: query.isError,
    retry: () => void query.refetch(),
    needsUpgrade: (workspaceSlug: string) => {
      const entry = query.data?.find(
        (candidate) => candidate.workspaceSlug === workspaceSlug,
      )
      return workspaceNeedsFormatUpgrade({
        items: entry?.items,
        formatVersion: entry?.formatVersion,
        codeFormat: entry?.codeFormat,
      })
    },
  }
}
