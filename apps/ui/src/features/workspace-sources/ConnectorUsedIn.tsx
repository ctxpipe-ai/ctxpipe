import { useQuery } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Link } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonLine } from "@/components/ui/Skeleton"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

import { AddToWorkspacesDialog } from "./AddToWorkspacesDialog"
import { connectionNextStep } from "./connection-next-step"
import { connectionUsageOptions } from "./queries"
import { ReviewPullRequestLink } from "./ReviewPullRequestLink"
import { sourceProviderLabel, workspaceSourceHref } from "./source-provider-ui"

/** What happens after the merge of an open source pull request. */
const PENDING_CHANGE_TEXT = {
  add: "Pull request open. The sync starts after the merge.",
  edit: "Pull request open. The change applies after the merge.",
  remove: "Pull request open. The source is removed after the merge.",
  rename: "Pull request open. The file moves after the merge.",
} as const

/**
 * "Used in" on an expanded connector: the Workspaces whose sources use this
 * connection, and the open source pull requests that wait for a merge. Each
 * provider card gives it to `ConnectorListItem` as `usedIn`. The next step of
 * the connection decides the lead: add it to a Workspace, or merge the first
 * source pull requests.
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
  const step = usageQuery.data ? connectionNextStep(usageQuery.data) : null

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
      ) : step?.kind === "add_to_workspace" ? (
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
        <>
          {step?.kind === "merge" ? (
            <div className="mt-2 rounded-md bg-zinc-900/60 p-3">
              <p className="font-medium text-foreground">
                {step.pullRequests.length === 1
                  ? "Merge the pull request"
                  : "Merge the pull requests"}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {step.pullRequests.length === 1
                  ? `ctxpipe opened a pull request that adds ${sourceProviderLabel(provider)} to the Workspace. The sync starts after the merge.`
                  : `ctxpipe opened a pull request in each Workspace that adds ${sourceProviderLabel(provider)}. The sync starts after each merge.`}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {step.pullRequests.map((pullRequest) => (
                  <li key={pullRequest.url}>
                    <ReviewPullRequestLink
                      url={pullRequest.url}
                      label={
                        step.pullRequests.length === 1
                          ? "Review pull request"
                          : `Review the ${pullRequest.workspaceName} pull request`
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
                {/* The merge lead above links each pull request already. */}
                {step?.kind === "merge"
                  ? null
                  : item.pendingChanges.map((change) => (
                      <p
                        key={change.pullRequestUrl}
                        className="pb-1 text-xs text-muted-foreground"
                      >
                        {PENDING_CHANGE_TEXT[change.action]}{" "}
                        <ReviewPullRequestLink url={change.pullRequestUrl} />
                      </p>
                    ))}
              </li>
            ))}
          </ul>
        </>
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
