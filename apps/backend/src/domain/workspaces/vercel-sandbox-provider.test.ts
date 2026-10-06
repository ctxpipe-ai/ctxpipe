import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  agentSnapshotTags,
  conversationSandboxTags,
  deleteVercelBuilder,
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

function snapshot(id: string, status: "created" | "deleted") {
  return {
    snapshot: {
      id,
      sourceSessionId: "ses_test",
      region: "iad1",
      status,
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

// The Vercel API keeps a deleted snapshot readable (status `deleted`) and
// answers 400 to a second delete (measured in the Vercel contract lane).
const snapshotHandlers = (deleted: string[]) => [
  http.get("https://vercel.com/api/v2/sandboxes/snapshots/:id", ({ params }) =>
    HttpResponse.json(
      snapshot(
        String(params.id),
        deleted.includes(String(params.id)) ? "deleted" : "created",
      ),
    ),
  ),
  http.delete(
    "https://vercel.com/api/v2/sandboxes/snapshots/:id",
    ({ params }) => {
      const id = String(params.id)
      if (deleted.includes(id))
        return HttpResponse.json(
          { error: { code: "bad_request", message: "already deleted" } },
          { status: 400 },
        )
      deleted.push(id)
      return HttpResponse.json(snapshot(id, "deleted"))
    },
  ),
]

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

describe("deleteVercelBuilder", () => {
  it("deletes a recorded snapshot, and counts an already deleted one as deleted", async () => {
    const deleted: string[] = []
    server.use(...snapshotHandlers(deleted))

    await deleteVercelBuilder({ credentials, snapshotId: "snap_base" })
    expect(deleted).toEqual(["snap_base"])

    await expect(
      deleteVercelBuilder({ credentials, snapshotId: "snap_base" }),
    ).resolves.toBeUndefined()
  })
})
