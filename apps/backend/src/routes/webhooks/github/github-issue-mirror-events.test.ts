import { describe, expect, it } from "vitest"

import { githubIssueMirrorRequest } from "./github-issue-mirror-events.js"

const base = {
  repository: { full_name: "acme/api" },
  installation: { id: 42 },
}

describe("githubIssueMirrorRequest", () => {
  it("names the changed issue and a version for each action and comment", () => {
    expect(
      githubIssueMirrorRequest("issues", {
        ...base,
        action: "edited",
        issue: { number: 7, updated_at: "2026-03-02T00:00:00Z" },
      }),
    ).toEqual({
      installationId: 42,
      repositoryFullName: "acme/api",
      number: 7,
      version: "issues.edited:2026-03-02T00:00:00Z",
    })
    // A delete keeps the time of the last change, so the action is in the version.
    expect(
      githubIssueMirrorRequest("issues", {
        ...base,
        action: "deleted",
        issue: { number: 7, updated_at: "2026-03-02T00:00:00Z" },
      })?.version,
    ).toBe("issues.deleted:2026-03-02T00:00:00Z")
    // A comment is versioned by the comment time.
    expect(
      githubIssueMirrorRequest("issue_comment", {
        ...base,
        action: "created",
        issue: { number: 7, updated_at: "2026-03-01T00:00:00Z" },
        comment: { created_at: "2026-03-03T00:00:00Z" },
      })?.version,
    ).toBe("issue_comment.created:2026-03-03T00:00:00Z")
  })

  it("leaves pull requests and other events to other handlers", () => {
    expect(
      githubIssueMirrorRequest("issue_comment", {
        ...base,
        action: "created",
        issue: { number: 7, pull_request: { url: "x" } },
        comment: { created_at: "2026-03-03T00:00:00Z" },
      }),
    ).toBeNull()
    expect(
      githubIssueMirrorRequest("pull_request", {
        ...base,
        action: "closed",
        issue: { number: 7 },
      }),
    ).toBeNull()
    expect(githubIssueMirrorRequest("issues", { action: "opened" })).toBeNull()
  })
})
