import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  createConversationPullRequest,
  pushConversationBranch,
} from "./queries"
import { installRelativeFetch } from "./relative-fetch-test"
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
let restoreFetch = () => {}

describe("conversation publish errors", () => {
  beforeAll(() => {
    installMemorySessionStorage()
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  function answer(path: string, status: number, error: string) {
    server.use(
      http.post(
        `http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/${path}`,
        () => HttpResponse.json({ error }, { status }),
      ),
    )
  }

  it("rejects a failed Commit+Push with the route's error code", async () => {
    answer("push", 409, "turn_running")
    await expect(pushConversationBranch("acme", "conv_1")).rejects.toThrow(
      "turn_running",
    )
  })

  it("rejects a failed Create PR with the route's error code", async () => {
    answer("pull-request", 400, "no_pr_access")
    await expect(
      createConversationPullRequest("acme", "conv_1", { title: "Notes" }),
    ).rejects.toThrow("no_pr_access")
  })
})
