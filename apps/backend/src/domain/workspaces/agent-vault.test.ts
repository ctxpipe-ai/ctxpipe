import { HttpResponse, type HttpResponseResolver, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { parseEnv } from "../../config/env.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  openRunVault,
  RunVaultRuleRefusedError,
  setRunVaultRules,
} from "./agent-vault.js"
import { ingestCredentialRules } from "./ingest-sandbox-egress.js"
import {
  bearerUrlRule,
  githubCredentialRules,
  modelProxyCredentialRules,
} from "./sandbox-credential-rules.js"

/**
 * An Agent Vault API that accepts each call. `policy` is how it answers the
 * settings PATCH, and `stall` can answer a call first; each test has its own
 * address, so no login is shared.
 */
function agentVault(
  address: string,
  policy: () => Response,
  stall?: HttpResponseResolver,
): { created: number; deleted: string[]; sessions: number; hosts: string[] } {
  const calls = {
    created: 0,
    deleted: [] as string[],
    sessions: 0,
    hosts: [] as string[],
  }
  server.use(
    ...(stall ? [http.all(`${address}/*`, stall)] : []),
    http.post(`${address}/v1/auth/login`, () =>
      HttpResponse.json({ token: "owner-token" }),
    ),
    http.post(`${address}/v1/vaults`, () => {
      calls.created += 1
      return HttpResponse.json({ name: "created" }, { status: 201 })
    }),
    http.patch(`${address}/v1/vaults/:name/settings`, policy),
    http.post(`${address}/v1/credentials`, () =>
      HttpResponse.json({ set: [] }),
    ),
    http.post(`${address}/v1/sessions`, () => {
      calls.sessions += 1
      return HttpResponse.json({ token: "session" })
    }),
    http.all(`${address}/v1/vaults/:name/*`, async ({ request }) => {
      if (request.url.endsWith("/services")) {
        const body = (await request.json()) as {
          services?: Array<{ host: string }>
        }
        calls.hosts.push(...(body.services ?? []).map((rule) => rule.host))
      }
      return HttpResponse.json({})
    }),
    http.delete(`${address}/v1/vaults/:name`, ({ params }) => {
      calls.deleted.push(String(params.name))
      return HttpResponse.json({})
    }),
  )
  return calls
}

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())

const open = (address: string) =>
  openRunVault({
    access: {
      address,
      proxyHost: "10.0.0.1",
      ownerPassword: async () => "owner-password",
    },
    runKey: `test:${crypto.randomUUID()}`,
    ttlSeconds: 60,
    rules: [],
    unmatchedHosts: "deny",
  })

describe("openRunVault with unmatchedHosts deny", () => {
  it("fails closed and deletes the vault when Agent Vault answers 200 but keeps passthrough", async () => {
    const address = "http://agent-vault-silent.test"
    const calls = agentVault(address, () =>
      HttpResponse.json({ unmatched_host_policy: "passthrough" }),
    )
    await expect(open(address)).rejects.toBeInstanceOf(
      AgentVaultUnavailableError,
    )
    expect(calls.deleted).toHaveLength(1)
    expect(calls.sessions).toBe(0)
  })

  it("fails closed and deletes the vault when the settings call fails", async () => {
    const address = "http://agent-vault-failing.test"
    const calls = agentVault(
      address,
      () => new HttpResponse(null, { status: 500 }),
    )
    await expect(open(address)).rejects.toBeInstanceOf(
      AgentVaultUnavailableError,
    )
    expect(calls.deleted).toHaveLength(1)
    expect(calls.sessions).toBe(0)
  })

  it.each([
    // A create that did not finish leaves no vault to delete here; the
    // sweep deletes a vault that the API made all the same.
    ["the create call", "POST", "/v1/vaults", 0],
    ["the settings call", "PATCH", "/settings", 1],
  ])(
    "fails closed when the answer to %s stops in its body",
    async (_call, method, path, deletes) => {
      const address = `http://agent-vault-stalled-${method.toLowerCase()}.test`
      let stalled: () => void = () => undefined
      const reached = new Promise<void>((resolve) => {
        stalled = resolve
      })
      const calls = agentVault(
        address,
        () => HttpResponse.json({ unmatched_host_policy: "deny" }),
        // The headers arrive; the body never ends. An abort errors the body,
        // as the network does.
        ({ request }) => {
          if (request.method !== method || !request.url.endsWith(path)) return
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"unmatched'))
              request.signal.addEventListener("abort", () =>
                controller.error(request.signal.reason),
              )
              stalled()
            },
          })
          return new HttpResponse(body, {
            headers: { "content-type": "application/json" },
          })
        },
      )
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const outcome = open(address).then(
          () => "opened",
          (error: unknown) => error,
        )
        await reached
        // The 10 second timeout covers the body, not only the headers.
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await outcome).toBeInstanceOf(AgentVaultUnavailableError)
      } finally {
        vi.useRealTimers()
      }
      expect(calls.deleted).toHaveLength(deletes)
      expect(calls.sessions).toBe(0)
    },
  )
})

