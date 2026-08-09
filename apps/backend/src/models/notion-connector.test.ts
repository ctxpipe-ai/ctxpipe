import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "../db/client.js"
import type { NotionSetupPhase } from "../lib/connection-config.js"
import {
  claimNotionBindingInitialSync,
  finalizeNotionSyncTargetAfterContentWorkflow,
} from "./notion-connector.js"

const dbMocks = vi.hoisted(() => ({
  getSystemDb: vi.fn(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return { ...actual, getSystemDb: dbMocks.getSystemDb }
})

function notionConnectionRow(
  setupPhase: NotionSetupPhase,
  overrides: { enabled?: boolean; repositoryId?: string; branch?: string } = {},
) {
  return {
    id: "con_notion",
    orgId: "org_1",
    type: "notion",
    config: {
      repositoryId: overrides.repositoryId ?? "repo_1",
      branch: overrides.branch ?? "main",
      enabled: overrides.enabled ?? true,
      setupPhase,
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function systemDb(
  setupPhase: NotionSetupPhase,
  overrides?: { enabled?: boolean; repositoryId?: string; branch?: string },
) {
  const row = notionConnectionRow(setupPhase, overrides)
  const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
    where: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: row.id }]),
    })),
  }))
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set })),
  }
  const db = {
    transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
    ),
  } as unknown as Db
  return { db, set }
}

describe("Notion connector lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    "awaiting_merge",
    "sync_failed",
    "live",
  ] as const)("claims initial sync from %s", async (setupPhase) => {
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(true)
  })

  it.each([
    "draft",
    "config_failed",
    "initial_sync",
  ] as const)("does not claim initial sync from %s", async (setupPhase) => {
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("does not claim a disabled or rebound binding", async () => {
    const disabled = systemDb("awaiting_merge", { enabled: false })
    dbMocks.getSystemDb.mockReturnValue(disabled.db)
    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)

    const rebound = systemDb("awaiting_merge")
    dbMocks.getSystemDb.mockReturnValue(rebound.db)
    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_other",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it.each([
    "failed",
    "partial_failed",
  ] as const)("finalizes %s content sync as sync_failed", async (workflowStatus) => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      finalizeNotionSyncTargetAfterContentWorkflow({
        connectionId: "con_notion",
        workflowStatus,
      }),
    ).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })

  it("finalizes completed content sync as live", async () => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await finalizeNotionSyncTargetAfterContentWorkflow({
      connectionId: "con_notion",
      workflowStatus: "completed",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })
})
