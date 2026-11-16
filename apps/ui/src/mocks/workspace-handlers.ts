import { delay, HttpResponse, http, ws } from "msw"

import type {
  ChatMessage,
  ConversationDetail,
  ConversationListItem,
  PageInfo,
} from "@/features/chat/types"
import type {
  ConversationGitDiffResponse,
  ConversationGitStatusResponse,
  ConversationPullRequestResponse,
  ConversationTurnChangesResponse,
  Workspace,
  WorkspaceActivityResponse,
  WorkspaceDetail,
  WorkspaceFileJobRequest,
  WorkspaceFilesResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitTreeResponse,
  WorkspaceGraphPayload,
} from "@/features/workspaces/types"
import {
  docsConversationDetail,
  docsConversations,
  docsWorkspace,
  docsWorkspaceActivity,
  docsWorkspaceDetail,
  docsWorkspaceFiles,
  docsWorkspaceGitBlobs,
  docsWorkspaceGitStatus,
  docsWorkspaceGitTree,
  docsWorkspaceGraph,
  eligibleGithubRepos,
  emptyWorkspaceActivity,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"

import { type MockState, mockResponse } from "./mock-state"
import {
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "./workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradesHandler,
} from "./workspace-upgrades-handlers"

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

const emptyPageInfo: PageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
}

/**
 * `GET /workspaces`: the Workspaces of the org. The last used Workspace is
 * the first one, unless `lastUsedWorkspaceId` names another (or null).
 */
export function workspaceListHandler(
  items: MockState<Workspace[]>,
  lastUsedWorkspaceId?: string | null,
) {
  return http.get(
    ({ request }) => /\/api\/v1\/workspaces$/.test(pathnameOf(request)),
    () =>
      mockResponse(items, (items) =>
        HttpResponse.json({
          items,
          lastUsedWorkspaceId:
            lastUsedWorkspaceId === undefined
              ? (items[0]?.id ?? null)
              : lastUsedWorkspaceId,
        }),
      ),
  )
}

/**
 * `GET /workspaces/:slug`: the detail of a Workspace, or 404 for null. With
 * `workspaceSlug`, it answers only that Workspace.
 */
export function workspaceDetailHandler(
  detail: WorkspaceDetail | null,
  workspaceSlug?: string,
) {
  return http.get(
    ({ request }) =>
      workspaceSlug
        ? pathnameOf(request).endsWith(`/api/v1/workspaces/${workspaceSlug}`)
        : /\/api\/v1\/workspaces\/[^/]+$/.test(pathnameOf(request)),
    () => {
      if (!detail) {
        return HttpResponse.json({ error: "not found" }, { status: 404 })
      }
      return HttpResponse.json(detail)
    },
  )
}

export function workspaceCreateHandler(created: Workspace) {
  return http.post(
    ({ request }) => /\/api\/v1\/workspaces$/.test(pathnameOf(request)),
    () => HttpResponse.json(created, { status: 201 }),
  )
}

export function workspaceDetailLoadingHandler() {
  return http.get(
    ({ request }) => /\/api\/v1\/workspaces\/[^/]+$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsWorkspaceDetail)
    },
  )
}

export function workspaceDetailErrorHandler() {
  return http.get(
    ({ request }) => /\/api\/v1\/workspaces\/[^/]+$/.test(pathnameOf(request)),
    () => HttpResponse.json({ error: "failed" }, { status: 500 }),
  )
}

const workspaceTouchHandler = http.post(
  ({ request }) =>
    /\/api\/v1\/workspaces\/[^/]+\/touch$/.test(pathnameOf(request)),
  () => new HttpResponse(null, { status: 204 }),
)

export function workspaceGitTreeHandler(
  tree: WorkspaceGitTreeResponse = docsWorkspaceGitTree,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/tree$/.test(pathnameOf(request)),
    () => HttpResponse.json(tree),
  )
}

export function workspaceGitTreeLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/tree$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsWorkspaceGitTree)
    },
  )
}

export function workspaceGitBlobLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/blob$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json({ path: "", body: "", binary: false })
    },
  )
}

