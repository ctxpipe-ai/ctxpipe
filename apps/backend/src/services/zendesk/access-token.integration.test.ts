import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { parseEnv } from "../../config/env.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  getZendeskConnection,
  getZendeskConnectionStatus,
} from "../../models/zendesk-connector.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { freshZendeskAccessToken } from "./access-token.js"
import { ZendeskAuthorizationRevokedError } from "./oauth.js"

const tokenRequests: unknown[] = []
const server = setupServer()
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

async function addConnection(expiresAt: string | null) {
  return seed.addConnection("zendesk", {
    subdomain: "acme",
    status: "installed",
    oauthClientId: "local-client",
    oauthClientSecretEnc: encryptConnectionSecret("local-secret", env),
    accessTokenEnc: encryptConnectionSecret("access-1", env),
    refreshTokenEnc: encryptConnectionSecret("refresh-1", env),
    accessTokenExpiresAt: expiresAt,
  })
}

const read = async (connectionId: string) => {
  const connection = await getZendeskConnection(seed.orgId, connectionId, env)
  if (!connection) throw new Error("no connection")
  return connection
}

describe("freshZendeskAccessToken (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("zendesk_tokens")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    server.resetHandlers()
    tokenRequests.length = 0
    vi.useRealTimers()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("uses a token that is still valid, without a refresh", async () => {
    const id = await addConnection("2099-01-01T00:00:00.000Z")
    expect(
      await freshZendeskAccessToken({
        orgId: seed.orgId,
        env,
        connection: await read(id),
      }),
    ).toBe("access-1")
  })

  it("gives two parallel callers the new token, without a transaction around the refresh", async () => {
    const id = await addConnection("2020-01-01T00:00:00.000Z")
    // Zendesk rotates: a refresh token works one time.
    const spent = new Set<string>()
    server.use(
      http.post(
        "https://acme.zendesk.com/oauth/tokens",
        async ({ request }) => {
          const body = (await request.json()) as { refresh_token: string }
          tokenRequests.push(body)
          if (spent.has(body.refresh_token))
            return HttpResponse.json(
              { error: "invalid_grant" },
              { status: 400 },
            )
          spent.add(body.refresh_token)
          return HttpResponse.json({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 1800,
          })
        },
      ),
    )
    const [first, second] = await Promise.all([
      freshZendeskAccessToken({
        orgId: seed.orgId,
        env,
        connection: await read(id),
      }),
      freshZendeskAccessToken({
        orgId: seed.orgId,
        env,
        connection: await read(id),
      }),
    ])
    expect([first, second]).toEqual(["access-2", "access-2"])
    // The local client sends the old refresh token; the loser of the race
    // reads the new token, and the connection stays installed.
    expect(tokenRequests[0]).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "local-client",
      client_secret: "local-secret",
    })
    expect((await read(id)).refreshToken).toBe("refresh-2")
    expect(await getZendeskConnectionStatus(seed.orgId, id)).toBe("installed")
  })

  it("marks the connection revoked when Zendesk refuses the refresh token", async () => {
    const id = await addConnection("2020-01-01T00:00:00.000Z")
    server.use(
      http.post("https://acme.zendesk.com/oauth/tokens", () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    )
    await expect(
      freshZendeskAccessToken({
        orgId: seed.orgId,
        env,
        connection: await read(id),
      }),
    ).rejects.toBeInstanceOf(ZendeskAuthorizationRevokedError)
    expect(await getZendeskConnectionStatus(seed.orgId, id)).toBe("revoked")
    // Before the revoke, the caller waits up to 5 seconds for a race winner.
  }, 10_000)
})
