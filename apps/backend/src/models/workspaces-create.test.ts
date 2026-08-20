import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgDbMock = vi.hoisted(() => vi.fn())

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: vi.fn(() => "org_1"),
  requireCurrentUserId: vi.fn(() => "user_1"),
}))

vi.mock("../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  getOrgDb: getOrgDbMock,
}))

import { createWorkspace } from "./workspaces.js"

function existingWorkspaceRow() {
  return {
    id: "ws_existing",
    orgId: "org_1",
    slug: "docs",
    displayName: "docs",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    githubConnectionId: "con_gh",
    desiredGeneration: 1,
    desiredSha: null,
    activeProjectionUrl: null,
    activeProjectionSha: null,
    indexedSha: null,
    writeStatus: "unknown",
    hydrateStatus: "pending",
    hydrateError: null,
    readOnlyReason: null,
    createdAt: new Date("2026-08-20T04:38:00.000Z"),
    updatedAt: new Date("2026-08-20T04:38:00.000Z"),
  }
}

describe("createWorkspace", () => {
  beforeEach(() => {
    getOrgDbMock.mockReset()
  })

  it("returns the existing workspace when the git URL already backs one", async () => {
    const existing = existingWorkspaceRow()
    const updated = {
      ...existing,
      writeStatus: "writable",
      readOnlyReason: null,
    }
    const limit = vi.fn().mockResolvedValue([existing])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    const returning = vi.fn().mockResolvedValue([updated])
    const updateWhere = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where: updateWhere })
    const update = vi.fn().mockReturnValue({ set })
    const transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ select, update }),
    )
    getOrgDbMock.mockReturnValue({ transaction, select, update })

    const result = await createWorkspace({
      gitUrl: "https://github.com/acme/docs.git",
      githubConnectionId: "con_gh",
      write: { writeStatus: "writable", readOnlyReason: null },
    })

    expect(result.id).toBe("ws_existing")
    expect(result.autoLinkGitUrls).toEqual([])
    expect(result.writeStatus).toBe("writable")
    expect(update).toHaveBeenCalled()
  })

  it("returns the raced workspace when insert hits the URL unique index", async () => {
    const existing = existingWorkspaceRow()
    const unique = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "workspaces_org_id_repository_url_uidx",
    })
    const limit = vi.fn().mockResolvedValue([existing])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    const transaction = vi.fn(async () => {
      throw unique
    })
    getOrgDbMock.mockReturnValue({ transaction, select })

    const result = await createWorkspace({
      gitUrl: "https://github.com/acme/docs.git",
    })

    expect(result.id).toBe("ws_existing")
    expect(result.autoLinkGitUrls).toEqual([])
  })
})
