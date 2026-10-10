import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { workspaceHydrateView } from "./projection"
import { retryPrepareWorkspace, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceHydrateFailedBody(props: {
  orgSlug: string
  workspace: Workspace
}) {
  const { orgSlug, workspace } = props
  const queryClient = useQueryClient()
  const retryMutation = useMutation({
    mutationFn: () => retryPrepareWorkspace(orgSlug, workspace.slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    },
  })

  return (
    <div className="w-full max-w-md">
      <h1 className="text-lg font-medium tracking-tight">Prepare failed</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Chat and the graph open when ctx| can read this repository. Change the
        Workspace repository in settings, or try again.
      </p>
      <div className="mt-5">
        <InlineAlert
          variant="error"
          title="Could not prepare the Workspace"
          actions={
            <Button
              variant="primary"
              isPending={retryMutation.isPending}
              onPress={() => retryMutation.mutate()}
            >
              Try again
            </Button>
          }
        >
          {workspace.hydrateError ?? "ctx| could not read this repository."}
        </InlineAlert>
      </div>
    </div>
  )
}

export function WorkspaceHydrateProgress(props: {
  orgSlug: string
  workspace: Workspace
}) {
  const { orgSlug, workspace } = props
  const view = workspaceHydrateView(workspace)
  const queryClient = useQueryClient()
  const retryMutation = useMutation({
    mutationFn: () => retryPrepareWorkspace(orgSlug, workspace.slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    },
  })
  const currentStage = view === "waiting_for_tip" ? 0 : 1

  if (view === "failed") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-12">
        <WorkspaceHydrateFailedBody orgSlug={orgSlug} workspace={workspace} />
      </div>
    )
  }

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-md">
        <p className="ctx-label text-teal-400">Workspace</p>
        <h1 className="mt-3 text-xl font-medium tracking-tight">
          Preparing {workspace.displayName}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          ctx| reads the knowledge in this repository. Chat and the graph open
          when it is done.
        </p>
        <ol className="mt-5 space-y-2 text-sm">
          {["Fetching repository", "Reading knowledge"].map((label, index) => (
            <li
              key={label}
              aria-current={index === currentStage ? "step" : undefined}
              className={
                index === currentStage
                  ? "flex items-center gap-2 text-foreground"
                  : "text-muted-foreground"
              }
            >
              {label}
              {index === currentStage ? (
                <span className="ctx-indexing-dot" aria-hidden />
              ) : null}
            </li>
          ))}
        </ol>
        {view === "waiting_for_tip" ? (
          <div className="mt-5">
            <p className="text-sm text-muted-foreground">
              The latest commit of this repository is not known yet. Select Try
              again to check the repository.
            </p>
            <div className="mt-4">
              <Button
                variant="primary"
                isPending={retryMutation.isPending}
                onPress={() => retryMutation.mutate()}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  )
}
