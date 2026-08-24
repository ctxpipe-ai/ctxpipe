import { queryOptions } from "@tanstack/react-query"
import type { ConversationDetail } from "@/features/chat/types"
import { getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import type {
  Workspace,
  WorkspaceDetail,
  WorkspaceFileJobRequest,
  WorkspaceFilesResponse,
  WorkspaceGitBlobResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitTreeResponse,
  WorkspaceGraphPayload,
  WorkspaceLinkedRepository,
  WorkspaceListResponse,
} from "./types"

export const workspaceKeys = {
  list: (orgSlug: string) => ["workspaces", orgSlug] as const,
  detail: (orgSlug: string, slug: string) =>
    ["workspace", orgSlug, slug] as const,
  conversations: (orgSlug: string, workspaceId: string) =>
    ["conversations", orgSlug, workspaceId, "ui"] as const,
  conversation: (
    orgSlug: string,
    conversationId: string,
    workspaceId: string,
  ) => ["conversation", orgSlug, conversationId, workspaceId] as const,
  files: (orgSlug: string, slug: string) =>
    ["workspace-files", orgSlug, slug] as const,
  gitTree: (orgSlug: string, slug: string, sha: string) =>
    ["workspace-git-tree", orgSlug, slug, sha] as const,
  gitBlob: (orgSlug: string, slug: string, sha: string, path: string) =>
    ["workspace-git-blob", orgSlug, slug, sha, path] as const,
  gitStatus: (orgSlug: string, slug: string, sha: string) =>
    ["workspace-git-status", orgSlug, slug, sha] as const,
  graph: (orgSlug: string, slug: string) =>
    ["workspace-graph", orgSlug, slug] as const,
  chatPrepare: (orgSlug: string, conversationId: string, workspaceId: string) =>
    ["workspace-chat-prepare", orgSlug, conversationId, workspaceId] as const,
}

export async function fetchWorkspaces(
  orgSlug: string,
): Promise<WorkspaceListResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces.$get({
    param: { orgSlug },
  })
  return readApiJson<WorkspaceListResponse>(res, {
    message: "Failed to load Workspaces",
  })
}

export async function fetchConversation(
  orgSlug: string,
  conversationId: string,
  workspaceId?: string,
): Promise<ConversationDetail | null> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].$get({
    param: { orgSlug, conversationId },
    query: workspaceId ? { workspaceId } : {},
  })
  return readApiJson<ConversationDetail | null>(res, {
    emptyOn: [404],
    empty: null,
    message: "Failed to load conversation",
  })
}

export async function prepareWorkspaceChat(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].prepare.$post({
    param: { orgSlug, conversationId },
    json: { workspaceId },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error("Failed to prepare workspace chat")
  }
}

export async function fetchWorkspaceFiles(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceFilesResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<WorkspaceFilesResponse>(res, {
    message: "Failed to load Workspace files",
  })
}

export async function fetchWorkspaceGitTree(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceGitTreeResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.tree.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<WorkspaceGitTreeResponse>(res, {
    emptyOn: [409],
    empty: { sha: "", paths: [] },
    message: "Failed to load Workspace files",
  })
}

export async function fetchWorkspaceGitBlob(
  orgSlug: string,
  workspaceSlug: string,
  path: string,
): Promise<WorkspaceGitBlobResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.blob.$get({
    param: { orgSlug, workspaceSlug },
    query: { path },
  })
  return readApiJson<WorkspaceGitBlobResponse>(res, {
    emptyOn: [404],
    empty: { path, body: null, binary: false },
    message: "Failed to load file",
  })
}

export async function fetchWorkspaceGitStatus(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceGitStatusResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.status.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<WorkspaceGitStatusResponse>(res, {
    message: "Failed to load git status",
  })
}

export async function enqueueWorkspaceFileJob(
  orgSlug: string,
  workspaceSlug: string,
  input: WorkspaceFileJobRequest,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.jobs.$post({
    param: { orgSlug, workspaceSlug },
    json: input,
  })
  await readApiJson<void>(res, { message: "Failed to save file changes" })
}

export async function fetchWorkspaceGraph(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceGraphPayload> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].graph.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<WorkspaceGraphPayload>(res, {
    message: "Failed to load Workspace graph",
  })
}

