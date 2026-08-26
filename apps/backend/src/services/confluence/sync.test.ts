import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type { ConfluenceSyncTarget } from "../../models/confluence-sync-target.js"
import type { ConnectorAssetBudget } from "../connectors/assets.js"
import {
  connectorAssetCommitFile,
  consumeConnectorAssetBudget,
  gitBlobSha,
} from "../connectors/assets.js"

const limitMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const github = vi.hoisted(() => ({
  commitFiles: vi.fn(),
  getFileContent: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const confluence = vi.hoisted(() => ({
  downloadConfluenceAttachment: vi.fn(),
  getConfluencePageWithBody: vi.fn(),
  listConfluencePageAttachments: vi.fn(),
  listConfluencePagesForSpace: vi.fn(),
  listConfluenceSpaces: vi.fn(),
}))
const downloadConnectorAsset = vi.hoisted(() => vi.fn())
const updateSpaceSyncState = vi.hoisted(() => vi.fn())

vi.mock("../../db/client.js", () => ({
  getOrgDb: () => ({ select: selectMock }),
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/atlassian-connector.js", () => ({
  updateConfluenceSpaceSyncState: updateSpaceSyncState,
}))
vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})
vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return { ...actual, downloadConnectorAsset }
})
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>()
  return { ...actual, ...confluence }
})

import {
  CONFLUENCE_DELETED_PAGE_EVENT,
  getConfluenceSyncReconcileMode,
  syncConfluenceContent,
} from "./sync.js"

const env = {} as Env
const target = {
  id: "cst_1",
  orgId: "org_1",
  connectionId: "con_forge",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
} satisfies ConfluenceSyncTarget

const forgeInstallation = {
  id: "con_forge",
  cloudId: "cloud-1",
  atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud-1",
  appSystemToken: "forge-app-token",
}

const scopeFromRepo = {
  spaces: [{ spaceKey: "ENG", selectedPageIds: ["42"] }],
}

const diagramBytes = Buffer.from("diagram-bytes")

function committedFiles() {
  return github.commitFiles.mock.calls[0]?.[0]?.files as Array<{
    path: string
    content: string
    encoding?: string
  }>
}

describe("getConfluenceSyncReconcileMode", () => {
  it("returns full when there is no page scoping", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        eventType: "avi:confluence:updated:page",
      }),
    ).toBe("full")
  })

  it("returns full for page delete events so orphans are pruned in one space run", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: CONFLUENCE_DELETED_PAGE_EVENT,
      }),
    ).toBe("full")
  })

  it("returns single_upsert for page create and update", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: "avi:confluence:updated:page",
      }),
    ).toBe("single_upsert")
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: "avi:confluence:created:page",
      }),
    ).toBe("single_upsert")
  })
})

