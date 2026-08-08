import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import { createLinearOAuthState } from "../../services/linear/oauth-state.js"
import {
  linearConnectorRoutes,
  linearOauthCallbackRoutes,
} from "./connectors-linear.js"

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  claimContentRetry: vi.fn(),
  getWorkspace: vi.fn(),
  hasAdminRole: vi.fn(),
  getTarget: vi.fn(),
  patchConfig: vi.fn(),
  releaseClaim: vi.fn(),
  resolveConnection: vi.fn(),
  runWorkflow: vi.fn(),
  updatePrState: vi.fn(),
  upsertConnection: vi.fn(),
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
vi.mock("../../models/linear-connector.js", () => ({
  claimLinearContentSyncRetry: mocks.claimContentRetry,
  deleteLinearConnectionById: vi.fn(),
  getLinearSyncTargetWithRepoByConnectionId: mocks.getTarget,
  listLinearScopesByConnectionId: vi.fn(),
  MULTIPLE_LINEAR_CONNECTIONS_MESSAGE: "multiple",
  patchLinearConnectorConfig: mocks.patchConfig,
  refreshLinearConnectionTokensWithLock: vi.fn(),
  releaseLinearConfigPrCreationClaim: mocks.releaseClaim,
  resolveLinearConnectionForOrgDetailed: mocks.resolveConnection,
  updateLinearSyncTargetPrState: mocks.updatePrState,
  upsertLinearConnectionFromOAuth: mocks.upsertConnection,
}))
vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))
vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../openworkflow/workflows/linear-sync-config.js", () => ({
  linearSyncConfig: { spec: { name: "linear-sync-config" } },
}))
vi.mock("../../openworkflow/workflows/linear-sync-content.js", () => ({
  linearSyncContent: { spec: { name: "linear-sync-content" } },
}))
vi.mock("../../openworkflow/workflows/linear-sync-incremental.js", () => ({
  linearSyncIncremental: { spec: { name: "linear-sync-incremental" } },
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/linear/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/linear/client.js")>()
  return {
    ...actual,
    exchangeLinearOAuthCode: mocks.exchangeCode,
    getLinearWorkspaceIdentity: mocks.getWorkspace,
  }
})

const env = {
  AUTH_BASE_URL: "https://ctxpipe.example",
  AUTH_SECRET: "linear-route-test-secret-that-is-long-enough",
  LINEAR_CLIENT_ID: "linear-client",
  LINEAR_CLIENT_SECRET: "linear-secret",
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
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 86_399,
    token_type: "Bearer",
    scope: "read",
  })
  mocks.getWorkspace.mockResolvedValue({
    workspaceId: "workspace_1",
    workspaceName: "Acme",
    workspaceUrlKey: "acme",
    actorUserId: "linear-user_1",
  })
  mocks.upsertConnection.mockResolvedValue({ id: "con_linear" })
  mocks.resolveConnection.mockResolvedValue({
    status: "ok",
    connection: { id: "con_linear", status: "installed" },
  })
  mocks.getTarget.mockResolvedValue({
    repositoryId: "repo_1",
    setupPhase: "sync_failed",
  })
  mocks.claimContentRetry.mockResolvedValue(true)
  mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
})

