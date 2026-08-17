import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const listWorkspacesMock = vi.hoisted(() => vi.fn())
const createWorkspaceMock = vi.hoisted(() => vi.fn())
const getWorkspaceBySlugMock = vi.hoisted(() => vi.fn())
const updateWorkspaceMock = vi.hoisted(() => vi.fn())
const touchLastUsedWorkspaceMock = vi.hoisted(() => vi.fn())
const listLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const listWorkspaceKnowledgeFilesMock = vi.hoisted(() => vi.fn())
const listWorkspaceKnowledgeUnitsMock = vi.hoisted(() => vi.fn())
const linkRepositoryMock = vi.hoisted(() => vi.fn())
const unlinkRepositoryMock = vi.hoisted(() => vi.fn())
const persistHydrateRetryMock = vi.hoisted(() => vi.fn())
const deleteWorkspaceMock = vi.hoisted(() => vi.fn())
const listSandboxInstancesMock = vi.hoisted(() => vi.fn())
const destroySandboxesForWorkspaceMock = vi.hoisted(() => vi.fn())
const getMigrationExportShaMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)
const listMigrationExportShasMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Map()),
)

vi.mock("../../openworkflow/enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-cutover.js", () => ({
  enqueueWorkspaceCutover: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-tip-check.js", () => ({
  enqueueWorkspaceTipCheck: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../domain/workspaces/sandbox-registry.js", () => ({
  destroySandboxesForWorkspace: destroySandboxesForWorkspaceMock,
}))

vi.mock("../../models/workspaces.js", () => ({
  listWorkspaces: listWorkspacesMock,
  createWorkspace: createWorkspaceMock,
  getWorkspaceBySlug: getWorkspaceBySlugMock,
  updateWorkspace: updateWorkspaceMock,
  touchLastUsedWorkspace: touchLastUsedWorkspaceMock,
  listLinkedRepositories: listLinkedRepositoriesMock,
  listWorkspaceKnowledgeFiles: listWorkspaceKnowledgeFilesMock,
  listWorkspaceKnowledgeUnits: listWorkspaceKnowledgeUnitsMock,
  persistHydrateRetry: persistHydrateRetryMock,
  deleteWorkspace: deleteWorkspaceMock,
  listSandboxInstances: listSandboxInstancesMock,
  getMigrationExportSha: getMigrationExportShaMock,
  listMigrationExportShas: listMigrationExportShasMock,
  linkRepository: linkRepositoryMock,
  unlinkRepository: unlinkRepositoryMock,
  getPersistedFirstWorkspaceId: vi.fn().mockResolvedValue(null),
}))

