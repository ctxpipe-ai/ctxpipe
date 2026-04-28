import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: vi.fn() },
}))

const countRepositoriesForGithubConnectionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(0),
)

vi.mock("../../models/repositories.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/repositories.js")>()
  return {
    ...actual,
    countRepositoriesForGithubConnection:
      countRepositoriesForGithubConnectionMock,
  }
})

const upsertInstallationMock = vi.hoisted(() => vi.fn())
const refreshGithubConnectionAccountSlugMock = vi.hoisted(() => vi.fn())
const getGithubUserAccessTokenMock = vi.hoisted(() => vi.fn())
const userCanAccessInstallationMock = vi.hoisted(() => vi.fn())
const getOrganizationSlugForInstallationByUserMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    upsertInstallation: upsertInstallationMock,
    refreshGithubConnectionAccountSlug: refreshGithubConnectionAccountSlugMock,
    getGithubUserAccessToken: getGithubUserAccessTokenMock,
    userCanAccessInstallation: userCanAccessInstallationMock,
    getOrganizationSlugForInstallationByUser:
      getOrganizationSlugForInstallationByUserMock,
  }
})

import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { githubInstallationRoutes } from "./github-installation.js"
import { meGithubInstallationsRoutes } from "./me-github-installations.js"

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
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
    expect(upsertInstallationMock).toHaveBeenCalledWith("org_1", 123)
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
    expect(upsertInstallationMock).toHaveBeenCalledWith("org_1", 123)
  })
})

describe("PATCH /github/installation", () => {
  beforeEach(() => {
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
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
    getOrganizationSlugForInstallationByUserMock.mockResolvedValueOnce(undefined)

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

