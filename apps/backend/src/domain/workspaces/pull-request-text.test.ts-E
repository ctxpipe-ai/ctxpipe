import { describe, expect, it } from "vitest"
import { pullRequestBody, pullRequestTitle } from "./pull-request-text.js"

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
      "Changes from ctxpipe",
    )
  })
})

describe("pullRequestBody", () => {
  it("lists the commit subjects and links the conversation, without files", () => {
    const body = pullRequestBody({
      changes,
      conversationUrl: "https://app.example.com/acme/ws/docs/conv_1",
    })
    expect(body).toBe(
      [
        "- docs: add referral bonus knowledge",
        "- Link the referral page from the loyalty program",
        "",
        "[Open the conversation in ctxpipe](https://app.example.com/acme/ws/docs/conv_1)",
      ].join("\n"),
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
    expect(body).toBe("- Use [masked] for the clone")
  })

  it("says where the changes come from when there is nothing else", () => {
    expect(
      pullRequestBody({
        changes: { commits: [], files: [] },
        conversationUrl: null,
      }),
    ).toBe("Changes made in a ctxpipe conversation.")
  })
})
