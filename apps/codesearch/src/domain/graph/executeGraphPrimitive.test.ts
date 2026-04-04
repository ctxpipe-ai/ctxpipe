import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { executeCgcGraphQuery } from "./executeGraphPrimitive.js"

describe("executeCgcGraphQuery", () => {
  it("returns a friendly note when the Kùzu file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cgc-missing-"))
    const missingKuzu = join(dir, "definitely-missing.kuzu")
    try {
      const res = await executeCgcGraphQuery({
        primitive: "get_callers",
        kuzuDbPath: missingKuzu,
        repoPath: join(dir, "repo"),
        symbol: "foo",
      })
      expect(res.ok).toBe(true)
      expect(res.results).toEqual([])
      expect(res.note).toMatch(/not found/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
