import { HttpResponse, type HttpResponseInit, http } from "msw"
import type { SetupServer } from "msw/node"

export type LinearGraphqlCall = {
  name: string
  query: string
  variables: Record<string, unknown>
}

export function linearOperationName(query: string): string {
  return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? ""
}

export function linearBudgetHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const reset = String(Date.now() + 3_600_000)
  return {
    "X-RateLimit-Requests-Limit": "5000",
    "X-RateLimit-Requests-Remaining": "4900",
    "X-RateLimit-Requests-Reset": reset,
    "X-RateLimit-Complexity-Limit": "2000000",
    "X-RateLimit-Complexity-Remaining": "1900000",
    "X-RateLimit-Complexity-Reset": reset,
    "X-Complexity": "100",
    ...overrides,
  }
}

export function installLinearGraphql(
  server: SetupServer,
  calls: LinearGraphqlCall[],
  respond: (call: LinearGraphqlCall) => unknown,
  init?: HttpResponseInit,
): void {
  server.use(
    http.post("https://api.linear.app/graphql", async ({ request }) => {
      const body = (await request.json()) as {
        query?: string
        variables?: Record<string, unknown>
      }
      const call = {
        name: linearOperationName(body.query ?? ""),
        query: body.query ?? "",
        variables: body.variables ?? {},
      }
      calls.push(call)
      return HttpResponse.json(
        { data: respond(call) },
        { headers: linearBudgetHeaders(), ...init },
      )
    }),
  )
}

export function emptyLinearPage<T>(nodes: T[] = []) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
  }
}

const actor = {
  id: "user-1",
  name: "Ada",
  displayName: "Ada",
  active: true,
  admin: false,
  guest: false,
  avatarUrl: null,
}

export function linearIssueData(
  input: {
    id?: string
    identifier?: string
    title?: string
    description?: string | null
    teamId?: string
    project?: { id: string; name: string; teamIds: string[] } | null
    attachments?: Array<{
      id: string
      title: string
      url: string
      sourceType?: string | null
      metadata?: unknown
    }>
    needs?: Array<{
      id: string
      url?: string | null
      body?: string | null
      content?: string | null
      customerId?: string | null
      projectId?: string | null
      issueId?: string | null
      priority?: number
    }>
    comments?: {
      nodes: Array<{
        id: string
        body: string
        userId?: string | null
        userName?: string | null
      }>
      hasNextPage?: boolean
      endCursor?: string | null
    }
  } = {},
) {
  return {
    id: input.id ?? "issue-1",
    identifier: input.identifier ?? "PRO-1",
    title: input.title ?? "Changed issue",
    description:
      input.description === undefined
        ? "Updated from a webhook"
        : input.description,
    url: "https://linear.app/acme/issue/PRO-1",
    priorityLabel: "High",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    state: { name: "In Progress" },
    team: {
      id: input.teamId ?? "team-1",
      key: "PRO",
      name: "Product",
    },
    project: input.project
      ? {
          id: input.project.id,
          name: input.project.name,
          teams: emptyLinearPage(input.project.teamIds.map((id) => ({ id }))),
        }
      : null,
    cycle: null,
    assignee: null,
    creator: actor,
    labels: emptyLinearPage(),
    comments: {
      nodes: (input.comments?.nodes ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        user: comment.userId
          ? {
              ...actor,
              id: comment.userId,
              displayName: comment.userName ?? "Ada",
              name: comment.userName ?? "Ada",
            }
          : null,
      })),
      pageInfo: {
        hasNextPage: input.comments?.hasNextPage ?? false,
        endCursor: input.comments?.endCursor ?? null,
      },
    },
    attachments: emptyLinearPage(
      (input.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        title: attachment.title,
        url: attachment.url,
        sourceType: attachment.sourceType ?? null,
        metadata: attachment.metadata ?? null,
      })),
    ),
    needs: emptyLinearPage(
      (input.needs ?? []).map((need) => ({
        id: need.id,
        url: need.url ?? null,
        body: need.body ?? null,
        content: need.content ?? null,
        priority: need.priority ?? 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        customer: need.customerId ? { id: need.customerId } : null,
        issue: { id: need.issueId ?? input.id ?? "issue-1" },
        project: need.projectId ? { id: need.projectId } : null,
        creator: null,
      })),
    ),
  }
}
