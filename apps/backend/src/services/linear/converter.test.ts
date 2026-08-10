import { describe, expect, it } from "vitest"
import { renderLinearIssue } from "./converter.js"

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
      projectId: "project-1",
      cycleId: null,
      assigneeId: null,
      creatorId: "user-1",
      labelIds: ["label-1"],
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
      projectId: null,
      cycleId: null,
      assigneeId: null,
      creatorId: null,
      labelIds: [],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          body: "Linear-native context",
          userId: "user-1",
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
    expect(file.content).toContain("Design")
    expect(file.content).toContain("https://example.com/design")
  })
})
