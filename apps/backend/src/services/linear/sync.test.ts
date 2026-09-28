import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  installLinearGraphql,
  type LinearGraphqlCall,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"
import type {
  LinearBindingWithRepo,
  LinearConnection,
  LinearScope,
} from "../../models/linear-connector.js"
import {
  collectLinearMirrorPages,
  fetchLinearMirrorPage,
  walkLinearMirrorPages,
} from "./content.js"
import { resetLinearGraphqlForTests } from "./graphql.js"
import { commitLinearMirror, syncLinearConfigYaml } from "./sync.js"

const github = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  commitFiles: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  getPullRequestHeadBranch: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const assetBoundary = vi.hoisted(() => ({
  download: vi.fn(),
}))
const model = vi.hoisted(() => ({
  withLinearBindingSnapshot: vi.fn(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  ),
}))

// assertLinearBindingSnapshot reads the binding row from Postgres around the git write.
vi.mock("../../models/linear-connector.js", () => model)
// downloadConnectorAsset resolves uploads.linear.app to a public IP and fetches that address.
vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return { ...actual, downloadConnectorAsset: assetBoundary.download }
})
// getInstallationOctokitForOrg loads the GitHub App installation from Postgres.
vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})

const linearCalls: LinearGraphqlCall[] = []
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

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
  resetLinearGraphqlForTests()
  vi.clearAllMocks()
  github.getFileContent.mockResolvedValue(undefined)
  github.getPullRequestHeadBranch.mockResolvedValue(undefined)
  github.createPullRequestWithFiles.mockResolvedValue({
    pullUrl: "https://github.com/acme/context/pull/4",
    pullNumber: 4,
  })
  github.listFilesInTree.mockResolvedValue([])
  github.commitFiles.mockResolvedValue({ commitSha: "commit-sha" })
  assetBoundary.download.mockResolvedValue({
    status: "downloaded",
    bytes: Buffer.from("asset-bytes"),
    filename: "diagram.png",
    contentType: "image/png",
  })
  model.withLinearBindingSnapshot.mockImplementation(
    async (_input: unknown, operation: () => Promise<unknown>) => operation(),
  )
})

describe("commitLinearMirror", () => {
  const config = {
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited" as const,
    scopes: [],
  }

  it("returns no commit for a true Git no-op", async () => {
    await expect(
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [],
        failures: [],
      }),
    ).resolves.toMatchObject({
      written: 0,
      deleted: 0,
      commitSha: undefined,
    })
    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("crosses provider traversal, asset capture, and Git reconciliation", async () => {
    linearCalls.length = 0
    installLinearGraphql(server, linearCalls, (call) => {
      if (call.name !== "DocumentRecord") return {}
      return {
        document: {
          id: "doc-1",
          title: "Architecture",
          url: "https://linear.app/acme/document/architecture-doc-1",
          content:
            "Current design\n\n![System diagram](https://uploads.linear.app/files/diagram.png?token=temporary-secret)",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:00.000Z",
          project: null,
          creator: null,
        },
      }
    })
    const documentConfig = {
      ...config,
      scopes: [
        {
          externalId: "doc-1",
          type: "document" as const,
          title: "Architecture",
          url: "https://linear.app/acme/document/architecture-doc-1",
          parentExternalId: null,
          teamId: null,
          teamKey: null,
        },
      ],
    }
    const pages = await walkLinearMirrorPages({
      config: documentConfig,
      runPage: (_name, request) =>
        fetchLinearMirrorPage({
          env: {} as Env,
          connection,
          config: documentConfig,
          request,
        }),
    })
    const mirror = collectLinearMirrorPages(pages)

    await commitLinearMirror({
      orgId: "org_1",
      env: {} as Env,
      connection,
      target,
      files: mirror.files,
      failures: mirror.failures,
    })

    expect(linearCalls.map((call) => call.name)).toEqual(["DocumentRecord"])
    expect(assetBoundary.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.linear.app/files/diagram.png?token=temporary-secret",
        headers: { Authorization: "Bearer secret" },
      }),
    )
    const files = github.commitFiles.mock.calls[0]?.[0].files as Array<{
      path: string
      content: string
      encoding?: string
    }>
    const markdown = files.find((file) => file.path.endsWith(".md"))
    const binary = files.find((file) => file.encoding === "base64")
    expect(markdown?.path).toBe("linear/documents/architecture--doc-1.md")
    expect(binary?.path).toMatch(
      /^linear\/documents\/architecture--doc-1\/assets\/src-[0-9a-f]{12}--diagram\.png$/,
    )
    expect(markdown?.content).toContain(
      `](${binary?.path.slice("linear/documents/".length)})`,
    )
    expect(binary?.content).toBe(Buffer.from("asset-bytes").toString("base64"))
    expect(JSON.stringify(files)).not.toContain("temporary-secret")
  })

  it("deletes stale mirror files after a complete reconcile", async () => {
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/config.yaml", sha: "config" },
      { path: "linear/issues/eng-1--issue-1.md", sha: "current" },
      { path: "linear/issues/eng-2--issue-2.md", sha: "stale" },
    ])

    await expect(
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
        ],
        failures: [],
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
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            content: Buffer.from("png-bytes").toString("base64"),
            encoding: "base64",
          },
        ],
        failures: [],
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
    github.listFilesInTree.mockResolvedValue([
      { path: preserved, sha: "prior-good-asset" },
      {
        path: "linear/issues/eng-1--issue-1/assets/removed--old.png",
        sha: "stale",
      },
    ])

    await commitLinearMirror({
      orgId: "org_1",
      env: {} as Env,
      connection,
      target,
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

    const deletePaths = github.commitFiles.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).not.toContain(preserved)
    expect(deletePaths).toContain(
      "linear/issues/eng-1--issue-1/assets/removed--old.png",
    )
  })

  it("omits unchanged binary assets from the commit while keeping them in the desired set", async () => {
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
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
          },
        ],
        failures: [],
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
    github.listFilesInTree.mockResolvedValue([
      {
        path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ])

    await expect(
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
          },
        ],
        failures: [],
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
    github.listFilesInTree.mockResolvedValue([
      { path: "linear/issues/eng-2--issue-2.md", sha: "possibly-current" },
    ])

    await expect(
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
        ],
        failures: [
          { type: "issue", id: "issue-2", message: "Linear unavailable" },
        ],
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
    model.withLinearBindingSnapshot.mockRejectedValueOnce(
      new Error("Linear sync target changed while content was being built"),
    )

    await expect(
      commitLinearMirror({
        orgId: "org_1",
        env: {} as Env,
        connection,
        target,
        files: [{ path: "linear/issues/eng-1--issue-1.md", content: "stale" }],
        failures: [],
      }),
    ).rejects.toThrow("target changed")
    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("refreshes an expired Linear token before downloading attachments", async () => {
    const onTokenRefresh = vi.fn().mockResolvedValue({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    await commitLinearMirror({
      orgId: "org_1",
      env: {} as Env,
      connection: {
        ...connection,
        accessTokenExpiresAt: new Date(0).toISOString(),
      },
      target,
      onTokenRefresh,
      files: [
        {
          path: "linear/documents/architecture--doc-1.md",
          content:
            "![System diagram](https://uploads.linear.app/files/diagram.png?token=temporary-secret)",
        },
      ],
      failures: [],
    })

    expect(onTokenRefresh).toHaveBeenCalledWith("refresh", "secret")
    expect(assetBoundary.download).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: "Bearer access-new" },
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
