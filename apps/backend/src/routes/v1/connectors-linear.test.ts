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
  getWorkspace: vi.fn(),
  upsertConnection: vi.fn(),
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
  deleteLinearConnectionById: vi.fn(),
  getLinearSyncTargetWithRepoByConnectionId: vi.fn(),
  listLinearScopesByConnectionId: vi.fn(),
  MULTIPLE_LINEAR_CONNECTIONS_MESSAGE: "multiple",
  patchLinearConnectorConfig: vi.fn(),
  resolveLinearConnectionForOrgDetailed: vi.fn(),
  updateLinearConnectionTokens: vi.fn(),
  upsertLinearConnectionFromOAuth: mocks.upsertConnection,
}))
vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))
vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))
vi.mock("../../openworkflow/workflows/linear-sync-config.js", () => ({
  linearSyncConfig: { spec: { name: "linear-sync-config" } },
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
  })
})
