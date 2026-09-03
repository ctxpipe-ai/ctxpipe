import { describe, expect, it } from "vitest"
import {
  applyLinearAssetRewrites,
  isLinearGithubReferenceAttachment,
  renderLinearIssue,
  rewriteLinearPrivateMedia,
} from "./converter.js"

describe("renderLinearIssue", () => {
  it("keeps GitHub attachments as reference metadata without duplicating PR content", () => {
    const file = renderLinearIssue({
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship connector",
      description: "Linear-owned issue description",
      url: "https://linear.app/acme/issue/ENG-42",
      priorityLabel: "High",
      state: "In Progress",
      teamId: "team-1",
      teamKey: "ENG",
      teamName: "Engineering",
      projectId: "project-1",
      projectName: "Connector work",
      cycleId: null,
      cycleName: null,
      assigneeId: "user-2",
      assignee: "Ada Lovelace",
      creatorId: "user-1",
      creator: "Grace Hopper",
      labels: [{ id: "label-1", name: "bug" }],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      comments: [],
      attachments: [
        {
          id: "attachment-1",
          title: "acme/product#123",
          url: "https://github.com/acme/product/pull/123",
          sourceType: "github",
          metadata: {
            state: "merged",
            body: "This must not be mirrored",
            diff: "+private implementation",
            reviews: [{ state: "approved" }],
          },
        },
      ],
    })

    expect(file.path).toBe("linear/issues/eng-42--issue-1.md")
    expect(file.content).toContain("githubReferences:")
    expect(file.content).toContain("state: merged")
    expect(file.content).toContain("https://github.com/acme/product/pull/123")
    expect(file.content).toContain("assignee: Ada Lovelace")
    expect(file.content).toContain("creator: Grace Hopper")
    expect(file.content).toContain("team: Engineering")
    expect(file.content).toContain("labels:\n  - bug")
    expect(file.content).not.toContain("This must not be mirrored")
    expect(file.content).not.toContain("private implementation")
    expect(file.content).not.toContain("approved")
  })

  it("keeps native comments and non-GitHub attachment metadata", () => {
    const file = renderLinearIssue({
      id: "issue-2",
      identifier: "ENG-43",
      title: "Document behaviour",
      description: null,
      url: "https://linear.app/acme/issue/ENG-43",
      priorityLabel: "No priority",
      state: "Todo",
      teamId: "team-1",
      teamKey: "ENG",
      teamName: "Engineering",
      projectId: null,
      projectName: null,
      cycleId: null,
      cycleName: null,
      assigneeId: null,
      assignee: null,
      creatorId: null,
      creator: null,
      labels: [],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          body: "Linear-native context",
          userId: "user-1",
          userName: "Ada Lovelace",
          createdAt: new Date("2026-08-01T01:00:00.000Z"),
          updatedAt: new Date("2026-08-01T01:00:00.000Z"),
        },
      ],
      attachments: [
        {
          id: "attachment-2",
          title: "Design",
          url: "https://example.com/design",
          sourceType: "link",
          metadata: null,
        },
      ],
    })

    expect(file.content).toContain("Linear-native context")
    expect(file.content).toContain("Ada Lovelace")
    expect(file.content).toContain("Design")
    expect(file.content).toContain("https://example.com/design")
  })

  it("rewrites captured uploads to sibling asset paths and keeps GitHub attachments as references", () => {
    const file = renderLinearIssue(
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
          {
            id: "attachment-gh",
            title: "acme/product#9",
            url: "https://github.com/acme/product/pull/9",
            sourceType: "github",
            metadata: { state: "open" },
          },
        ],
      },
      [
        {
          sourceUrl: "https://uploads.linear.app/org/file.png",
          sourceKey: "attachment-4",
          relativePath: "eng-45--issue-4/assets/attachment-4--diagram.png",
          gitPath:
            "linear/issues/eng-45--issue-4/assets/attachment-4--diagram.png",
          status: "downloaded",
          filename: "diagram.png",
        },
      ],
    )

    expect(file.path).toBe("linear/issues/eng-45--issue-4.md")
    expect(file.content).toContain(
      "![diagram](eng-45--issue-4/assets/attachment-4--diagram.png)",
    )
    expect(file.content).not.toContain("https://uploads.linear.app/")
    expect(file.content).toContain(
      "path: eng-45--issue-4/assets/attachment-4--diagram.png",
    )
    expect(file.content).toContain("githubReferences:")
    expect(file.content).toContain("https://github.com/acme/product/pull/9")
    expect(file.content).not.toContain("File omitted")
  })

  it("strips Linear upload URLs from description, comments, and attachment metadata", () => {
    const file = renderLinearIssue({
      id: "issue-3",
      identifier: "ENG-44",
      title: "Screenshot",
      description:
        "See ![diagram](https://uploads.linear.app/org/file.png) please",
      url: "https://linear.app/acme/issue/ENG-44",
      priorityLabel: "Low",
      state: "Todo",
      labels: [],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      comments: [
        {
          id: "comment-2",
          body: "[shot](https://uploads.linear.app/org/shot.png)",
          userId: "user-1",
          userName: "Ada",
          createdAt: new Date("2026-08-01T01:00:00.000Z"),
          updatedAt: new Date("2026-08-01T01:00:00.000Z"),
        },
      ],
      attachments: [
        {
          id: "attachment-3",
          title: "Shot",
          url: "https://uploads.linear.app/org/shot.png",
          sourceType: "upload",
          metadata: null,
        },
      ],
    })

    expect(file.content).toContain("[image: diagram — view in Linear]")
    expect(file.content).toContain("[shot — view in Linear]")
    expect(file.content).not.toContain("https://uploads.linear.app/")
    expect(file.content).toContain("File omitted")
  })

  it("does not persist a failed file attachment's signed URL", () => {
    const signedUrl = "https://cdn.example.com/spec.pdf?token=expiring"
    const file = renderLinearIssue(
      {
        id: "issue-5",
        identifier: "ENG-46",
        title: "External file",
        description: null,
        url: "https://linear.app/acme/issue/ENG-46",
        priorityLabel: "Low",
        labels: [],
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        comments: [],
        attachments: [
          {
            id: "attachment-5",
            title: "spec.pdf",
            url: signedUrl,
            sourceType: "file",
            metadata: null,
          },
        ],
      },
      [
        {
          sourceUrl: signedUrl,
          sourceKey: "attachment-5",
          relativePath: "eng-46--issue-5/assets/attachment-5--spec.pdf",
          gitPath:
            "linear/issues/eng-46--issue-5/assets/attachment-5--spec.pdf",
          status: "stub",
          reason: "download_failed",
        },
      ],
    )

    expect(file.content).toContain("File omitted")
    expect(file.content).not.toContain(signedUrl)
    expect(file.content).not.toContain("token=expiring")
  })

  it("does not persist an uncaptured attachment's signed URL", () => {
    const signedUrl =
      "https://cdn.example.com/spec.pdf?X-Amz-Credential=key&X-Amz-Signature=secret"
    const file = renderLinearIssue({
      id: "issue-6",
      identifier: "ENG-47",
      title: "External link attachment",
      description: null,
      url: "https://linear.app/acme/issue/ENG-47",
      priorityLabel: "Low",
      labels: [],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      comments: [],
      attachments: [
        {
          id: "attachment-6",
          title: "spec.pdf",
          url: signedUrl,
          sourceType: "link",
          metadata: null,
        },
      ],
    })

    expect(file.content).toContain(
      "File omitted; open the issue in Linear to view it.",
    )
    expect(file.content).not.toContain("cdn.example.com")
    expect(file.content).not.toContain("secret")
  })
})

