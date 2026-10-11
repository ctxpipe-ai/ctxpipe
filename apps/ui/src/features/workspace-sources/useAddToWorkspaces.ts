import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { chooseWorkspacesRequests } from "./choose-workspaces"
import { createWorkspaceSource, workspaceSourceKeys } from "./queries"

type AddRequests = NonNullable<ReturnType<typeof chooseWorkspacesRequests>>

/**
 * Add one source to each chosen Workspace (the requests of the Choose
 * Workspaces step), refresh "Used in" and each Workspace source list, and
 * tell the user whether a pull request waits for a merge.
 */
export function useAddToWorkspaces(input: {
  orgSlug: string
  connectionId: string
  onAdded: () => void
}) {
  const { orgSlug, connectionId, onAdded } = input
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (list: AddRequests) =>
      Promise.all(
        list.map((request) =>
          createWorkspaceSource(orgSlug, request.workspaceSlug, request.source),
        ),
      ),
    onSuccess: (results, list) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.usage(orgSlug, connectionId),
      })
      for (const request of list)
        void queryClient.invalidateQueries({
          queryKey: workspaceSourceKeys.list(orgSlug, request.workspaceSlug),
        })
      toast.success(
        results.some((result) => result.outcome === "pull_request")
          ? "Pull request opened. The source starts to sync after the merge."
          : "Source added",
      )
      onAdded()
    },
    onError: (error: Error) => toast.error(error.message),
  })
}
