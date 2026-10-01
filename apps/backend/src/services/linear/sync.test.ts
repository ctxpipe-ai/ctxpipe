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
import {
  captureLinearContent,
  captureLinearIncrementalContent,
  syncLinearConfigYaml,
} from "./sync.js"

const github = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  getPullRequestHeadBranch: vi.fn(),
}))
const assetBoundary = vi.hoisted(() => ({
  download: vi.fn(),
}))
const incremental = vi.hoisted(() => ({
  buildLinearIncrementalChanges: vi.fn(),
}))

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
// Incremental webhook change building is covered in incremental.test.ts.
vi.mock("./incremental.js", () => incremental)

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
  assetBoundary.download.mockResolvedValue({
    status: "downloaded",
    bytes: Buffer.from("asset-bytes"),
    filename: "diagram.png",
    contentType: "image/png",
  })
  incremental.buildLinearIncrementalChanges.mockResolvedValue({
    files: [],
    deletePaths: [],
    failures: [],
  })
})

describe("captureLinearContent", () => {
  const config = {
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited" as const,
    scopes: [],
  }

  it("returns no files for a true Git no-op", async () => {
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [],
        failures: [],
        existingPaths: [],
      }),
    ).resolves.toEqual({
      status: "completed",
      files: [],
      deletePaths: [],
      failures: [],
    })
  })

  it("fails when every fetch failed and nothing rendered", async () => {
    const failures = [
      { type: "issue", id: "issue-1", message: "Linear unavailable" },
    ]
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [],
        failures,
        existingPaths: ["linear/issues/eng-1--issue-1.md"],
      }),
    ).resolves.toEqual({
      status: "failed",
      files: [],
      deletePaths: [],
      failures,
    })
  })

  it("crosses provider traversal and asset capture without committing", async () => {
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

    const captured = await captureLinearContent({
      env: {} as Env,
      connection,
      files: mirror.files,
      failures: mirror.failures,
      existingPaths: [],
    })

    expect(linearCalls.map((call) => call.name)).toEqual(["DocumentRecord"])
    expect(assetBoundary.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.linear.app/files/diagram.png?token=temporary-secret",
        headers: { Authorization: "Bearer secret" },
      }),
    )
    const markdown = captured.files.find((file) => file.path.endsWith(".md"))
    const binary = captured.files.find((file) => file.encoding === "base64")
    expect(markdown?.path).toBe("linear/documents/architecture--doc-1.md")
    expect(binary?.path).toMatch(
      /^linear\/documents\/architecture--doc-1\/assets\/src-[0-9a-f]{12}--diagram\.png$/,
    )
    expect(markdown?.content).toContain(
      `](${binary?.path.slice("linear/documents/".length)})`,
    )
    expect(binary?.content).toBe(Buffer.from("asset-bytes").toString("base64"))
    expect(JSON.stringify(captured.files)).not.toContain("temporary-secret")
  })

  it("deletes stale mirror files after a complete reconcile", async () => {
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
        ],
        failures: [],
        existingPaths: [
          "linear/config.yaml",
          "linear/issues/eng-1--issue-1.md",
          "linear/issues/eng-2--issue-2.md",
          "knowledge/billing.md",
        ],
      }),
    ).resolves.toMatchObject({
      status: "completed",
      deletePaths: ["linear/issues/eng-2--issue-2.md"],
    })
  })

  it("includes sibling assets in the desired set and prunes stale ones", async () => {
    const captured = await captureLinearContent({
      env: {} as Env,
      connection,
      files: [
        { path: "linear/issues/eng-1--issue-1.md", content: "current" },
        {
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          content: Buffer.from("png-bytes").toString("base64"),
          encoding: "base64",
        },
      ],
      failures: [],
      existingPaths: [
        "linear/config.yaml",
        "linear/issues/eng-1--issue-1.md",
        "linear/issues/eng-1--issue-1/assets/stale--old.png",
        "linear/issues/eng-2--issue-2.md",
        "linear/issues/eng-2--issue-2/assets/gone.png",
      ],
    })

    expect(captured.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          encoding: "base64",
        }),
      ]),
    )
    expect([...captured.deletePaths].sort()).toEqual([
      "linear/issues/eng-1--issue-1/assets/stale--old.png",
      "linear/issues/eng-2--issue-2.md",
      "linear/issues/eng-2--issue-2/assets/gone.png",
    ])
  })

  it("preserves a prior asset when the current download is transiently unavailable", async () => {
    const preserved =
      "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png"
    assetBoundary.download.mockResolvedValueOnce({
      status: "stub",
      reason: "download_failed",
    })

    const captured = await captureLinearContent({
      env: {} as Env,
      connection,
      files: [
        {
          path: "linear/issues/eng-1--issue-1.md",
          content: [
            "---",
            "attachments:",
            "  - id: attachment-4",
            "    title: diagram.png",
            "    url: https://uploads.linear.app/files/diagram.png",
            "---",
            "current",
          ].join("\n"),
        },
      ],
      failures: [],
      existingPaths: [],
      existingBlobs: [
        { path: preserved, sha: "prior-good-asset" },
        {
          path: "linear/issues/eng-1--issue-1/assets/removed--old.png",
          sha: "stale",
        },
      ],
    })

    expect(captured.deletePaths).not.toContain(preserved)
    expect(captured.deletePaths).toContain(
      "linear/issues/eng-1--issue-1/assets/removed--old.png",
    )
  })

  it("omits unchanged binary assets from the captured files while keeping them in the desired set", async () => {
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
          },
        ],
        failures: [],
        existingPaths: [],
        existingBlobs: [
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
        ],
      }),
    ).resolves.toMatchObject({
      status: "completed",
      files: [
        expect.objectContaining({
          path: "linear/issues/eng-1--issue-1.md",
        }),
      ],
      deletePaths: ["linear/issues/eng-1--issue-1/assets/stale--old.png"],
    })
  })

  it("keeps a binary asset when the git blob sha changed", async () => {
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
          },
        ],
        failures: [],
        existingPaths: [],
        existingBlobs: [
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }),
    ).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          encoding: "base64",
        }),
      ]),
      deletePaths: [],
    })
  })

  it("preserves possible orphans when any entity fetch fails", async () => {
    await expect(
      captureLinearContent({
        env: {} as Env,
        connection,
        files: [
          { path: "linear/issues/eng-1--issue-1.md", content: "current" },
        ],
        failures: [
          { type: "issue", id: "issue-2", message: "Linear unavailable" },
        ],
        existingPaths: ["linear/issues/eng-2--issue-2.md"],
      }),
    ).resolves.toMatchObject({
      status: "partial_failed",
      deletePaths: [],
    })
  })

  it("refreshes an expired Linear token before downloading attachments", async () => {
    const onTokenRefresh = vi.fn().mockResolvedValue({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    await captureLinearContent({
      env: {} as Env,
      connection: {
        ...connection,
        accessTokenExpiresAt: new Date(0).toISOString(),
      },
      onTokenRefresh,
      files: [
        {
          path: "linear/documents/architecture--doc-1.md",
          content:
            "![System diagram](https://uploads.linear.app/files/diagram.png?token=temporary-secret)",
        },
      ],
      failures: [],
      existingPaths: [],
    })

    expect(onTokenRefresh).toHaveBeenCalledWith("refresh", "secret")
    expect(assetBoundary.download).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: "Bearer access-new" },
      }),
    )
  })
})

