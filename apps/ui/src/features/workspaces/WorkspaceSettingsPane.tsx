import { IconAlertCircle } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import {
  deleteWorkspace,
  linkWorkspaceRepository,
  unlinkWorkspaceRepository,
  updateWorkspace,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail } from "./types"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"
import { workspaceDeleteNameMatches } from "./workspaceDeleteNameMatches"

export function WorkspaceSettingsPane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const [linkUrl, setLinkUrl] = useState("")
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmName, setConfirmName] = useState("")

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.list(orgSlug),
    })
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
    })
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      updateWorkspace(orgSlug, workspace.slug, {
        displayName,
        slug,
      }),
    onSuccess: (updated) => {
      invalidate()
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

  const relinkMutation = useMutation({
    mutationFn: (gitUrl: string) =>
      updateWorkspace(orgSlug, workspace.slug, {
        workspaceRepositoryUrl: gitUrl,
      }),
    onSuccess: () => {
      setRelinkError(null)
      invalidate()
      toast.success("Workspace repository updated")
    },
    onError: (error: Error) => setRelinkError(error.message),
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

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      deleteWorkspace(orgSlug, workspace.slug, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      toast.success("Workspace deleted")
      setDeleteOpen(false)
      void navigate({
        to: "/$orgSlug/organization/$organizationView",
        params: { orgSlug, organizationView: "settings" },
      })
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  const projectionLag =
    workspace.activeProjectionUrl &&
    workspace.activeProjectionUrl !== workspace.workspaceRepositoryUrl
      ? workspace.activeProjectionUrl
      : null

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <h2 className="text-lg font-medium tracking-tight">Workspace settings</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This Workspace only. Add Workspace lives in organisation settings.
      </p>

      <section className="mt-6 max-w-md">
        <p className="ctx-label text-muted-foreground">Status</p>
        <p className="mt-2 text-sm">
          Write: {workspace.writeStatus.replace("_", "-")}. Hydrate:{" "}
          {workspace.hydrateStatus}.
        </p>
        {workspace.readOnlyReason ? (
          <div className="mt-3">
            <InlineAlert variant="warning" title="Read-only">
              {workspace.readOnlyReason}
            </InlineAlert>
          </div>
        ) : null}
        {projectionLag ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Serving still uses{" "}
            <code className="font-mono text-xs">{projectionLag}</code> until
            hydrate of the new remote succeeds.
          </p>
        ) : null}
      </section>

      <form
        className="mt-8 flex max-w-md flex-col gap-4"
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
        <Button
          type="submit"
          variant="primary"
          isDisabled={saveMutation.isPending}
        >
          Save
        </Button>
      </form>

      <section className="mt-10 max-w-md">
        <h3 className="text-sm font-medium">Workspace repository</h3>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {workspace.workspaceRepositoryUrl}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Relink keeps this Workspace and its conversations. Knowledge on the
          old remote is left as-is.
        </p>
        <div className="mt-4">
          <WorkspaceRepositoryPicker
            orgSlug={orgSlug}
            currentUrl={workspace.workspaceRepositoryUrl}
            submitLabel="Relink"
            pending={relinkMutation.isPending}
            error={relinkError}
            onSubmit={(url) => {
              setRelinkError(null)
              relinkMutation.mutate(url)
            }}
          />
        </div>
      </section>

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

      <section className="mt-16 max-w-md">
        <h3 className="text-sm font-medium">Delete Workspace</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This removes the Workspace, its conversations, and serving knowledge.
          The git remote is not deleted.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onPress={() => {
            setConfirmName("")
            setDeleteOpen(true)
          }}
        >
          Delete Workspace
        </Button>
      </section>

      <Modal
        isOpen={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open)
          if (!open) setConfirmName("")
        }}
        isDismissable={!deleteMutation.isPending}
      >
        <Dialog role="alertdialog">
          {({ close }) => (
            <>
              <Heading
                slot="title"
                className="my-0 text-xl font-semibold leading-6 text-zinc-100"
              >
                Delete Workspace?
              </Heading>
              <div className="absolute right-6 top-6 size-6 text-destructive">
                <IconAlertCircle aria-hidden className="size-6 stroke-2" />
              </div>
              <p className="mt-3 text-zinc-400">
                Type{" "}
                <strong className="font-medium text-zinc-100">
                  {workspace.displayName}
                </strong>{" "}
                to confirm. This removes the Workspace, its conversations, and
                serving knowledge. The git remote is not deleted.
              </p>
              <TextField
                className="mt-4"
                label="Workspace name"
                value={confirmName}
                onChange={setConfirmName}
                autoFocus
              />
              <div className="mt-6 flex justify-end gap-2">
                <Button
                  variant="quiet"
                  isDisabled={deleteMutation.isPending}
                  onPress={close}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  isDisabled={
                    deleteMutation.isPending ||
                    !workspaceDeleteNameMatches(
                      confirmName,
                      workspace.displayName,
                    )
                  }
                  onPress={() => deleteMutation.mutate(confirmName.trim())}
                >
                  Delete Workspace
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </div>
  )
}
