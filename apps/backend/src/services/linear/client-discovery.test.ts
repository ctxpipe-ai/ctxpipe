import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { discoverLinearScopes } from "./client.js"

const sdk = vi.hoisted(() => ({
  client: {
    teams: vi.fn(),
    projects: vi.fn(),
    documents: vi.fn(),
    initiatives: vi.fn(),
  },
}))

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    teams = sdk.client.teams
    projects = sdk.client.projects
    documents = sdk.client.documents
    initiatives = sdk.client.initiatives
  },
}))

function page<T>(nodes: T[]) {
  return {
    nodes,
    pageInfo: { hasNextPage: false },
    fetchNext: vi.fn(),
  }
}

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
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearConnection

beforeEach(() => {
  vi.clearAllMocks()
  const team = {
    id: "team-1",
    key: "PRO",
    name: "Product",
    url: "https://linear.app/acme/team/PRO",
  }
  sdk.client.teams.mockResolvedValue(page([team]))
  sdk.client.projects.mockResolvedValue(
    page([
      {
        id: "project-1",
        name: "Launch",
        url: "https://linear.app/acme/project/launch",
        teams: vi.fn().mockResolvedValue(page([team])),
      },
    ]),
  )
  sdk.client.documents.mockResolvedValue(
    page([
      {
        id: "document-1",
        title: "Architecture",
        url: "https://linear.app/acme/document/architecture",
        projectId: "project-1",
      },
    ]),
  )
  sdk.client.initiatives.mockResolvedValue(
    page([
      {
        id: "initiative-1",
        name: "FY27",
        url: "https://linear.app/acme/initiative/fy27",
      },
    ]),
  )
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
      expect.objectContaining({
        externalId: "project-1",
        type: "project",
        parentExternalId: "team-1",
      }),
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
  })
})
