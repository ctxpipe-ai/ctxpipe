import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import {
  linkWorkspaceRepository,
  unlinkWorkspaceRepository,
  updateWorkspace,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail } from "./types"

export function WorkspaceSettingsPane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const [repoUrl, setRepoUrl] = useState(workspace.workspaceRepositoryUrl)
  const [linkUrl, setLinkUrl] = useState("")

  const saveMutation = useMutation({
    mutationFn: () =>
      updateWorkspace(orgSlug, workspace.slug, {
        displayName,
        slug,
        workspaceRepositoryUrl: repoUrl,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      toast.success("Workspace updated")
      if (updated.slug !== workspace.slug) {
        void navigate({
          to: "/$orgSlug/ws/$workspaceSlug",
          params: { orgSlug, workspaceSlug: updated.slug },
          search: { pane: "settings" },
        })
      }
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  const linkMutation = useMutation({
    mutationFn: () => linkWorkspaceRepository(orgSlug, workspace.slug, linkUrl),
    onSuccess: () => {
      setLinkUrl("")
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unlinkMutation = useMutation({
    mutationFn: (linkedId: string) =>
      unlinkWorkspaceRepository(orgSlug, workspace.slug, linkedId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <h2 className="text-lg font-medium tracking-tight">Workspace settings</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This Workspace only. Add Workspace lives in organisation settings.
      </p>
      <form
        className="mt-6 flex max-w-md flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          saveMutation.mutate()
        }}
      >
        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          description="Git-canonical in AGENTS.md. May differ from the slug."
        />
        <TextField
          label="Slug"
          value={slug}
          onChange={setSlug}
          description="URL segment. Relink does not change it. The old slug 404s."
        />
        <TextField
          label="Workspace repository"
          value={repoUrl}
          onChange={setRepoUrl}
          description="Relink keeps this Workspace and its conversations."
        />
        {workspace.readOnlyReason ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
            Read-only: {workspace.readOnlyReason}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          isDisabled={saveMutation.isPending}
        >
          Save
        </Button>
      </form>

      <section className="mt-10 max-w-md">
        <h3 className="text-sm font-medium">Linked repositories</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Extra remotes for codesearch. Link or unlink here.
        </p>
        <ul className="mt-3 space-y-2">
          {workspace.linkedRepositories.length === 0 ? (
            <li className="text-sm text-muted-foreground">None linked.</li>
          ) : (
            workspace.linkedRepositories.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 truncate font-mono text-xs">
                  {item.gitUrl}
                </span>
                <Button
                  variant="outline"
                  className="shrink-0"
                  onPress={() => unlinkMutation.mutate(item.id)}
                >
                  Unlink
                </Button>
              </li>
            ))
          )}
        </ul>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (linkUrl.trim()) linkMutation.mutate()
          }}
        >
          <TextField
            aria-label="Git URL to link"
            value={linkUrl}
            onChange={setLinkUrl}
            placeholder="https://github.com/org/repo.git"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary">
            Link
          </Button>
        </form>
      </section>
    </div>
  )
}