export function workspaceGitBlobHandler(
  blobs: Record<string, string> = docsWorkspaceGitBlobs,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/blob$/.test(pathnameOf(request)),
    ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? ""
      const body = blobs[path]
      if (body === undefined) {
        return HttpResponse.json({ error: "Not found" }, { status: 404 })
      }
      return HttpResponse.json({ path, body, binary: false })
    },
  )
}

export function workspaceGitStatusHandler(
  status: WorkspaceGitStatusResponse = docsWorkspaceGitStatus,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/status$/.test(pathnameOf(request)),
    () => HttpResponse.json(status),
  )
}

export function workspaceFileJobHandler(
  onJob?: (body: WorkspaceFileJobRequest) => void,
) {
  return http.post(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files\/jobs$/.test(pathnameOf(request)),
    async ({ request }) => {
      const body = (await request.json()) as WorkspaceFileJobRequest
      onJob?.(body)
      return HttpResponse.json(
        { queued: true, jobId: "wjob_story" },
        { status: 202 },
      )
    },
  )
}

function workspaceFilesHandler(
  files: WorkspaceFilesResponse = docsWorkspaceFiles,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files$/.test(pathnameOf(request)),
    () => HttpResponse.json(files),
  )
}

export function workspaceGraphHandler(
  graph: WorkspaceGraphPayload = docsWorkspaceGraph,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/graph$/.test(pathnameOf(request)),
    () => HttpResponse.json(graph),
  )
}

export function workspaceActivityHandler(
  activity: WorkspaceActivityResponse = docsWorkspaceActivity,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(pathnameOf(request)),
    () => HttpResponse.json(activity),
  )
}

/** `GET /{orgSlug}/api/v1/activity`: the activity of the org (none by default). */
export function orgActivityHandler(
  activity: MockState<WorkspaceActivityResponse> = emptyWorkspaceActivity,
) {
  return http.get(
    ({ request }) => /\/api\/v1\/activity$/.test(pathnameOf(request)),
    () => mockResponse(activity, (activity) => HttpResponse.json(activity)),
  )
}

export function workspaceActivityLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsWorkspaceActivity)
    },
  )
}

export function workspaceGraphLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/graph$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsWorkspaceGraph)
    },
  )
}

export function conversationsListHandler(
  items: ConversationListItem[],
  pageInfo = emptyPageInfo,
) {
  return http.get(
    ({ request }) => /\/api\/v1\/conversations$/.test(pathnameOf(request)),
    () => HttpResponse.json({ items, pageInfo }),
  )
}

export function conversationsListLoadingHandler() {
  return http.get(
    ({ request }) => /\/api\/v1\/conversations$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json({ items: [], pageInfo: emptyPageInfo })
    },
  )
}

export function conversationDetailHandler(detail: ConversationDetail | null) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+$/.test(pathnameOf(request)),
    () => {
      if (!detail) {
        return HttpResponse.json({ error: "not found" }, { status: 404 })
      }
      return HttpResponse.json(detail)
    },
  )
}

export function conversationPrepareHandler() {
  return http.post(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/prepare$/.test(pathnameOf(request)),
    () => new HttpResponse(null, { status: 204 }),
  )
}

export function conversationGitTreeHandler(
  tree: WorkspaceGitTreeResponse & {
    branch?: string
    worktreeVersion?: string
  } = {
    ...docsWorkspaceGitTree,
    branch: "ctxpipe/chat/conv_1/1",
    worktreeVersion: "wt-0",
  },
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(pathnameOf(request)),
    () => HttpResponse.json(tree),
  )
}

export function conversationGitTreeMissingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(pathnameOf(request)),
    () => HttpResponse.json({ error: "missing_sandbox" }, { status: 409 }),
  )
}

/**
 * A busy conversation: the tree answers 409 turn_running `missingHits` times,
 * then the tree. The Files pane asks again only on turn_running.
 */
export function conversationGitTreeEventuallyHandler(
  tree: WorkspaceGitTreeResponse & { branch?: string },
  missingHits = 2,
) {
  let hits = 0
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(pathnameOf(request)),
    async () => {
      hits += 1
      if (hits <= missingHits) {
        await delay(1500)
        return HttpResponse.json({ error: "turn_running" }, { status: 409 })
      }
      return HttpResponse.json(tree)
    },
  )
}

