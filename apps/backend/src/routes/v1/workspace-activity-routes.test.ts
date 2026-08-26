import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getWorkspaceBySlugMock = vi.hoisted(() => vi.fn())
const getWorkspaceCommitProjectionMock = vi.hoisted(() => vi.fn())
const listWorkspaceCommitDayCountsMock = vi.hoisted(() => vi.fn())
const listWorkspaceRepositoryCommitsMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceCommitProjectionMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceBySlug: getWorkspaceBySlugMock,
}))

vi.mock("../../models/workspace-commits.js", () => ({
  getWorkspaceCommitProjection: getWorkspaceCommitProjectionMock,
  listWorkspaceCommitDayCounts: listWorkspaceCommitDayCountsMock,
  listWorkspaceRepositoryCommits: listWorkspaceRepositoryCommitsMock,
}))

vi.mock("../../openworkflow/enqueue-workspace-commit-projection.js", () => ({
  enqueueWorkspaceCommitProjection: enqueueWorkspaceCommitProjectionMock,
}))

import { workspaceActivityRoutes } from "./workspace-activity-routes.js"

function app() {
  const hono = new OpenAPIHono<AppEnv>()
  hono.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_mock")
    c.set("log", {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as AppEnv["Variables"]["log"])
    await next()
  })
  hono.route("/workspaces", workspaceActivityRoutes)
  return hono
}

const workspace = {
  id: "ws_1",
  orgId: "org_mock",
  slug: "docs",
  desiredSha: "abc",
}

describe("workspace activity API", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWorkspaceBySlugMock.mockResolvedValue(workspace)
    listWorkspaceCommitDayCountsMock.mockResolvedValue(new Map())
    listWorkspaceRepositoryCommitsMock.mockResolvedValue([])
    enqueueWorkspaceCommitProjectionMock.mockResolvedValue(undefined)
  })

  it("returns pending zeros and enqueues a backfill", async () => {
    getWorkspaceCommitProjectionMock.mockResolvedValue(null)
    const res = await app().request("/workspaces/docs/activity")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("pending")
    expect(body.days.length).toBeGreaterThan(300)
    expect(body.days.every((day: { count: number }) => day.count === 0)).toBe(
      true,
    )
    expect(body.recent).toEqual([])
    expect(enqueueWorkspaceCommitProjectionMock).toHaveBeenCalledWith(
      { orgId: "org_mock", workspaceId: "ws_1" },
      expect.anything(),
    )
  })

  it("returns ready recent commits without enqueue when the tip matches", async () => {
    getWorkspaceCommitProjectionMock.mockResolvedValue({
      headSha: "abc",
      backfillStatus: "ready",
    })
    listWorkspaceCommitDayCountsMock.mockResolvedValue(
      new Map([["2026-08-26", 2]]),
    )
    listWorkspaceRepositoryCommitsMock.mockResolvedValue([
      {
        sha: "abc",
        subject: "Add heatmap",
        authorName: "Ada",
        committedAt: new Date("2026-08-26T10:00:00.000Z"),
        htmlUrl: "https://github.com/acme/docs/commit/abc",
      },
    ])
    const res = await app().request("/workspaces/docs/activity")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ready")
    expect(body.recent).toEqual([
      {
        sha: "abc",
        subject: "Add heatmap",
        authorName: "Ada",
        committedAt: "2026-08-26T10:00:00.000Z",
        htmlUrl: "https://github.com/acme/docs/commit/abc",
      },
    ])
    expect(enqueueWorkspaceCommitProjectionMock).not.toHaveBeenCalled()
  })

  it("returns failed and enqueues another backfill", async () => {
    getWorkspaceCommitProjectionMock.mockResolvedValue({
      headSha: null,
      backfillStatus: "failed",
    })
    const res = await app().request("/workspaces/docs/activity")
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("failed")
    expect(enqueueWorkspaceCommitProjectionMock).toHaveBeenCalled()
  })

  it("enqueues again when the projected tip is stale", async () => {
    getWorkspaceCommitProjectionMock.mockResolvedValue({
      headSha: "old",
      backfillStatus: "ready",
    })
    const res = await app().request("/workspaces/docs/activity")
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("ready")
    expect(enqueueWorkspaceCommitProjectionMock).toHaveBeenCalled()
  })
})
