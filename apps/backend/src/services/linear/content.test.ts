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
import { buildLinearMirror } from "./content.js"
import { resetLinearGraphqlForTests } from "./graphql.js"

const calls: LinearGraphqlCall[] = []
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
let issuePages = 0
let commentPages = 0

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

function projectNode(id = "project-1") {
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
    teams: emptyLinearPage([{ id: "team-1" }]),
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
      return { team: { projects: emptyLinearPage([projectNode()]) } }
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

describe("buildLinearMirror", () => {
  it("pages issues once per page and follows a comment thread once", async () => {
    const result = await buildLinearMirror({
      env: {} as Env,
      connection,
      config: config([teamScope]),
    })

    expect(result.failures).toEqual([])
    expect(
      calls.filter((call) => call.name === "TeamIssuesWithNeeds"),
    ).toHaveLength(2)
    expect(commentPages).toBe(1)
    expect(calls.filter((call) => call.name === "IssueComments")).toHaveLength(
      1,
    )
    expect(
      result.files.some((file) => file.path.includes("pro-1--issue-1")),
    ).toBe(true)
  })

  it("does not list project issues for a project already covered by its team", async () => {
    const result = await buildLinearMirror({
      env: {} as Env,
      connection,
      config: config([
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
      ]),
    })

    expect(result.failures).toEqual([])
    expect(calls.some((call) => call.name.startsWith("ProjectIssues"))).toBe(
      false,
    )
    expect(calls.some((call) => call.name.startsWith("ProjectRecord"))).toBe(
      false,
    )
  })

  it("pages project issues when the project is in scope without its team", async () => {
    const result = await buildLinearMirror({
      env: {} as Env,
      connection,
      config: config([
        {
          externalId: "project-9",
          type: "project",
          title: "Launch",
          url: null,
          parentExternalId: null,
          teamId: null,
          teamKey: null,
        },
      ]),
    })

    expect(result.failures).toEqual([])
    expect(calls.map((call) => call.name)).toContain("ProjectIssuesWithNeeds")
    expect(calls.some((call) => call.name.startsWith("TeamIssues"))).toBe(false)
  })
})
