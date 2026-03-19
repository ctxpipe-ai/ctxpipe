import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getSystemDbMock = vi.hoisted(() => vi.fn())

vi.mock("../../db/client.js", () => ({
  getSystemDb: getSystemDbMock,
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: vi.fn() },
}))

const upsertInstallationMock = vi.hoisted(() => vi.fn())
const getGithubUserAccessTokenMock = vi.hoisted(() => vi.fn())
const userCanAccessInstallationMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    upsertInstallation: upsertInstallationMock,
    getGithubUserAccessToken: getGithubUserAccessTokenMock,
    userCanAccessInstallation: userCanAccessInstallationMock,
  }
})

import { githubInstallationRoutes } from "./github-installation.js"

function createMockDb(input: { membershipRows?: Array<{ role: string }> }) {
  const membershipRows = input.membershipRows ?? []
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => membershipRows),
        })),
      })),
    })),
  }
}

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/github/installation", githubInstallationRoutes)
  return app
}

describe("POST /github/installation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    upsertInstallationMock.mockResolvedValue({
      id: "ghi_1",
      installationId: 123,
      orgId: "org_1",
      ingestAllRepositories: false,
      includeFutureRepos: false,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("returns 403 when user is not org admin/owner", async () => {
    getSystemDbMock.mockReturnValue(createMockDb({ membershipRows: [] }) as never)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("returns 409 when GitHub account not linked", async () => {
    getSystemDbMock.mockReturnValue(
      createMockDb({ membershipRows: [{ role: "admin" }] }) as never,
    )
    getGithubUserAccessTokenMock.mockResolvedValueOnce(undefined)

    const app = createApp()
    const res = await app.request("/github/installation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 123 }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "GitHub account not linked",
      code: "github_not_linked",
    })
  })

  it("returns 403 when installationId is not accessible to the user", async () => {
    getSystemDbMock.mockReturnValue(
      createMockDb({ membershipRows: [{ role: "owner" }] }) as never,
    )
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
    getSystemDbMock.mockReturnValue(
      createMockDb({ membershipRows: [{ role: "admin" }] }) as never,
    )
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
  it("returns 403 when user is not org admin/owner", async () => {
    getSystemDbMock.mockReturnValue(createMockDb({ membershipRows: [] }) as never)

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

