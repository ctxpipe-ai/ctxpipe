import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LinearAttachmentMetadata } from "./converter.js"

const downloadConnectorAsset = vi.hoisted(() => vi.fn())

vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return { ...actual, downloadConnectorAsset }
})

import { gitBlobSha } from "../connectors/assets.js"
import {
  captureLinearEntityAssets,
  linearEntityMirrorFiles,
  linearIssueMirrorFiles,
  linearManagedPathsForEntity,
} from "./assets.js"

const pngBytes = Buffer.from("png-bytes")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("captureLinearEntityAssets", () => {
  it("downloads Linear uploads with private auth only on trusted hosts", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "diagram.png",
      contentType: "image/png",
    })

    const attachments: LinearAttachmentMetadata[] = [
      {
        id: "attachment-4",
        title: "diagram.png",
        url: "https://uploads.linear.app/org/file.png",
        sourceType: "upload",
        metadata: null,
      },
    ]

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/issues/eng-45--issue-4.md",
      accessToken: "lin_oauth_token",
      attachments,
      markdownSources: [
        "See ![diagram](https://uploads.linear.app/org/file.png) please",
      ],
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.linear.app/org/file.png",
        headers: { Authorization: "Bearer lin_oauth_token" },
        authenticatedHosts: expect.arrayContaining(["uploads.linear.app"]),
      }),
    )
    expect(captured.files).toEqual([
      {
        path: "linear/issues/eng-45--issue-4/assets/attachment-4--diagram.png",
        content: pngBytes.toString("base64"),
        encoding: "base64",
      },
    ])
    expect(
      captured.rewriteMarkdown(
        "See ![diagram](https://uploads.linear.app/org/file.png) please",
      ),
    ).toBe(
      "See ![diagram](eng-45--issue-4/assets/attachment-4--diagram.png) please",
    )
  })

  it("downloads explicit external markdown images without Linear credentials", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "architecture.png",
      contentType: "image/png",
    })

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/documents/spec--doc-1.md",
      accessToken: "lin_oauth_token",
      attachments: [],
      markdownSources: [
        "Diagram ![architecture](https://example.com/architecture.png)",
      ],
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/architecture.png",
        headers: undefined,
        authenticatedHosts: [],
      }),
    )
    expect(captured.files[0]?.path).toMatch(
      /^linear\/documents\/spec--doc-1\/assets\/src-[a-f0-9]+--architecture\.png$/,
    )
    expect(
      captured.rewriteMarkdown(
        "Diagram ![architecture](https://example.com/architecture.png)",
      ),
    ).toContain("![architecture](spec--doc-1/assets/")
    expect(captured.rewriteMarkdown("...")).not.toContain("lin_oauth_token")
  })

  it("downloads explicit images with angle-bracket, nested, and escaped destinations", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "nested.png",
      contentType: "image/png",
    })

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/documents/spec--doc-1.md",
      accessToken: "lin_oauth_token",
      attachments: [],
      markdownSources: [
        [
          "![x](<https://cdn.example.com/a(b).png?sig=1>)",
          "![shot](https://cdn.example.com/a(b(c)).png)",
          "![esc](https://cdn.example.com/a\\(b\\).png)",
          "[not-an-image](https://cdn.example.com/skip.png)",
        ].join("\n"),
      ],
    })

    const downloadedUrls = downloadConnectorAsset.mock.calls.map(
      (call) => call[0]?.url,
    )
    expect(downloadedUrls).toEqual([
      "https://cdn.example.com/a(b).png?sig=1",
      "https://cdn.example.com/a(b(c)).png",
      "https://cdn.example.com/a(b).png",
    ])
    expect(downloadedUrls).not.toContain("https://cdn.example.com/skip.png")
    expect(
      captured.rewriteMarkdown(
        "![x](<https://cdn.example.com/a(b).png?sig=1>)",
      ),
    ).toContain("![x](spec--doc-1/assets/")
    expect(
      captured.rewriteMarkdown(
        "![x](<https://cdn.example.com/a(b).png?sig=1>)",
      ),
    ).not.toContain("sig=1")
  })

  it("downloads reference-style images and ignores fenced or inline code copies", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "ref.png",
      contentType: "image/png",
    })

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/documents/spec--doc-1.md",
      accessToken: "lin_oauth_token",
      attachments: [],
      markdownSources: [
        [
          "See ![diagram][shot] and `![nope](https://cdn.example.com/inline.png)`",
          "",
          "```",
          "![nope](https://cdn.example.com/fenced.png)",
          "```",
          "",
          "[shot]: https://cdn.example.com/a(b).png?token=expiring",
        ].join("\n"),
      ],
    })

    expect(
      downloadConnectorAsset.mock.calls.map((call) => call[0]?.url),
    ).toEqual(["https://cdn.example.com/a(b).png?token=expiring"])
    const rewritten = captured.rewriteMarkdown(
      [
        "See ![diagram][shot]",
        "",
        "[shot]: https://cdn.example.com/a(b).png?token=expiring",
      ].join("\n"),
    )
    expect(rewritten).toContain("See ![diagram](spec--doc-1/assets/")
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("token=expiring")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("leaves ordinary link attachments as metadata and does not download them", async () => {
    const files = await linearIssueMirrorFiles(
      {
        id: "issue-2",
        identifier: "ENG-43",
        title: "Document behaviour",
        description: "See the linked design.",
        url: "https://linear.app/acme/issue/ENG-43",
        priorityLabel: "No priority",
        state: "Todo",
        labels: [],
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        comments: [],
        attachments: [
          {
            id: "attachment-2",
            title: "Design",
            url: "https://example.com/design",
            sourceType: "link",
            metadata: null,
          },
        ],
      },
      "lin_oauth_token",
    )

    expect(downloadConnectorAsset).not.toHaveBeenCalled()
    expect(files.map((file) => file.path)).toEqual([
      "linear/issues/eng-43--issue-2.md",
    ])
    expect(files[0]?.content).toContain("sourceType: link")
    expect(files[0]?.content).toContain("title: Design")
    expect(files[0]?.content).toContain("https://example.com/design")
  })

  it("keeps GitHub pull request and commit attachments reference-only", async () => {
    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/issues/eng-42--issue-1.md",
      accessToken: "lin_oauth_token",
      attachments: [
        {
          id: "attachment-pr",
          title: "acme/product#123",
          url: "https://github.com/acme/product/pull/123",
          sourceType: "github",
          metadata: { state: "merged" },
        },
        {
          id: "attachment-commit",
          title: "fix",
          url: "https://github.com/acme/product/commit/abc123",
          sourceType: "github",
          metadata: null,
        },
      ],
      markdownSources: ["See the PR"],
    })

    expect(downloadConnectorAsset).not.toHaveBeenCalled()
    expect(captured.files).toEqual([])
  })

  it("falls back to a stub when download fails or exceeds the entity budget", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "entity_limit",
    })

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/issues/eng-44--issue-3.md",
      accessToken: "lin_oauth_token",
      attachments: [
        {
          id: "attachment-3",
          title: "Shot",
          url: "https://uploads.linear.app/org/shot.png",
          sourceType: "upload",
          metadata: null,
        },
      ],
      markdownSources: [
        "See ![diagram](https://uploads.linear.app/org/shot.png) please",
      ],
    })

    expect(captured.files).toEqual([])
    expect(
      captured.rewriteMarkdown(
        "See ![diagram](https://uploads.linear.app/org/shot.png) please",
      ),
    ).toBe("See [image: diagram — view in Linear] please")
  })

  it("stubs failed external markdown media without persisting the source URL", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })

    const captured = await captureLinearEntityAssets({
      markdownPath: "linear/documents/spec--doc-1.md",
      accessToken: "lin_oauth_token",
      attachments: [],
      markdownSources: [
        "Diagram ![architecture](https://cdn.example.com/signed/architecture.png?token=expiring)",
      ],
    })

    expect(captured.files).toEqual([])
    const rewritten = captured.rewriteMarkdown(
      "Diagram ![architecture](https://cdn.example.com/signed/architecture.png?token=expiring)",
    )
    expect(rewritten).toContain("[image: architecture — unavailable]")
    expect(rewritten).not.toContain("https://cdn.example.com/")
    expect(rewritten).not.toContain("token=expiring")
    expect(rewritten).not.toContain("](")
  })
})

