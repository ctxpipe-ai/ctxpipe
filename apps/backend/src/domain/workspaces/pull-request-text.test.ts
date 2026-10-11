import { describe, expect, it } from "vitest"
import {
  pullRequestBody,
  pullRequestTitle,
  refreshedPullRequestBody,
} from "./pull-request-text.js"

const changes = {
  commits: [
    "docs: add referral bonus knowledge\n\nThe page explains the bonus.",
    "Link the referral page from the loyalty program",
  ],
  files: [
    { path: "knowledge/rewards/referral-bonus.md", status: "added" },
    { path: "knowledge/rewards/loyalty-program.md", status: "modified" },
  ],
}

describe("pullRequestTitle", () => {
  it("uses the conversation name as one clean line", () => {
    expect(pullRequestTitle('"Referral bonus docs."\n\nMore', changes)).toBe(
      "Referral bonus docs",
    )
  })

  it("names the changed file when the conversation has no name", () => {
    expect(
      pullRequestTitle("New conversation", {
        commits: [],
        files: [changes.files[0] ?? { path: "", status: "" }],
      }),
    ).toBe("Update referral-bonus.md")
  })

  it("names two files, then counts the others", () => {
    expect(pullRequestTitle("", changes)).toBe(
      "Update referral-bonus.md and loyalty-program.md",
    )
    expect(
      pullRequestTitle(null, {
        commits: [],
        files: [...changes.files, { path: "README.md", status: "modified" }],
      }),
    ).toBe("Update referral-bonus.md and 2 other files")
  })

  it("masks a credential in the conversation name", () => {
    const title = pullRequestTitle(
      "Clone with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      changes,
    )
    expect(title).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
  })

  it("falls back to a fixed title without a name or files", () => {
    expect(pullRequestTitle("  ", { commits: [], files: [] })).toBe(
      "Changes from ctx|",
    )
  })
})

describe("pullRequestBody", () => {
  it("lists the commit subjects, the changed files and the conversation", () => {
    const body = pullRequestBody({
      changes,
      conversationUrl: "https://app.example.com/acme/ws/docs/conv_1",
    })
    expect(body).toContain("- docs: add referral bonus knowledge\n")
    expect(body).not.toContain("The page explains the bonus")
    expect(body).toContain("- `knowledge/rewards/referral-bonus.md` (added)")
    expect(body).toContain(
      "[Open the conversation in ctx|](https://app.example.com/acme/ws/docs/conv_1)",
    )
  })

  it("masks a credential in a commit message", () => {
    const body = pullRequestBody({
      changes: {
        commits: ["Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the clone"],
        files: [],
      },
      conversationUrl: null,
    })
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(body).toContain("[masked]")
    expect(body).not.toContain("Open the conversation")
  })

  it("shows at most 50 files", () => {
    const files = Array.from({ length: 53 }, (_, index) => ({
      path: `docs/page-${index}.md`,
      status: "added",
    }))
    const body = pullRequestBody({
      changes: { commits: [], files },
      conversationUrl: null,
    })
    expect(body).toContain("docs/page-49.md")
    expect(body).not.toContain("docs/page-50.md")
    expect(body).toContain("- 3 more files")
  })
})

describe("refreshedPullRequestBody", () => {
  const generated = pullRequestBody({ changes, conversationUrl: null })

  it("writes the generated body into an empty body", () => {
    expect(refreshedPullRequestBody("", generated)).toBe(generated)
    expect(refreshedPullRequestBody(null, generated)).toBe(generated)
  })

  it("replaces only the ctx| section and keeps the text a person added", () => {
    const old = pullRequestBody({
      changes: { commits: ["Old"], files: [] },
      conversationUrl: null,
    })
    const refreshed = refreshedPullRequestBody(
      `Reviewer notes first.\n\n${old}\n\nThanks!`,
      generated,
    )
    expect(refreshed).toBe(`Reviewer notes first.\n\n${generated}\n\nThanks!`)
  })

  it("leaves a body a person wrote without the ctx| section", () => {
    expect(refreshedPullRequestBody("My own text", generated)).toBeNull()
  })

  it("does nothing when the body is already current", () => {
    expect(refreshedPullRequestBody(generated, generated)).toBeNull()
  })
})
