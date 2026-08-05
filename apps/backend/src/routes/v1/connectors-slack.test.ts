import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const orgHasGithubMock = vi.hoisted(() => vi.fn())
const resolveConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const listChannelsMock = vi.hoisted(() => vi.fn())
const patchConfigMock = vi.hoisted(() => vi.fn())
const claimConfigPrMock = vi.hoisted(() => vi.fn())
const releaseConfigPrMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())
const assertOAuthConfiguredMock = vi.hoisted(() => vi.fn())

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: orgHasGithubMock,
}))
vi.mock("../../models/slack-connector.js", () => ({
  claimSlackConfigPrCreation: claimConfigPrMock,
  deleteSlackConnectionById: vi.fn(),
  getSlackSyncTargetWithRepoByConnectionId: getTargetMock,
  listSlackChannelsByConnectionId: listChannelsMock,
  MULTIPLE_SLACK_CONNECTIONS_MESSAGE:
    "Multiple Slack connections for this organization; specify connectionId query parameter",
  patchSlackConnectorConfig: patchConfigMock,
  releaseSlackConfigPrCreationClaim: releaseConfigPrMock,
  resolveSlackConnectionForOrgDetailed: resolveConnectionMock,
  upsertSlackConnectionFromOAuth: vi.fn(),
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}))
vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))
vi.mock("../../openworkflow/workflows/slack-sync-config.js", () => ({
  slackSyncConfig: { spec: { name: "slack-sync-config" } },
}))
vi.mock("../../services/slack/client.js", () => ({
  assertSlackOAuthConfigured: assertOAuthConfiguredMock,
  exchangeSlackOAuthCode: vi.fn(),
  getSlackOAuthAuthorizeUrl: vi.fn(
    () => "https://slack.com/oauth/v2/authorize",
  ),
  listSlackChannelsForBot: vi.fn(),
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
    listChannelsMock.mockResolvedValue([
      {
        channelId: "C1",
        name: "engineering",
        isPrivate: false,
      },
    ])
    getTargetMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "ghc_1",
      branch: "main",
      enabled: true,
      setupPhase: "awaiting_merge",
      pendingConfigPullUrl: "https://github.com/acme/context/pull/1",
      pendingConfigPrCreating: false,
      oldestDays: 90,
    })
    patchConfigMock.mockResolvedValue({
      channels: [{ channelId: "C1" }],
      repositoryIngestion: null,
    })
    claimConfigPrMock.mockResolvedValue(undefined)
    releaseConfigPrMock.mockResolvedValue(undefined)
    runWorkflowMock.mockResolvedValue(undefined)
  })

  it("returns phase-aware status for an installed connection", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/status?connectionId=con_1",
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      isInstalled: true,
      isGithubLinked: true,
      selectedChannelCount: 1,
      setupPhase: "awaiting_merge",
      pendingConfigPullUrl: "https://github.com/acme/context/pull/1",
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

  it("claims and enqueues a config PR after saving configuration", async () => {
    const response = await testApp().request(
      "/acme/api/v1/connectors/slack/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channels: [
            {
              channelId: "C1",
              name: "engineering",
              isPrivate: false,
            },
          ],
          syncTarget: {
            repositoryId: "repo_1",
            branch: "main",
            enabled: true,
            oldestDays: 90,
          },
        }),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      savedCount: 1,
      configPrEnqueued: true,
      workflowName: "slack-sync-config",
    })
    expect(claimConfigPrMock).toHaveBeenCalledWith({
      connectionId: "con_1",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "slack-sync-config" },
      {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_1",
      },
    )
  })
})
