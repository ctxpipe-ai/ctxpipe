import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const { getAccessibleRepositoryMock, resolveRepositoryRefMock } = vi.hoisted(
  () => ({
    getAccessibleRepositoryMock: vi.fn(),
    resolveRepositoryRefMock: vi.fn(),
  }),
)

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: vi.fn(),
}))

vi.mock("../domain/repositories/resolveRef.js", () => ({
  resolveRepositoryRef: resolveRepositoryRefMock,
}))

import { registerRepoRoutes } from "./repo.js"

describe("POST /{repoId}/resolve-ref", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns resolved branch/hash", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "main", hash: "abc123" })
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/appear/ctxpipe.git",
      branch: "main",
      githubToken: undefined,
    })
  })

  it("passes githubToken from request body to resolveRepositoryRef", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", githubToken: "ghs_testtoken123" }),
    })

    expect(res.status).toBe(200)
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/appear/ctxpipe.git",
      branch: "main",
      githubToken: "ghs_testtoken123",
    })
  })

  it("returns 404 when repository is not accessible", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(404)
  })

  it("returns 500 when ref resolution fails", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockRejectedValue(new Error("failed"))

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    expect(res.status).toBe(500)
  })
})
