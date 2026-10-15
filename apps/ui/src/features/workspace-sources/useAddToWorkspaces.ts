import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { toast } from "sonner"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesChanges,
  chooseWorkspacesFromExisting,
  type ExistingWorkspaceSource,
  emptyChooseWorkspaces,
  type WorkspaceSourceChange,
} from "./choose-workspaces"
import {
  connectionUsageOptions,
  createWorkspaceSource,
  deleteWorkspaceSource,
  updateWorkspaceSource,
  workspaceSourceKeys,
  workspaceSourcesOptions,
} from "./queries"

/** A source pull request that a save opened. */
export type OpenedPullRequest = {
  url: string
  workspaceSlug: string
  path: string
  /** The scope of the source after the merge, or null for a remove. */
  scope: Record<string, unknown> | null
}

/**
 * The state and the save of the Choose Workspaces step. It adds one source
 * for each chosen Workspace. With `manage`, the step starts from the sources
 * that the connection has now, and the save also updates a changed scope and
 * removes an unchecked Workspace. After a successful save it refreshes "Used
 * in" and each Workspace source list, tells the user whether a pull request
 * waits for a merge, and clears the selection.
 */
export function useAddToWorkspaces(input: {
  orgSlug: string
  provider: SourceProvider
  connectionId: string
  /** Start from the current sources of the connection (Manage). */
  manage?: boolean
  /** After the save, with the pull request of each Workspace that got one. */
  onAdded?: (pullRequests: OpenedPullRequest[]) => void
}) {
  const { orgSlug, provider, connectionId, manage = false, onAdded } = input
  const queryClient = useQueryClient()
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const [prefilled, setPrefilled] = useState(false)

  // Manage starts from a new read: a cached read can be from before a merge.
  const usageQuery = useQuery({
    ...connectionUsageOptions(orgSlug, connectionId),
    enabled: manage && Boolean(connectionId),
    refetchOnMount: "always",
  })
  // The step holds one scope for each Workspace, so Manage leaves out a
  // Workspace that has more than one source of the connection.
  const managed = (usageQuery.data?.items ?? []).flatMap((item) => {
    const sources = item.sources.filter(
      (source) => source.provider === provider,
    )
    const [only] = sources
    return sources.length === 1 && only
      ? [{ workspaceSlug: item.workspaceSlug, path: only.path }]
      : []
  })
  const sourceQueries = useQueries({
    queries: managed.map((item) => ({
      ...workspaceSourcesOptions(orgSlug, item.workspaceSlug),
      refetchOnMount: "always" as const,
    })),
  })
  const loadFailed =
    manage &&
    (usageQuery.isError || sourceQueries.some((query) => query.isError))
  const loaded =
    usageQuery.isSuccess &&
    !usageQuery.isFetching &&
    sourceQueries.every((query) => query.isSuccess && !query.isFetching)
  const ready = !manage || prefilled
  const existing: Record<string, ExistingWorkspaceSource> = {}
  if (manage && (prefilled || loaded))
    managed.forEach((item, index) => {
      const source = sourceQueries[index]?.data?.items.find(
        (candidate) => candidate.path === item.path,
      )
      if (source)
        existing[item.workspaceSlug] = {
          path: item.path,
          scope: source.scope,
        }
    })
  if (manage && loaded && !prefilled) {
    setPrefilled(true)
    setValue(chooseWorkspacesFromExisting(existing))
  }

  const changes = ready
    ? chooseWorkspacesChanges(value, { provider, connectionId }, existing)
    : null
  const mutation = useMutation({
    mutationFn: (list: WorkspaceSourceChange[]) =>
      Promise.all(
        list.map((change) =>
          change.kind === "add"
            ? createWorkspaceSource(
                orgSlug,
                change.workspaceSlug,
                change.source,
              )
            : change.kind === "update"
              ? updateWorkspaceSource(
                  orgSlug,
                  change.workspaceSlug,
                  change.path,
                  change.source,
                )
              : deleteWorkspaceSource(
                  orgSlug,
                  change.workspaceSlug,
                  change.path,
                ),
        ),
      ),
    onSuccess: (results, list) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.usage(orgSlug, connectionId),
      })
      for (const change of list)
        void queryClient.invalidateQueries({
          queryKey: workspaceSourceKeys.list(orgSlug, change.workspaceSlug),
        })
      const pullRequests = results.flatMap((result, index) => {
        const change = list[index]
        return result.outcome === "pull_request" && change
          ? [
              {
                url: result.pullRequestUrl,
                workspaceSlug: change.workspaceSlug,
                path: result.path,
                scope: change.kind === "remove" ? null : change.source.scope,
              },
            ]
          : []
      })
      toast.success(
        pullRequests.length
          ? manage
            ? "Pull request opened. The change applies after the merge."
            : "Pull request opened. The source starts to sync after the merge."
          : manage
            ? "Sources changed"
            : "Source added",
      )
      setValue(emptyChooseWorkspaces())
      setPrefilled(false)
      onAdded?.(pullRequests)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return {
    value,
    setValue,
    /** The step can show the selection: Manage has loaded the sources. */
    ready,
    /** Manage could not load the current sources, so it cannot save. */
    loadFailed,
    /** The connection has sources that the step shows (Manage). */
    isManaging: Object.keys(existing).length > 0,
    canAdd: Boolean(changes?.length),
    add: () => {
      if (changes?.length) mutation.mutate(changes)
    },
    isPending: mutation.isPending,
    /** Clear the selection without a save (for example on cancel). */
    reset: () => {
      setValue(emptyChooseWorkspaces())
      setPrefilled(false)
    },
  }
}
