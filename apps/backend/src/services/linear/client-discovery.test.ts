import { beforeEach, describe, expect, it } from "vitest"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { discoverLinearScopes } from "./client.js"
import { resetLinearGraphqlForTests } from "./graphql.js"

const calls: LinearGraphqlCall[] = []
let projectHasNextPage = false
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

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
  repositoryId: null,
  branch: null,
  enabled: true,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearConnection

beforeEach(() => {
  resetLinearGraphqlForTests()
  calls.length = 0
  projectHasNextPage = false
  installLinearGraphql(server, calls, (call) => {
    if (call.name !== "DiscoverScopes") return {}
    const projectsAfter = call.variables.projectsAfter
    return {
      ...(call.variables.includeTeams
        ? {
            teams: emptyLinearPage([
              { id: "team-1", key: "PRO", name: "Product" },
            ]),
          }
        : {}),
      ...(call.variables.includeProjects
        ? {
            projects:
              projectsAfter == null
                ? {
                    nodes: Array.from({ length: 5 }, (_, index) => ({
                      id: `project-${index + 1}`,
                      name: index === 0 ? "Launch" : `Project ${index + 1}`,
                      url: "https://linear.app/acme/project/launch",
                      teams: {
                        nodes: [{ id: "team-1", key: "PRO" }],
                      },
                    })),
                    pageInfo: {
                      hasNextPage: projectHasNextPage,
                      endCursor: projectHasNextPage ? "projects-2" : null,
                    },
                  }
                : emptyLinearPage([
                    {
                      id: "project-6",
                      name: "Follow-up",
                      url: "https://linear.app/acme/project/follow-up",
                      teams: {
                        nodes: [{ id: "team-1", key: "PRO" }],
                      },
                    },
                  ]),
          }
        : {}),
      ...(call.variables.includeDocuments
        ? {
            documents: emptyLinearPage([
              {
                id: "document-1",
                title: "Architecture",
                url: "https://linear.app/acme/document/architecture",
                project: { id: "project-1" },
              },
            ]),
          }
        : {}),
      ...(call.variables.includeInitiatives
        ? {
            initiatives: emptyLinearPage([
              {
                id: "initiative-1",
                name: "FY27",
                url: "https://linear.app/acme/initiative/fy27",
              },
            ]),
          }
        : {}),
    }
  })
})

describe("discoverLinearScopes", () => {
  it("loads teams, projects, documents, and initiatives in one query", async () => {
    const scopes = await discoverLinearScopes({
      env: {} as Env,
      connection: { ...connection },
    })

    expect(scopes).toEqual([
      expect.objectContaining({
        externalId: "team-1",
        type: "team",
        teamKey: "PRO",
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        expect.objectContaining({
          externalId: `project-${index + 1}`,
          type: "project",
          parentExternalId: "team-1",
        }),
      ),
      expect.objectContaining({
        externalId: "document-1",
        type: "document",
        parentExternalId: "project-1",
        teamKey: "PRO",
      }),
      expect.objectContaining({
        externalId: "initiative-1",
        type: "initiative",
      }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe("DiscoverScopes")
    expect(calls[0]?.query).toContain("teams(first: 1)")
    expect(calls[0]?.variables).toMatchObject({
      includeTeams: true,
      includeProjects: true,
      includeDocuments: true,
      includeInitiatives: true,
    })
  })

  it("pages a long list with the same query and skips lists that already finished", async () => {
    projectHasNextPage = true
    const scopes = await discoverLinearScopes({
      env: {} as Env,
      connection: { ...connection },
    })

    expect(scopes.filter((scope) => scope.type === "project")).toHaveLength(6)
    expect(calls.map((call) => call.name)).toEqual([
      "DiscoverScopes",
      "DiscoverScopes",
    ])
    expect(calls[1]?.query).toBe(calls[0]?.query)
    expect(calls[1]?.variables).toMatchObject({
      includeTeams: false,
      includeProjects: true,
      includeDocuments: false,
      includeInitiatives: false,
      projectsAfter: "projects-2",
    })
  })
})