export async function fetchWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceDetail | null> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"].$get(
    {
      param: { orgSlug, workspaceSlug },
    },
  )
  return readApiJson<WorkspaceDetail | null>(res, {
    emptyOn: [404],
    empty: null,
    message: "Failed to load Workspace",
  })
}

export function workspaceListOptions(orgSlug: string) {
  return queryOptions({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
}

export function workspaceDetailOptions(orgSlug: string, workspaceSlug: string) {
  return queryOptions({
    queryKey: workspaceKeys.detail(orgSlug, workspaceSlug),
    queryFn: () => fetchWorkspace(orgSlug, workspaceSlug),
  })
}

export function workspaceConversationOptions(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversation(orgSlug, conversationId, workspaceId),
    queryFn: () => fetchConversation(orgSlug, conversationId, workspaceId),
  })
}

export function workspaceFilesOptions(orgSlug: string, workspaceSlug: string) {
  return queryOptions({
    queryKey: workspaceKeys.files(orgSlug, workspaceSlug),
    queryFn: () => fetchWorkspaceFiles(orgSlug, workspaceSlug),
  })
}

export function workspaceGitTreeOptions(
  orgSlug: string,
  workspaceSlug: string,
  sha: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.gitTree(orgSlug, workspaceSlug, sha),
    queryFn: () => fetchWorkspaceGitTree(orgSlug, workspaceSlug),
  })
}

export function workspaceGitBlobOptions(
  orgSlug: string,
  workspaceSlug: string,
  sha: string,
  path: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.gitBlob(orgSlug, workspaceSlug, sha, path),
    queryFn: () => fetchWorkspaceGitBlob(orgSlug, workspaceSlug, path),
  })
}

export function workspaceGitStatusOptions(
  orgSlug: string,
  workspaceSlug: string,
  sha: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.gitStatus(orgSlug, workspaceSlug, sha),
    queryFn: () => fetchWorkspaceGitStatus(orgSlug, workspaceSlug),
  })
}

export function workspaceGraphOptions(orgSlug: string, workspaceSlug: string) {
  return queryOptions({
    queryKey: workspaceKeys.graph(orgSlug, workspaceSlug),
    queryFn: () => fetchWorkspaceGraph(orgSlug, workspaceSlug),
  })
}

export async function createWorkspace(
  orgSlug: string,
  input: {
    gitUrl: string
    displayName?: string
    slug?: string
    githubConnectionId?: string
    source?: "select" | "paste"
  },
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces.$post({
    param: { orgSlug },
    json: input,
  })
  return readApiJson<Workspace>(res, { message: "Failed to create Workspace" })
}

export async function updateWorkspace(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    displayName?: string
    slug?: string
    workspaceRepositoryUrl?: string
    githubConnectionId?: string | null
    source?: "select" | "paste"
  },
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].$patch({
    param: { orgSlug, workspaceSlug },
    json: input,
  })
  return readApiJson<Workspace>(res, { message: "Failed to update Workspace" })
}

export async function deleteWorkspace(
  orgSlug: string,
  workspaceSlug: string,
  confirmName: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].$delete({
    param: { orgSlug, workspaceSlug },
    json: { confirmName },
  })
  await readApiJson<void>(res, { message: "Failed to delete Workspace" })
}

export async function touchWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].touch.$post({
    param: { orgSlug, workspaceSlug },
  })
  await readApiJson<void>(res, {
    message: "Failed to record last-used Workspace",
  })
}

export async function retryPrepareWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "retry-prepare"
  ].$post({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<Workspace>(res, {
    message: "Failed to retry Workspace prepare",
  })
}

export async function linkWorkspaceRepository(
  orgSlug: string,
  workspaceSlug: string,
  gitUrl: string,
): Promise<WorkspaceLinkedRepository> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "linked-repositories"
  ].$post({
    param: { orgSlug, workspaceSlug },
    json: { gitUrl },
  })
  return readApiJson<WorkspaceLinkedRepository>(res, {
    message: "Failed to link repository",
  })
}

export async function unlinkWorkspaceRepository(
  orgSlug: string,
  workspaceSlug: string,
  linkedId: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "linked-repositories"
  ][":linkedId"].$delete({
    param: { orgSlug, workspaceSlug, linkedId },
  })
  await readApiJson<void>(res, { message: "Failed to unlink repository" })
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
