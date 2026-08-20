import { beforeEach, describe, expect, it, vi } from "vitest"

const executeMock = vi.fn()
const transactionMock = vi.fn(
  async (handler: (tx: { execute: typeof executeMock }) => Promise<unknown>) =>
    handler({ execute: executeMock }),
)

vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this
    }
    query() {
      return Promise.resolve({ rows: [] })
    }
    connect() {
      return Promise.resolve({ release() {} })
    }
    end() {
      return Promise.resolve()
    }
  },
}))

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => ({
    transaction: transactionMock,
    execute: executeMock,
    $client: {
      end: () => Promise.resolve(),
      on: () => undefined,
    },
  }),
}))

vi.mock("./transientDbRetry.js", () => ({
  formatUnknownError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  wrapPoolQueryWithTransientRetry: () => undefined,
}))

import {
  assertNotInOrgDbContext,
  closeDb,
  getOrgDb,
  initDb,
  tryGetOrgDb,
  withOrgDbContext,
} from "./client.js"

describe("withOrgDbContext identity-aware reuse", () => {
  beforeEach(async () => {
    await closeDb()
    transactionMock.mockClear()
    executeMock.mockClear()
    executeMock.mockResolvedValue(undefined)
    initDb("postgres://localhost/test")
  })

  it("opens one transaction for nested same-org calls", async () => {
    await withOrgDbContext("org_1", async () => {
      expect(tryGetOrgDb()).toBeTruthy()
      await withOrgDbContext("org_1", async () => {
        expect(getOrgDb()).toBe(tryGetOrgDb())
      })
    })
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it("throws when nested withOrgDbContext uses a different org", async () => {
    await expect(
      withOrgDbContext("org_1", async () =>
        withOrgDbContext("org_2", async () => undefined),
      ),
    ).rejects.toThrow(/nested org mismatch/)
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it("throws when nested call sets idleInTransactionSessionTimeout", async () => {
    await expect(
      withOrgDbContext("org_1", async () =>
        withOrgDbContext("org_1", async () => undefined, {
          idleInTransactionSessionTimeout: "20min",
        }),
      ),
    ).rejects.toThrow(/idleInTransactionSessionTimeout/)
  })

  it("inner throw aborts the outer transaction without a second begin", async () => {
    await expect(
      withOrgDbContext("org_1", async () => {
        await withOrgDbContext("org_1", async () => {
          throw new Error("inner boom")
        })
      }),
    ).rejects.toThrow("inner boom")
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it("throws getOrgDb outside withOrgDbContext", () => {
    expect(() => getOrgDb()).toThrow(/Org database not initialized/)
  })

  it("assertNotInOrgDbContext throws inside a transaction", async () => {
    await withOrgDbContext("org_1", async () => {
      expect(() => assertNotInOrgDbContext()).toThrow(/Outbound I\/O/)
    })
    expect(() => assertNotInOrgDbContext()).not.toThrow()
  })
})
