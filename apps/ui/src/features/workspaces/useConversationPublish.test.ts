import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { conversationPublishErrorMessage } from "./conversationPublish"
import {
  createConversationPullRequest,
  pushConversationBranch,
} from "./queries"
import { installMemorySessionStorage } from "./session-storage-test"
import {
  conversationCreatePrMutationKey,
  conversationPushMutationKey,
} from "./useConversationPublish"

describe("conversation publish mutation keys", () => {
  it("scopes push and pull-request commands to the conversation", () => {
    expect(conversationPushMutationKey("acme", "conv_1")).toEqual([
      "conversation-push",
      "acme",
      "conv_1",
    ])
    expect(conversationCreatePrMutationKey("acme", "conv_1")).toEqual([
      "conversation-create-pr",
      "acme",
      "conv_1",
    ])
    expect(conversationPushMutationKey("acme", "conv_1")).not.toEqual(
      conversationPushMutationKey("acme", "conv_2"),
    )
  })
})

const server = setupServer()

describe("conversation publish errors", () => {
  beforeAll(() => {
    installMemorySessionStorage()
    server.listen({ onUnhandledRequest: "error" })
    const intercepted = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      intercepted(
        (typeof input === "string" && input.startsWith("/")
          ? `http://localhost${input}`
          : input) as RequestInfo,
        init,
      )) as typeof fetch
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  function answer(path: string, status: number, error: string) {
    server.use(
      http.post(
        `http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/${path}`,
        () => HttpResponse.json({ error }, { status }),
      ),
    )
  }

  it("tells the user why Commit+Push failed", async () => {
    answer("push", 409, "turn_running")
    const error = await pushConversationBranch("acme", "conv_1").catch(
      (e: unknown) => e,
    )
    expect(conversationPublishErrorMessage("Commit+Push", error)).toBe(
      "Commit+Push failed: the agent is still working. Try again when the turn ends.",
    )
  })

  it("tells the user why Create PR failed", async () => {
    answer("pull-request", 400, "no_pr_access")
    const error = await createConversationPullRequest("acme", "conv_1", {
      title: "Notes",
    }).catch((e: unknown) => e)
    expect(conversationPublishErrorMessage("Create PR", error)).toBe(
      "Create PR failed: the ctx| GitHub App cannot open pull requests. Give it the Pull requests: Read and write permission.",
    )
  })

  it("shows the code of an error it does not know", async () => {
    answer("pull-request", 502, "github_unavailable")
    const error = await createConversationPullRequest("acme", "conv_1").catch(
      (e: unknown) => e,
    )
    expect(conversationPublishErrorMessage("Create PR", error)).toBe(
      "Create PR failed: GitHub did not answer. Try again.",
    )
    expect(
      conversationPublishErrorMessage("Create PR", new Error("odd_code")),
    ).toBe("Create PR failed (odd_code).")
  })
})
