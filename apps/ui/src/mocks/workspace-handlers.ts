import { delay, HttpResponse, http } from "msw"
import type {
  ConversationDetail,
  ConversationListItem,
  PageInfo,
} from "@/features/chat/types"
import type {
  Workspace,
  WorkspaceDetail,
  WorkspaceFilesResponse,
  WorkspaceGraphPayload,
} from "@/features/workspaces/types"
import {
  docsConversationDetail,
  docsConversations,
  docsWorkspace,
  docsWorkspaceDetail,
  docsWorkspaceFiles,
  docsWorkspaceGraph,
  eligibleGithubRepos,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

const emptyPageInfo: PageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
}

export function workspaceListHandler(
  items: Workspace[],
  lastUsedWorkspaceId: string | null = items[0]?.id ?? null,
) {
  return http.get(
    ({ request }) => /\/api\/v1\/workspaces$/.test(pathnameOf(request)),
    () => HttpResponse.json({ items, lastUsedWorkspaceId }),
  )
}

export function workspaceDetailHandler(detail: WorkspaceDetail | null) {
  return http.get(
    ({ request }) => /\/api\/v1\/workspaces\/[^/]+$/.test(pathnameOf(request)),
    () => {
      if (!detail) {
        return HttpResponse.json({ error: "not found" }, { status: 404 })
      }
      return HttpResponse.json(detail)
    },
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

export const workspaceTouchHandler = http.post(
  ({ request }) =>
    /\/api\/v1\/workspaces\/[^/]+\/touch$/.test(pathnameOf(request)),
  () => new HttpResponse(null, { status: 204 }),
)

export function workspaceFilesHandler(
  files: WorkspaceFilesResponse = docsWorkspaceFiles,
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files$/.test(pathnameOf(request)),
    () => HttpResponse.json(files),
  )
}

export function workspaceFilesLoadingHandler() {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/files$/.test(pathnameOf(request)),
    async () => {
      await delay("infinite")
      return HttpResponse.json(docsWorkspaceFiles)
    },
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

export function githubInstallationReposHandler(
  repositories: { name: string; clone_url: string }[] = eligibleGithubRepos,
) {
  return http.get(
    ({ request }) =>
      pathnameOf(request).endsWith("/api/v1/github/installation/repositories"),
    () => HttpResponse.json({ repositories }),
  )
}

export function workspaceShellHandlers(input?: {
  workspaces?: Workspace[]
  detail?: WorkspaceDetail | null
  conversations?: ConversationListItem[]
  conversation?: ConversationDetail | null
  files?: WorkspaceFilesResponse
  graph?: WorkspaceGraphPayload
}) {
  const workspaces = input?.workspaces ?? [docsWorkspace, readOnlyWorkspace]
  const detail = input && "detail" in input ? input.detail : docsWorkspaceDetail
  return [
    workspaceListHandler(workspaces),
    workspaceDetailHandler(detail ?? null),
    workspaceTouchHandler,
    conversationsListHandler(input?.conversations ?? docsConversations),
    conversationDetailHandler(
      input && "conversation" in input
        ? (input.conversation ?? null)
        : docsConversationDetail,
    ),
    workspaceFilesHandler(input?.files ?? docsWorkspaceFiles),
    workspaceGraphHandler(input?.graph ?? docsWorkspaceGraph),
  ]
}
