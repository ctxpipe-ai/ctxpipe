import { describe, expect, it } from "vitest"
import type { Db } from "../../db/client.js"
import { retractIngestionForDiffPg } from "./ingestionRetraction.js"

const noopDb = {} as Db

function dbWithEmptyEvidenceMatches() {
  let transactionCalls = 0
  const where = () => Promise.resolve([])
  const innerJoin = () => ({ where })
  const from = () => ({ innerJoin })
  const select = () => ({ from })
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      transactionCalls++
      await fn({ select })
    },
  } as unknown as Db
  return { db, transactionCalls: () => transactionCalls }
}

describe("retractIngestionForDiffPg", () => {
  it("no-ops on full ingest mode", async () => {
    const { stats, graphEffects } = await retractIngestionForDiffPg(noopDb, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "full",
      changedPaths: ["src/changed.ts"],
      deletedPaths: ["src/removed.ts"],
      renames: [{ from: "a", to: "b" }],
    })
    expect(stats).toEqual({
      renamedEvidenceRows: 0,
      deletedEvidenceRows: 0,
      claimsUpdated: 0,
      claimsDeleted: 0,
      orphanObjectsDeleted: 0,
      graphEdgesDeleted: 0,
      graphClaimsRefreshed: 0,
      graphOrphanObjectsDeleted: 0,
    })
    expect(graphEffects).toEqual({
      deletedClaimIds: [],
      refreshedClaimIds: [],
      deletedObjectIds: [],
    })
  })

  it("no-ops on partial ingest when diff lists are empty", async () => {
    const { stats } = await retractIngestionForDiffPg(noopDb, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "partial",
      changedPaths: [],
      deletedPaths: [],
      renames: [],
    })
    expect(stats.deletedEvidenceRows).toBe(0)
    expect(stats.renamedEvidenceRows).toBe(0)
  })

  it("processes changed-only partial diffs so stale evidence can be replaced", async () => {
    const { db, transactionCalls } = dbWithEmptyEvidenceMatches()

    const { stats } = await retractIngestionForDiffPg(db, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "partial",
      changedPaths: ["src/routes.ts"],
      deletedPaths: [],
      renames: [],
    })

    expect(transactionCalls()).toBe(1)
    expect(stats.deletedEvidenceRows).toBe(0)
    expect(stats.renamedEvidenceRows).toBe(0)
  })
})
