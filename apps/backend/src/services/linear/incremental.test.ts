import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type {
  LinearConnection,
  LinearDirtyEntity,
} from "../../models/linear-connector.js"
import { buildLinearIncrementalChanges } from "./incremental.js"

const sdk = vi.hoisted(() => ({
  issue: vi.fn(),
}))

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    issue = sdk.issue
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

const dirtyIssue = {
  id: "dirty-1",
  connectionId: "con_linear",
  entityType: "issue",
  externalId: "issue-1",
  action: "upsert",
  firstDirtyAt: new Date(),
  lastEventAt: new Date(),
  revision: 2,
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

beforeEach(() => {
  vi.clearAllMocks()
  sdk.issue.mockResolvedValue({
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
  })
})

describe("buildLinearIncrementalChanges", () => {
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
      ...(await sdk.issue.mock.results[0]?.value),
      teamId: "team-outside-scope",
    })
    const outside = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      dirty: [dirtyIssue],
      existingPaths: [],
    })
    expect(outside.files).toEqual([])
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
})
