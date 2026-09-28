import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
  linearBudgetHeaders,
  linearIssueData,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { createConnectorAssetBytePool } from "../connectors/assets.js"
import { resetLinearGraphqlForTests } from "./graphql.js"
import {
  buildLinearIncrementalChanges,
  type LinearEntityChange,
} from "./incremental.js"
import { syncLinearIncrementalContent } from "./sync.js"

const calls: LinearGraphqlCall[] = []
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
let issue = linearIssueData()
let initiativeProjectIds: string[] = []
const downloadConnectorAsset = vi.hoisted(() => vi.fn())
const github = vi.hoisted(() => ({
  commitFiles: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const model = vi.hoisted(() => ({
  withLinearBindingSnapshot: vi.fn(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  ),
}))

vi.mock("../connectors/assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/assets.js")>()),
  downloadConnectorAsset,
}))
vi.mock("../../models/linear-connector.js", () => model)
vi.mock("../github/installation-write-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../github/installation-write-client.js")
  >()),
  ...github,
}))

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

function respond(call: LinearGraphqlCall): unknown {
  if (call.name === "IssueRecord" || call.name === "IssueRecordWithNeeds") {
    return { issue }
  }
  if (call.name === "TeamRecord") {
    return {
      team: {
        id: "team-1",
        name: "Product",
        key: "PRO",
        description: "Updated team description",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        parent: null,
      },
    }
  }
  if (call.name === "InitiativeProjects") {
    return {
      initiative: {
        projects: emptyLinearPage(initiativeProjectIds.map((id) => ({ id }))),
      },
    }
  }
  if (call.name === "InitiativeDocuments") {
    return { initiative: { documents: emptyLinearPage() } }
  }
  if (call.name === "InitiativeRecord") {
    return {
      initiative: {
        id: "initiative-1",
        name: "Roadmap",
        url: "https://linear.app/acme/initiative/initiative-1",
        content: "Initiative body",
        description: null,
        status: "Active",
        health: "onTrack",
        targetDate: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        parentInitiative: null,
        owner: null,
        initiativeUpdates: emptyLinearPage([
          {
            body: "Delivery remains on schedule.",
            health: "onTrack",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        ]),
      },
    }
  }
  return {}
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetLinearGraphqlForTests()
  calls.length = 0
  issue = linearIssueData()
  initiativeProjectIds = []
  installLinearGraphql(server, calls, respond)
  github.listFilesInTree.mockResolvedValue([])
  github.commitFiles.mockResolvedValue({ commitSha: "commit-sha" })
  model.withLinearBindingSnapshot.mockImplementation(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  )
})

