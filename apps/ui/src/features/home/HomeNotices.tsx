import { IconAlertTriangle, IconCircleArrowUp } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button as RACButton } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ToastStack } from "@/components/ui/ToastStack"
import {
  enableAutomaticWorkspaceUpgrades,
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
} from "@/features/workspace-upgrades/queries"
import { upgradeStartedMessage } from "@/features/workspace-upgrades/upgrade-copy"
import {
  skippedFilesFixPrompt,
  skippedReasonCopy,
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
import { cn } from "@/lib/utils"
import { useHomeNotices } from "./use-home-notices"

/**
 * One upgrade toast. An owner or admin gets Update once, Always update and Dismiss.
 * A member gets no button. `isAdmin` is `null` while the role loads: the
 * toast then shows neither the buttons nor the member line.
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
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceUpgradeKeys.pending(orgSlug),
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceUpgradeKeys.list(orgSlug, workspace.slug),
      }),
    ])
  const start = useMutation({
    mutationFn: async (always: boolean) => {
      if (always)
        await enableAutomaticWorkspaceUpgrades(orgSlug, workspace.slug)
      return startWorkspaceUpgrade(orgSlug, workspace.slug, item.key)
    },
    onSuccess: (_, always) => {
      toast.success(
        always
          ? `ctx| now starts each upgrade of ${workspace.displayName}. ${upgradeStartedMessage(item)}`
          : upgradeStartedMessage(item),
      )
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
    onSettled: refresh,
  })
  const title = `${workspace.displayName} ${item.status === "failed" ? "upgrade failed" : "upgrade available"}`
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
          {item.status === "failed" && item.failureReason
            ? item.failureReason
            : item.description}
        </p>
        {isAdmin === false ? (
          <p className="text-xs text-muted-foreground">
            An owner or admin can start it.
          </p>
        ) : null}
      </div>
      {isAdmin === true ? (
        <div className="flex flex-wrap gap-2 max-sm:w-full">
          <Button
            variant="primary"
            size="sm"
            isDisabled={start.isPending}
            isPending={start.isPending && start.variables === false}
            onPress={() => start.mutate(false)}
            aria-label={`Update once: ${label}`}
          >
            Update once
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={start.isPending}
            isPending={start.isPending && start.variables === true}
            onPress={() => start.mutate(true)}
            aria-label={`Always update: ${label}`}
          >
            Always update
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isDisabled={start.isPending}
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
  const fixable = skippedFiles.filter((file) => file.reason === "malformed")
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
            {skippedReasonCopy[first.reason]}
            {more > 0 ? `, and ${more} more ${more === 1 ? "file" : "files"}` : ""}
            . Chat, MCP, search, and the graph do not use{" "}
            {count === 1 ? "it" : "them"}.
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
  const toasts = shown.map((notice) => {
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
      slotClassName="h-53 sm:h-28"
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
