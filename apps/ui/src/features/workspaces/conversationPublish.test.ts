import { describe, expect, it } from "vitest"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationCommitPushEnabled,
  conversationGithubTreeHref,
  conversationPullRequestAction,
  conversationSessionBranch,
} from "./conversationPublish"

describe("conversation publish helpers", () => {
  it("treats only writable as editable", () => {
    expect(conversationAllowsEdits("writable")).toBe(true)
    expect(conversationAllowsEdits("read_only")).toBe(false)
    expect(conversationAllowsEdits("unknown")).toBe(false)
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

  it("enables Commit+Push when dirty, ahead, or unpushed", () => {
    expect(
      conversationCommitPushEnabled({
        dirty: false,
        differsFromDefault: false,
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

  it("builds a GitHub tree href after the first push", () => {
    expect(
      conversationGithubTreeHref(
        "https://github.com/acme/docs.git",
        "ctxpipe/chat/conv_1/1",
      ),
    ).toBe("https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1")
  })
})