describe("buildLinearIncrementalChanges", () => {
  it("crosses provider traversal, asset capture, and Git reconciliation", async () => {
    const sourceUrl = "https://uploads.linear.app/acme/diagram.png"
    issue = linearIssueData({
      description: `Current architecture: ![diagram](${sourceUrl})`,
      attachments: [
        {
          id: "attachment-1",
          title: "diagram.png",
          url: sourceUrl,
          sourceType: "upload",
        },
      ],
    })
    downloadConnectorAsset.mockResolvedValueOnce({
      status: "downloaded",
      bytes: Buffer.from("diagram-bytes"),
      filename: "diagram.png",
      contentType: "image/png",
    })

    const result = await syncLinearIncrementalContent({
      orgId: "org_1",
      env: {} as Env,
      connection,
      target: {
        id: "con_linear",
        orgId: "org_1",
        connectionId: "con_linear",
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        githubConnectionId: "con_github",
        branch: "main",
        enabled: true,
        setupPhase: "live",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      config: selectedConfig,
      entity: issueChange,
    })

    expect(result.commitSha).toBe("commit-sha")
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "linear/issues/pro-1--issue-1.md",
            content: expect.stringContaining(
              "![diagram](pro-1--issue-1/assets/attachment-1--diagram.png)",
            ),
          }),
          {
            path: "linear/issues/pro-1--issue-1/assets/attachment-1--diagram.png",
            content: Buffer.from("diagram-bytes").toString("base64"),
            encoding: "base64",
          },
        ]),
      }),
    )
  })

  it("updates a selected team from a webhook event", async () => {
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

    issue = linearIssueData({ teamId: "team-outside-scope" })
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
    issue = linearIssueData({ identifier: "PRO-2" })

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
    issue = linearIssueData({ identifier: "PRO-2" })

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

  it("enforces the retained-byte pool across duplicate attachment aliases", async () => {
    const sharedUrl = "https://uploads.linear.app/acme/shared.png"
    issue = linearIssueData({
      attachments: Array.from({ length: 5 }, (_, index) => ({
        id: `attachment-${index}`,
        title: "shared.png",
        url: sharedUrl,
        sourceType: "upload",
      })),
    })
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("x"),
      filename: "shared.png",
      contentType: "image/png",
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [],
      bytePool: createConnectorAssetBytePool(4),
    })

    expect(downloadConnectorAsset).toHaveBeenCalledTimes(1)
    expect(
      result.files.filter((file) => file.encoding === "base64"),
    ).toHaveLength(4)
    expect(result.files[0]?.content).toContain(
      "File omitted; open the issue in Linear to view it.",
    )
  })

  it("prunes stale customer-request assets when its parent issue updates", async () => {
    issue = linearIssueData({
      needs: [
        {
          id: "need-1",
          url: "https://linear.app/acme/customer-request/need-1",
          content: "Current request",
          customerId: "customer-1",
          issueId: "issue-1",
          priority: 1,
        },
      ],
    })

    const result = await buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [
        "linear/customer-requests/customer-request-need-1--need-1.md",
        "linear/customer-requests/customer-request-need-1--need-1/assets/stale--old.png",
      ],
    })

    expect(result.deletePaths).toEqual([
      "linear/customer-requests/customer-request-need-1--need-1/assets/stale--old.png",
    ])
  })

  it("preserves the prior binary when an incremental asset download fails", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    issue = linearIssueData({
      identifier: "ENG-1",
      attachments: [
        {
          id: "attachment-4",
          title: "diagram.png",
          url: "https://uploads.linear.app/acme/diagram.png",
          sourceType: "upload",
        },
      ],
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
        content: expect.stringContaining(
          "path: pro-1--issue-1/assets/attachment-4--diagram.png",
        ),
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
    expect(calls).toEqual([])
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
    expect(calls).toEqual([])
  })

  it("updates issues descended from a selected initiative", async () => {
    initiativeProjectIds = ["project-1"]
    issue = linearIssueData({
      teamId: "team-outside-scope",
      project: { id: "project-1", name: "Launch", teamIds: [] },
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

  it("waits out a short rate limit and still returns the mapped issue", async () => {
    vi.useFakeTimers()
    let attempts = 0
    server.use(
      http.post("https://api.linear.app/graphql", async () => {
        attempts += 1
        if (attempts === 1) {
          return HttpResponse.json(
            {
              errors: [
                {
                  message: "Rate limited",
                  extensions: { code: "RATELIMITED" },
                },
              ],
            },
            {
              status: 400,
              headers: {
                "X-RateLimit-Requests-Remaining": "0",
                "X-RateLimit-Requests-Reset": String(Date.now() + 3_000),
              },
            },
          )
        }
        return HttpResponse.json(
          { data: { issue } },
          { headers: linearBudgetHeaders() },
        )
      }),
    )

    const pending = buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [],
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    expect(attempts).toBe(2)
    expect(result.failures).toEqual([])
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "linear/issues/pro-1--issue-1.md",
        content: expect.stringContaining("Updated from a webhook"),
      }),
    ])
  })

  it("waits for an empty endpoint bucket without parking on a healthy request window", async () => {
    vi.useFakeTimers()
    let attempts = 0
    server.use(
      http.post("https://api.linear.app/graphql", async () => {
        attempts += 1
        if (attempts === 1) {
          return HttpResponse.json(
            {
              errors: [
                {
                  message: "Rate limited",
                  extensions: { code: "RATELIMITED" },
                },
              ],
            },
            {
              status: 400,
              headers: {
                "X-RateLimit-Requests-Remaining": "4900",
                "X-RateLimit-Requests-Reset": String(Date.now() + 3_600_000),
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": String(
                  Date.now() + 3_000,
                ),
                "X-RateLimit-Endpoint-Requests-Name": "issues",
              },
            },
          )
        }
        return HttpResponse.json(
          { data: { issue } },
          { headers: linearBudgetHeaders() },
        )
      }),
    )

    const pending = buildLinearIncrementalChanges({
      env: {} as Env,
      connection,
      config: selectedConfig,
      entities: [issueChange],
      existingPaths: [],
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    expect(attempts).toBe(2)
    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toContain(
      "linear/issues/pro-1--issue-1.md",
    )
  })

  it("includes health in incremental initiative update sections", async () => {
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