/**
 * The access of a hosted AgentCore backend, as `agentVaultAccess` reads it
 * from the environment, with the DNS answers of the test (`answers`, by
 * host name; each other name resolves to a public address).
 */
function agentCoreAccess(
  address: string,
  answers: Record<string, string[]> = {},
): AgentVaultAccess {
  const access = agentVaultAccess({
    AGENT_VAULT_ADDR: address,
    AGENT_VAULT_OWNER_PASSWORD: "owner-password",
    SANDBOX_PROVIDER: "agentcore",
    SANDBOX_CALLBACK_HOST: "backend.ctxpipe.test",
  })
  if (!access?.agentCore) throw new Error("No AgentCore access")
  return {
    ...access,
    proxyHost: "10.0.0.1",
    agentCore: {
      ...access.agentCore,
      lookup: async (hostname) => answers[hostname] ?? ["93.184.215.14"],
    },
  }
}

/** The egress of an ingest step with a plain git source on `host`. */
const plainGitEgress = (host: string, port?: number) => ({
  repositories: [
    {
      kind: "git" as const,
      host,
      path: "/team/repo.git",
      ...(port ? { port } : {}),
    },
  ],
  modelProxyUrl:
    "https://api.ctxpipe.test/acme/api/v1/workspace-chat/openai/v1",
  capability: "ingest-capability",
  bridge: { url: "https://api.ctxpipe.test/ingest/tools", token: "bridge" },
})

