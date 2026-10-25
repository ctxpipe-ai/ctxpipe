import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
} from "./queries"
import { upgradeStartedMessage } from "./upgrade-copy"

/** The click of an owner or admin on Start. One mutation for each item. */
export function useStartWorkspaceUpgrade(
  orgSlug: string,
  workspaceSlug: string,
  item: Pick<WorkspaceUpgradeItem, "key" | "kind">,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => startWorkspaceUpgrade(orgSlug, workspaceSlug, item.key),
    onSuccess: () => {
      toast.success(upgradeStartedMessage(item))
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.pending(orgSlug),
        }),
      ]),
  })
}
