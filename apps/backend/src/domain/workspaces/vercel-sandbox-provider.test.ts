import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import type { NetworkPolicy } from "@vercel/sandbox"
import {
  agentSnapshotTags,
  conversationFirewall,
  conversationSandboxTags,
  deleteVercelBuilder,
  hostedNetworkPolicy,
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

const turn = {
  modelPath: "/acme/api/v1/workspace-chat/openai/",
  modelCapability: "model-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}

function bearer(token: string) {
  return [{ headers: { authorization: `Bearer ${token}` } }]
}

describe("hostedNetworkPolicy", () => {
  it("keeps the internet open and adds the GitHub token on GitHub hosts only", () => {
    const policy = hostedNetworkPolicy({ gitToken: "git-1" }) as {
      allow: Record<string, unknown[]>
    }
    const basic = Buffer.from("x-access-token:git-1").toString("base64")
    expect(policy.allow).toEqual({
      "github.com": [
        { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
      ],
      "codeload.github.com": [
        { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
      ],
      "api.github.com": [{ transform: bearer("git-1") }],
      "*": [],
    })
    // The catch-all comes last, after every named host.
    expect(Object.keys(policy.allow).at(-1)).toBe("*")
  })

  it("adds no credential on the backend host outside a turn", () => {
    const policy = hostedNetworkPolicy({
      gitToken: "git-1",
      backendHost: "app.example.test",
    }) as { allow: Record<string, unknown[]> }
    expect(policy.allow["app.example.test"]).toEqual([])
    expect(Object.keys(policy.allow).at(-1)).toBe("*")
  })

  it("adds the turn's credentials on the backend host by path, the narrower rule first", () => {
    const policy = hostedNetworkPolicy({
      gitToken: "git-1",
      backendHost: "app.example.test",
      turn,
    }) as { allow: Record<string, unknown[]> }
    expect(policy.allow["app.example.test"]).toEqual([
      {
        match: { path: { exact: turn.bridgePath } },
        transform: bearer("bridge-token"),
      },
      {
        match: { path: { startsWith: turn.modelPath } },
        transform: bearer("model-capability"),
      },
    ])
    expect(JSON.stringify(policy.allow["*"])).toBe("[]")
  })
})

describe("conversationFirewall", () => {
  const policies: NetworkPolicy[] = []
  let failUpdates = false
  const sandboxJson = {
    name: "sbx-1",
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: "ses_1",
    status: "running",
  }
  const sessionJson = {
    id: "ses_1",
    memory: 2048,
    vcpus: 1,
    region: "iad1",
    runtime: "node24",
    timeout: 60_000,
    status: "running",
    requestedAt: 1,
    createdAt: 1,
    cwd: "/vercel/sandbox",
    updatedAt: 1,
  }
  const vercelApi = [
    http.get("https://vercel.com/api/v2/sandboxes/:name", () =>
      HttpResponse.json({
        sandbox: sandboxJson,
        session: sessionJson,
        routes: [],
      }),
    ),
    http.patch("https://vercel.com/api/v2/sandboxes/:name", async ({ request }) => {
      if (failUpdates)
        return HttpResponse.json(
          { error: { code: "bad_request", message: "update failed" } },
          { status: 400 },
        )
      const body = (await request.json()) as { networkPolicy: NetworkPolicy }
      policies.push(body.networkPolicy)
      return HttpResponse.json({ sandbox: sandboxJson })
    }),
    // A running session gets the same policy at once.
    http.post(
      "https://vercel.com/api/v2/sandboxes/sessions/:id/network-policy",
      () => HttpResponse.json({ session: sessionJson }),
    ),
  ]
  const tokenRows = new Map<string, { token: string; mintedAt: Date }>()
  const tokens = {
    get: async (id: string) => tokenRows.get(id) ?? null,
    put: async (id: string, token: string) => {
      tokenRows.set(id, { token, mintedAt: new Date() })
    },
    take: async (id: string) => {
      const row = tokenRows.get(id)
      tokenRows.delete(id)
      return row?.token ?? null
    },
  }
  const backendRules = (policy: NetworkPolicy | undefined) =>
    (policy as { allow: Record<string, unknown[]> }).allow["app.example.test"]

  it("sets the turn's credentials at turn start and removes them at turn end", async () => {
    server.use(...vercelApi)
    policies.length = 0
    failUpdates = false
    await tokens.put("sbx-1", "git-1")
    const firewall = conversationFirewall({
      credentials,
      backendHost: "app.example.test",
      tokens,
    })
    await firewall.openTurn("sbx-1", turn)
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-1")
    // A token rotation during the turn keeps the turn's credentials.
    await firewall.rotateGitToken("git-2")
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-2")
    await firewall.closeTurn()
    expect(backendRules(policies.at(-1))).toEqual([])
    expect(JSON.stringify(policies.at(-1))).not.toContain("model-capability")
    expect(JSON.stringify(policies.at(-1))).not.toContain("bridge-token")
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-2")
  })

  it("fails the turn start clearly when the firewall update fails, and keeps no turn", async () => {
    server.use(...vercelApi)
    policies.length = 0
    failUpdates = true
    await tokens.put("sbx-1", "git-1")
    const firewall = conversationFirewall({
      credentials,
      backendHost: "app.example.test",
      tokens,
    })
    await expect(firewall.openTurn("sbx-1", turn)).rejects.toThrow(
      /firewall/i,
    )
    failUpdates = false
    await firewall.rotateGitToken("git-2")
    expect(backendRules(policies.at(-1))).toEqual([])
  })
})
