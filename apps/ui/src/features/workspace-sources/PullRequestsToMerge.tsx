import { IconCheck, IconExternalLink } from "@tabler/icons-react"
import { useQueries } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"

import { Button } from "@/components/ui/Button"
import { pollWhileOk } from "@/lib/api-result"

import { stableJson } from "./choose-workspaces"
import {
  type WorkspaceSourceListResponse,
  workspaceSourcesOptions,
} from "./queries"
import type { OpenedPullRequest } from "./useAddToWorkspaces"

/**
 * Whether the Workspace sources have the change of a pull request. An add or
 * an edit needs the source with the new scope. A remove needs no source with
 * that id. While the sources file has an error, the sources are not known.
 */
function isMerged(
  pullRequest: OpenedPullRequest,
  list: WorkspaceSourceListResponse | undefined,
) {
  if (!list || list.fileError) return false
  const source = list.items.find((item) => item.path === pullRequest.path)
  return pullRequest.scope === null
    ? !source
    : source !== undefined &&
        stableJson(source.scope) === stableJson(pullRequest.scope)
}

/**
 * The last step of every connector setup (CTX-1060): merge the source pull
 * requests that the save opened. A source syncs only after its merge
 * (ADR-050), so the setup is not done before it. Each setup dialog gives its
 * own steps and gets them back with this step at the end.
 *
 * `currentIndex` is null before the save, so the dialog keeps its own step.
 * After the save it is this step, and past the end when each pull request
 * is merged. `merged` has one entry for each pull request.
 */
export function useMergeStep(input: {
  orgSlug: string
  steps: readonly { readonly id: string; readonly label: string }[]
  pullRequests: OpenedPullRequest[]
}) {
  const { orgSlug, pullRequests } = input
  // Read the sources every 5 seconds for at most 15 minutes after the save. A
  // merge in another window or with the GitHub CLI does not make the tab
  // visible, so a read on focus is not sufficient.
  const [poll, setPoll] = useState(() => ({
    pullRequests,
    until: Date.now() + 15 * 60_000,
  }))
  if (poll.pullRequests !== pullRequests)
    setPoll({ pullRequests, until: Date.now() + 15 * 60_000 })
  const sourceLists = useQueries({
    queries: pullRequests.map((pullRequest) => ({
      ...workspaceSourcesOptions(orgSlug, pullRequest.workspaceSlug),
      refetchInterval: (query: {
        state: { status: string; data: WorkspaceSourceListResponse | undefined }
      }) =>
        isMerged(pullRequest, query.state.data) || Date.now() > poll.until
          ? false
          : pollWhileOk(5_000)(query),
    })),
  })
  const merged = pullRequests.map((pullRequest, index) =>
    isMerged(pullRequest, sourceLists[index]?.data),
  )
  const steps = [
    ...input.steps,
    {
      id: "merge",
      label:
        pullRequests.length > 1
          ? "Merge pull requests"
          : "Merge the pull request",
    },
  ]
  return {
    steps,
    currentIndex:
      pullRequests.length === 0
        ? null
        : merged.every(Boolean)
          ? steps.length
          : steps.length - 1,
    merged,
  }
}

/** "acme/docs#7" for a GitHub pull request URL. */
function pullRequestRef(url: string) {
  return url.replace(/^https:\/\/github\.com\//, "").replace("/pull/", "#")
}

/**
 * The body of the merge step, the same in each setup dialog. "Review pull
 * request" is the primary action until each pull request is merged; then
 * "Done" is. Each pull request shows whether it is merged.
 */
export function PullRequestsToMerge(props: {
  pullRequests: OpenedPullRequest[]
  /** From `useMergeStep`, one entry for each pull request. */
  merged: boolean[]
  /** Replaces the default sentence, for a provider-specific note. */
  detail?: ReactNode
  /** Closes the dialog. */
  onDone: () => void
}) {
  const { pullRequests, merged } = props
  const allMerged = merged.every(Boolean)
  const single = pullRequests.length === 1
  const review = (url: string) => (
    <Button
      href={url}
      target="_blank"
      rel="noreferrer"
      size={single ? "default" : "sm"}
      aria-label={`Review pull request ${pullRequestRef(url)}. Opens GitHub in a new tab.`}
    >
      Review pull request
      <IconExternalLink className="size-3.5" aria-hidden />
    </Button>
  )
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          {allMerged
            ? single
              ? "Pull request merged"
              : "Pull requests merged"
            : single
              ? "Merge the pull request"
              : "Merge the pull requests"}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {allMerged
            ? "The Workspace sources have the change now."
            : (props.detail ?? "The source change applies after the merge.")}
        </p>
      </div>
      <ul className="space-y-2 text-sm">
        {pullRequests.map((pullRequest, index) => (
          <li
            key={pullRequest.url}
            className="flex min-h-7 items-center justify-between gap-3"
          >
            <span className="flex min-w-0 items-center gap-3">
              <code className="truncate font-mono text-xs text-foreground">
                {pullRequestRef(pullRequest.url)}
              </code>
              {merged[index] ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <IconCheck className="size-3.5" aria-hidden />
                  Merged
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-amber-400">
                  <span
                    aria-hidden
                    className="ctx-status-pulse size-1.5 rounded-full bg-amber-400"
                  />
                  Awaiting merge
                </span>
              )}
            </span>
            {!single && !merged[index] ? review(pullRequest.url) : null}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        {allMerged ? (
          <Button onPress={props.onDone}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onPress={props.onDone}>
              Close
            </Button>
            {single && pullRequests[0] ? review(pullRequests[0].url) : null}
          </>
        )}
      </div>
    </div>
  )
}