import { WRITE_STATUS_REASONS } from "../../domain/workspaces/write-status.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
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
  hydrateError: null,
  readOnlyReason: null,
  mostRecentConversationId: null,
  autoLinkGitUrls: [],
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
    getMigrationExportShaMock.mockResolvedValue(null)
    listMigrationExportShasMock.mockResolvedValue(new Map())
    destroySandboxesForWorkspaceMock.mockResolvedValue(0)
    listSandboxInstancesMock.mockResolvedValue([])
  })

  it("lists workspaces and last-used id", async () => {
    listWorkspacesMock.mockResolvedValue({
      lastUsedWorkspaceId: "ws_abc",
      items: [workspaceRow],
    })
    listMigrationExportShasMock.mockResolvedValue(
      new Map([["ws_abc", "exportsha"]]),
    )
    const res = await app().request("/workspaces")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lastUsedWorkspaceId).toBe("ws_abc")
    expect(body.items[0].slug).toBe("knowledge")
    expect(body.items[0].id).toBe("ws_abc")
    expect(body.items[0].migrationExportSha).toBe("exportsha")
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
      write: {
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
        defaultBranch: null,
      },
    })
    const body = await res.json()
    expect(body.slug).toBe("knowledge")
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("queues export and hydrate when create is writable", async () => {
    createWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
    })
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
      }),
    })
    expect(res.status).toBe(201)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "migration_export",
      }),
      expect.anything(),
    )
  })

  it("does not queue first-create links while write status is unknown", async () => {
    createWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "unknown",
      autoLinkGitUrls: ["https://github.com/acme/app.git"],
    })
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
      }),
    })
    expect(res.status).toBe(201)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalled()
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
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
    expect(body.hydrateError).toBeNull()
    expect(body.migrationExportSha).toBeNull()
  })

  it("404s unknown slugs", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(null)
    const res = await app().request("/workspaces/missing")
    expect(res.status).toBe(404)
  })

  it("relinks the workspace repository without changing the slug", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    updateWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredGeneration: 2,
      hydrateStatus: "pending",
      writeStatus: "writable",
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
      write: {
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
        defaultBranch: null,
      },
    })
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "bootstrap",
      }),
      expect.anything(),
    )
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

  it("deletes a workspace when confirmName matches the display name", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    deleteWorkspaceMock.mockResolvedValue({ id: "ws_abc" })
    const res = await app().request("/workspaces/knowledge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "knowledge" }),
    })
    expect(res.status).toBe(204)
    expect(destroySandboxesForWorkspaceMock).toHaveBeenCalledWith("ws_abc")
    expect(listSandboxInstancesMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
    })
    expect(deleteWorkspaceMock).toHaveBeenCalledWith("knowledge", "knowledge")
  })

  it("400s when confirmName does not match", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    const res = await app().request("/workspaces/knowledge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "wrong" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("Type the Workspace display name to confirm delete")
    expect(destroySandboxesForWorkspaceMock).not.toHaveBeenCalled()
    expect(deleteWorkspaceMock).not.toHaveBeenCalled()
  })

  it("404s delete for an unknown slug", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(null)
    const res = await app().request("/workspaces/missing", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "Docs" }),
    })
    expect(res.status).toBe(404)
    expect(deleteWorkspaceMock).not.toHaveBeenCalled()
  })

  it("keeps the workspace when sandbox destroy leaves a live provider id", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    listSandboxInstancesMock.mockResolvedValue([
      {
        id: "job-1",
        kind: "job",
        workspaceId: "ws_abc",
        provider: "docker",
        providerSandboxId: "sbx_live",
        state: "destroy_failed",
        lastHeartbeatAt: new Date(),
      },
    ])
    const res = await app().request("/workspaces/knowledge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "knowledge" }),
    })
    expect(res.status).toBe(409)
    expect(destroySandboxesForWorkspaceMock).toHaveBeenCalledWith("ws_abc")
    expect(deleteWorkspaceMock).not.toHaveBeenCalled()
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

  it("serializes a failed hydrate on GET", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      hydrateStatus: "failed",
      hydrateError: "getLogger: no logger in context.",
    })
    listLinkedRepositoriesMock.mockResolvedValue([])
    const res = await app().request("/workspaces/knowledge")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hydrateStatus).toBe("failed")
    expect(body.hydrateError).toBe("getLogger: no logger in context.")
  })

  it("retries prepare from a failed hydrate with no tip", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      hydrateStatus: "failed",
      hydrateError: "getLogger: no logger in context.",
      desiredSha: null,
    })
    persistHydrateRetryMock.mockResolvedValue({
      ...workspaceRow,
      hydrateStatus: "pending",
      hydrateError: null,
    })
    const res = await app().request("/workspaces/knowledge/retry-prepare", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hydrateStatus).toBe("pending")
    expect(body.hydrateError).toBeNull()
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("retries hydrate and export when writable with no tip", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      hydrateStatus: "failed",
      hydrateError: "paused write",
      desiredSha: null,
    })
    persistHydrateRetryMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      hydrateStatus: "pending",
      hydrateError: null,
      desiredSha: null,
    })
    const res = await app().request("/workspaces/knowledge/retry-prepare", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "migration_export",
      }),
      expect.anything(),
    )
  })

  it("retries hydrate when a tip already exists", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      hydrateStatus: "failed",
      hydrateError: "hydrate died",
      desiredSha: "abc123def456",
    })
    persistHydrateRetryMock.mockResolvedValue({
      ...workspaceRow,
      desiredSha: "abc123def456",
      hydrateStatus: "pending",
      hydrateError: null,
    })
    getMigrationExportShaMock.mockResolvedValue("exportsha")
    const res = await app().request("/workspaces/knowledge/retry-prepare", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("retries hydrate and export when a tip exists but export SHA does not", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      hydrateStatus: "failed",
      hydrateError: "hydrate died",
      desiredSha: "abc123def456",
    })
    persistHydrateRetryMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      desiredSha: "abc123def456",
      hydrateStatus: "pending",
      hydrateError: null,
    })
    const res = await app().request("/workspaces/knowledge/retry-prepare", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalled()
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "migration_export",
      }),
      expect.anything(),
    )
  })

  it("retries hydrate without re-export when export is recorded but no desired SHA exists", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      hydrateStatus: "failed",
      hydrateError: "hydrate died",
      desiredSha: null,
    })
    persistHydrateRetryMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      hydrateStatus: "pending",
      hydrateError: null,
      desiredSha: null,
    })
    getMigrationExportShaMock.mockResolvedValue("exportsha")
    const res = await app().request("/workspaces/knowledge/retry-prepare", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("queues a link while write status is unknown", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    listLinkedRepositoriesMock.mockResolvedValue([])
    const res = await app().request(
      "/workspaces/knowledge/linked-repositories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gitUrl: "https://github.com/acme/app.git" }),
      },
    )
    expect(res.status).toBe(202)
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      {
        orgId: "org_mock",
        workspaceId: "ws_abc",
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
      },
      expect.anything(),
    )
  })

  it("queues a git-first link write", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
    })
    listLinkedRepositoriesMock.mockResolvedValue([])
    const res = await app().request(
      "/workspaces/knowledge/linked-repositories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gitUrl: "https://github.com/acme/app.git" }),
      },
    )
    expect(res.status).toBe(202)
    expect(linkRepositoryMock).not.toHaveBeenCalled()
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      {
        orgId: "org_mock",
        workspaceId: "ws_abc",
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
      },
      expect.anything(),
    )
  })

  it("queues a git-first unlink write", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
    })
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
    const res = await app().request(
      "/workspaces/knowledge/linked-repositories/wlr_1",
      { method: "DELETE" },
    )
    expect(res.status).toBe(202)
    expect(unlinkRepositoryMock).not.toHaveBeenCalled()
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      {
        orgId: "org_mock",
        workspaceId: "ws_abc",
        kind: "link_unlink",
        linkAction: "unlink",
        linkGitUrl: "https://github.com/acme/app",
      },
      expect.anything(),
    )
  })

  it("lists hydrated files for the Files pane", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    listWorkspaceKnowledgeFilesMock.mockResolvedValue([
      { path: "knowledge/billing/ledger.md", body: "Ledger" },
    ])
    const res = await app().request("/workspaces/knowledge/files")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([
      { path: "knowledge/billing/ledger.md", body: "Ledger" },
    ])
    expect(body.tree[0]?.name).toBe("knowledge")
  })

  it("lists this Workspace’s projection for the Graph pane", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    listWorkspaceKnowledgeUnitsMock.mockResolvedValue({
      lastUpdatedAt: "2026-08-16T10:00:00.000Z",
      units: [
        {
          path: "knowledge/billing/ledger.md",
          servingId: "kn_ledger",
          body: "Ledger",
          links: [],
          claims: [],
        },
      ],
    })
    const res = await app().request("/workspaces/knowledge/graph")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.metrics.totalNodes).toBe(1)
    expect(body.nodes[0]).toMatchObject({
      id: "kn_ledger",
      name: "ledger",
      kind: "KnowledgeUnit",
    })
  })
})
