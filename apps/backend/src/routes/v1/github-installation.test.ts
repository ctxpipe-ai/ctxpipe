import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

const runWorkflowMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
  runWorkflowWithWorkerWake: (...args: unknown[]) => runWorkflowMock(...args),
}))

const countRepositoriesForGithubConnectionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(0),
)
const pruneGithubConnectionRepositoriesNotInGitUrlsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)

vi.mock("../../models/repositories.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/repositories.js")>()
  return {
    ...actual,
    countRepositoriesForGithubConnection:
      countRepositoriesForGithubConnectionMock,
    pruneGithubConnectionRepositoriesNotInGitUrls:
      pruneGithubConnectionRepositoriesNotInGitUrlsMock,
  }
})

const upsertInstallationMock = vi.hoisted(() => vi.fn())
const registerInstallationOnConnectionMock = vi.hoisted(() => vi.fn())
const createDraftGithubConnectionMock = vi.hoisted(() => vi.fn())
const createPlaceholderGithubConnectionMock = vi.hoisted(() => vi.fn())
const completeGithubDraftCredentialsMock = vi.hoisted(() => vi.fn())
const listGithubConnectionRowsForOrgMock = vi.hoisted(() => vi.fn())
const getGithubConnectionRowMock = vi.hoisted(() => vi.fn())
const refreshGithubConnectionAccountSlugMock = vi.hoisted(() => vi.fn())
const getGithubUserAccessTokenMock = vi.hoisted(() => vi.fn())
const userCanAccessInstallationMock = vi.hoisted(() => vi.fn())
const getOrganizationSlugForInstallationByUserMock = vi.hoisted(() => vi.fn())
const resolveGithubInstallationForOrgDetailedMock = vi.hoisted(() => vi.fn())
const deleteGithubConnectionByIdMock = vi.hoisted(() => vi.fn())
const listReposForInstallationMock = vi.hoisted(() => vi.fn())
const searchReposForInstallationMock = vi.hoisted(() => vi.fn())
const updateInstallationOptionsMock = vi.hoisted(() => vi.fn())

const githubRowHasAppCredentialsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/connection-rows.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/connection-rows.js")>()
  return {
    ...actual,
    githubRowHasAppCredentials: githubRowHasAppCredentialsMock,
  }
})

vi.mock("../../models/github-installation.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    upsertInstallation: upsertInstallationMock,
    registerInstallationOnConnection: registerInstallationOnConnectionMock,
    createDraftGithubConnection: createDraftGithubConnectionMock,
    createPlaceholderGithubConnection: createPlaceholderGithubConnectionMock,
    completeGithubDraftCredentials: completeGithubDraftCredentialsMock,
    listGithubConnectionRowsForOrg: listGithubConnectionRowsForOrgMock,
    getGithubConnectionRow: getGithubConnectionRowMock,
    refreshGithubConnectionAccountSlug: refreshGithubConnectionAccountSlugMock,
    getGithubUserAccessToken: getGithubUserAccessTokenMock,
    userCanAccessInstallation: userCanAccessInstallationMock,
    getOrganizationSlugForInstallationByUser:
      getOrganizationSlugForInstallationByUserMock,
    resolveGithubInstallationForOrgDetailed:
      resolveGithubInstallationForOrgDetailedMock,
    deleteGithubConnectionById: deleteGithubConnectionByIdMock,
    listReposForInstallation: listReposForInstallationMock,
    searchReposForInstallation: searchReposForInstallationMock,
    updateInstallationOptions: updateInstallationOptionsMock,
  }
})

import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import type { Env } from "../../config/env.js"
import { syncGithubRepositories } from "../../openworkflow/workflows/sync-github-repositories.js"
import { githubInstallationRoutes } from "./github-installation.js"
import { meGithubInstallationsRoutes } from "./me-github-installations.js"

const installationFixture = {
  id: "con_github",
  installationId: 123,
  orgId: "org_1",
  accountSlug: "acme",
  appSlug: null,
  ingestAllRepositories: false,
  includeFutureRepos: false,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
}

const baseTestEnv = {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe", // pragma: allowlist secret
  AUTH_SECRET: "01234567890123456789012345678901",
  GRAPH_DB_URI: "redis://localhost:6379", // pragma: allowlist secret
} as const

const testEnv = parseEnv({ ...baseTestEnv })

const testEnvWithDefaultGithubApp = parseEnv({
  ...baseTestEnv,
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----", // pragma: allowlist secret
  GITHUB_APP_SLUG: "ctxpipe-agent",
})

