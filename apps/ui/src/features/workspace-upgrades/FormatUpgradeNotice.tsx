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
 * step: an owner or admin starts the upgrade or reviews it, a member asks
 * an admin. A failed upgrade shows its cause. One component, so the Workspace
 * page, Sources and the connect flows say the same thing.
 */
export function FormatUpgradeNotice(props: {
  orgSlug: string
  workspaceSlug: string
  context: FormatUpgradeContext
  items: readonly WorkspaceUpgradeItem[]
  /**
   * `banner`: one row with the actions on the right, for the top of the
   * Workspace page. The default is an inline alert.
   */
  appearance?: "alert" | "banner"
}) {
  const { orgSlug, workspaceSlug, context, items } = props
  const banner = props.appearance === "banner"
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
    : (item?.failureReason ?? "ctxpipe gives no reason.")
  // The yellow banner needs dark buttons; the failed banner is a red slab.
  const onYellow = banner && !failed
  const size = banner ? "default" : "sm"
  const actions = (
    <>
      {isAdmin === true && canStart ? (
        <Button
          variant="primary"
          size={size}
          className={onYellow ? bannerPrimary : undefined}
          isPending={start.isPending}
          onPress={() => start.mutate()}
        >
          Start the upgrade
        </Button>
      ) : null}
      {item?.status === "pr_open" && item.pullRequest ? (
        <Button
          variant={onYellow ? "primary" : "secondary"}
          size={size}
          className={onYellow ? bannerPrimary : undefined}
          href={item.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          Open pull request
        </Button>
      ) : null}
      <Button
        variant={banner ? "outline" : "secondary"}
        size={size}
        className={
          onYellow
            ? "border-zinc-950/40 text-zinc-950 outline-zinc-950 hover:border-zinc-950/60 hover:bg-zinc-950/10 pressed:bg-zinc-950/15 dark:border-zinc-950/40 dark:hover:border-zinc-950/60"
            : undefined
        }
        href={workspaceUpgradesHref(orgSlug, workspaceSlug)}
      >
        Review upgrade
      </Button>
      {isAdmin === false && (canStart || failed) ? (
        <span className="self-center text-xs">{MEMBER_ASK_ADMIN}</span>
      ) : null}
    </>
  )

  return (
    <InlineAlert
      variant={failed ? "error" : banner ? "attention" : "warning"}
      title={failed ? "The format upgrade failed" : copy.title}
      actions={actions}
      actionsPlacement={banner ? "end" : "below"}
    >
      {failed ? (
        <p>
          {cause} Press Review upgrade to see the step that failed and the fix.
          Sources and chat stay limited until the upgrade is merged.
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

/** The main action on the yellow banner: a dark button with a dark focus ring. */
const bannerPrimary =
  "border-transparent bg-zinc-950 text-amber-50 outline-zinc-950 hover:bg-zinc-800 pressed:bg-zinc-800"
