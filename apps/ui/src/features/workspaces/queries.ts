import type { ConversationDetail } from "@/features/chat/types"
import { client } from "@/lib/api"
import type {
  Workspace,
  WorkspaceDetail,
  WorkspaceLinkedRepository,
  WorkspaceListResponse,
} from "./types"

export const workspaceKeys = {
  list: (orgSlug: string) => ["workspaces", orgSlug] as const,
  detail: (orgSlug: string, slug: string) =>
    ["workspace", orgSlug, slug] as const,
  conversations: (orgSlug: string, workspaceId: string) =>
    ["conversations", orgSlug, workspaceId, "ui"] as const,
}

export async function fetchWorkspaces(
  orgSlug: string,
): Promise<WorkspaceListResponse> {
  const res = await client[":orgSlug"].api.v1.workspaces.$get({
    param: { orgSlug },
  })
  if (!res.ok) throw new Error("Failed to load Workspaces")
  return res.json() as Promise<WorkspaceListResponse>
}

export async function fetchConversation(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].$get({
    param: { orgSlug, conversationId },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error("Failed to load conversation")
  return res.json() as Promise<ConversationDetail>
}

export async function fetchWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceDetail | null> {
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"].$get(
    {
      param: { orgSlug, workspaceSlug },
    },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error("Failed to load Workspace")
  return res.json() as Promise<WorkspaceDetail>
}

export async function createWorkspace(
  orgSlug: string,
  input: {
    gitUrl: string
    displayName?: string
    slug?: string
    githubConnectionId?: string
  },
): Promise<Workspace> {
  const res = await client[":orgSlug"].api.v1.workspaces.$post({
    param: { orgSlug },
    json: input,
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to create Workspace")
  }
  return res.json() as Promise<Workspace>
}

export async function updateWorkspace(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    displayName?: string
    slug?: string
    workspaceRepositoryUrl?: string
    githubConnectionId?: string | null
  },
): Promise<Workspace> {
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].$patch({
    param: { orgSlug, workspaceSlug },
    json: input,
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to update Workspace")
  }
  return res.json() as Promise<Workspace>
}

export async function touchWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].touch.$post({
    param: { orgSlug, workspaceSlug },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error("Failed to record last-used Workspace")
  }
}

export async function linkWorkspaceRepository(
  orgSlug: string,
  workspaceSlug: string,
  gitUrl: string,
): Promise<WorkspaceLinkedRepository> {
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "linked-repositories"
  ].$post({
    param: { orgSlug, workspaceSlug },
    json: { gitUrl },
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to link repository")
  }
  return res.json() as Promise<WorkspaceLinkedRepository>
}

export async function unlinkWorkspaceRepository(
  orgSlug: string,
  workspaceSlug: string,
  linkedId: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "linked-repositories"
  ][":linkedId"].$delete({
    param: { orgSlug, workspaceSlug, linkedId },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error("Failed to unlink repository")
  }
}

export function landingWorkspace(
  list: WorkspaceListResponse,
): Workspace | null {
  if (list.items.length === 0) return null
  const last = list.lastUsedWorkspaceId
    ? list.items.find((item) => item.id === list.lastUsedWorkspaceId)
    : null
  return last ?? list.items[0] ?? null
}
