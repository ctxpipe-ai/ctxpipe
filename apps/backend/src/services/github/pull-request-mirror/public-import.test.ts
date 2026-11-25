import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { expect, it } from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import { importPublicGithubPullRequests } from "./public-import.js"

/*
 * The public pull request import of an eval twin (CTX-1661) against the
 * GitHub API in msw. The corpus test (`knowledge-corpus.test.ts`) checks
 * the files; this test checks the stop on pending review comments.
 */

const API = "https://api.github.com"
const server = useMswServer()

const page = <T>(nodes: T[], hasNextPage = false) => ({
  pageInfo: { hasNextPage },
  nodes,
})

it("stops when the pending review comments of the token owner do not fit in one page", async () => {
  server.use(
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: false, visibility: "public" }),
    ),
    http.get(`${API}/repos/acme/api/pulls`, () =>
      HttpResponse.json([
        {
          number: 7,
          created_at: "2026-05-01T00:00:00Z",
          closed_at: "2026-05-02T00:00:00Z",
          draft: false,
        },
      ]),
    ),
    http.post(`${API}/graphql`, async ({ request }) => {
      const { query } = (await request.json()) as { query: string }
      if (query.includes("PendingComments"))
        return HttpResponse.json({
          data: {
            repository: {
              p7: {
                reviews: page([{ comments: page([{ databaseId: 3 }], true) }]),
              },
            },
          },
        })
      return HttpResponse.json({
        data: {
          repository: {
            pr7: {
              databaseId: 700,
              number: 7,
              title: "Add typing events",
              state: "MERGED",
              merged: true,
              createdAt: "2026-05-01T00:00:00Z",
              updatedAt: "2026-05-02T00:00:00Z",
              labels: page([]),
              reviewRequests: page([]),
              files: page([]),
              reviews: page([]),
              comments: page([]),
              reviewThreads: page([]),
            },
          },
        },
      })
    }),
  )

  const files = importPublicGithubPullRequests({
    octokit: new Octokit(),
    repository: "acme/api",
    until: new Date("2026-06-01T00:00:00Z"),
    limit: 5,
  })

  await expect(files.next()).rejects.toThrow(
    "Pull request 7 of acme/api has more pending review comments than one page.",
  )
})
