import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { openDockerRunVault } from "./docker-run-vault.js"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())

describe("openDockerRunVault", () => {
  it("closes the proxy to its rules when the caller asks for deny (hosted AgentCore chat)", async () => {
    const address = "http://agent-vault.test"
    const policies: unknown[] = []
    server.use(
      http.post(`${address}/v1/auth/login`, () =>
        HttpResponse.json({ token: "owner-token" }),
      ),
      http.post(`${address}/v1/vaults`, () =>
        HttpResponse.json({ name: "created" }, { status: 201 }),
      ),
      http.patch(`${address}/v1/vaults/:name/settings`, async ({ request }) => {
        const body = (await request.json()) as {
          unmatched_host_policy: string
        }
        policies.push(body.unmatched_host_policy)
        return HttpResponse.json(body)
      }),
      http.post(`${address}/v1/sessions`, () =>
        HttpResponse.json({
          token: "session",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          av_addr: address,
        }),
      ),
      http.get(
        `${address}/v1/mitm/ca.pem`,
        () =>
          new HttpResponse(
            "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
            {
              headers: { "X-MITM-Port": "14322", "X-MITM-TLS": "1" },
            },
          ),
      ),
      http.all(`${address}/v1/vaults/:name/*`, () => HttpResponse.json({})),
    )
    // No GitHub connection: no token is minted and no database is read.
    const vault = await openDockerRunVault({
      orgId: "org_test",
      conversationId: `conv_${crypto.randomUUID()}`,
      label: "turn",
      revision: {
        workspaceId: "ws_test",
        remote: { url: "https://example.test/context.git", connectionId: null },
        sha: "a".repeat(40),
        generation: 1,
        defaultBranch: "main",
        access: "read",
      },
      access: {
        address,
        proxyHost: "10.0.0.1",
        ownerPassword: async () => "owner-password",
      },
      unmatchedHosts: "deny",
    })
    expect(policies).toEqual(["deny"])
    expect(vault.env).toBeDefined()
  })
})
