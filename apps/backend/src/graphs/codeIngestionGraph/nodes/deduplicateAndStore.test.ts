import { describe, expect, it, vi } from "vitest"
import type { Db } from "../../../db/client.js"
import {
  claimEvidenceMatchesLogicalKey,
  DEDUP_CLAIM_TRIPLE_BATCH_SIZE,
  prefetchClaimsByTriples,
  prefetchDedupKeysIntoMap,
  prefetchEvidenceByClaimIds,
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

describe("prefetchClaimsByTriples", () => {
  it("batches unique triples so 501 lookups are two queries", async () => {
    const where = vi.fn().mockResolvedValue([])
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db
    const triples = Array.from(
      { length: DEDUP_CLAIM_TRIPLE_BATCH_SIZE + 1 },
      (_, i) => ({
        subjectId: `fil_${i}`,
        predicate: "PART_OF",
        objectId: "repo_1",
      }),
    )
    await prefetchClaimsByTriples("org_1", db, triples)
    expect(where).toHaveBeenCalledTimes(2)
  })
})

describe("prefetchEvidenceByClaimIds", () => {
  it("uniques ids before the IN query", async () => {
    const where = vi.fn().mockResolvedValue([])
    const from = vi.fn().mockReturnValue({ where })
    const db = {
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as Db
    await prefetchEvidenceByClaimIds(
      db,
      Array.from({ length: 2000 }, () => "claim_a"),
    )
    expect(where).toHaveBeenCalledTimes(1)
  })
})