describe("run vault rules on hosted AgentCore (CTX-1287)", () => {
  it("refuses a plain git host that resolves to a private address, before a vault exists", async () => {
    const address = "http://agent-vault-private-git.test"
    const calls = agentVault(address, () =>
      HttpResponse.json({ unmatched_host_policy: "deny" }),
    )
    const opened = openRunVault({
      access: agentCoreAccess(address, { "git.example.test": ["10.20.64.5"] }),
      runKey: `test:${crypto.randomUUID()}`,
      ttlSeconds: 60,
      rules: ingestCredentialRules(plainGitEgress("git.example.test"), [], {
        fetchSource: true,
      }),
      unmatchedHosts: "deny",
    })
    await expect(opened).rejects.toBeInstanceOf(RunVaultRuleRefusedError)
    await expect(opened).rejects.toThrow(
      "The host git.example.test of the vault rule",
    )
    expect(calls.created).toBe(0)
    expect(calls.hosts).toEqual([])
  })

  it.each([
    ["the backend's port", 8080],
    ["a tool bridge port", 41234],
    ["plain HTTP", 80],
  ])(
    "refuses a plain git rule on %s, also with a public address",
    async (_name, port) => {
      const address = `http://agent-vault-port-${port}.test`
      const calls = agentVault(address, () =>
        HttpResponse.json({ unmatched_host_policy: "deny" }),
      )
      await expect(
        openRunVault({
          access: agentCoreAccess(address),
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 60,
          rules: ingestCredentialRules(
            plainGitEgress("git.example.test", port),
            [],
            { fetchSource: true },
          ),
          unmatchedHosts: "deny",
        }),
      ).rejects.toThrow(`names port ${port}`)
      expect(calls.created).toBe(0)
    },
  )

  it("gives each other rule port 443 and keeps the callback rules' ports", async () => {
    const address = "http://agent-vault-pinned.test"
    const calls = agentVault(address, () =>
      HttpResponse.json({ unmatched_host_policy: "deny" }),
    )
    const access = agentCoreAccess(address)
    const runKey = `test:${crypto.randomUUID()}`
    await setRunVaultRules(access, runKey, [
      ...githubCredentialRules("ghs_test"),
      ...modelProxyCredentialRules(
        "http://backend.ctxpipe.test:8080/acme/api/v1/workspace-chat/openai/v1",
        "model-capability",
      ),
      bearerUrlRule(
        "tool-bridge",
        "http://backend.ctxpipe.test:41234/mcp",
        "t",
      ),
    ])
    expect(calls.hosts).toEqual([
      "github.com:443",
      "codeload.github.com:443",
      "api.github.com:443",
      "backend.ctxpipe.test:8080/acme/api/v1/workspace-chat/openai/v1/chat/completions",
      "backend.ctxpipe.test:8080/acme/api/v1/workspace-chat/openai/v1/models",
      "backend.ctxpipe.test:41234/mcp",
    ])
    // A later step's rules get the same check. A rule that the backend does
    // not make for its callbacks gets it also on the callback name.
    for (const host of ["git.example.test:8080", "backend.ctxpipe.test:8080"])
      await expect(
        setRunVaultRules(access, runKey, [
          { name: "git-plain-0123456789abcdef", host, authorization: null },
        ]),
      ).rejects.toBeInstanceOf(RunVaultRuleRefusedError)
    expect(calls.hosts).toHaveLength(6)
  })

  it("fails closed as unavailable when a rule host does not resolve", async () => {
    const address = "http://agent-vault-no-dns.test"
    const calls = agentVault(address, () =>
      HttpResponse.json({ unmatched_host_policy: "deny" }),
    )
    const access = agentCoreAccess(address)
    await expect(
      setRunVaultRules(
        {
          ...access,
          agentCore: {
            isCallbackHost: () => false,
            lookup: () => Promise.reject(new Error("ESERVFAIL")),
          },
        },
        `test:${crypto.randomUUID()}`,
        githubCredentialRules("ghs_test"),
      ),
    ).rejects.toBeInstanceOf(AgentVaultUnavailableError)
    expect(calls.hosts).toEqual([])
  })

  it("refuses a vault that forwards hosts with no rule", async () => {
    const address = "http://agent-vault-passthrough.test"
    const calls = agentVault(address, () =>
      HttpResponse.json({ unmatched_host_policy: "passthrough" }),
    )
    await expect(
      openRunVault({
        access: agentCoreAccess(address),
        runKey: `test:${crypto.randomUUID()}`,
        ttlSeconds: 60,
        rules: [],
        unmatchedHosts: "passthrough",
      }),
    ).rejects.toBeInstanceOf(RunVaultRuleRefusedError)
    expect(calls.created).toBe(0)
  })

  it("knows the backend's own callback name under the VPC DNS suffix only for a local address", () => {
    const access = agentVaultAccess({
      AGENT_VAULT_ADDR: "http://agent-vault.test",
      SANDBOX_PROVIDER: "agentcore",
      SANDBOX_CALLBACK_DNS_SUFFIX: "us-west-2.compute.internal",
    })
    const isCallbackHost = access?.agentCore?.isCallbackHost
    expect(isCallbackHost?.("ip-127-0-0-1.us-west-2.compute.internal")).toBe(
      true,
    )
    // Another machine's name, and a local address under another suffix.
    expect(isCallbackHost?.("ip-192-0-2-77.us-west-2.compute.internal")).toBe(
      false,
    )
    expect(isCallbackHost?.("ip-127-0-0-1.eu-west-1.compute.internal")).toBe(
      false,
    )
  })

  it.each(["docker", "vercel", undefined])(
    "writes the rules as given with SANDBOX_PROVIDER=%s",
    async (provider) => {
      const address = `http://agent-vault-${provider ?? "default"}.test`
      const calls = agentVault(address, () =>
        HttpResponse.json({ unmatched_host_policy: "passthrough" }),
      )
      const access = agentVaultAccess({
        AGENT_VAULT_ADDR: address,
        AGENT_VAULT_OWNER_PASSWORD: "owner-password",
        ...(provider ? { SANDBOX_PROVIDER: provider } : {}),
      })
      expect(access?.agentCore).toBeUndefined()
      if (!access) throw new Error("No access")
      await setRunVaultRules(
        access,
        `test:${crypto.randomUUID()}`,
        ingestCredentialRules(plainGitEgress("git.example.test", 8080), [], {
          fetchSource: true,
        }),
      )
      expect(calls.hosts[0]).toMatch(/^git\.example\.test:8080\//)
    },
  )
})

describe("the proxy host that sandboxes dial", () => {
  /** An Agent Vault API with its TLS proxy on port 14322. */
  function servedAt(address: string): void {
    server.use(
      http.post(`${address}/v1/auth/login`, () =>
        HttpResponse.json({ token: "owner-token" }),
      ),
      http.post(`${address}/v1/vaults`, () =>
        HttpResponse.json({ name: "created" }, { status: 201 }),
      ),
      http.all(`${address}/v1/vaults/:name/*`, () => HttpResponse.json({})),
      http.post(`${address}/v1/sessions`, () =>
        HttpResponse.json({ token: "session" }),
      ),
      http.get(
        `${address}/v1/mitm/ca.pem`,
        () =>
          new HttpResponse("ca", {
            headers: { "X-MITM-Port": "14322", "X-MITM-TLS": "1" },
          }),
      ),
    )
  }

  async function proxyEnv(env: Record<string, string>) {
    const access = agentVaultAccess({
      AGENT_VAULT_OWNER_PASSWORD: "owner-password",
      ...env,
    })
    if (!access) throw new Error("No Agent Vault access")
    const vault = await openRunVault({
      access,
      runKey: `test:${crypto.randomUUID()}`,
      ttlSeconds: 60,
      rules: [],
    })
    const { HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy } = vault.env
    return [HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy].map(
      (value) => new URL(value ?? "").host,
    )
  }

  it("is AGENT_VAULT_SANDBOX_PROXY_HOST when it is set", async () => {
    // The API's name does not resolve here: the backend must not look it up.
    const address = "http://agent-vault-api.invalid:14321"
    servedAt(address)
    const host = "vpce-0abc-xyz.vpce-svc-0def.us-west-2.vpce.amazonaws.com"
    expect(
      await proxyEnv({
        AGENT_VAULT_ADDR: address,
        AGENT_VAULT_SANDBOX_PROXY_HOST: host,
      }),
    ).toEqual(Array(4).fill(`${host}:14322`))
  })

  it("is the API's host when the setting is not set", async () => {
    const address = "http://10.20.30.40:14321"
    servedAt(address)
    expect(
      await proxyEnv({
        AGENT_VAULT_ADDR: address,
        AGENT_VAULT_SANDBOX_PROXY_HOST: "",
      }),
    ).toEqual(Array(4).fill("10.20.30.40:14322"))
  })

  it.each([
    "https://vpce.example.com",
    "vpce.example.com:14322",
    "vpce.example.com/proxy",
    "vpce example.com",
  ])("refuses %s at config parse", (value) => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      AGENT_VAULT_ADDR: "http://10.20.30.40:14321",
      AGENT_VAULT_SANDBOX_PROXY_HOST: value,
    }
    expect(() => parseEnv(env)).toThrow(/AGENT_VAULT_SANDBOX_PROXY_HOST/)
    expect(() => agentVaultAccess(env)).toThrow(
      /AGENT_VAULT_SANDBOX_PROXY_HOST/,
    )
  })
})
