import { useQuery } from "@tanstack/react-query"

import { type ConnectionUsageResponse, connectionUsageOptions } from "./queries"

/**
 * The next step of a connection (CTX-1060). A connection holds auth only
 * (ADR-050), so it does nothing until a Workspace source uses it, and a
 * source exists only after its pull request merges.
 * - `add_to_workspace`: no Workspace uses the connection.
 * - `merge`: each Workspace that uses it waits for a source pull request.
 * - `live`: a Workspace has a source or a repository from the connection.
 *
 * The usage read has no sync time, so it cannot tell a first sync from a
 * later one: a merged source is `live` at once.
 */
export type ConnectionNextStep =
  | { kind: "add_to_workspace" }
  | {
      kind: "merge"
      /** One entry for each pull request, in the order of the Workspaces. */
      pullRequests: { url: string; workspaceName: string }[]
    }
  | { kind: "live" }

export function connectionNextStep(
  usage: ConnectionUsageResponse,
): ConnectionNextStep {
  if (usage.items.length === 0) return { kind: "add_to_workspace" }
  // A Workspace waits when it has an open source pull request and no source
  // that syncs. A Workspace with no pull request uses the connection now,
  // for example a GitHub Workspace repository without a source file.
  const waits = usage.items.every(
    (item) =>
      item.pendingChanges.length > 0 &&
      !item.sources.some((source) => source.status === "ok"),
  )
  if (!waits) return { kind: "live" }
  const pullRequests = new Map<string, string>()
  for (const item of usage.items)
    for (const change of item.pendingChanges)
      if (!pullRequests.has(change.pullRequestUrl))
        pullRequests.set(change.pullRequestUrl, item.workspaceName)
  return {
    kind: "merge",
    pullRequests: [...pullRequests].map(([url, workspaceName]) => ({
      url,
      workspaceName,
    })),
  }
}

/**
 * The next step of a connection, from the "Used in" read (the same cache).
 * `step` is null while the read loads or after it fails.
 */
export function useConnectionNextStep(orgSlug: string, connectionId: string) {
  const query = useQuery(connectionUsageOptions(orgSlug, connectionId))
  return {
    step: query.data ? connectionNextStep(query.data) : null,
    isPending: query.isPending,
  }
}
