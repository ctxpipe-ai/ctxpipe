import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { getSystemDb } from "../../../db/client.js"
import { accounts, members, users } from "../../../db/schema/auth.js"
import { buildForgeAppManifestYml } from "../../../lib/forge-app-manifest.js"
import {
  getForgeInstallationByConnectionId,
  patchForgeConnectionTypedConfig,
  upsertForgeInstallationFromEvent,
} from "../../../models/atlassian-connector.js"
import { seedSourcesOrg } from "../../../test/workspace-sources-fixture.js"

const hostedAppAri =
  "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43"

// Atlassian signs each Forge call. The test signs with its own key and
// serves that key from the Forge JWKS URL.
let signingKey: CryptoKey
let otherKey: CryptoKey
let publicJwk: JWK
useMswServer(
  http.get(
    "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json",
    () => HttpResponse.json({ keys: [publicJwk] }),
  ),
)

// The routes import the OpenWorkflow client, which reads DATABASE_URL on import.
let routes: typeof import("./atlassian.js")
let provision: typeof import("../../../openworkflow/workflows/forge-provision.js")
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
const userIds: string[] = []

beforeAll(async () => {
  const pair = await generateKeyPair("RS256")
  signingKey = pair.privateKey
  otherKey = (await generateKeyPair("RS256")).privateKey
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }
  // setup-evlog turns evlog off; the token refresh case reads the drained events.
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
  seed = await seedSourcesOrg("forge_webhook")
  routes = await import("./atlassian.js")
  provision = await import("../../../openworkflow/workflows/forge-provision.js")
})
afterAll(async () => {
  for (const id of userIds) {
    await getSystemDb().delete(users).where(eq(users.id, id))
  }
  await seed.cleanup()
})

function uuid() {
  return crypto.randomUUID()
}

function appAri(id = uuid()) {
  return `ari:cloud:ecosystem::app/${id}`
}

type Site = { installationId: string; cloudId: string }

function newSite(): Site {
  return { installationId: uuid(), cloudId: `cloud_${uuid()}` }
}

/** Valid Forge claims for a call from `app` on `site`. */
function claimsForApp(
  app: string,
  site: Site,
  environmentType = "PRODUCTION",
): Record<string, unknown> {
  return {
    iss: "forge/invocation-token",
    aud: app,
    app: {
      id: app,
      installationId: `ari:cloud:ecosystem::installation/${site.installationId}`,
      apiBaseUrl: `https://api.atlassian.com/ex/confluence/${site.cloudId}`,
      environment: { type: environmentType, id: "env_1" },
    },
    context: { cloudId: site.cloudId },
  }
}

async function bearer(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; issuedAt?: number; expiresAt?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(options.key ?? signingKey)
  return `Bearer ${token}`
}

function envWith(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({
    ...process.env,
    NODE_ENV: "test",
    RAILWAY_ENVIRONMENT_NAME: undefined,
    CONFLUENCE_FORGE_INSTALL_URL: undefined,
    ...overrides,
  })
}

const events: Record<string, unknown>[] = []

function createApp(env = envWith()) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(
    evlog({
      drain: async (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx]) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    }),
  )
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  routes.registerAtlassianWebhookRoute(app)
  return app
}

async function addInstalled(
  site: Site,
  config: { appId?: string; confluenceForgeInstallUrl?: string } = {},
) {
  const row = await upsertForgeInstallationFromEvent({
    orgId: seed.orgId,
    cloudId: site.cloudId,
    status: "installed",
    installationContext: `ari:cloud:confluence::site/${site.cloudId}`,
    installationId: site.installationId,
    appId: config.appId ?? null,
    appSystemToken: "old_system_token",
  })
  if (config.confluenceForgeInstallUrl) {
    await patchForgeConnectionTypedConfig(seed.orgId, row.id, {
      confluenceForgeInstallUrl: config.confluenceForgeInstallUrl,
    })
  }
  return row.id
}

