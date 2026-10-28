import { useQuery } from "@tanstack/react-query"

import { type PendingSourceChange, workspaceSourcesOptions } from "./queries"
import { ReviewPullRequestLink } from "./ReviewPullRequestLink"
import { sourceProviderLabel } from "./source-provider-ui"

/** What the merge of a source pull request does, as the end of a sentence. */
function mergeResult(change: PendingSourceChange) {
  switch (change.action) {
    case "add":
      return change.provider === "github" || change.provider === "git"
        ? "link the repository"
        : "start the sync"
    case "edit":
      return "apply the change"
    case "remove":
      return "remove the source"
    case "rename":
      return "move the source file"
  }
}

/**
 * The "Needs you" list of the Sources card in Workspace settings (CTX-1060):
 * one row for each source pull request that waits for its merge, with a teal
 * link to it. The rows use the layout of the "Needs you" rows of the Upgrades
 * card. It reads the Workspace sources from the same cache as the list.
 */
export function SourceMergesNeedYou(props: {
  orgSlug: string
  workspaceSlug: string
}) {
  const { data } = useQuery(
    workspaceSourcesOptions(props.orgSlug, props.workspaceSlug),
  )
  // One pull request can hold several changes (a batch add): one row for it.
  const pullRequests = new Map<string, PendingSourceChange>()
  for (const change of data?.pendingChanges ?? [])
    if (!pullRequests.has(change.pullRequestUrl))
      pullRequests.set(change.pullRequestUrl, change)
  if (pullRequests.size === 0) return null
  return (
    <ul
      aria-label="Needs you"
      className="-mx-5 mb-4 divide-y divide-white/[0.06] border-y border-white/[0.06]"
    >
      {[...pullRequests.values()].map((change) => {
        const title = `Merge the ${sourceProviderLabel(change.provider)} source pull request to ${mergeResult(change)}`
        return (
          <li
            key={change.pullRequestUrl}
            className="px-5 py-3"
            aria-label={title}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm text-foreground">
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-amber-400"
                  />
                  <span className="sr-only">Needs you: </span>
                  {title}
                </h3>
                <p className="mt-1 max-w-prose pl-3.5 text-xs text-muted-foreground">
                  ctxpipe opened this pull request in the Workspace repository.
                  Nothing changes until you merge it.
                </p>
              </div>
              <ReviewPullRequestLink
                url={change.pullRequestUrl}
                className="shrink-0 text-sm"
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
