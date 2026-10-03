import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const orgHasGithubMock = vi.hoisted(() => vi.fn())
const resolveConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const bindRepositoryMock = vi.hoisted(() => vi.fn())
const enqueueIngestionMock = vi.hoisted(() => vi.fn())
const assertOAuthConfiguredMock = vi.hoisted(() => vi.fn())
const exchangeOAuthCodeMock = vi.hoisted(() => vi.fn())
const verifyInstallationMock = vi.hoisted(() => vi.fn())
const upsertConnectionMock = vi.hoisted(() => vi.fn())
const SlackOAuthMissingScopesErrorMock = vi.hoisted(
  () =>
    class SlackOAuthMissingScopesError extends Error {
      readonly missingScopes: string[]

      constructor(missingScopes: string[]) {
        super(`Missing Slack scopes: ${missingScopes.join(", ")}`)
        this.name = "SlackOAuthMissingScopesError"
        this.missingScopes = missingScopes
      }
    },
)
const SlackRepositoryNotFoundErrorMock = vi.hoisted(
  () =>
    class SlackRepositoryNotFoundError extends Error {
      constructor() {
        super("Repository not found for organization")
      }
    },
)

vi.mock("../../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: orgHasGithubMock,
}))
vi.mock("../../models/slack-connector.js", () => ({
  bindSlackSyncTargetRepository: bindRepositoryMock,
  deleteSlackConnectionById: vi.fn(),
  derivedSlackSetupPhase: ({
    repositoryId,
    enabled,
  }: {
    repositoryId?: string | null
    enabled: boolean
  }) => (repositoryId && enabled ? "live" : "draft"),
  getSlackBindingWithRepoByConnectionId: getTargetMock,
  MULTIPLE_SLACK_CONNECTIONS_MESSAGE:
    "Multiple Slack connections for this organization; specify connectionId query parameter",
  resolveSlackConnectionForOrgDetailed: resolveConnectionMock,
  SLACK_SETUP_PHASES: ["draft", "live"] as const,
  SlackRepositoryNotFoundError: SlackRepositoryNotFoundErrorMock,
  SlackTeamAlreadyConnectedError: class SlackTeamAlreadyConnectedError extends Error {},
  upsertSlackConnectionFromOAuth: upsertConnectionMock,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))
vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: enqueueIngestionMock,
}))
vi.mock("../../services/slack/client.js", () => ({
  assertSlackOAuthConfigured: assertOAuthConfiguredMock,
  botTokenFromConnection: vi.fn(() => "xoxb-test"),
  exchangeSlackOAuthCode: exchangeOAuthCodeMock,
  fetchSlackUserProfile: vi.fn(),
  getSlackOAuthAuthorizeUrl: vi.fn(
    ({ state }: { state: string }) =>
      `https://slack.com/oauth/v2/authorize?state=${state}`,
  ),
  SlackOAuthMissingScopesError: SlackOAuthMissingScopesErrorMock,
  verifySlackInstallation: verifyInstallationMock,
}))

import {
  slackConnectorRoutes,
  slackOAuthCallbackRoutes,
} from "./connectors-slack.js"

const connection = {
  id: "con_1",
  orgId: "org_1",
  status: "installed",
  botTokenEnc: "encrypted-token",
  teamName: "Acme Workspace",
  botHandle: "ctxpipe",
}

function testApp() {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never)
    c.set("session", { id: "session_1" } as never)
    c.set("orgId", "org_1")
    c.set("env", { AUTH_SECRET: "a".repeat(32) } as never)
    await next()
  })
  app.route("/:orgSlug/api/v1/connectors/slack", slackConnectorRoutes as never)
  app.route(
    "/api/v1/connectors/slack",
    slackOAuthCallbackRoutes as never,
  )
  return app
}