describe("Linear connector routes", () => {
  it("returns a signed read-only authorization URL", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/linear/oauth/start",
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string }
    const authorizationUrl = new URL(body.authorizationUrl)
    expect(authorizationUrl.searchParams.get("scope")).toBe("read")
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy()
  })

  it("exchanges the callback and relays the connection id", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      enabled: true,
      setupPhase: "live",
    })
    const app = appWithVariables().route(
      "/api/v1/integrations/linear",
      linearOauthCallbackRoutes,
    )
    const state = createLinearOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
    })
    const response = await app.request(
      `/api/v1/integrations/linear/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("con_linear")
    expect(mocks.exchangeCode).toHaveBeenCalledWith({
      env,
      code: "oauth-code",
    })
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: "workspace_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
    )
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-incremental" },
      { orgId: "org_1", connectionId: "con_linear" },
    )
  })

  it("relays a Linear authorization error back to the setup dialog", async () => {
    const app = appWithVariables().route(
      "/api/v1/integrations/linear",
      linearOauthCallbackRoutes,
    )
    const state = createLinearOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
    })

    const response = await app.request(
      `/api/v1/integrations/linear/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("linear-oauth-error")
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
  })

  it("relays token exchange failures back to the setup dialog", async () => {
    mocks.exchangeCode.mockRejectedValueOnce(new Error("provider unavailable"))
    const app = appWithVariables().route(
      "/api/v1/integrations/linear",
      linearOauthCallbackRoutes,
    )
    const state = createLinearOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
    })

    const response = await app.request(
      `/api/v1/integrations/linear/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("linear-oauth-error")
    expect(mocks.upsertConnection).not.toHaveBeenCalled()
  })

  it("relays an error when the user is no longer an org administrator", async () => {
    mocks.hasAdminRole.mockResolvedValueOnce(false)
    const app = appWithVariables().route(
      "/api/v1/integrations/linear",
      linearOauthCallbackRoutes,
    )
    const state = createLinearOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
    })
    const response = await app.request(
      `/api/v1/integrations/linear/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("linear-oauth-error")
    expect(mocks.exchangeCode).not.toHaveBeenCalled()
    expect(mocks.upsertConnection).not.toHaveBeenCalled()
  })

  it("retries failed configuration pull request creation", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      setupPhase: "config_failed",
    })
    mocks.patchConfig.mockResolvedValueOnce({
      scopes: [{ externalId: "team-1" }],
      scopesChanged: false,
      syncTargetChanged: false,
      configPrClaimed: true,
      previousConfigPrState: {
        pendingConfigPullUrl: null,
        setupPhase: "config_failed",
      },
    })
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/linear/retry-config?connectionId=con_linear",
      { method: "POST" },
    )

    expect(response.status).toBe(202)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-config" },
      {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_linear",
      },
    )
  })

  it("marks initial configuration enqueue failures as retryable", async () => {
    mocks.patchConfig.mockResolvedValueOnce({
      scopes: [],
      scopesChanged: true,
      syncTargetChanged: false,
      configPrClaimed: true,
      previousConfigPrState: {
        pendingConfigPullUrl: null,
        setupPhase: "draft",
      },
    })
    mocks.runWorkflow.mockRejectedValueOnce(new Error("worker unavailable"))
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/linear/config?connectionId=con_linear",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: [] }),
      },
    )

    expect(response.status).toBe(503)
    expect(mocks.updatePrState).toHaveBeenCalledWith({
      connectionId: "con_linear",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "config_failed",
    })
  })

  it("retries failed content sync without raising another config PR", async () => {
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST" },
    )

    expect(response.status).toBe(202)
    expect(mocks.claimContentRetry).toHaveBeenCalledWith("con_linear")
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-content" },
      { orgId: "org_1", connectionId: "con_linear" },
    )
  })

  it("restores the failed state when retry enqueue fails", async () => {
    mocks.runWorkflow.mockRejectedValueOnce(new Error("worker unavailable"))
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )
    const response = await app.request(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST" },
    )

    expect(response.status).toBe(500)
    expect(mocks.updatePrState).toHaveBeenCalledWith({
      connectionId: "con_linear",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "sync_failed",
    })
  })

  it("does not start a content retry outside the failed state", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      setupPhase: "live",
    })
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )

    const response = await app.request(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST" },
    )

    expect(response.status).toBe(400)
    expect(mocks.claimContentRetry).not.toHaveBeenCalled()
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("does not enqueue a content retry when another request claimed it", async () => {
    mocks.claimContentRetry.mockResolvedValueOnce(false)
    const app = appWithVariables().route(
      "/acme/api/v1/connectors/linear",
      linearConnectorRoutes,
    )

    const response = await app.request(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST" },
    )

    expect(response.status).toBe(409)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })
})
