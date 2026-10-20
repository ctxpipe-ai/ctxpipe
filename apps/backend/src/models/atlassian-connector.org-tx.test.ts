import { beforeEach, describe, expect, it, vi } from "vitest"

const withOrgDbContext = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: (db: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  ),
)

const getOrgDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error(
      "Org database not initialized. Call withOrgDbContext() during startup.",
    )
  }),
)

vi.mock("../db/client.js", () => ({
  tryGetOrgDb: () => undefined,
  tryGetOrgDbOrgId: () => undefined,
  assertNotInOrgDbContext: () => undefined,
  getSystemDb: () => ({}),
  getOrgDb,
  withOrgDbContext,
}))

import {
  getForgeInstallationByConnectionId,
  resolveForgeInstallationForOrg,
} from "./atlassian-connector.js"

describe("getForgeInstallationByConnectionId org context", () => {
  beforeEach(() => {
    withOrgDbContext.mockClear()
    getOrgDb.mockClear()
  })

  it("opens withOrgDbContext when the status probe passes connectionId", async () => {
    await expect(
      resolveForgeInstallationForOrg("org_1", "con_forge"),
    ).resolves.toBeUndefined()
    expect(withOrgDbContext).toHaveBeenCalledWith("org_1", expect.any(Function))
    expect(getOrgDb).not.toHaveBeenCalled()
  })

  it("uses the passed org db instead of opening another transaction", async () => {
    const limit = vi.fn().mockResolvedValue([])
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit }),
        }),
      }),
    }
    await expect(
      getForgeInstallationByConnectionId("org_1", "con_forge", db as never),
    ).resolves.toBeUndefined()
    expect(withOrgDbContext).not.toHaveBeenCalled()
    expect(limit).toHaveBeenCalled()
  })
})
