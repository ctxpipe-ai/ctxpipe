import { generateKeyPairSync } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { accounts } from "../../db/schema/auth.js"
import { generateObjectId } from "../../lib/id.js"
import {
  createDraftGithubConnection,
  createPlaceholderGithubConnection,
  deleteGithubConnectionById,
  listGithubConnectionsForOrg,
} from "../../models/github-installation.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

const installationId = 424_242
const ownAppInstallationId = 515_151
const visibleToken = "gho_can_see_installation"
const otherToken = "gho_cannot_see_installation"
const revokedToken = "gho_revoked"
const oauthAppToken = "gho_oauth_app"
const { privateKey: ownAppPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

let installationLookups = 0

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.get("https://api.github.com/user/installations", ({ request }) => {
    installationLookups += 1
    const auth = request.headers.get("authorization") ?? ""
    if (auth.endsWith(revokedToken)) {
      return HttpResponse.json({ message: "Bad credentials" }, { status: 401 })
    }
    if (auth.endsWith(oauthAppToken)) {
      return HttpResponse.json({ message: "Forbidden" }, { status: 403 })
    }
    const installations = auth.endsWith(visibleToken)
      ? [{ id: installationId }]
      : [{ id: 1 }]
    return HttpResponse.json({
      total_count: installations.length,
      installations,
    })
  }),
  // The own App's installation, asked with its JWT.
  http.get(
    "https://api.github.com/app/installations/:installationId",
    ({ params }) =>
      Number(params.installationId) === ownAppInstallationId
        ? HttpResponse.json({ id: ownAppInstallationId, account: null })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  // Account-slug refresh after attaching; not under test here.
  http.post(
    "https://api.github.com/app/installations/:installationId/access_tokens",
    () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  http.post("https://github.com/login/oauth/access_token", () =>
    HttpResponse.json({
      access_token: visibleToken,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: "ghr_rotated",
    }),
  ),
  // Better Auth dashboard events when a local .env.local enables them.
  http.post(
    "https://dash.better-auth.com/*",
    () => new HttpResponse(null, { status: 204 }),
  ),
)

describe("POST /github/installation requires GitHub access (Postgres)", () => {
  let seed: SeededOrg
  // No deployment App: nothing here may reach GitHub as the App.
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    GITHUB_APP_ID: undefined,
    GITHUB_PRIVATE_KEY: undefined,
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerV1Routes(app)
    return app
  }

  function attach(body: { installationId: number; connectionId?: string }) {
    return createApp().request(
      `http://backend.test/${seed.orgSlug}/api/v1/github/installation`,
      {
        method: "POST",
        headers: { cookie: seed.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )
  }

  async function linkGithub(
    accessToken: string,
    refresh?: { refreshToken: string; accessTokenExpiresAt: Date },
  ) {
    await getSystemDb()
      .insert(accounts)
      .values({
        id: generateObjectId("acc"),
        accountId: `gh-${seed.userId}`,
        providerId: "github",
        userId: seed.userId,
        accessToken,
        ...refresh,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
  }

  function createOwnAppDraft() {
    return createDraftGithubConnection({
      orgId: seed.orgId,
      env,
      githubAppId: "1",
      appSlug: "self-hosted-app",
      privateKey: ownAppPrivateKey,
      webhookSecret: "webhook-secret",
    })
  }

  async function attachedInstallationIds() {
    const rows = await listGithubConnectionsForOrg(seed.orgId)
    return rows.map((row) => row.installationId)
  }

  beforeAll(async () => {
    // GitHub sign-in configured, so Better Auth can refresh GitHub tokens.
    vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-secret")
    seed = await seedOrg()
  })

  afterEach(async () => {
    installationLookups = 0
    await getSystemDb()
      .delete(accounts)
      .where(
        and(
          eq(accounts.userId, seed.userId),
          eq(accounts.providerId, "github"),
        ),
      )
    for (const row of await listGithubConnectionsForOrg(seed.orgId)) {
      await deleteGithubConnectionById(seed.orgId, row.id)
    }
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  it("rejects a user without a linked GitHub account and writes nothing", async () => {
    const res = await attach({ installationId })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ why: "github_not_linked" })
    expect(await attachedInstallationIds()).toEqual([])
  })

  it("rejects attaching to a placeholder connection without a linked GitHub account", async () => {
    const placeholder = await createPlaceholderGithubConnection({
      orgId: seed.orgId,
    })

    const res = await attach({ installationId, connectionId: placeholder.id })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ why: "github_not_linked" })
    expect(await attachedInstallationIds()).toEqual([null])
  })

  it("rejects a GitHub account that cannot see the installation", async () => {
    await linkGithub(otherToken)

    const res = await attach({ installationId })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_installation_not_accessible",
    })
    expect(await attachedInstallationIds()).toEqual([])
  })

  it.each([
    ["rejects the stored token", revokedToken],
    ["will not list installations for the token", oauthAppToken],
  ])("asks to link GitHub again when GitHub %s", async (_, token) => {
    await linkGithub(token)

    const res = await attach({ installationId })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ why: "github_not_linked" })
    expect(await attachedInstallationIds()).toEqual([])
  })

  it("attaches the installation when the GitHub account can see it", async () => {
    await linkGithub(visibleToken)

    const res = await attach({ installationId })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ installationId })
    expect(await attachedInstallationIds()).toEqual([installationId])
    expect(installationLookups).toBe(1)
  })

  it("refreshes an expired GitHub token before checking access", async () => {
    await linkGithub("gho_expired", {
      refreshToken: "ghr_refresh",
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })

    const res = await attach({ installationId })

    expect(res.status).toBe(200)
    expect(await attachedInstallationIds()).toEqual([installationId])
  })

  it("attaches to a connection whose own App owns the installation, without a GitHub account", async () => {
    const draft = await createOwnAppDraft()

    const res = await attach({
      installationId: ownAppInstallationId,
      connectionId: draft.id,
    })

    expect(res.status).toBe(200)
    expect(await attachedInstallationIds()).toEqual([ownAppInstallationId])
    expect(installationLookups).toBe(0)
  })

  it("rejects attaching another App's installation to a connection with its own App", async () => {
    const draft = await createOwnAppDraft()

    const res = await attach({ installationId, connectionId: draft.id })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_installation_not_accessible",
    })
    expect(await attachedInstallationIds()).toEqual([null])
  })
})
