import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import { parseNotionConnectionConfig } from "../../lib/connection-config.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

const getNotionStoredConfigByConnectionIdMock = vi.hoisted(() => vi.fn())
const createDraftNotionConnectionMock = vi.hoisted(() => vi.fn())
const patchNotionOauthAppMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/notion-connector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/notion-connector.js")>()
  return {
    ...actual,
    getNotionStoredConfigByConnectionId:
      getNotionStoredConfigByConnectionIdMock,
    createDraftNotionConnection: createDraftNotionConnectionMock,
    patchNotionOauthApp: patchNotionOauthAppMock,
  }
})

vi.mock("../../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/client.js")>()
  return {
    ...actual,
    withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
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
  notionOauthAppReadRoutes,
} from "./connectors-notion.js"

const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
  AUTH_BASE_URL: "https://app.test",
} as AppEnv["Variables"]["env"]

function mountApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    c.set("env", env)
    await next()
  })
  app.route("/connectors/notion", notionOauthAppReadRoutes)
  app.route("/connectors/notion", notionConnectorRoutes)
  return app
}

describe("GET /connectors/notion/oauth-app", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getNotionStoredConfigByConnectionIdMock.mockReset()
  })

  it("returns metadata without any secret fields", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "client-id-one",
        oauthClientSecretEnc: encryptConnectionSecret(
          "super-secret-value",
          env,
        ),
      }),
    )

    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.oauthAppSaved).toBe(true)
    expect(body.oauthConfigured).toBe(true)
    expect(body.oauthClientId).toBe("client-id-one")
    expect(body.globalNotionOAuthConfigured).toBe(false)
    expect(body.callbackUrl).toBe(
      "https://app.test/api/v1/connectors/notion/oauth/callback",
    )
    expect(String(body.webhookUrl)).toContain("connectionId=con_1")
    expect(String(body.webhookUrl)).toContain("provisioningToken=")
    expect(JSON.stringify(body)).not.toContain("super-secret-value")
    expect(body.webhookVerificationToken).toBeNull()
    expect("oauthClientSecretEnc" in body).toBe(false)
    expect("clientSecret" in body).toBe(false)
  })

  it("returns the row webhook verification token and still omits the client secret", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "client-id-one",
        oauthClientSecretEnc: encryptConnectionSecret(
          "super-secret-value",
          env,
        ),
        webhookSecretEnc: encryptConnectionSecret(
          "secret_notion-verify-token",
          env,
        ),
      }),
    )

    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.webhookConfigured).toBe(true)
    expect(body.webhookVerificationToken).toBe("secret_notion-verify-token")
    expect(JSON.stringify(body)).not.toContain("super-secret-value")
    expect("clientSecret" in body).toBe(false)
  })

  it("does not return env NOTION_WEBHOOK_SECRET as webhookVerificationToken", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "client-id-one",
        oauthClientSecretEnc: encryptConnectionSecret(
          "super-secret-value",
          env,
        ),
      }),
    )
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
      c.set("orgId", "org_1")
      c.set("orgSlug", "acme")
      c.set("env", {
        ...env,
        NOTION_WEBHOOK_SECRET: "env-only-webhook-secret",
      })
      await next()
    })
    app.route("/connectors/notion", notionOauthAppReadRoutes)
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.webhookConfigured).toBe(true)
    expect(body.webhookVerificationToken).toBeNull()
    expect(JSON.stringify(body)).not.toContain("env-only-webhook-secret")
  })

  it("returns 404 when the connection is missing", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(undefined)
    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=missing",
    )
    expect(res.status).toBe(404)
  })
})

describe("PUT /connectors/notion/oauth-app", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    patchNotionOauthAppMock.mockResolvedValue(true)
  })

  it("returns 400 when first save omits clientSecret", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({ setupPhase: "draft" }),
    )
    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "new-id" }),
      },
    )
    expect(res.status).toBe(400)
    expect(patchNotionOauthAppMock).not.toHaveBeenCalled()
  })

  it("returns 204 on first save with clientSecret", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({ setupPhase: "draft" }),
    )
    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "cid1", clientSecret: "sec1" }),
      },
    )
    expect(res.status).toBe(204)
    expect(patchNotionOauthAppMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      env,
      clientId: "cid1",
      clientSecret: "sec1",
    })
  })

  it("returns 204 and omits secret from patch when rotating is skipped", async () => {
    getNotionStoredConfigByConnectionIdMock.mockResolvedValue(
      parseNotionConnectionConfig({
        oauthClientId: "old-cid",
        oauthClientSecretEnc: encryptConnectionSecret("old-secret", env),
      }),
    )
    const app = mountApp()
    const res = await app.request(
      "/connectors/notion/oauth-app?connectionId=con_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "updated-cid" }),
      },
    )
    expect(res.status).toBe(204)
    expect(patchNotionOauthAppMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      env,
      clientId: "updated-cid",
      clientSecret: undefined,
    })
  })
})

describe("POST /connectors/notion/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createDraftNotionConnectionMock.mockResolvedValue({
      id: "con_draft",
      orgId: "org_1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
  })

  it("returns draft metadata only", async () => {
    const app = mountApp()
    const res = await app.request("/connectors/notion/draft", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "con_draft",
      orgId: "org_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
  })
})
