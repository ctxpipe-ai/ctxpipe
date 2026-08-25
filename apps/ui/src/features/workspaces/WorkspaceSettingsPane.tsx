import { IconAlertCircle, IconGitBranch, IconPencil } from "@tabler/icons-react"
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
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import { cn } from "@/lib/utils"
import { deleteWorkspace, updateWorkspace, workspaceKeys } from "./queries"
import type { WorkspaceDetail } from "./types"
import { WorkspaceLinkedRepositories } from "./WorkspaceLinkedRepositories"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"
import { workspaceDeleteNameMatches } from "./workspaceDeleteNameMatches"
import { writeStatusLabel } from "./writeStatusLabel"

function writeTag(status: string): { label: string; className: string } {
  const tagged = writeStatusLabel(status)
  if (tagged.tone === "writable") {
    return {
      label: tagged.label,
      className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
    }
  }
  if (tagged.tone === "pending") {
    return {
      label: tagged.label,
      className: "border-border bg-zinc-800 text-muted-foreground",
    }
  }
  return {
    label: tagged.label,
    className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  }
}

function hydrateTag(status: string): {
  label: string
  className: string
  pulse?: boolean
} {
  if (status === "ready") {
    return {
      label: "Hydrate ready",
      className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
    }
  }
  if (status === "failed") {
    return {
      label: "Hydrate failed",
      className: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    }
  }
  if (status === "running") {
    return {
      label: "Hydrating",
      className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
      pulse: true,
    }
  }
  return {
    label: "Hydrate pending",
    className: "border-border bg-zinc-800 text-muted-foreground",
    pulse: true,
  }
}

function StatusTag({
  label,
  className,
  pulse,
}: {
  label: string
  className: string
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-xs",
        className,
      )}
    >
      <span
        className={
          pulse
            ? "size-1.5 shrink-0 animate-pulse rounded-full bg-current"
            : "size-1.5 shrink-0 rounded-full bg-current"
        }
        aria-hidden
      />
      {label}
    </span>
  )
}

