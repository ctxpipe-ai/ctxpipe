import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type {
  LinearBindingWithRepo,
  LinearConnection,
  LinearScope,
} from "../../models/linear-connector.js"
import { syncLinearConfigYaml } from "./sync.js"

const github = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  getPullRequestHeadBranch: vi.fn(),
}))
vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})

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
