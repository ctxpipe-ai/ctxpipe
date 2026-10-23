import { IconAlertCircle, IconGitBranch, IconPencil } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Heading, Link } from "react-aria-components"
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
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"
import { WORKSPACE_UPGRADES_HASH } from "@/features/workspace-upgrades/queries"
import { WorkspaceUpgrades } from "@/features/workspace-upgrades/WorkspaceUpgrades"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { writeCheckInFlight } from "./projection"
import {
  checkWorkspaceWriteAccess,
  deleteWorkspace,
  forgetDeletedWorkspace,
  updateWorkspace,
  workspaceKeys,
} from "./queries"
import { normalizeRootFolder, rootFolderError } from "./rootFolder"
import { StatusTag } from "./StatusTag"
import {
  skippedFileCopy,
  skippedFileFixable,
  skippedFilesFixPrompt,
} from "./skipped-files"
import type { WorkspaceDetail, WorkspaceSkippedFile } from "./types"
import {
  type WorkspaceRepositoryChoice,
  WorkspaceRepositoryPicker,
} from "./WorkspaceRepositoryPicker"
import { WorkspaceRootFolderField } from "./WorkspaceRootFolderField"
import { workspaceDeleteNameMatches } from "./workspaceDeleteNameMatches"
import { useWriteCheckStall } from "./writeCheckStall"
import { writeStatusLabel } from "./writeStatusLabel"

function writeTag(tagged: ReturnType<typeof writeStatusLabel>): {
  label: string
  className: string
} {
  if (tagged.tone === "writable") {
    return {
      label: "Can save changes",
      className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
    }
  }
  if (tagged.tone === "pending" || tagged.tone === "pull_request") {
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
      label: "Ready",
      className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
    }
  }
  if (status === "failed") {
    return {
      label: "Loading failed",
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

/** One settings group: a hairline, a mono eyebrow, then the content. */
function SettingsGroup(props: {
  eyebrow: string
  children: ReactNode
  /** A link can land on the group: it gets the focus and scrolls into view. */
  landing?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const section = ref.current
    if (!props.landing || !section) return
    // Scroll only the pane's own scroll area. `scrollIntoView` and a plain
    // `focus` also scroll the outer boxes, which shifts the whole pane.
    const scroller = section.closest<HTMLElement>("[data-settings-scroll]")
    const toStart = () => {
      if (!scroller) return
      scroller.scrollTop +=
        section.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top
    }
    section.focus({ preventScroll: true })
    toStart()
    // The groups above grow when their data loads. Keep this group in view
    // until the user scrolls, or for a few seconds.
    const keep = new ResizeObserver(toStart)
    if (section.parentElement) keep.observe(section.parentElement)
    const stop = () => keep.disconnect()
    const timer = setTimeout(stop, 3000)
    const events = ["wheel", "touchstart", "keydown"] as const
    for (const event of events) window.addEventListener(event, stop)
    return () => {
      stop()
      clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, stop)
    }
  }, [props.landing])
  return (
    <div
      ref={ref}
      data-settings-group={props.eyebrow}
      tabIndex={props.landing === undefined ? undefined : -1}
      className="border-t border-white/[0.06] pt-4 outline-none"
    >
      <p className="ctx-label text-muted-foreground">{props.eyebrow}</p>
      <div className="mt-6">{props.children}</div>
    </div>
  )
}