export function conversationGitBlobHandler(
  blobs: Record<string, string> = docsWorkspaceGitBlobs,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(pathnameOf(request)),
    ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? ""
      const body = blobs[path]
      if (body === undefined) {
        return HttpResponse.json({ error: "Not found" }, { status: 404 })
      }
      return HttpResponse.json({ path, body, binary: false })
    },
  )
}

export function conversationGitStatusHandler(
  status: MockState<ConversationGitStatusResponse> = {
    source: "sandbox",
    branch: "main",
    dirty: true,
    differsFromDefault: true,
    unpushed: true,
    published: false,
    ahead: 1,
    behind: 0,
    items: docsWorkspaceGitStatus.items,
    worktreeVersion: "wt-0",
  },
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/status$/.test(
        pathnameOf(request),
      ),
    () => mockResponse(status, (status) => HttpResponse.json(status)),
  )
}

export function conversationGitDiffHandler(
  items: ConversationGitDiffResponse["items"] = [
    {
      path: "knowledge/billing/ledger.md",
      status: "modified",
      additions: 2,
      deletions: 0,
      oldBody: docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? "",
      body: `${docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? ""}\nQueued sandbox edit.\n`,
    },
  ],
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/diff$/.test(pathnameOf(request)),
    () => HttpResponse.json({ base: "main", items }),
  )
}

export function conversationFilePutHandler() {
  return http.put(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(pathnameOf(request)),
    async ({ request }) => {
      const body = (await request.json()) as {
        path: string
        body?: string | null
        expectedWorktreeVersion?: string
        deletePath?: boolean
        from?: string
      }
      const worktreeVersion = body.expectedWorktreeVersion
        ? `${body.expectedWorktreeVersion}:saved`
        : "wt-1"
      const path = body.path
      return HttpResponse.json({
        path,
        body: body.deletePath ? null : (body.body ?? null),
        binary: false,
        worktreeVersion,
        tree: {
          sha: "sandboxsha",
          paths: [path],
          branch: "ctxpipe/chat/conv_1/1",
          worktreeVersion,
        },
        status: {
          source: "sandbox",
          branch: "ctxpipe/chat/conv_1/1",
          dirty: true,
          differsFromDefault: true,
          unpushed: true,
          published: false,
          ahead: 0,
          behind: 0,
          items: [{ path, status: "modified" }],
          worktreeVersion,
        },
      })
    },
  )
}

/**
 * `GET /conversations/:id/chat`: the transcript that the chat session loads
 * when it opens. No run streams.
 */
export function conversationChatHandler(messages: MockState<ChatMessage[]>) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/chat$/.test(pathnameOf(request)),
    () =>
      mockResponse(messages, (messages) =>
        HttpResponse.json({
          messages,
          activeRun: null,
          interrupts: null,
        }),
      ),
  )
}

/** `GET /conversations/:id/turns`: the files that each turn changed. */
const conversationTurnsHandler = http.get(
  ({ request }) =>
    /\/api\/v1\/conversations\/[^/]+\/turns$/.test(pathnameOf(request)),
  () =>
    HttpResponse.json({
      items: [],
      syncs: [],
    } satisfies ConversationTurnChangesResponse),
)

/**
 * `GET /conversations/:id/pull-request`: the pull request of the session
 * branch. `null` answers 404: the conversation has no pull request.
 */
export function conversationPullRequestHandler(
  pullRequest: MockState<ConversationPullRequestResponse | null>,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+\/pull-request$/.test(
        pathnameOf(request),
      ),
    () =>
      mockResponse(pullRequest, (pullRequest) =>
        pullRequest
          ? HttpResponse.json(pullRequest)
          : HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
  )
}

/** The pull request that a conversation detail names, or null. */
function pullRequestOf(
  detail: ConversationDetail | null,
): ConversationPullRequestResponse | null {
  const conversation = detail?.conversation
  if (!conversation?.lastChatPrNumber || !conversation.lastChatPrUrl)
    return null
  return {
    branch: conversation.lastBranch ?? "",
    prNumber: conversation.lastChatPrNumber,
    pullUrl: conversation.lastChatPrUrl,
    prState: conversation.prState ?? "open",
  }
}