describe("captureLinearIncrementalContent", () => {
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

  it("omits unchanged incremental binaries without pruning them", async () => {
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

    await expect(
      captureLinearIncrementalContent({
        env: {} as Env,
        connection,
        config,
        existingPaths: [],
        existingBlobs: [
          { path: "linear/issues/eng-1--issue-1.md", sha: "md" },
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            sha: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
          },
          {
            path: "linear/issues/eng-1--issue-1/assets/stale--old.png",
            sha: "stale-asset",
          },
        ],
        entity,
      }),
    ).resolves.toMatchObject({
      files: [
        expect.objectContaining({
          path: "linear/issues/eng-1--issue-1.md",
        }),
      ],
      deletePaths: ["linear/issues/eng-1--issue-1/assets/stale--old.png"],
    })
  })

  it("keeps an incremental binary when the git blob sha changed", async () => {
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

    await expect(
      captureLinearIncrementalContent({
        env: {} as Env,
        connection,
        config,
        existingPaths: [],
        existingBlobs: [
          {
            path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
        entity,
      }),
    ).resolves.toMatchObject({
      files: [
        expect.objectContaining({
          path: "linear/issues/eng-1--issue-1/assets/attachment-4--diagram.png",
          encoding: "base64",
        }),
      ],
      deletePaths: [],
    })
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