describe("Slack connector routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assertOAuthConfiguredMock.mockReturnValue(undefined)
    orgHasGithubMock.mockResolvedValue(true)
    resolveConnectionMock.mockResolvedValue({
      status: "ok",
      connection,
    })
    getTargetMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "ghc_1",
      branch: "main",
      enabled: true,
      setupPhase: "live",
    })
    bindRepositoryMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "live",
    })
    verifyInstallationMock.mockResolvedValue({
      appId: "A_CTXPIPE",
      storedTeamId: "T_TRU",
      storedBotUserId: "U_BOT",
      reportedTeamId: "T_TRU",
      reportedBotUserId: "U_BOT",
      botId: "B_BOT",
      grantedScopes: ["app_mentions:read", "chat:write"],
      missingScopes: ["channels:history"],
      identityMatches: true,
    })
  })

  it("returns phase-aware status for an installed connection", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/status?connectionId=con_1",
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      isInstalled: true,
      isGithubLinked: true,
      setupPhase: "live",
      botHandle: "ctxpipe",
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        branch: "main",
        githubConnectionId: "ghc_1",
      },
    })
  })

  it("rejects ambiguous status requests without connectionId", async () => {
    resolveConnectionMock.mockResolvedValue({ status: "ambiguous" })

    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/status",
    )

    expect(response.status).toBe(400)
  })

  it("returns a clear deployment error when Slack OAuth is unavailable", async () => {
    assertOAuthConfiguredMock.mockImplementation(() => {
      throw new Error("not configured")
    })

    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/oauth/start",
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: "slack_oauth_not_configured",
    })
  })

  it("verifies the live Slack token without returning the token", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/verify?connectionId=con_1",
      { method: "POST" },
    )

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      appId: "A_CTXPIPE",
      storedTeamId: "T_TRU",
      reportedTeamId: "T_TRU",
      grantedScopes: ["app_mentions:read", "chat:write"],
      missingScopes: ["channels:history"],
      identityMatches: true,
    })
    expect(JSON.stringify(result)).not.toContain("xoxb-test")
    expect(verifyInstallationMock).toHaveBeenCalledWith({
      connection,
      botToken: "xoxb-test",
    })
  })

  it("relays missing OAuth scopes without persisting the token", async () => {
    const startResponse = await testApp().request(
      "/acme/api/v1/connectors/slack/oauth/start",
    )
    const { authorizationUrl } = (await startResponse.json()) as {
      authorizationUrl: string
    }
    const state = new URL(authorizationUrl).searchParams.get("state")
    expect(state).toBeTruthy()
    exchangeOAuthCodeMock.mockRejectedValue(
      new SlackOAuthMissingScopesErrorMock(["app_mentions:read"]),
    )

    const response = await testApp().request(
      `/api/v1/connectors/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(
      "Slack did not grant required permissions: app_mentions:read",
    )
    expect(upsertConnectionMock).not.toHaveBeenCalled()
  })

  it("binds a context repository and reports the connector as live", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId: "repo_1" }),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      setupPhase: "live",
    })
    expect(bindRepositoryMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      repositoryName: undefined,
      gitUrl: undefined,
      githubConnectionId: undefined,
      branch: undefined,
    })
    expect(enqueueIngestionMock).not.toHaveBeenCalled()
  })

  it("binds by GitHub repository metadata when the repo is not registered yet", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryName: "acme/ctxpipe-context",
          gitUrl: "https://github.com/acme/ctxpipe-context.git",
          githubConnectionId: "ghc_1",
          branch: "main",
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(bindRepositoryMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: undefined,
      repositoryName: "acme/ctxpipe-context",
      gitUrl: "https://github.com/acme/ctxpipe-context.git",
      githubConnectionId: "ghc_1",
      branch: "main",
    })
    expect(enqueueIngestionMock).not.toHaveBeenCalled()
  })

  it("enqueues repository ingestion when bind creates a new repository", async () => {
    bindRepositoryMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_new",
      branch: "main",
      enabled: true,
      setupPhase: "live",
      repositoryIngestion: {
        orgId: "org_1",
        repositoryId: "repo_new",
        targetBranch: "main",
      },
    })

    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryName: "acme/ctxpipe-context",
          gitUrl: "https://github.com/acme/ctxpipe-context.git",
          githubConnectionId: "ghc_1",
          branch: "main",
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(enqueueIngestionMock).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        repositoryId: "repo_new",
        targetBranch: "main",
      },
      expect.objectContaining({ error: expect.any(Function) }),
    )
  })

  it("returns 404 when the repository does not belong to the org", async () => {
    bindRepositoryMock.mockRejectedValue(new SlackRepositoryNotFoundErrorMock())

    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId: "repo_missing" }),
      },
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Repository not found"),
    })
  })

  it("rejects binding a repository when Slack is not installed", async () => {
    resolveConnectionMock.mockResolvedValue({
      status: "ok",
      connection: { ...connection, status: "pending", botTokenEnc: null },
    })

    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId: "repo_1" }),
      },
    )

    expect(response.status).toBe(409)
    expect(bindRepositoryMock).not.toHaveBeenCalled()
  })
})
