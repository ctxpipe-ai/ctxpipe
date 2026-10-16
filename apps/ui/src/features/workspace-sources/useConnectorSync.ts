import { useMutation, useQuery } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { toast } from "sonner"
import { useOrgMemberRole } from "@/lib/org-member-role"
import { isAdminRole } from "@/lib/session-user"
import { connectionUsageOptions, syncConnectionNow } from "./queries"

/**
 * The providers whose sources sync content on a schedule. GitHub sources
 * read the repositories as they are; Slack captures messages on demand.
 */
const SYNCED_PROVIDERS: ReadonlySet<SourceProvider> = new Set([
  "confluence",
  "linear",
  "notion",
  "pagerduty",
])

/**
 * "Sync now" in a connector card menu. Only an org admin or owner can start
 * a sync, and only for a connection with an `ok` source. Returns undefined
 * when the card must not show the action.
 */
export function useConnectorSync(input: {
  orgSlug: string
  connectionId: string
  provider: SourceProvider
}): { start: () => void; isPending: boolean } | undefined {
  const { orgSlug, connectionId, provider } = input
  const synced = SYNCED_PROVIDERS.has(provider)
  const usageQuery = useQuery({
    ...connectionUsageOptions(orgSlug, connectionId),
    enabled: synced,
  })
  const roleQuery = useOrgMemberRole(orgSlug, { enabled: synced })
  const mutation = useMutation({
    mutationFn: () => syncConnectionNow(orgSlug, connectionId),
    onSuccess: () => toast.success("Sync started. Files update after it ends."),
    onError: () => toast.error("Could not start the sync. Try again."),
  })
  // As the server: only an `ok` source syncs. A Workspace that waits for a
  // source pull request is in "Used in", but has nothing to sync yet.
  const canSync =
    synced &&
    Boolean(
      usageQuery.data?.items.some((item) =>
        item.sources.some((source) => source.status === "ok"),
      ),
    ) &&
    isAdminRole(roleQuery.data?.role)
  return canSync
    ? { start: () => mutation.mutate(), isPending: mutation.isPending }
    : undefined
}
