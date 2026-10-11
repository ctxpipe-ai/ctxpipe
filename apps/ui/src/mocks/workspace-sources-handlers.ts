import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { delay, HttpResponse, http } from "msw"
import type { OrgConnectionListItem } from "@/features/connectors/queries/org-connections"
import type {
  ConnectionUsageItem,
  WorkspaceSource,
  WorkspaceSourceListResponse,
} from "@/features/workspace-sources/queries"

/** Story fixtures and msw handlers for the Workspace sources contract. */

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

export function workspaceSourceFixture(
  overrides: Partial<WorkspaceSource> & {
    sourceKey: string
    provider: SourceProvider | null
  },
): WorkspaceSource {
  return {
    connectionId: "con_story1",
    connectionName: "Story connection",
    scope: {},
    scopeSummary: "Summary",
    status: "ok",
    statusDetail: null,
    revision: "a1b2c3d",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

export function workspaceSourceList(
  overrides: Partial<WorkspaceSourceListResponse> = {},
): WorkspaceSourceListResponse {
  return {
    path: ".ctxpipe/sources.yaml",
    revision: "a1b2c3d",
    fileError: null,
    items: [],
    pendingChanges: [],
    ...overrides,
  }
}

export function workspaceSourcesHandler(
  response: WorkspaceSourceListResponse | "loading" | "error",
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/sources$/.test(pathnameOf(request)),
    async () => {
      if (response === "loading") await delay("infinite")
      if (response === "error" || response === "loading")
        return HttpResponse.json({ error: "Server error" }, { status: 500 })
      return HttpResponse.json(response)
    },
  )
}

/** Records each add, edit, and remove request; answers with a pull request. */
export function workspaceSourceChangeHandlers(
  calls: { method: string; path: string; body: unknown }[] = [],
) {
  const answer = async ({ request }: { request: Request }) => {
    const path = pathnameOf(request)
    const body = request.method === "DELETE" ? null : await request.json()
    calls.push({ method: request.method, path, body })
    return HttpResponse.json({
      outcome: "pull_request",
      sourceKey: path.split("/").at(-1) ?? "new-source",
      pullRequestUrl: "https://github.com/acme/docs/pull/7",
    })
  }
  const matches = ({ request }: { request: Request }) =>
    /\/api\/v1\/workspaces\/[^/]+\/sources(\/[^/]+)?$/.test(pathnameOf(request))
  return [
    http.post(matches, answer),
    http.put(matches, answer),
    http.delete(matches, answer),
  ]
}

export function connectionUsageHandler(
  items: ConnectionUsageItem[] | "loading",
) {
  return http.get(
    ({ request }) =>
      /\/api\/v1\/connectors\/[^/]+\/workspaces$/.test(pathnameOf(request)),
    async () => {
      if (items === "loading") await delay("infinite")
      return HttpResponse.json({ items: items === "loading" ? [] : items })
    },
  )
}

export function orgConnectionsHandler(
  items: Array<Pick<OrgConnectionListItem, "id" | "type">>,
) {
  return http.get(
    ({ request }) => pathnameOf(request).endsWith("/api/v1/connectors"),
    () =>
      HttpResponse.json({
        items: items.map((item) => ({
          ...item,
          createdAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
        })),
      }),
  )
}

export function connectionUsageItem(
  overrides: Partial<ConnectionUsageItem> & {
    workspaceSlug: string
    workspaceName: string
  },
): ConnectionUsageItem {
  return {
    workspaceId: `ws_${overrides.workspaceSlug}`,
    stat: "1 source",
    sources: [],
    ...overrides,
  }
}
