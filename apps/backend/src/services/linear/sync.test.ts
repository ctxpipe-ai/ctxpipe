import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type {
  LinearBindingWithRepo,
  LinearConnection,
  LinearScope,
} from "../../models/linear-connector.js"
import {
  syncLinearConfigYaml,
  syncLinearContentToGit,
  syncLinearIncrementalContent,
} from "./sync.js"

const github = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  commitFiles: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  getPullRequestHeadBranch: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const content = vi.hoisted(() => ({
  buildLinearMirror: vi.fn(),
}))
const incremental = vi.hoisted(() => ({
  buildLinearIncrementalChanges: vi.fn(),
}))
const model = vi.hoisted(() => ({
  withLinearBindingSnapshot: vi.fn(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  ),
}))

vi.mock("../../models/linear-connector.js", () => model)
vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})
vi.mock("./content.js", () => content)
vi.mock("./incremental.js", () => incremental)

const connection = {
  id: "con_linear",
  orgId: "org_1",
  accessToken: "secret",
  refreshToken: "refresh",
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
  setupPhase: "awaiting_merge",
  pendingConfigPullUrl: "https://github.com/acme/context/pull/3",
  pendingConfigPrCreating: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearConnection

const target = {
  id: "lst_1",
  orgId: "org_1",
  connectionId: "con_linear",
  repositoryId: "repo_1",
  repositoryName: "acme/context",
  githubConnectionId: "con_github",
  branch: "main",
  enabled: true,
  setupPhase: "awaiting_merge",
  pendingConfigPullUrl: "https://github.com/acme/context/pull/3",
  pendingConfigPrCreating: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies LinearBindingWithRepo

const scopes = [
  {
    externalId: "team-1",
    type: "team",
    title: "Product",
    url: null,
    parentExternalId: null,
    teamId: "team-1",
    teamKey: "PRO",
  },
] satisfies LinearScope[]

beforeEach(() => {
  vi.clearAllMocks()
  github.getFileContent.mockResolvedValue(undefined)
  github.getPullRequestHeadBranch.mockResolvedValue(undefined)
  github.createPullRequestWithFiles.mockResolvedValue({
    pullUrl: "https://github.com/acme/context/pull/4",
    pullNumber: 4,
  })
  github.listFilesInTree.mockResolvedValue([])
  github.commitFiles.mockResolvedValue("commit-sha")
  content.buildLinearMirror.mockResolvedValue({
    files: [],
    failures: [],
    preservePathPrefixes: [],
  })
  incremental.buildLinearIncrementalChanges.mockResolvedValue({
    files: [],
    deletePaths: [],
    failures: [],
  })
  model.withLinearBindingSnapshot.mockImplementation(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  )
})

describe("syncLinearContentToGit", () => {
  const config = {
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited" as const,
    scopes: [],
  }

  it("deletes stale mirror files after a complete reconcile", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current",
        },
      ],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/config.yaml", sha: "config" },
      { path: "linear/issues/eng-1--issue-1.md", sha: "current" },
      { path: "linear/issues/eng-2--issue-2.md", sha: "stale" },
    ])

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      written: 1,
      deleted: 1,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["linear/issues/eng-2--issue-2.md"],
      }),
    )
  })

  it("includes sibling assets in the desired set and prunes stale ones", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current",
        },
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("png-bytes").toString("base64"),
          encoding: "base64",
        },
      ],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/config.yaml", sha: "config" },
      { path: "linear/issues/eng-1--issue-1.md", sha: "current" },
      {
        path: "linear/issues/eng-1--issue-1/assets/stale--old.png",
        sha: "stale-asset",
      },
      { path: "linear/issues/eng-2--issue-2.md", sha: "stale" },
      {
        path: "linear/issues/eng-2--issue-2/assets/gone.png",
        sha: "gone",
      },
    ])

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      written: 2,
      deleted: 3,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            encoding: "base64",
          }),
        ]),
        deletePaths: expect.arrayContaining([
          "linear/issues/eng-1--issue-1/assets/stale--old.png",
          "linear/issues/eng-2--issue-2.md",
          "linear/issues/eng-2--issue-2/assets/gone.png",
        ]),
      }),
    )
    expect(github.commitFiles.mock.calls[0]?.[0].deletePaths).not.toContain(
      "linear/config.yaml",
    )
  })

  it("preserves a prior asset when the current download is transiently unavailable", async () => {
    const preserved =
      "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png"
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current with fallback stub",
        },
      ],
      failures: [],
      preservePathPrefixes: [
        "linear/issues/eng-1--issue-1/assets/attachment-4--",
      ],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: preserved, sha: "prior-good-asset" },
      {
        path: "linear/issues/eng-1--issue-1/assets/removed--old.png",
        sha: "stale",
      },
    ])

    await syncLinearContentToGit({
      orgId: "org_1",
      env: {} as Env,
      connection,
      target,
      config,
    })

    const deletePaths = github.commitFiles.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).not.toContain(preserved)
    expect(deletePaths).toContain(
      "linear/issues/eng-1--issue-1/assets/removed--old.png",
    )
  })

  it("omits unchanged binary assets from the commit while keeping them in the desired set", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current",
        },
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("hello").toString("base64"),
          encoding: "base64",
        },
      ],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/config.yaml", sha: "config" },
      { path: "linear/issues/eng-1--issue-1.md", sha: "md" },
      {
        path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
        sha: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
      },
      {
        path: "linear/issues/eng-1--issue-1/assets/stale--old.png",
        sha: "stale-asset",
      },
    ])

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      written: 1,
      deleted: 1,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "linear/issues/eng-1--issue-1.md",
          }),
        ],
        deletePaths: ["linear/issues/eng-1--issue-1/assets/stale--old.png"],
      }),
    )
  })

  it("recommits a binary asset when the git blob sha changed", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current",
        },
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("hello").toString("base64"),
          encoding: "base64",
        },
      ],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      {
        path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ])

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).resolves.toMatchObject({
      written: 2,
      deleted: 0,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            encoding: "base64",
          }),
        ]),
      }),
    )
  })

  it("preserves possible orphans when any entity fetch fails", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "current",
        },
      ],
      failures: [
        { type: "issue", id: "issue-2", message: "Linear unavailable" },
      ],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/issues/eng-2--issue-2.md", sha: "possibly-current" },
    ])

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).resolves.toMatchObject({
      status: "partial_failed",
      deleted: 0,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ deletePaths: [] }),
    )
  })

  it("does not commit content after the sync target changes", async () => {
    content.buildLinearMirror.mockResolvedValue({
      files: [{ path: "linear/issues/eng-1--issue-1.md", content: "stale" }],
      failures: [],
    })
    model.withLinearBindingSnapshot.mockRejectedValueOnce(
      new Error("Linear sync target changed while content was being built"),
    )

    await expect(
      syncLinearContentToGit({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
      }),
    ).rejects.toThrow("target changed")
    expect(github.commitFiles).not.toHaveBeenCalled()
  })
})

