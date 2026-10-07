import { type NetworkPolicy, Sandbox } from "@vercel/sandbox"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  agentSnapshotTags,
  conversationFirewall,
  conversationSandboxTags,
  deleteVercelBuilder,
  hostedNetworkPolicy,
  listTaggedSandboxes,
  turnAgentPassword,
  vercelConversationProvider,
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
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "model-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}

function pinned(host: string, authorization: string) {
  return [{ headers: { host, authorization } }]
}

type Rule = {
  match?: { path?: { exact?: string; regex?: string; startsWith?: string } }
  transform: unknown
}

function allowOf(policy: NetworkPolicy | undefined) {
  return (policy as { allow: Record<string, Rule[]> }).allow
}

/** The rule the firewall applies to a request path: the first match. */
function ruleFor(rules: Rule[], path: string): Rule | undefined {
  return rules.find((rule) => {
    const matcher = rule.match?.path
    if (!matcher) return true
    if (matcher.exact !== undefined) return path === matcher.exact
    if (matcher.startsWith !== undefined)
      return path.startsWith(matcher.startsWith)
    return new RegExp(matcher.regex ?? "").test(path)
  })
}

describe("hostedNetworkPolicy", () => {
  it("keeps the internet open and adds the GitHub token on GitHub hosts only, with the host pinned", () => {
    const allow = allowOf(hostedNetworkPolicy({ gitToken: "git-1" }))
    const basic = `Basic ${Buffer.from("x-access-token:git-1").toString("base64")}`
    expect(allow).toEqual({
      "github.com": [{ transform: pinned("github.com", basic) }],
      "codeload.github.com": [
        { transform: pinned("codeload.github.com", basic) },
      ],
      "api.github.com": [
        { transform: pinned("api.github.com", "Bearer git-1") },
      ],
      "*": [],
    })
    // The catch-all comes last, after every named host.
    expect(Object.keys(allow).at(-1)).toBe("*")
  })

  it("has no backend rule outside a turn", () => {
    const allow = allowOf(
      hostedNetworkPolicy({
        gitToken: "git-1",
        backendHost: "app.example.test",
      }),
    )
    expect(allow["app.example.test"]).toBeUndefined()
  })

  it("adds the turn's credentials on the backend host on exact paths only, with the host pinned", () => {
    const allow = allowOf(
      hostedNetworkPolicy({
        gitToken: "git-1",
        backendHost: "app.example.test",
        turn,
      }),
    )
    const rules = allow["app.example.test"] ?? []
    const model = pinned("app.example.test", "Bearer model-capability")
    const bridge = pinned("app.example.test", "Bearer bridge-token")
    expect(ruleFor(rules, turn.bridgePath)?.transform).toEqual(bridge)
    expect(
      ruleFor(rules, `${turn.modelProxyPath}/chat/completions`)?.transform,
    ).toEqual(model)
    expect(ruleFor(rules, `${turn.modelProxyPath}/models`)?.transform).toEqual(
      model,
    )
    // A dot segment or another route gets no credential: the backend
    // resolves these paths to other routes.
    for (const path of [
      `${turn.modelProxyPath}/../../../../api/v1/x`,
      `${turn.modelProxyPath}/%2e%2e/%2E%2e/x`,
      `${turn.modelProxyPath}/chat/completions/../../x`,
      `${turn.bridgePath}/../x`,
      "/acme/api/v1/workspace-chat/openai/v2/chat/completions",
      "/other/api/v1/workspace-chat/openai/v1/chat/completions",
    ])
      expect(ruleFor(rules, path), path).toBeUndefined()
    expect(Object.keys(allow).at(-1)).toBe("*")
  })
})

