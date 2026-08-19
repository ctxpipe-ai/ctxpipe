import type { QueryClient } from "@tanstack/react-query"
import { parsePane, visiblePane } from "./pane"
import {
  workspaceConversationOptions,
  workspaceDetailOptions,
  workspaceGitBlobOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
} from "./queries"

/** Prefetch workspace detail (+ conversation / pane) for SSR and navigations. */
export async function ensureWorkspaceRouteData(input: {
  queryClient: QueryClient
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  const { queryClient, orgSlug, workspaceSlug, conversationId, paneParam } =
    input

  const workspace = await queryClient.ensureQueryData(
    workspaceDetailOptions(orgSlug, workspaceSlug),
  )

  if (workspace && conversationId) {
    await queryClient.ensureQueryData(
      workspaceConversationOptions(orgSlug, conversationId, workspace.id),
    )
  }

  const pane = visiblePane(parsePane(paneParam))
  if (!pane || !workspace) return workspace

  if (pane.kind === "files" || pane.kind === "file") {
    const sha =
      workspace.activeProjectionSha?.trim() || workspace.desiredSha?.trim() || ""
    await queryClient.ensureQueryData(
      workspaceGitTreeOptions(orgSlug, workspaceSlug, sha),
    )
    if (pane.kind === "file") {
      await queryClient.ensureQueryData(
        workspaceGitBlobOptions(orgSlug, workspaceSlug, sha, pane.path),
      )
    }
  } else if (pane.kind === "graph") {
    await queryClient.ensureQueryData(
      workspaceGraphOptions(orgSlug, workspaceSlug),
    )
  }

  return workspace
}
