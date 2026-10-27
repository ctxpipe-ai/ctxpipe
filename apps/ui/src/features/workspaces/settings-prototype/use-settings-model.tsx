/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). The data and the actions
 * of Workspace settings, shared by the variants. The logic is copied from
 * WorkspaceSettingsPane and WorkspaceUpgrades, so that each variant keeps
 * every function and state of the current pane; only the layout changes.
 */
import { IconAlertCircle } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import {
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import { useExpiredCheckingKeys } from "@/features/workspace-upgrades/checking-format-clock"
import {
  checkWorkspaceUpgradesAndWait,
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  type WorkspaceUpgrades,
  workspaceUpgradeKeys,
  workspaceUpgradesOptions,
} from "@/features/workspace-upgrades/queries"
import {
  CHECKING_FORMAT_COPY,
  formatHealthLine,
  MEMBER_ASK_ADMIN,
  STATUS_INTRO,
  UPGRADE_WAITS_TAG,
  upgradeBlockedCopy,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeGroups,
  upgradeHeadline,
  upgradeHistoryLine,
  upgradeIsCheckingFormat,
  upgradeNotices,
  upgradeSpendLine,
  upgradeStartedMessage,
  upgradeStatusTag,
  upgradeWaitingCopy,
} from "@/features/workspace-upgrades/upgrade-copy"
import {
  upgradeFailureAllowsStartAgain,
  upgradeFailureCopy,
  upgradeFailurePrompt,
} from "@/features/workspace-upgrades/upgrade-failure"
import {
  upgradeCheckResult,
  type UpgradeProgress,
  upgradeProgress,
} from "@/features/workspace-upgrades/upgrade-progress"
import { useIsOrgAdmin } from "@/lib/org-member-role"

import {
  type IngestionItem,
  ingestionItemTitle,
  ingestionProgress,
  useWorkspaceIngesting,
  workspaceIngestionOptions,
} from "../ingestion"
import { writeCheckInFlight } from "../projection"
import {
  checkWorkspaceWriteAccess,
  deleteWorkspace,
  forgetDeletedWorkspace,
  updateWorkspace,
  workspaceKeys,
} from "../queries"
import { normalizeRootFolder, rootFolderError } from "../rootFolder"
import {
  skippedFileCopy,
  skippedFileFixable,
  skippedFilesFixPrompt,
} from "../skipped-files"
import type { WorkspaceDetail } from "../types"
import { workspaceDeleteNameMatches } from "../workspaceDeleteNameMatches"
import {
  type WorkspaceRepositoryChoice,
  WorkspaceRepositoryPicker,
} from "../WorkspaceRepositoryPicker"
import { useWriteCheckStall } from "../writeCheckStall"
import { writeStatusLabel } from "../writeStatusLabel"

export type Tone = "good" | "attention" | "error" | "neutral"

/** One upgrade, with everything that the current card shows and does. */
export type UpgradeView = {
  key: string
  item: WorkspaceUpgradeItem
  group: "needs_you" | "working" | "done"
  title: string
  description: string
  tag: { label: string; className: string; pulse?: boolean }
  progress: UpgradeProgress | null
  /** What ctxpipe waits for, or null. */
  waiting: string | null
  notices: ReturnType<typeof upgradeNotices>
  checkResult: string | null
  spend: string | null
  blocked: { title: string; body: string } | null
  note: string | null
  failure: {
    step: string | null
    reason: string
    summary: string
    action: string
    /** Set when the fix is in Connectors. */
    connectorsHref: string | null
    connectorsLabel: string | null
    /** Set when "Fix using agent" helps. */
    fixPrompt: string | null
    autoRetried: boolean
  } | null
  /** A failure with no failure class: only the reason. */
  failureReason: string | null
  pullRequest: { url: string; number: number | null } | null
  steps: WorkspaceUpgradeItem["steps"]
  canStart: boolean
  startLabel: string
  canCheck: boolean
  /** A member sees "Ask an admin" in place of the action. */
  memberAsk: string | null
  starting: boolean
  checking: boolean
  start: () => void
  check: () => void
}

/** The running work of one source: its runs grouped, the most advanced first. */
export type SourceActivity = {
  key: string
  title: string
  kind: IngestionItem["kind"]
  runs: IngestionItem[]
  lead: IngestionItem
  progress: UpgradeProgress
  /** The start of the oldest run. */
  since: string
}

/** A thing that needs the user, from any part of the page. */
export type AttentionItem = {
  id: string
  tone: "attention" | "error"
  title: string
  body: string
  part: "upgrades" | "access" | "graph"
}

const STAGE_RANK: Record<string, number> = {
  publishing: 6,
  ingesting: 5,
  indexing: 4,
  planning: 3,
  waiting: 2,
  queued: 1,
}

function groupActivity(items: IngestionItem[]): SourceActivity[] {
  const groups = new Map<string, IngestionItem[]>()
  for (const item of items) {
    if (item.kind === "hydrate") continue
    const title = ingestionItemTitle(item)
    groups.set(title, [...(groups.get(title) ?? []), item])
  }
  return [...groups].map(([title, runs]) => {
    const sorted = [...runs].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )
    const lead =
      [...sorted].sort(
        (a, b) =>
          (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0),
      )[0] ?? (sorted[0] as IngestionItem)
    return {
      key: title,
      title,
      kind: lead.kind,
      runs: sorted,
      lead,
      progress: ingestionProgress(lead),
      since: sorted[0]?.startedAt ?? lead.startedAt,
    }
  })
}

