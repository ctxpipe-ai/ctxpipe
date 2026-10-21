import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api-result"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationCommitPushEnabled,
  conversationCreatePrEnabled,
  conversationCtaPlan,
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
      conversationPublishErrorMessage("Sync", new Error("turn_running")),
    ).toBe(
      "Sync failed. The agent is still working. Try again when the turn ends.",
    )
    expect(
      conversationPublishErrorMessage("Create PR", new Error("no_pr_access")),
    ).toBe(
      "Create PR failed. The ctxpipe GitHub App can't open pull requests. Give it the Pull requests: Read and write permission.",
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

  it("says GitHub refused the pull request, and why", () => {
    expect(
      conversationPublishErrorMessage(
        "Create PR",
        new ApiError("pr_refused", 400, {
          body: { error: "pr_refused", message: "not all refs are readable" },
        }),
      ),
    ).toBe(
      "Create PR failed. GitHub refused the pull request: not all refs are readable.",
    )
  })

  it("shows an unknown code as it is", () => {
    expect(
      conversationPublishErrorMessage("Create PR", new Error("odd_code")),
    ).toBe("Create PR failed (odd_code).")
  })
})

describe("conversationCtaPlan", () => {
  const cases: Array<{
    name: string
    input: Parameters<typeof conversationCtaPlan>[0]
    want: ReturnType<typeof conversationCtaPlan>
  }> = [
    {
      name: "none shows nothing",
      input: {
        syncVisible: false,
        createPrVisible: false,
        createPrPending: false,
        prExists: false,
      },
      want: { sync: null, pullRequest: null },
    },
    {
      name: "dirty shows only Sync",
      input: {
        syncVisible: true,
        createPrVisible: true,
        createPrPending: false,
        prExists: false,
      },
      want: { sync: "cta", pullRequest: null },
    },
    {
      name: "clean and ahead shows Create PR",
      input: {
        syncVisible: false,
        createPrVisible: true,
        createPrPending: false,
        prExists: false,
      },
      want: { sync: null, pullRequest: "create" },
    },
    {
      name: "a running Create PR is the only CTA and Sync is subtle",
      input: {
        syncVisible: true,
        createPrVisible: true,
        createPrPending: true,
        prExists: false,
      },
      want: { sync: "subtle", pullRequest: "create" },
    },
    {
      name: "a PR shows Show PR as the CTA",
      input: {
        syncVisible: false,
        createPrVisible: false,
        createPrPending: false,
        prExists: true,
      },
      want: { sync: null, pullRequest: "show" },
    },
    {
      name: "a PR and dirty show Sync as the CTA and a subtle Show PR",
      input: {
        syncVisible: true,
        createPrVisible: false,
        createPrPending: false,
        prExists: true,
      },
      want: { sync: "cta", pullRequest: "show" },
    },
  ]
  for (const { name, input, want } of cases) {
    it(name, () => expect(conversationCtaPlan(input)).toEqual(want))
  }
})
