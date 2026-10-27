import { useQuery } from "@tanstack/react-query"

import { workspaceNeedsFormatUpgrade } from "./format-gate"
import { FormatUpgradeNotice } from "./FormatUpgradeNotice"
import { workspaceUpgradesOptions } from "./queries"

/**
 * The banner at the top of the Workspace page and of the chat (CTX-932). It
 * shows only while the Workspace needs the format upgrade, so a user sees the
 * action where the user works and not only in Settings. It shows nothing
 * while the read loads or when the read fails: Settings still shows the error.
 */
export function WorkspaceFormatUpgradeBanner(props: {
  orgSlug: string
  workspaceSlug: string
}) {
  const { orgSlug, workspaceSlug } = props
  const { data } = useQuery(workspaceUpgradesOptions(orgSlug, workspaceSlug))
  if (!data || !workspaceNeedsFormatUpgrade(data)) return null
  return (
    <div className="shrink-0 border-b border-white/[0.06] p-3">
      <FormatUpgradeNotice
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        context="workspace"
        items={data.items}
      />
    </div>
  )
}