/** A user with a linked Atlassian account and a pending Confluence setup. */
async function addPending(config: { appId?: string } = {}) {
  const userId = `user_forge_${uuid()}`
  const atlassianAccountId = `atl_${uuid()}`
  await getSystemDb()
    .insert(users)
    .values({ id: userId, name: "Dev", email: `${userId}@example.com` })
  userIds.push(userId)
  await getSystemDb()
    .insert(accounts)
    .values({
      id: `acc_${uuid()}`,
      accountId: atlassianAccountId,
      providerId: "atlassian",
      userId,
      updatedAt: new Date(),
    })
  await getSystemDb()
    .insert(members)
    .values({
      id: `mem_${uuid()}`,
      organizationId: seed.orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    })
  const connectionId = await seed.addConnection("forge", {
    status: "pending",
    provisionStatus: "idle",
    installedByUserId: userId,
    ...(config.appId ? { appId: config.appId } : {}),
  })
  return { connectionId, atlassianAccountId }
}

async function connection(connectionId: string) {
  const row = await getForgeInstallationByConnectionId(seed.orgId, connectionId)
  if (!row) throw new Error(`connection ${connectionId} is missing`)
  return row
}

function lifecycleBody(site: Site, installerAccountId = `atl_${uuid()}`) {
  return JSON.stringify({
    id: site.installationId,
    eventType: "avi:forge:installed:app",
    context: `ari:cloud:confluence::site/${site.cloudId}`,
    installerAccountId,
    environment: { id: "env_1" },
  })
}

function postForge(
  app: OpenAPIHono<AppEnv>,
  authorization: string,
  body: string,
) {
  return app.request("/api/v1/webhook/atlassian/forge", {
    method: "POST",
    headers: {
      authorization,
      "x-forge-oauth-system": "new_system_token",
      "content-type": "application/json",
    },
    body,
  })
}

function postTokenRefresh(app: OpenAPIHono<AppEnv>, authorization: string) {
  return app.request("/api/v1/webhook/atlassian/forge/token-refresh", {
    method: "POST",
    headers: { authorization, "x-forge-oauth-system": "new_system_token" },
  })
}

const pageCreated = JSON.stringify({
  eventType: "avi:confluence:created:page",
  content: { id: "838205441", type: "page", space: { key: "SP" } },
})

