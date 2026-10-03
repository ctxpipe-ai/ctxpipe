import { describe, expect, it, vi } from "vitest"
import {
  assertNotInOrgDbContext,
  type Db,
  getOrgDb,
  tryGetOrgDb,
  withOrgDbContext,
} from "./client.js"

function fakeDb() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const transaction = vi.fn(
    async (handler: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      handler({ execute }),
  )
  return { execute, transaction, txExecute: execute }
}

describe("withOrgDbContext", () => {
  it("opens one transaction for nested same-org calls", async () => {
    const db = fakeDb()
    await withOrgDbContext(db as unknown as Db, "org_1", async () => {
      expect(tryGetOrgDb()).toBeTruthy()
      await withOrgDbContext(db as unknown as Db, "org_1", async () => {
        expect(getOrgDb()).toBe(tryGetOrgDb())
      })
    })
    expect(db.transaction).toHaveBeenCalledTimes(1)
  })

  it("throws when nested withOrgDbContext uses a different org", async () => {
    const db = fakeDb()
    await expect(
      withOrgDbContext(db as unknown as Db, "org_1", async () =>
        withOrgDbContext(db as unknown as Db, "org_2", async () => undefined),
      ),
    ).rejects.toThrow(/nested org mismatch/)
    expect(db.transaction).toHaveBeenCalledTimes(1)
  })

  it("sets app.organization_id with is_local true", async () => {
    const db = fakeDb()
    await withOrgDbContext(db as unknown as Db, "org_1", async () => undefined)
    expect(db.txExecute).toHaveBeenCalled()
    const payload = JSON.stringify(db.txExecute.mock.calls[0] ?? [])
    expect(payload).toMatch(/set_config|organization_id/)
    expect(payload).toMatch(/true/)
  })

  it("throws getOrgDb outside withOrgDbContext", () => {
    expect(() => getOrgDb()).toThrow(/Org database not initialized/)
  })

  it("assertNotInOrgDbContext passes after COMMIT", async () => {
    const db = fakeDb()
    await withOrgDbContext(db as unknown as Db, "org_1", async () => {
      expect(() => assertNotInOrgDbContext()).toThrow(/Outbound I\/O/)
    })
    expect(() => assertNotInOrgDbContext()).not.toThrow()
  })
})
