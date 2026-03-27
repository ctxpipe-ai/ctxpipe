import { describe, expect, it, vi } from "vitest"
import { resolveDedupRefToId } from "./deduplicateAndStore.js"
import type { Db } from "../../../db/client.js"

describe("resolveDedupRefToId", () => {
  it("returns deduplication key hits from keyToId without querying", async () => {
    const key = "svc:repo_agosuaxjsryk5b3hbf56do5n7y:apps/otel-collector"
    const map = new Map([[key, "obj_from_batch"]])
    const db = { select: vi.fn() } as unknown as Db
    await expect(
      resolveDedupRefToId(key, map, "org_1", db),
    ).resolves.toBe("obj_from_batch")
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

  it("passes through id-shaped refs without DB lookup", async () => {
    const map = new Map<string, string>()
    const db = { select: vi.fn() } as unknown as Db
    await expect(
      resolveDedupRefToId("repo_abc123", map, "org_1", db),
    ).resolves.toBe("repo_abc123")
    expect(db.select).not.toHaveBeenCalled()
  })
})
