import pg from "pg"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { log } from "../observability/logger.js"
import { logKnowledgeSearchPlan } from "./knowledge-search-plan.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { APP_ROLE_NAME } from "./provision-app-role.js"

let pool: pg.Pool

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  pool = new pg.Pool({
    connectionString: ownerUrlForMigrate(process.env.DATABASE_URL),
  })
})

afterAll(async () => {
  await pool.end()
})

it("logs that the GIN index serves the org and the full-text match as the app role", async () => {
  const info = vi.spyOn(log, "info")
  const warn = vi.spyOn(log, "warn")
  try {
    await logKnowledgeSearchPlan(pool, APP_ROLE_NAME)
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "workspace_knowledge_chunks_search_idx serves the org and the full-text match",
        ),
      }),
    )
  } finally {
    info.mockRestore()
    warn.mockRestore()
  }
})
