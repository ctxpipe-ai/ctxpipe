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
const destroySandboxesForWorkspaceMock = vi.hoisted(() => vi.fn())
const withDestroyedWorkspaceSandboxesMock = vi.hoisted(() => vi.fn())
const getMigrationExportShaMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
)
const listMigrationExportShasMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Map()),
)
const listWorkspaceCheckoutPathsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue([]),
)
const readWorkspaceCheckoutFileMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ kind: "missing" }),
)
const getJobSandboxMock = vi.hoisted(() => vi.fn().mockReturnValue(null))

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

vi.mock("../../domain/workspaces/sandbox-registry.js", () => ({
  destroySandboxesForWorkspace: destroySandboxesForWorkspaceMock,
  withDestroyedWorkspaceSandboxes: withDestroyedWorkspaceSandboxesMock,
  getJobSandbox: getJobSandboxMock,
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
  getMigrationExportSha: getMigrationExportShaMock,
  listMigrationExportShas: listMigrationExportShasMock,
  linkRepository: linkRepositoryMock,
  unlinkRepository: unlinkRepositoryMock,
}))

vi.mock("../../domain/workspaces/checkout-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../domain/workspaces/checkout-read.js")
    >()
  return {
    ...actual,
    listWorkspaceCheckoutPaths: listWorkspaceCheckoutPathsMock,
    readWorkspaceCheckoutFile: readWorkspaceCheckoutFileMock,
  }
})

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

