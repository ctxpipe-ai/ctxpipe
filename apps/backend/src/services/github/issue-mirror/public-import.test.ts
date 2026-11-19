import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { describe, expect, it } from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import { importPublicGithubIssues } from "./public-import.js"

const API = "https://api.github.com"
const server = useMswServer()

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    node_id: `I_${number}`,
    number,
    html_url: `https://github.com/acme/api/issues/${number}`,
    title: `Problem ${number}`,
    body: "Steps to see it.",
    state: "open",
    state_reason: null,
    user: { login: "bob", type: "User" },
    labels: [{ name: "bug" }],
    assignees: [{ login: "carol" }],
    comments: 0,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    closed_at: null,
    ...overrides,
  }
}

function comment(createdAt: string, body: string, user = "carol") {
  return { user: { login: user, type: "User" }, body, created_at: createdAt }
}

/**
 * Serves `pages` of the issue list with a `Link` header, as GitHub does,
 * and the comments of each issue. Returns the requested URLs.
 */
function serve(
  pages: unknown[][],
  comments: Record<number, unknown[]> = {},
): string[] {
  const requests: string[] = []
  server.use(
    http.get(`${API}/repos/acme/api/issues`, ({ request }) => {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const page = Number(url.searchParams.get("page") ?? "1")
      const headers: Record<string, string> = {}
      if (page < pages.length) {
        url.searchParams.set("page", String(page + 1))
        headers.link = `<${url.toString()}>; rel="next"`
      }
      return HttpResponse.json(pages[page - 1] ?? [], { headers })
    }),
    http.get(
      `${API}/repos/acme/api/issues/:number/comments`,
      ({ params, request }) => {
        requests.push(new URL(request.url).pathname)
        return HttpResponse.json(comments[Number(params.number)] ?? [])
      },
    ),
  )
  return requests
}

async function importAll(input: {
  until: string
  since?: string
  limit?: number
}) {
  const files = []
  for await (const file of importPublicGithubIssues({
    octokit: new Octokit(),
    repository: "acme/api",
    until: new Date(input.until),
    since: input.since ? new Date(input.since) : undefined,
    limit: input.limit,
  }))
    files.push(file)
  return files
}

describe("importPublicGithubIssues", () => {
  it("writes the file that the production issue mirror writes", async () => {
    serve(
      [
        [
          issue(7, {
            state: "closed",
            state_reason: "completed",
            closed_at: "2026-03-03T00:00:00Z",
            updated_at: "2026-03-03T00:00:00Z",
            user: { login: "renovate[bot]", type: "Bot" },
            comments: 1,
          }),
        ],
      ],
      { 7: [comment("2026-03-02T00:00:00Z", "Fixed on main.")] },
    )

    const files = await importAll({ until: "2026-06-01T00:00:00Z" })

    expect(files).toEqual([
      {
        path: "github/issues/acme/api/7.md",
        content: `---
source: github
type: issue
id: I_7
number: 7
repository: acme/api
url: https://github.com/acme/api/issues/7
title: Problem 7
state: closed
stateReason: completed
author: renovate[bot]
authorType: bot
labels:
  - bug
assignees:
  - carol
createdAt: 2026-03-01T00:00:00Z
updatedAt: 2026-03-03T00:00:00Z
closedAt: 2026-03-03T00:00:00Z
closedBy: []
---

# Problem 7

Steps to see it.

## Comments

### 2026-03-02T00:00:00Z · carol

Fixed on main.
`,
      },
    ])
  })

  it("shows each issue as it was at the cut-off date", async () => {
    serve(
      [
        [
          issue(9, { created_at: "2026-06-02T00:00:00Z" }),
          issue(8, {
            state: "closed",
            state_reason: "not_planned",
            closed_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
            comments: 2,
          }),
        ],
      ],
      {
        8: [
          comment("2026-05-01T00:00:00Z", "Before the cut-off."),
          comment("2026-06-15T00:00:00Z", "After the cut-off."),
        ],
      },
    )

    const files = await importAll({ until: "2026-06-01T00:00:00Z" })

    expect(files.map((file) => file.path)).toEqual([
      "github/issues/acme/api/8.md",
    ])
    const [content] = files.map((file) => file.content)
    expect(content).toContain("state: open\nstateReason: null\n")
    expect(content).toContain("updatedAt: 2026-06-01T00:00:00Z\n")
    expect(content).toContain("closedAt: null\n")
    expect(content).toContain("Before the cut-off.")
    expect(content).not.toContain("After the cut-off.")
  })

  it("skips pull requests, follows pages and stops at the start date", async () => {
    const requests = serve([
      [issue(5), issue(4, { pull_request: { url: "x" } })],
      [
        issue(3, { created_at: "2026-02-01T00:00:00Z" }),
        issue(2, { created_at: "2026-01-01T00:00:00Z" }),
      ],
      [issue(1, { created_at: "2025-12-01T00:00:00Z" })],
    ])

    const files = await importAll({
      until: "2026-06-01T00:00:00Z",
      since: "2026-01-15T00:00:00Z",
    })

    expect(files.map((file) => file.path)).toEqual([
      "github/issues/acme/api/5.md",
      "github/issues/acme/api/3.md",
    ])
    // The import ends at the first older issue and reads no more pages.
    expect(requests).toEqual([
      "/repos/acme/api/issues?state=all&sort=created&direction=desc&per_page=100",
      "/repos/acme/api/issues?state=all&sort=created&direction=desc&per_page=100&page=2",
    ])
  })

  it("stops at the limit", async () => {
    serve([[issue(3), issue(2), issue(1)]])

    const files = await importAll({ until: "2026-06-01T00:00:00Z", limit: 2 })

    expect(files).toHaveLength(2)
  })

  it("keeps the 100 most recent comments and counts the others", async () => {
    serve([[issue(6, { comments: 101 })]], {
      6: Array.from({ length: 101 }, (_, i) =>
        comment(
          `2026-03-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
          `Comment ${i}.`,
        ),
      ),
    })

    const [file] = await importAll({ until: "2026-06-01T00:00:00Z" })

    expect(file?.content).toContain("_1 older comment is not mirrored.")
    expect(file?.content).not.toContain("Comment 0.")
    expect(file?.content).toContain("Comment 100.")
  })
})
