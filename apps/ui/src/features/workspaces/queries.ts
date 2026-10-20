import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query"
import type { WorkspaceSourceChangeResult } from "backend/routes/v1/workspace-sources-contract"
import type {
  ConversationDetail,
  ConversationListItem,
} from "@/features/chat/types"
import { getApiClient } from "@/lib/api"
import {
  ApiError,
  apiFetch,
  pollWhileOk,
  readApiJson,
  retryQuery,
} from "@/lib/api-result"
import {
  readConversationGitTreeSnapshot,
  writeConversationGitTreeSnapshot,
} from "./conversation-git-tree-snapshot"
import { destinationAfterMove } from "./fileTreeMutations"
import type {
  ConversationFileMutation,
  ConversationFileWriteResponse,
  ConversationGitDiffResponse,
  ConversationGitStatusResponse,
  ConversationGitTreeResponse,
  ConversationPullRequestResponse,
  ConversationPushResponse,
  ConversationTurnChangesResponse,
  Workspace,
  WorkspaceActivityResponse,
  WorkspaceDetail,
  WorkspaceFileJobRequest,
  WorkspaceGitBlobResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitTreeResponse,
  WorkspaceGraphPayload,
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
  conversationStart: (orgSlug: string, conversationId: string) =>
    ["conversation-start", orgSlug, conversationId] as const,
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
  activity: (orgSlug: string, workspaceSlug: string, date: string | null) =>
    ["workspace-activity", orgSlug, workspaceSlug, date] as const,
  orgActivity: (orgSlug: string, date: string | null) =>
    ["org-activity", orgSlug, date] as const,
  activityCommits: (
    orgSlug: string,
    workspaceSlug: string | null,
    filters: ActivityCommitFilters,
  ) => ["activity-commits", orgSlug, workspaceSlug, filters] as const,
  conversationGitTree: (orgSlug: string, conversationId: string) =>
    ["conversation-git-tree", orgSlug, conversationId] as const,
  conversationGitBlob: (
    orgSlug: string,
    conversationId: string,
    path: string,
  ) => ["conversation-git-blob", orgSlug, conversationId, path] as const,
  conversationGitStatus: (orgSlug: string, conversationId: string) =>
    ["conversation-git-status", orgSlug, conversationId] as const,
  conversationGitDiff: (
    orgSlug: string,
    conversationId: string,
    turn?: string,
  ) => ["conversation-git-diff", orgSlug, conversationId, turn ?? ""] as const,
  /** Matches the full diff and each turn diff of the conversation. */
  conversationGitDiffs: (orgSlug: string, conversationId: string) =>
    ["conversation-git-diff", orgSlug, conversationId] as const,
  conversationTurnChanges: (orgSlug: string, conversationId: string) =>
    ["conversation-turn-changes", orgSlug, conversationId] as const,
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
  return readApiJson(res, {
    message: "Failed to load Workspaces",
  })
}

async function fetchConversation(
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
  const data = await readApiJson(res, {
    emptyOn: [404],
    empty: null,
    message: "Failed to load conversation",
  })
  return data === null
    ? null
    : { ...data, messages: data.messages as ConversationDetail["messages"] }
}

export async function renameConversation(
  orgSlug: string,
  conversationId: string,
  name: string,
): Promise<ConversationListItem> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].$patch({
    param: { orgSlug, conversationId },
    json: { name },
  })
  return readApiJson(res, {
    message: "Failed to rename conversation",
  })
}

/**
 * Deletes a conversation. A 404 means it is already gone, which is the result
 * the caller wants. A 409 (`turn_running`) means a turn still runs in it.
 */
export async function deleteConversation(
  orgSlug: string,
  conversationId: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].$delete({
    param: { orgSlug, conversationId },
  })
  await readApiJson(res, {
    emptyOn: [404],
    empty: undefined,
    message: "Failed to delete conversation",
  })
}