import { WRITE_STATUS_REASONS } from "../../domain/workspaces/write-status.js"
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
    listWorkspaceCheckoutPathsMock.mockResolvedValue([])
    readWorkspaceCheckoutFileMock.mockResolvedValue({ kind: "missing" })
    getJobSandboxMock.mockReturnValue(null)
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
    expect(enqueueWorkspaceTipCheck).toHaveBeenCalledWith(
      "org_mock",
      expect.anything(),
    )
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
      },
    })
    const body = await res.json()
    expect(body.slug).toBe("knowledge")
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        gitUrl: "https://github.com/acme/knowledge",
      }),
    )
    expect(enqueueWorkspaceHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        workspaceId: "ws_abc",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("creates a writable workspace when Select GitHub sends a connection", async () => {
    createWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_gh",
      writeStatus: "writable",
    })
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
        githubConnectionId: "con_gh",
      }),
    })
    expect(res.status).toBe(201)
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/knowledge.git",
      githubConnectionId: "con_gh",
      write: {
        writeStatus: "writable",
        readOnlyReason: null,
      },
    })
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubConnectionId: "con_gh",
      }),
    )
  })

  it("does not treat a foreign GitHub connection as writable", async () => {
    getGithubInstallationByConnectionIdMock.mockResolvedValue(undefined)
    createWorkspaceMock.mockResolvedValue(workspaceRow)
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
        githubConnectionId: "con_other",
        source: "select",
      }),
    })
    expect(res.status).toBe(201)
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/knowledge.git",
      write: {
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
      },
    })
  })

  it("uses the org's only GitHub connection when Select omitted an id", async () => {
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: { id: "con_only" },
    })
    createWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_only",
      writeStatus: "writable",
    })
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
        source: "select",
      }),
    })
    expect(res.status).toBe(201)
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/knowledge.git",
      githubConnectionId: "con_only",
      write: {
        writeStatus: "writable",
        readOnlyReason: null,
      },
    })
  })

  it("does not infer a connection when Paste omitted an id", async () => {
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: { id: "con_only" },
    })
    createWorkspaceMock.mockResolvedValue(workspaceRow)
    const res = await app().request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/acme/knowledge.git",
        source: "paste",
      }),
    })
    expect(res.status).toBe(201)
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/knowledge.git",
      write: {
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
      },
    })
    expect(resolveGithubInstallationForOrgDetailedMock).not.toHaveBeenCalled()
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
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        gitUrl: "https://github.com/acme/knowledge",
      }),
    )
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

  it("queues paused first-create export and links while write status is unknown", async () => {
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
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "migration_export",
      }),
      expect.anything(),
    )
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
      }),
      expect.anything(),
    )
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
      },
    })
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        gitUrl: "https://github.com/acme/docs",
      }),
    )
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

  it("applies write status when relinking the same URL with a connection", async () => {
    getWorkspaceBySlugMock.mockResolvedValue(workspaceRow)
    updateWorkspaceMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_gh",
      writeStatus: "writable",
    })
    const res = await app().request("/workspaces/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceRepositoryUrl: "https://github.com/acme/knowledge.git",
        githubConnectionId: "con_gh",
        source: "select",
      }),
    })
    expect(res.status).toBe(200)
    expect(updateWorkspaceMock).toHaveBeenCalledWith("knowledge", {
      workspaceRepositoryUrl: "https://github.com/acme/knowledge.git",
      githubConnectionId: "con_gh",
      write: {
        writeStatus: "writable",
        readOnlyReason: null,
      },
    })
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
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_mock",
        gitUrl: "https://github.com/acme/app",
      }),
    )
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

  it("lists the git tree at the active projection SHA", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionUrl: "https://github.com/acme/knowledge",
      activeProjectionSha: "active-sha",
      desiredSha: "desired-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue([
      "AGENTS.md",
      "knowledge/billing/ledger.md",
    ])
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sha: "active-sha",
      paths: ["AGENTS.md", "knowledge/billing/ledger.md"],
    })
    expect(listWorkspaceCheckoutPathsMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/knowledge",
    })
  })

  it("reads the active remote during relink instead of the desired repository", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      workspaceRepositoryUrl: "https://github.com/acme/desired",
      githubConnectionId: "con_1",
      activeProjectionUrl: "https://github.com/acme/active",
      activeProjectionSha: "active-sha",
      desiredSha: "desired-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue(["AGENTS.md"])
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(200)
    expect(listWorkspaceCheckoutPathsMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/active",
    })
  })

  it("lists the git tree after hydrate without a stored GitHub connection", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: null,
      activeProjectionSha: "active-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue(["AGENTS.md"])
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sha: "active-sha",
      paths: ["AGENTS.md"],
    })
    expect(listWorkspaceCheckoutPathsMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/knowledge",
    })
  })

  it("lists the git tree for a hydrated non-GitHub remote", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      workspaceRepositoryUrl: "https://gitlab.com/acme/docs",
      githubConnectionId: null,
      activeProjectionSha: "active-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue(["README.md"])
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sha: "active-sha",
      paths: ["README.md"],
    })
    expect(listWorkspaceCheckoutPathsMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://gitlab.com/acme/docs",
    })
  })

  it("rejects a git tree read when no SHA is stored", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
    })
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "This Workspace has no git SHA to browse yet.",
    })
  })

  it("returns a git blob at the projection SHA", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    readWorkspaceCheckoutFileMock.mockResolvedValue({
      kind: "bytes",
      bytes: Buffer.from("# Ledger\n", "utf8"),
    })
    const res = await app().request(
      "/workspaces/knowledge/files/blob?path=knowledge/billing/ledger.md",
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: "knowledge/billing/ledger.md",
      body: "# Ledger\n",
      binary: false,
    })
    expect(readWorkspaceCheckoutFileMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/knowledge",
      path: "knowledge/billing/ledger.md",
    })
  })

  it("returns a git blob after hydrate without a stored GitHub connection", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: null,
      activeProjectionSha: "active-sha",
    })
    readWorkspaceCheckoutFileMock.mockResolvedValue({
      kind: "bytes",
      bytes: Buffer.from("# Ledger\n", "utf8"),
    })
    const res = await app().request(
      "/workspaces/knowledge/files/blob?path=knowledge/billing/ledger.md",
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: "knowledge/billing/ledger.md",
      body: "# Ledger\n",
      binary: false,
    })
    expect(readWorkspaceCheckoutFileMock).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      gitUrl: "https://github.com/acme/knowledge",
      path: "knowledge/billing/ledger.md",
    })
  })

  it("rejects a git blob read when no SHA is stored", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
    })
    const res = await app().request(
      "/workspaces/knowledge/files/blob?path=knowledge/billing/ledger.md",
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "This Workspace has no git SHA to browse yet.",
    })
    expect(readWorkspaceCheckoutFileMock).not.toHaveBeenCalled()
  })

  it("marks a git blob with NUL bytes as binary", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      desiredSha: "desired-sha",
    })
    readWorkspaceCheckoutFileMock.mockResolvedValue({
      kind: "bytes",
      bytes: Buffer.from("png\0bytes", "utf8"),
    })
    const res = await app().request(
      "/workspaces/knowledge/files/blob?path=logo.png",
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: "logo.png",
      body: null,
      binary: true,
    })
  })

  it("returns 409 when the workspace checkout is not ready", async () => {
    const { WorkspaceCheckoutReadError } = await import(
      "../../domain/workspaces/checkout-read.js"
    )
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    listWorkspaceCheckoutPathsMock.mockRejectedValue(
      new WorkspaceCheckoutReadError(
        "This Workspace checkout is not ready yet.",
        409,
      ),
    )
    const res = await app().request("/workspaces/knowledge/files/tree")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "This Workspace checkout is not ready yet.",
    })
  })

  it("rejects a git blob path that leaves the repository", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    const res = await app().request(
      "/workspaces/knowledge/files/blob?path=../secret",
    )
    expect(res.status).toBe(400)
    expect(readWorkspaceCheckoutFileMock).not.toHaveBeenCalled()
  })

  it("returns a clean git status when no write sandbox is attached", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    const res = await app().request("/workspaces/knowledge/files/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sha: "active-sha",
      source: "clean",
      items: [],
    })
  })

  it("maps write-sandbox porcelain into Files pane git status", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    getJobSandboxMock.mockReturnValue({
      exec: async (command: string) => {
        if (command.includes("numstat")) {
          return {
            stdout: "1\t0\tknowledge/billing/ledger.md\n1\t0\tscratch.ts\n",
            stderr: "",
            exitCode: 0,
          }
        }
        return {
          stdout: " M knowledge/billing/ledger.md\n?? scratch.ts\n",
          stderr: "",
          exitCode: 0,
        }
      },
      fs: {
        read: async (path: string) => {
          if (path === "knowledge/billing/ledger.md") return "# dirty\n"
          if (path === "scratch.ts") return "export {}\n"
          throw new Error("missing")
        },
        write: async () => undefined,
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    })
    const res = await app().request("/workspaces/knowledge/files/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sha: "active-sha",
      source: "sandbox",
      items: [
        {
          path: "knowledge/billing/ledger.md",
          status: "modified",
          body: "# dirty\n",
          additions: 1,
          deletions: 0,
        },
        {
          path: "scratch.ts",
          status: "untracked",
          body: "export {}\n",
          additions: 1,
          deletions: 0,
        },
      ],
    })
  })

  it("queues a Files pane save as a write job", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue(["AGENTS.md"])
    const res = await app().request("/workspaces/knowledge/files/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "save",
        path: "AGENTS.md",
        content: "# saved\n",
      }),
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: true })
    expect(enqueueWorkspaceWriteCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_abc",
        kind: "ui_file_edit",
        mergeFiles: [{ path: "AGENTS.md", content: "# saved\n" }],
        mergeDeletePaths: [],
      }),
      expect.anything(),
    )
  })

  it("refuses a Files pane write when the Workspace is read-only", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "read_only",
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    const res = await app().request("/workspaces/knowledge/files/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "save",
        path: "AGENTS.md",
        content: "# saved\n",
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Workspace is read-only" })
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
  })

  it("rejects a Files pane write that leaves the repository", async () => {
    getWorkspaceBySlugMock.mockResolvedValue({
      ...workspaceRow,
      writeStatus: "writable",
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
    })
    listWorkspaceCheckoutPathsMock.mockResolvedValue(["AGENTS.md"])
    const res = await app().request("/workspaces/knowledge/files/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "delete",
        path: "../secret",
      }),
    })
    expect(res.status).toBe(400)
    expect(enqueueWorkspaceWriteCommit).not.toHaveBeenCalled()
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
