import { describe, expect, it, vi } from "vitest"
import type { Db } from "../../../db/client.js"
import {
  claimEvidenceMatchesLogicalKey,
  DEDUP_CLAIM_PREFETCH_BATCH_SIZE,
  fetchExistingClaimsForProjection,
  prefetchDedupKeysIntoMap,
  resolveDedupRefToId,
  shouldEmitDedupProgress,
} from "./deduplicateAndStore.js"

describe("shouldEmitDedupProgress", () => {
  it("emits on positive multiples of the interval", () => {
    expect(shouldEmitDedupProgress(0, 250)).toBe(false)
    expect(shouldEmitDedupProgress(249, 250)).toBe(false)
    expect(shouldEmitDedupProgress(250, 250)).toBe(true)
    expect(shouldEmitDedupProgress(500, 250)).toBe(true)
  })
})

describe("resolveDedupRefToId", () => {
  it("returns deduplication key hits from keyToId without querying", async () => {
    const key = "svc:repo_agosuaxjsryk5b3hbf56do5n7y:apps/otel-collector"
    const map = new Map([[key, "obj_from_batch"]])
    const db = { select: vi.fn() } as unknown as Db
    await expect(resolveDedupRefToId(key, map, "org_1", db)).resolves.toBe(
      "obj_from_batch",
    )
    expect(db.select).not.toHaveBeenCalled()
  })

  it("loads svc:… deduplication key from Postgres when missing from the batch map", async () => {
    const key = "svc:repo_agosuaxjsryk5b3hbf56do5n7y:apps/otel-collector"
    const map = new Map<string, string>()
    const limit = vi.fn().mockResolvedValue([{ id: "obj_existing" }])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db

    await expect(resolveDedupRefToId(key, map, "org_1", db)).resolves.toBe(
      "obj_existing",
    )
    expect(map.get(key)).toBe("obj_existing")
    expect(limit).toHaveBeenCalledWith(1)
  })

  it("returns null when ref is not in batch map or database", async () => {
    const key = "svc:repo_missing:path"
    const map = new Map<string, string>()
    const limit = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db

    await expect(resolveDedupRefToId(key, map, "org_1", db)).resolves.toBeNull()
  })

  it("passes through id-shaped refs without DB lookup", async () => {
    const map = new Map<string, string>()
    const db = { select: vi.fn() } as unknown as Db
    await expect(
      resolveDedupRefToId("repo_abc123", map, "org_1", db),
    ).resolves.toBe("repo_abc123")
    expect(db.select).not.toHaveBeenCalled()
  })
})

describe("claimEvidenceMatchesLogicalKey", () => {
  const hash = "abc123"

  it("matches on stored logicalSourceKey", () => {
    expect(
      claimEvidenceMatchesLogicalKey(
        { sourceId: "other", logicalSourceKey: "path/file.ts" },
        "path/file.ts",
        "path/file.ts:abc123",
        hash,
      ),
    ).toBe(true)
  })

  it("matches on exact sourceId", () => {
    expect(
      claimEvidenceMatchesLogicalKey(
        { sourceId: "path/file.ts:abc123", logicalSourceKey: "different" },
        "path/file.ts",
        "path/file.ts:abc123",
        hash,
      ),
    ).toBe(true)
  })

  it("matches legacy null logical key via derived sourceId", () => {
    expect(
      claimEvidenceMatchesLogicalKey(
        { sourceId: "path/file.ts:abc123", logicalSourceKey: null },
        "path/file.ts",
        "path/file.ts:otherhash",
        hash,
      ),
    ).toBe(true)
  })

  it("does not match unrelated evidence", () => {
    expect(
      claimEvidenceMatchesLogicalKey(
        { sourceId: "other.ts:abc123", logicalSourceKey: "other.ts" },
        "path/file.ts",
        "path/file.ts:abc123",
        hash,
      ),
    ).toBe(false)
  })
})

describe("fetchExistingClaimsForProjection", () => {
  function claimRow(id: string) {
    return {
      id,
      subjectId: "fil_1",
      objectId: "repo_1",
      predicate: "PART_OF",
      status: "active",
      aggregatedConfidence: 0.9,
      lastObservedAt: new Date("2026-09-01T00:00:00.000Z"),
      validFrom: null,
      validTo: null,
    }
  }

  function mockDb() {
    const whereArgs: unknown[] = []
    const groupBy = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockImplementation((arg: unknown) => {
      whereArgs.push(arg)
      const rows = Promise.resolve([claimRow("claim_a")])
      return Object.assign(rows, { groupBy })
    })
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db
    return { db, where, groupBy, whereArgs }
  }

  it("collapses duplicate ids before querying", async () => {
    const { db, where } = mockDb()
    const ids = Array.from({ length: 2000 }, () => "claim_a")
    const result = await fetchExistingClaimsForProjection(db, "org_1", ids)
    expect(where).toHaveBeenCalledTimes(2)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.id).toBe("claim_a")
  })

  it("splits unique ids into batches of 500", async () => {
    const { db, where } = mockDb()
    const ids = Array.from(
      { length: DEDUP_CLAIM_PREFETCH_BATCH_SIZE + 1 },
      (_, i) => `claim_${i}`,
    )
    await fetchExistingClaimsForProjection(db, "org_1", ids)
    expect(where).toHaveBeenCalledTimes(4)
  })

  it("does not query when the id list is empty", async () => {
    const db = { select: vi.fn() } as unknown as Db
    const result = await fetchExistingClaimsForProjection(db, "org_1", [])
    expect(db.select).not.toHaveBeenCalled()
    expect(result.rows).toEqual([])
  })
})

describe("prefetchDedupKeysIntoMap", () => {
  it("fills only missing non-id keys with one IN query and skips cached/id refs", async () => {
    const map = new Map<string, string>([["svc:cached", "obj_cached"]])
    const where = vi.fn().mockResolvedValue([
      {
        id: "obj_loaded",
        deduplicationKey: "svc:missing",
      },
    ])
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db

    await prefetchDedupKeysIntoMap(
      ["svc:cached", "repo_alreadyid", "svc:missing", "svc:missing"],
      map,
      "org_1",
      db,
    )

    expect(db.select).toHaveBeenCalledTimes(1)
    expect(map.get("svc:missing")).toBe("obj_loaded")
    expect(map.get("svc:cached")).toBe("obj_cached")
  })

  it("does not query when every ref is already resolved", async () => {
    const map = new Map([["svc:a", "obj_a"]])
    const db = { select: vi.fn() } as unknown as Db
    await prefetchDedupKeysIntoMap(["svc:a", "obj_b"], map, "org_1", db)
    expect(db.select).not.toHaveBeenCalled()
  })
})