function createApp(appEnv: Env = testEnv): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("env", appEnv)
    c.set("log", { error: vi.fn() } as unknown as AppEnv["Variables"]["log"])
    await next()
  })
  const scoped = new OpenAPIHono<AppEnv>()
    .use("*", requireOrgAdminOrOwner)
    .route("/", githubInstallationRoutes)
  app.route("/github/installation", scoped)
  return app
}

describe("POST /github/installation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    refreshGithubConnectionAccountSlugMock.mockResolvedValue(undefined)
    upsertInstallationMock.mockResolvedValue({
      id: "ghi_1",
      installationId: 123,
      orgId: "org_1",
      accountSlug: null,
      appSlug: null,
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("returns 403 when user is not org admin/owner", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("allows installation registration when GitHub account is not linked", async () => {
    getGithubUserAccessTokenMock.mockResolvedValueOnce(undefined)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(200)
    expect(upsertInstallationMock).toHaveBeenCalled()
    expect(upsertInstallationMock.mock.calls[0]?.[0]).toBe("org_1")
    expect(upsertInstallationMock.mock.calls[0]?.[1]).toBe(123)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("returns 403 when installationId is not accessible to the user", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "owner" })
    getGithubUserAccessTokenMock.mockResolvedValueOnce("ghu_token")
    userCanAccessInstallationMock.mockResolvedValueOnce(false)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(upsertInstallationMock).not.toHaveBeenCalled()
  })

  it("upserts when installationId is accessible and user is org admin", async () => {
    getGithubUserAccessTokenMock.mockResolvedValueOnce("ghu_token")
    userCanAccessInstallationMock.mockResolvedValueOnce(true)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(200)
    expect(upsertInstallationMock).toHaveBeenCalled()
    expect(upsertInstallationMock.mock.calls[0]?.[0]).toBe("org_1")
    expect(upsertInstallationMock.mock.calls[0]?.[1]).toBe(123)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("does not enqueue sync on registration", async () => {
    getGithubUserAccessTokenMock.mockResolvedValueOnce(undefined)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})

describe("GET /github/installation/connector-bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    listGithubConnectionRowsForOrgMock.mockResolvedValue([])
    githubRowHasAppCredentialsMock.mockReturnValue(false)
  })

  it("returns bootstrap with null hosted URL when env has no GitHub app", async () => {
    const app = createApp(testEnv)
    const res = await app.request("/github/installation/connector-bootstrap")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      suggestedWebhookUrlTemplate:
        "https://localhost:3000/api/v1/webhook/github/<connectionId>",
      githubAppConfiguredInEnv: false,
      rowsNeedingSecrets: 0,
      hostedDefaultAppInstallUrl: null,
    })
  })

  it("returns hosted default install URL when GITHUB_APP_ID and key are set", async () => {
    const app = createApp(testEnvWithDefaultGithubApp)
    const res = await app.request("/github/installation/connector-bootstrap")
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      hostedDefaultAppInstallUrl: string | null
      githubAppConfiguredInEnv: boolean
    }
    expect(json.githubAppConfiguredInEnv).toBe(true)
    expect(json.hostedDefaultAppInstallUrl).toBe(
      "https://github.com/apps/ctxpipe-agent/installations/select_target",
    )
  })
})

describe("POST /github/installation/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    createDraftGithubConnectionMock.mockResolvedValue({
      id: "con_draft",
      installationId: null,
      orgId: "org_1",
      accountSlug: null,
      appSlug: "my-app",
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("creates a draft connection via createDraftGithubConnection", async () => {
    const app = createApp()
    const res = await app.request("/github/installation/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        githubAppId: "1",
        appSlug: "acme",
        privateKey: "pem",
        webhookSecret: "whsec",
      }),
    })
    expect(res.status).toBe(200)
    expect(createDraftGithubConnectionMock).toHaveBeenCalled()
    const body = (await res.json()) as { id: string; installationId: null }
    expect(body.id).toBe("con_draft")
    expect(body.installationId).toBeNull()
  })
})

describe("POST /github/installation/draft/placeholder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    createPlaceholderGithubConnectionMock.mockResolvedValue({
      id: "con_ph",
      installationId: null,
      orgId: "org_1",
      accountSlug: null,
      appSlug: null,
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("returns connection id and webhook URL", async () => {
    const app = createApp(testEnv)
    const res = await app.request("/github/installation/draft/placeholder", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(createPlaceholderGithubConnectionMock).toHaveBeenCalledWith({
      orgId: "org_1",
    })
    expect(await res.json()).toEqual({
      id: "con_ph",
      webhookUrl: "https://localhost:3000/api/v1/webhook/github/con_ph",
    })
  })
})

