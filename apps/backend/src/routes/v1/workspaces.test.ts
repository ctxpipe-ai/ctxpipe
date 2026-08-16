import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const listWorkspacesMock = vi.hoisted(() => vi.fn())
const createWorkspaceMock = vi.hoisted(() => vi.fn())
const getWorkspaceBySlugMock = vi.hoisted(() => vi.fn())
const updateWorkspaceMock = vi.hoisted(() => vi.fn())
const touchLastUsedWorkspaceMock = vi.hoisted(() => vi.fn())
const listLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const linkRepositoryMock = vi.hoisted(() => vi.fn())
const unlinkRepositoryMock = vi.hoisted(() => vi.fn())

vi.mock("../../openworkflow/enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../models/workspaces.js", () => ({
  listWorkspaces: listWorkspacesMock,
  createWorkspace: createWorkspaceMock,
  getWorkspaceBySlug: getWorkspaceBySlugMock,
  updateWorkspace: updateWorkspaceMock,
  touchLastUsedWorkspace: touchLastUsedWorkspaceMock,
  listLinkedRepositories: listLinkedRepositoriesMock,
  linkRepository: linkRepositoryMock,
  unlinkRepository: unlinkRepositoryMock,
}))

import { workspaceRoutes } from "./workspaces.js"

const workspaceRow = {
  id: "ws_abc",
  orgId: "org_mock",
  slug: "knowledge",
  displayName: "knowledge",
  workspaceRepositoryUrl: "https://github.com/acme/knowledge",
  githubConnectionId: null,
  desiredGeneration: 1,
  desiredSha: null,
  activeProjectionUrl: null,
  activeProjectionSha: null,
  indexedSha: null,
  writeStatus: "unknown",
  hydrateStatus: "pending",
  readOnlyReason: null,
  mostRecentConversationId: null,
  createdAt: new Date("2026-08-15T10:00:00.000Z"),
  updatedAt: new Date("2026-08-15T10:00:00.000Z"),
}

function app() {
  const hono = new OpenAPIHono<AppEnv>()
  hono.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    c.set("log", {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as AppEnv["Variables"]["log"])
    await next()
  })
  hono.route("/workspaces", workspaceRoutes)
  return hono
}

describe("workspaces API", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lists workspaces and last-used id", async () => {
    listWorkspacesMock.mockResolvedValue({
      lastUsedWorkspaceId: "ws_abc",
      items: [workspaceRow],
    })
    const res = await app().request("/workspaces")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lastUsedWorkspaceId).toBe("ws_abc")
    expect(body.items[0].slug).toBe("knowledge")
    expect(body.items[0].id).toBe("ws_abc")
  })

  it("creates a workspace from a git URL", async () => {
    createWorkspaceMock.mockResolvedValue(workspaceRow)
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
      }),
    })
    expect(res.status).toBe(201)
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/knowledge.git",
    })
    const body = await res.json()
    expect(body.slug).toBe("knowledge")
  })

  it("returns workspace details with linked remotes", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    listLinkedRepositoriesMock.mockResolvedValue([
      {
        id: "wlr_1",
        workspaceId: "ws_abc",
        gitUrl: "https://github.com/acme/app",
        desiredRef: null,
        desiredSha: null,
        indexedSha: null,
        createdAt: new Date("2026-08-15T10:00:00.000Z"),
      },
    ])
    const res = await app().request("/workspaces/knowledge")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.linkedRepositories).toHaveLength(1)
    expect(body.linkedRepositories[0].gitUrl).toBe(
      "https://github.com/acme/app",
    )
  })

  it("404s unknown slugs", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(null)
    const res = await app().request("/workspaces/missing")
    expect(res.status).toBe(404)
  })

  it("relinks the workspace repository without changing the slug", async () => {
    updateWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredGeneration: 2,
      hydrateStatus: "pending",
    })
    const res = await app().request("/workspaces/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
      }),
    })
    expect(res.status).toBe(200)
    expect(updateWorkspaceMock).toHaveBeenCalledWith("knowledge", {
      workspaceRepositoryUrl: "https://github.com/acme/docs.git",
    })
    const body = await res.json()
    expect(body.slug).toBe("knowledge")
    expect(body.desiredGeneration).toBe(2)
  })

  it("patches slug and display name", async () => {
    updateWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      slug: "docs",
      displayName: "Docs",
    })
    const res = await app().request("/workspaces/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "docs", displayName: "Docs" }),
    })
    expect(res.status).toBe(200)
    expect(updateWorkspaceMock).toHaveBeenCalledWith("knowledge", {
      slug: "docs",
      displayName: "Docs",
    })
    const body = await res.json()
    expect(body.slug).toBe("docs")
  })

  it("records last-used on touch", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    touchLastUsedWorkspaceMock.mockResolvedValue(undefined)
    const res = await app().request("/workspaces/knowledge/touch", {
      method: "POST",
    })
    expect(res.status).toBe(204)
    expect(touchLastUsedWorkspaceMock).toHaveBeenCalledWith("ws_abc")
  })

  it("links a remote", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    linkRepositoryMock.mockResolvedValue({
      id: "wlr_1",
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/app",
      desiredRef: null,
      desiredSha: null,
      indexedSha: null,
      createdAt: new Date("2026-08-15T10:00:00.000Z"),
    })
    const res = await app().request(
      "/workspaces/knowledge/linked-repositories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gitUrl: "https://github.com/acme/app.git" }),
      },
    )
    expect(res.status).toBe(201)
    expect(linkRepositoryMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/app.git",
    })
  })

  it("unlinks a remote", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    unlinkRepositoryMock.mockResolvedValue(true)
    const res = await app().request(
      "/workspaces/knowledge/linked-repositories/wlr_1",
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })
})