describe("syncConfluenceContent safety", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    limitMock.mockResolvedValue([
      { name: "acme/context", githubConnectionId: "con_github" },
    ])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "keep" },
      {
        path: "confluence/ENG/_assets/42/att100--diagram.png",
        sha: "keep-asset",
      },
    ])
    github.getFileContent.mockResolvedValue(undefined)
    github.commitFiles.mockResolvedValue({ commitSha: "sha-1" })
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
    ])
  })

  it("does not reconcile git when confluence/config.yaml is missing", async () => {
    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
      }),
    ).rejects.toThrow("confluence/config.yaml is missing or invalid")

    expect(github.listFilesInTree).not.toHaveBeenCalled()
    expect(github.commitFiles).not.toHaveBeenCalled()
    expect(confluence.listConfluenceSpaces).not.toHaveBeenCalled()
  })

  it("preserves an unresolved configured space prefix during full reconcile", async () => {
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
    ])
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Design", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage: "<p>Hello</p>",
    })
    confluence.listConfluencePageAttachments.mockResolvedValue([])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-eng" },
      { path: "confluence/OPS/runbook--9.md", sha: "ops-md" },
      { path: "confluence/OPS/_assets/9/keep.png", sha: "ops-keep" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [
          { spaceKey: "ENG", selectedPageIds: ["42"] },
          { spaceKey: "OPS", selectedPageIds: ["9"] },
        ],
      },
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--old.png"],
      }),
    )
  })

  it("preserves an unresolved space prefix on a space-scoped full reconcile", async () => {
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
    ])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-eng" },
      { path: "confluence/OPS/runbook--9.md", sha: "ops-md" },
      { path: "confluence/OPS/_assets/9/keep.png", sha: "ops-keep" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [
          { spaceKey: "ENG", selectedPageIds: ["42"] },
          { spaceKey: "OPS", selectedPageIds: ["9"] },
        ],
      },
      mode: {
        spaceKey: "OPS",
        eventType: "avi:confluence:updated:space:V2",
      },
    })

    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("ignores single-page events outside repository scope", async () => {
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "keep" },
      {
        path: "confluence/ENG/_assets/42/att100--diagram.png",
        sha: "keep-asset",
      },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "DOCS", selectedPageIds: ["7"] }],
        },
        mode: {
          spaceKey: "ENG",
          pageId: "42",
          eventType: "avi:confluence:updated:page",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 0,
      pagesFailed: 0,
      errors: [],
    })

    expect(github.listFilesInTree).not.toHaveBeenCalled()
    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("preserves an unresolved space prefix on single_upsert", async () => {
    confluence.listConfluenceSpaces.mockResolvedValue([])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "keep" },
      {
        path: "confluence/ENG/_assets/42/att100--diagram.png",
        sha: "keep-asset",
      },
      { path: "confluence/ENG/other--99.md", sha: "other" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42"] }],
        },
        mode: {
          spaceKey: "ENG",
          pageId: "42",
          eventType: "avi:confluence:updated:page",
        },
      }),
    ).resolves.toMatchObject({
      errors: [expect.objectContaining({ spaceKey: "ENG" })],
    })

    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("records a failure and keeps files when the page is absent on single_upsert", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "99", title: "Other", spaceId: "space-1", parentId: null },
    ])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "keep" },
      {
        path: "confluence/ENG/_assets/42/att100--diagram.png",
        sha: "keep-asset",
      },
      { path: "confluence/ENG/other--99.md", sha: "other" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42"] }],
        },
        mode: {
          spaceKey: "ENG",
          pageId: "42",
          eventType: "avi:confluence:updated:page",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      pagesFailed: 1,
      pagesProcessed: 0,
      errors: [expect.objectContaining({ spaceKey: "ENG", pageId: "42" })],
    })

    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("does not delete existing files when a page exception happens on single_upsert", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Redesign", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockRejectedValue(
      new Error("Confluence API request failed (500)"),
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "old" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale" },
      { path: "confluence/ENG/other--99.md", sha: "other" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42"] }],
        },
        mode: {
          spaceKey: "ENG",
          pageId: "42",
          eventType: "avi:confluence:updated:page",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      pagesFailed: 1,
      pagesProcessed: 0,
    })

    expect(github.commitFiles).not.toHaveBeenCalled()
  })

  it("keeps the previous leaf when a renamed page fails during full reconcile", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Redesign", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockRejectedValue(
      new Error("Confluence API request failed (500)"),
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "old" },
      { path: "confluence/ENG/_assets/42/att100--diagram.png", sha: "keep" },
      { path: "confluence/ENG/other--99.md", sha: "other" },
      { path: "confluence/ENG/_assets/99/stale.png", sha: "stale-other" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42"] }],
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      pagesFailed: 1,
      pagesProcessed: 0,
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [
          "confluence/ENG/other--99.md",
          "confluence/ENG/_assets/99/stale.png",
        ],
      }),
    )
  })

  it("preserves ambiguous legacy markdown in a space when a page fails during full reconcile", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Design", spaceId: "space-1", parentId: null },
      { id: "99", title: "Failed", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockImplementation(
      async ({ pageId }: { pageId: string }) => {
        if (pageId === "99") {
          throw new Error("Confluence API request failed (500)")
        }
        return {
          id: "42",
          title: "Design",
          spaceId: "space-1",
          parentId: null,
          bodyStorage: "<p>Hello</p>",
        }
      },
    )
    confluence.listConfluencePageAttachments.mockResolvedValue([])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "current" },
      { path: "confluence/ENG/design/index.md", sha: "legacy" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-ok" },
      { path: "confluence/ENG/failed--99.md", sha: "failed-md" },
      { path: "confluence/ENG/other--7.md", sha: "stale-id" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42", "99"] }],
        },
      }),
    ).resolves.toMatchObject({
      status: "partial_failed",
      pagesProcessed: 1,
      pagesFailed: 1,
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [
          "confluence/ENG/_assets/42/stale--old.png",
          "confluence/ENG/other--7.md",
        ],
      }),
    )
  })
})

