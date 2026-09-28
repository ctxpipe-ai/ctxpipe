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
  installLinearGraphql(server, calls, (call) => {
    if (call.name === "DiscoverTeams") {
      return {
        teams: emptyLinearPage([{ id: "team-1", key: "PRO", name: "Product" }]),
      }
    }
    if (call.name === "DiscoverProjects") {
      return {
        projects: emptyLinearPage(
          Array.from({ length: 5 }, (_, index) => ({
            id: `project-${index + 1}`,
            name: index === 0 ? "Launch" : `Project ${index + 1}`,
            url: "https://linear.app/acme/project/launch",
            teams: {
              nodes: [{ id: "team-1", key: "PRO" }],
            },
          })),
        ),
      }
    }
    if (call.name === "DiscoverDocuments") {
      return {
        documents: emptyLinearPage([
          {
            id: "document-1",
            title: "Architecture",
            url: "https://linear.app/acme/document/architecture",
            project: { id: "project-1" },
          },
        ]),
      }
    }
    if (call.name === "DiscoverInitiatives") {
      return {
        initiatives: emptyLinearPage([
          {
            id: "initiative-1",
            name: "FY27",
            url: "https://linear.app/acme/initiative/fy27",
          },
        ]),
      }
    }
    return {}
  })
})

describe("discoverLinearScopes", () => {
  it("normalises selectable entities and their parent team context", async () => {
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
    expect(calls.map((call) => call.name).sort()).toEqual([
      "DiscoverDocuments",
      "DiscoverInitiatives",
      "DiscoverProjects",
      "DiscoverTeams",
    ])
    const projects = calls.find((call) => call.name === "DiscoverProjects")
    expect(projects?.query).toContain("teams(first: 1)")
    expect(calls).toHaveLength(4)
  })
})
