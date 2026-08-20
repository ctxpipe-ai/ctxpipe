import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeIngestionState } from "../schemas.js"
import { withTestLogger } from "../../../test/with-test-logger.js"

const generateEmbeddingsMock = vi.hoisted(() => vi.fn())
const setIngestionIndexingStepMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const getSystemDbMock = vi.hoisted(() => vi.fn())

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  EMBEDDING_BATCH_SIZE: 64,
  generateEmbeddings: generateEmbeddingsMock,
}))

vi.mock("../setIngestionIndexingStep.js", () => ({
  setIngestionIndexingStep: setIngestionIndexingStepMock,
}))

vi.mock("../../../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  getSystemDb: getSystemDbMock,
}))

import { embed, getObjectIdsForEmbedding } from "./embed.js"

function state(partial: Partial<CodeIngestionState>): CodeIngestionState {
  return {
    repositoryId: "repo_1",
    orgId: "org_1",
    targetHash: "abc",
    ...partial,
  } as CodeIngestionState
}

describe("getObjectIdsForEmbedding", () => {
  it("uses objectIds in full mode", () => {
    expect(
      getObjectIdsForEmbedding(
        state({
          ingestMode: "full",
          objectIds: ["obj_a", "obj_b"],
          touchedObjectIds: ["obj_a"],
        }),
      ),
    ).toEqual(["obj_a", "obj_b"])
  })

  it("prefers touchedObjectIds in partial mode", () => {
    expect(
      getObjectIdsForEmbedding(
        state({
          ingestMode: "partial",
          objectIds: ["obj_a", "obj_b", "obj_c"],
          touchedObjectIds: ["obj_b"],
        }),
      ),
    ).toEqual(["obj_b"])
  })

  it("falls back to objectIds in partial mode when touchedObjectIds is absent", () => {
    expect(
      getObjectIdsForEmbedding(
        state({
          ingestMode: "partial",
          objectIds: ["obj_a"],
        }),
      ),
    ).toEqual(["obj_a"])
  })
})

describe("embed", () => {
  beforeEach(() => {
    generateEmbeddingsMock.mockReset()
    setIngestionIndexingStepMock.mockClear()

    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
    const update = vi.fn().mockReturnValue({ set: updateSet })
    const where = vi.fn().mockResolvedValue([
      {
        id: "obj_a",
        kind: "Service",
        payload: { name: "a", summary: "sa" },
      },
      {
        id: "obj_b",
        kind: "Service",
        payload: { name: "b", summary: "sb" },
      },
      {
        id: "obj_empty",
        kind: "Service",
        payload: {},
      },
    ])
    getSystemDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update,
    })

    generateEmbeddingsMock.mockResolvedValue([
      new Array(2000).fill(0.1),
      new Array(2000).fill(0.2),
    ])
  })

  it("batch-embeds non-empty objects in one generateEmbeddings call", async () => {
    await withTestLogger(() =>
      embed(
        state({
          ingestMode: "full",
          objectIds: ["obj_a", "obj_b", "obj_empty"],
        }),
      ),
    )

    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1)
    expect(generateEmbeddingsMock.mock.calls[0]?.[0]).toEqual(["a sa", "b sb"])
    expect(setIngestionIndexingStepMock).toHaveBeenCalledWith(
      expect.anything(),
      "embedding",
    )
  })
})
