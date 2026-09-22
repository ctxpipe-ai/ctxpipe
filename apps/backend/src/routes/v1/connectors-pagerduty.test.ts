import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  createPagerdutyOAuthState,
  PAGERDUTY_PKCE_COOKIE,
  serializePagerdutyPkceCookie,
} from "../../services/pagerduty/oauth-state.js"
import {
  pagerdutyConnectorRoutes,
  pagerdutyOauthCallbackRoutes,
} from "./connectors-pagerduty.js"

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  getIdentity: vi.fn(),
  hasAdminRole: vi.fn(),
  upsertConnection: vi.fn(),
  ensureWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  persistWebhook: vi.fn(),
  deleteConnection: vi.fn(),
  resolveConnection: vi.fn(),
  getConnection: vi.fn(),
  createDraft: vi.fn(),
  saveOauthApp: vi.fn(),
  oauthMetadata: vi.fn(),
  getTarget: vi.fn(),
  patchConfig: vi.fn(),
  claimConfig: vi.fn(),
  runWorkflow: vi.fn(),
  loadConfig: vi.fn(),
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))
vi.mock("../../auth/withAuth.js", () => ({
  hasOrgAdminOrOwnerRole: mocks.hasAdminRole,
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, run: () => Promise<unknown>) =>
    run(),
  ),
}))
vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: vi.fn().mockResolvedValue(true),
}))
vi.mock("../../models/pagerduty-connector.js", () => ({
  claimPagerdutyConfigPrCreation: mocks.claimConfig,
  claimPagerdutyContentSyncRetry: vi.fn(),
  createOrReusePagerdutyDraft: mocks.createDraft,
  deletePagerdutyConnectionById: mocks.deleteConnection,
  getPagerdutyBindingWithRepoByConnectionId: mocks.getTarget,
  getPagerdutyConnectionByConnectionId: mocks.getConnection,
  MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE: "multiple",
  pagerdutyOAuthAppMetadata: mocks.oauthMetadata,
  patchPagerdutyConnectorConfig: mocks.patchConfig,
  recordPagerdutyOAuthRevocation: vi.fn(),
  refreshPagerdutyConnectionTokensWithLock: vi.fn(),
  releasePagerdutyConfigPrCreationClaim: vi.fn(),
  resolvePagerdutyConnectionForOrgDetailed: mocks.resolveConnection,
  savePagerdutyOAuthApp: mocks.saveOauthApp,
  persistPagerdutyWebhookSubscriptionIfAbsent: mocks.persistWebhook,
  transitionPagerdutyBindingState: vi.fn(),
  upsertPagerdutyConnectionFromOAuth: mocks.upsertConnection,
}))
vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))
vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../openworkflow/workflows/pagerduty-sync-config.js", () => ({
  pagerdutySyncConfig: { spec: { name: "pagerduty-sync-config" } },
}))
vi.mock("../../openworkflow/workflows/pagerduty-sync-content.js", () => ({
  pagerdutySyncContent: { spec: { name: "pagerduty-sync-content" } },
}))
vi.mock("../../services/pagerduty/config-from-repo.js", () => ({
  loadPagerdutyScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../services/pagerduty/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/pagerduty/client.js")>()
  return {
    ...actual,
    exchangePagerdutyOAuthCode: mocks.exchangeCode,
    getPagerdutyAccountIdentity: mocks.getIdentity,
    ensurePagerdutyWebhookSubscription: mocks.ensureWebhook,
    deletePagerdutyWebhookSubscription: mocks.deleteWebhook,
  }
})

const env = {
  AUTH_BASE_URL: "https://ctxpipe.example",
  AUTH_SECRET: "pagerduty-route-test-secret-long-enough",
  PAGERDUTY_CLIENT_ID: "pd-client",
  PAGERDUTY_CLIENT_SECRET: "pd-secret",
} as Env

function appWithVariables(runtimeEnv: Env = env) {
  return new OpenAPIHono<AppEnv>().use("*", async (c, next) => {
    c.set("env", runtimeEnv)
    c.set("user", { id: "user_1" } as unknown as AppEnv["Variables"]["user"])
    c.set("session", {
      id: "session_1",
    } as unknown as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    await next()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasAdminRole.mockResolvedValue(true)
  mocks.exchangeCode.mockResolvedValue({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
  })
  mocks.getIdentity.mockResolvedValue({
    accountId: "acme",
    accountName: "acme",
    accountSubdomain: "acme",
    region: "us",
    actorUserId: "PUSER",
  })
  mocks.upsertConnection.mockResolvedValue({
    id: "con_pd",
    webhookSubscriptionId: null,
    webhookSecretEnc: null,
  })
  mocks.ensureWebhook.mockResolvedValue({ id: "PFSUB", secret: "whsec" })
  mocks.persistWebhook.mockResolvedValue("PFSUB")
  mocks.resolveConnection.mockResolvedValue({
    status: "ok",
    connection: { id: "con_pd", status: "installed" },
  })
  mocks.getTarget.mockResolvedValue({
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    githubConnectionId: "con_github",
    branch: "main",
    enabled: true,
    setupPhase: "draft",
  })
  mocks.loadConfig.mockResolvedValue({ services: [] })
  mocks.patchConfig.mockResolvedValue({ bindingChanged: true })
  mocks.claimConfig.mockResolvedValue({
    pendingConfigPullUrl: null,
    setupPhase: "draft",
  })
  mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  mocks.getConnection.mockResolvedValue({
    id: "con_pd",
    accountId: "pending:con_pd",
    status: "pending",
    oauthClientId: null,
    oauthClientSecretEnc: null,
  })
  mocks.createDraft.mockResolvedValue({ id: "con_pd" })
  mocks.oauthMetadata.mockReturnValue({
    oauthAppSaved: false,
    globalPagerdutyOAuthConfigured: true,
    oauthCallbackUrl:
      "https://ctxpipe.example/api/v1/integrations/pagerduty/callback",
    webhookUrl: "https://ctxpipe.example/api/v1/webhook/pagerduty",
  })
  mocks.saveOauthApp.mockResolvedValue(undefined)
})

function signedState(
  overrides: { userId?: string; now?: number; connectionId?: string } = {},
) {
  return createPagerdutyOAuthState({
    authSecret: env.AUTH_SECRET,
    orgId: "org_1",
    orgSlug: "acme",
    userId: overrides.userId ?? "user_1",
    connectionId: overrides.connectionId,
    now: overrides.now,
  })
}

function pkceCookie(nonce: string, verifier = "verifier") {
  return `${PAGERDUTY_PKCE_COOKIE}=${serializePagerdutyPkceCookie({
    nonce,
    codeVerifier: verifier,
  })}`
}

describe("PagerDuty connector routes", () => {
  it("returns a PKCE authorization URL", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth/start",
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string }
    const authorizationUrl = new URL(body.authorizationUrl)
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    )
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
      "users.read",
    )
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy()
    expect(authorizationUrl.searchParams.get("client_id")).toBe("pd-client")
    expect(response.headers.get("set-cookie")).toContain(PAGERDUTY_PKCE_COOKIE)
  })

  it("returns 503 when neither the row nor env has an OAuth app", async () => {
    const emptyEnv = {
      ...env,
      PAGERDUTY_CLIENT_ID: undefined,
      PAGERDUTY_CLIENT_SECRET: undefined,
    } as Env
    const app = new OpenAPIHono<AppEnv>()
      .use("*", async (c, next) => {
        c.set("env", emptyEnv)
        c.set("user", {
          id: "user_1",
        } as unknown as AppEnv["Variables"]["user"])
        c.set("session", {
          id: "session_1",
        } as unknown as AppEnv["Variables"]["session"])
        c.set("orgId", "org_1")
        c.set("orgSlug", "acme")
        await next()
      })
      .route("/acme/api/v1/connectors/pagerduty", pagerdutyConnectorRoutes)
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      oauthClientId: null,
      oauthClientSecretEnc: null,
    })
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth/start?connectionId=con_pd",
    )
    expect(response.status).toBe(503)
  })

  it("starts OAuth with the row client id when env is empty", async () => {
    const emptyEnv = {
      ...env,
      PAGERDUTY_CLIENT_ID: undefined,
      PAGERDUTY_CLIENT_SECRET: undefined,
      AUTH_SECRET: env.AUTH_SECRET,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
    } as Env
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      oauthClientId: "row-client",
      oauthClientSecretEnc: encryptConnectionSecret("row-secret", emptyEnv),
    })
    const app = new OpenAPIHono<AppEnv>()
      .use("*", async (c, next) => {
        c.set("env", emptyEnv)
        c.set("user", {
          id: "user_1",
        } as unknown as AppEnv["Variables"]["user"])
        c.set("session", {
          id: "session_1",
        } as unknown as AppEnv["Variables"]["session"])
        c.set("orgId", "org_1")
        c.set("orgSlug", "acme")
        await next()
      })
      .route("/acme/api/v1/connectors/pagerduty", pagerdutyConnectorRoutes)
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth/start?connectionId=con_pd",
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string }
    expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(
      "row-client",
    )
  })

  it("prefers the row OAuth app when hosted env credentials also exist", async () => {
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      oauthClientId: "row-client",
      oauthClientSecretEnc: encryptConnectionSecret("row-secret", env),
    })
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )

    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth/start?connectionId=con_pd",
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string }
    expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(
      "row-client",
    )
  })

  it("starts hosted setup without creating a draft", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/setup",
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connectionId: null })
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it("creates a draft for self-hosted setup", async () => {
    const selfHostedEnv = {
      ...env,
      PAGERDUTY_CLIENT_ID: undefined,
      PAGERDUTY_CLIENT_SECRET: undefined,
    } as Env
    const app = appWithVariables(selfHostedEnv).route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/setup",
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connectionId: "con_pd" })
  })

  it("saves an OAuth app without echoing the secret", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth-app?connectionId=con_pd",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "row-client",
          clientSecret: "super-secret",
        }),
      },
    )
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(mocks.saveOauthApp).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "row-client",
        clientSecret: "super-secret",
      }),
    )
  })

  it("rejects changing an OAuth app after tokens are issued", async () => {
    mocks.saveOauthApp.mockRejectedValueOnce(
      new Error(
        "PagerDuty OAuth app cannot be changed after account authorisation",
      ),
    )
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )

    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/oauth-app?connectionId=con_pd",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "replacement-client",
          clientSecret: "replacement-secret",
        }),
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        "PagerDuty OAuth app cannot be changed after account authorisation",
    })
  })

  it("relays the PagerDuty identity error instead of a generic failure", async () => {
    mocks.getIdentity.mockRejectedValueOnce(
      new Error("PagerDuty identity lookup failed (401)"),
    )
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState()
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      "PagerDuty identity lookup failed (401)",
    )
  })

  it("exchanges the callback and relays the connection id", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ connectionId: "con_pd" })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("con_pd")
    expect(mocks.exchangeCode).toHaveBeenCalledWith({
      env,
      creds: { clientId: "pd-client", clientSecret: "pd-secret" },
      code: "oauth-code",
      codeVerifier: "verifier",
    })
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "con_pd" }),
    )
    expect(mocks.persistWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookSubscriptionId: "PFSUB",
        webhookSecret: "whsec",
      }),
    )
    expect(mocks.ensureWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSubscriptionId: null,
        hasStoredSecret: false,
      }),
    )
  })

  it("rejects reconnecting an existing connection to another account", async () => {
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      accountId: "original-account",
      status: "installed",
    })
    mocks.upsertConnection.mockRejectedValueOnce(
      new Error("PagerDuty authorised account does not match this connection"),
    )
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ connectionId: "con_pd" })

    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      "PagerDuty authorised account does not match this connection",
    )
    expect(mocks.upsertConnection).toHaveBeenCalled()
    expect(mocks.ensureWebhook).not.toHaveBeenCalled()
  })

  it("does not complete OAuth when webhook persistence fails", async () => {
    mocks.persistWebhook.mockRejectedValueOnce(
      new Error("database unavailable"),
    )
    mocks.deleteWebhook.mockResolvedValueOnce(undefined)
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ connectionId: "con_pd" })

    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      "PagerDuty authorization could not be completed",
    )
    expect(mocks.ensureWebhook).toHaveBeenCalled()
    expect(mocks.deleteWebhook).toHaveBeenCalledWith({
      accessToken: "access-token",
      region: "us",
      subscriptionId: "PFSUB",
    })
  })

  it("does not complete OAuth when webhook creation fails", async () => {
    mocks.ensureWebhook.mockRejectedValueOnce(
      new Error("PagerDuty webhook subscription create failed (403)"),
    )
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ connectionId: "con_pd" })

    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      "PagerDuty webhook subscription create failed (403)",
    )
    expect(mocks.persistWebhook).not.toHaveBeenCalled()
  })

  it("rejects an expired OAuth state", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ now: Date.now() - 20 * 60 * 1000 })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )
    expect(response.status).toBe(400)
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
  })

  it("rejects a callback when the PKCE cookie nonce is missing", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state } = signedState()
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Missing PagerDuty PKCE verifier",
    })
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
  })

  it("rejects a state signed for another user", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const { state, nonce } = signedState({ userId: "other-user" })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )
    expect(response.status).toBe(400)
  })

  it("rejects a state signed for another org after callback verification", async () => {
    const { state, nonce } = createPagerdutyOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_other",
      orgSlug: "other",
      userId: "user_1",
    })
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    mocks.hasAdminRole.mockResolvedValueOnce(false)
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: pkceCookie(nonce) } },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      "You no longer have permission to connect PagerDuty",
    )
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
  })

  it("enqueues a config PR when services change", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty/config?connectionId=con_pd",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          services: [{ id: "PSVC", name: "checkout" }],
        }),
      },
    )
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "pagerduty-sync-config" },
      expect.objectContaining({
        connectionId: "con_pd",
        services: [{ id: "PSVC", name: "checkout" }],
      }),
    )
  })

  it("removes the PagerDuty subscription before deleting the connection", async () => {
    mocks.resolveConnection.mockResolvedValue({
      status: "ok",
      connection: {
        id: "con_pd",
        status: "installed",
        accessToken: "pd-access",
        region: "us",
        webhookSubscriptionId: "PFSUB",
      },
    })
    mocks.deleteWebhook.mockResolvedValue(undefined)
    mocks.deleteConnection.mockResolvedValue(true)
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/pagerduty",
      pagerdutyConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/pagerduty?connectionId=con_pd",
      { method: "DELETE" },
    )
    expect(response.status).toBe(204)
    expect(mocks.deleteWebhook).toHaveBeenCalledWith({
      accessToken: "pd-access",
      region: "us",
      subscriptionId: "PFSUB",
    })
    expect(mocks.deleteConnection).toHaveBeenCalledWith("org_1", "con_pd")
    expect(mocks.deleteWebhook.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteConnection.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    )
  })
})
