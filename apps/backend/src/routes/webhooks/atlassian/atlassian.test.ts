import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"

const jwtVerifyMock = vi.hoisted(() => vi.fn())
const createRemoteJwkSetMock = vi.hoisted(() => vi.fn())

vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: createRemoteJwkSetMock,
}))

const getForgeInstallationByForgeInstallationIdMock = vi.hoisted(() => vi.fn())
const getPendingForgeInstallationByInstallerAccountIdMock = vi.hoisted(() =>
  vi.fn(),
)
const upsertForgeInstallationFromEventMock = vi.hoisted(() => vi.fn())
const updateForgeAppSystemTokenByInstallationIdMock = vi.hoisted(() => vi.fn())
const getConfluenceSyncTargetByConnectionIdMock = vi.hoisted(() => vi.fn())
const getConfluenceSyncTargetWithRepoByConnectionIdMock = vi.hoisted(() =>
  vi.fn(),
)
const loadConfluenceScopeFromRepoMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../../models/atlassian-connector.js", () => ({
  getForgeInstallationByForgeInstallationId:
    getForgeInstallationByForgeInstallationIdMock,
  getPendingForgeInstallationByInstallerAccountId:
    getPendingForgeInstallationByInstallerAccountIdMock,
  upsertForgeInstallationFromEvent: upsertForgeInstallationFromEventMock,
  updateForgeAppSystemTokenByInstallationId:
    updateForgeAppSystemTokenByInstallationIdMock,
}))

vi.mock("../../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetByConnectionId:
    getConfluenceSyncTargetByConnectionIdMock,
  getConfluenceSyncTargetWithRepoByConnectionId:
    getConfluenceSyncTargetWithRepoByConnectionIdMock,
}))

vi.mock("../../../services/confluence/config-from-repo.js", () => ({
  loadConfluenceScopeFromRepo: loadConfluenceScopeFromRepoMock,
}))

vi.mock("../../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
  runWorkflowWithWorkerWake: (...args: unknown[]) => runWorkflowMock(...args),
}))

import { confluenceSyncSpace } from "../../../openworkflow/confluence-sync-space.js"
import type {
  ForgeInvocationTokenApp,
  ForgeInvocationTokenPayload,
} from "./atlassian.js"
import {
  parseInstallationIdFromFitPayload,
  registerAtlassianWebhookRoute,
} from "./atlassian.js"

const fitInstallationIdBare = "4ce198e3-2ce7-4a6e-865f-a3e31d15fe43"
const fitInstallationAri = `ari:cloud:ecosystem::installation/${fitInstallationIdBare}`

function fitWithApp(
  overrides: Partial<ForgeInvocationTokenApp> = {},
): ForgeInvocationTokenPayload {
  const app: ForgeInvocationTokenApp = {
    installationId: fitInstallationAri,
    apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
    id: "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43",
    appVersion: "1.0.0",
    environment: {
      type: "DEVELOPMENT",
      id: "ari:cloud:ecosystem::environment/e1",
    },
    module: { type: "core:endpoint", key: "ctxpipe-remote" },
    installation: {
      id: fitInstallationAri,
      contexts: [
        {
          name: "confluence",
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
        },
      ],
    },
    ...overrides,
  }
  return { app }
}

describe("parseInstallationIdFromFitPayload", () => {
  it("strips ari:cloud:ecosystem::installation/ prefix and trims", () => {
    expect(
      parseInstallationIdFromFitPayload(
        fitWithApp({
          installationId: `  ${fitInstallationAri}  `,
        }),
      ),
    ).toBe(fitInstallationIdBare)
  })

  it("returns bare id when already without ARI prefix", () => {
    expect(
      parseInstallationIdFromFitPayload(
        fitWithApp({ installationId: `  ${fitInstallationIdBare}  ` }),
      ),
    ).toBe(fitInstallationIdBare)
  })

  it("returns empty string when ARI has no id after prefix", () => {
    expect(
      parseInstallationIdFromFitPayload(
        fitWithApp({
          installationId: "ari:cloud:ecosystem::installation/",
        }),
      ),
    ).toBe("")
  })

  it("returns undefined when installation id is empty; empty string after strip for whitespace-only", () => {
    expect(
      parseInstallationIdFromFitPayload(fitWithApp({ installationId: "" })),
    ).toBeUndefined()
    expect(
      parseInstallationIdFromFitPayload(fitWithApp({ installationId: "   " })),
    ).toBe("")
  })

  it("returns undefined when installation id is absent", () => {
    const app = { ...fitWithApp().app } as Record<string, unknown>
    delete app.installationId
    expect(
      parseInstallationIdFromFitPayload({
        app: app as unknown as ForgeInvocationTokenApp,
      } as ForgeInvocationTokenPayload),
    ).toBeUndefined()
  })
})

