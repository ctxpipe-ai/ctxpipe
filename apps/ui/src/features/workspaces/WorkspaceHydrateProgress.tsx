import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { workspaceHydrateView } from "./projection"
import { retryPrepareWorkspace, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

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
  const sha = workspace.desiredSha

  if (view === "failed") {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-md">
          <p className="ctx-label text-teal-400">Workspace</p>
          <h1 className="mt-3 text-xl font-medium tracking-tight">
            Preparing {workspace.displayName}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Chat and the graph wait until the first hydrate SHA is the active
            projection. Prepare did not finish.
          </p>
          <div className="mt-5">
            <InlineAlert
              variant="error"
              title="Prepare failed"
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
              {workspace.hydrateError ??
                "The prepare job failed before a hydrate SHA was ready."}
            </InlineAlert>
          </div>
        </div>
      </main>
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
          Chat and the graph wait until the first hydrate SHA is the active
          projection. This Workspace is still importing knowledge from git.
        </p>
        <p className="mt-5 flex items-center gap-2 text-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-400" />
          </span>
          <span>
            Hydrate {workspace.hydrateStatus}
            {sha ? (
              <>
                {" "}
                for{" "}
                <code className="font-mono text-xs tabular-nums">
                  {sha.slice(0, 12)}
                </code>
              </>
            ) : (
              ". Waiting for a resolved tip."
            )}
          </span>
        </p>
        {view === "waiting_for_tip" ? (
          <div className="mt-5">
            <p className="text-sm text-muted-foreground">
              Hydrate does not wait on a bootstrap commit. Try again resolves
              the git tip and hydrates.
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
