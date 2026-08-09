import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type {
  LinearConnection,
  LinearDirtyEntity,
} from "../../models/linear-connector.js"
import { buildLinearIncrementalChanges } from "./incremental.js"

const sdk = vi.hoisted(() => ({
  initiative: vi.fn(),
  issue: vi.fn(),
  team: vi.fn(),
}))

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    initiative = sdk.initiative
    issue = sdk.issue
    team = sdk.team
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
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearConnection

const dirtyIssue = {
  id: "dirty-1",
  connectionId: "con_linear",
  entityType: "issue",
  externalId: "issue-1",
  action: "upsert",
  firstDirtyAt: new Date(),
  lastEventAt: new Date(),
  revision: 2,
  deadLetteredAt: null,
} satisfies LinearDirtyEntity

const selectedConfig = {
  workspaceId: "workspace-1",
  workspaceName: "Acme",
  customerRequests: "limited" as const,
  scopes: [
    {
      externalId: "team-1",
      type: "team" as const,
      title: "Product",
      url: null,
      parentExternalId: null,
      teamId: "team-1",
      teamKey: "PRO",
    },
  ],
}

const linearIssue = {
  id: "issue-1",
  identifier: "PRO-1",
  title: "Changed issue",
  description: "Updated from a webhook",
  url: "https://linear.app/acme/issue/PRO-1",
  priorityLabel: "High",
  teamId: "team-1",
  projectId: null,
  cycleId: null,
  assigneeId: null,
  creatorId: "user-1",
  labelIds: [],
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  state: Promise.resolve({ name: "In Progress" }),
  comments: vi.fn().mockResolvedValue(page([])),
  attachments: vi.fn().mockResolvedValue(page([])),
  needs: vi.fn().mockResolvedValue(page([])),
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.issue.mockResolvedValue(linearIssue)
})

describe("buildLinearIncrementalChanges", () => {
  it("updates a selected team from a webhook event", async () => {
    sdk.team.mockResolvedValue({
      id: "team-1",
      key: "PRO",
      name: "Product",
      description: "Updated team description",
      parentId: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      dirty: [{ ...dirtyIssue, entityType: "team", externalId: "team-1" }],
      existingPaths: [],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/teams/product--team-1.md",
        content: expect.stringContaining("Updated team description"),
      }),
    ])
  })

  it("upserts only an entity that belongs to configured scope", async () => {
    await expect(
      buildLinearIncrementalChanges({
        env: {} as Env,
        connection,
        config: selectedConfig,
        dirty: [dirtyIssue],
        existingPaths: [],
      }),
    ).resolves.toMatchObject({
      files: [
        {
          path: "linear/issues/pro-1--issue-1.md",
          content: expect.stringContaining("Updated from a webhook"),
        },
      ],
      deletePaths: [],
      failures: [],
    })

    sdk.issue.mockResolvedValue({
      ...linearIssue,
      teamId: "team-outside-scope",
    })
    const outside = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      dirty: [dirtyIssue],
      existingPaths: ["linear/issues/old-title--issue-1.md"],
    })
    expect(outside.files).toEqual([])
    expect(outside.deletePaths).toEqual(["linear/issues/old-title--issue-1.md"])
  })

  it("deletes the stale path when an in-scope entity is renamed", async () => {
    sdk.issue.mockResolvedValue({
      ...linearIssue,
      identifier: "PRO-2",
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      dirty: [dirtyIssue],
      existingPaths: ["linear/issues/pro-1--issue-1.md"],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-2--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual(["linear/issues/pro-1--issue-1.md"])
  })

  it("deletes a matching stable-id path without fetching Linear", async () => {
    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      dirty: [{ ...dirtyIssue, action: "delete" }],
      existingPaths: [
        "linear/config.yaml",
        "linear/issues/old-title--issue-1.md",
      ],
    })

    expect(result.deletePaths).toEqual(["linear/issues/old-title--issue-1.md"])
    expect(sdk.issue).not.toHaveBeenCalled()
  })

  it("updates issues descended from a selected initiative", async () => {
    sdk.initiative.mockResolvedValue({
      projects: vi.fn().mockResolvedValue(page([{ id: "project-1" }])),
      documents: vi.fn().mockResolvedValue(page([])),
    })
    sdk.issue.mockResolvedValue({
      ...linearIssue,
      teamId: "team-outside-scope",
      projectId: "project-1",
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: {
        ...selectedConfig,
        scopes: [
          {
            externalId: "initiative-1",
            type: "initiative",
            title: "Roadmap",
            url: null,
            parentExternalId: null,
            teamId: null,
            teamKey: null,
          },
        ],
      },
      dirty: [dirtyIssue],
      existingPaths: [],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-1--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual([])
  })
})
