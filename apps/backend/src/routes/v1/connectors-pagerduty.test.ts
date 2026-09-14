import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import { createPagerdutyOAuthState } from "../../services/pagerduty/oauth-state.js"
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
  saveWebhook: vi.fn(),
  resolveConnection: vi.fn(),
  getTarget: vi.fn(),
  patchConfig: vi.fn(),
  claimConfig: vi.fn(),
  runWorkflow: vi.fn(),
  loadConfig: vi.fn(),
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
  deletePagerdutyConnectionById: vi.fn(),
  getPagerdutyBindingWithRepoByConnectionId: mocks.getTarget,
  MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE: "multiple",
  patchPagerdutyConnectorConfig: mocks.patchConfig,
  refreshPagerdutyConnectionTokensWithLock: vi.fn(),
  releasePagerdutyConfigPrCreationClaim: vi.fn(),
  resolvePagerdutyConnectionForOrgDetailed: mocks.resolveConnection,
  savePagerdutyWebhookSubscription: mocks.saveWebhook,
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
  }
})

const env = {
  AUTH_BASE_URL: "https://ctxpipe.example",
  AUTH_SECRET: "pagerduty-route-test-secret-long-enough",
  PAGERDUTY_CLIENT_ID: "pd-client",
  PAGERDUTY_CLIENT_SECRET: "pd-secret",
} as Env

function appWithVariables() {
  return new OpenAPIHono<AppEnv>().use("*", async (c, next) => {
    c.set("env", env)
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
})

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
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy()
  })

  it("exchanges the callback and relays the connection id", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const state = createPagerdutyOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
      codeVerifier: "verifier",
    })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("con_pd")
    expect(mocks.exchangeCode).toHaveBeenCalledWith({
      env,
      code: "oauth-code",
      codeVerifier: "verifier",
    })
    expect(mocks.saveWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookSubscriptionId: "PFSUB",
        webhookSecret: "whsec",
      }),
    )
  })

  it("rejects an expired OAuth state", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const state = createPagerdutyOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
      codeVerifier: "verifier",
      now: Date.now() - 20 * 60 * 1000,
    })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )
    expect(response.status).toBe(400)
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
  })

  it("rejects a state signed for another user", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/pagerduty",
      pagerdutyOauthCallbackRoutes,
    )
    const state = createPagerdutyOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "other-user",
      codeVerifier: "verifier",
    })
    const response = await app.request(
      `/api/v1/integrations/pagerduty/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )
    expect(response.status).toBe(400)
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
})
