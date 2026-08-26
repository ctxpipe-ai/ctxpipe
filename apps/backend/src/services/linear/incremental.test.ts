import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import {
  buildLinearIncrementalChanges,
  type LinearEntityChange,
} from "./incremental.js"

const sdk = vi.hoisted(() => ({
  initiative: vi.fn(),
  issue: vi.fn(),
  team: vi.fn(),
}))
const downloadConnectorAsset = vi.hoisted(() => vi.fn())

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    initiative = sdk.initiative
    issue = sdk.issue
    team = sdk.team
  },
}))
vi.mock("../connectors/assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/assets.js")>()),
  downloadConnectorAsset,
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

const issueChange = {
  entityType: "issue",
  externalId: "issue-1",
  action: "upsert",
} satisfies LinearEntityChange

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
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  state: Promise.resolve({ name: "In Progress" }),
  team: Promise.resolve({ id: "team-1", key: "PRO", name: "Product" }),
  project: Promise.resolve(undefined),
  cycle: Promise.resolve(undefined),
  assignee: Promise.resolve(undefined),
  creator: Promise.resolve({
    id: "user-1",
    displayName: "Ada",
    name: "Ada",
  }),
  labels: vi.fn().mockResolvedValue(page([])),
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
      entities: [{ ...issueChange, entityType: "team", externalId: "team-1" }],
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
        entities: [issueChange],
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
      entities: [issueChange],
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
      entities: [issueChange],
      existingPaths: ["linear/issues/pro-1--issue-1.md"],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-2--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual(["linear/issues/pro-1--issue-1.md"])
  })

  it("deletes sibling assets with the markdown file on rename", async () => {
    sdk.issue.mockResolvedValue({
      ...linearIssue,
      identifier: "PRO-2",
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [
        "linear/issues/pro-1--issue-1.md",
        "linear/issues/pro-1--issue-1/assets/attachment-4--diagram.png",
      ],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-2--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual([
      "linear/issues/pro-1--issue-1.md",
      "linear/issues/pro-1--issue-1/assets/attachment-4--diagram.png",
    ])
  })

  it("prunes stale sibling assets that are no longer in the desired set", async () => {
    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [
        "linear/issues/pro-1--issue-1.md",
        "linear/issues/pro-1--issue-1/assets/stale--old.png",
      ],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-1--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual([
      "linear/issues/pro-1--issue-1/assets/stale--old.png",
    ])
  })

  it("preserves the prior binary when an incremental asset download fails", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    sdk.issue.mockResolvedValue({
      ...linearIssue,
      identifier: "ENG-1",
      attachments: vi.fn().mockResolvedValue(
        page([
          {
            id: "attachment-4",
            title: "diagram.png",
            url: "https://uploads.linear.app/acme/diagram.png",
            sourceType: "upload",
            metadata: null,
          },
        ]),
      ),
    })
    const preserved =
      "linear/issues/pro-1--issue-1/assets/attachment-4--diagram.png"

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [
        "linear/issues/pro-1--issue-1.md",
        preserved,
        "linear/issues/pro-1--issue-1/assets/removed--old.png",
      ],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/eng-1--issue-1.md",
      }),
    ])
    expect(result.deletePaths).not.toContain(preserved)
    expect(result.deletePaths).toContain("linear/issues/pro-1--issue-1.md")
    expect(result.deletePaths).toContain(
      "linear/issues/pro-1--issue-1/assets/removed--old.png",
    )
  })

  it("deletes a matching stable-id path without fetching Linear", async () => {
    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [{ ...issueChange, action: "delete" }],
      existingPaths: [
        "linear/config.yaml",
        "linear/issues/old-title--issue-1.md",
      ],
    })

    expect(result.deletePaths).toEqual(["linear/issues/old-title--issue-1.md"])
    expect(sdk.issue).not.toHaveBeenCalled()
  })

  it("deletes sibling assets without fetching Linear", async () => {
    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [{ ...issueChange, action: "delete" }],
      existingPaths: [
        "linear/config.yaml",
        "linear/issues/old-title--issue-1.md",
        "linear/issues/old-title--issue-1/assets/attachment-4--diagram.png",
      ],
    })

    expect(result.deletePaths).toEqual([
      "linear/issues/old-title--issue-1.md",
      "linear/issues/old-title--issue-1/assets/attachment-4--diagram.png",
    ])
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
      entities: [issueChange],
      existingPaths: [],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-1--issue-1.md",
      }),
    ])
    expect(result.deletePaths).toEqual([])
  })

  it("includes health in incremental initiative update sections", async () => {
    sdk.initiative.mockResolvedValue({
      id: "initiative-1",
      name: "Roadmap",
      url: "https://linear.app/acme/initiative/initiative-1",
      content: "Initiative body",
      description: null,
      status: "Started",
      health: "onTrack",
      ownerId: null,
      targetDate: null,
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      initiativeUpdates: vi.fn().mockResolvedValue(
        page([
          {
            body: "Delivery remains on schedule.",
            health: "onTrack",
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
          },
        ]),
      ),
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
      entities: [
        {
          entityType: "initiative",
          externalId: "initiative-1",
          action: "upsert",
        },
      ],
      existingPaths: [],
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        content: expect.stringContaining(
          "Health: onTrack\n\nDelivery remains on schedule.",
        ),
      }),
    ])
  })
})
