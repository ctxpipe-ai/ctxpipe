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
 * The state and the add of the Choose Workspaces step: one source for each
 * chosen Workspace. After a successful add it refreshes "Used in" and each
 * Workspace source list, tells the user whether a pull request waits for a
 * merge, and clears the selection.
 */
export function useAddToWorkspaces(input: {
  orgSlug: string
  provider: SourceProvider
  connectionId: string
  onAdded?: () => void
}) {
  const { orgSlug, provider, connectionId, onAdded } = input
  const queryClient = useQueryClient()
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const requests = chooseWorkspacesRequests(value, { provider, connectionId })
  const mutation = useMutation({
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
      onAdded?.()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return {
    value,
    setValue,
    canAdd: requests !== null,
    add: () => {
      if (requests) mutation.mutate(requests)
    },
    isPending: mutation.isPending,
    /** Clear the selection without an add (for example on cancel). */
    reset: () => setValue(emptyChooseWorkspaces()),
  }
}