export function WorkspaceSettingsPane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmName, setConfirmName] = useState("")

  const dirty =
    displayName.trim() !== workspace.displayName ||
    slug.trim() !== workspace.slug

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
    mutationFn: (choice: {
      gitUrl: string
      githubConnectionId?: string
      source: "select" | "paste"
    }) =>
      updateWorkspace(orgSlug, workspace.slug, {
        workspaceRepositoryUrl: choice.gitUrl,
        githubConnectionId: choice.githubConnectionId ?? null,
        source: choice.source,
      }),
    onSuccess: () => {
      setRelinkError(null)
      setRelinkOpen(false)
      invalidate()
      toast.success("Workspace repository updated")
    },
    onError: (error: Error) => setRelinkError(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      deleteWorkspace(orgSlug, workspace.slug, name),
    onSuccess: () => {
      toast.success("Workspace deleted")
      setDeleteOpen(false)
      void navigate({
        to: "/$orgSlug",
        params: { orgSlug },
        replace: true,
      }).then(() => {
        queryClient.removeQueries({
          queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
        })
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.list(orgSlug),
        })
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

  const write = writeTag(workspace.writeStatus)
  const hydrate = hydrateTag(workspace.hydrateStatus)
  const repoTitle =
    githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
    workspace.workspaceRepositoryUrl
  const repoWebUrl = githubWebUrl(workspace.workspaceRepositoryUrl)

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg font-medium tracking-tight">
          Workspace settings
        </h1>
        <Button
          type="submit"
          form="workspace-settings"
          variant="primary"
          isDisabled={saveMutation.isPending || !dirty}
        >
          Save
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <StatusTag label={write.label} className={write.className} />
        <StatusTag
          label={hydrate.label}
          className={hydrate.className}
          pulse={hydrate.pulse}
        />
      </div>

      {workspace.readOnlyReason ? (
        <div className="mt-4 max-w-lg">
          <InlineAlert variant="warning" title="Read-only">
            {workspace.readOnlyReason}
          </InlineAlert>
        </div>
      ) : null}
      {projectionLag ? (
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          Serving still uses{" "}
          <code className="font-mono text-xs">{projectionLag}</code> until
          hydrate of the new remote succeeds.
        </p>
      ) : null}

      <form
        id="workspace-settings"
        className="mt-8 flex max-w-lg flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          saveMutation.mutate()
        }}
      >
        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
        />
        <TextField
          label="Slug"
          value={slug}
          onChange={setSlug}
          description="URL segment. Relink does not change it. The old slug 404s."
        />
      </form>

      <section className="mt-10 max-w-lg">
        <h2 className="text-sm font-medium text-foreground">
          Workspace repository
        </h2>
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-border px-3 py-2">
          <span
            className="ctx-node size-8 shrink-0 rounded-lg text-muted-foreground"
            aria-hidden
          >
            <IconGitBranch className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{repoTitle}</p>
            {repoWebUrl ? (
              <a
                href={repoWebUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate text-xs text-muted-foreground hover:text-foreground"
              >
                {workspace.workspaceRepositoryUrl}
              </a>
            ) : (
              <p className="truncate font-mono text-xs text-muted-foreground">
                {workspace.workspaceRepositoryUrl}
              </p>
            )}
          </div>
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label="Edit workspace repository"
            onPress={() => {
              setRelinkError(null)
              setRelinkOpen(true)
            }}
          >
            <IconPencil className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        </div>
      </section>

      <WorkspaceLinkedRepositories orgSlug={orgSlug} workspace={workspace} />

      <section className="mt-16 max-w-lg">
        <h2 className="text-sm font-medium text-foreground">
          Delete Workspace
        </h2>
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
        isOpen={relinkOpen}
        onOpenChange={(open) => {
          setRelinkOpen(open)
          if (!open) setRelinkError(null)
        }}
        isDismissable={!relinkMutation.isPending}
        size="medium"
        placement="top"
      >
        <Dialog>
          <Heading
            slot="title"
            className="my-0 text-lg font-medium leading-6 text-foreground"
          >
            Workspace repository
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            Relink keeps this Workspace and its conversations. Knowledge on the
            old remote is left as-is.
          </p>
          <div className="mt-5">
            <WorkspaceRepositoryPicker
              orgSlug={orgSlug}
              currentUrl={workspace.workspaceRepositoryUrl}
              submitLabel="Save"
              pending={relinkMutation.isPending}
              error={relinkError}
              onSubmit={(choice) => {
                setRelinkError(null)
                relinkMutation.mutate(choice)
              }}
            />
          </div>
        </Dialog>
      </Modal>

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
                className="my-0 text-lg font-medium leading-6 text-foreground"
              >
                Delete Workspace?
              </Heading>
              <div className="absolute right-6 top-6 size-6 text-destructive">
                <IconAlertCircle aria-hidden className="size-6 stroke-2" />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Type{" "}
                <strong className="font-medium text-foreground">
                  {workspace.displayName}
                </strong>{" "}
                to confirm. This removes the Workspace, its conversations, and
                serving knowledge. The git remote is not deleted.
              </p>
              <form
                className="mt-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (
                    deleteMutation.isPending ||
                    !workspaceDeleteNameMatches(
                      confirmName,
                      workspace.displayName,
                    )
                  ) {
                    return
                  }
                  deleteMutation.mutate(confirmName.trim())
                }}
              >
                <TextField
                  label="Workspace name"
                  placeholder={workspace.displayName}
                  value={confirmName}
                  onChange={setConfirmName}
                  autoFocus
                />
                <div className="mt-6 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="quiet"
                    isDisabled={deleteMutation.isPending}
                    onPress={close}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    isPending={deleteMutation.isPending}
                    isDisabled={
                      !workspaceDeleteNameMatches(
                        confirmName,
                        workspace.displayName,
                      )
                    }
                  >
                    Delete Workspace
                  </Button>
                </div>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </div>
  )
}
