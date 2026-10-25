import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { useIsOrgAdmin } from "@/lib/org-member-role"

import { workspaceUpgradesHref } from "./format-gate"
import { MEMBER_ASK_ADMIN } from "./upgrade-copy"

/**
 * The notice for a place that works on all the Workspaces of the org (the
 * Connectors page, the Choose Workspaces step), when each Workspace needs the
 * format upgrade first (CTX-935). One button for each Workspace opens its
 * Upgrades. A member sees "Ask an admin".
 */
export function FormatUpgradeWorkspacesNotice(props: {
  orgSlug: string
  workspaces: ReadonlyArray<{ slug: string; displayName: string }>
}) {
  const { orgSlug, workspaces } = props
  const isAdmin = useIsOrgAdmin(orgSlug)
  return (
    <InlineAlert
      variant="warning"
      title="Upgrade a Workspace before you add a source"
      actions={
        <>
          {workspaces.map((workspace) => (
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
          ))}
          {isAdmin === false ? (
            <span className="self-center text-xs">{MEMBER_ASK_ADMIN}</span>
          ) : null}
        </>
      }
    >
      {workspaces.length === 1
        ? "This Workspace still has the old repository layout."
        : "These Workspaces still have the old repository layout."}{" "}
      Sources need the newest layout. Run the format upgrade first, then add the
      source.
    </InlineAlert>
  )
}