describe("rewriteLinearPrivateMedia", () => {
  it("leaves external markdown links alone", () => {
    expect(
      rewriteLinearPrivateMedia(
        "![a](https://example.com/a.png) [b](https://example.com/b)",
      ),
    ).toBe("![a](https://example.com/a.png) [b](https://example.com/b)")
  })

  it("redacts private Linear URLs even when surrounding Markdown is malformed", () => {
    const privateUrl =
      "https://uploads.linear.app/acme/diagram.png?X-Amz-Signature=secret"
    const rewritten = rewriteLinearPrivateMedia(
      `Keep ![diagram](${privateUrl} please`,
    )

    expect(rewritten).toContain("Keep")
    expect(rewritten).toContain("diagram")
    expect(rewritten).not.toContain("uploads.linear.app")
    expect(rewritten).not.toContain("secret")
  })

  it("redacts protocol-relative private Linear URLs", () => {
    const rewritten = rewriteLinearPrivateMedia(
      "![diagram](//uploads.linear.app/acme/diagram.png?X-Amz-Signature=secret)",
    )

    expect(rewritten).toContain("diagram")
    expect(rewritten).not.toContain("uploads.linear.app")
    expect(rewritten).not.toContain("secret")
  })

  it("redacts signed external links and bare URLs", () => {
    const signedUrl =
      "https://cdn.example.com/spec.pdf?X-Amz-Credential=key&X-Amz-Signature=secret"
    const credentialedUrl =
      "https://temporary-user:temporary-password@cdn.example.com/private.pdf"
    const rewritten = rewriteLinearPrivateMedia(
      `[download](${signedUrl}) or ${signedUrl} or ${credentialedUrl}`,
    )

    expect(rewritten).toContain("download")
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("secret")
    expect(rewritten).not.toContain("temporary-password")
  })

  it("only classifies canonical GitHub pull and commit paths as references", () => {
    const attachment = {
      id: "attachment-1",
      title: "spec.pdf",
      sourceType: "upload",
      metadata: null,
    }
    expect(
      isLinearGithubReferenceAttachment({
        ...attachment,
        url: "https://github.com/acme/product/releases/download/commit/spec.pdf",
      }),
    ).toBe(false)
    expect(
      isLinearGithubReferenceAttachment({
        ...attachment,
        url: "https://github.com/acme/product/pull/123/files",
      }),
    ).toBe(true)
    expect(
      isLinearGithubReferenceAttachment({
        ...attachment,
        url: "https://github.com/acme/product/commit/abcdef1234567",
      }),
    ).toBe(true)
  })

  it("escapes provider-authored media labels before writing Markdown", () => {
    const sourceUrl = "https://uploads.linear.app/acme/diagram.png"
    const rewritten = applyLinearAssetRewrites(
      `<img alt="Diagram [draft]](https://evil.example)" src="${sourceUrl}">`,
      [
        {
          status: "downloaded",
          sourceUrl,
          sourceKey: "diagram",
          relativePath: "./assets/diagram.png",
          gitPath: "linear/issues/ENG-42/assets/diagram.png",
          filename: "diagram.png",
        },
      ],
    )

    expect(rewritten).toBe(
      "![Diagram \\[draft\\]\\](https://evil.example)](./assets/diagram.png)",
    )
    expect(rewritten).not.toContain("![Diagram](https://evil.example)")
  })
})
