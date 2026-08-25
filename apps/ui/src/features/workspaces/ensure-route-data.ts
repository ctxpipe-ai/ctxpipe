import type { QueryClient } from "@tanstack/react-query"
import { landingPane } from "./pane"
import { workspaceProjectionReady } from "./projection"
import {
  workspaceConversationOptions,
  workspaceDetailOptions,
  workspaceGitBlobOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
} from "./queries"

/** Conversation document: `/$org/ws/$slug/$conversationId`. */
export function isWorkspaceConversationDocument(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean)
  return parts.length >= 4 && parts[1] === "ws" && Boolean(parts[3])
}

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
  if (!pane) return workspace

  if (pane.kind === "files" || pane.kind === "file") {
    if (!workspaceProjectionReady(workspace)) return workspace
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

/** Client page enter / hover: start the same fetches without gating the route. */
export function prefetchWorkspaceRouteData(
  input: Parameters<typeof ensureWorkspaceRouteData>[0],
) {
  void ensureWorkspaceRouteData(input)
}

/** Client in-page nav: start the conversation fetch without gating the route. */
export function prefetchWorkspaceConversation(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceSlug: string,
  conversationId: string,
) {
  const workspace = queryClient.getQueryData(
    workspaceDetailOptions(orgSlug, workspaceSlug).queryKey,
  )
  if (!workspace) {
    prefetchWorkspaceRouteData({
      queryClient,
      orgSlug,
      workspaceSlug,
      conversationId,
      warmLandingPane: true,
    })
    return
  }
  void queryClient.prefetchQuery(
    workspaceConversationOptions(orgSlug, conversationId, workspace.id),
  )
}
