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

vi.mock("../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

vi.mock("../openworkflow/workflows/workspace-index.js", () => ({
  workspaceIndex: { spec: { name: "workspace-index" } },
}))

import { closeDb, initDb, withOrgDbContext } from "./client.js"
import { enqueueWorkspaceIndex } from "../openworkflow/enqueue-workspace-index.js"

describe("outbound I/O gateway guards", () => {
  beforeEach(async () => {
    await closeDb()
    transactionMock.mockClear()
    executeMock.mockClear()
    executeMock.mockResolvedValue(undefined)
    initDb("postgres://localhost/test")
  })

  it("enqueueWorkspaceIndex throws inside withOrgDbContext", async () => {
    await expect(
      withOrgDbContext("org_1", () =>
        enqueueWorkspaceIndex(
          {
            orgId: "org_1",
            workspaceId: "ws_1",
            gitUrl: "https://github.com/acme/app.git",
            desiredSha: "abc",
            role: "workspace",
            jobGeneration: 1,
            jobWorkspaceUrl: "https://github.com/acme/app.git",
          },
          { error: () => undefined },
        ),
      ),
    ).rejects.toThrow(/Outbound I\/O/)
  })
})
