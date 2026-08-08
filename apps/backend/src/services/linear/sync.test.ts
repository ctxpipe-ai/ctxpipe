import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type {
  LinearConnection,
  LinearScope,
  LinearSyncTargetWithRepo,
} from "../../models/linear-connector.js"
import { syncLinearConfigYaml, syncLinearContentToGit } from "./sync.js"

const github = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  commitFiles: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const content = vi.hoisted(() => ({
  buildLinearMirror: vi.fn(),
}))

vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})
vi.mock("./content.js", () => content)

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
} satisfies LinearSyncTargetWithRepo

const scopes = [
  {
    id: "lsc_1",
    connectionId: "con_linear",
    externalId: "team-1",
    type: "team",
    title: "Product",
    url: null,
    parentExternalId: null,
    teamId: "team-1",
    teamKey: "PRO",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
] satisfies LinearScope[]

beforeEach(() => {
  vi.clearAllMocks()
  github.getFileContent.mockResolvedValue(undefined)
  github.createPullRequestWithFiles.mockResolvedValue({
    pullUrl: "https://github.com/acme/context/pull/4",
  })
  github.listFilesInTree.mockResolvedValue([])
  github.commitFiles.mockResolvedValue("commit-sha")
  content.buildLinearMirror.mockResolvedValue({ files: [], failures: [] })
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
})
