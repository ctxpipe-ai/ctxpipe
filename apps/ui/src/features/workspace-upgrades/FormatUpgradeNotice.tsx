import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import {
  type FormatUpgradeContext,
  formatUpgradeCopy,
  formatUpgradeStatusLine,
  pendingFormatUpgrade,
  workspaceUpgradesHref,
} from "./format-gate"
import type { WorkspaceUpgradeItem } from "./queries"
import { MEMBER_ASK_ADMIN } from "./upgrade-copy"
import { upgradeFailureCopy } from "./upgrade-failure"
import { useStartWorkspaceUpgrade } from "./use-start-upgrade"

/**
 * The notice of a Workspace that needs the format upgrade (CTX-932, CTX-934,
 * CTX-935). It says what is missing, where the upgrade stands, and the next
 * step: an owner or admin starts the upgrade or opens Upgrades, a member asks
 * an admin. A failed upgrade shows its cause. One component, so the Workspace
 * page, Sources and the connect flows say the same thing.
 */
export function FormatUpgradeNotice(props: {
  orgSlug: string
  workspaceSlug: string
  context: FormatUpgradeContext
  items: readonly WorkspaceUpgradeItem[]
}) {
  const { orgSlug, workspaceSlug, context, items } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  const item = pendingFormatUpgrade(items)
  const start = useStartWorkspaceUpgrade(
    orgSlug,
    workspaceSlug,
    item ?? { key: "", kind: "format" },
  )
  const copy = formatUpgradeCopy(context)
  const failed = item?.status === "failed"
  const canStart = item?.status === "awaiting_operator"
  const cause = item?.failure
    ? upgradeFailureCopy(item.failure).reason
    : (item?.failureReason ?? "ctx| gives no reason.")
  return (
    <InlineAlert
      variant={failed ? "error" : "warning"}
      title={failed ? "The format upgrade failed" : copy.title}
      actions={
        <>
          {isAdmin === true && canStart ? (
            <Button
              variant="primary"
              size="sm"
              isPending={start.isPending}
              onPress={() => start.mutate()}
            >
              Start the upgrade
            </Button>
          ) : null}
          {item?.status === "pr_open" && item.pullRequest ? (
            <Button
              variant="secondary"
              size="sm"
              href={item.pullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              Open pull request
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            href={workspaceUpgradesHref(orgSlug, workspaceSlug)}
          >
            Open Upgrades
          </Button>
          {isAdmin === false && (canStart || failed) ? (
            <span className="self-center text-xs">{MEMBER_ASK_ADMIN}</span>
          ) : null}
        </>
      }
    >
      {failed ? (
        <p>
          {cause} Open Upgrades to see the step that failed and the fix. Sources
          and chat stay limited until the upgrade is merged.
        </p>
      ) : (
        <>
          <p>{copy.body}</p>
          {formatUpgradeStatusLine(item) ? (
            <p className="mt-1">{formatUpgradeStatusLine(item)}</p>
          ) : null}
        </>
      )}
    </InlineAlert>
  )
}
