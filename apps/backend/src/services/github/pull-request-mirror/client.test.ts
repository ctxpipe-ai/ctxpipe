import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import {
  fetchMergedPullRequestPage,
  fetchPullRequestsByNumber,
} from "./client.js"

const API = "https://api.github.com"
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

function connection<T>(nodes: T[], hasNextPage = false) {
  return { pageInfo: { hasNextPage }, nodes }
}

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    databaseId: number * 10,
    number,
    url: `https://github.com/acme/api/pull/${number}`,
    title: `Change ${number}`,
    body: "",
    state: "MERGED",
    merged: true,
    isDraft: false,
    author: { login: "renovate", __typename: "Bot" },
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: `change-${number}`,
    headRefOid: "b".repeat(40),
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    mergedAt: "2026-03-02T00:00:00Z",
    labels: connection([{ name: "backend" }]),
    reviewRequests: connection([]),
    // Relations a page carries inline; adding records adds no request.
    files: connection(
      Array.from({ length: 30 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        changeType: i === 0 ? "ADDED" : "MODIFIED",
      })),
    ),
    reviews: connection([
      {
        databaseId: 1,
        author: { login: "bob", __typename: "User" },
        state: "APPROVED",
        body: "",
        submittedAt: "2026-03-02T00:00:00Z",
      },
    ]),
    comments: connection(
      Array.from({ length: 12 }, (_, i) => ({
        databaseId: 100 + i,
        author: { login: "carol", __typename: "User" },
        body: `Comment ${i}`,
        createdAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}Z`,
      })),
    ),
    reviewThreads: connection([
      {
        comments: connection([
          {
            databaseId: 500,
            author: { login: "bob", __typename: "User" },
            body: "Nit",
            createdAt: "2026-03-01T12:00:00Z",
            path: "src/file-1.ts",
            line: 3,
            originalLine: 3,
          },
        ]),
      },
    ]),
    ...overrides,
  }
}

function countGraphql(
  respond: (variables: Record<string, unknown>) => unknown,
) {
  const calls: Array<Record<string, unknown>> = []
  server.use(
    http.post(`${API}/graphql`, async ({ request }) => {
      const body = (await request.json()) as {
        variables: Record<string, unknown>
      }
      calls.push(body.variables)
      return HttpResponse.json({ data: respond(body.variables) })
    }),
  )
  return calls
}

const octokit = new Octokit({ auth: "fixture-only-token" })

describe("fetchMergedPullRequestPage", () => {
  it("reads a page of pull requests and their relations in one request, the next page in one more", async () => {
    const calls = countGraphql((variables) => ({
      repository: {
        pullRequests: {
          pageInfo: {
            hasNextPage: variables.after === null,
            endCursor: variables.after === null ? "cursor-1" : null,
          },
          nodes: variables.after === null ? [pull(1), pull(2)] : [pull(3)],
        },
      },
    }))
    const first = await fetchMergedPullRequestPage({
      octokit,
      owner: "acme",
      repo: "api",
      first: 2,
      after: null,
    })
    expect(calls).toHaveLength(1)
    expect(first.nextAfter).toBe("cursor-1")
    expect(first.snapshots.map((snapshot) => snapshot.number)).toEqual([1, 2])
    expect(first.snapshots[0]).toMatchObject({
      id: 10,
      repository: "acme/api",
      merged: true,
      author: { login: "renovate[bot]", type: "bot" },
      labels: ["backend"],
    })
    expect(first.snapshots[0]?.files).toHaveLength(30)
    expect(first.snapshots[0]?.comments).toHaveLength(13)
    expect(first.snapshots[0]?.comments.at(-1)).toMatchObject({
      kind: "review",
      path: "src/file-1.ts",
      line: 3,
    })

    const second = await fetchMergedPullRequestPage({
      octokit,
      owner: "acme",
      repo: "api",
      first: 2,
      after: "cursor-1",
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ after: "cursor-1", first: 2 })
    expect(second).toMatchObject({ nextAfter: null })
  })

  it("reads one pull request over REST only when the page cannot carry it", async () => {
    countGraphql(() => ({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            pull(1),
            pull(2, {
              files: connection([
                { path: "src/new.ts", changeType: "RENAMED" },
              ]),
            }),
          ],
        },
      },
    }))
    const rest: string[] = []
    server.use(
      http.get(`${API}/repos/acme/api/pulls/2/files`, ({ request }) => {
        rest.push(request.url)
        return HttpResponse.json([
          {
            filename: "src/new.ts",
            previous_filename: "src/old.ts",
            status: "renamed",
          },
        ])
      }),
      http.get(`${API}/repos/acme/api/pulls/2/reviews`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API}/repos/acme/api/pulls/2/comments`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API}/repos/acme/api/issues/2/comments`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API}/repos/acme/api/pulls/2`, () =>
        HttpResponse.json({
          id: 20,
          number: 2,
          html_url: "https://github.com/acme/api/pull/2",
          title: "Rename",
          state: "closed",
          merged: true,
          draft: false,
          user: { login: "alice", type: "User" },
          base: { ref: "main", sha: "a" },
          head: { ref: "rename", sha: "b" },
          merged_at: "2026-03-02T00:00:00Z",
        }),
      ),
    )
    const page = await fetchMergedPullRequestPage({
      octokit,
      owner: "acme",
      repo: "api",
      first: 20,
      after: null,
    })
    expect(rest).toHaveLength(1)
    expect(page.snapshots[1]?.files).toEqual([
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ])
  })
})

describe("fetchPullRequestsByNumber", () => {
  it("reads the named pull requests in one request and skips missing ones", async () => {
    const calls = countGraphql(() => ({
      repository: { pr7: pull(7), pr8: null },
    }))
    const snapshots = await fetchPullRequestsByNumber({
      octokit,
      owner: "acme",
      repo: "api",
      numbers: [7, 8, 7],
    })
    expect(calls).toHaveLength(1)
    expect(snapshots.map((snapshot) => snapshot.number)).toEqual([7])
  })
})
