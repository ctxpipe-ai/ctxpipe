import { queryOptions } from "@tanstack/react-query"
import type { ConversationDetail } from "@/features/chat/types"
import { getApiClient } from "@/lib/api"
import { ApiError, pollWhileOk, readApiJson } from "@/lib/api-result"
import { destinationAfterMove } from "./fileTreeMutations"
import type {
  ConversationFileMutation,
  ConversationGitDiffResponse,
  ConversationGitStatusResponse,
  ConversationPullRequestResponse,
  ConversationPushResponse,
  Workspace,
  WorkspaceActivityResponse,
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
  activity: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-activity", orgSlug, workspaceSlug] as const,
  conversationGitTree: (orgSlug: string, conversationId: string) =>
    ["conversation-git-tree", orgSlug, conversationId] as const,
  conversationGitBlob: (
    orgSlug: string,
    conversationId: string,
    path: string,
  ) => ["conversation-git-blob", orgSlug, conversationId, path] as const,
  conversationGitStatus: (orgSlug: string, conversationId: string) =>
    ["conversation-git-status", orgSlug, conversationId] as const,
  conversationGitDiff: (orgSlug: string, conversationId: string) =>
    ["conversation-git-diff", orgSlug, conversationId] as const,
  conversationPullRequest: (orgSlug: string, conversationId: string) =>
    ["conversation-pull-request", orgSlug, conversationId] as const,
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

export function workspaceChatPrepareOptions(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.chatPrepare(orgSlug, conversationId, workspaceId),
    queryFn: () => prepareWorkspaceChat(orgSlug, conversationId, workspaceId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
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

export async function fetchWorkspaceActivity(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceActivityResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].activity.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson<WorkspaceActivityResponse>(res, {
    message: "Failed to load workspace activity",
  })
}

export function workspaceActivityOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.activity(orgSlug, workspaceSlug),
    queryFn: () => fetchWorkspaceActivity(orgSlug, workspaceSlug),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? pollWhileOk(2000)(query) : false,
  })
}

export async function fetchConversationGitTree(
  orgSlug: string,
  conversationId: string,
): Promise<WorkspaceGitTreeResponse & { branch: string }> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.tree.$get({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, { message: "Failed to load conversation files" })
}

export async function fetchConversationGitBlob(
  orgSlug: string,
  conversationId: string,
  path: string,
): Promise<WorkspaceGitBlobResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.blob.$get({
    param: { orgSlug, conversationId },
    query: { path },
  })
  return readApiJson(res, {
    emptyOn: [404],
    empty: { path, body: null, binary: false },
    message: "Failed to load conversation file",
  })
}

export async function fetchConversationGitStatus(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationGitStatusResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.status.$get({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, { message: "Failed to load conversation git status" })
}

export async function fetchConversationGitDiff(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationGitDiffResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.diff.$get({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, { message: "Failed to load conversation diff" })
}

export async function putConversationFile(
  orgSlug: string,
  conversationId: string,
  input: ConversationFileMutation,
): Promise<WorkspaceGitBlobResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.blob.$put({
    param: { orgSlug, conversationId },
    json: input,
  })
  return readApiJson(res, { message: "Failed to save conversation file" })
}

export async function persistConversationFileMutation(
  orgSlug: string,
  conversationId: string,
  input: WorkspaceFileJobRequest,
): Promise<void> {
  if (input.op === "save") {
    await putConversationFile(orgSlug, conversationId, {
      path: input.path,
      body: input.content,
    })
    return
  }
  if (input.op === "create") {
    const path =
      input.kind === "folder" ? `${input.path}/.gitkeep` : input.path
    await putConversationFile(orgSlug, conversationId, {
      path,
      body: input.content ?? "",
    })
    return
  }
  if (input.op === "delete") {
    await putConversationFile(orgSlug, conversationId, {
      path: input.path,
      deletePath: true,
    })
    return
  }
  if (input.op === "rename") {
    await putConversationFile(orgSlug, conversationId, {
      path: input.to,
      from: input.from,
    })
    return
  }
  const to = destinationAfterMove(input.from, input.toDirectory)
  if (!to) throw new Error("Invalid move destination")
  await putConversationFile(orgSlug, conversationId, {
    path: to,
    from: input.from,
  })
}

export async function pushConversationBranch(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationPushResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].push.$post({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, { message: "Failed to push conversation branch" })
}

export async function fetchConversationPullRequest(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationPullRequestResponse | null> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ]["pull-request"].$get({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, {
    emptyOn: [404],
    empty: null,
    message: "Failed to load pull request",
  })
}

export async function createConversationPullRequest(
  orgSlug: string,
  conversationId: string,
  input?: { title?: string; body?: string },
): Promise<ConversationPullRequestResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ]["pull-request"].$post({
    param: { orgSlug, conversationId },
    json: input ?? {},
  })
  return readApiJson(res, { message: "Failed to create pull request" })
}

function retrySandboxUntilReady(failureCount: number, error: Error) {
  return error instanceof ApiError && error.status === 409 && failureCount < 8
}

export function conversationGitTreeOptions(
  orgSlug: string,
  conversationId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationGitTree(orgSlug, conversationId),
    queryFn: () => fetchConversationGitTree(orgSlug, conversationId),
    retry: retrySandboxUntilReady,
    retryDelay: 1000,
  })
}

export function conversationGitBlobOptions(
  orgSlug: string,
  conversationId: string,
  path: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationGitBlob(orgSlug, conversationId, path),
    queryFn: () => fetchConversationGitBlob(orgSlug, conversationId, path),
  })
}

export function conversationGitStatusOptions(
  orgSlug: string,
  conversationId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
    queryFn: () => fetchConversationGitStatus(orgSlug, conversationId),
    retry: retrySandboxUntilReady,
    retryDelay: 1000,
  })
}

export function conversationGitDiffOptions(
  orgSlug: string,
  conversationId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationGitDiff(orgSlug, conversationId),
    queryFn: () => fetchConversationGitDiff(orgSlug, conversationId),
    retry: retrySandboxUntilReady,
    retryDelay: 1000,
  })
}

export function conversationPullRequestOptions(
  orgSlug: string,
  conversationId: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationPullRequest(orgSlug, conversationId),
    queryFn: () => fetchConversationPullRequest(orgSlug, conversationId),
    enabled,
    retry: false,
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