describe("syncConfluenceContent assets", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    limitMock.mockResolvedValue([
      { name: "acme/context", githubConnectionId: "con_github" },
    ])
    github.listFilesInTree.mockResolvedValue([])
    github.getFileContent.mockResolvedValue(undefined)
    github.commitFiles.mockResolvedValue({ commitSha: "sha-1" })
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
    ])
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Design", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage:
        '<p>Before.</p><ac:image ac:alt="Architecture"><ri:attachment ri:filename="diagram.png" /></ac:image><p>After.</p>',
    })
    confluence.listConfluencePageAttachments.mockResolvedValue([
      {
        id: "att100",
        title: "diagram.png",
        fileSize: 13,
        mediaType: "image/png",
        downloadLink: "/wiki/download/attachments/42/diagram.png",
      },
      {
        id: "att200",
        title: "unused.pdf",
        fileSize: 8,
        mediaType: "application/pdf",
        downloadLink: "/wiki/download/attachments/42/unused.pdf",
      },
    ])
    confluence.downloadConfluenceAttachment.mockImplementation(
      async ({ filename }: { filename: string }) => {
        if (filename === "diagram.png") {
          return {
            status: "downloaded",
            bytes: diagramBytes,
            filename: "diagram.png",
            contentType: "image/png",
          }
        }
        return {
          status: "downloaded",
          bytes: Buffer.from("pdf-bytes"),
          filename: "unused.pdf",
          contentType: "application/pdf",
        }
      },
    )
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("logo-bytes"),
      filename: "logo.png",
      contentType: "image/png",
    })
  })

  it("writes page attachments under _assets and rewrites relative links", async () => {
    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 1,
      pagesFailed: 0,
    })

    const files = committedFiles()
    const markdown = files.find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "![Architecture](_assets/42/att100--diagram.png)",
    )
    expect(markdown?.content).toContain("Before.")
    expect(markdown?.content).toContain("After.")
    expect(markdown?.content).toContain("## Attachments")
    expect(markdown?.content).toContain(
      "[unused.pdf](_assets/42/att200--unused.pdf)",
    )
    expect(files).toEqual(
      expect.arrayContaining([
        {
          ...connectorAssetCommitFile(
            "confluence/ENG/_assets/42/att100--diagram.png",
            diagramBytes,
          ),
        },
        {
          ...connectorAssetCommitFile(
            "confluence/ENG/_assets/42/att200--unused.pdf",
            Buffer.from("pdf-bytes"),
          ),
        },
      ]),
    )
  })

  it("does not crawl ordinary Confluence links", async () => {
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage:
        '<p>Read <ac:link><ri:url ri:value="https://example.com/guide" /><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>.</p>',
    })
    confluence.listConfluencePageAttachments.mockResolvedValue([])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    expect(downloadConnectorAsset).not.toHaveBeenCalled()
    const markdown = committedFiles().find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "Read [the guide](https://example.com/guide).",
    )
  })

  it("preserves a prior attachment when its recapture download fails", async () => {
    const prior = "confluence/ENG/_assets/42/att100--diagram.png"
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "old-markdown" },
      { path: prior, sha: "old-binary" },
      { path: "confluence/ENG/_assets/42/removed--old.png", sha: "stale" },
    ])
    confluence.downloadConfluenceAttachment.mockImplementation(
      async ({ filename }: { filename: string }) =>
        filename === "diagram.png"
          ? { status: "stub", reason: "download_failed" }
          : {
              status: "downloaded",
              bytes: Buffer.from("pdf-bytes"),
              filename: "unused.pdf",
              contentType: "application/pdf",
            },
    )

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    const deletePaths = github.commitFiles.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).not.toContain(prior)
    expect(deletePaths).toContain("confluence/ENG/_assets/42/removed--old.png")
  })

  it("prunes a dangling attachment after complete metadata discovery", async () => {
    const prior = "confluence/ENG/_assets/42/att-old--removed.png"
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "old-markdown" },
      { path: prior, sha: "old-binary" },
    ])
    confluence.listConfluencePageAttachments.mockResolvedValue([])
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage:
        '<p><ac:image><ri:attachment ri:filename="removed.png" /></ac:image></p>',
    })

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    const deletePaths = github.commitFiles.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).toContain(prior)
  })

  it("prunes only the affected space during a space-scoped full reconcile", async () => {
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
      { id: "space-2", key: "DOCS", name: "Docs", homepageId: null },
    ])
    confluence.listConfluencePagesForSpace.mockImplementation(
      async ({ spaceId }: { spaceId: string }) =>
        spaceId === "space-2"
          ? [{ id: "7", title: "Intro", spaceId: "space-2", parentId: null }]
          : [{ id: "42", title: "Design", spaceId: "space-1", parentId: null }],
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/config.yaml", sha: "config" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-eng" },
      { path: "confluence/DOCS/intro--7.md", sha: "docs-md" },
      { path: "confluence/DOCS/_assets/7/keep.png", sha: "docs-keep" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [
          { spaceKey: "ENG", selectedPageIds: ["42"] },
          { spaceKey: "DOCS", selectedPageIds: ["7"] },
        ],
      },
      mode: {
        spaceKey: "ENG",
        eventType: "avi:confluence:updated:space:V2",
      },
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--old.png"],
      }),
    )
  })

  it("prunes stale paths across every managed space on a global full reconcile", async () => {
    confluence.listConfluenceSpaces.mockResolvedValue([
      { id: "space-1", key: "ENG", name: "Engineering", homepageId: null },
      { id: "space-2", key: "DOCS", name: "Docs", homepageId: null },
    ])
    confluence.listConfluencePagesForSpace.mockImplementation(
      async ({ spaceId }: { spaceId: string }) =>
        spaceId === "space-2"
          ? [{ id: "7", title: "Intro", spaceId: "space-2", parentId: null }]
          : [{ id: "42", title: "Design", spaceId: "space-1", parentId: null }],
    )
    confluence.getConfluencePageWithBody.mockImplementation(
      async ({ pageId }: { pageId: string }) =>
        pageId === "7"
          ? {
              id: "7",
              title: "Intro",
              spaceId: "space-2",
              parentId: null,
              bodyStorage: "<p>Docs.</p>",
            }
          : {
              id: "42",
              title: "Design",
              spaceId: "space-1",
              parentId: null,
              bodyStorage:
                '<p>Before.</p><ac:image ac:alt="Architecture"><ri:attachment ri:filename="diagram.png" /></ac:image><p>After.</p>',
            },
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-eng" },
      { path: "confluence/DOCS/_assets/7/stale--old.png", sha: "stale-docs" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [
          { spaceKey: "ENG", selectedPageIds: ["42"] },
          { spaceKey: "DOCS", selectedPageIds: ["7"] },
        ],
      },
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [
          "confluence/ENG/_assets/42/stale--old.png",
          "confluence/DOCS/_assets/7/stale--old.png",
        ],
      }),
    )
  })

  it("keeps current assets in the full reconcile desired set", async () => {
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/config.yaml", sha: "config" },
      {
        path: "confluence/ENG/_assets/42/att100--diagram.png",
        sha: gitBlobSha(diagramBytes),
      },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--old.png"],
      }),
    )
    expect(
      committedFiles().some(
        (file) => file.path === "confluence/ENG/_assets/42/att100--diagram.png",
      ),
    ).toBe(false)
    expect(
      committedFiles().find(
        (file) => file.path === "confluence/ENG/design--42.md",
      )?.content,
    ).toContain("![Architecture](_assets/42/att100--diagram.png)")
  })

  it("does not delete a failed page markdown or its asset prefix during full reconcile", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Design", spaceId: "space-1", parentId: null },
      { id: "99", title: "Failed", spaceId: "space-1", parentId: null },
    ])
    confluence.getConfluencePageWithBody.mockImplementation(
      async ({ pageId }: { pageId: string }) => {
        if (pageId === "99") {
          throw new Error("Confluence API request failed (500)")
        }
        return {
          id: "42",
          title: "Design",
          spaceId: "space-1",
          parentId: null,
          bodyStorage:
            '<p>Before.</p><ac:image ac:alt="Architecture"><ri:attachment ri:filename="diagram.png" /></ac:image><p>After.</p>',
        }
      },
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/config.yaml", sha: "config" },
      { path: "confluence/ENG/design--42.md", sha: "design" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale-ok" },
      { path: "confluence/ENG/failed--99.md", sha: "failed-md" },
      { path: "confluence/ENG/_assets/99/att9--keep.png", sha: "keep" },
      { path: "confluence/ENG/_assets/99/stale--old.png", sha: "stale-fail" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo: {
          spaces: [{ spaceKey: "ENG", selectedPageIds: ["42", "99"] }],
        },
      }),
    ).resolves.toMatchObject({
      status: "partial_failed",
      pagesProcessed: 1,
      pagesFailed: 1,
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--old.png"],
      }),
    )
  })

  it("preserves existing page assets when attachment listing fails on a full reconcile", async () => {
    confluence.listConfluencePageAttachments.mockRejectedValue(
      new Error("Confluence API request failed (429)"),
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "design" },
      { path: "confluence/ENG/_assets/42/att100--diagram.png", sha: "keep" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 1,
      pagesFailed: 0,
    })

    const files = committedFiles()
    const markdown = files.find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "[omitted: Architecture (download failed)]",
    )
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [],
      }),
    )
  })

  it("preserves existing page assets when attachment listing fails on single_upsert", async () => {
    confluence.listConfluencePageAttachments.mockRejectedValue(
      new Error("Confluence API request failed (500)"),
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/_assets/42/att100--diagram.png", sha: "keep" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale" },
      { path: "confluence/ENG/_assets/99/att9--keep.png", sha: "other" },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo,
        mode: {
          spaceKey: "ENG",
          pageId: "42",
          eventType: "avi:confluence:updated:page",
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 1,
      pagesFailed: 0,
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [],
      }),
    )
  })

  it("deletes the prior markdown file for the same page id after a title rename", async () => {
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Redesign",
      spaceId: "space-1",
      parentId: null,
      bodyStorage: "<p>Hello</p>",
    })
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "42", title: "Redesign", spaceId: "space-1", parentId: null },
    ])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "old" },
      { path: "confluence/ENG/other--99.md", sha: "other" },
      { path: "confluence/ENG/page--1/child--2.md", sha: "child" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
      mode: {
        spaceKey: "ENG",
        pageId: "42",
        eventType: "avi:confluence:updated:page",
      },
    })

    const files = committedFiles()
    expect(
      files.some((file) => file.path === "confluence/ENG/redesign--42.md"),
    ).toBe(true)
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/design--42.md"],
      }),
    )
  })

  it("prunes legacy branch directories that omit the page id on full reconcile", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "1", title: "Parent", spaceId: "space-1", parentId: null },
      { id: "2", title: "Child", spaceId: "space-1", parentId: "1" },
    ])
    confluence.getConfluencePageWithBody.mockImplementation(
      async ({ pageId }: { pageId: string }) =>
        pageId === "1"
          ? {
              id: "1",
              title: "Parent",
              spaceId: "space-1",
              parentId: null,
              bodyStorage: "<p>Root</p>",
            }
          : {
              id: "2",
              title: "Child",
              spaceId: "space-1",
              parentId: "1",
              bodyStorage: "<p>Leaf</p>",
            },
    )
    confluence.listConfluencePageAttachments.mockResolvedValue([])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/parent/index.md", sha: "legacy-parent" },
      { path: "confluence/ENG/parent/child--2.md", sha: "legacy-child" },
      { path: "confluence/ENG/parent--1/index.md", sha: "titled-parent" },
      { path: "confluence/ENG/parent--1/child--2.md", sha: "titled-child" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [{ spaceKey: "ENG", selectedPageIds: ["1", "2"] }],
      },
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [
          "confluence/ENG/parent/index.md",
          "confluence/ENG/parent/child--2.md",
          "confluence/ENG/parent--1/index.md",
          "confluence/ENG/parent--1/child--2.md",
        ],
      }),
    )
    const files = committedFiles()
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "confluence/ENG/page--1/index.md",
        "confluence/ENG/page--1/child--2.md",
      ]),
    )
  })

  it("does not move descendant markdown when a branch ancestor is renamed", async () => {
    confluence.listConfluencePagesForSpace.mockResolvedValue([
      { id: "1", title: "Folder", spaceId: "space-1", parentId: null },
      { id: "2", title: "Child", spaceId: "space-1", parentId: "1" },
    ])
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "1",
      title: "Folder",
      spaceId: "space-1",
      parentId: null,
      bodyStorage: "<p>Root</p>",
    })
    confluence.listConfluencePageAttachments.mockResolvedValue([])
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/page--1/index.md", sha: "parent" },
      { path: "confluence/ENG/page--1/child--2.md", sha: "child" },
      { path: "confluence/ENG/other--99.md", sha: "other" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo: {
        spaces: [{ spaceKey: "ENG", selectedPageIds: ["1", "2"] }],
      },
      mode: {
        spaceKey: "ENG",
        pageId: "1",
        eventType: "avi:confluence:updated:page",
      },
    })

    const files = committedFiles()
    expect(
      files.some((file) => file.path === "confluence/ENG/page--1/index.md"),
    ).toBe(true)
    expect(
      files.some((file) => file.path === "confluence/ENG/page--1/child--2.md"),
    ).toBe(false)
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: [],
      }),
    )
  })

  it("prunes only the page asset prefix on single_upsert", async () => {
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/other--99.md", sha: "other" },
      { path: "confluence/ENG/_assets/99/att9--keep.png", sha: "keep" },
      { path: "confluence/ENG/_assets/42/stale--old.png", sha: "stale" },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
      mode: {
        spaceKey: "ENG",
        pageId: "42",
        eventType: "avi:confluence:updated:page",
      },
    })

    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--old.png"],
      }),
    )
  })

  it("stubs failed or oversized attachments without failing the page", async () => {
    confluence.listConfluencePageAttachments.mockResolvedValue([
      {
        id: "att100",
        title: "diagram.png",
        fileSize: 26 * 1024 * 1024,
        mediaType: "image/png",
        downloadLink: "/wiki/download/attachments/42/diagram.png",
      },
    ])

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 1,
      pagesFailed: 0,
    })

    const files = committedFiles()
    const markdown = files.find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "[omitted: Architecture (exceeds 25 MiB)]",
    )
    expect(files.some((file) => file.path.includes("_assets"))).toBe(false)
    expect(confluence.downloadConfluenceAttachment).not.toHaveBeenCalled()
  })

  it("renders an explicit stub when attachment discovery is truncated", async () => {
    confluence.listConfluencePageAttachments.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `att-${index}`,
        title: `attachment-${index}.bin`,
        fileSize: 26 * 1024 * 1024,
        mediaType: "application/octet-stream",
      })),
    )
    github.listFilesInTree.mockResolvedValue([
      { path: "confluence/ENG/design--42.md", sha: "markdown" },
      {
        path: "confluence/ENG/_assets/42/att-100--attachment-100.bin",
        sha: "current-over-cap",
      },
      {
        path: "confluence/ENG/_assets/42/stale--removed.bin",
        sha: "stale",
      },
    ])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    const markdown = committedFiles().find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "[omitted: Additional attachments (page exceeds 100 MiB of attachments)]",
    )
    expect(confluence.listConfluencePageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttachments: 1_001 }),
    )
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: ["confluence/ENG/_assets/42/stale--removed.bin"],
      }),
    )
  })

  it("stubs later attachments once the page exceeds 100 MiB without failing the page", async () => {
    const twentyFourMiB = 24 * 1024 * 1024
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage:
        '<p>Keep me.</p><ac:image ac:alt="A"><ri:attachment ri:filename="a.bin" /></ac:image><ac:image ac:alt="B"><ri:attachment ri:filename="b.bin" /></ac:image><ac:image ac:alt="C"><ri:attachment ri:filename="c.bin" /></ac:image><ac:image ac:alt="D"><ri:attachment ri:filename="d.bin" /></ac:image><ac:image ac:alt="Later"><ri:attachment ri:filename="later.bin" /></ac:image>',
    })
    confluence.listConfluencePageAttachments.mockResolvedValue(
      ["a.bin", "b.bin", "c.bin", "d.bin"]
        .map((title, index) => ({
          id: `att${index + 1}`,
          title,
          fileSize: twentyFourMiB,
          mediaType: "application/octet-stream",
          downloadLink: `/wiki/download/attachments/42/${title}`,
        }))
        .concat([
          {
            id: "att-later",
            title: "later.bin",
            fileSize: 10 * 1024 * 1024,
            mediaType: "application/octet-stream",
            downloadLink: "/wiki/download/attachments/42/later.bin",
          },
        ]),
    )
    confluence.downloadConfluenceAttachment.mockImplementation(
      async ({
        filename,
        budget,
      }: {
        filename: string
        budget: ConnectorAssetBudget
      }) => {
        const consumed = consumeConnectorAssetBudget(budget, twentyFourMiB)
        if (!consumed.ok) {
          return { status: "stub", reason: consumed.reason }
        }
        return {
          status: "downloaded",
          bytes: Buffer.from(filename),
          filename,
          contentType: "application/octet-stream",
        }
      },
    )

    await expect(
      syncConfluenceContent({
        orgId: "org_1",
        env,
        forgeInstallation,
        target,
        scopeFromRepo,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      pagesProcessed: 1,
      pagesFailed: 0,
    })

    const files = committedFiles()
    const markdown = files.find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain("Keep me.")
    expect(markdown?.content).toContain(
      "[omitted: Later (page exceeds 100 MiB of attachments)]",
    )
    expect(
      files.some((file) => file.path.endsWith("att-later--later.bin")),
    ).toBe(false)
    expect(
      confluence.downloadConfluenceAttachment.mock.calls.map(
        (call) => call[0].filename,
      ),
    ).toEqual(["a.bin", "b.bin", "c.bin", "d.bin"])
  })

  it("downloads explicit external ri:url media with the safe shared downloader", async () => {
    confluence.getConfluencePageWithBody.mockResolvedValue({
      id: "42",
      title: "Design",
      spaceId: "space-1",
      parentId: null,
      bodyStorage:
        '<p>Logo:</p><ac:image ac:alt="Logo"><ri:url ri:value="https://cdn.example.com/logo.png" /></ac:image>',
    })
    confluence.listConfluencePageAttachments.mockResolvedValue([])

    await syncConfluenceContent({
      orgId: "org_1",
      env,
      forgeInstallation,
      target,
      scopeFromRepo,
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/logo.png",
      }),
    )
    const authCall = downloadConnectorAsset.mock.calls[0]?.[0] as {
      headers?: Record<string, string>
      authenticatedHosts?: string[]
    }
    expect(authCall.headers?.authorization).toBeUndefined()
    const files = committedFiles()
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "confluence/ENG/_assets/42/2443b42f4c45--logo.png",
          encoding: "base64",
        }),
      ]),
    )
    const markdown = files.find(
      (file) => file.path === "confluence/ENG/design--42.md",
    )
    expect(markdown?.content).toContain(
      "![Logo](_assets/42/2443b42f4c45--logo.png)",
    )
  })
})