export function useSettingsModel(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  onOpenFile: (path: string) => void
  onFixWithAgent?: (prompt: string) => void
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isAdmin = useIsOrgAdmin(orgSlug)

  // General
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const generalDirty =
    displayName.trim() !== workspace.displayName ||
    slug.trim() !== workspace.slug

  // Repository
  const [rootFolder, setRootFolder] = useState(workspace.rootPath ?? "")
  const rootFolderChanged =
    normalizeRootFolder(rootFolder) !== (workspace.rootPath ?? "")
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)

  // Delete
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
      updateWorkspace(orgSlug, workspace.slug, { displayName, slug }),
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
    onError: (error: Error) => toast.error(error.message),
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
    onError: (error: Error) => toast.error(error.message),
  })

  const checkWriteMutation = useMutation({
    mutationFn: () => checkWorkspaceWriteAccess(orgSlug, workspace.slug),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(error.message),
  })

  const deletedRef = useRef(false)
  useEffect(
    () => () => {
      if (!deletedRef.current) return
      setTimeout(() => {
        queryClient.removeQueries({
          predicate: ({ queryKey: [, org, slugKey] }) =>
            org === orgSlug && slugKey === workspace.slug,
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
      void navigate({ to: "/$orgSlug", params: { orgSlug }, replace: true })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // Write access
  const stall = useWriteCheckStall()
  const write = writeStatusLabel(
    workspace.writeStatus,
    workspace.readOnlyReason,
    workspace.conversationWritable,
  )

  // Upgrades
  const upgradesQuery = useQuery(
    workspaceUpgradesOptions(orgSlug, workspace.slug),
  )
  const upgradesData: WorkspaceUpgrades | undefined = upgradesQuery.data
  const formatVersion = upgradesData?.formatVersion ?? null
  const upgradeItems = upgradesData?.items ?? []
  const expired = useExpiredCheckingKeys(
    `${orgSlug}/${workspace.slug}`,
    upgradeItems,
    formatVersion,
  )
  const { lists, groupOf, count } = upgradeGroups(
    upgradeItems,
    formatVersion,
    expired,
  )
  const ingestingLabel = useWorkspaceIngesting(orgSlug, workspace.slug)
  const headline =
    upgradesData &&
    upgradeHeadline({
      count,
      formatVersion,
      codeFormat: upgradesData.codeFormat,
      ingesting: ingestingLabel,
    })

  const startMutation = useMutation({
    mutationFn: (item: WorkspaceUpgradeItem) =>
      startWorkspaceUpgrade(orgSlug, workspace.slug, item.key),
    onSuccess: (_result, item) => toast.success(upgradeStartedMessage(item)),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspace.slug),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.pending(orgSlug),
        }),
      ]),
  })
  const checkMutation = useMutation({
    mutationFn: (item: WorkspaceUpgradeItem) =>
      checkWorkspaceUpgradesAndWait(
        queryClient,
        orgSlug,
        workspace.slug,
        item.key,
      ),
    onSuccess: (result, item) => {
      if (result === "pending") {
        toast.message(
          "ctxpipe has not finished the check yet. This page shows the result when it does.",
        )
        return
      }
      const found = queryClient
        .getQueryData<WorkspaceUpgrades>(
          workspaceUpgradeKeys.list(orgSlug, workspace.slug),
        )
        ?.items.find(({ key }) => key === item.key)
      toast.success(
        (found && upgradeCheckResult(found, formatVersion)) ??
          "ctxpipe checked the Workspace. The upgrade is not pending any more.",
      )
    },
    onError: (error: Error) =>
      toast.error(
        `${error.message.replace(/\.$/, "")}. Press Check again to try again.`,
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspace.slug),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.pending(orgSlug),
        }),
      ]),
  })

  const describeUpgrade = (item: WorkspaceUpgradeItem): UpgradeView => {
    const group = groupOf.get(item.key) ?? "needs_you"
    const fv = expired.has(item.key) ? null : formatVersion
    const checkingFormat = upgradeIsCheckingFormat(item, fv)
    const blockedWaits =
      group === "working" && item.status === "blocked" && !checkingFormat
    const waiting = checkingFormat
      ? CHECKING_FORMAT_COPY
      : blockedWaits
        ? item.blockedReason === "needs_format"
          ? "This starts after ctxpipe reads the format upgrade above."
          : upgradeBlockedCopy(item).body
        : upgradeWaitingCopy(item)
    const failureCopy = item.failure ? upgradeFailureCopy(item.failure) : null
    const canStart =
      upgradeCanStart(item) &&
      isAdmin === true &&
      upgradeFailureAllowsStartAgain(item)
    const canCheck = upgradeCanCheck(item) && isAdmin === true
    return {
      key: item.key,
      item,
      group,
      title: item.title,
      description:
        item.kind === "reingest"
          ? item.description
          : `${item.description} Format ${item.fromFormat} to format ${item.targetFormat}. ctxpipe opens one pull request. Nothing changes until you merge it.`,
      tag: blockedWaits ? UPGRADE_WAITS_TAG : upgradeStatusTag(item, fv),
      progress: upgradeProgress(item),
      waiting: waiting ?? null,
      notices: upgradeNotices(item),
      checkResult: upgradeCheckResult(item, formatVersion),
      spend: upgradeSpendLine(item),
      blocked:
        !checkingFormat && !blockedWaits && item.status === "blocked"
          ? upgradeBlockedCopy(item)
          : null,
      note: item.note,
      failure:
        item.status === "failed" && item.failure && failureCopy
          ? {
              step: failureCopy.step,
              reason: failureCopy.reason,
              summary: item.failure.summary,
              action: failureCopy.action,
              connectorsHref:
                failureCopy.link === "connectors"
                  ? `/${orgSlug}/connectors`
                  : null,
              connectorsLabel: failureCopy.linkLabel ?? null,
              fixPrompt:
                failureCopy.agent && props.onFixWithAgent
                  ? upgradeFailurePrompt(item, item.failure)
                  : null,
              autoRetried: item.autoRetried,
            }
          : null,
      failureReason:
        item.status === "failed" && !item.failure
          ? (item.failureReason ?? "ctxpipe gives no reason.")
          : null,
      pullRequest: item.pullRequest
        ? { url: item.pullRequest.url, number: item.pullRequest.number }
        : null,
      steps: item.steps,
      canStart,
      startLabel: item.status === "failed" ? "Start again" : "Start",
      canCheck,
      memberAsk:
        (upgradeCanStart(item) ||
          (item.status === "blocked" && upgradeCanCheck(item))) &&
        isAdmin === false
          ? MEMBER_ASK_ADMIN
          : null,
      starting:
        startMutation.isPending && startMutation.variables?.key === item.key,
      checking:
        checkMutation.isPending && checkMutation.variables?.key === item.key,
      start: () => startMutation.mutate(item),
      check: () => checkMutation.mutate(item),
    }
  }

  // Running work
  const ingestionQuery = useQuery({
    ...workspaceIngestionOptions(orgSlug, workspace.slug),
    enabled: ingestingLabel !== null,
  })
  const ingestionItems = ingestionQuery.data ?? []
  const sources = groupActivity(ingestionItems)
  const hydrateRun = ingestionItems.find((item) => item.kind === "hydrate")

  // Graph and files
  const skippedFiles = (workspace.skippedFiles ?? []).map((file) => ({
    path: file.path,
    text: skippedFileCopy(file),
    /** A legacy-overlay file comes from the database, not from Git: no file to open. */
    canOpen: file.source !== "legacy-overlay",
    fixPrompt:
      skippedFileFixable(file) && props.onFixWithAgent
        ? skippedFilesFixPrompt([file])
        : null,
  }))
  const projectionLag =
    workspace.activeProjectionUrl &&
    workspace.activeProjectionUrl !== workspace.workspaceRepositoryUrl
      ? workspace.activeProjectionUrl
      : null

  const attention: AttentionItem[] = [
    ...lists.needs_you.map((item): AttentionItem => ({
      id: `upgrade:${item.key}`,
      tone: item.status === "failed" ? "error" : "attention",
      title: item.title,
      body: upgradeStatusTag(item, formatVersion).label,
      part: "upgrades",
    })),
    ...(write.tone === "read_only" || write.tone === "check_failed"
      ? [
          {
            id: "access",
            tone: "attention" as const,
            title:
              write.tone === "check_failed"
                ? "Could not check write access"
                : "ctxpipe cannot push to the repository",
            body: write.description,
            part: "access" as const,
          },
        ]
      : []),
    ...(workspace.hydrateStatus === "failed"
      ? [
          {
            id: "graph",
            tone: "error" as const,
            title: "The knowledge graph did not load",
            body: workspace.hydrateError ?? "ctxpipe gives no reason.",
            part: "graph" as const,
          },
        ]
      : []),
    ...(skippedFiles.length
      ? [
          {
            id: "skipped",
            tone: "attention" as const,
            title: `${skippedFiles.length} knowledge ${skippedFiles.length === 1 ? "file was" : "files were"} skipped`,
            body: "ctxpipe could not read them, so answers do not use them.",
            part: "graph" as const,
          },
        ]
      : []),
  ]

  const repoTitle =
    githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
    workspace.workspaceRepositoryUrl

  const dialogs: ReactNode = (
    <>
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
                  )
                    return
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
    </>
  )

  return {
    orgSlug,
    workspace,
    isAdmin,
    attention,
    /** Mount once in each variant: the relink and delete dialogs. */
    dialogs,
    general: {
      displayName,
      setDisplayName,
      slug,
      setSlug,
      dirty: generalDirty,
      saving: saveMutation.isPending,
      save: () => saveMutation.mutate(),
      /** Resolves on success, rejects on failure: a dialog closes only on success. */
      saveAsync: () => saveMutation.mutateAsync(),
      reset: () => {
        setDisplayName(workspace.displayName)
        setSlug(workspace.slug)
      },
    },
    repository: {
      title: repoTitle,
      url: workspace.workspaceRepositoryUrl,
      webUrl: githubWebUrl(workspace.workspaceRepositoryUrl),
      rootPath: workspace.rootPath ?? "",
      rootFolder,
      setRootFolder,
      rootFolderChanged,
      rootFolderError: rootFolderError(rootFolder),
      savingRootFolder: rootFolderMutation.isPending,
      saveRootFolder: () => {
        if (rootFolderChanged && rootFolderError(rootFolder) === null)
          rootFolderMutation.mutate()
      },
      openRelink: () => {
        setRelinkError(null)
        setRelinkOpen(true)
      },
      linkedRepositories: workspace.linkedRepositories,
    },
    access: {
      ...write,
      writeStatus: workspace.writeStatus,
      readOnlyReason: workspace.readOnlyReason,
      /** "Check again" helps when the check failed or stalls. */
      canCheckAgain:
        workspace.writeStatus === "unknown" ||
        (stall.stalled && writeCheckInFlight(workspace)),
      stalled: stall.stalled && writeCheckInFlight(workspace),
      /** No GitHub connection reads the repository: select it again. */
      needsRelink:
        Boolean(workspace.readOnlyReason) &&
        workspace.writeStatus !== "unknown" &&
        !workspace.githubConnectionId,
      checking: checkWriteMutation.isPending,
      checkAgain: () => {
        stall.restart()
        checkWriteMutation.mutate()
      },
    },
    graph: {
      status: workspace.hydrateStatus,
      error: workspace.hydrateError,
      projectionLag,
      skippedFiles,
      openFile: props.onOpenFile,
      fixWithAgent: props.onFixWithAgent,
      indexingRun: hydrateRun ?? null,
    },
    upgrades: {
      status: upgradesQuery.isPending
        ? ("loading" as const)
        : upgradesQuery.isError
          ? ("error" as const)
          : ("ready" as const),
      retry: () => void upgradesQuery.refetch(),
      headline: headline ?? null,
      intro: count.needs_you + count.working > 0 ? STATUS_INTRO : null,
      formatLine: upgradesData
        ? formatHealthLine(upgradesData.formatVersion, upgradesData.codeFormat)
        : null,
      needsYou: lists.needs_you.map(describeUpgrade),
      working: lists.working.map(describeUpgrade),
      done: lists.done.map(describeUpgrade),
      historyLine: lists.done.length ? upgradeHistoryLine(lists.done) : null,
    },
    activity: {
      status: ingestionQuery.isError
        ? ("error" as const)
        : ingestingLabel !== null && ingestionQuery.isPending
          ? ("loading" as const)
          : ("ready" as const),
      retry: () => void ingestionQuery.refetch(),
      label: ingestingLabel,
      sources,
      hydrate: hydrateRun ?? null,
    },
    openDelete: () => {
      setConfirmName("")
      setDeleteOpen(true)
    },
  }
}

export type SettingsModel = ReturnType<typeof useSettingsModel>