describe("PATCH /github/installation/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    completeGithubDraftCredentialsMock.mockResolvedValue({
      id: "con_ph",
      installationId: null,
      orgId: "org_1",
      accountSlug: null,
      appSlug: "acme",
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
    countRepositoriesForGithubConnectionMock.mockResolvedValue(0)
  })

  it("stores credentials via completeGithubDraftCredentials", async () => {
    const app = createApp()
    const res = await app.request("/github/installation/draft", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "con_ph",
        githubAppId: "1",
        appSlug: "acme",
        privateKey: "pem",
        webhookSecret: "whsec",
      }),
    })
    expect(res.status).toBe(200)
    expect(completeGithubDraftCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_ph",
        githubAppId: "1",
        appSlug: "acme",
        privateKey: "pem",
        webhookSecret: "whsec",
      }),
    )
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe("con_ph")
  })
})

describe("GET /github/installation/connector-status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    githubRowHasAppCredentialsMock.mockReturnValue(true)
    getGithubConnectionRowMock.mockResolvedValue({
      id: "con_stat",
      orgId: "org_1",
      type: "github",
      config: {
        ingestAllRepositories: false,
        includeFutureRepos: false,
        appSlug: "acme",
      },
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("returns install_app next step when credentials exist but installation is missing", async () => {
    const app = createApp()
    const res = await app.request(
      "/github/installation/connector-status?connectionId=con_stat",
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      connectionId: "con_stat",
      installationComplete: false,
      hasAppCredentials: true,
      webhookUrl:
        "https://localhost:3000/api/v1/webhook/github/con_stat",
      githubAppInstallSelectUrl:
        "https://github.com/apps/acme/installations/select_target",
      suggestedNextStep: "install_app",
    })
  })
})

describe("POST /github/installation with connectionId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    getGithubUserAccessTokenMock.mockResolvedValue(undefined)
    registerInstallationOnConnectionMock.mockResolvedValue({
      id: "con_draft",
      installationId: 999,
      orgId: "org_1",
      accountSlug: "acme",
      appSlug: "my-app",
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("registers installation on existing draft connection", async () => {
    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: 999,
        connectionId: "con_draft",
      }),
    })
    expect(res.status).toBe(200)
    expect(registerInstallationOnConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_draft",
        installationId: 999,
      }),
    )
    expect(upsertInstallationMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})

describe("PATCH /github/installation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    countRepositoriesForGithubConnectionMock.mockResolvedValue(0)
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: installationFixture,
    })
    updateInstallationOptionsMock.mockImplementation(
      async (_orgId, _connectionId, options) => ({
        ...installationFixture,
        ...options,
      }),
    )
  })

  it("returns 403 when user is not org admin/owner", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ingestAllRepositories: false,
        includeFutureRepos: false,
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("select mode enqueues reposToSync only", async () => {
    const selectedRepositories = [
      {
        id: 1,
        full_name: "acme/alpha",
        name: "alpha",
        clone_url: "https://github.com/acme/alpha.git",
      },
      {
        id: 2,
        full_name: "acme/beta",
        name: "beta",
        clone_url: "https://github.com/acme/beta.git",
      },
    ]

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ingestAllRepositories: false,
        includeFutureRepos: false,
        selectedRepositories,
      }),
    })

    expect(res.status).toBe(200)
    expect(pruneGithubConnectionRepositoriesNotInGitUrlsMock).toHaveBeenCalledWith(
      "org_1",
      "con_github",
      new Set([
        "https://github.com/acme/alpha.git",
        "https://github.com/acme/beta.git",
      ]),
    )
    expect(runWorkflowMock).toHaveBeenCalledWith(syncGithubRepositories.spec, {
      orgId: "org_1",
      githubConnectionId: "con_github",
      reposToSync: [
        {
          name: "acme/alpha",
          gitUrl: "https://github.com/acme/alpha.git",
        },
        {
          name: "acme/beta",
          gitUrl: "https://github.com/acme/beta.git",
        },
      ],
    })
  })

  it("all mode enqueues full sync without reposToSync", async () => {
    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ingestAllRepositories: true,
        includeFutureRepos: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(pruneGithubConnectionRepositoriesNotInGitUrlsMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).toHaveBeenCalledWith(syncGithubRepositories.spec, {
      orgId: "org_1",
      githubConnectionId: "con_github",
    })
    expect(runWorkflowMock.mock.calls[0]?.[1]).not.toHaveProperty("reposToSync")
  })

  it("select mode with empty selection returns 400 and does not enqueue sync", async () => {
    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ingestAllRepositories: false,
        includeFutureRepos: false,
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: "Select at least one repository",
    })
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(pruneGithubConnectionRepositoriesNotInGitUrlsMock).not.toHaveBeenCalled()
  })

  it("all mode persists includeFutureRepos false", async () => {
    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ingestAllRepositories: true,
        includeFutureRepos: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(updateInstallationOptionsMock).toHaveBeenCalledWith(
      "org_1",
      "con_github",
      {
        ingestAllRepositories: true,
        includeFutureRepos: false,
      },
    )
  })
})

