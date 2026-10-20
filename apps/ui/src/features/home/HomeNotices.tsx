import { IconAlertTriangle, IconCircleArrowUp } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ToastStack } from "@/components/ui/ToastStack"
import { workspaceUpgradesHref } from "@/features/workspace-upgrades/format-gate"
import {
  automaticUpgradesJobOptions,
  enableAutomaticWorkspaceUpgrades,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
} from "@/features/workspace-upgrades/queries"
import {
  MEMBER_ASK_ADMIN,
  upgradeToastLine,
} from "@/features/workspace-upgrades/upgrade-copy"
import {
  upgradeFailedItemPrompt,
  upgradeFailureCopy,
} from "@/features/workspace-upgrades/upgrade-failure"
import { useStartWorkspaceUpgrade } from "@/features/workspace-upgrades/use-start-upgrade"
import {
  skippedFileCopy,
  skippedFileFixable,
  skippedFilesFixPrompt,
} from "@/features/workspaces/skipped-files"
import type {
  Workspace,
  WorkspaceSkippedFile,
} from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import {
  withDismissedUpgrade,
  withoutDismissedUpgrades,
} from "@/lib/user-preferences"
import { useViewTransitionValue } from "@/lib/useViewTransitionValue"
import { cn } from "@/lib/utils"
import { useHomeNotices } from "./use-home-notices"

/**
 * One upgrade toast that waits for a click. An owner or admin gets Update
 * once, Always update and Dismiss. A member gets no button. `isAdmin` is
 * `null` while the role loads: the toast then shows neither the buttons nor
 * the member line.
 *
 * The toast has a title and one short line. The full description stays in
 * Workspace settings, Upgrades, which keeps the item and its state after the
 * toast goes.
 *
 * Always update answers at once. The server saves the setting and then
 * starts the upgrade, also when the user leaves Home. The toast follows the
 * save as progress only: a failed save shows its cause and a next step.
 */