export function workspaceChatPrepareOptions(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.chatPrepare(orgSlug, conversationId, workspaceId),
    queryFn: async () => {
      await prepareWorkspaceChat(orgSlug, conversationId, workspaceId)
      return null
    },
    staleTime: Number.POSITIVE_INFINITY,
    // The composer prepares before the session mounts and observes this
    // query. Keep the result in between, so the session does not prepare
    // again.
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

async function prepareWorkspaceChat(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].prepare.$post(
    {
      param: { orgSlug, conversationId },
      json: { workspaceId },
    },
    {
      // The answer comes when the sandbox is ready. A new hosted sandbox
      // takes 40 seconds or more, which is longer than the default timeout.
      // The backend closes an idle connection after 255 seconds.
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        apiFetch(input, { ...init, timeoutMs: 240_000 }),
    },
  )
  if (!res.ok) {
    // The server explains refusals people can act on (e.g. at capacity).
    const body = (await res.json().catch(() => null)) as {
      error?: unknown
    } | null
    throw new Error(
      res.status === 429 && typeof body?.error === "string"
        ? body.error
        : "Failed to prepare workspace chat",
    )
  }
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
  return readApiJson(res, {
    emptyOn: [409],
    empty: { sha: "", paths: [] },
    message: "Failed to load Workspace files",
  })
}

async function fetchWorkspaceGitBlob(
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
  return readApiJson(res, {
    emptyOn: [404],
    empty: { path, body: null, binary: false },
    message: "Failed to load file",
  })
}

async function fetchWorkspaceGitStatus(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceGitStatusResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].files.status.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson(res, {
    message: "Failed to load git status",
  })
}

/** The graph route answers `building` while the graph of the active revision builds. */
type WorkspaceGraphRead = WorkspaceGraphPayload | { building: true }

export function workspaceGraphBuilding(
  read: WorkspaceGraphRead | undefined,
): read is { building: true } {
  return Boolean(read && "building" in read)
}

async function fetchWorkspaceGraph(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceGraphRead> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].graph.$get({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson(res, {
    message: "Failed to load Workspace graph",
  })
}

async function fetchWorkspace(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceDetail | null> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"].$get(
    {
      param: { orgSlug, workspaceSlug },
    },
  )
  return readApiJson(res, {
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
    queryFn: async ({ client }) => {
      const fetched = await fetchConversation(
        orgSlug,
        conversationId,
        workspaceId,
      )
      if (fetched) return fetched
      return (
        client.getQueryData<ConversationDetail>(
          workspaceKeys.conversation(orgSlug, conversationId, workspaceId),
        ) ?? null
      )
    },
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
    // Read again until the graph that builds is there.
    refetchInterval: (query) =>
      workspaceGraphBuilding(query.state.data) ? 2000 : false,
  })
}

async function fetchWorkspaceActivity(
  orgSlug: string,
  workspaceSlug: string,
  date: string | null = null,
): Promise<WorkspaceActivityResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].activity.$get({
    param: { orgSlug, workspaceSlug },
    query: date ? { date } : {},
  })
  return readApiJson(res, {
    message: "Failed to load workspace activity",
  })
}

async function fetchOrgActivity(
  orgSlug: string,
  date: string | null,
): Promise<WorkspaceActivityResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.activity.$get({
    param: { orgSlug },
    query: date ? { date } : {},
  })
  return readApiJson(res, {
    message: "Failed to load activity",
  })
}

/**
 * The filters of the Home commit list. `date` is one UTC day (the heatmap
 * day). `since` and `until` are UTC days, both inclusive.
 */
export type ActivityCommitFilters = {
  author?: string
  date?: string
  since?: string
  until?: string
}

/** The page size of the Home commit list. */
const ACTIVITY_COMMITS_PAGE_SIZE = 10

/**
 * The recent commits of one workspace, or (`workspaceSlug: null`) of every
 * workspace in the org, page by page. Each page holds the response of one
 * activity read; `recent` is the commits of that page.
 */
