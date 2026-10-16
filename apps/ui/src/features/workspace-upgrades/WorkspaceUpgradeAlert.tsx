import { useQueries } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useSelectNav } from "@/components/ShellLayoutContext"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import type { Workspace } from "@/features/workspaces/types"
import { useIsOrgAdmin, workspaceUpgradesOptions } from "./queries"
import { upgradeAlertLines, upgradeIsPending } from "./upgrade-copy"

/**
 * One alert for each existing Workspace that has an upgrade item to finish.
 * It shows nothing when no item is pending, while the lists load, and when a
 * list fails. A new org has no Workspace, so it gets no alert.
 */
export function WorkspaceUpgradeAlerts(props: {
  orgSlug: string
  workspaces: Workspace[]
}) {
  const { orgSlug, workspaces } = props
  const navigate = useNavigate()
  const selectNav = useSelectNav()
  const isAdmin = useIsOrgAdmin(orgSlug)
  const results = useQueries({
    queries: workspaces.map((workspace) =>
      workspaceUpgradesOptions(orgSlug, workspace.slug),
    ),
  })
  const alerts = workspaces.flatMap((workspace, index) => {
    const pending = results[index]?.data?.items.filter(upgradeIsPending) ?? []
    return pending.length > 0 ? [{ workspace, pending }] : []
  })
  if (alerts.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {alerts.map(({ workspace, pending }) => {
        const count = pending.length
        return (
          <InlineAlert
            key={workspace.id}
            variant="warning"
            title={`${workspace.displayName} has ${count} ${count === 1 ? "upgrade" : "upgrades"} to finish`}
            actions={
              <Button
                variant="secondary"
                onPress={() => {
                  selectNav({
                    orgSlug,
                    primary: "workspace",
                    workspaceSlug: workspace.slug,
                  })
                  void navigate({
                    to: "/$orgSlug/ws/$workspaceSlug",
                    params: { orgSlug, workspaceSlug: workspace.slug },
                    search: { pane: "settings" },
                  })
                }}
              >
                Review upgrades
              </Button>
            }
          >
            {upgradeAlertLines(pending, isAdmin).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </InlineAlert>
        )
      })}
    </div>
  )
}
