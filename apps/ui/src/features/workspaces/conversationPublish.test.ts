import { describe, expect, it } from "vitest"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationCommitPushEnabled,
  conversationCreatePrEnabled,
  conversationGithubTreeHref,
  conversationPullRequestAction,
  conversationPullRequestVisible,
  conversationSessionBranch,
} from "./conversationPublish"

describe("conversation publish helpers", () => {
  it("uses the server capability with a fallback for older responses", () => {
    expect(conversationAllowsEdits("writable")).toBe(true)
    expect(conversationAllowsEdits("read_only")).toBe(false)
    expect(conversationAllowsEdits("unknown")).toBe(false)
    expect(conversationAllowsEdits("read_only", true)).toBe(true)
    expect(conversationAllowsEdits("writable", false)).toBe(false)
  })

  it("uses one session branch and a short chrome name", () => {
    expect(conversationSessionBranch("conv_1")).toBe("ctxpipe/chat/conv_1/1")
    expect(conversationBranchShortName("ctxpipe/chat/conv_1/1")).toBe("chat/1")
  })

  it("shows Create PR after merge and Show PR while open", () => {
    expect(conversationPullRequestAction("open")).toBe("show")
    expect(conversationPullRequestAction("merged")).toBe("create")
    expect(conversationPullRequestAction(null)).toBe("create")
  })

  it("shows Commit+Push only when the worktree is dirty", () => {
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: false,
        unpushed: false,
      }),
    ).toBe(false)
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: true,
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

  it("shows Create PR when anything has changed versus the default branch", () => {
    expect(
      conversationCreatePrEnabled({
        dirty: false,
        differsFromDefault: false,
        unpushed: false,
      }),
    ).toBe(false)
    expect(
      conversationCreatePrEnabled({
        dirty: false,
        differsFromDefault: true,
        unpushed: true,
      }),
    ).toBe(true)
    expect(
      conversationCreatePrEnabled({
        dirty: true,
        differsFromDefault: true,
        unpushed: true,
      }),
    ).toBe(true)
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
    expect(
      conversationCommitPushEnabled({
        dirty: true,
        differsFromDefault: true,
        unpushed: true,
        stale: true,
      }),
    ).toBe(false)
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
