import HyperDX from "@hyperdx/browser"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { workspaceCreateLandingSearch } from "./github-workspace-destination-nav"
import { createWorkspace, workspaceKeys } from "./queries"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"

export function WorkspaceCreateForm(props: {
  orgSlug: string
  onCreated?: (slug: string) => void
  after?: "settings"
}) {
  const { orgSlug, onCreated, after } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: (choice: {
      gitUrl: string
      githubConnectionId?: string
      source: "select" | "paste"
    }) => createWorkspace(orgSlug, choice),
    onSuccess: (workspace) => {
      HyperDX.addAction("workspace_created")
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      if (onCreated) {
        onCreated(workspace.slug)
        return
      }
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug",
        params: { orgSlug, workspaceSlug: workspace.slug },
        search: workspaceCreateLandingSearch(after),
      })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <div className="w-full">
      <h1 className="text-lg font-medium tracking-tight">Add Workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick one repository to be this Workspace’s repository. ctxpipe writes
        the Workspace’s knowledge and connector files into it and reads its
        code. A monorepo works as one repository. You can link more repositories
        for code search in Settings after you create the Workspace.
      </p>
      <div className="mt-6">
        <WorkspaceRepositoryPicker
          orgSlug={orgSlug}
          submitLabel="Create Workspace"
          pending={createMutation.isPending}
          error={error}
          onSubmit={(choice) => {
            setError(null)
            createMutation.mutate(choice)
          }}
        />
      </div>
    </div>
  )
}
