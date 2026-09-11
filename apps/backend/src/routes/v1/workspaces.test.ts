import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const listWorkspacesMock = vi.hoisted(() => vi.fn())
const createWorkspaceMock = vi.hoisted(() => vi.fn())
const getWorkspaceBySlugMock = vi.hoisted(() => vi.fn())
const updateWorkspaceMock = vi.hoisted(() => vi.fn())
const touchLastUsedWorkspaceMock = vi.hoisted(() => vi.fn())
const listLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const persistHydrateRetryMock = vi.hoisted(() => vi.fn())
const deleteWorkspaceMock = vi.hoisted(() => vi.fn())
const destroySandboxesForWorkspaceMock = vi.hoisted(() => vi.fn())
const withDestroyedWorkspaceSandboxesMock = vi.hoisted(() => vi.fn())
const getMigrationExportShaMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)
const listMigrationExportShasMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Map()),
)
const ensureOrgRepositoryForGitUrlMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)

vi.mock("../../domain/workspaces/ensure-org-repository.js", () => ({
  ensureOrgRepositoryForGitUrl: ensureOrgRepositoryForGitUrlMock,
}))

vi.mock("../../openworkflow/enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-tip-check.js", () => ({
  enqueueWorkspaceTipCheck: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../openworkflow/enqueue-workspace-commit-projection.js", () => ({
  enqueueWorkspaceCommitProjection: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../domain/workspaces/workspace-sandbox-cleanup.js", () => ({
  destroySandboxesForWorkspace: destroySandboxesForWorkspaceMock,
  withDestroyedWorkspaceSandboxes: withDestroyedWorkspaceSandboxesMock,
}))

vi.mock("../../models/workspaces.js", () => ({
  listWorkspaces: listWorkspacesMock,
  createWorkspace: createWorkspaceMock,
  getWorkspaceBySlug: getWorkspaceBySlugMock,
  updateWorkspace: updateWorkspaceMock,
  touchLastUsedWorkspace: touchLastUsedWorkspaceMock,
  listLinkedRepositories: listLinkedRepositoriesMock,
  persistHydrateRetry: persistHydrateRetryMock,
  deleteWorkspace: deleteWorkspaceMock,
  getMigrationExportSha: getMigrationExportShaMock,
  listMigrationExportShas: listMigrationExportShasMock,
}))

const getGithubInstallationByConnectionIdMock = vi.hoisted(() =>
  vi.fn(
    async (
      _orgId: string,
      connectionId: string,
    ): Promise<{ id: string } | undefined> => ({
      id: connectionId,
    }),
  ),
)
const resolveGithubInstallationForOrgDetailedMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      | { status: "none" }
      | { status: "ok"; installation: { id: string } }
      | { status: "ambiguous" }
    > => ({ status: "none" }),
  ),
)

vi.mock("../../models/github-installation.js", () => ({
  getGithubInstallationByConnectionId: getGithubInstallationByConnectionIdMock,
  resolveGithubInstallationForOrgDetailed:
    resolveGithubInstallationForOrgDetailedMock,
}))

import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
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
    c.set("orgId", "org_mock")
    c.set("env", { NODE_ENV: "test" } as AppEnv["Variables"]["env"])
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
    ensureOrgRepositoryForGitUrlMock.mockReset()
    ensureOrgRepositoryForGitUrlMock.mockResolvedValue(null)
    getGithubInstallationByConnectionIdMock.mockImplementation(
      async (_orgId: string, connectionId: string) => ({ id: connectionId }),
    )
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "none",
    })
    withDestroyedWorkspaceSandboxesMock.mockImplementation(
      async (
        _input: { workspaceId: string; orgId: string },
        fn: (remaining: unknown[]) => Promise<unknown>,
      ) => fn([]),
    )
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
    expect(enqueueWorkspaceTipCheck).not.toHaveBeenCalled()
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
    expect(enqueueWorkspaceTipCheck).not.toHaveBeenCalled()
  })

  it("rechecks write access when opening a read-only workspace", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "read_only",
    })
    listLinkedRepositoriesMock.mockResolvedValue([])
    const res = await app().request("/workspaces/knowledge")
    expect(res.status).toBe(200)
    expect(enqueueWorkspaceTipCheck).toHaveBeenCalledWith(
      workspaceRow.orgId,
      expect.anything(),
    )
  })

  it("404s unknown slugs", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(null)
    const res = await app().request("/workspaces/missing")
    expect(res.status).toBe(404)
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
    expect(withDestroyedWorkspaceSandboxesMock).toHaveBeenCalledWith(
      { workspaceId: "ws_abc", orgId: "org_mock" },
      expect.any(Function),
    )
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
    expect(withDestroyedWorkspaceSandboxesMock).not.toHaveBeenCalled()
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
    withDestroyedWorkspaceSandboxesMock.mockImplementation(
      async (
        _input: { workspaceId: string; orgId: string },
        fn: (remaining: unknown[]) => Promise<unknown>,
      ) =>
        fn([
          {
            id: "job-1",
            kind: "job",
            workspaceId: "ws_abc",
            provider: "docker",
            providerSandboxId: "sbx_live",
            state: "destroy_failed",
            lastHeartbeatAt: new Date(),
          },
        ]),
    )
    const res = await app().request("/workspaces/knowledge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "knowledge" }),
    })
    expect(res.status).toBe(409)
    expect(withDestroyedWorkspaceSandboxesMock).toHaveBeenCalledWith(
      { workspaceId: "ws_abc", orgId: "org_mock" },
      expect.any(Function),
    )
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
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "migration_export",
        orgId: "org_mock",
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
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

})
