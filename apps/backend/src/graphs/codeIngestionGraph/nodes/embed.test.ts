import { describe, expect, it } from "vitest"
import type { CodeIngestionState } from "../schemas.js"
import { getObjectIdsForEmbedding } from "./embed.js"

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
