import { IconCheck } from "@tabler/icons-react"
import { useQueries } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"

import { ExternalLink } from "@/components/ui/ExternalLink"
import { StepMarker } from "@/features/connectors/components/ConnectorSetupStepper"
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
 * The last step of a connector setup when the save opened source pull
 * requests: the change applies after each merge. It is the next to-do item
 * of the setup steps, so it shows as a card in that list
 * (`ConnectorSetupStepper` `finalStep`), with the pull request links inside.
 * Every setup dialog shows this card, so the step looks the same for each
 * connector. The step reads the sources of each Workspace. A pull request
 * shows as merged when the Workspace sources have its change.
 */
export function PullRequestsToMerge(props: {
  orgSlug: string
  pullRequests: OpenedPullRequest[]
  /** The number of this step in the setup list. */
  stepNumber: number
  /** Replaces the default sentence, for a provider-specific note. */
  detail?: ReactNode
}) {
  // Read the sources every 5 seconds for at most 15 minutes. A merge in
  // another window or with the GitHub CLI does not make the tab visible, so a
  // read on focus is not sufficient.
  const [pollUntil] = useState(() => Date.now() + 15 * 60_000)
  const sourceLists = useQueries({
    queries: props.pullRequests.map((pullRequest) => ({
      ...workspaceSourcesOptions(props.orgSlug, pullRequest.workspaceSlug),
      refetchInterval: (query: {
        state: { status: string; data: WorkspaceSourceListResponse | undefined }
      }) =>
        isMerged(pullRequest, query.state.data) || Date.now() > pollUntil
          ? false
          : pollWhileOk(5_000)(query),
    })),
  })
  const merged = props.pullRequests.map((pullRequest, index) =>
    isMerged(pullRequest, sourceLists[index]?.data),
  )
  const allMerged = merged.every(Boolean)
  const single = props.pullRequests.length === 1
  return (
    <li
      className="-mx-3 mt-3 flex gap-3 rounded-md border border-white/[0.08] bg-zinc-900/60 p-3 text-sm"
      data-state={allMerged ? "done" : "current"}
      aria-current={allMerged ? undefined : "step"}
    >
      <span className="mt-0.5 shrink-0">
        <StepMarker
          state={allMerged ? "done" : "current"}
          number={props.stepNumber}
        />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="font-medium text-foreground">
          {allMerged
            ? single
              ? "Pull request merged"
              : "Pull requests merged"
            : single
              ? "Merge the pull request"
              : "Merge the pull requests"}
        </h3>
        <p className="mt-1 text-muted-foreground">
          {allMerged
            ? "The Workspace sources have the change now."
            : (props.detail ?? "The source change applies after the merge.")}
        </p>
        <ul className="mt-3 space-y-1">
          {props.pullRequests.map((pullRequest, index) => (
            <li key={pullRequest.url} className="flex items-center gap-2">
              <ExternalLink href={pullRequest.url}>
                {pullRequest.url
                  .replace(/^https:\/\/github\.com\//, "")
                  .replace("/pull/", "#")}
              </ExternalLink>
              {merged[index] ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <IconCheck className="size-3.5" aria-hidden />
                  Merged
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </li>
  )
}
