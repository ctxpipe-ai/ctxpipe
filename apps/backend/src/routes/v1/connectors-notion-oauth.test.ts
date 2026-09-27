import { createHmac } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import { parseNotionConnectionConfig } from "../../lib/connection-config.js"

const getNotionStoredConfigByConnectionIdMock = vi.hoisted(() => vi.fn())
const upsertNotionConnectionFromOAuthMock = vi.hoisted(() => vi.fn())
const exchangeNotionOAuthCodeMock = vi.hoisted(() => vi.fn())
const getNotionOAuthAuthorizeUrlMock = vi.hoisted(() => vi.fn())
const memberRows = vi.hoisted<{ value: unknown[] }>(() => ({ value: [] }))

vi.mock("../../models/notion-connector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/notion-connector.js")>()
  return {
    ...actual,
    getNotionStoredConfigByConnectionId:
      getNotionStoredConfigByConnectionIdMock,
    upsertNotionConnectionFromOAuth: upsertNotionConnectionFromOAuthMock,
  }
})

vi.mock("../../services/notion/client.js", () => ({
  exchangeNotionOAuthCode: (...args: unknown[]) =>
    exchangeNotionOAuthCodeMock(...args),
  getNotionOAuthAuthorizeUrl: (...args: unknown[]) =>
    getNotionOAuthAuthorizeUrlMock(...args),
  refreshNotionOAuthToken: vi.fn(),
  searchNotionResources: vi.fn(),
}))

vi.mock("../../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/client.js")>()
  return {
    ...actual,
    withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
    getSystemDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(memberRows.value),
          }),
        }),
      }),
    }),
  }
})

vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: vi.fn(),
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  getPullRequestHeadBranch: vi.fn(),
}))

vi.mock("../../services/notion/config-from-repo.js", () => ({
  loadNotionScopeFromRepo: vi.fn(),
  NOTION_CONFIG_PATH: "notion/config.yaml",
}))

vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))

vi.mock("../../openworkflow/workflows/notion-sync-config.js", () => ({
  notionSyncConfig: { spec: { name: "notion-sync-config" } },
}))

vi.mock("../../openworkflow/workflows/notion-sync-content.js", () => ({
  notionSyncContent: { spec: { name: "notion-sync-content" } },
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}))

import {
  notionConnectorRoutes,
  notionOAuthCallbackRoutes,
} from "./connectors-notion.js"

const AUTH_SECRET = "test-secret-at-least-32-characters-long-xx"

function makeState(input: {
  orgId?: string
  userId?: string
  orgSlug?: string
  ts?: number
  connectionId?: string
  secret?: string
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      orgId: input.orgId ?? "org_1",
      userId: input.userId ?? "user_1",
      orgSlug: input.orgSlug ?? "acme",
      ts: input.ts ?? Date.now(),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    }),
    "utf8",
  ).toString("base64url")
  const signature = createHmac("sha256", input.secret ?? AUTH_SECRET)
    .update(payload)
    .digest("base64url")
  return `${payload}.${signature}`
}

function startApp(envOverrides: Record<string, string | undefined> = {}) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    c.set("env", {
      AUTH_SECRET,
      AUTH_BASE_URL: "https://app.test",
      ...envOverrides,
    } as AppEnv["Variables"]["env"])
    await next()
  })
  app.route("/:orgSlug/api/v1/connectors/notion", notionConnectorRoutes)
  return app
}

function callbackApp(envOverrides: Record<string, string | undefined> = {}) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("env", {
      AUTH_SECRET,
      AUTH_BASE_URL: "https://app.test",
      ...envOverrides,
    } as AppEnv["Variables"]["env"])
    await next()
  })
  app.route("/", notionOAuthCallbackRoutes)
  return app
}

