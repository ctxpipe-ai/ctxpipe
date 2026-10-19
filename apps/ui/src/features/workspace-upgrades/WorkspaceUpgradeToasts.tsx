import { IconInfoCircle } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ToastStack } from "@/components/ui/ToastStack"
import type { Workspace } from "@/features/workspaces/types"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import {
  upgradeDismissKey,
  useUserPreferences,
  withDismissedUpgrade,
} from "@/lib/user-preferences"
import {
  enableAutomaticWorkspaceUpgrades,
  pendingWorkspaceUpgradesOptions,
  startWorkspaceUpgrade,
  type WorkspaceUpgradeItem,
  workspaceUpgradeKeys,
} from "./queries"
import { upgradeCanStart, upgradeStartedMessage } from "./upgrade-copy"

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
    <div className="flex gap-3 p-3">
      <IconInfoCircle
        className="mt-0.5 size-4 shrink-0 text-teal-300"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {item.status === "failed" && item.failureReason
            ? item.failureReason
            : item.description}
        </p>
        {isAdmin === true ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              isDisabled={start.isPending}
              isPending={start.isPending && start.variables === false}
              onPress={() => start.mutate(false)}
              aria-label={`Update once: ${label}`}
            >
              Update once
            </Button>
            <Button
              variant="primary"
              isDisabled={start.isPending}
              isPending={start.isPending && start.variables === true}
              onPress={() => start.mutate(true)}
              aria-label={`Always update: ${label}`}
            >
              Always update
            </Button>
            <Button
              variant="ghost"
              isDisabled={start.isPending}
              onPress={onDismiss}
              aria-label={`Dismiss: ${label}`}
            >
              Dismiss
            </Button>
          </div>
        ) : isAdmin === false ? (
          <p className="mt-2 text-xs text-muted-foreground">
            An owner or admin can start it.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The Home toasts (CTX-894): one for each upgrade item that an owner or
 * admin can start, in a stack. One read of the org gives the items of all
 * the Workspaces. A dismissed item stays hidden in this browser until its
 * status changes; Workspace settings > Upgrades still lists it.
 */
export function WorkspaceUpgradeToasts(props: {
  orgSlug: string
  workspaces: Workspace[]
}) {
  const { orgSlug, workspaces } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  const { data } = useQuery(pendingWorkspaceUpgradesOptions(orgSlug))
  const [preferences, updatePreferences] = useUserPreferences()
  const toasts = workspaces.flatMap((workspace) =>
    (data?.find((entry) => entry.workspaceSlug === workspace.slug)?.items ?? [])
      .filter(upgradeCanStart)
      .flatMap((item) => {
        const dismissKey = upgradeDismissKey({
          orgSlug,
          workspaceSlug: workspace.slug,
          key: item.key,
          status: item.status,
        })
        if (preferences.dismissedUpgrades.includes(dismissKey)) return []
        return [
          {
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
          },
        ]
      }),
  )
  return <ToastStack label="Workspace upgrades" toasts={toasts} />
}
