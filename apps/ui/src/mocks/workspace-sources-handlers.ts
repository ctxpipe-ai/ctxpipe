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
    path: string
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
    description: null,
    removable: true,
    revision: "a1b2c3d",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

export function workspaceSourceList(
  overrides: Partial<WorkspaceSourceListResponse> = {},
): WorkspaceSourceListResponse {
  return {
    path: "sources",
    revision: "a1b2c3d",
    fileError: null,
    canEdit: true,
    directCommitAllowed: false,
    items: [],
    pendingChanges: [],
    linkErrors: [],
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

/**
 * Records each add, edit, rename, and remove request. It answers a direct
 * commit with `commit_queued` and any other change with a pull request. The
 * result names the new path for a rename and the path of the request
 * otherwise (`sources/<provider>/new.md` for an add without a path).
 */
export function workspaceSourceChangeHandlers(
  calls: {
    method: string
    path: string
    query?: Record<string, string>
    body: unknown
  }[] = [],
) {
  const answer = async ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    const body = request.method === "DELETE" ? null : await request.json()
    calls.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    })
    const json = body as {
      path?: string
      newPath?: string
      delivery?: string
      source?: { provider?: string }
    } | null
    const path =
      json?.newPath ??
      json?.path ??
      url.searchParams.get("path") ??
      `sources/${json?.source?.provider ?? "github"}/new.md`
    const delivery =
      request.method === "DELETE"
        ? url.searchParams.get("delivery")
        : json?.delivery
    if (delivery === "commit")
      return HttpResponse.json({ outcome: "commit_queued", path })
    return HttpResponse.json({
      outcome: "pull_request",
      path,
      pullRequestUrl: "https://github.com/acme/docs/pull/7",
    })
  }
  const matches = ({ request }: { request: Request }) =>
    /\/api\/v1\/workspaces\/[^/]+\/sources(\/rename)?$/.test(
      new URL(request.url).pathname,
    )
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

/** The org role of the story user (`get-active-member-role`). */
export function activeMemberRoleHandler(role: string) {
  return http.get(
    "*/.auth/api/v1/auth/organization/get-active-member-role",
    () => HttpResponse.json({ role }),
  )
}

/**
 * "Sync now" (`POST /connectors/:id/sync`). Each request is added to
 * `requests`; the reply waits `delayMs` so a story can see the pending state.
 */
export function connectionSyncHandler(
  options: { status?: 202 | 404; delayMs?: number; requests?: string[] } = {},
) {
  return http.post(
    ({ request }) =>
      /\/api\/v1\/connectors\/[^/]+\/sync$/.test(pathnameOf(request)),
    async ({ request }) => {
      options.requests?.push(pathnameOf(request))
      if (options.delayMs) await delay(options.delayMs)
      return options.status === 404
        ? HttpResponse.json({ error: "Not found" }, { status: 404 })
        : HttpResponse.json({ accepted: true }, { status: 202 })
    },
  )
}

export function orgConnectionsHandler(
  items: Array<
    Pick<OrgConnectionListItem, "id" | "type"> &
      Partial<Pick<OrgConnectionListItem, "displayName">>
  >,
) {
  return http.get(
    ({ request }) => pathnameOf(request).endsWith("/api/v1/connectors"),
    () =>
      HttpResponse.json({
        items: items.map((item) => ({
          displayName: null,
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
    pendingChanges: [],
    ...overrides,
  }
}