describe("conversationFirewall", () => {
  const policies: NetworkPolicy[] = []
  /** `fail`: the API answers an error; `applied-then-fail`: it records first. */
  let failure: "none" | "fail" | "applied-then-fail" = "none"
  const sandboxJson = (name: string) => ({
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: "ses_1",
    status: "running",
  })
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
    http.get("https://vercel.com/api/v2/sandboxes/:name", ({ params }) =>
      HttpResponse.json({
        sandbox: sandboxJson(String(params.name)),
        session: sessionJson,
        routes: [],
      }),
    ),
    http.patch(
      "https://vercel.com/api/v2/sandboxes/:name",
      async ({ request, params }) => {
        const body = (await request.json()) as { networkPolicy: NetworkPolicy }
        if (failure === "applied-then-fail") policies.push(body.networkPolicy)
        if (failure !== "none")
          return HttpResponse.json(
            { error: { code: "bad_request", message: "update failed" } },
            { status: 400 },
          )
        policies.push(body.networkPolicy)
        return HttpResponse.json({ sandbox: sandboxJson(String(params.name)) })
      },
    ),
    // A running session gets the same policy at once.
    http.post(
      "https://vercel.com/api/v2/sandboxes/sessions/:id/network-policy",
      () => HttpResponse.json({ session: sessionJson }),
    ),
  ]
  const backendRules = (policy: NetworkPolicy | undefined) =>
    allowOf(policy)["app.example.test"]
  const attached = async (name: string, gitToken: string) => {
    server.use(...vercelApi)
    policies.length = 0
    failure = "none"
    const firewall = conversationFirewall("app.example.test")
    firewall.attach(await Sandbox.get({ ...credentials, name }), gitToken)
    return firewall
  }

  it("sets the turn's credentials at turn start and removes them at turn end", async () => {
    const firewall = await attached("sbx-1", "git-1")
    await firewall.openTurn("sbx-1", turn)
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-1")
    // A token rotation during the turn keeps the turn's credentials, also
    // when another chat call (a Files read) starts it.
    await conversationFirewall("app.example.test").rotateGitToken(
      await Sandbox.get({ ...credentials, name: "sbx-1" }),
      "git-2",
    )
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-2")
    await firewall.closeTurn("sbx-1")
    expect(backendRules(policies.at(-1))).toBeUndefined()
    expect(JSON.stringify(policies.at(-1))).not.toContain("model-capability")
    expect(JSON.stringify(policies.at(-1))).not.toContain("bridge-token")
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-2")
  })

  it("fails the turn start clearly when the firewall update fails, and keeps no turn", async () => {
    const firewall = await attached("sbx-2", "git-1")
    failure = "fail"
    await expect(firewall.openTurn("sbx-2", turn)).rejects.toThrow(/firewall/i)
    failure = "none"
    await firewall.rotateGitToken(
      await Sandbox.get({ ...credentials, name: "sbx-2" }),
      "git-2",
    )
    expect(backendRules(policies.at(-1))).toBeUndefined()
  })

  it("resets the policy at turn end when a failed update was applied", async () => {
    const firewall = await attached("sbx-3", "git-1")
    failure = "applied-then-fail"
    await expect(firewall.openTurn("sbx-3", turn)).rejects.toThrow(/firewall/i)
    // Vercel applied the rules although it answered with an error.
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    failure = "none"
    await firewall.closeTurn("sbx-3")
    expect(backendRules(policies.at(-1))).toBeUndefined()
  })

  /** A provider whose GitHub tokens are in memory; `mintedAt` sets the age. */
  const resumable = (mintedAt?: Date) => {
    const rows = new Map<string, { token: string; mintedAt: Date }>()
    let mints = 0
    const firewall = conversationFirewall("app.example.test")
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "password",
      access: {
        firewall,
        mintGitToken: async () => `git-minted-${++mints}`,
        revokeGitToken: async () => undefined,
        tokens: {
          get: async (id) =>
            mintedAt
              ? (rows.get(id) ?? { token: "git-old", mintedAt })
              : (rows.get(id) ?? null),
          put: async (id, token) => {
            rows.set(id, { token, mintedAt: new Date() })
          },
          take: async () => null,
        },
      },
      tags: {},
      base: async () => ({ failed: async () => undefined }),
      agentSnapshot: async () => "snap_agent",
    })
    return { provider, firewall, rotated: () => rows.size > 0 }
  }

  it("opens a turn on a resumed sandbox whose token was replaced before use", async () => {
    server.use(...vercelApi)
    policies.length = 0
    failure = "none"
    const { provider, firewall } = resumable()
    const handle = await provider.resume({ id: "sbx-resume-1" })
    if (!handle) throw new Error("not resumed")
    await firewall.openTurn(handle.id, turn)
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-minted-1")
    await firewall.closeTurn(handle.id)
  })

  it("opens a turn on a resumed sandbox after a background rotation ended", async () => {
    server.use(...vercelApi)
    policies.length = 0
    failure = "none"
    const { provider, firewall, rotated } = resumable(new Date(0))
    const handle = await provider.resume({ id: "sbx-resume-2" })
    if (!handle) throw new Error("not resumed")
    await expect.poll(rotated).toBe(true)
    await firewall.openTurn(handle.id, turn)
    expect(backendRules(policies.at(-1))).toHaveLength(2)
    expect(JSON.stringify(policies.at(-1))).toContain("Bearer git-minted-1")
    await firewall.closeTurn(handle.id)
  })

  it("refuses a turn on a sandbox that this process did not create or resume", async () => {
    const firewall = conversationFirewall("app.example.test")
    await expect(firewall.openTurn("sbx-unknown", turn)).rejects.toThrow(
      /not attached/,
    )
  })
})

describe("turnAgentPassword", () => {
  it("gives each turn its own OpenCode password", () => {
    const first = turnAgentPassword()
    const second = turnAgentPassword()
    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(second).not.toBe(first)
  })
})
