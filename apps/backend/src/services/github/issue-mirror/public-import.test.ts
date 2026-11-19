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

function event(name: string, createdAt: string, fields = {}) {
  return { event: name, created_at: createdAt, ...fields }
}

/**
 * Serves the repository, `pages` of the issue list with a `Link` header as
 * GitHub does, and the comments and events of each issue. Returns the
 * requested URLs.
 */
function serve(input: {
  pages: unknown[][]
  comments?: Record<number, unknown[]>
  events?: Record<number, unknown[]>
  visibility?: "public" | "private"
}): string[] {
  const requests: string[] = []
  const visibility = input.visibility ?? "public"
  server.use(
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: visibility === "private", visibility }),
    ),
    http.get(`${API}/repos/acme/api/issues`, ({ request }) => {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const page = Number(url.searchParams.get("page") ?? "1")
      const headers: Record<string, string> = {}
      if (page < input.pages.length) {
        url.searchParams.set("page", String(page + 1))
        headers.link = `<${url.toString()}>; rel="next"`
      }
      return HttpResponse.json(input.pages[page - 1] ?? [], { headers })
    }),
    http.get(
      `${API}/repos/acme/api/issues/:number/:kind`,
      ({ params, request }) => {
        requests.push(new URL(request.url).pathname)
        const source = params.kind === "events" ? input.events : input.comments
        return HttpResponse.json(source?.[Number(params.number)] ?? [])
      },
    ),
  )
  return requests
}

async function importAll(input: { until: string; limit?: number }) {
  const files = []
  for await (const file of importPublicGithubIssues({
    octokit: new Octokit(),
    repository: "acme/api",
    until: new Date(input.until),
    limit: input.limit,
  }))
    files.push(file)
  return files
}

const UNTIL = "2026-06-01T00:00:00Z"

describe("importPublicGithubIssues", () => {
  it("writes the file that the production issue mirror writes", async () => {
    serve({
      pages: [
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
      comments: { 7: [comment("2026-03-02T00:00:00Z", "Fixed on main.")] },
    })

    const files = await importAll({ until: UNTIL })

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
    serve({
      pages: [
        [
          issue(9, { created_at: "2026-06-02T00:00:00Z" }),
          issue(8, {
            title: "Renamed later",
            labels: [{ name: "wontfix" }],
            assignees: [],
            state: "closed",
            state_reason: "not_planned",
            closed_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
            comments: 2,
          }),
        ],
      ],
      comments: {
        8: [
          comment("2026-05-01T00:00:00Z", "Before the cut-off."),
          comment("2026-06-15T00:00:00Z", "After the cut-off."),
        ],
      },
      events: {
        8: [
          event("labeled", "2026-03-01T00:00:00Z", { label: { name: "bug" } }),
          event("unlabeled", "2026-06-20T00:00:00Z", {
            label: { name: "bug" },
          }),
          event("labeled", "2026-06-20T00:00:00Z", {
            label: { name: "wontfix" },
          }),
          event("unassigned", "2026-06-21T00:00:00Z", {
            assignee: { login: "carol" },
          }),
          event("renamed", "2026-06-22T00:00:00Z", {
            rename: { from: "Problem 8", to: "Renamed later" },
          }),
          event("closed", "2026-07-01T00:00:00Z"),
        ],
      },
    })

    const files = await importAll({ until: UNTIL })

    expect(files.map((file) => file.path)).toEqual([
      "github/issues/acme/api/8.md",
    ])
    const [content] = files.map((file) => file.content)
    expect(content).toContain(
      "title: Problem 8\nstate: open\nstateReason: null\n",
    )
    expect(content).toContain("labels:\n  - bug\nassignees:\n  - carol\n")
    expect(content).toContain("updatedAt: 2026-06-01T00:00:00Z\n")
    expect(content).toContain("closedAt: null\n")
    expect(content).toContain("Before the cut-off.")
    expect(content).not.toContain("After the cut-off.")
  })

  it("shows an issue that was closed at the cut-off and reopened later as closed", async () => {
    serve({
      pages: [[issue(6, { updated_at: "2026-07-01T00:00:00Z" })]],
      events: {
        6: [
          event("closed", "2026-04-01T00:00:00Z"),
          event("reopened", "2026-07-01T00:00:00Z"),
        ],
      },
    })

    const [file] = await importAll({ until: UNTIL })

    expect(file?.content).toContain("state: closed\nstateReason: null\n")
    expect(file?.content).toContain("closedAt: 2026-04-01T00:00:00Z\n")
  })

  it("skips pull requests, follows pages and stops at the limit", async () => {
    const requests = serve({
      pages: [
        [issue(5), issue(4, { pull_request: { url: "x" } })],
        [issue(3), issue(2)],
        [issue(1)],
      ],
    })

    const files = await importAll({ until: UNTIL, limit: 2 })

    expect(files.map((file) => file.path)).toEqual([
      "github/issues/acme/api/5.md",
      "github/issues/acme/api/3.md",
    ])
    // The import ends at the limit and reads no more pages.
    expect(requests).toEqual([
      "/repos/acme/api/issues?state=all&sort=created&direction=desc&per_page=100",
      "/repos/acme/api/issues?state=all&sort=created&direction=desc&per_page=100&page=2",
    ])
  })

  it("keeps the 100 most recent comments and counts the others", async () => {
    serve({
      pages: [[issue(6, { comments: 101 })]],
      comments: {
        6: Array.from({ length: 101 }, (_, i) =>
          comment(
            `2026-03-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
            `Comment ${i}.`,
          ),
        ),
      },
    })

    const [file] = await importAll({ until: UNTIL })

    expect(file?.content).toContain("_1 older comment is not mirrored.")
    expect(file?.content).not.toContain("Comment 0.")
    expect(file?.content).toContain("Comment 100.")
  })

  it("refuses a repository that is not public, before it reads an issue", async () => {
    const requests = serve({ pages: [[issue(1)]], visibility: "private" })

    await expect(importAll({ until: UNTIL })).rejects.toThrow(
      "acme/api is not a public repository",
    )
    expect(requests).toEqual([])
  })
})
