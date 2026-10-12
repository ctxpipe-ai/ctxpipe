import { useMutation, useQuery } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Link } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonLine } from "@/components/ui/Skeleton"
import { authClient } from "@/lib/auth-client"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { isAdminRole } from "@/lib/session-user"
import { cn } from "@/lib/utils"
import { AddToWorkspacesDialog } from "./AddToWorkspacesDialog"
import { connectionUsageOptions, syncConnectionNow } from "./queries"
import { sourceProviderLabel, workspaceSourceHref } from "./source-provider-ui"

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
 * "Used in" on an expanded connector: the Workspaces whose sources use this
 * connection. Each provider card gives it to `ConnectorListItem` as `usedIn`.
 */
export function ConnectorUsedIn(props: {
  orgSlug: string
  connectionId: string
  provider: SourceProvider
}) {
  const { orgSlug, connectionId, provider } = props
  const usageQuery = useQuery(connectionUsageOptions(orgSlug, connectionId))
  const [addOpen, setAddOpen] = useState(false)
  const items = usageQuery.data?.items ?? []
  const syncMutation = useMutation({
    mutationFn: () => syncConnectionNow(orgSlug, connectionId),
  })
  // The sync route is for an org admin or owner only.
  const roleQuery = useQuery({
    queryKey: ["organization-member-role", orgSlug],
    queryFn: () =>
      authClient.organization.getActiveMemberRole({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      }),
  })
  const canSync =
    SYNCED_PROVIDERS.has(provider) &&
    items.length > 0 &&
    isAdminRole(roleQuery.data?.role)

  return (
    <section aria-labelledby={`used-in-${connectionId}`} className="text-sm">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 id={`used-in-${connectionId}`} className="text-muted-foreground">
          Used in
        </h3>
        {canSync ? (
          <div className="flex items-center gap-3">
            <output className="text-muted-foreground">
              {syncMutation.isSuccess
                ? "Sync started. Files update after it ends."
                : syncMutation.isError
                  ? "Could not start the sync."
                  : null}
            </output>
            <Button
              variant="secondary"
              isPending={syncMutation.isPending}
              onPress={() => syncMutation.mutate()}
            >
              Sync now
            </Button>
          </div>
        ) : null}
      </div>
      {usageQuery.isPending ? (
        <ul
          className="mt-1 flex flex-col"
          aria-busy
          aria-label="Loading Workspaces"
        >
          {[0, 1].map((row) => (
            <li key={row} className="flex h-7 items-center gap-2">
              <SkeletonLine className="h-3.5 w-32" />
              <SkeletonLine className="h-3 w-24" />
            </li>
          ))}
        </ul>
      ) : usageQuery.isError ? (
        <div className="mt-2">
          <InlineAlert
            variant="error"
            actions={
              <Button variant="secondary" onPress={() => usageQuery.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load the Workspaces of this connector.
          </InlineAlert>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-2 rounded-md bg-zinc-900/60 p-3">
          <p className="font-medium text-foreground">No Workspaces yet</p>
          <p className="mt-0.5 text-muted-foreground">
            Nothing syncs from {sourceProviderLabel(provider)} until you add it
            to a Workspace.
          </p>
          <Button
            variant="primary"
            className="mt-3"
            onPress={() => setAddOpen(true)}
          >
            Add to a Workspace
          </Button>
        </div>
      ) : (
        <ul className="mt-1 flex flex-col">
          {items.map((item) => (
            <li key={item.workspaceId}>
              <Link
                href={workspaceSourceHref(
                  orgSlug,
                  item.workspaceSlug,
                  provider,
                )}
                className={cn(
                  "flex h-7 min-w-0 items-center gap-1 rounded-md text-foreground transition-colors hover:text-teal-300",
                  focusVisibleClassName,
                )}
              >
                <span className="truncate">{item.workspaceName}</span>
                <span className="shrink-0 text-muted-foreground">
                  · {item.stat}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <AddToWorkspacesDialog
        orgSlug={orgSlug}
        connectionId={connectionId}
        provider={provider}
        isOpen={addOpen}
        onOpenChange={setAddOpen}
      />
    </section>
  )
}