describe("linearIssueMirrorFiles", () => {
  it("includes the markdown file and captured sidecar bytes", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "diagram.png",
      contentType: "image/png",
    })

    const files = await linearIssueMirrorFiles(
      {
        id: "issue-4",
        identifier: "ENG-45",
        title: "Captured screenshot",
        description:
          "See ![diagram](https://uploads.linear.app/org/file.png) please",
        url: "https://linear.app/acme/issue/ENG-45",
        priorityLabel: "Low",
        state: "Todo",
        labels: [],
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        comments: [],
        attachments: [
          {
            id: "attachment-4",
            title: "diagram.png",
            url: "https://uploads.linear.app/org/file.png",
            sourceType: "upload",
            metadata: null,
          },
        ],
      },
      "lin_oauth_token",
    )

    expect(files.map((file) => file.path)).toEqual([
      "linear/issues/eng-45--issue-4.md",
      "linear/issues/eng-45--issue-4/assets/attachment-4--diagram.png",
    ])
    expect(files[1]).toMatchObject({
      encoding: "base64",
      content: pngBytes.toString("base64"),
    })
    expect(gitBlobSha(pngBytes)).toHaveLength(40)
  })

  it("captures explicit inline media from issue comments", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "comment.png",
      contentType: "image/png",
    })

    const files = await linearIssueMirrorFiles(
      {
        id: "issue-5",
        identifier: "ENG-46",
        title: "Comment screenshot",
        description: "No image in the description.",
        url: "https://linear.app/acme/issue/ENG-46",
        priorityLabel: "Low",
        state: "Todo",
        labels: [],
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        comments: [
          {
            id: "comment-9",
            body: "See ![comment-shot](https://uploads.linear.app/org/comment.png)",
            userId: "user-1",
            userName: "Ada",
            createdAt: new Date("2026-08-01T01:00:00.000Z"),
            updatedAt: new Date("2026-08-01T01:00:00.000Z"),
          },
        ],
        attachments: [],
      },
      "lin_oauth_token",
    )

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.linear.app/org/comment.png",
        headers: { Authorization: "Bearer lin_oauth_token" },
      }),
    )
    const markdown = files.find((file) => file.path.endsWith(".md"))
    expect(markdown?.content).toContain("## Comments")
    expect(markdown?.content).toContain(
      "![comment-shot](eng-46--issue-5/assets/",
    )
    expect(markdown?.content).not.toContain("https://uploads.linear.app/")
    expect(files.some((file) => file.encoding === "base64")).toBe(true)
  })
})

