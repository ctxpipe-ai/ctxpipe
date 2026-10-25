import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { describe, expect, it } from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import { fetchGithubIssue, fetchGithubIssuePage } from "./client.js"

const API = "https://api.github.com"
const server = useMswServer()

function connection<T>(nodes: T[], endCursor: string | null = null) {
  return { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes }
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `I_${number}`,
    number,
    url: `https://github.com/acme/api/issues/${number}`,
    title: `Problem ${number}`,
    body: "Steps to see it.",
    state: "CLOSED",
    stateReason: "COMPLETED",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    closedAt: "2026-03-02T00:00:00Z",
    author: { login: "renovate", __typename: "Bot" },
    labels: { nodes: [{ name: "bug" }] },
    assignees: { nodes: [{ login: "bob" }] },
    // Relations a page carries inline; adding records adds no request.
    comments: {
      totalCount: 12,
      ...connection(
        Array.from({ length: 12 }, (_, i) => ({
          author: { login: "carol", __typename: "User" },
          body: `Comment ${i}`,
          createdAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}Z`,
        })),
      ),
    },
    closedByPullRequestsReferences: {
      nodes: [{ url: "https://github.com/acme/api/pull/9" }],
    },
    ...overrides,
  }
}

type GraphqlBody = { query: string; variables: Record<string, unknown> }

function serveGraphql(respond: (body: GraphqlBody) => Record<string, unknown>) {
  const calls: GraphqlBody[] = []
  server.use(
    http.post(`${API}/graphql`, async ({ request }) => {
      const body = (await request.json()) as GraphqlBody
      calls.push(body)
      return HttpResponse.json(respond(body))
    }),
  )
  return calls
}

const graphql = new Octokit({ auth: "fixture-only-token" }).graphql

describe("fetchGithubIssuePage", () => {
  it("reads a page of issues and their comments in one request, the next page in one more", async () => {
    const calls = serveGraphql(({ variables }) => ({
      data: {
        repository: {
          issues:
            variables.after === null
              ? connection([issue(1), issue(2)], "cursor-1")
              : connection([issue(3, { state: "OPEN", closedAt: null })]),
        },
      },
    }))
    const first = await fetchGithubIssuePage({
      graphql,
      repository: "acme/api",
      first: 2,
      after: null,
    })
    expect(calls).toHaveLength(1)
    expect(first.nextAfter).toBe("cursor-1")
    expect(first.issues.map((snapshot) => snapshot.number)).toEqual([1, 2])
    expect(first.issues[0]).toMatchObject({
      repository: "acme/api",
      state: "closed",
      stateReason: "completed",
      // GraphQL drops the suffix that REST and the pull request mirror show.
      author: { login: "renovate[bot]", type: "bot" },
      labels: ["bug"],
      assignees: ["bob"],
      closedBy: ["https://github.com/acme/api/pull/9"],
    })
    expect(first.issues[0]?.comments).toHaveLength(12)

    const second = await fetchGithubIssuePage({
      graphql,
      repository: "acme/api",
      first: 2,
      after: "cursor-1",
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.variables).toMatchObject({ after: "cursor-1", first: 2 })
    expect(second.nextAfter).toBeNull()
    expect(second.issues[0]).toMatchObject({ state: "open", closedAt: null })
  })

  it("asks for the 100 most recent comments of each issue and reads no more", async () => {
    const calls = serveGraphql(() => ({
      data: {
        repository: {
          issues: connection([
            issue(1, {
              comments: {
                totalCount: 150,
                nodes: [
                  {
                    author: null,
                    body: "Late comment",
                    createdAt: "2026-03-03T00:00:00Z",
                  },
                ],
              },
            }),
          ]),
        },
      },
    }))
    const page = await fetchGithubIssuePage({
      graphql,
      repository: "acme/api",
      first: 50,
      after: null,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toContain("comments(last: 100)")
    // A deleted account has no author.
    expect(page.issues[0]?.commentsTotal).toBe(150)
    expect(page.issues[0]?.comments).toEqual([
      {
        author: { login: "unknown", type: "human" },
        body: "Late comment",
        createdAt: "2026-03-03T00:00:00Z",
      },
    ])
  })

  it("keeps the issues when GitHub hides a closing pull request of another repository", async () => {
    serveGraphql(() => ({
      data: {
        repository: {
          issues: connection([
            issue(1, { closedByPullRequestsReferences: { nodes: [null] } }),
          ]),
        },
      },
      errors: [
        {
          type: "FORBIDDEN",
          path: [
            "repository",
            "issues",
            "nodes",
            0,
            "closedByPullRequestsReferences",
            "nodes",
            0,
          ],
          message: "Resource not accessible by integration",
        },
      ],
    }))
    const page = await fetchGithubIssuePage({
      graphql,
      repository: "acme/api",
      first: 50,
      after: null,
    })
    expect(page.issues[0]?.closedBy).toEqual([])
  })
})

describe("fetchGithubIssue", () => {
  it("reads one issue in one request, and null when GitHub has no such issue", async () => {
    const calls = serveGraphql(({ variables }) =>
      variables.number === 7
        ? { data: { repository: { issue: issue(7) } } }
        : {
            data: { repository: { issue: null } },
            errors: [
              {
                type: "NOT_FOUND",
                path: ["repository", "issue"],
                message: "Could not resolve to an Issue",
              },
            ],
          },
    )
    expect(
      await fetchGithubIssue({ graphql, repository: "acme/api", number: 7 }),
    ).toMatchObject({ number: 7, title: "Problem 7" })
    expect(calls).toHaveLength(1)
    expect(
      await fetchGithubIssue({ graphql, repository: "acme/api", number: 8 }),
    ).toBeNull()
  })
})
