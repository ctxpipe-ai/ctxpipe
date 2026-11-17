import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { useIsOrgAdmin } from "@/lib/org-member-role"

import { workspaceUpgradesHref } from "./format-gate"
import { MEMBER_ASK_ADMIN } from "./upgrade-copy"

/**
 * The notice for a place that works on all the Workspaces of the org (the
 * Connectors page, the Add to Workspaces step), when each Workspace needs the
 * format upgrade first (CTX-935). One button for each Workspace opens its
 * Upgrades. A member sees "Ask an admin".
 *
 * `upgradeButtons: false` is for a place that already links each Workspace to
 * its upgrade (the rows of the Add to Workspaces step), so that the same link
 * does not show twice.
 */
export function FormatUpgradeWorkspacesNotice(props: {
  orgSlug: string
  workspaces: ReadonlyArray<{ slug: string; displayName: string }>
  upgradeButtons?: boolean
}) {
  const { orgSlug, workspaces, upgradeButtons = true } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  const buttons = upgradeButtons
    ? workspaces.map((workspace) => (
        <Button
          key={workspace.slug}
          variant="secondary"
          size="sm"
          href={workspaceUpgradesHref(orgSlug, workspace.slug)}
          aria-label={`Review upgrade: ${workspace.displayName}`}
        >
          {workspaces.length === 1
            ? "Review upgrade"
            : `Review upgrade: ${workspace.displayName}`}
        </Button>
      ))
    : null
  const askAdmin =
    isAdmin === false ? (
      <span className="self-center text-xs">{MEMBER_ASK_ADMIN}</span>
    ) : null
  return (
    <InlineAlert
      variant="warning"
      title="Upgrade a Workspace before you add a source"
      actions={
        buttons || askAdmin ? (
          <>
            {buttons}
            {askAdmin}
          </>
        ) : undefined
      }
    >
      {/* This page is not inside a Workspace, so the notice names it. */}
      {workspaces.length === 1
        ? `The ${workspaces[0]?.displayName} Workspace still has the old repository layout.`
        : "These Workspaces still have the old repository layout."}{" "}
      Sources need the newest layout. Run the format upgrade first, then add the
      source.
    </InlineAlert>
  )
}