describe("linearEntityMirrorFiles", () => {
  it("captures explicit inline media from update bodies", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: pngBytes,
      filename: "status.png",
      contentType: "image/png",
    })

    const files = await linearEntityMirrorFiles({
      directory: "projects",
      type: "project",
      id: "project-1",
      title: "Launch",
      body: "Project description without media.",
      sections: [
        {
          heading: "Update · 2026-08-02T00:00:00.000Z",
          body: "Health: onTrack\n\n![status](https://example.com/status.png)",
        },
      ],
      accessToken: "lin_oauth_token",
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/status.png",
        headers: undefined,
        authenticatedHosts: [],
      }),
    )
    expect(files[0]?.content).toContain("## Update · 2026-08-02T00:00:00.000Z")
    expect(files[0]?.content).toContain("![status](launch--project-1/assets/")
    expect(files[0]?.content).not.toContain("https://example.com/status.png")
    expect(files.some((file) => file.encoding === "base64")).toBe(true)
  })
})

describe("linearManagedPathsForEntity", () => {
  it("selects the entity markdown file and its sibling asset tree", () => {
    expect(
      linearManagedPathsForEntity(
        [
          "linear/config.yaml",
          "linear/issues/pro-1--issue-1.md",
          "linear/issues/pro-1--issue-1/assets/attachment-4--diagram.png",
          "linear/issues/pro-1--issue-10.md",
          "linear/issues/pro-1--issue-10/assets/other.png",
          "README.md",
        ],
        "issue-1",
      ),
    ).toEqual([
      "linear/issues/pro-1--issue-1.md",
      "linear/issues/pro-1--issue-1/assets/attachment-4--diagram.png",
    ])
  })
})