export function activityCommitsOptions(
  orgSlug: string,
  workspaceSlug: string | null,
  filters: ActivityCommitFilters,
) {
  return infiniteQueryOptions({
    queryKey: workspaceKeys.activityCommits(orgSlug, workspaceSlug, filters),
    queryFn: async ({ pageParam }) => {
      const query = {
        ...filters,
        limit: String(ACTIVITY_COMMITS_PAGE_SIZE),
        ...(pageParam ? { cursor: pageParam } : {}),
      }
      const client = await getApiClient()
      const res =
        workspaceSlug === null
          ? await client[":orgSlug"].api.v1.activity.$get({
              param: { orgSlug },
              query,
            })
          : await client[":orgSlug"].api.v1.workspaces[
              ":workspaceSlug"
            ].activity.$get({ param: { orgSlug, workspaceSlug }, query })
      return readApiJson(res, {
        message: "Failed to load commits",
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
}

/**
 * After a delete, remove the Workspace from the cached list before Home
 * renders, and drop the cached org activity. Home keeps a query fresh for a
 * minute, so without this it shows the deleted Workspace again.
 */
export async function forgetDeletedWorkspace(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceId: string,
) {
  await queryClient.cancelQueries({ queryKey: workspaceKeys.list(orgSlug) })
  queryClient.setQueryData<WorkspaceListResponse>(
    workspaceKeys.list(orgSlug),
    (list) =>
      list && {
        ...list,
        items: list.items.filter((item) => item.id !== workspaceId),
      },
  )
  // Every day of the org activity: the key prefix without the date.
  queryClient.removeQueries({ queryKey: ["org-activity", orgSlug] })
  queryClient.removeQueries({ queryKey: ["activity-commits", orgSlug] })
}

/** When the org activity read first listed a pending workspace, per query. */
const orgActivityPendingSince = new WeakMap<object, number>()

/**
 * The commit activity of one workspace, or (`workspaceSlug: null`) of every
 * workspace in the org. `date` (`YYYY-MM-DD`, UTC) limits `recent` to the
 * commits of that day.
 */
export function activityOptions(
  orgSlug: string,
  workspaceSlug: string | null,
  date: string | null = null,
) {
  return queryOptions({
    queryKey:
      workspaceSlug === null
        ? workspaceKeys.orgActivity(orgSlug, date)
        : workspaceKeys.activity(orgSlug, workspaceSlug, date),
    queryFn: () =>
      workspaceSlug === null
        ? fetchOrgActivity(orgSlug, date)
        : fetchWorkspaceActivity(orgSlug, workspaceSlug, date),
    refetchInterval: (query) => {
      const data = query.state.data
      // The read of one day does not poll. The read without a day polls.
      if (date !== null) return false
      // All workspaces: poll slowly while a workspace is pending, for about
      // 3 minutes from when the pending list became non-empty.
      if (workspaceSlug === null) {
        if (!data?.pendingWorkspaces?.length) {
          orgActivityPendingSince.delete(query)
          return false
        }
        const since = orgActivityPendingSince.get(query) ?? Date.now()
        orgActivityPendingSince.set(query, since)
        return Date.now() - since < 180_000 ? pollWhileOk(10_000)(query) : false
      }
      return data?.status === "pending" ? pollWhileOk(2000)(query) : false
    },
  })
}

/**
 * A 409 from a Files read. `busy`: a turn holds the conversation
 * (`turn_running`), so a later read can succeed. Other 409s (for example
 * `missing_sandbox`) do not end on their own.
 */
type ConversationFilesBlocked = { blocked: true; busy: boolean }

async function readConversationFilesBlocked(
  res: Response,
): Promise<ConversationFilesBlocked> {
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return { blocked: true, busy: body.error === "turn_running" }
}

async function fetchConversationGitTree(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationGitTreeResponse | ConversationFilesBlocked> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.tree.$get({
    param: { orgSlug, conversationId },
  })
  if (res.status === 409) return readConversationFilesBlocked(res)
  return readApiJson(res, { message: "Failed to load conversation files" })
}

async function fetchConversationGitBlob(
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

async function fetchConversationGitStatus(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationGitStatusResponse | ConversationFilesBlocked> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.status.$get({
    param: { orgSlug, conversationId },
  })
  if (res.status === 409) return readConversationFilesBlocked(res)
  return readApiJson(res, {
    message: "Failed to load conversation git status",
  })
}

async function fetchConversationGitDiff(
  orgSlug: string,
  conversationId: string,
  turn?: string,
): Promise<ConversationGitDiffResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.diff.$get({
    param: { orgSlug, conversationId },
    query: turn ? { turn } : {},
  })
  // A rebuilt sandbox no longer has the turn's snapshots.
  if (res.status === 410) return { items: [], gone: true }
  return readApiJson(res, { message: "Failed to load conversation diff" })
}

async function putConversationFile(
  orgSlug: string,
  conversationId: string,
  input: ConversationFileMutation,
): Promise<ConversationFileWriteResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].files.blob.$put({
    param: { orgSlug, conversationId },
    json: input,
  })
  return readApiJson(res, {
    message: "Failed to save conversation file",
  })
}

export function conversationWorktreeVersionFromCache(
  client: QueryClient,
  orgSlug: string,
  conversationId: string,
): string | undefined {
  const tree = client.getQueryData<ConversationGitTreeResponse>(
    workspaceKeys.conversationGitTree(orgSlug, conversationId),
  )
  if (tree?.worktreeVersion) return tree.worktreeVersion
  return client.getQueryData<ConversationGitStatusResponse>(
    workspaceKeys.conversationGitStatus(orgSlug, conversationId),
  )?.worktreeVersion
}

export async function resolveConversationWorktreeVersion(
  client: QueryClient,
  orgSlug: string,
  conversationId: string,
): Promise<string> {
  const cached = conversationWorktreeVersionFromCache(
    client,
    orgSlug,
    conversationId,
  )
  if (cached) return cached
  const tree = await fetchConversationGitTree(orgSlug, conversationId)
  if ("blocked" in tree || !tree.worktreeVersion) {
    throw new Error("Conversation worktree version is missing")
  }
  client.setQueryData(
    workspaceKeys.conversationGitTree(orgSlug, conversationId),
    {
      ...tree,
      ready: true,
    },
  )
  return tree.worktreeVersion
}

export function applyConversationFileWriteSnapshot(
  client: QueryClient,
  orgSlug: string,
  conversationId: string,
  snapshot: ConversationFileWriteResponse,
  expectedWorktreeVersion?: string,
) {
  const current = conversationWorktreeVersionFromCache(
    client,
    orgSlug,
    conversationId,
  )
  if (
    current &&
    expectedWorktreeVersion &&
    current !== expectedWorktreeVersion &&
    current !== snapshot.worktreeVersion
  ) {
    return
  }
  client.setQueryData(
    workspaceKeys.conversationGitTree(orgSlug, conversationId),
    { ...snapshot.tree, ready: true },
  )
  writeConversationGitTreeSnapshot(conversationId, {
    ...snapshot.tree,
    ready: true,
  })
  client.setQueryData(
    workspaceKeys.conversationGitStatus(orgSlug, conversationId),
    snapshot.status,
  )
  client.setQueryData(
    workspaceKeys.conversationGitBlob(orgSlug, conversationId, snapshot.path),
    {
      path: snapshot.path,
      body: snapshot.body,
      binary: snapshot.binary,
    },
  )
  void client.invalidateQueries({
    queryKey: workspaceKeys.conversationGitDiff(orgSlug, conversationId),
  })
}

/** A finished chat turn can change files: reload what the panes show. */
export function refreshConversationAfterTurn(
  client: QueryClient,
  orgSlug: string,
  conversationId: string,
) {
  return Promise.all(
    [
      workspaceKeys.conversationGitTree(orgSlug, conversationId),
      workspaceKeys.conversationGitStatus(orgSlug, conversationId),
      workspaceKeys.conversationTurnChanges(orgSlug, conversationId),
      workspaceKeys.conversationGitDiffs(orgSlug, conversationId),
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
  )
}

/**
 * The backend names a new conversation in parallel with its first turn. A
 * title that is not ready at the final event is saved later, and nothing more
 * comes on the stream. Read the conversation until it has a name, and return
 * that name. Returns null when no name shows up or the signal aborts.
 */
export async function waitForConversationTitle(
  orgSlug: string,
  conversationId: string,
  workspaceId: string,
  options: { signal: AbortSignal; attempts?: number; delayMs?: number },
): Promise<string | null> {
  const { signal, attempts = 6, delayMs = 1500 } = options
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    if (signal.aborted) return null
    const detail = await fetchConversation(
      orgSlug,
      conversationId,
      workspaceId,
    ).catch(() => null)
    const name = detail?.conversation.name
    if (name && !isDefaultConversationName(name)) return name
  }
  return null
}

/** The labels of a conversation that has no title yet, as on the backend. */
export function isDefaultConversationName(name: string | null | undefined) {
  return !name || name === "New conversation" || name === "New Chat"
}

export async function persistConversationFileMutation(
  orgSlug: string,
  conversationId: string,
  input: WorkspaceFileJobRequest,
  expectedWorktreeVersion: string,
): Promise<ConversationFileWriteResponse> {
  const expected = { expectedWorktreeVersion }
  if (input.op === "save") {
    return putConversationFile(orgSlug, conversationId, {
      path: input.path,
      body: input.content,
      ...expected,
    })
  }
  if (input.op === "create") {
    const path = input.kind === "folder" ? `${input.path}/.gitkeep` : input.path
    return putConversationFile(orgSlug, conversationId, {
      path,
      body: input.content ?? "",
      ...expected,
    })
  }
  if (input.op === "delete") {
    return putConversationFile(orgSlug, conversationId, {
      path: input.path,
      deletePath: true,
      ...expected,
    })
  }
  if (input.op === "rename") {
    return putConversationFile(orgSlug, conversationId, {
      path: input.to,
      from: input.from,
      ...expected,
    })
  }
  const to = destinationAfterMove(input.from, input.toDirectory)
  if (!to) throw new Error("Invalid move destination")
  return putConversationFile(orgSlug, conversationId, {
    path: to,
    from: input.from,
    ...expected,
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

async function fetchConversationPullRequest(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationPullRequestResponse | null> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[":conversationId"][
    "pull-request"
  ].$get({
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
  input?: { title?: string },
): Promise<ConversationPullRequestResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[":conversationId"][
    "pull-request"
  ].$post({
    param: { orgSlug, conversationId },
    json: input ?? {},
  })
  return readApiJson(res, { message: "Failed to create pull request" })
}

/** Query data for a Files read. `busy`: the last read got 409 turn_running. */
type PolledFiles<T> = T & { busy?: boolean }

export function conversationGitTreeOptions(
  orgSlug: string,
  conversationId: string,
) {
  return queryOptions<
    PolledFiles<ConversationGitTreeResponse>,
    Error,
    PolledFiles<ConversationGitTreeResponse>,
    ReturnType<typeof workspaceKeys.conversationGitTree>
  >({
    queryKey: workspaceKeys.conversationGitTree(orgSlug, conversationId),
    queryFn: async ({
      client,
    }): Promise<PolledFiles<ConversationGitTreeResponse>> => {
      const tree = await fetchConversationGitTree(orgSlug, conversationId)
      if ("blocked" in tree) {
        const { busy } = tree
        const cached = client.getQueryData<ConversationGitTreeResponse>(
          workspaceKeys.conversationGitTree(orgSlug, conversationId),
        )
        if (cached && cached.ready !== false) return { ...cached, busy }
        return {
          sha: "HEAD",
          paths: [],
          // Unknown until the sandbox answers.
          branch: "",
          ready: false,
          busy,
        }
      }
      const listed = { ...tree, ready: true }
      writeConversationGitTreeSnapshot(conversationId, listed)
      return listed
    },
    // 409 turn_running: a turn holds the conversation. Ask again.
    refetchInterval: (query) => (query.state.data?.busy ? 2000 : false),
    placeholderData: (previousData): ConversationGitTreeResponse | undefined =>
      readConversationGitTreeSnapshot(conversationId) ?? previousData,
    initialData: (): ConversationGitTreeResponse | undefined =>
      readConversationGitTreeSnapshot(conversationId),
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

class ConversationSandboxBusy extends Error {
  /** The backend answered 409. The error reporter treats it as expected. */
  readonly status = 409
  constructor() {
    super("Conversation sandbox is not ready")
  }
}

export function conversationGitStatusOptions(
  orgSlug: string,
  conversationId: string,
) {
  return queryOptions<
    PolledFiles<ConversationGitStatusResponse>,
    Error,
    PolledFiles<ConversationGitStatusResponse>,
    ReturnType<typeof workspaceKeys.conversationGitStatus>
  >({
    queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
    queryFn: async ({
      client,
    }): Promise<PolledFiles<ConversationGitStatusResponse>> => {
      const status = await fetchConversationGitStatus(orgSlug, conversationId)
      if ("blocked" in status) {
        if (!status.busy) {
          throw Object.assign(new Error("Conversation sandbox is not ready"), {
            status: 409,
          })
        }
        const cached = client.getQueryData<ConversationGitStatusResponse>(
          workspaceKeys.conversationGitStatus(orgSlug, conversationId),
        )
        if (cached) return { ...cached, busy: true }
        throw new ConversationSandboxBusy()
      }
      return status
    },
    // 409 turn_running: a turn holds the conversation. Ask again.
    refetchInterval: (query) =>
      query.state.data?.busy ||
      query.state.error instanceof ConversationSandboxBusy
        ? 2000
        : false,
  })
}

export function conversationGitDiffOptions(
  orgSlug: string,
  conversationId: string,
  turn?: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.conversationGitDiff(orgSlug, conversationId, turn),
    queryFn: () => fetchConversationGitDiff(orgSlug, conversationId, turn),
  })
}

async function fetchConversationTurnChanges(
  orgSlug: string,
  conversationId: string,
): Promise<ConversationTurnChangesResponse> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.conversations[
    ":conversationId"
  ].turns.$get({
    param: { orgSlug, conversationId },
  })
  return readApiJson(res, { message: "Failed to load the turn changes" })
}

/** The files each turn changed. A finished turn invalidates this query. */
export function conversationTurnChangesOptions(
  orgSlug: string,
  conversationId: string,
  /** False while the conversation has no server row: the route answers 404. */
  enabled = true,
) {
  return queryOptions({
    enabled,
    queryKey: workspaceKeys.conversationTurnChanges(orgSlug, conversationId),
    queryFn: () => fetchConversationTurnChanges(orgSlug, conversationId),
    // A turn records its changes just before it ends, and the backend answers
    // 409 until then. Ask again: the card shows when the turn is done.
    retry: (count, error) =>
      error instanceof ApiError && error.status === 409
        ? count < 30
        : retryQuery(count, error),
    retryDelay: (count, error) =>
      error instanceof ApiError && error.status === 409
        ? 1000
        : Math.min(1000 * 2 ** count, 30_000),
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
    rootPath?: string
  },
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces.$post({
    param: { orgSlug },
    json: input,
  })
  return readApiJson(res, { message: "Failed to create Workspace" })
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
    rootPath?: string
  },
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].$patch({
    param: { orgSlug, workspaceSlug },
    json: input,
  })
  return readApiJson(res, { message: "Failed to update Workspace" })
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
  await readApiJson(res, { message: "Failed to delete Workspace" })
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
  await readApiJson(res, {
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
  return readApiJson(res, {
    message: "Failed to retry Workspace prepare",
  })
}

/** Clears a failed write-access check and starts a new one. */
export async function checkWorkspaceWriteAccess(
  orgSlug: string,
  workspaceSlug: string,
): Promise<Workspace> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "check-write-access"
  ].$post({
    param: { orgSlug, workspaceSlug },
  })
  return readApiJson(res, {
    message: "Failed to check write access",
  })
}

export async function unlinkWorkspaceRepository(
  orgSlug: string,
  workspaceSlug: string,
  linkedId: string,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"][
    "linked-repositories"
  ][":linkedId"].$delete({
    param: { orgSlug, workspaceSlug, linkedId },
  })
  return readApiJson(res, {
    message: "Failed to unlink repository",
  })
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