describe("Forge install event (Postgres)", () => {
  it("accepts the install of an app that provisioning registered", async () => {
    const { connectionId, atlassianAccountId } = await addPending()
    const registered = appAri()
    // `forge register` writes the new app id into manifest.yml.
    const workdir = mkdtempSync(join(tmpdir(), "ctxpipe-forge-test-"))
    try {
      writeFileSync(
        join(workdir, "manifest.yml"),
        buildForgeAppManifestYml({
          appIdAri: registered,
          remoteBaseUrl: "https://ctxpipe.example.com",
        }),
      )
      await provision.saveRegisteredForgeAppId({
        orgId: seed.orgId,
        connectionId,
        workdir,
      })
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
    expect((await connection(connectionId)).appId).toBe(registered)

    const site = newSite()
    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(registered, site)),
      lifecycleBody(site, atlassianAccountId),
    )

    expect(res.status).toBe(204)
    expect(await connection(connectionId)).toMatchObject({
      status: "installed",
      appId: registered,
      installationId: site.installationId,
      cloudId: site.cloudId,
    })
  })

  it("matches the signed installation before a pending setup of the installer", async () => {
    const site = newSite()
    const installed = await addInstalled(site)
    const pending = await addPending()

    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(hostedAppAri, site)),
      lifecycleBody(site, pending.atlassianAccountId),
    )

    expect(res.status).toBe(204)
    expect((await connection(installed)).appSystemToken).toBe(
      "new_system_token",
    )
    expect((await connection(pending.connectionId)).status).toBe("pending")
  })

  it("answers another app the same way with or without a pending setup", async () => {
    const pending = await addPending()
    const foreign = appAri()
    const app = createApp()

    const site = newSite()
    const withSetup = await postForge(
      app,
      await bearer(claimsForApp(foreign, site)),
      lifecycleBody(site, pending.atlassianAccountId),
    )
    const otherSite = newSite()
    const withoutSetup = await postForge(
      app,
      await bearer(claimsForApp(foreign, otherSite)),
      lifecycleBody(otherSite),
    )

    expect(withSetup.status).toBe(withoutSetup.status)
    expect((await connection(pending.connectionId)).status).toBe("pending")
  })

  it("saves the app that the claims name", async () => {
    const site = newSite()
    const id = await addInstalled(site)
    const res = await postForge(
      createApp(),
      await bearer({
        ...claimsForApp(hostedAppAri, site),
        aud: [appAri(), hostedAppAri],
      }),
      lifecycleBody(site),
    )
    expect(res.status).toBe(204)
    expect((await connection(id)).appId).toBe(hostedAppAri)
  })

  it("refuses claims whose app differs from the audience", async () => {
    const site = newSite()
    await addInstalled(site)
    const claims = claimsForApp(hostedAppAri, site)
    const res = await postForge(
      createApp(),
      await bearer({
        ...claims,
        app: { ...(claims.app as object), id: appAri() },
      }),
      lifecycleBody(site),
    )
    expect(res.status).toBe(401)
  })

  it("refuses a site that differs from the signed API base URL", async () => {
    const site = newSite()
    await addInstalled(site)
    const otherSite = { ...site, cloudId: `cloud_${uuid()}` }
    const res = await postForge(
      createApp(),
      await bearer({
        ...claimsForApp(hostedAppAri, site),
        context: { cloudId: otherSite.cloudId },
      }),
      lifecycleBody(otherSite),
    )
    expect(res.status).toBe(400)
  })
})

describe("Forge install event body (Postgres)", () => {
  it("accepts a body installation id that is a full ARI", async () => {
    const site = newSite()
    await addInstalled(site)
    const body = JSON.parse(lifecycleBody(site)) as Record<string, unknown>
    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(hostedAppAri, site)),
      JSON.stringify({
        ...body,
        id: `ari:cloud:ecosystem::installation/${site.installationId}`,
      }),
    )
    expect(res.status).toBe(204)
  })

  it.each([
    ["installation", (site: Site) => ({ ...site, installationId: uuid() })],
    ["site", (site: Site) => ({ ...site, cloudId: `cloud_${uuid()}` })],
  ])(
    "refuses a body whose %s differs from the claims",
    async (_name, change) => {
      const site = newSite()
      await addInstalled(site)
      const res = await postForge(
        createApp(),
        await bearer(claimsForApp(hostedAppAri, site)),
        lifecycleBody(change(site)),
      )
      expect(res.status).toBe(400)
    },
  )

  it("refuses claims without a valid API base URL", async () => {
    const site = newSite()
    await addInstalled(site)
    const claims = claimsForApp(hostedAppAri, site)
    const res = await postForge(
      createApp(),
      await bearer({
        ...claims,
        app: {
          ...(claims.app as object),
          apiBaseUrl: `http://api.atlassian.com/ex/confluence/${site.cloudId}`,
        },
      }),
      lifecycleBody(site),
    )
    expect(res.status).toBe(400)
  })
})