/**
 * The chat socket of a conversation (`/conversations/:id`). It opens and
 * sends nothing: no run streams. A story that streams a run replaces
 * `window.WebSocket` (`installAguiWebSocket`).
 */
const conversationSocketHandler = ws
  .link(/\/api\/v1\/conversations\/[^/]+(\?.*)?$/)
  .addEventListener("connection", () => {})

export function conversationDetailLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/conversations\/[^/]+$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsConversationDetail)
    },
  )
}

export function orgGithubConnectionsHandler(
  items: Array<{ id: string }> = [{ id: "con_gh" }],
) {
  return orgConnectionsHandler(items.map(({ id }) => ({ id, type: "github" })))
}

export function githubInstallationReposHandler(
  repositories?: {
    name: string
    clone_url: string
    id?: number
    full_name?: string
  }[],
  options?: {
    repositorySelection?: string
    manageUrl?: string | null
    totalCount?: number
  },
) {
  const repos = repositories ?? eligibleGithubRepos
  return http.get(
    ({ request }) =>
      pathnameOf(request).endsWith("/api/v1/github/installation/repositories"),
    () =>
      HttpResponse.json({
        repositories: repos,
        repositorySelection: options?.repositorySelection ?? "selected",
        manageUrl:
          options && "manageUrl" in options
            ? options.manageUrl
            : "https://github.com/organizations/acme/settings/installations/123",
        hasMore: false,
        totalCount: options?.totalCount ?? repos.length,
      }),
  )
}

/**
 * The reads of the side nav of an org page: the Workspaces of the org (Docs)
 * and the chats of the open Workspace.
 */
export function sideNavHandlers() {
  return [
    workspaceListHandler([docsWorkspace]),
    conversationsListHandler(docsConversations),
  ]
}

/**
 * The reads of the Settings pane of a Workspace: its sources (none), the
 * connections of the org (GitHub), its upgrades (none) and the automatic
 * upgrades setting (manual).
 */
export function workspaceSettingsHandlers() {
  return [
    workspaceSourcesHandler(workspaceSourceList()),
    orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
    ...workspaceUpgradeAutomaticHandlers(),
  ]
}

export function workspaceShellHandlers(input?: {
  workspaces?: Workspace[]
  detail?: WorkspaceDetail | null
  conversations?: ConversationListItem[]
  conversation?: ConversationDetail | null
  files?: WorkspaceFilesResponse
  gitTree?: WorkspaceGitTreeResponse
  gitBlobs?: Record<string, string>
  gitStatus?: WorkspaceGitStatusResponse
  graph?: WorkspaceGraphPayload
}) {
  const workspaces = input?.workspaces ?? [docsWorkspace, readOnlyWorkspace]
  const detail = input && "detail" in input ? input.detail : docsWorkspaceDetail
  const conversation =
    input && "conversation" in input
      ? (input.conversation ?? null)
      : docsConversationDetail
  return [
    workspaceListHandler(workspaces),
    workspaceDetailHandler(detail ?? null),
    workspaceTouchHandler,
    conversationsListHandler(input?.conversations ?? docsConversations),
    conversationDetailHandler(conversation),
    workspaceGitTreeHandler(input?.gitTree ?? docsWorkspaceGitTree),
    workspaceGitBlobHandler(input?.gitBlobs ?? docsWorkspaceGitBlobs),
    workspaceGitStatusHandler(input?.gitStatus),
    workspaceFileJobHandler(),
    workspaceFilesHandler(input?.files ?? docsWorkspaceFiles),
    workspaceGraphHandler(input?.graph ?? docsWorkspaceGraph),
    workspaceActivityHandler(),
    conversationPrepareHandler(),
    conversationGitTreeHandler(input?.gitTree ?? docsWorkspaceGitTree),
    conversationGitBlobHandler(input?.gitBlobs ?? docsWorkspaceGitBlobs),
    conversationGitStatusHandler(),
    conversationChatHandler(conversation?.messages ?? []),
    conversationTurnsHandler,
    conversationPullRequestHandler(pullRequestOf(conversation)),
    conversationSocketHandler,
    ...workspaceSettingsHandlers(),
  ]
}
