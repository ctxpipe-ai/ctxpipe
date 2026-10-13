import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AgentVaultUnavailableError, openRunVault } from "./agent-vault.js"

/**
 * An Agent Vault API that accepts each call. `policy` is how it answers the
 * settings PATCH; each test has its own address, so no login is shared.
 */
function agentVault(
  address: string,
  policy: () => Response,
): { deleted: string[]; sessions: number } {
  const calls = { deleted: [] as string[], sessions: 0 }
  server.use(
    http.post(`${address}/v1/auth/login`, () =>
      HttpResponse.json({ token: "owner-token" }),
    ),
    http.post(`${address}/v1/vaults`, () =>
      HttpResponse.json({ name: "created" }, { status: 201 }),
    ),
    http.patch(`${address}/v1/vaults/:name/settings`, policy),
    http.post(`${address}/v1/sessions`, () => {
      calls.sessions += 1
      return HttpResponse.json({ token: "session" })
    }),
    http.all(`${address}/v1/vaults/:name/*`, () => HttpResponse.json({})),
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
})