describe("DELETE /github/installation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: {
        id: "con_github",
        installationId: 123,
        orgId: "org_1",
        accountSlug: "acme",
        appSlug: null,
        ingestAllRepositories: false,
        includeFutureRepos: false,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    })
    deleteGithubConnectionByIdMock.mockResolvedValue(true)
  })

  it("returns 403 when user is not org admin/owner", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })

    const app = createApp()
    const res = await app.request(
      "/github/installation?connectionId=con_github",
      {
        method: "DELETE",
      },
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(deleteGithubConnectionByIdMock).not.toHaveBeenCalled()
  })

  it("deletes the selected GitHub connection", async () => {
    const app = createApp()
    const res = await app.request(
      "/github/installation?connectionId=con_github",
      {
        method: "DELETE",
      },
    )

    expect(res.status).toBe(204)
    expect(resolveGithubInstallationForOrgDetailedMock).toHaveBeenCalledWith(
      "org_1",
      "con_github",
    )
    expect(deleteGithubConnectionByIdMock).toHaveBeenCalledWith(
      "org_1",
      "con_github",
    )
  })

  it("returns 400 when multiple GitHub connections exist and no connectionId is provided", async () => {
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValueOnce({
      status: "ambiguous",
    })

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "DELETE",
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error:
        "Multiple GitHub connections for this organization; specify connectionId query parameter",
    })
    expect(deleteGithubConnectionByIdMock).not.toHaveBeenCalled()
  })

  it("returns 404 when the GitHub connection does not exist", async () => {
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValueOnce({
      status: "none",
    })

    const app = createApp()
    const res = await app.request(
      "/github/installation?connectionId=con_missing",
      {
        method: "DELETE",
      },
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: "No GitHub installation found for this org",
    })
    expect(deleteGithubConnectionByIdMock).not.toHaveBeenCalled()
  })
})

describe("GET /github/installation/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: {
        id: "con_github",
        installationId: 123,
        orgId: "org_1",
        accountSlug: "acme",
        appSlug: null,
        ingestAllRepositories: false,
        includeFutureRepos: false,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    })
    listReposForInstallationMock.mockResolvedValue({
      repositories: [],
      repositorySelection: "selected",
      hasMore: false,
    })
    searchReposForInstallationMock.mockResolvedValue({
      repositories: [],
      hasMore: false,
      totalCount: 0,
    })
  })

  it("returns an empty preview with a reconnect warning when the GitHub installation is unavailable", async () => {
    const err = new Error(
      "Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app",
    )
    err.name = "HttpError"
    Object.assign(err, { status: 404 })
    listReposForInstallationMock.mockRejectedValueOnce(err)

    const app = createApp()
    const res = await app.request(
      "/github/installation/repositories?page=1&per_page=100",
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      repositories: [],
      repositorySelection: "unavailable",
      hasMore: false,
      warning:
        "GitHub installation is no longer available. Reconnect GitHub from the Connectors page.",
    })
  })

  it("does not leak raw GitHub errors for unexpected repository list failures", async () => {
    listReposForInstallationMock.mockRejectedValueOnce(
      new Error(
        "Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app",
      ),
    )

    const app = createApp()
    const res = await app.request(
      "/github/installation/repositories?page=1&per_page=100",
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { warning?: string }
    expect(body.warning).toBe(
      "GitHub installation is no longer available. Reconnect GitHub from the Connectors page.",
    )
    expect(JSON.stringify(body)).not.toContain("docs.github.com")
  })
})

describe("GET /api/v1/me/github/installations/:installationId/organization", () => {
  it("returns 200 with orgSlug when a matching organization exists", async () => {
    getOrganizationSlugForInstallationByUserMock.mockResolvedValueOnce(
      "acme-org",
    )

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
      await next()
    })
    app.route("/api/v1/me/github/installations", meGithubInstallationsRoutes)

    const res = await app.request(
      "/api/v1/me/github/installations/123/organization",
      {
        method: "GET",
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orgSlug: "acme-org" })
    expect(getOrganizationSlugForInstallationByUserMock).toHaveBeenCalledWith(
      "user_1",
      123,
    )
  })

  it("returns 404 when no matching organization exists", async () => {
    getOrganizationSlugForInstallationByUserMock.mockResolvedValueOnce(
      undefined,
    )

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
      await next()
    })
    app.route("/api/v1/me/github/installations", meGithubInstallationsRoutes)

    const res = await app.request(
      "/api/v1/me/github/installations/123/organization",
      {
        method: "GET",
      },
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })
})