describe("GET /oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(undefined)
    getNotionOAuthAuthorizeUrlMock.mockReturnValue(
      "https://api.notion.com/v1/oauth/authorize?client_id=x",
    )
  })

  it("returns 400 when connectionId is missing", async () => {
    const res = await startApp().request(
      "/acme/api/v1/connectors/notion/oauth/start",
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 when the targeted connection is missing", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(undefined)
    const res = await startApp().request(
      "/acme/api/v1/connectors/notion/oauth/start?connectionId=con_missing",
    )
    expect(res.status).toBe(404)
    expect(getNotionOAuthAuthorizeUrlMock).not.toHaveBeenCalled()
  })

  it("returns 503 when neither row nor env is configured", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({ setupPhase: "draft" }),
    )
    const res = await startApp().request(
      "/acme/api/v1/connectors/notion/oauth/start?connectionId=con_1",
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      code: "notion_oauth_not_configured",
    })
  })

  it("returns 200 with env-only credentials", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({ setupPhase: "draft" }),
    )
    const res = await startApp({
      NOTION_CLIENT_ID: "env-id",
      NOTION_CLIENT_SECRET: "env-secret",
    }).request("/acme/api/v1/connectors/notion/oauth/start?connectionId=con_1")
    expect(res.status).toBe(200)
    expect(getNotionOAuthAuthorizeUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "env-id" }),
    )
  })

  it("returns 200 with row-only credentials and rounds connectionId through state", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "row-id",
        oauthClientSecretEnc: encryptConnectionSecret("row-secret", {
          AUTH_SECRET,
        } as AppEnv["Variables"]["env"]),
      }),
    )
    const res = await startApp().request(
      "/acme/api/v1/connectors/notion/oauth/start?connectionId=con_1",
    )
    expect(res.status).toBe(200)
    expect(getNotionOAuthAuthorizeUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "row-id" }),
    )
    const state = getNotionOAuthAuthorizeUrlMock.mock.calls[0]?.[0]?.state as
      | string
      | undefined
    expect(state).toBeTruthy()
    const payload = JSON.parse(
      Buffer.from(state?.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { connectionId?: string }
    expect(payload.connectionId).toBe("con_1")
  })
})

describe("GET /oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memberRows.value = [{ id: "mem_1" }]
    upsertNotionConnectionFromOAuthMock.mockResolvedValue({ id: "con_1" })
    exchangeNotionOAuthCodeMock.mockResolvedValue({
      access_token: "tok",
      bot_id: "bot_1",
    })
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "row-id",
        oauthClientSecretEnc: encryptConnectionSecret("row-secret", {
          AUTH_SECRET,
        } as AppEnv["Variables"]["env"]),
      }),
    )
  })

  it("rejects expired state", async () => {
    const state = makeState({ ts: Date.now() - 11 * 60 * 1000 })
    const res = await callbackApp().request(
      `/oauth/callback?code=abc&state=${state}`,
    )
    expect(res.status).toBe(400)
    expect(upsertNotionConnectionFromOAuthMock).not.toHaveBeenCalled()
  })

  it("rejects a user who is not a member of the state org", async () => {
    memberRows.value = []
    const state = makeState({ connectionId: "con_1" })
    const res = await callbackApp().request(
      `/oauth/callback?code=abc&state=${state}`,
    )
    expect(res.status).toBe(403)
  })

  it("exchanges the code with row credentials and passes connectionId", async () => {
    const state = makeState({ connectionId: "con_1" })
    const res = await callbackApp().request(
      `/oauth/callback?code=abc&state=${state}`,
    )
    expect(res.status).toBe(200)
    expect(exchangeNotionOAuthCodeMock).toHaveBeenCalledWith({
      clientId: "row-id",
      clientSecret: "row-secret",
      code: "abc",
      redirectUri: "https://app.test/api/v1/connectors/notion/oauth/callback",
    })
    expect(upsertNotionConnectionFromOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "con_1",
        botId: "bot_1",
      }),
    )
  })

  it("rejects a missing targeted connection before exchanging the code", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(undefined)
    const state = makeState({ connectionId: "con_gone" })
    const res = await callbackApp({
      NOTION_CLIENT_ID: "env-id",
      NOTION_CLIENT_SECRET: "env-secret",
    }).request(`/oauth/callback?code=abc&state=${state}`)
    expect(res.status).toBe(404)
    expect(exchangeNotionOAuthCodeMock).not.toHaveBeenCalled()
    expect(upsertNotionConnectionFromOAuthMock).not.toHaveBeenCalled()
  })
})
