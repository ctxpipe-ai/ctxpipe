import { describe, expect, it } from "vitest"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationCommitPushEnabled,
  conversationCreatePrEnabled,
  conversationGithubTreeHref,
  conversationPublishErrorMessage,
  conversationPullRequestAction,
  conversationPullRequestVisible,
} from "./conversationPublish"

describe("conversation publish helpers", () => {
  it("uses the server capability with a fallback for older responses", () => {
    expect(conversationAllowsEdits("writable")).toBe(true)
    expect(conversationAllowsEdits("read_only")).toBe(false)
    expect(conversationAllowsEdits("unknown")).toBe(false)
    expect(conversationAllowsEdits("read_only", true)).toBe(true)
    expect(conversationAllowsEdits("writable", false)).toBe(false)
  })

  it("names the session branch by its number", () => {
    expect(conversationBranchShortName("ctxpipe/chat/conv_1/1")).toBe("chat/1")
    expect(conversationBranchShortName("ctxpipe/chat/conv_1/2")).toBe("chat/2")
    expect(conversationBranchShortName("main")).toBe("main")
  })

  it("shows Create PR after merge and Show PR while open", () => {
    expect(conversationPullRequestAction("open")).toBe("show")
    expect(conversationPullRequestAction("merged")).toBe("create")
    expect(conversationPullRequestAction(null)).toBe("create")
  })

  it("shows Commit+Push when the sandbox has changes GitHub lacks", () => {
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: false,
        unpushed: false,
      }),
    ).toBe(false)
    // The agent committed but did not push.
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: true,
      }),
    ).toBe(true)
    // Everything is on GitHub.
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: false,
      }),
    ).toBe(false)
    expect(
      conversationCommitPushEnabled({
        dirty: true,
        differsFromDefault: true,
        unpushed: true,
      }),
    ).toBe(true)
  })

  it("shows Create PR when there are commits to publish", () => {
    expect(
      conversationCreatePrEnabled({
        dirty: false,
        differsFromDefault: false,
        unpushed: false,
      }),
    ).toBe(false)
    // Commits the agent did not push yet: Create PR pushes them first.
    expect(
      conversationCreatePrEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: true,
        ahead: 1,
      }),
    ).toBe(true)
    // The branch is on GitHub.
    expect(
      conversationCreatePrEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: false,
        published: true,
      }),
    ).toBe(true)
    // Only uncommitted files (a fresh branch after a merge): Commit+Push first.
    expect(
      conversationCreatePrEnabled({
        dirty: true,
        differsFromDefault: true,
        unpushed: true,
        ahead: 0,
        published: false,
      }),
    ).toBe(false)
    expect(conversationPullRequestVisible(null, "create")).toBe(false)
    expect(conversationPullRequestVisible(null, "show")).toBe(true)
    expect(
      conversationPullRequestVisible(
        {
          dirty: false,
          differsFromDefault: false,
          unpushed: false,
        },
        "create",
      ),
    ).toBe(false)
  })

  it("blocks publishing a stale conversation branch", () => {
    const stale = {
      dirty: true,
      differsFromDefault: true,
      unpushed: true,
      stale: true,
    } as const
    expect(conversationCommitPushEnabled(stale)).toBe(false)
    expect(conversationCreatePrEnabled(stale)).toBe(false)
  })

  it("builds a GitHub tree href after the first push", () => {
    expect(
      conversationGithubTreeHref(
        "https://github.com/acme/docs.git",
        "ctxpipe/chat/conv_1/1",
      ),
    ).toBe("https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1")
  })
})

describe("conversationPublishErrorMessage", () => {
  it("names the cause of a known error code", () => {
    expect(
      conversationPublishErrorMessage("Commit+Push", new Error("turn_running")),
    ).toBe(
      "Commit+Push failed. The agent is still working. Try again when the turn ends.",
    )
    expect(
      conversationPublishErrorMessage("Create PR", new Error("no_pr_access")),
    ).toBe(
      "Create PR failed. The ctx| GitHub App can't open pull requests. Give it the Pull requests: Read and write permission.",
    )
  })

  it("gives every stale code the same message", () => {
    for (const code of ["stale_sha", "stale_url", "stale_binding"])
      expect(
        conversationPublishErrorMessage("Create PR", new Error(code)),
      ).toBe(
        "Create PR failed. The Workspace moved. Reload the page and try again.",
      )
  })

  it("shows an unknown code as it is", () => {
    expect(
      conversationPublishErrorMessage("Create PR", new Error("odd_code")),
    ).toBe("Create PR failed (odd_code).")
  })
})
