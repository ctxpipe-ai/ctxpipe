import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import type { CommitFile } from "../installation-write-client.js"
import { fetchGithubIssue, fetchGithubIssues } from "./client.js"
import { mirrorGithubIssues, type RunStep } from "./sync.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

function connection<T>(items: T[], offset: number, first: number) {
  const end = offset + first
  return {
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: end < items.length ? String(end) : null,
    },
    nodes: items.slice(offset, end),
  }
}

const comments = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    author: { login: "alice", __typename: "User" },
    body: `comment ${i}`,
    createdAt: "2026-03-01T00:00:00Z",
  }))

const issueNode = (
  repository: string,
  number: number,
  commentCount: number,
) => ({
  id: `I_${number}`,
  number,
  url: `https://github.com/${repository}/issues/${number}`,
  title: `Issue ${number}`,
  body: "Body",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-02T00:00:00Z",
  closedAt: null,
  author: null,
  labels: { nodes: [{ name: "bug" }] },
  assignees: { nodes: [] },
  comments: connection(comments(commentCount), 0, 100),
  closedByPullRequestsReferences: {
    nodes: [{ url: `https://github.com/${repository}/pull/${number + 100}` }],
  },
})

type Call = { operation: string; variables: Record<string, unknown> }

/**
 * GitHub GraphQL over `repository → comment count of issue #1, #2, …`.
 * A repository mapped to a status answers with that HTTP status; one that is
 * missing answers like an App without Issues: Read.
 */
function githubGraphql(repositories: Record<string, number[] | number>) {
  const calls: Call[] = []
  server.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const body = (await request.json()) as {
        query: string
        variables: Record<string, unknown>
      }
      const operation = /query (\w+)/.exec(body.query)?.[1] ?? ""
      const { variables } = body
      calls.push({ operation, variables })
      const repository = `${variables.owner}/${variables.repo}`
      const counts = repositories[repository]
      if (typeof counts === "number") {
        return HttpResponse.json({ message: "Bad gateway" }, { status: counts })
      }
      if (!counts) {
        return HttpResponse.json({
          data: { repository: { issues: null } },
          errors: [
            {
              type: "FORBIDDEN",
              path: ["repository", "issues"],
              message: "Resource not accessible by integration",
            },
          ],
        })
      }
      const offset = Number(variables.after ?? 0)
      const number = Number(variables.number)
      const data =
        operation === "GithubIssuePage"
          ? {
              issues: connection(
                counts.map((count, i) => issueNode(repository, i + 1, count)),
                offset,
                Number(variables.first),
              ),
            }
          : operation === "GithubIssueComments"
            ? {
                issue: {
                  comments: connection(
                    comments(counts[number - 1] ?? 0),
                    offset,
                    100,
                  ),
                },
              }
            : { issue: issueNode(repository, number, counts[number - 1] ?? 0) }
      return HttpResponse.json({ data: { repository: data } })
    }),
  )
  const octokit = new Octokit({
    auth: "test-token",
    retry: { enabled: false },
    throttle: { enabled: false },
  })
  return { graphql: octokit.graphql, calls }
}