function SkippedFilesNotice(props: {
  files: WorkspaceSkippedFile[]
  onOpenFile: (path: string) => void
  onFixWithAgent?: (prompt: string) => void
}) {
  const { onFixWithAgent } = props
  const count = props.files.length
  return (
    <div className="mt-4 max-w-lg">
      <InlineAlert
        variant="warning"
        title={`Hydrate skipped ${count} ${count === 1 ? "file" : "files"}`}
      >
        <p>
          Chat, MCP, search, and the graph do not use these files.
          {props.files.some((file) => file.source !== "legacy-overlay")
            ? " Fix each file that is in Git and push the change to the default branch."
            : ""}
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          {props.files.map((file) => (
            <li
              key={file.path}
              className="flex min-w-0 items-center justify-between gap-3"
            >
              <div className="min-w-0">
                {/* A legacy overlay path is not in Git, so the Files pane cannot open it. */}
                {file.source === "legacy-overlay" ? (
                  <span className="block truncate font-mono text-xs text-amber-50">
                    {file.path}
                  </span>
                ) : (
                  <Link
                    onPress={() => props.onOpenFile(file.path)}
                    className={cn(
                      "block cursor-pointer truncate rounded-md font-mono text-xs text-amber-50 underline decoration-amber-200/40 underline-offset-2 hover:decoration-amber-50",
                      focusVisibleClassName,
                    )}
                  >
                    {file.path}
                  </Link>
                )}
                <p className="text-xs text-amber-100/70">
                  {skippedFileCopy(file)}
                </p>
              </div>
              {/* Only front matter in a file of Git is for the agent to fix. */}
              {onFixWithAgent && skippedFileFixable(file) ? (
                <Button
                  variant="secondary"
                  className="shrink-0"
                  aria-label={`Fix ${file.path} using agent`}
                  onPress={() => onFixWithAgent(skippedFilesFixPrompt([file]))}
                >
                  Fix using agent
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </InlineAlert>
    </div>
  )
}

export function WorkspaceSettingsPane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  /** Opens a Workspace file in the Files pane. */
  onOpenFile: (path: string) => void
  /** Opens the Workspace chat with this prompt in the composer. */
  onFixWithAgent?: (prompt: string) => void
}) {
  const { orgSlug, workspace } = props
  const hash = useLocation({ select: (location) => location.hash })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmName, setConfirmName] = useState("")
  const [rootFolder, setRootFolder] = useState(workspace.rootPath ?? "")
  const rootFolderChanged =
    normalizeRootFolder(rootFolder) !== (workspace.rootPath ?? "")

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
    mutationFn: (choice: WorkspaceRepositoryChoice) =>
      updateWorkspace(orgSlug, workspace.slug, {
        workspaceRepositoryUrl: choice.gitUrl,
        githubConnectionId: choice.githubConnectionId ?? null,
        source: choice.source,
        rootPath: choice.rootPath,
      }),
    onSuccess: () => {
      setRelinkError(null)
      setRelinkOpen(false)
      invalidate()
      toast.success("Workspace repository updated")
    },
    onError: (error: Error) => setRelinkError(error.message),
  })

  const rootFolderMutation = useMutation({
    mutationFn: () =>
      updateWorkspace(orgSlug, workspace.slug, {
        rootPath: normalizeRootFolder(rootFolder),
      }),
    onSuccess: (updated) => {
      setRootFolder(updated.rootPath)
      invalidate()
      toast.success("Root folder saved")
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  const checkWriteMutation = useMutation({
    mutationFn: () => checkWorkspaceWriteAccess(orgSlug, workspace.slug),
    onSuccess: invalidate,
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  // Remove the caches of a deleted Workspace only after this pane unmounts.
  // While the Workspace is on screen, a removed query would read again, get a
  // 404, and replace the page with an error.
  const deletedRef = useRef(false)
  useEffect(
    () => () => {
      if (!deletedRef.current) return
      setTimeout(() => {
        queryClient.removeQueries({
          predicate: ({ queryKey: [, org, slug] }) =>
            org === orgSlug && slug === workspace.slug,
        })
      })
    },
    [queryClient, orgSlug, workspace.slug],
  )

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      deleteWorkspace(orgSlug, workspace.slug, name),
    onSuccess: async () => {
      toast.success("Workspace deleted")
      deletedRef.current = true
      setDeleteOpen(false)
      await forgetDeletedWorkspace(queryClient, orgSlug, workspace.id)
      void navigate({
        to: "/$orgSlug",
        params: { orgSlug },
        replace: true,
      }).then(() => {
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

  const stall = useWriteCheckStall()
  const writeLabel = writeStatusLabel(
    workspace.writeStatus,
    workspace.readOnlyReason,
    workspace.conversationWritable,
  )
  const write = writeTag(writeLabel)
  const hydrate = hydrateTag(workspace.hydrateStatus)
  const repoTitle =
    githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
    workspace.workspaceRepositoryUrl
  const repoWebUrl = githubWebUrl(workspace.workspaceRepositoryUrl)

  return (
    // The pane is a container: the groups take columns when it is wide.
    <div
      data-settings-scroll
      className="@container min-h-0 flex-1 overflow-auto"
    >
      <div className="mx-auto max-w-5xl px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-lg font-medium tracking-tight">
              Workspace settings
            </h1>
            <StatusTag label={write.label} className={write.className} />
            <StatusTag
              label={hydrate.label}
              className={hydrate.className}
              pulse={hydrate.pulse}
            />
          </div>
          <Button
            type="submit"
            form="workspace-settings"
            variant="primary"
            isDisabled={saveMutation.isPending || !dirty}
          >
            Save
          </Button>
        </div>

        {workspace.skippedFiles?.length ? (
          <SkippedFilesNotice
            files={workspace.skippedFiles}
            onOpenFile={props.onOpenFile}
            {...(props.onFixWithAgent
              ? { onFixWithAgent: props.onFixWithAgent }
              : {})}
          />
        ) : null}
        {writeLabel.tone === "pull_request" ? (
          <p className="mt-4 max-w-lg text-sm text-muted-foreground">
            {writeLabel.description}
          </p>
        ) : workspace.readOnlyReason ? (
          <div className="mt-4 max-w-lg">
            <InlineAlert
              variant="warning"
              title={
                workspace.writeStatus === "unknown"
                  ? "Could not check write access"
                  : "Read-only"
              }
              actions={
                workspace.writeStatus === "unknown" ? (
                  <Button
                    variant="secondary"
                    isDisabled={checkWriteMutation.isPending}
                    onPress={() => {
                      stall.restart()
                      checkWriteMutation.mutate()
                    }}
                  >
                    Check again
                  </Button>
                ) : !workspace.githubConnectionId ? (
                  // No connection reads the repository. Select it again
                  // after GitHub can see it, and the Workspace binds.
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setRelinkError(null)
                      setRelinkOpen(true)
                    }}
                  >
                    Select the repository again
                  </Button>
                ) : undefined
              }
            >
              {workspace.readOnlyReason}
              {workspace.writeStatus === "read_only"
                ? " After you fix it, reload this page. ctxpipe checks again at most once a minute."
                : null}
            </InlineAlert>
          </div>
        ) : null}
        {stall.stalled && writeCheckInFlight(workspace) ? (
          <div className="mt-4 max-w-lg">
            <InlineAlert
              variant="warning"
              title="Still checking write access"
              actions={
                <Button
                  variant="secondary"
                  isDisabled={checkWriteMutation.isPending}
                  onPress={() => {
                    stall.restart()
                    checkWriteMutation.mutate()
                  }}
                >
                  Check again
                </Button>
              }
            >
              The check takes longer than usual.
            </InlineAlert>
          </div>
        ) : null}
        {projectionLag ? (
          <p className="mt-3 max-w-lg text-sm text-muted-foreground">
            Answers still come from{" "}
            <code className="font-mono text-xs">{projectionLag}</code> until the
            new repository finishes loading.
          </p>
        ) : null}

        <div className="mt-8 flex flex-col gap-12">
          <SettingsGroup
            eyebrow="Status"
            landing={hash === WORKSPACE_UPGRADES_HASH}
          >
            <WorkspaceUpgrades
              orgSlug={orgSlug}
              workspaceSlug={workspace.slug}
              {...(props.onFixWithAgent
                ? { onFixWithAgent: props.onFixWithAgent }
                : {})}
            />
          </SettingsGroup>

          <SettingsGroup eyebrow="General">
            <form
              id="workspace-settings"
              className="grid items-start gap-6 @2xl:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                saveMutation.mutate()
              }}
            >
              <TextField
                label="Name"
                value={displayName}
                onChange={setDisplayName}
                description="Shown in the sidebar and to your team."
              />
              <TextField
                label="URL name"
                value={slug}
                onChange={setSlug}
                description="Used in this Workspace's web address. If you change it, old links stop working."
              />
            </form>
          </SettingsGroup>

          <SettingsGroup eyebrow="Repositories">
            <section>
              <h2 className="text-sm font-medium text-foreground">
                Context repository
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The GitHub repository where this Workspace keeps its files.
              </p>
              <div className="mt-3 grid gap-6 @2xl:grid-cols-2">
                <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                  <span
                    className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
                    aria-hidden
                  >
                    <IconGitBranch className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">
                      {repoTitle}
                    </p>
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
                    aria-label="Edit context repository"
                    onPress={() => {
                      setRelinkError(null)
                      setRelinkOpen(true)
                    }}
                  >
                    <IconPencil
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  </Button>
                </div>
              </div>
              <form
                className="mt-4 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (rootFolderChanged && rootFolderError(rootFolder) === null)
                    rootFolderMutation.mutate()
                }}
              >
                <WorkspaceRootFolderField
                  value={rootFolder}
                  onChange={setRootFolder}
                  isDisabled={rootFolderMutation.isPending}
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="secondary"
                    isPending={rootFolderMutation.isPending}
                    isDisabled={
                      !rootFolderChanged || rootFolderError(rootFolder) !== null
                    }
                  >
                    Save root folder
                  </Button>
                </div>
              </form>
            </section>
          </SettingsGroup>

          <SettingsGroup eyebrow="Sources">
            <WorkspaceSources
              orgSlug={orgSlug}
              workspaceSlug={workspace.slug}
              linkedRepositories={workspace.linkedRepositories}
            />
          </SettingsGroup>

          <SettingsGroup eyebrow="Danger zone">
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-white/[0.06] px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-foreground">
                  Delete this Workspace
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Deletes this Workspace and its conversations. Your GitHub
                  repository and its files stay.
                </p>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                onPress={() => {
                  setConfirmName("")
                  setDeleteOpen(true)
                }}
              >
                Delete Workspace
              </Button>
            </section>
          </SettingsGroup>
        </div>
      </div>

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
            Context repository
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            You keep this Workspace and its conversations. Files in the old
            repository stay where they are.
          </p>
          <div className="mt-5">
            <WorkspaceRepositoryPicker
              orgSlug={orgSlug}
              currentUrl={workspace.workspaceRepositoryUrl}
              currentRootPath={workspace.rootPath}
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
                to confirm. This deletes the Workspace and its conversations.
                Your GitHub repository stays.
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
