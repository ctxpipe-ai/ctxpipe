import { beforeEach, describe, expect, it, vi } from "vitest"

type QueueJobRow = {
  id: string
  repositoryId: string
  orgId: string
  targetHash: string
  sourceBranch: string | null
  fromHash: string | null
  status: string
  attemptCount: number
}

type UpdateLog = { table: unknown; values: Record<string, unknown> }
type DeleteLog = { table: unknown }
type InsertLog = { table: unknown; values: Record<string, unknown> }

const { withDbContextMock, graphInvokeMock, generateObjectIdMock } = vi.hoisted(
  () => ({
    withDbContextMock: vi.fn(),
    graphInvokeMock: vi.fn(),
    generateObjectIdMock: vi.fn(() => "inge_ERR1"),
  }),
)

vi.mock("../../db/client.js", () => ({
  withDbContext: withDbContextMock,
}))

vi.mock("../../graphs/codeIngestionGraph/graph.js", () => ({
  graph: {
    invoke: graphInvokeMock,
  },
}))

vi.mock("../../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

import { processOneCodeIngestionJob, shouldMoveToErrorLog } from "./worker.js"

const TRANSITION_MATRIX = [
  { attemptCount: 0, terminal: false },
  { attemptCount: 1, terminal: false },
  { attemptCount: 2, terminal: true },
]

function createFakeDb(job: QueueJobRow | null) {
  const updates: UpdateLog[] = []
  const deletes: DeleteLog[] = []
  const inserts: InsertLog[] = []

  const chainUpdate = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      return {
        async where() {
          updates.push({ table, values })
        },
      }
    },
  })
  const chainDelete = (table: unknown) => ({
    async where() {
      deletes.push({ table })
    },
  })
  const chainInsert = (table: unknown) => ({
    async values(values: Record<string, unknown>) {
      inserts.push({ table, values })
    },
  })

  const tx = {
    async execute() {
      return { rows: job ? [job] : [] }
    },
    update: chainUpdate,
  }

  const db = {
    async transaction(handler: (txArg: typeof tx) => Promise<unknown>) {
      return handler(tx)
    },
    update: chainUpdate,
    delete: chainDelete,
    insert: chainInsert,
  }

  return { db, updates, deletes, inserts }
}

describe("code ingestion worker transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(TRANSITION_MATRIX)(
    "transition matrix attempt=$attemptCount terminal=$terminal",
    ({ attemptCount, terminal }) => {
      expect(shouldMoveToErrorLog(attemptCount)).toBe(terminal)
    },
  )

  it("returns false when no pending job is claimable", async () => {
    const fake = createFakeDb(null)
    withDbContextMock.mockImplementation(
      async (handler: (db: unknown) => Promise<unknown>) => handler(fake.db),
    )

    const processed = await processOneCodeIngestionJob()

    expect(processed).toBe(false)
    expect(graphInvokeMock).not.toHaveBeenCalled()
  })

  it("marks success by updating repository cursor and deleting queue job", async () => {
    const fake = createFakeDb({
      id: "ingq_1",
      repositoryId: "repo_TEST1",
      orgId: "org_mock123",
      targetHash: "hashB",
      sourceBranch: "main",
      fromHash: "hashA",
      status: "pending",
      attemptCount: 0,
    })
    withDbContextMock.mockImplementation(
      async (handler: (db: unknown) => Promise<unknown>) => handler(fake.db),
    )
    graphInvokeMock.mockResolvedValue({})

    const processed = await processOneCodeIngestionJob()

    expect(processed).toBe(true)
    expect(graphInvokeMock).toHaveBeenCalledWith({
      repositoryId: "repo_TEST1",
      fromHash: "hashA",
      sourceBranch: "main",
      targetHash: "hashB",
    })
    expect(
      fake.updates.some(
        (u) => u.values.indexReady === true && u.values.lastIngestedHash === "hashB",
      ),
    ).toBe(true)
    expect(fake.deletes.length).toBe(1)
    expect(fake.inserts.length).toBe(0)
  })

  it("requeues with incremented attempt count on non-terminal failure", async () => {
    const fake = createFakeDb({
      id: "ingq_2",
      repositoryId: "repo_TEST1",
      orgId: "org_mock123",
      targetHash: "hashB",
      sourceBranch: "main",
      fromHash: "hashA",
      status: "pending",
      attemptCount: 1,
    })
    withDbContextMock.mockImplementation(
      async (handler: (db: unknown) => Promise<unknown>) => handler(fake.db),
    )
    graphInvokeMock.mockRejectedValue(new Error("index failed"))

    const processed = await processOneCodeIngestionJob()

    expect(processed).toBe(true)
    expect(
      fake.updates.some(
        (u) =>
          u.values.status === "pending" &&
          u.values.attemptCount === 2 &&
          u.values.lastError === "index failed",
      ),
    ).toBe(true)
    expect(fake.inserts.length).toBe(0)
    expect(fake.deletes.length).toBe(0)
  })

  it("moves job to error log and removes queue row on terminal failure", async () => {
    const fake = createFakeDb({
      id: "ingq_3",
      repositoryId: "repo_TEST1",
      orgId: "org_mock123",
      targetHash: "hashB",
      sourceBranch: "main",
      fromHash: "hashA",
      status: "pending",
      attemptCount: 2,
    })
    withDbContextMock.mockImplementation(
      async (handler: (db: unknown) => Promise<unknown>) => handler(fake.db),
    )
    graphInvokeMock.mockRejectedValue(new Error("still failing"))

    const processed = await processOneCodeIngestionJob()

    expect(processed).toBe(true)
    expect(fake.inserts.length).toBe(1)
    expect(fake.inserts[0]?.values).toMatchObject({
      id: "inge_ERR1",
      queueJobId: "ingq_3",
      repositoryId: "repo_TEST1",
      targetHash: "hashB",
      attemptCount: 3,
      errorMessage: "still failing",
    })
    expect(fake.deletes.length).toBe(1)
  })
})
