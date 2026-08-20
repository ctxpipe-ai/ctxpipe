import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgDbMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: (db: unknown) => unknown) =>
    fn(getOrgDbMock()),
  ),
)
const generateObjectIdMock = vi.hoisted(() =>
  vi.fn((prefix: string) => `${prefix}_generated`),
)

vi.mock("../../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  getOrgDb: getOrgDbMock,
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

import {
  batchUpsertRetrievalObjectsByDeduplicationKey,
  collapseUpsertInputsByDeduplicationKey,
  mergeRetrievalObjectPayloads,
} from "./retrievalObjectWrite.js"

describe("mergeRetrievalObjectPayloads", () => {
  it("keeps rich fields when incoming is consumer stub", () => {
    const existing = {
      path: "apps/web/src/app/api",
      framework: "Next.js",
      operations: [{ method: "GET", path: "/users" }],
    }
    const incoming = {
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
    }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
      framework: "Next.js",
      operations: [{ method: "GET", path: "/users" }],
    })
  })

  it("replaces stub when incoming is full extraction", () => {
    const existing = {
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
    }
    const incoming = {
      path: "apps/web/src/app/api",
      framework: "Hono",
    }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
      framework: "Hono",
    })
  })

  it("prefers incoming for two non-stub payloads", () => {
    const existing = { name: "a", x: 1 }
    const incoming = { name: "b", y: 2 }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      name: "b",
      x: 1,
      y: 2,
    })
  })
})

describe("collapseUpsertInputsByDeduplicationKey", () => {
  it("merges duplicate keys in encounter order without dropping stubs onto rich payloads incorrectly", () => {
    const collapsed = collapseUpsertInputsByDeduplicationKey([
      {
        kind: "API",
        deduplicationKey: "api:a",
        payload: { name: "a", framework: "Hono" },
      },
      {
        kind: "API",
        deduplicationKey: "api:a",
        payload: { name: "a", inferredFromConsumer: true },
      },
      {
        kind: "Service",
        deduplicationKey: "svc:b",
        payload: { name: "b" },
      },
    ])
    expect(collapsed).toHaveLength(2)
    expect(collapsed[0]).toEqual({
      kind: "API",
      deduplicationKey: "api:a",
      payload: {
        name: "a",
        inferredFromConsumer: true,
        framework: "Hono",
      },
    })
    expect(collapsed[1]?.deduplicationKey).toBe("svc:b")
  })
})

describe("batchUpsertRetrievalObjectsByDeduplicationKey", () => {
  beforeEach(() => {
    getOrgDbMock.mockReset()
    generateObjectIdMock.mockClear()
  })

  it("prefetches once per chunk, batch-inserts new keys, and updates existing", async () => {
    const selectWhere = vi.fn().mockResolvedValue([
      {
        id: "obj_existing",
        payload: { name: "old", summary: "keep-me" },
        kind: "Service",
        deduplicationKey: "svc:existing",
      },
    ])
    const selectFrom = vi.fn().mockReturnValue({ where: selectWhere })
    const insertValues = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockReturnValue({ values: insertValues })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
    const update = vi.fn().mockReturnValue({ set: updateSet })

    getOrgDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({ from: selectFrom }),
      insert,
      update,
    })

    const results = await batchUpsertRetrievalObjectsByDeduplicationKey(
      "org_1",
      [
        {
          kind: "Service",
          deduplicationKey: "svc:existing",
          payload: { name: "new", path: "/x" },
        },
        {
          kind: "Service",
          deduplicationKey: "svc:new",
          payload: { name: "brand-new" },
        },
        {
          kind: "Service",
          deduplicationKey: "svc:new",
          payload: { name: "brand-new", inferredFromConsumer: true },
        },
      ],
    )

    expect(selectWhere).toHaveBeenCalledTimes(1)
    expect(insertValues).toHaveBeenCalledTimes(1)
    expect(insertValues.mock.calls[0]?.[0]).toEqual([
      {
        id: "obj_generated",
        orgId: "org_1",
        kind: "Service",
        deduplicationKey: "svc:new",
        payload: {
          name: "brand-new",
          inferredFromConsumer: true,
        },
      },
    ])
    expect(update).toHaveBeenCalledTimes(1)
    expect(updateSet).toHaveBeenCalledWith({
      payload: { name: "new", summary: "keep-me", path: "/x" },
      updatedAt: expect.any(Date),
    })

    expect(results.get("svc:existing")).toEqual({
      id: "obj_existing",
      needsEmbeddingRefresh: true,
    })
    expect(results.get("svc:new")).toEqual({
      id: "obj_generated",
      needsEmbeddingRefresh: true,
    })
  })

  it("skips insert/update when inputs are empty", async () => {
    getOrgDbMock.mockReturnValue({
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    })
    const results = await batchUpsertRetrievalObjectsByDeduplicationKey(
      "org_1",
      [],
    )
    expect(results.size).toBe(0)
    expect(getOrgDbMock).not.toHaveBeenCalled()
  })

  it("invokes onChunk after each batch with cumulative unique-key progress", async () => {
    const selectWhere = vi.fn().mockResolvedValue([])
    const selectFrom = vi.fn().mockReturnValue({ where: selectWhere })
    const insertValues = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockReturnValue({ values: insertValues })
    getOrgDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({ from: selectFrom }),
      insert,
      update: vi.fn(),
    })
    generateObjectIdMock
      .mockReturnValueOnce("obj_a")
      .mockReturnValueOnce("obj_b")
      .mockReturnValueOnce("obj_c")

    const onChunk = vi.fn()
    await batchUpsertRetrievalObjectsByDeduplicationKey(
      "org_1",
      [
        {
          kind: "Service",
          deduplicationKey: "svc:a",
          payload: { name: "a" },
        },
        {
          kind: "Service",
          deduplicationKey: "svc:b",
          payload: { name: "b" },
        },
        {
          kind: "Service",
          deduplicationKey: "svc:c",
          payload: { name: "c" },
        },
      ],
      { batchSize: 2, onChunk },
    )

    expect(onChunk).toHaveBeenCalledTimes(2)
    expect(onChunk).toHaveBeenNthCalledWith(1, {
      processedUniqueKeys: 2,
      totalUniqueKeys: 3,
    })
    expect(onChunk).toHaveBeenNthCalledWith(2, {
      processedUniqueKeys: 3,
      totalUniqueKeys: 3,
    })
  })
})