describe("Forge call verification (Postgres)", () => {
  const site = newSite()
  beforeAll(async () => {
    await addInstalled(site)
  })

  it.each([
    [
      "an expired call",
      async () =>
        bearer(claimsForApp(hostedAppAri, site), {
          issuedAt: Math.floor(Date.now() / 1000) - 600,
          expiresAt: Math.floor(Date.now() / 1000) - 300,
        }),
    ],
    [
      "a call older than one minute",
      async () =>
        bearer(claimsForApp(hostedAppAri, site), {
          issuedAt: Math.floor(Date.now() / 1000) - 120,
        }),
    ],
    [
      "another signing key",
      async () => bearer(claimsForApp(hostedAppAri, site), { key: otherKey }),
    ],
    [
      "no audience",
      async () => {
        const { aud: _aud, ...claims } = claimsForApp(hostedAppAri, site)
        return bearer(claims)
      },
    ],
    [
      "another issuer",
      async () =>
        bearer({ ...claimsForApp(hostedAppAri, site), iss: "someone-else" }),
    ],
  ])("refuses %s", async (_name, authorization) => {
    const res = await postForge(
      createApp(),
      await authorization(),
      lifecycleBody(site),
    )
    expect(res.status).toBe(401)
  })

  it("accepts the app of CONFLUENCE_FORGE_INSTALL_URL", async () => {
    const id = uuid()
    const own = newSite()
    await addInstalled(own)
    const res = await postForge(
      createApp(
        envWith({
          CONFLUENCE_FORGE_INSTALL_URL: `https://developer.atlassian.com/console/install/${id}?signature=x`,
        }),
      ),
      await bearer(claimsForApp(appAri(id), own)),
      lifecycleBody(own),
    )
    expect(res.status).toBe(204)
  })

  it("accepts the app of the connection install URL", async () => {
    const id = uuid()
    const own = newSite()
    await addInstalled(own, {
      confluenceForgeInstallUrl: `https://developer.atlassian.com/console/install/${id}?signature=x`,
    })
    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(appAri(id), own)),
      lifecycleBody(own),
    )
    expect(res.status).toBe(204)
  })

  it.each([
    ["a production deployment", "production", undefined, 401],
    ["a deployment with no NODE_ENV", undefined, undefined, 204],
    ["an unknown Railway deployment", "development", "staging", 401],
    ["a Railway production", "development", "production", 401],
    ["a PR preview", "production", "pr-1", 204],
    ["local development", "development", undefined, 204],
    ["tests", "test", undefined, 204],
  ])(
    "answers a DEVELOPMENT Forge app in %s",
    async (_name, nodeEnv, railway, status) => {
      const res = await postForge(
        createApp(
          envWith({ NODE_ENV: nodeEnv, RAILWAY_ENVIRONMENT_NAME: railway }),
        ),
        await bearer(claimsForApp(hostedAppAri, site, "DEVELOPMENT")),
        lifecycleBody(site),
      )
      expect(res.status).toBe(status)
    },
  )
})

describe("Forge Confluence event (Postgres)", () => {
  it("refuses another app on an installed connection", async () => {
    const site = newSite()
    await addInstalled(site)
    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(appAri(), site)),
      pageCreated,
    )
    expect(res.status).toBe(401)
  })

  it("accepts the app of the connection", async () => {
    const site = newSite()
    await addInstalled(site)
    const res = await postForge(
      createApp(),
      await bearer(claimsForApp(hostedAppAri, site)),
      pageCreated,
    )
    expect(res.status).not.toBe(401)
    expect(res.status).toBeLessThan(300)
  })
})

describe("Forge token refresh (Postgres)", () => {
  it("saves the new token on the checked connection", async () => {
    const site = newSite()
    const id = await addInstalled(site)
    const res = await postTokenRefresh(
      createApp(),
      await bearer(claimsForApp(hostedAppAri, site)),
    )
    expect(res.status).toBe(204)
    expect((await connection(id)).appSystemToken).toBe("new_system_token")
  })

  it("refuses another app and logs it", async () => {
    const site = newSite()
    const id = await addInstalled(site)
    events.length = 0
    const res = await postTokenRefresh(
      createApp(),
      await bearer(claimsForApp(appAri(), site)),
    )
    expect(res.status).toBe(401)
    const warning = events.find((event) =>
      JSON.stringify(event).includes("forge_token_refresh_untrusted_app"),
    )
    expect(warning).toMatchObject({
      level: "warn",
      connectionId: id,
      orgId: seed.orgId,
    })
    expect((await connection(id)).appSystemToken).toBe("old_system_token")
  })
})