describe("POST /api/v1/webhook/atlassian/forge", () => {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
  } as Record<string, string | undefined>)

  beforeEach(() => {
    vi.clearAllMocks()
    createRemoteJwkSetMock.mockReturnValue({})
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "forge-event",
        app: {
          installationId: fitInstallationAri,
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    getForgeInstallationByForgeInstallationIdMock.mockImplementation(
      (installationId: string) => {
        const bare = installationId.replace(
          /^ari:cloud:ecosystem::installation\//,
          "",
        )
        if (
          bare === "installation_1" ||
          bare === "75969db9-dc7b-4798-9715-bd098ac0d9d1" ||
          bare === fitInstallationIdBare
        ) {
          return Promise.resolve({
            id: "fgi_1",
            orgId: "org_1",
            cloudId: "cloud_1",
            installedByUserId: "user_1",
          })
        }
        return Promise.resolve(undefined)
      },
    )
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValue(
      undefined,
    )
    upsertForgeInstallationFromEventMock.mockResolvedValue({
      id: "fgi_1",
      orgId: "org_1",
    })
    updateForgeAppSystemTokenByInstallationIdMock.mockResolvedValue(true)
    getConfluenceSyncTargetByConnectionIdMock.mockResolvedValue({
      id: "cst_1",
      orgId: "org_1",
      connectionId: "fgi_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    getConfluenceSyncTargetWithRepoByConnectionIdMock.mockResolvedValue({
      enabled: true,
      setupPhase: "live",
      githubConnectionId: "ghc_1",
      repositoryName: "acme/docs",
      branch: "main",
    })
    loadConfluenceScopeFromRepoMock.mockResolvedValue({
      spaces: [{ spaceKey: "SP", selectedPageIds: null }],
    })
    runWorkflowMock.mockResolvedValue({ status: "completed" })
  })

  function createApp() {
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as AppEnv["Variables"]["log"]
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", log)
      await next()
    })
    registerAtlassianWebhookRoute(app)
    return { app, log }
  }

  it("returns 401 when invocation token is missing", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("returns 401 when invocation token verification fails", async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error("invalid"))
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("returns 400 when eventType is missing", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("upserts forge installation for known cloud id", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "installation_1",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_1",
        installerAccountId: "atl_installer_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "fgi_1",
        cloudId: "cloud_1",
        installationId: "installation_1",
        appId: "forge_app_1",
        status: "installed",
        appSystemToken: "system_token",
        atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
      }),
    )
  })

  it("stores bare installation id when lifecycle payload id is a full ecosystem ARI", async () => {
    const bare = "75969db9-dc7b-4798-9715-bd098ac0d9d1"
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: bare,
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_1",
        installerAccountId: "atl_installer_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "fgi_1",
        installationId: bare,
      }),
    )
  })

  it("does not persist invalid FIT apiBaseUrl", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-event",
        app: {
          apiBaseUrl: "http://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "installation_1",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_1",
        installerAccountId: "atl_installer_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })
    expect(res.status).toBe(204)
    const arg = upsertForgeInstallationFromEventMock.mock
      .calls[0]?.[0] as Record<string, unknown>
    expect(arg.atlassianApiBaseUrl).toBeUndefined()
  })

  it("falls back to pending installation matched by installer account id", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-event",
        app: {
          installationId: fitInstallationAri,
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_pending",
        },
      },
    })
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue(undefined)
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValueOnce({
      id: "fgi_pending_1",
      orgId: "org_pending",
      installedByUserId: "user_pending",
    })

    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "installation_pending",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_pending",
        installerAccountId: "atl_account_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })

    expect(res.status).toBe(204)
    expect(
      getPendingForgeInstallationByInstallerAccountIdMock,
    ).toHaveBeenCalledWith("atl_account_1")
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_pending",
        connectionId: "fgi_pending_1",
        cloudId: "cloud_pending",
        installationId: "installation_pending",
        appId: "forge_app_1",
        atlassianApiBaseUrl:
          "https://api.atlassian.com/ex/confluence/cloud_pending",
      }),
    )
  })

  it("returns 204 and enqueues workflow for Confluence page created", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:created:page",
        eventCreatedDate: "2021-01-20T06:29:21.907Z",
        content: {
          id: "838205441",
          type: "page",
          status: "current",
          title: "A page",
          space: {
            id: 827392002,
            key: "SP",
            alias: "SP",
            name: "Project",
            type: "global",
            status: "current",
          },
        },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).toHaveBeenCalledWith(confluenceSyncSpace.spec, {
      orgId: "org_1",
      connectionId: "fgi_1",
      spaceKey: "SP",
      pageId: "838205441",
      eventType: "avi:confluence:created:page",
    })
  })

  it("returns 204 for Confluence space updated without upserting installation", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:updated:space:V2",
        eventCreatedDate: "2021-01-20T06:29:21.907Z",
        space: {
          id: 827392002,
          key: "SP",
          alias: "SP",
          name: "Project: Sample",
          type: "global",
          status: "current",
        },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).toHaveBeenCalledWith(confluenceSyncSpace.spec, {
      orgId: "org_1",
      connectionId: "fgi_1",
      spaceKey: "SP",
      pageId: undefined,
      eventType: "avi:confluence:updated:space:V2",
    })
  })

  it("returns 501 and warns for unknown event type without upserting", async () => {
    const { app, log } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:viewed:page",
        eventCreatedDate: "2021-01-20T06:29:21.907Z",
      }),
    })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string; eventType: string }
    expect(body.error).toBe("Unhandled event type")
    expect(body.eventType).toBe("avi:confluence:viewed:page")
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith("unhandled_forge_event_type", {
      eventType: "avi:confluence:viewed:page",
    })
  })
})

