import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react"

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
  const actions = (
    <>
      {isAdmin === true && canStart ? (
        <Button
          variant="primary"
          size={banner ? "default" : "sm"}
          className={banner ? bannerPrimary : undefined}
          isPending={start.isPending}
          onPress={() => start.mutate()}
        >
          Start the upgrade
        </Button>
      ) : null}
      {item?.status === "pr_open" && item.pullRequest ? (
        <Button
          variant={banner ? "primary" : "secondary"}
          size={banner ? "default" : "sm"}
          className={banner ? bannerPrimary : undefined}
          href={item.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          Open pull request
        </Button>
      ) : null}
      <Button
        variant={banner ? "outline" : "secondary"}
        size={banner ? "default" : "sm"}
        className={
          banner && !failed
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
  const message = failed ? (
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
  )
  const title = failed ? "The format upgrade failed" : copy.title

  if (banner) {
    // A yellow slab with dark text: 13.8:1 for the title and 10.4:1 for the
    // body (WCAG AA). A failed upgrade keeps the dark red slab.
    const Icon = failed ? IconAlertCircle : IconAlertTriangle
    return (
      <div
        role="alert"
        className={`flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md px-4 py-3 ${
          failed
            ? "border border-red-500/40 bg-red-950/35 text-red-50"
            : "bg-amber-300 text-zinc-950"
        }`}
      >
        <div className="flex min-w-0 flex-1 basis-64 gap-3">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium">{title}</p>
            <div
              className={`mt-0.5 ${failed ? "text-red-200" : "text-amber-950"}`}
            >
              {message}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      </div>
    )
  }

  return (
    <InlineAlert
      variant={failed ? "error" : "warning"}
      title={title}
      actions={actions}
    >
      {message}
    </InlineAlert>
  )
}

/** The main action on the yellow banner: a dark button with a dark focus ring. */
const bannerPrimary =
  "border-transparent bg-zinc-950 text-amber-50 outline-zinc-950 hover:bg-zinc-800 pressed:bg-zinc-800"