function UpgradeToast(props: {
  orgSlug: string
  workspace: Pick<Workspace, "slug" | "displayName">
  item: WorkspaceUpgradeItem
  isAdmin: boolean | null
  onDismiss: () => void
}) {
  const { orgSlug, workspace, item, isAdmin, onDismiss } = props
  const queryClient = useQueryClient()
  const startOnce = useStartWorkspaceUpgrade(orgSlug, workspace.slug, item)
  const [savingJobId, setSavingJobId] = useState<string | null>(null)
  const always = useMutation({
    mutationFn: () => enableAutomaticWorkspaceUpgrades(orgSlug, workspace.slug),
    onSuccess: ({ jobId }) => setSavingJobId(jobId),
    onError: (error: Error) => {
      toast.error(error.message)
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: workspaceUpgradeKeys.pending(orgSlug),
      }),
  })
  const job = useQuery({
    ...automaticUpgradesJobOptions(orgSlug, workspace.slug, savingJobId ?? ""),
    enabled: savingJobId !== null,
  })
  const jobStatus = job.data?.status
  const saving =
    always.isPending ||
    (savingJobId !== null &&
      jobStatus !== "completed" &&
      jobStatus !== "failed" &&
      !job.isError)
  const saveFailed = jobStatus === "failed"
  const busy = startOnce.isPending || saving
  const title = `${workspace.displayName} upgrade available`
  // One Workspace can have two items: the buttons name the item too.
  const label = `${workspace.displayName}, ${item.title}`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <IconCircleArrowUp
        className="size-5 shrink-0 text-teal-300"
        stroke={1.25}
        aria-hidden
      />
      <div className="min-w-0 grow basis-64">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          {saving
            ? "ctx| saves the setting. It starts the upgrade when the setting is saved. You can leave this page."
            : saveFailed
              ? `ctx| could not save the setting. ${job.data?.failureReason ?? ""} Press Update once to start the upgrade now, or open Upgrades.`
              : jobStatus === "completed"
                ? "ctx| saved the setting. The upgrade starts in a moment."
                : upgradeToastLine(item)}
        </p>
        {isAdmin === false ? (
          <p className="text-xs text-muted-foreground">{MEMBER_ASK_ADMIN}</p>
        ) : null}
      </div>
      {isAdmin === true ? (
        <div className="flex flex-wrap gap-2 max-sm:w-full">
          <Button
            variant="primary"
            size="sm"
            isDisabled={busy}
            isPending={startOnce.isPending}
            onPress={() => startOnce.mutate()}
            aria-label={`Update once: ${label}`}
          >
            Update once
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={busy}
            isPending={saving}
            onPress={() => {
              setSavingJobId(null)
              always.mutate()
            }}
            aria-label={`Always update: ${label}`}
          >
            Always update
          </Button>
          {saveFailed ? (
            <OpenUpgradesButton
              orgSlug={orgSlug}
              workspaceSlug={workspace.slug}
              label={label}
            />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onPress={onDismiss}
            aria-label={`Dismiss: ${label}`}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function OpenUpgradesButton(props: {
  orgSlug: string
  workspaceSlug: string
  label: string
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      href={workspaceUpgradesHref(props.orgSlug, props.workspaceSlug)}
      aria-label={`Open Upgrades: ${props.label}`}
    >
      Open Upgrades
    </Button>
  )
}

/**
 * One failed upgrade. A failure with a repeatable cause fails again on a
 * retry, so the toast offers no Update once and no Always update (CTX-936).
 * It shows the cause and two next steps: ask the agent, or open Upgrades,
 * where the card names the step that failed and the fix. Every role sees it.
 */
function FailedUpgradeToast(props: {
  orgSlug: string
  workspace: Pick<Workspace, "id" | "slug" | "displayName">
  item: WorkspaceUpgradeItem
  onFixWithAgent: (workspaceId: string, prompt: string) => void
  onDismiss: () => void
}) {
  const { orgSlug, workspace, item, onFixWithAgent, onDismiss } = props
  const label = `${workspace.displayName}, ${item.title}`
  const cause = item.failure
    ? upgradeFailureCopy(item.failure).reason
    : (item.failureReason ?? "ctx| gives no reason.")
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <IconAlertTriangle
        className="size-5 shrink-0 text-red-300"
        stroke={1.25}
        aria-hidden
      />
      <div className="min-w-0 grow basis-64">
        <p className="text-sm font-medium">
          {workspace.displayName} upgrade failed
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {cause}
          {item.failure
            ? ` Details: ${item.failure.summary.replace(/[.!?]?$/, ".")}`
            : ""}{" "}
          A new try can fail the same way.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 max-sm:w-full">
        <Button
          variant="primary"
          size="sm"
          onPress={() =>
            onFixWithAgent(workspace.id, upgradeFailedItemPrompt(item))
          }
          aria-label={`Ask the agent: ${label}`}
        >
          Ask the agent
        </Button>
        <OpenUpgradesButton
          orgSlug={orgSlug}
          workspaceSlug={workspace.slug}
          label={label}
        />
        <Button
          variant="ghost"
          size="sm"
          onPress={onDismiss}
          aria-label={`Dismiss: ${label}`}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/**
 * One hydrate problem of a Workspace: the files that hydrate skipped, as
 * Workspace settings lists them. "Fix using agent" puts a prompt into the
 * Home composer for that Workspace. A skipped file that is not front matter
 * gets "Open settings", so the toast is never a dead end.
 */
function HydrateProblemToast(props: {
  orgSlug: string
  workspace: Pick<Workspace, "id" | "slug" | "displayName">
  skippedFiles: WorkspaceSkippedFile[]
  onFixWithAgent: (workspaceId: string, prompt: string) => void
  onDismiss: () => void
}) {
  const { orgSlug, workspace, skippedFiles, onFixWithAgent, onDismiss } = props
  const navigate = useNavigate()
  const [first] = skippedFiles
  const count = skippedFiles.length
  const more = count - 1
  const fixable = skippedFiles.filter(skippedFileFixable)
  // Hydrate lists files of Git first, so the first skip can hide the cause of
  // a legacy overlay file. Name that cause too.
  const overlay = skippedFiles.find((file) => file.source === "legacy-overlay")
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <IconAlertTriangle
        className="size-5 shrink-0 text-amber-300"
        stroke={1.25}
        aria-hidden
      />
      <div className="min-w-0 grow basis-64">
        <p className="text-sm font-medium">
          {workspace.displayName}: hydrate skipped {count}{" "}
          {count === 1 ? "file" : "files"}
        </p>
        {first ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-mono break-all">{first.path}</span>:{" "}
            {skippedFileCopy(first)}
            {more > 0
              ? `, and ${more} more ${more === 1 ? "file" : "files"}`
              : ""}
            . Chat, MCP, search, and the graph do not use{" "}
            {count === 1 ? "it" : "them"}.
          </p>
        ) : null}
        {overlay && overlay !== first ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-mono break-all">{overlay.path}</span>:{" "}
            {skippedFileCopy(overlay)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 max-sm:w-full">
        {fixable.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            onPress={() =>
              onFixWithAgent(workspace.id, skippedFilesFixPrompt(fixable))
            }
            aria-label={`Fix using agent: ${workspace.displayName}, skipped files`}
          >
            Fix using agent
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onPress={() =>
              void navigate({
                to: "/$orgSlug/ws/$workspaceSlug",
                params: { orgSlug, workspaceSlug: workspace.slug },
                search: { pane: "settings" },
              })
            }
            aria-label={`Open settings: ${workspace.displayName}`}
          >
            Open settings
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onPress={onDismiss}
          aria-label={`Dismiss: ${workspace.displayName}, skipped files`}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/**
 * The Home notices in one stack: hydrate problems (warning icon) first,
 * then the upgrade items that an owner or admin can start (upgrade icon).
 * One read of the org gives the upgrade items of all the Workspaces. A
 * dismissed notice stays hidden in this browser until it changes or the
 * user shows it again with {@link ShowNoticesButton}; Workspace settings
 * still lists it.
 */
export function HomeNoticeToasts(props: {
  orgSlug: string
  workspaces: Workspace[]
  /** Puts `prompt` into the Home composer of that Workspace. */
  onFixWithAgent: (workspaceId: string, prompt: string) => void
}) {
  const { orgSlug, workspaces, onFixWithAgent } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  const { shown, updatePreferences } = useHomeNotices(orgSlug, workspaces)
  // The stack holds no space without a notice. It comes and goes in a view
  // transition, so the composer moves with a transform and does not jump
  // (CTX-939). The last notices stay on screen until the transition ends.
  const visible = useViewTransitionValue(shown.length > 0)
  const last = useRef(shown)
  useEffect(() => {
    if (shown.length > 0) last.current = shown
  }, [shown])
  const notices = visible ? (shown.length > 0 ? shown : last.current) : []
  const toasts = notices.map((notice) => {
    const onDismiss = () =>
      updatePreferences((previous) =>
        withDismissedUpgrade(previous, notice.dismissKey),
      )
    return {
      id: notice.dismissKey,
      content:
        notice.kind === "problem" ? (
          <HydrateProblemToast
            orgSlug={orgSlug}
            workspace={notice.workspace}
            skippedFiles={notice.skippedFiles}
            onFixWithAgent={onFixWithAgent}
            onDismiss={onDismiss}
          />
        ) : notice.item.status === "failed" ? (
          <FailedUpgradeToast
            orgSlug={orgSlug}
            workspace={notice.workspace}
            item={notice.item}
            onFixWithAgent={onFixWithAgent}
            onDismiss={onDismiss}
          />
        ) : (
          <UpgradeToast
            orgSlug={orgSlug}
            workspace={notice.workspace}
            item={notice.item}
            isAdmin={isAdmin}
            onDismiss={onDismiss}
          />
        ),
    }
  })
  return (
    <ToastStack
      label="Workspace notices"
      className="[view-transition-name:home-notices]"
      toasts={toasts}
    />
  )
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/**
 * A small button at the top right of the Home composer. It shows when the
 * user dismissed notices: one icon for each notice type, each with its
 * count. A press shows the notices again.
 */
export function ShowNoticesButton(props: {
  orgSlug: string
  workspaces: Workspace[]
}) {
  const { dismissed, updatePreferences } = useHomeNotices(
    props.orgSlug,
    props.workspaces,
  )
  if (dismissed.length === 0) return null
  const upgrades = dismissed.filter((entry) => entry.kind === "upgrade").length
  const problems = dismissed.length - upgrades
  const counts = [
    upgrades > 0 ? plural(upgrades, "upgrade") : null,
    problems > 0 ? plural(problems, "problem") : null,
  ].filter(Boolean)
  return (
    <RACButton
      aria-label={`Show notices: ${counts.join(", ")}`}
      onPress={() =>
        updatePreferences((previous) =>
          withoutDismissedUpgrades(
            previous,
            dismissed.map((entry) => entry.dismissKey),
          ),
        )
      }
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-xs font-medium tabular-nums hover:bg-foreground/[0.06]",
        focusVisibleClassName,
      )}
    >
      {upgrades > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-teal-300">
          <IconCircleArrowUp aria-hidden className="size-4" stroke={1.5} />
          {upgrades}
        </span>
      ) : null}
      {problems > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-amber-300">
          <IconAlertTriangle aria-hidden className="size-4" stroke={1.5} />
          {problems}
        </span>
      ) : null}
    </RACButton>
  )
}