describe("syncLinearIncrementalContent", () => {
  const config = {
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited" as const,
    scopes: [],
  }
  const entity = {
    entityType: "issue" as const,
    externalId: "issue-1",
    action: "upsert" as const,
  }

  it("omits unchanged incremental binaries from the commit without pruning them", async () => {
    incremental.buildLinearIncrementalChanges.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: "updated",
        },
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("hello").toString("base64"),
          encoding: "base64",
        },
      ],
      deletePaths: ["linear/issues/eng-1--issue-1/assets/stale--old.png"],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/issues/eng-1--issue-1.md", sha: "md" },
      {
        path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
        sha: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
      },
      {
        path: "linear/issues/eng-1--issue-1/assets/stale--old.png",
        sha: "stale-asset",
      },
    ])

    await expect(
      syncLinearIncrementalContent({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
        entity,
      }),
    ).resolves.toMatchObject({
      written: 1,
      deleted: 1,
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "linear/issues/eng-1--issue-1.md",
          }),
        ],
        deletePaths: ["linear/issues/eng-1--issue-1/assets/stale--old.png"],
      }),
    )
  })

  it("recommits an incremental binary when the git blob sha changed", async () => {
    incremental.buildLinearIncrementalChanges.mockResolvedValue({
      files: [
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("hello").toString("base64"),
          encoding: "base64",
        },
      ],
      deletePaths: [],
      failures: [],
    })
    github.listFilesInTree.mockResolvedValue([
      {
        path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ])

    await expect(
      syncLinearIncrementalContent({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        config,
        entity,
      }),
    ).resolves.toMatchObject({ written: 1, deleted: 0 })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            encoding: "base64",
          }),
        ],
      }),
    )
  })
})

describe("syncLinearConfigYaml", () => {
  it("closes a stale PR and creates a provider-specific config branch", async () => {
    await expect(
      syncLinearConfigYaml({
        orgId: "org_1",
        orgSlug: "acme",
        env: {} as Env,
        connection,
        target,
        scopes,
      }),
    ).resolves.toEqual({
      changed: true,
      pullUrl: "https://github.com/acme/context/pull/4",
      pullNumber: 4,
    })

    expect(github.closePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 3 }),
    )
    expect(github.createPullRequestWithFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        featureBranchPrefix: "ctxpipe/linear-config",
        files: [
          expect.objectContaining({
            path: "linear/config.yaml",
            content: expect.stringContaining("workspace-1"),
          }),
        ],
      }),
    )
  })

  it("preserves the target branch customer request policy", async () => {
    github.getFileContent.mockResolvedValue(`
version: 1
source: linear
workspace:
  id: workspace-1
  name: Acme
scope:
  teams: []
  projects: []
  documents: []
  initiatives: []
policy:
  customerRequests: exclude
  githubLinks: references_only
  attachmentBinaries: false
`)

    await syncLinearConfigYaml({
      orgId: "org_1",
      orgSlug: "acme",
      env: {} as Env,
      connection,
      target,
      scopes,
    })

    expect(github.createPullRequestWithFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            content: expect.stringContaining("customerRequests: exclude"),
          }),
        ],
      }),
    )
  })

  it("preserves customer request policy from the pending PR head", async () => {
    github.getPullRequestHeadBranch.mockResolvedValue(
      "ctxpipe/linear-config-policy",
    )
    github.getFileContent.mockImplementation(
      async ({ branch }: { branch: string }) =>
        branch === "ctxpipe/linear-config-policy"
          ? `
version: 1
source: linear
workspace:
  id: workspace-1
  name: Acme
scope:
  teams: []
  projects: []
  documents: []
  initiatives: []
policy:
  customerRequests: exclude
  githubLinks: references_only
  attachmentBinaries: false
`
          : undefined,
    )

    await syncLinearConfigYaml({
      orgId: "org_1",
      orgSlug: "acme",
      env: {} as Env,
      connection,
      target,
      scopes,
    })

    expect(github.getPullRequestHeadBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        pullUrl: "https://github.com/acme/context/pull/3",
      }),
    )
    expect(github.getFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "ctxpipe/linear-config-policy" }),
    )
    expect(github.createPullRequestWithFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            content: expect.stringContaining("customerRequests: exclude"),
          }),
        ],
      }),
    )
  })
})
