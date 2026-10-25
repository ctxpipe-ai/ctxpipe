import { OpenAPIHono } from "@hono/zod-openapi"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { HttpResponse, http } from "msw"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"

const hostedForgeAppAri =
  "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43"
const foreignForgeAppAri =
  "ari:cloud:ecosystem::app/00000000-1111-2222-3333-444444444444"

// Atlassian signs each Forge call. The test signs with its own key and
// serves that key from the Forge JWKS URL.
let signingKey: CryptoKey
let publicJwk: JWK
useMswServer(
  http.get(
    "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json",
    () => HttpResponse.json({ keys: [publicJwk] }),
  ),
)
beforeAll(async () => {
  const pair = await generateKeyPair("RS256")
  signingKey = pair.privateKey
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** Claims of the next Forge call. Each test starts from valid claims. */
let fitClaims: Record<string, unknown>

function validFitClaims(): Record<string, unknown> {
  return {
    iss: "forge/invocation-token",
    aud: hostedForgeAppAri,
    app: {
      id: hostedForgeAppAri,
      installationId: fitInstallationAri,
      apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
      environment: {
        type: "PRODUCTION",
        id: "ari:cloud:ecosystem::environment/e1",
      },
    },
    context: { cloudId: "cloud_1" },
  }
}

async function bearer(claims: Record<string, unknown> = fitClaims) {
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey)
  return `Bearer ${token}`
}

function withApp(app: Record<string, unknown>): Record<string, unknown> {
  const base = validFitClaims()
  return { ...base, app: { ...(base.app as object), ...app } }
}

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

import { confluenceSyncSpace } from "../../../openworkflow/workflows/confluence-sync-space.js"
import { workspaceSourcesSync } from "../../../openworkflow/workflows/workspace-sources-sync.js"
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
    fitClaims = validFitClaims()
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
    const log = createLogger()
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
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
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  function lifecycleBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: fitInstallationIdBare,
      eventType: "avi:forge:installed:app",
      context: "ari:cloud:confluence::site/cloud_1",
      installerAccountId: "atl_installer_1",
      app: { id: hostedForgeAppAri, version: "1.0.0" },
      environment: { id: "env_1" },
      ...overrides,
    })
  }

  async function postLifecycle(
    app: OpenAPIHono<AppEnv>,
    body: string,
    authorization?: string,
  ) {
    return app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: authorization ?? (await bearer()),
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body,
    })
  }

  it("upserts the installation from the signed Forge claims", async () => {
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "fgi_1",
        cloudId: "cloud_1",
        installationId: fitInstallationIdBare,
        appId: hostedForgeAppAri,
        status: "installed",
        appSystemToken: "system_token",
        atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
      }),
    )
  })

  it("accepts a lifecycle payload id that is a full ecosystem ARI", async () => {
    const { app } = createApp()
    const res = await postLifecycle(
      app,
      lifecycleBody({ id: fitInstallationAri }),
    )
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: fitInstallationIdBare }),
    )
  })

  it("does not persist invalid FIT apiBaseUrl", async () => {
    fitClaims = withApp({
      apiBaseUrl: "http://api.atlassian.com/ex/confluence/cloud_1",
    })
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(204)
    const arg = upsertForgeInstallationFromEventMock.mock
      .calls[0]?.[0] as Record<string, unknown>
    expect(arg.atlassianApiBaseUrl).toBeUndefined()
  })

  it("falls back to pending installation matched by installer account id", async () => {
    fitClaims = {
      ...withApp({
        apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_pending",
      }),
      context: { cloudId: "cloud_pending" },
    }
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue(undefined)
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValueOnce({
      id: "fgi_pending_1",
      orgId: "org_pending",
      installedByUserId: "user_pending",
      appId: null,
    })

    const { app } = createApp()
    const res = await postLifecycle(
      app,
      lifecycleBody({
        context: "ari:cloud:confluence::site/cloud_pending",
        installerAccountId: "atl_account_1",
      }),
    )

    expect(res.status).toBe(204)
    expect(
      getPendingForgeInstallationByInstallerAccountIdMock,
    ).toHaveBeenCalledWith("atl_account_1")
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_pending",
        connectionId: "fgi_pending_1",
        cloudId: "cloud_pending",
        installationId: fitInstallationIdBare,
        appId: hostedForgeAppAri,
        atlassianApiBaseUrl:
          "https://api.atlassian.com/ex/confluence/cloud_pending",
      }),
    )
  })

  it("refuses another Forge app on a pending setup", async () => {
    fitClaims = {
      ...validFitClaims(),
      aud: foreignForgeAppAri,
      app: { ...(validFitClaims().app as object), id: foreignForgeAppAri },
    }
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue(undefined)
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValueOnce({
      id: "fgi_pending_1",
      orgId: "org_pending",
      installedByUserId: "user_pending",
      appId: null,
    })
    const { app } = createApp()
    const res = await postLifecycle(
      app,
      lifecycleBody({ app: { id: foreignForgeAppAri, version: "1.0.0" } }),
    )
    expect(res.status).toBe(401)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
  })

  it("accepts the Forge app that a self-hosted setup provisioned", async () => {
    fitClaims = {
      ...validFitClaims(),
      aud: foreignForgeAppAri,
      app: { ...(validFitClaims().app as object), id: foreignForgeAppAri },
    }
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue(undefined)
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValueOnce({
      id: "fgi_pending_1",
      orgId: "org_pending",
      installedByUserId: "user_pending",
      appId: "00000000-1111-2222-3333-444444444444",
    })
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: foreignForgeAppAri }),
    )
  })

  it("refuses the hosted Forge app on a setup that provisioned its own app", async () => {
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue({
      id: "fgi_1",
      orgId: "org_1",
      cloudId: "cloud_1",
      appId: foreignForgeAppAri,
    })
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(401)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
  })

  it("refuses the wrong issuer", async () => {
    const { app } = createApp()
    const res = await postLifecycle(
      app,
      lifecycleBody(),
      await bearer({ ...validFitClaims(), iss: "someone-else" }),
    )
    expect(res.status).toBe(401)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
  })

  it("refuses a non-production Forge environment in production", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production")
    fitClaims = withApp({
      environment: { type: "DEVELOPMENT", id: "env_dev" },
    })
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(401)
    expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
  })

  it("accepts a non-production Forge environment in a preview", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-1")
    fitClaims = withApp({
      environment: { type: "DEVELOPMENT", id: "env_dev" },
    })
    const { app } = createApp()
    const res = await postLifecycle(app, lifecycleBody())
    expect(res.status).toBe(204)
  })

  it.each([
    ["installation id", { id: "75969db9-dc7b-4798-9715-bd098ac0d9d1" }],
    ["site", { context: "ari:cloud:confluence::site/cloud_other" }],
  ])(
    "refuses a lifecycle payload whose %s differs from the signed claims",
    async (_field, overrides) => {
      const { app } = createApp()
      const res = await postLifecycle(app, lifecycleBody(overrides))
      expect(res.status).toBe(400)
      expect(upsertForgeInstallationFromEventMock).not.toHaveBeenCalled()
    },
  )

  it("returns 204 and enqueues workflow for Confluence page created", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
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
    expect(runWorkflowMock).toHaveBeenCalledWith(
      workspaceSourcesSync.spec,
      {
        kind: "connection",
        orgId: "org_1",
        connectionId: "fgi_1",
        provider: "confluence",
        event: {
          spaceKeys: ["SP"],
          pageId: "838205441",
          eventType: "avi:confluence:created:page",
        },
      },
      undefined,
    )
  })

  it("refuses a Confluence event from another Forge app", async () => {
    fitClaims = { ...validFitClaims(), aud: foreignForgeAppAri }
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:created:page",
        content: { id: "838205441", type: "page", space: { key: "SP" } },
      }),
    })
    expect(res.status).toBe(401)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("still enqueues the legacy sync when the handover lookup throws", async () => {
    // This test opens no database, so the handover lookup fails.
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:created:page",
        content: {
          id: "838205441",
          type: "page",
          space: { id: 827392002, key: "SP" },
        },
      }),
    })
    expect(res.status).toBe(204)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      confluenceSyncSpace.spec,
      expect.objectContaining({ spaceKey: "SP" }),
    )
  })

  it.each([
    "avi:confluence:created:attachment",
    "avi:confluence:updated:attachment",
    "avi:confluence:archived:attachment",
    "avi:confluence:unarchived:attachment",
    "avi:confluence:trashed:attachment",
    "avi:confluence:restored:attachment",
    "avi:confluence:deleted:attachment",
  ])("routes %s through its parent page", async (eventType) => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType,
        eventCreatedDate: "2021-01-20T06:29:21.907Z",
        attachment: {
          id: "838205455",
          type: "attachment",
          status: "current",
          title: "logo.png",
          space: { id: 827392002, key: "SP" },
          container: {
            id: "838205441",
            type: "page",
            space: { id: 827392002, key: "SP" },
          },
        },
      }),
    })

    expect(res.status).toBe(204)
    expect(runWorkflowMock).toHaveBeenCalledWith(confluenceSyncSpace.spec, {
      orgId: "org_1",
      connectionId: "fgi_1",
      spaceKey: "SP",
      pageId: "838205441",
      eventType,
    })
  })

  it("rejects a malformed supported Confluence payload", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:created:attachment",
        attachment: "not-an-attachment",
      }),
    })

    expect(res.status).toBe(400)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("fully reconciles both spaces when a page moves across spaces", async () => {
    loadConfluenceScopeFromRepoMock.mockResolvedValue({
      spaces: [
        { spaceKey: "NEW", selectedPageIds: null },
        { spaceKey: "OLD", selectedPageIds: null },
      ],
    })
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:confluence:moved:page",
        eventCreatedDate: "2021-01-20T06:29:21.907Z",
        content: {
          id: "838205441",
          type: "page",
          space: { id: 2, key: "NEW" },
        },
        prevContent: {
          id: "838205441",
          type: "page",
          space: { id: 1, key: "OLD" },
        },
      }),
    })

    expect(res.status).toBe(204)
    expect(runWorkflowMock).toHaveBeenCalledTimes(3)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      workspaceSourcesSync.spec,
      expect.objectContaining({
        event: {
          spaceKeys: ["NEW", "OLD"],
          pageId: undefined,
          eventType: "avi:confluence:moved:page",
        },
      }),
      undefined,
    )
    expect(runWorkflowMock).toHaveBeenCalledWith(confluenceSyncSpace.spec, {
      orgId: "org_1",
      connectionId: "fgi_1",
      spaceKey: "NEW",
      pageId: undefined,
      eventType: "avi:confluence:moved:page",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(confluenceSyncSpace.spec, {
      orgId: "org_1",
      connectionId: "fgi_1",
      spaceKey: "OLD",
      pageId: undefined,
      eventType: "avi:confluence:moved:page",
    })
  })

  it("returns 204 for Confluence space updated without upserting installation", async () => {
    const { app } = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
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
    const warn = vi.spyOn(log, "warn")
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: await bearer(),
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
    expect(warn).toHaveBeenCalledWith("unhandled_forge_event_type", {
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
    fitClaims = validFitClaims()
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue({
      id: "fgi_1",
      orgId: "org_1",
      cloudId: "cloud_1",
      appId: null,
    })
    updateForgeAppSystemTokenByInstallationIdMock.mockResolvedValue(true)
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", createLogger())
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
        headers: { authorization: await bearer() },
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when installation id in FIT is missing or invalid", async () => {
    fitClaims = withApp({ installationId: undefined })
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-forge-oauth-system": "system_token",
        },
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 202 when no installed row matches", async () => {
    getForgeInstallationByForgeInstallationIdMock.mockResolvedValue(undefined)
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
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
          authorization: await bearer(),
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

  it("refuses another Forge app", async () => {
    fitClaims = { ...validFitClaims(), aud: foreignForgeAppAri }
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-forge-oauth-system": "new_system_token",
        },
      },
    )
    expect(res.status).toBe(401)
    expect(updateForgeAppSystemTokenByInstallationIdMock).not.toHaveBeenCalled()
  })

  it("omits atlassianApiBaseUrl when FIT apiBaseUrl is invalid", async () => {
    fitClaims = withApp({
      apiBaseUrl: "http://api.atlassian.com/ex/confluence/cloud_1",
    })
    const app = createApp()
    const res = await app.request(
      "/api/v1/webhook/atlassian/forge/token-refresh",
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
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
