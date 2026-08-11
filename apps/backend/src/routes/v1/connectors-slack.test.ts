import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const orgHasGithubMock = vi.hoisted(() => vi.fn())
const resolveConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const bindRepositoryMock = vi.hoisted(() => vi.fn())
const assertOAuthConfiguredMock = vi.hoisted(() => vi.fn())
const SlackRepositoryNotFoundErrorMock = vi.hoisted(
  () =>
    class SlackRepositoryNotFoundError extends Error {
      constructor() {
        super("Repository not found for organization")
      }
    },
)

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: orgHasGithubMock,
}))
vi.mock("../../models/slack-connector.js", () => ({
  bindSlackSyncTargetRepository: bindRepositoryMock,
  deleteSlackConnectionById: vi.fn(),
  getSlackSyncTargetWithRepoByConnectionId: getTargetMock,
  MULTIPLE_SLACK_CONNECTIONS_MESSAGE:
    "Multiple Slack connections for this organization; specify connectionId query parameter",
  resolveSlackConnectionForOrgDetailed: resolveConnectionMock,
  SlackRepositoryNotFoundError: SlackRepositoryNotFoundErrorMock,
  upsertSlackConnectionFromOAuth: vi.fn(),
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))
vi.mock("../../services/slack/client.js", () => ({
  assertSlackOAuthConfigured: assertOAuthConfiguredMock,
  exchangeSlackOAuthCode: vi.fn(),
  getSlackOAuthAuthorizeUrl: vi.fn(
    () => "https://slack.com/oauth/v2/authorize",
  ),
}))

import { slackConnectorRoutes } from "./connectors-slack.js"

const connection = {
  id: "con_1",
  orgId: "org_1",
  status: "installed",
  botTokenEnc: "encrypted-token",
  teamName: "Acme Workspace",
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
