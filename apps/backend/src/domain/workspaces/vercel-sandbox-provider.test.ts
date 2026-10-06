import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  agentSnapshotTags,
  conversationSandboxTags,
  listTaggedSandboxes,
} from "./vercel-sandbox-provider.js"

const credentials = { token: "t", teamId: "team_test", projectId: "prj_test" }

function listed(name: string, tags: Record<string, string>) {
  return {
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: "ses_test",
    status: "stopped",
    tags,
  }
}

const sandboxes = [
  listed("agent-current", { ...agentSnapshotTags("pr-1"), opencode: "1" }),
  listed("agent-old", { ...agentSnapshotTags("pr-1"), opencode: "0" }),
  listed("agent-other-env", { ...agentSnapshotTags("pr-2"), opencode: "1" }),
  listed("chat", conversationSandboxTags("pr-1")),
]

// The Vercel API filters a list by one tag only and answers 400 to more
// (https://vercel.com/docs/sandbox/concepts/tags, "Limitations").
const server = setupServer(
  http.get("https://vercel.com/api/v2/sandboxes", ({ request }) => {
    const filters = new URL(request.url).searchParams.getAll("tags")
    if (filters.length > 1)
      return HttpResponse.json(
        { error: { code: "bad_request", message: "one tag filter only" } },
        { status: 400 },
      )
    const matching = sandboxes.filter((sandbox) =>
      filters.every((filter) => {
        const [key = "", value] = filter.split(":")
        return (sandbox.tags as Record<string, string>)[key] === value
      }),
    )
    return HttpResponse.json({
      sandboxes: matching,
      pagination: { count: matching.length, next: null },
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe("listTaggedSandboxes", () => {
  it("lists sandboxes that carry every tag, with one tag filter per request", async () => {
    const found = await listTaggedSandboxes(credentials, {
      ...agentSnapshotTags("pr-1"),
      opencode: "1",
    })
    expect(found.map((sandbox) => sandbox.name)).toEqual(["agent-current"])
  })

  it("keeps a two-tag list to the environment", async () => {
    const found = await listTaggedSandboxes(
      credentials,
      conversationSandboxTags("pr-1"),
    )
    expect(found.map((sandbox) => sandbox.name)).toEqual(["chat"])
  })
})
