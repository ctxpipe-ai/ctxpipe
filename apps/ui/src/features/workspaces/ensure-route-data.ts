import type { QueryClient } from "@tanstack/react-query"
import { landingPane } from "./pane"
import {
  workspaceConversationOptions,
  workspaceDetailOptions,
  workspaceGitBlobOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
} from "./queries"

/** Prefetch workspace detail (+ conversation / landing pane) for SSR and workspace entry. */
export async function ensureWorkspaceRouteData(input: {
  queryClient: QueryClient
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
  /** Warm the landing pane (files by default). Skip on in-page search stays. */
  warmLandingPane?: boolean
}) {
  const {
    queryClient,
    orgSlug,
    workspaceSlug,
    conversationId,
    paneParam,
    warmLandingPane = true,
  } = input

  const workspace = await queryClient.ensureQueryData(
    workspaceDetailOptions(orgSlug, workspaceSlug),
  )

  if (workspace && conversationId) {
    await queryClient.ensureQueryData(
      workspaceConversationOptions(orgSlug, conversationId, workspace.id),
    )
  }

  if (!warmLandingPane || !workspace) return workspace

  const pane = landingPane(paneParam)

  if (pane.kind === "files" || pane.kind === "file") {
    const sha =
      workspace.activeProjectionSha?.trim() ||
      workspace.desiredSha?.trim() ||
      ""
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