describe("POST /api/v1/webhook/atlassian/forge/token-refresh", () => {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
  } as Record<string, string | undefined>)

  beforeEach(() => {
    vi.clearAllMocks()
    createRemoteJwkSetMock.mockReturnValue({})
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "forge-scheduled",
        app: {
          installationId: fitInstallationAri,
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    updateForgeAppSystemTokenByInstallationIdMock.mockResolvedValue(true)
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AppEnv["Variables"]["log"])
      await next()
    })
    registerAtlassianWebhookRoute(app)
    return app
  }

  it("returns 401 when invocation token is missing", async () => {
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      { method: "POST" },
    )
    expect(res.status).toBe(401)
  })

  it("returns 401 when invocation token verification fails", async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error("invalid"))
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "x-forge-oauth-system": "system_token",
        },
      },
    )
    expect(res.status).toBe(401)
  })

  it("returns 400 when system token header is missing", async () => {
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: { authorization: "Bearer fit_token" },
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when installation id in FIT is missing or invalid", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-scheduled",
        app: { apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1" },
      },
    })
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: "Bearer fit_token",
          "x-forge-oauth-system": "system_token",
        },
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 202 when no installed row matches", async () => {
    updateForgeAppSystemTokenByInstallationIdMock.mockResolvedValueOnce(false)
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: "Bearer fit_token",
          "x-forge-oauth-system": "new_system_token",
        },
      },
    )
    expect(res.status).toBe(202)
  })

  it("returns 204 and updates token when installation matches", async () => {
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: "Bearer fit_token",
          "x-forge-oauth-system": "new_system_token",
        },
      },
    )
    expect(res.status).toBe(204)
    expect(updateForgeAppSystemTokenByInstallationIdMock).toHaveBeenCalledWith({
      installationId: fitInstallationIdBare,
      appSystemToken: "new_system_token",
      atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
    })
  })

  it("omits atlassianApiBaseUrl when FIT apiBaseUrl is invalid", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-scheduled",
        app: {
          installationId: fitInstallationAri,
          apiBaseUrl: "http://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: "Bearer fit_token",
          "x-forge-oauth-system": "tok",
        },
      },
    )
    expect(res.status).toBe(204)
    expect(updateForgeAppSystemTokenByInstallationIdMock).toHaveBeenCalledWith({
      installationId: fitInstallationIdBare,
      appSystemToken: "tok",
    })
  })
})
