import {
  IconAlertTriangle,
  IconCircleCheck,
  IconGitBranch,
  IconGitPullRequest,
} from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import {
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

import { writeCheckInFlight } from "../projection"
import {
  checkWorkspaceWriteAccess,
  updateWorkspace,
  workspaceKeys,
} from "../queries"
import { normalizeRootFolder, rootFolderError } from "../rootFolder"
import type { WorkspaceDetail } from "../types"
import {
  type WorkspaceRepositoryChoice,
  WorkspaceRepositoryPicker,
} from "../WorkspaceRepositoryPicker"
import { WorkspaceRootFolderField } from "../WorkspaceRootFolderField"
import { useWriteCheckStall } from "../writeCheckStall"
import { writeStatusLabel } from "../writeStatusLabel"
import { SettingsCard } from "./SettingsCard"

/** The write access of a Workspace: does it need the user, and how. */
export function useWriteAccess(workspace: WorkspaceDetail) {
  const stall = useWriteCheckStall()
  const label = writeStatusLabel(
    workspace.writeStatus,
    workspace.readOnlyReason,
    workspace.conversationWritable,
  )
  const stalled = stall.stalled && writeCheckInFlight(workspace)
  return {
    ...label,
    stalled,
    restartStall: stall.restart,
    needsYou:
      label.tone === "read_only" || label.tone === "check_failed" || stalled,
  }
}

/**
 * The repository of the Workspace: which one, can ctxpipe push to it, and
 * the root folder. Today's relink dialog changes the repository.
 */
export function RepositoryCard(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const queryClient = useQueryClient()
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [rootFolder, setRootFolder] = useState(workspace.rootPath ?? "")
  const rootFolderChanged =
    normalizeRootFolder(rootFolder) !== (workspace.rootPath ?? "")
  const canSaveRootFolder =
    rootFolderChanged && rootFolderError(rootFolder) === null
  const access = useWriteAccess(workspace)

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.list(orgSlug),
    })
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
    })
  }

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

  const openRelink = () => {
    setRelinkError(null)
    setRelinkOpen(true)
  }
  const repoTitle =
    githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
    workspace.workspaceRepositoryUrl
  const repoWebUrl = githubWebUrl(workspace.workspaceRepositoryUrl)

  return (
    <SettingsCard
      part="repository"
      title="Repository"
      description="The GitHub repository where this Workspace keeps its files."
      needsYou={access.needsYou}
      footer={
        <Button
          type="submit"
          form="workspace-settings-root-folder"
          variant="primary"
          aria-label="Save root folder"
          isPending={rootFolderMutation.isPending}
          isDisabled={!canSaveRootFolder}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
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
                className={cn(
                  "block truncate rounded-md text-xs text-muted-foreground hover:text-foreground",
                  focusVisibleClassName,
                )}
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
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-label="Change the context repository"
            onPress={openRelink}
          >
            Change
          </Button>
        </div>

        <WriteAccessLine
          access={access}
          writeStatus={workspace.writeStatus}
          needsRelink={
            access.tone === "read_only" &&
            Boolean(workspace.readOnlyReason) &&
            !workspace.githubConnectionId
          }
          checking={checkWriteMutation.isPending}
          onCheckAgain={() => {
            access.restartStall()
            checkWriteMutation.mutate()
          }}
          onRelink={openRelink}
        />

        <form
          id="workspace-settings-root-folder"
          className="max-w-md"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSaveRootFolder) rootFolderMutation.mutate()
          }}
        >
          <WorkspaceRootFolderField
            value={rootFolder}
            onChange={setRootFolder}
            isDisabled={rootFolderMutation.isPending}
          />
        </form>
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
    </SettingsCard>
  )
}

/**
 * Write access in one line, with its fix next to it. A problem has the title
 * and the facts of the alert that it replaces, and it is announced. "Check
 * again" shows only where a new check can help: a check that failed or
 * stalls. A read-only Workspace is checked again by itself.
 */
function WriteAccessLine(props: {
  access: ReturnType<typeof useWriteAccess>
  writeStatus: string
  /** No GitHub connection reads the repository: select it again. */
  needsRelink: boolean
  checking: boolean
  onCheckAgain: () => void
  onRelink: () => void
}) {
  const { access } = props
  const problem = access.needsYou
  const title = access.stalled
    ? "Still checking write access"
    : access.tone === "check_failed"
      ? "Could not check write access"
      : access.tone === "read_only"
        ? "Read-only"
        : access.tone === "pull_request"
          ? "Changes by pull request"
          : null
  const text = access.stalled
    ? "The check takes longer than usual."
    : access.tone === "writable"
      ? "ctxpipe can push to this repository."
      : access.tone === "pending"
        ? "ctxpipe checks write access now."
        : access.description
  const fix = props.needsRelink ? (
    <Button variant="secondary" size="sm" onPress={props.onRelink}>
      Select the repository again
    </Button>
  ) : props.writeStatus === "unknown" &&
    (access.tone === "check_failed" || access.stalled) ? (
    <Button
      variant="secondary"
      size="sm"
      isPending={props.checking}
      onPress={props.onCheckAgain}
    >
      Check again
    </Button>
  ) : null
  return (
    <div
      role={problem ? "alert" : undefined}
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md px-3 py-2.5",
        problem ? "bg-amber-400/[0.06]" : "bg-white/[0.03]",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        {problem ? (
          <IconAlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-300"
            aria-hidden
          />
        ) : access.tone === "pull_request" ? (
          <IconGitPullRequest
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : access.tone === "pending" ? (
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center"
          >
            <span className="ctx-status-pulse size-1.5 rounded-full bg-zinc-400" />
          </span>
        ) : (
          <IconCircleCheck
            className="mt-0.5 size-4 shrink-0 text-teal-300"
            aria-hidden
          />
        )}
        <p
          className={cn(
            "text-sm",
            problem ? "text-amber-50" : "text-muted-foreground",
          )}
        >
          <span className="sr-only">Write access: </span>
          {title ? (
            <span
              className={cn(
                "block",
                problem ? "font-medium" : "text-foreground",
              )}
            >
              {title}
            </span>
          ) : null}
          <span>{text}</span>
          {access.tone === "read_only" ? (
            <span className="text-amber-100/70">
              {props.needsRelink
                ? " After GitHub can see the repository, select it again."
                : props.writeStatus === "read_only"
                  ? " After you fix it, reload this page. ctxpipe checks again at most once a minute."
                  : null}
            </span>
          ) : null}
        </p>
      </div>
      {fix}
    </div>
  )
}