describe("fetchGithubIssues", () => {
  it("reads one request per 50 issues with their comments inlined", async () => {
    const github = githubGraphql({ "acme/api": Array(60).fill(3) })

    const issues = await fetchGithubIssues({
      graphql: github.graphql,
      repository: "acme/api",
      max: 200,
    })

    expect(issues).toHaveLength(60)
    expect(issues[0]?.comments).toHaveLength(3)
    expect(github.calls.map((call) => call.operation)).toEqual([
      "GithubIssuePage",
      "GithubIssuePage",
    ])
  })

  it("adds one request per further 100 comments, not one per comment", async () => {
    const github = githubGraphql({ "acme/api": [1, 250] })

    const issues = await fetchGithubIssues({
      graphql: github.graphql,
      repository: "acme/api",
      max: 200,
    })

    expect(issues[1]?.comments).toHaveLength(250)
    expect(github.calls.map((call) => call.operation)).toEqual([
      "GithubIssuePage",
      "GithubIssueComments",
      "GithubIssueComments",
    ])
  })

  it("stops at the per-repository cap", async () => {
    const github = githubGraphql({ "acme/api": Array(120).fill(0) })

    const issues = await fetchGithubIssues({
      graphql: github.graphql,
      repository: "acme/api",
      max: 60,
    })

    expect(issues).toHaveLength(60)
    expect(github.calls.map((call) => call.variables.first)).toEqual([50, 10])
  })

  it("keeps a page when only a closing pull request is unreadable", async () => {
    const calls: unknown[] = []
    server.use(
      http.post("https://api.github.com/graphql", () => {
        calls.push(1)
        const node = {
          ...issueNode("acme/api", 1, 0),
          closedByPullRequestsReferences: { nodes: [null] },
        }
        return HttpResponse.json({
          data: {
            repository: { issues: connection([node], 0, 50) },
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
        })
      }),
    )
    const octokit = new Octokit({
      auth: "test-token",
      retry: { enabled: false },
      throttle: { enabled: false },
    })

    const issues = await fetchGithubIssues({
      graphql: octokit.graphql,
      repository: "acme/api",
      max: 200,
    })

    expect(issues.map((issue) => issue.closedBy)).toEqual([[]])
    expect(calls).toHaveLength(1)
  })
})

describe("fetchGithubIssue", () => {
  it("reads one issue in one request plus one per further 100 comments", async () => {
    const github = githubGraphql({ "acme/api": [0, 150] })

    const issue = await fetchGithubIssue({
      graphql: github.graphql,
      repository: "acme/api",
      number: 2,
    })

    expect(issue.comments).toHaveLength(150)
    expect(issue.author).toEqual({ login: "ghost", type: "human" })
    expect(issue.closedBy).toEqual(["https://github.com/acme/api/pull/102"])
    expect(github.calls).toHaveLength(2)
  })
})

describe("mirrorGithubIssues", () => {
  /** OpenWorkflow-like steps: a stored name returns its stored value without running. */
  function durableSteps(stored: Map<string, unknown>) {
    const names: string[] = []
    const runStep: RunStep = async (name, run) => {
      names.push(name)
      if (stored.has(name)) return structuredClone(stored.get(name)) as never
      const value = await run()
      stored.set(name, structuredClone(value))
      return value
    }
    return { runStep, names }
  }

  function recordCommits() {
    const commits: Array<{ repository: string; paths: string[] }> = []
    const commit = async (repository: string, files: CommitFile[]) => {
      commits.push({ repository, paths: files.map((file) => file.path) })
    }
    return { commits, commit }
  }

  it("commits each repository in its own step and skips one the App cannot read", async () => {
    const github = githubGraphql({ "acme/api": [0, 0], "acme/web": [0] })
    const steps = durableSteps(new Map())
    const { commits, commit } = recordCommits()

    const result = await mirrorGithubIssues({
      graphql: github.graphql,
      repositories: ["acme/api", "acme/private", "acme/web"],
      maxIssuesPerRepository: 200,
      runStep: steps.runStep,
      commit,
    })

    expect(steps.names).toEqual([
      "issues-acme/api",
      "issues-acme/private",
      "issues-acme/web",
    ])
    expect(commits).toEqual([
      {
        repository: "acme/api",
        paths: ["github/issues/acme/api/1.md", "github/issues/acme/api/2.md"],
      },
      { repository: "acme/web", paths: ["github/issues/acme/web/1.md"] },
    ])
    expect(result).toEqual({ written: 3, failedRepositories: ["acme/private"] })
  })

  it("does not skip a repository when a permission error comes with another error", async () => {
    server.use(
      http.post("https://api.github.com/graphql", () =>
        HttpResponse.json({
          data: { repository: { issues: null } },
          errors: [
            { type: "FORBIDDEN", path: ["repository", "issues"], message: "x" },
            { type: "SERVICE_UNAVAILABLE", path: ["repository"], message: "y" },
          ],
        }),
      ),
    )
    const octokit = new Octokit({
      auth: "test-token",
      retry: { enabled: false },
      throttle: { enabled: false },
    })

    await expect(
      mirrorGithubIssues({
        graphql: octokit.graphql,
        repositories: ["acme/api"],
        maxIssuesPerRepository: 200,
        runStep: durableSteps(new Map()).runStep,
        commit: recordCommits().commit,
      }),
    ).rejects.toThrow()
  })

  it("fails the run on any other GitHub error instead of skipping", async () => {
    const github = githubGraphql({ "acme/api": 502 })

    await expect(
      mirrorGithubIssues({
        graphql: github.graphql,
        repositories: ["acme/api"],
        maxIssuesPerRepository: 200,
        runStep: durableSteps(new Map()).runStep,
        commit: recordCommits().commit,
      }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it("does not read or commit again a repository stored before a crash", async () => {
    const github = githubGraphql({ "acme/api": [0, 0], "acme/web": [0] })
    const stored = new Map<string, unknown>()
    const { commits, commit } = recordCommits()
    const { runStep } = durableSteps(stored)
    const crashing: RunStep = async (name, run) => {
      if (name === "issues-acme/web") throw new Error("worker crashed")
      return runStep(name, run)
    }
    const run = (step: RunStep) =>
      mirrorGithubIssues({
        graphql: github.graphql,
        repositories: ["acme/api", "acme/web"],
        maxIssuesPerRepository: 200,
        runStep: step,
        commit,
      })
    await expect(run(crashing)).rejects.toThrow("worker crashed")
    const callsBeforeReplay = github.calls.length

    const result = await run(durableSteps(stored).runStep)

    expect(result.written).toBe(3)
    expect(github.calls.slice(callsBeforeReplay)).toEqual([
      expect.objectContaining({
        variables: expect.objectContaining({ repo: "web" }),
      }),
    ])
    expect(commits.map((entry) => entry.repository)).toEqual([
      "acme/api",
      "acme/web",
    ])
  })
})
