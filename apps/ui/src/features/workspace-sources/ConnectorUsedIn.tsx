import { useQuery } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Link } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { SkeletonLine } from "@/components/ui/Skeleton"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { AddToWorkspacesDialog } from "./AddToWorkspacesDialog"
import { connectionUsageOptions } from "./queries"
import { sourceProviderLabel, workspaceSourceHref } from "./source-provider-ui"

/** What happens after the merge of an open source pull request. */
const PENDING_CHANGE_TEXT = {
  add: "Pull request open. The sync starts after the merge.",
  edit: "Pull request open. The change applies after the merge.",
  remove: "Pull request open. The source is removed after the merge.",
} as const

/**
 * "Used in" on an expanded connector: the Workspaces whose sources use this
 * connection, and the open source pull requests that wait for a merge. Each
 * provider card gives it to `ConnectorListItem` as `usedIn`.
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

  return (
    <section aria-labelledby={`used-in-${connectionId}`} className="text-sm">
      <h3 id={`used-in-${connectionId}`} className="text-muted-foreground">
        Used in
      </h3>
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
                {item.stat ? (
                  <span className="shrink-0 text-muted-foreground">
                    · {item.stat}
                  </span>
                ) : null}
              </Link>
              {item.pendingChanges.map((change) => (
                <p
                  key={change.pullRequestUrl}
                  className="pb-1 text-xs text-muted-foreground"
                >
                  {PENDING_CHANGE_TEXT[change.action]}{" "}
                  <TextLink
                    href={change.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    variant="secondary"
                  >
                    Open pull request
                  </TextLink>
                </p>
              ))}
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
