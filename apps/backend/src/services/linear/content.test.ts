import { beforeEach, describe, expect, it } from "vitest"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
  linearIssueData,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  collectLinearMirrorPages,
  fetchLinearMirrorPage,
  walkLinearMirrorPages,
} from "./content.js"
import { resetLinearGraphqlForTests } from "./graphql.js"

const calls: LinearGraphqlCall[] = []
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
let issuePages = 0
let commentPages = 0
let teamProjectNodes = [projectNode()]

const connection = {
  id: "con_linear",
  orgId: "org_1",
  accessToken: "access-token",
  refreshToken: null,
  accessTokenExpiresAt: null,
  workspaceId: "workspace-1",
  workspaceName: "Acme",
  workspaceUrlKey: "acme",
  actorUserId: "user-1",
  ownerUserId: "owner-1",
  status: "installed",
  lastEventPayload: null,
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearConnection

const teamScope = {
  externalId: "team-1",
  type: "team" as const,
  title: "Product",
  url: null,
  parentExternalId: null,
  teamId: "team-1",
  teamKey: "PRO",
}

function config(
  scopes: ParsedLinearRepoConfig["scopes"],
): ParsedLinearRepoConfig {
  return {
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited",
    scopes,
  }
}

function teamRecord() {
  return {
    id: "team-1",
    name: "Product",
    key: "PRO",
    description: "Product team",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    parent: null,
  }
}

function projectNode(id = "project-1", teamIds = ["team-1"]) {
  return {
    id,
    name: "Launch",
    url: "https://linear.app/acme/project/launch",
    content: "Project body",
    description: "Launch",
    priorityLabel: "High",
    progress: 0,
    startDate: null,
    targetDate: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    status: { id: "status-1" },
    lead: null,
    teams: emptyLinearPage(teamIds.map((teamId) => ({ id: teamId }))),
    projectUpdates: emptyLinearPage(),
    documents: emptyLinearPage(),
    needs: emptyLinearPage(),
  }
}

beforeEach(() => {
  resetLinearGraphqlForTests()
  calls.length = 0
  issuePages = 0
  commentPages = 0
  teamProjectNodes = [projectNode()]
  installLinearGraphql(server, calls, (call) => {
    if (call.name === "TeamRecord") return { team: teamRecord() }
    if (call.name === "TeamIssues" || call.name === "TeamIssuesWithNeeds") {
      issuePages += 1
      if (issuePages === 1 && call.variables.after == null) {
        return {
          team: {
            issues: {
              nodes: [
                linearIssueData({
                  comments: {
                    nodes: [
                      { id: "comment-1", body: "First" },
                      { id: "comment-2", body: "Second" },
                    ],
                    hasNextPage: true,
                    endCursor: "comment-cursor",
                  },
                }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "issue-cursor" },
            },
          },
        }
      }
      return { team: { issues: emptyLinearPage() } }
    }
    if (call.name === "IssueComments") {
      commentPages += 1
      return {
        issue: {
          comments: emptyLinearPage([
            {
              id: "comment-3",
              body: "Third",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              user: null,
            },
          ]),
        },
      }
    }
    if (call.name === "TeamProjects" || call.name === "TeamProjectsWithNeeds") {
      return { team: { projects: emptyLinearPage(teamProjectNodes) } }
    }
    if (call.name === "TeamCycles")
      return { team: { cycles: emptyLinearPage() } }
    if (call.name === "TeamLabels")
      return { team: { labels: emptyLinearPage() } }
    if (
      call.name === "ProjectRecord" ||
      call.name === "ProjectRecordWithNeeds"
    ) {
      return { project: projectNode(String(call.variables.id ?? "project-1")) }
    }
    if (
      call.name === "ProjectIssues" ||
      call.name === "ProjectIssuesWithNeeds"
    ) {
      return {
        project: {
          issues: emptyLinearPage([
            linearIssueData({ id: "issue-project", identifier: "PRO-9" }),
          ]),
        },
      }
    }
    if (call.name === "InitiativeRecord") {
      return {
        initiative: {
          id: "initiative-1",
          name: "Roadmap",
          url: "https://linear.app/acme/initiative/initiative-1",
          content: null,
          description: null,
          status: "Active",
          health: null,
          targetDate: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          parentInitiative: null,
          owner: null,
          initiativeUpdates: emptyLinearPage(),
        },
      }
    }
    if (call.name === "InitiativeProjects") {
      return {
        initiative: { projects: emptyLinearPage([{ id: "project-1" }]) },
      }
    }
    if (call.name === "InitiativeDocuments") {
      return { initiative: { documents: emptyLinearPage() } }
    }
    return {}
  })
})

describe("fetchLinearMirrorPage", () => {
  it("returns the next issue cursor without fetching that page", async () => {
    const page = await fetchLinearMirrorPage({
      env: {} as Env,
      connection,
      config: config([teamScope]),
      request: { kind: "team-issues", teamId: "team-1", after: null },
    })

    expect(page.nextAfter).toBe("issue-cursor")
    expect(
      calls.filter((call) => call.name === "TeamIssuesWithNeeds"),
    ).toHaveLength(1)
    expect(calls.filter((call) => call.name === "IssueComments")).toHaveLength(
      0,
    )
    expect(page.follows).toEqual([
      {
        connection: "issue-comments",
        entityId: "issue-1",
        queryId: "issue-1",
        after: "comment-cursor",
      },
    ])
    expect(
      page.files.some((file) => file.path.includes("pro-1--issue-1")),
    ).toBe(false)
    expect(page.held).toHaveLength(1)
  })
})

describe("walkLinearMirrorPages", () => {
  async function walked(scopes: ParsedLinearRepoConfig["scopes"]) {
    const names: string[] = []
    const pages = await walkLinearMirrorPages({
      config: config(scopes),
      runPage: (name, request) => {
        names.push(name)
        return fetchLinearMirrorPage({
          env: {} as Env,
          connection,
          config: config(scopes),
          request,
        })
      },
    })
    return { ...collectLinearMirrorPages(pages), names }
  }

  it("pages issues once per page and follows a comment thread in its own step", async () => {
    const result = await walked([teamScope])

    expect(result.failures).toEqual([])
    expect(
      calls.filter((call) => call.name === "TeamIssuesWithNeeds"),
    ).toHaveLength(2)
    expect(commentPages).toBe(1)
    expect(calls.filter((call) => call.name === "IssueComments")).toHaveLength(
      1,
    )
    expect(result.names).toContain(
      "team-team-1-issues-0-issue-comments-issue-1-0",
    )
    const issue = result.files.find((file) =>
      file.path.includes("pro-1--issue-1"),
    )
    expect(issue?.content).toContain("Third")
  })

  it("refetches a comment page without repeating the stored issue page", async () => {
    const stored = await fetchLinearMirrorPage({
      env: {} as Env,
      connection,
      config: config([teamScope]),
      request: { kind: "team-issues", teamId: "team-1", after: null },
    })
    calls.length = 0
    issuePages = 0
    const pages = await walkLinearMirrorPages({
      config: config([teamScope]),
      runPage: (name, request) => {
        if (name === "team-team-1-issues-0") {
          return Promise.resolve(JSON.parse(JSON.stringify(stored)))
        }
        return fetchLinearMirrorPage({
          env: {} as Env,
          connection,
          config: config([teamScope]),
          request,
        })
      },
    })
    const result = collectLinearMirrorPages(pages)

    expect(
      calls.filter(
        (call) =>
          call.name === "TeamIssuesWithNeeds" && call.variables.after == null,
      ),
    ).toHaveLength(0)
    expect(calls.filter((call) => call.name === "IssueComments")).toHaveLength(
      1,
    )
    expect(
      result.files.find((file) => file.path.includes("pro-1--issue-1"))
        ?.content,
    ).toContain("Third")
  })

  it("does not list project issues for a project already covered by its team", async () => {
    const result = await walked([
      teamScope,
      {
        externalId: "initiative-1",
        type: "initiative",
        title: "Roadmap",
        url: null,
        parentExternalId: null,
        teamId: null,
        teamKey: null,
      },
    ])

    expect(result.failures).toEqual([])
    expect(calls.some((call) => call.name.startsWith("ProjectIssues"))).toBe(
      false,
    )
    expect(calls.some((call) => call.name.startsWith("ProjectRecord"))).toBe(
      false,
    )
  })

  it("pages project issues when the project is in scope without its team", async () => {
    const result = await walked([
      {
        externalId: "project-9",
        type: "project",
        title: "Launch",
        url: null,
        parentExternalId: null,
        teamId: null,
        teamKey: null,
      },
    ])

    expect(result.failures).toEqual([])
    expect(calls.map((call) => call.name)).toContain("ProjectIssuesWithNeeds")
    expect(calls.some((call) => call.name.startsWith("TeamIssues"))).toBe(false)
  })

  it("pages issues for a selected project that also belongs to an unselected team", async () => {
    teamProjectNodes = [
      projectNode("project-1"),
      projectNode("project-2", ["team-1", "team-2"]),
    ]

    const result = await walked([
      teamScope,
      {
        externalId: "project-2",
        type: "project",
        title: "Shared",
        url: null,
        parentExternalId: null,
        teamId: null,
        teamKey: null,
      },
    ])

    expect(result.failures).toEqual([])
    expect(
      calls
        .filter((call) => call.name === "ProjectIssuesWithNeeds")
        .map((call) => call.variables.id),
    ).toEqual(["project-2"])
  })
})
