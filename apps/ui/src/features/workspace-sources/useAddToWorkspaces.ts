import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { toast } from "sonner"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"
import { createWorkspaceSource, workspaceSourceKeys } from "./queries"

/**
 * The state and the add request of the "Choose Workspaces" step: one source
 * for each selected Workspace. `onAdded` runs after each source is added.
 */
export function useAddToWorkspaces(input: {
  orgSlug: string
  connectionId: string
  provider: SourceProvider
  onAdded: () => void
}) {
  const { orgSlug, connectionId, provider, onAdded } = input
  const queryClient = useQueryClient()
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const requests = chooseWorkspacesRequests(value, { provider, connectionId })
  const addMutation = useMutation({
    mutationFn: (list: NonNullable<typeof requests>) =>
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
      setValue(emptyChooseWorkspaces())
      onAdded()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return {
    value,
    setValue,
    reset: () => setValue(emptyChooseWorkspaces()),
    canAdd: requests !== null,
    isAdding: addMutation.isPending,
    add: () => {
      if (requests) addMutation.mutate(requests)
    },
  }
}
