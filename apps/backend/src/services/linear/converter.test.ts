import { describe, expect, it } from "vitest"
import { renderLinearIssue, rewriteLinearPrivateMedia } from "./converter.js"

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
    expect(file.content).toContain("Linear-hosted file omitted")
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
})
