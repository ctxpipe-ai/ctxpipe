import { IconCircleArrowUp } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button as RACButton } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ToastStack } from "@/components/ui/ToastStack"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import {
  withDismissedUpgrade,
  withoutDismissedUpgrades,
} from "@/lib/user-preferences"
import { cn } from "@/lib/utils"
import {
  enableAutomaticWorkspaceUpgrades,
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
} from "./queries"
import { upgradeStartedMessage } from "./upgrade-copy"
import { useUpgradeToastItems } from "./use-upgrade-toast-items"

/**
 * One toast. An owner or admin gets Update once, Always update and Dismiss.
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
        className="size-4 shrink-0 text-teal-300"
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
            variant="quiet"
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
 * The Home toasts (CTX-894): one for each upgrade item that an owner or
 * admin can start, in a stack. One read of the org gives the items of all
 * the Workspaces. A dismissed item stays hidden in this browser until its
 * status changes or the user shows it again with {@link ShowUpgradesButton};
 * Workspace settings > Upgrades still lists it.
 */
export function WorkspaceUpgradeToasts(props: {
  orgSlug: string
  workspaces: Workspace[]
}) {
  const { orgSlug, workspaces } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  const { shown, updatePreferences } = useUpgradeToastItems(orgSlug, workspaces)
  const toasts = shown.map(({ dismissKey, workspace, item }) => ({
    id: dismissKey,
    content: (
      <UpgradeToast
        orgSlug={orgSlug}
        workspace={workspace}
        item={item}
        isAdmin={isAdmin}
        onDismiss={() =>
          updatePreferences((previous) =>
            withDismissedUpgrade(previous, dismissKey),
          )
        }
      />
    ),
  }))
  return <ToastStack label="Workspace upgrades" toasts={toasts} />
}

/**
 * A small icon button at the top right of the Home composer. It shows when
 * the user dismissed upgrade toasts; a press shows them again.
 */
export function ShowUpgradesButton(props: {
  orgSlug: string
  workspaces: Workspace[]
}) {
  const { dismissed, updatePreferences } = useUpgradeToastItems(
    props.orgSlug,
    props.workspaces,
  )
  if (dismissed.length === 0) return null
  return (
    <RACButton
      aria-label={`Show upgrades (${dismissed.length})`}
      onPress={() =>
        updatePreferences((previous) =>
          withoutDismissedUpgrades(
            previous,
            dismissed.map((entry) => entry.dismissKey),
          ),
        )
      }
      className={cn(
        "relative inline-flex size-7 items-center justify-center rounded-md text-teal-300 hover:bg-foreground/[0.06]",
        focusVisibleClassName,
      )}
    >
      <IconCircleArrowUp aria-hidden className="size-4" />
      {dismissed.length > 1 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-teal-300 px-1 text-center text-[10px] leading-4 font-medium text-zinc-950"
        >
          {dismissed.length}
        </span>
      ) : null}
    </RACButton>
  )
}
