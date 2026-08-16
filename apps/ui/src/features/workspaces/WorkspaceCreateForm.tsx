import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { createWorkspace, workspaceKeys } from "./queries"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"

export function WorkspaceCreateForm(props: {
  orgSlug: string
  onCreated?: (slug: string) => void
}) {
  const { orgSlug, onCreated } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: (url: string) => createWorkspace(orgSlug, { gitUrl: url }),
    onSuccess: (workspace) => {
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
      })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <div className="mx-auto w-full max-w-lg">
      <h1 className="text-xl font-medium tracking-tight">Add Workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Create is link — pick a git remote. No draft Workspace. Existing indexed
        repositories that are not this remote are linked for search, and we
        import knowledge into this Workspace.
      </p>
      <div className="mt-6">
        <WorkspaceRepositoryPicker
          orgSlug={orgSlug}
          submitLabel="Create Workspace"
          pending={createMutation.isPending}
          error={error}
          onSubmit={(url) => {
            setError(null)
            createMutation.mutate(url)
          }}
        />
      </div>
    </div>
  )
}
