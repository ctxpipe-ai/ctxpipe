import { describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"
import { getAccessibleRepository } from "./service.js"

function repoDb(rows: Array<{ id: string; orgId: string; name: string; gitUrl: string }>) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  const execute = vi.fn().mockResolvedValue(undefined)
  return {
    select,
    execute,
    transaction: async (
      fn: (tx: { select: typeof select; execute: typeof execute }) => unknown,
    ) => fn({ select, execute }),
  } as unknown as Db
}

describe("getAccessibleRepository", () => {
  it("keeps the application org check when the row org mismatches", async () => {
    const db = repoDb([
      {
        id: "repo_1",
        orgId: "org_other",
        name: "other",
        gitUrl: "https://example.com/other.git",
      },
    ])
    await expect(
      getAccessibleRepository(db, "repo_1", "org_1"),
    ).resolves.toBeNull()
  })

  it("returns the row when JWT orgId matches", async () => {
    const db = repoDb([
      {
        id: "repo_1",
        orgId: "org_1",
        name: "mine",
        gitUrl: "https://example.com/mine.git",
      },
    ])
    await expect(getAccessibleRepository(db, "repo_1", "org_1")).resolves.toEqual(
      {
        id: "repo_1",
        orgId: "org_1",
        name: "mine",
        gitUrl: "https://example.com/mine.git",
      },
    )
  })
})
